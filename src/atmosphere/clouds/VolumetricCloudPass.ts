import * as THREE from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  dot,
  exp,
  float,
  fract,
  max,
  mix,
  perspectiveDepthToViewZ,
  positionGeometry,
  smoothstep,
  sqrt,
  texture,
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import type { AtmosphereDebugMode, QualityTier } from "../../engine/types";
import type { CloudNoiseTextures } from "./CloudNoiseTextures";
import type { WeatherMap } from "./WeatherMap";
import { WEATHER_DOMAIN_METERS } from "./WeatherMap";
import { remapNode } from "./noise";

type NodeRef = any;
type AnyUniform<T> = any & { value: T };

const EARTH_RADIUS = 6_371_000;
const CIRRUS_ALTITUDE = 8000;
/** Base noise tiles every 8 km, detail noise every 950 m. */
const BASE_NOISE_METERS = 8000;
const DETAIL_NOISE_METERS = 950;

function sceneDepthUvFromScreenUv(screenUv: NodeRef): NodeRef {
  // WebGPU depth render targets are sampled with the opposite vertical origin
  // from the fullscreen screen UV used to reconstruct camera rays here.
  return vec2(screenUv.x, float(1).sub(screenUv.y));
}

export type CloudQualityConfig = {
  /** Render target scale relative to the canvas (0.25 = quarter res). */
  resolutionScale: number;
  weatherMapSize: number;
  marchSteps: number;
  lightSteps: number;
};

export const CLOUD_QUALITY: Record<QualityTier, CloudQualityConfig> = {
  low: { resolutionScale: 0.25, weatherMapSize: 1024, marchSteps: 40, lightSteps: 5 },
  medium: { resolutionScale: 0.5, weatherMapSize: 1024, marchSteps: 64, lightSteps: 6 },
  high: { resolutionScale: 0.5, weatherMapSize: 1024, marchSteps: 96, lightSteps: 8 }
};

export type CloudLightingInput = {
  keyLightDir: THREE.Vector3;
  keyLightColor: THREE.Color;
  keyLightIntensity: number;
  ambientTop: THREE.Color;
  ambientBottom: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
};

export type CloudWeatherInput = {
  cloudBaseMeters: number;
  cloudThicknessMeters: number;
  cloudDensity: number;
  cloudDarkening: number;
  cloudCoverage: number;
  cirrusAmount: number;
  windDirectionRad: number;
};

export type LightningLightInput = {
  position: THREE.Vector3; // render space
  color: THREE.Color;
  intensity: number;
};

export type SceneDepthInput = {
  texture: THREE.DepthTexture;
  width: number;
  height: number;
};

/**
 * Half-resolution raymarched volumetric clouds (Schneider/Nubis density model,
 * Frostbite-style energy-conserving integration with a Wrenninge multi-scatter
 * approximation), with an in-pass temporal exponential accumulation driven by
 * direction-based reprojection, plus an analytic high-altitude cirrus layer.
 *
 * The resolved buffer stores only cloud radiance/transmittance: premultiplied
 * HDR radiance in RGB and view transmittance in A. Ocean occlusion is handled
 * analytically inside the march by clamping rays against the sea plane; mesh
 * occlusion is applied later in the fullscreen composite so moving objects
 * never contaminate the cloud history.
 */
export class VolumetricCloudPass {
  readonly compositeMesh: THREE.Mesh;

  private readonly quad: THREE.QuadMesh;
  private readonly material: THREE.NodeMaterial;
  private targets: [THREE.RenderTarget, THREE.RenderTarget];
  private writeIndex = 0;
  private frameIndex = 0;
  private width = 2;
  private height = 2;
  private readonly resolutionScale: number;
  private historyValid = false;

  private readonly prevProjView = new THREE.Matrix4();
  private readonly currProjView = new THREE.Matrix4();
  private readonly prevCameraPos = new THREE.Vector3();

  // Camera
  private readonly uCamPos: AnyUniform<THREE.Vector3> = uniform(new THREE.Vector3()) as any;
  private readonly uCamAbsXZ: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;
  private readonly uInvProj: AnyUniform<THREE.Matrix4> = uniform(new THREE.Matrix4()) as any;
  private readonly uCamWorld: AnyUniform<THREE.Matrix4> = uniform(new THREE.Matrix4()) as any;
  private readonly uPrevProjView: AnyUniform<THREE.Matrix4> = uniform(new THREE.Matrix4()) as any;

  // Layer + weather
  private readonly uCloudBase: AnyUniform<number> = uniform(1200) as any;
  private readonly uCloudThickness: AnyUniform<number> = uniform(1500) as any;
  private readonly uDensityMult: AnyUniform<number> = uniform(0.6) as any;
  private readonly uDarkening: AnyUniform<number> = uniform(0.2) as any;
  private readonly uGlobalCoverage: AnyUniform<number> = uniform(0.5) as any;
  private readonly uCirrus: AnyUniform<number> = uniform(0.3) as any;
  private readonly uWindOffset: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;
  private readonly uWindDir: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2(1, 0)) as any;

  // Lighting
  private readonly uKeyLightDir: AnyUniform<THREE.Vector3> = uniform(new THREE.Vector3(0, 1, 0)) as any;
  private readonly uKeyLightRadiance: AnyUniform<THREE.Color> = uniform(new THREE.Color(1, 1, 1)) as any;
  private readonly uAmbientTop: AnyUniform<THREE.Color> = uniform(new THREE.Color(0.4, 0.5, 0.6)) as any;
  private readonly uAmbientBottom: AnyUniform<THREE.Color> = uniform(new THREE.Color(0.2, 0.25, 0.3)) as any;
  private readonly uFogColor: AnyUniform<THREE.Color> = uniform(new THREE.Color(0.5, 0.6, 0.65)) as any;
  private readonly uFogDensity: AnyUniform<number> = uniform(0.0005) as any;

  // Lightning (up to two simultaneous in-cloud flashes)
  private readonly uLightning0: AnyUniform<THREE.Vector4> = uniform(new THREE.Vector4(0, 0, 0, 0)) as any;
  private readonly uLightning1: AnyUniform<THREE.Vector4> = uniform(new THREE.Vector4(0, 0, 0, 0)) as any;
  private readonly uLightningColor: AnyUniform<THREE.Color> = uniform(new THREE.Color(0.72, 0.78, 1)) as any;

  // Temporal
  private readonly uFrame: AnyUniform<number> = uniform(0) as any;
  private readonly uHistoryBlend: AnyUniform<number> = uniform(0) as any;
  private readonly uResolution: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2(2, 2)) as any;
  private readonly uDebugMode: AnyUniform<number> = uniform(0) as any;
  private readonly historyTexNode: NodeRef;
  private readonly resolvedTexNode: NodeRef;
  private readonly sceneDepthPlaceholder = new THREE.DepthTexture(1, 1);
  private readonly sceneDepthTexNode: NodeRef;
  private weatherStability = 1;
  private readonly uCameraNear: AnyUniform<number> = uniform(0.1) as any;
  private readonly uCameraFar: AnyUniform<number> = uniform(60000) as any;
  private readonly uHasSceneDepth: AnyUniform<number> = uniform(0) as any;
  private readonly uDepthBiasMeters: AnyUniform<number> = uniform(1.25) as any;

  constructor(
    noise: CloudNoiseTextures,
    weatherMap: WeatherMap,
    quality: CloudQualityConfig
  ) {
    this.resolutionScale = quality.resolutionScale;
    this.targets = [this.createTarget(2, 2), this.createTarget(2, 2)];

    this.historyTexNode = texture(this.targets[0].texture);
    this.resolvedTexNode = texture(this.targets[0].texture);
    this.sceneDepthTexNode = texture(this.sceneDepthPlaceholder);

    this.material = new THREE.NodeMaterial();
    this.material.name = "volumetric-cloud-raymarch";
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.fragmentNode = this.createFragmentNode(noise, weatherMap, quality);

    this.quad = new THREE.QuadMesh(this.material);

    this.compositeMesh = this.createCompositeMesh();
  }

  setSize(canvasWidth: number, canvasHeight: number): void {
    const w = Math.max(2, Math.round(canvasWidth * this.resolutionScale));
    const h = Math.max(2, Math.round(canvasHeight * this.resolutionScale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.uResolution.value.set(w, h);
    this.targets.forEach((target) => target.setSize(w, h));
    this.historyValid = false;
  }

  updateWeather(weather: CloudWeatherInput): void {
    const delta =
      Math.abs(weather.cloudBaseMeters - this.uCloudBase.value) / 6000 +
      Math.abs(weather.cloudThicknessMeters - this.uCloudThickness.value) / 6000 +
      Math.abs(weather.cloudDensity - this.uDensityMult.value) +
      Math.abs(weather.cloudDarkening - this.uDarkening.value) +
      Math.abs(weather.cloudCoverage - this.uGlobalCoverage.value);
    this.weatherStability = THREE.MathUtils.clamp(1 - delta * 1.25, 0.18, 1);
    if (delta > 0.55) {
      this.historyValid = false;
    }

    this.uCloudBase.value = weather.cloudBaseMeters;
    this.uCloudThickness.value = Math.max(200, weather.cloudThicknessMeters);
    this.uDensityMult.value = weather.cloudDensity;
    this.uDarkening.value = weather.cloudDarkening;
    this.uGlobalCoverage.value = weather.cloudCoverage;
    this.uCirrus.value = weather.cirrusAmount;
    this.uWindDir.value.set(Math.cos(weather.windDirectionRad), Math.sin(weather.windDirectionRad));
  }

  setDebugMode(mode: AtmosphereDebugMode): void {
    this.uDebugMode.value = ATMOSPHERE_DEBUG_MODE_INDEX[mode];
    if (mode !== "off") {
      this.historyValid = false;
    }
  }

  updateLighting(input: CloudLightingInput): void {
    this.uKeyLightDir.value.copy(input.keyLightDir).normalize();
    this.uKeyLightRadiance.value.copy(input.keyLightColor).multiplyScalar(input.keyLightIntensity);
    this.uAmbientTop.value.copy(input.ambientTop);
    this.uAmbientBottom.value.copy(input.ambientBottom);
    this.uFogColor.value.copy(input.fogColor);
    this.uFogDensity.value = input.fogDensity;
  }

  updateLightning(lights: LightningLightInput[]): void {
    const l0 = lights[0];
    const l1 = lights[1];
    if (l0) {
      this.uLightning0.value.set(l0.position.x, l0.position.y, l0.position.z, l0.intensity);
      this.uLightningColor.value.copy(l0.color);
    } else {
      this.uLightning0.value.set(0, 0, 0, 0);
    }
    if (l1) {
      this.uLightning1.value.set(l1.position.x, l1.position.y, l1.position.z, l1.intensity);
    } else {
      this.uLightning1.value.set(0, 0, 0, 0);
    }
  }

  /** Renders the raymarch + temporal resolve into the current write target. */
  render(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    originOffset: { x: number; z: number },
    weatherMap: WeatherMap,
    sceneDepth: SceneDepthInput | null = null
  ): void {
    this.uCamPos.value.copy(camera.position);
    this.uCamAbsXZ.value.set(camera.position.x + originOffset.x, camera.position.z + originOffset.z);
    this.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.uCamWorld.value.copy(camera.matrixWorld);
    this.uCameraNear.value = camera.near;
    this.uCameraFar.value = camera.far;
    this.uHasSceneDepth.value = sceneDepth ? 1 : 0;
    this.sceneDepthTexNode.value = sceneDepth?.texture ?? this.sceneDepthPlaceholder;
    this.uWindOffset.value.copy(weatherMap.windOffsetMeters);
    this.uFrame.value = this.frameIndex % 1024;

    const cameraDelta = this.prevCameraPos.distanceTo(camera.position);
    const movementFade = THREE.MathUtils.clamp(1 - cameraDelta / 180, 0.25, 1);
    if (cameraDelta > 600) {
      this.historyValid = false;
    }
    this.uHistoryBlend.value = this.historyValid ? 0.93 * movementFade * this.weatherStability : 0;
    this.uPrevProjView.value.copy(this.prevProjView);

    const readTarget = this.targets[1 - this.writeIndex];
    const writeTarget = this.targets[this.writeIndex];
    this.historyTexNode.value = readTarget.texture;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(writeTarget);
    this.quad.render(renderer);
    renderer.setRenderTarget(previousTarget);

    this.resolvedTexNode.value = writeTarget.texture;

    // Bookkeeping for next frame
    this.currProjView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.prevProjView.copy(this.currProjView);
    this.prevCameraPos.copy(camera.position);
    this.writeIndex = 1 - this.writeIndex;
    this.frameIndex += 1;
    this.historyValid = true;
  }

  setVisible(visible: boolean): void {
    this.compositeMesh.visible = visible;
  }

  dispose(): void {
    this.targets.forEach((target) => target.dispose());
    this.material.dispose();
    this.sceneDepthPlaceholder.dispose();
    this.compositeMesh.geometry.dispose();
    (this.compositeMesh.material as THREE.Material).dispose();
    this.compositeMesh.removeFromParent();
  }

  private createTarget(width: number, height: number): THREE.RenderTarget {
    const target = new THREE.RenderTarget(width, height, {
      depthBuffer: false,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false
    });
    target.texture.name = "volumetric-cloud-buffer";
    return target;
  }

  /** Fullscreen triangle-strip mesh compositing the resolved clouds over the scene. */
  private createCompositeMesh(): THREE.Mesh {
    const material = new THREE.NodeMaterial();
    material.name = "volumetric-cloud-composite";
    material.depthTest = false;
    material.depthWrite = false;
    material.transparent = true;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.SrcAlphaFactor;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
    (material as any).fog = false;

    material.vertexNode = vec4(positionGeometry.xy, 0.5, 1);

    const resolved = this.resolvedTexNode;
    const sceneDepthTex = this.sceneDepthTexNode;
    const uInvProj = this.uInvProj;
    const uCamWorld = this.uCamWorld;
    const uCamPos = this.uCamPos;
    const uCloudBase = this.uCloudBase;
    const uCloudThickness = this.uCloudThickness;
    const uCameraNear = this.uCameraNear;
    const uCameraFar = this.uCameraFar;
    const uHasSceneDepth = this.uHasSceneDepth;
    const uDepthBias = this.uDepthBiasMeters;
    const uDebugMode = this.uDebugMode;

    const raySphereLocal = (roc: NodeRef, rd: NodeRef, radius: NodeRef): NodeRef => {
      const b = dot(roc, rd);
      const c = dot(roc, roc).sub(radius.mul(radius));
      const disc = b.mul(b).sub(c);
      const s = sqrt(max(disc, 0));
      return vec3(b.negate().sub(s), b.negate().add(s), disc);
    };

    material.fragmentNode = Fn(() => {
      const sampleUV: NodeRef = uv();
      const clouds: NodeRef = resolved.sample(sampleUV);

      const ndc = sampleUV.mul(2).sub(1);
      const viewDir4: NodeRef = uInvProj.mul(vec4(ndc.x, ndc.y, 0.5, 1));
      const viewDir = viewDir4.xyz.div(viewDir4.w).normalize();
      const worldDir: NodeRef = uCamWorld.mul(vec4(viewDir, 0)).xyz.normalize();

      const sceneDepthUV: NodeRef = sceneDepthUvFromScreenUv(sampleUV);
      const sceneDepthRaw: NodeRef = sceneDepthTex.sample(sceneDepthUV).r;
      const sceneViewZ: NodeRef = perspectiveDepthToViewZ(sceneDepthRaw, uCameraNear, uCameraFar);
      const sceneDistance: NodeRef = sceneViewZ.div(viewDir.z).max(0);
      const validSceneDepth = uHasSceneDepth.greaterThan(0.5).and(sceneDepthRaw.lessThan(0.999999));

      const camAltitude = uCamPos.y;
      const earthCenterOffset = vec3(0, camAltitude.add(EARTH_RADIUS), 0);
      const rBase = float(EARTH_RADIUS).add(uCloudBase);
      const rTop = float(EARTH_RADIUS).add(uCloudBase).add(uCloudThickness);
      const hitBase: NodeRef = raySphereLocal(earthCenterOffset, worldDir, rBase);
      const hitTop: NodeRef = raySphereLocal(earthCenterOffset, worldDir, rTop);

      const camRadius = camAltitude.add(EARTH_RADIUS);
      const belowLayer = camRadius.lessThan(rBase);
      const aboveLayer = camRadius.greaterThan(rTop);
      const cloudStart = float(1e9).toVar();

      If(belowLayer, () => {
        cloudStart.assign(hitBase.y.max(0));
      })
        .ElseIf(aboveLayer, () => {
          If(hitTop.z.greaterThan(0).and(hitTop.x.greaterThan(0)), () => {
            cloudStart.assign(hitTop.x.max(0));
          });
        })
        .Else(() => {
          cloudStart.assign(0);
        });

      const horizonFallback = uCloudBase.div(worldDir.y.max(0.02)).max(0);
      const firstPossibleCloud = cloudStart.min(horizonFallback);
      const hasCloud = clouds.a.lessThan(0.999);
      const edgeFade = validSceneDepth
        .and(hasCloud)
        .select(smoothstep(float(0.35), float(6), sceneDistance.sub(firstPossibleCloud).add(uDepthBias)), float(1));
      const finalFade = uDebugMode.greaterThan(0.5).select(float(1), edgeFade);
      return vec4(clouds.rgb.mul(finalFade), mix(float(1), clouds.a, finalFade));
    })();

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.name = "Volumetric cloud composite";
    mesh.frustumCulled = false;
    mesh.renderOrder = 10000;
    mesh.userData.depthPass = "exclude";
    return mesh;
  }

  private createFragmentNode(
    noiseTextures: CloudNoiseTextures,
    weatherMap: WeatherMap,
    quality: CloudQualityConfig
  ): NodeRef {
    const baseNoise = texture3D(noiseTextures.baseTexture);
    const detailNoise = texture3D(noiseTextures.detailTexture);
    const weatherTex = texture(weatherMap.texture);

    const uCamPos = this.uCamPos;
    const uCamAbsXZ = this.uCamAbsXZ;
    const uInvProj = this.uInvProj;
    const uCamWorld = this.uCamWorld;
    const uPrevProjView = this.uPrevProjView;
    const uCameraNear = this.uCameraNear;
    const uCameraFar = this.uCameraFar;
    const uHasSceneDepth = this.uHasSceneDepth;
    const uDepthBias = this.uDepthBiasMeters;
    const uCloudBase = this.uCloudBase;
    const uCloudThickness = this.uCloudThickness;
    const uDensityMult = this.uDensityMult;
    const uDarkening = this.uDarkening;
    const uGlobalCoverage = this.uGlobalCoverage;
    const uCirrus = this.uCirrus;
    const uWindOffset = this.uWindOffset;
    const uWindDir = this.uWindDir;
    const uKeyLightDir = this.uKeyLightDir;
    const uKeyLightRadiance = this.uKeyLightRadiance;
    const uAmbientTop = this.uAmbientTop;
    const uAmbientBottom = this.uAmbientBottom;
    const uFogColor = this.uFogColor;
    const uFogDensity = this.uFogDensity;
    const uLightning0 = this.uLightning0;
    const uLightning1 = this.uLightning1;
    const uLightningColor = this.uLightningColor;
    const uFrame = this.uFrame;
    const uHistoryBlend = this.uHistoryBlend;
    const uResolution = this.uResolution;
    const uDebugMode = this.uDebugMode;
    const historyTex = this.historyTexNode;
    const sceneDepthTex = this.sceneDepthTexNode;

    const MARCH_STEPS = quality.marchSteps;
    const LIGHT_STEPS = quality.lightSteps;

    /** Tiled weather sample — wind advection is smooth via the offset uniform. */
    const sampleWeather = (posAbsXZ: NodeRef): NodeRef => {
      const wuv = fract(posAbsXZ.sub(uWindOffset).div(WEATHER_DOMAIN_METERS));
      return weatherTex.sample(wuv).level(float(0));
    };

    /**
     * Cloud density at a point. `posLocal` is relative to the camera's sea-level
     * origin (x/z) with y = true altitude following earth curvature.
     * Returns vec2(density, precip).
     */
    const cloudDensity = (
      posLocalXZ: NodeRef,
      altitude: NodeRef,
      withDetail: boolean
    ): NodeRef => {
      const posAbsXZ = posLocalXZ.add(uCamAbsXZ);
      const weather = sampleWeather(posAbsXZ).toVar();
      const coverage = weather.x.mul(uGlobalCoverage).clamp(0, 1);
      const cloudType = weather.y;
      const precip = weather.z;
      const clearAir = weather.w;

      const hNorm = altitude.sub(uCloudBase).div(uCloudThickness).clamp(0, 1);
      // Effective layer height by type: stratus fill more of the slab at horizon
      const layerHeight = mix(float(0.58), float(1.12), cloudType);
      const hRel = hNorm.div(layerHeight).clamp(0, 1.35);

      // Vertical profile: rounded base, type-dependent top; anvil spread near cb tops
      const bottom = smoothstep(float(0.0), float(0.09), hRel);
      const top = float(1).sub(smoothstep(mix(float(0.22), float(0.72), cloudType), float(1.0), hRel));
      const tower = smoothstep(float(0.12), float(0.48), hRel)
        .mul(float(1).sub(smoothstep(float(0.74), float(1.08), hRel)))
        .mul(smoothstep(float(0.35), float(1.0), cloudType))
        .mul(smoothstep(float(0.18), float(0.92), precip.add(coverage.mul(0.35))));
      const anvil = smoothstep(float(0.62), float(0.95), hRel)
        .mul(smoothstep(float(0.65), float(1), cloudType))
        .mul(smoothstep(float(0.3), float(1), precip.add(cloudType.mul(0.25))))
        .mul(0.42);
      const profile = bottom
        .mul(top.add(tower.mul(0.35)).clamp(0, 1.18))
        .mul(smoothstep(float(1.34), float(1.0), hRel));

      // Wind drift with mild vertical shear so tops lag behind bases
      const shear = hNorm.mul(mix(float(0.42), float(1.08), cloudType)).add(0.72);
      const crossShear = vec2(uWindDir.y.negate(), uWindDir.x).mul(uWindOffset.length().mul(hNorm.mul(hNorm)).mul(cloudType).mul(0.18));
      const drift = uWindOffset.mul(shear).add(crossShear);
      const noisePos = vec3(
        posAbsXZ.x.sub(drift.x),
        altitude,
        posAbsXZ.y.sub(drift.y)
      );

      const basePN: NodeRef = baseNoise.sample(noisePos.div(BASE_NOISE_METERS)).level(float(0));
      const baseFbm = basePN.y.mul(0.625).add(basePN.z.mul(0.25)).add(basePN.w.mul(0.125));
      const baseShape = remapNode(basePN.x, baseFbm.sub(1), float(1), float(0), float(1));

      const erosion = clearAir.mul(mix(float(0.28), float(0.72), cloudType)).mul(mix(float(0.45), float(1), hNorm));
      const coverageMod = coverage
        .add(anvil)
        .sub(erosion)
        .clamp(0, 1)
        .mul(profile);
      let cloud: NodeRef = remapNode(baseShape, float(1).sub(coverageMod), float(1), float(0), float(1))
        .mul(coverageMod)
        .max(0);

      if (withDetail) {
        const detailPos = noisePos.div(DETAIL_NOISE_METERS);
        const detailPN: NodeRef = detailNoise.sample(detailPos).level(float(0));
        const detailFbm = detailPN.x.mul(0.625).add(detailPN.y.mul(0.25)).add(detailPN.z.mul(0.125));
        // Wispy erosion at the base, billowy rounded erosion higher up
        const detailMod = mix(detailFbm, float(1).sub(detailFbm), hRel.mul(4).clamp(0, 1));
        cloud = remapNode(cloud, detailMod.mul(0.32), float(1), float(0), float(1)).max(0);
      }

      // Slightly denser tops for crisper sun-lit crowns
      const heightDensity = mix(float(0.72), float(1.2), hRel.clamp(0, 1)).add(tower.mul(0.16));
      return vec2(cloud.mul(heightDensity), precip.mul(float(1).sub(clearAir.mul(0.55))));
    };

    /** Ray-sphere against earth-centered sphere. ro is relative to earth center. */
    const raySphere = (roc: NodeRef, rd: NodeRef, radius: NodeRef): NodeRef => {
      const b = dot(roc, rd);
      const c = dot(roc, roc).sub(radius.mul(radius));
      const disc = b.mul(b).sub(c);
      const s = sqrt(max(disc, 0));
      const near = b.negate().sub(s);
      const far = b.negate().add(s);
      // miss flagged by far < near via disc sign
      return vec3(near, far, disc);
    };

    const henyeyGreenstein = (cosTheta: NodeRef, g: number): NodeRef => {
      const g2 = g * g;
      const denom = float(1 + g2).sub(cosTheta.mul(2 * g)).pow(1.5).max(1e-4);
      return float((1 - g2) / (4 * Math.PI)).div(denom);
    };

    return Fn(() => {
      const screenPos: NodeRef = uv();
      const ndc = screenPos.mul(2).sub(1);
      const debugWeather: NodeRef = weatherTex.sample(screenPos).level(float(0));
      const seamEdge = float(1)
        .sub(smoothstep(float(0.0), float(0.012), screenPos.x))
        .max(smoothstep(float(0.988), float(1.0), screenPos.x))
        .max(float(1).sub(smoothstep(float(0.0), float(0.012), screenPos.y)))
        .max(smoothstep(float(0.988), float(1.0), screenPos.y));
      const debugCoverage = vec4(vec3(debugWeather.x), 0);
      const debugType = vec4(vec3(debugWeather.y), 0);
      const debugPrecip = vec4(vec3(debugWeather.z), 0);
      const debugErosion = vec4(vec3(debugWeather.w), 0);
      const debugDensity = vec4(vec3(debugWeather.x.mul(float(1).sub(debugWeather.w)).mul(debugWeather.y.mul(0.35).add(0.65))), 0);
      const debugHistory = vec4(vec3(uHistoryBlend), 0);
      const debugSeam = vec4(debugWeather.x, debugWeather.w, seamEdge, 0);
      const debugOut = debugCoverage.toVar();
      If(uDebugMode.greaterThan(1.5).and(uDebugMode.lessThan(2.5)), () => {
        debugOut.assign(debugType);
      })
        .ElseIf(uDebugMode.greaterThan(2.5).and(uDebugMode.lessThan(3.5)), () => {
          debugOut.assign(debugPrecip);
        })
        .ElseIf(uDebugMode.greaterThan(3.5).and(uDebugMode.lessThan(4.5)), () => {
          debugOut.assign(debugErosion);
        })
        .ElseIf(uDebugMode.greaterThan(4.5).and(uDebugMode.lessThan(5.5)), () => {
          debugOut.assign(debugDensity);
        })
        .ElseIf(uDebugMode.greaterThan(5.5).and(uDebugMode.lessThan(6.5)), () => {
          debugOut.assign(debugHistory);
        })
        .ElseIf(uDebugMode.greaterThan(6.5), () => {
          debugOut.assign(debugSeam);
        });

      // Reconstruct the world-space view ray from the scene camera matrices
      const viewDir4: NodeRef = uInvProj.mul(vec4(ndc.x, ndc.y, 0.5, 1));
      const viewDir = viewDir4.xyz.div(viewDir4.w);
      const viewDirNorm = viewDir.normalize();
      const worldDir: NodeRef = uCamWorld.mul(vec4(viewDir, 0)).xyz.normalize().toVar();
      const sceneDepthUV: NodeRef = sceneDepthUvFromScreenUv(screenPos);
      const sceneDepthRaw: NodeRef = sceneDepthTex.sample(sceneDepthUV).r;
      const sceneViewZ: NodeRef = perspectiveDepthToViewZ(sceneDepthRaw, uCameraNear, uCameraFar);
      const sceneDistance: NodeRef = sceneViewZ.div(viewDirNorm.z).max(0);
      const validSceneDepth = uHasSceneDepth.greaterThan(0.5).and(sceneDepthRaw.lessThan(0.999999));

      // Local frame: origin at sea level directly below the camera
      const camAltitude = uCamPos.y;
      const earthCenterOffset = vec3(0, camAltitude.add(EARTH_RADIUS), 0);

      const rBase = float(EARTH_RADIUS).add(uCloudBase);
      const rTop = float(EARTH_RADIUS).add(uCloudBase).add(uCloudThickness);

      const hitBase: NodeRef = raySphere(earthCenterOffset, worldDir, rBase);
      const hitTop: NodeRef = raySphere(earthCenterOffset, worldDir, rTop);

      const camRadius = camAltitude.add(EARTH_RADIUS);
      const belowLayer = camRadius.lessThan(rBase);
      const aboveLayer = camRadius.greaterThan(rTop);

      // March interval [start, end] through the cloud shell
      const start = float(0).toVar();
      const end = float(-1).toVar();

      If(belowLayer, () => {
        start.assign(hitBase.y.max(0));
        end.assign(hitTop.y);
      })
        .ElseIf(aboveLayer, () => {
          If(hitTop.z.greaterThan(0).and(hitTop.x.greaterThan(0)), () => {
            start.assign(hitTop.x);
            const hitsBase = hitBase.z.greaterThan(0).and(hitBase.x.greaterThan(0));
            end.assign(hitsBase.select(hitBase.x, hitTop.y));
          });
        })
        .Else(() => {
          start.assign(0);
          const hitsBase = hitBase.z.greaterThan(0).and(hitBase.x.greaterThan(0));
          end.assign(hitsBase.select(hitBase.x, hitTop.y));
        });

      // Analytic occlusion by the sea surface (plane y = 0)
      If(worldDir.y.lessThan(-0.0005), () => {
        const tOcean = camAltitude.div(worldDir.y.negate());
        end.assign(end.min(tOcean));
      });

      const radiance = vec3(0).toVar();
      const transmittance = float(1).toVar();
      const firstHitDistance = float(-1).toVar();

      // Per-ray constants for lighting. A small isotropic floor keeps the
      // sun-facing sides of clouds from going black when viewed down-sun.
      const isoFloor = float(0.06);
      const cosTheta = dot(worldDir, uKeyLightDir);
      const phase0 = henyeyGreenstein(cosTheta, 0.72)
        .mul(0.72)
        .add(henyeyGreenstein(cosTheta, -0.22).mul(0.28))
        .add(isoFloor);
      const phase1 = henyeyGreenstein(cosTheta, 0.72 * 0.65)
        .mul(0.72)
        .add(henyeyGreenstein(cosTheta, -0.14).mul(0.28))
        .add(isoFloor);
      const phase2 = henyeyGreenstein(cosTheta, 0.72 * 0.42)
        .mul(0.72)
        .add(henyeyGreenstein(cosTheta, -0.09).mul(0.28))
        .add(isoFloor);

      // Interleaved gradient noise, animated per frame, hides banding
      const ign = fract(
        float(52.9829189).mul(
          fract(
            dot(screenPos.mul(uResolution), vec2(0.06711056, 0.00583715)).add(
              uFrame.mul(0.6180339887)
            )
          )
        )
      );

      If(end.greaterThan(start.add(1)).and(transmittance.greaterThan(0)), () => {
        const stepLen = end.sub(start).div(MARCH_STEPS);
        const extinctionScale = uDensityMult.mul(0.032).add(0.008);

        Loop(MARCH_STEPS, ({ i }: { i: NodeRef }) => {
          If(transmittance.lessThan(0.004), () => {
            Break();
          });

          const t = start.add(i.toFloat().add(ign).mul(stepLen));
          // Local frame: xz relative to the camera column, y = altitude above sea
          const pos = vec3(
            worldDir.x.mul(t),
            camAltitude.add(worldDir.y.mul(t)),
            worldDir.z.mul(t)
          ).toVar();
          // True altitude on the curved earth
          const altitude = pos
            .add(vec3(0, EARTH_RADIUS, 0))
            .length()
            .sub(EARTH_RADIUS);

          const sampleResult: NodeRef = cloudDensity(pos.xz, altitude, true).toVar();
          const density = sampleResult.x;
          const precip = sampleResult.y;

          If(density.greaterThan(0.001), () => {
            If(firstHitDistance.lessThan(0), () => {
              firstHitDistance.assign(t);
            });

            const sigmaT = density.mul(extinctionScale).mul(precip.mul(0.45).add(1));

            // Sun visibility: short march toward the key light
            const sunOD = float(0).toVar();
            const lightStepBase = uCloudThickness.mul(0.16).div(LIGHT_STEPS).add(28);
            for (let ls = 0; ls < LIGHT_STEPS; ls += 1) {
              const lt = lightStepBase.mul(Math.pow(1.65, ls) * (ls + 1) * 0.5 + 0.5);
              const lpos = pos.add(uKeyLightDir.mul(lt)).toVar();
              const laltitude = lpos
                .add(vec3(0, EARTH_RADIUS, 0))
                .length()
                .sub(EARTH_RADIUS);
              const ldensity: NodeRef = cloudDensity(lpos.xz, laltitude, false).x;
              // 0.72 shadow softening: light leaks around the discrete samples
              sunOD.addAssign(ldensity.mul(extinctionScale).mul(0.72).mul(lightStepBase.mul(Math.pow(1.65, ls))));
            }

            // Wrenninge multi-scattering octaves + powder edge darkening
            const powder = float(1).sub(exp(sunOD.mul(-2))).mul(0.65).add(0.35);
            const sunTerm = exp(sunOD.negate())
              .mul(phase0)
              .add(exp(sunOD.mul(-0.42)).mul(phase1).mul(0.55))
              .add(exp(sunOD.mul(-0.18)).mul(phase2).mul(0.28))
              .mul(powder);

            // Sky irradiance dominates the look of overcast clouds: strong
            // top-lit gradient, darker toward the cloud belly.
            const hNorm = altitude.sub(uCloudBase).div(uCloudThickness).clamp(0, 1);
            const ambient = mix(uAmbientBottom, uAmbientTop, hNorm).mul(
              mix(float(0.3), float(1), hNorm)
            );

            // Rain cells and storm bases are darker (soot-in-the-bottle look)
            const albedo = float(1)
              .sub(uDarkening.mul(0.38).mul(float(1).sub(hNorm)))
              .sub(precip.mul(0.3))
              .clamp(0.25, 1);

            // Lightning in-scattering from up to two point flashes.
            // Flash positions arrive in render space; shift into the local frame.
            const camXZ = vec3(uCamPos.x, 0, uCamPos.z);
            const toL0 = pos.sub(uLightning0.xyz.sub(camXZ));
            const distSq0 = dot(toL0, toL0).add(250000);
            const l0 = uLightning0.w.div(distSq0).mul(exp(dot(toL0, toL0).sqrt().mul(-0.0006)));
            const toL1 = pos.sub(uLightning1.xyz.sub(camXZ));
            const distSq1 = dot(toL1, toL1).add(250000);
            const l1 = uLightning1.w.div(distSq1).mul(exp(dot(toL1, toL1).sqrt().mul(-0.0006)));
            const lightningLight = uLightningColor.mul(l0.add(l1));

            const source = uKeyLightRadiance
              .mul(sunTerm)
              .add(ambient.mul(0.6))
              .add(lightningLight)
              .mul(sigmaT)
              .mul(albedo);

            // Energy-conserving integration (Frostbite)
            const stepTrans = exp(sigmaT.negate().mul(stepLen));
            const integrated = source.sub(source.mul(stepTrans)).div(sigmaT.max(1e-5));
            radiance.addAssign(integrated.mul(transmittance));
            transmittance.mulAssign(stepTrans);
          });
        });
      });

      // ---------------------------------------------------------------- cirrus
      If(uCirrus.greaterThan(0.005).and(transmittance.greaterThan(0.01)), () => {
        const rCirrus = float(EARTH_RADIUS + CIRRUS_ALTITUDE);
        const hitCirrus: NodeRef = raySphere(earthCenterOffset, worldDir, rCirrus);
        const tCirrus = hitCirrus.y;
        If(hitCirrus.z.greaterThan(0).and(tCirrus.greaterThan(0)).and(camAltitude.lessThan(CIRRUS_ALTITUDE)), () => {
          const posXZ = worldDir.xz.mul(tCirrus).add(uCamAbsXZ).sub(uWindOffset.mul(1.8));
          const along = dot(posXZ, uWindDir);
          const across = dot(posXZ, vec2(uWindDir.y.negate(), uWindDir.x));
          const cuv = vec2(along.div(64000), across.div(15000));
          const streaks = cirrusFbm(cuv);
          const cover: NodeRef = smoothstep(float(1).sub(uCirrus.mul(0.75)), float(1.25).sub(uCirrus.mul(0.75)), streaks.add(0.35))
            .mul(uCirrus)
            .mul(smoothstep(float(0.0), float(0.06), worldDir.y));
          If(cover.greaterThan(0.001).and(firstHitDistance.lessThan(0)), () => {
            firstHitDistance.assign(tCirrus);
          });
          const cirrusTrans = exp(cover.mul(-1.4));
          const phaseCirrus = henyeyGreenstein(cosTheta, 0.55).mul(12).add(0.35);
          const cirrusColor = uKeyLightRadiance
            .mul(phaseCirrus)
            .mul(0.09)
            .add(uAmbientTop.mul(0.05));
          radiance.addAssign(cirrusColor.mul(float(1).sub(cirrusTrans)).mul(transmittance));
          transmittance.mulAssign(cirrusTrans);
        });
      });

      // Aerial perspective: distant clouds sink into the haze
      const fogAmount: NodeRef = float(1).sub(exp(start.max(0).mul(uFogDensity.mul(-0.55))));
      radiance.assign(mix(radiance, uFogColor.mul(float(1).sub(transmittance)).mul(0.85), fogAmount));

      // Horizon fill: only shallow sky rays get stratus haze. Looking down at
      // the ocean must not composite cloud haze over the water foreground.
      const aboveHorizonFade: NodeRef = smoothstep(float(-0.045), float(0.008), worldDir.y);
      const horizonWeight: NodeRef = aboveHorizonFade.mul(
        float(1).sub(smoothstep(float(0.004), float(0.16), worldDir.y))
      );
      const horizonWeather: NodeRef = sampleWeather(uCamAbsXZ.add(worldDir.xz.mul(WEATHER_DOMAIN_METERS * 0.35)));
      const horizonLocal = horizonWeather.x.mul(float(1).sub(horizonWeather.w.mul(0.75))).clamp(0, 1);
      const horizonFill: NodeRef = uGlobalCoverage.mul(horizonLocal).mul(horizonWeight).mul(0.72).clamp(0, 1);
      If(horizonFill.greaterThan(0.001).and(firstHitDistance.lessThan(0)), () => {
        firstHitDistance.assign(start.max(0));
      });
      const horizonColor = mix(uAmbientBottom, uFogColor, float(0.55));
      radiance.addAssign(horizonColor.mul(horizonFill).mul(0.48).mul(transmittance));
      transmittance.mulAssign(float(1).sub(horizonFill.mul(0.68)));

      const current = vec4(radiance, transmittance);

      // -------------------------------------------------------- temporal blend
      const prevClip: NodeRef = uPrevProjView.mul(vec4(worldDir, 0));
      const prevUV = prevClip.xy.div(prevClip.w.max(1e-5)).mul(0.5).add(0.5);
      const inBounds = prevClip.w
        .greaterThan(0)
        .and(prevUV.x.greaterThanEqual(0))
        .and(prevUV.x.lessThanEqual(1))
        .and(prevUV.y.greaterThanEqual(0))
        .and(prevUV.y.lessThanEqual(1));
      const history: NodeRef = historyTex.sample(prevUV).level(float(0));
      const texel = vec2(1).div(uResolution);
      const h1: NodeRef = historyTex.sample(prevUV.add(vec2(texel.x, 0))).level(float(0));
      const h2: NodeRef = historyTex.sample(prevUV.sub(vec2(texel.x, 0))).level(float(0));
      const h3: NodeRef = historyTex.sample(prevUV.add(vec2(0, texel.y))).level(float(0));
      const h4: NodeRef = historyTex.sample(prevUV.sub(vec2(0, texel.y))).level(float(0));
      const hMin = history.min(h1).min(h2).min(h3).min(h4);
      const hMax = history.max(h1).max(h2).max(h3).max(h4);
      const clampedHistory = history.max(hMin.sub(0.08)).min(hMax.add(0.08));
      const blend = uHistoryBlend.mul(inBounds.select(float(1), float(0)));

      const temporal = mix(current, clampedHistory, blend);
      const cloudOcclusionMask = validSceneDepth
        .and(firstHitDistance.greaterThan(0))
        .and(sceneDistance.add(uDepthBias).lessThan(firstHitDistance))
        .select(float(1), float(0));
      const finalDebug = debugOut.toVar();
      If(uDebugMode.greaterThan(7.5).and(uDebugMode.lessThan(8.5)), () => {
        finalDebug.assign(vec4(vec3(sceneViewZ.negate().div(8000).clamp(0, 1)), 0));
      })
        .ElseIf(uDebugMode.greaterThan(8.5).and(uDebugMode.lessThan(9.5)), () => {
          finalDebug.assign(vec4(vec3(end.max(0).div(16000).clamp(0, 1)), 0));
        })
        .ElseIf(uDebugMode.greaterThan(9.5).and(uDebugMode.lessThan(10.5)), () => {
          finalDebug.assign(vec4(vec3(firstHitDistance.max(0).div(16000).clamp(0, 1)), 0));
        })
        .ElseIf(uDebugMode.greaterThan(10.5), () => {
          finalDebug.assign(vec4(cloudOcclusionMask, float(1).sub(cloudOcclusionMask), 0, 0));
        });
      return uDebugMode.greaterThan(0.5).select(finalDebug, temporal);
    })();

    /** Anisotropic FBM for cirrus streaks, stretched along the wind. */
    function cirrusFbm(p: NodeRef): NodeRef {
      let sum: NodeRef = float(0);
      let amplitude = 0.5;
      let current: NodeRef = p;
      for (let i = 0; i < 4; i += 1) {
        sum = sum.add(valueNoiseLocal(current).mul(amplitude));
        amplitude *= 0.55;
        current = current.mul(vec2(2.3, 1.9)).add(vec2(13.7, 5.1));
      }
      return sum;
    }

    function valueNoiseLocal(p: NodeRef): NodeRef {
      const pi: NodeRef = p.floor();
      const pf: NodeRef = p.fract();
      const w: NodeRef = pf.mul(pf).mul(float(3).sub(pf.mul(2)));
      const h = (offset: NodeRef): NodeRef =>
        fract(dot(pi.add(offset), vec2(12.9898, 78.233)).sin().mul(43758.5453));
      const v00 = h(vec2(0, 0));
      const v10 = h(vec2(1, 0));
      const v01 = h(vec2(0, 1));
      const v11 = h(vec2(1, 1));
      return mix(mix(v00, v10, w.x), mix(v01, v11, w.x), w.y);
    }
  }
}

const ATMOSPHERE_DEBUG_MODE_INDEX: Record<AtmosphereDebugMode, number> = {
  off: 0,
  weatherCoverage: 1,
  weatherType: 2,
  precipitation: 3,
  erosion: 4,
  densitySlice: 5,
  historyWeight: 6,
  seamGrid: 7,
  sceneDepth: 8,
  cloudRayEnd: 9,
  cloudFirstHit: 10,
  cloudOcclusionMask: 11
};
