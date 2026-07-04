import * as THREE from "three/webgpu";
import {
  Fn,
  exp,
  float,
  fract,
  instanceIndex,
  mix,
  smoothstep,
  texture,
  texture3D,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import type { WeatherState } from "../../engine/types";
import type { CloudNoiseTextures } from "./CloudNoiseTextures";
import type { WeatherMap } from "./WeatherMap";
import { WEATHER_DOMAIN_METERS } from "./WeatherMap";
import { remapNode } from "./noise";

type NodeRef = any;
type AnyUniform<T> = any & { value: T };

export const SHADOW_MAP_SIZE = 512;
/** World-space extent covered by the cloud shadow map, in meters. */
export const SHADOW_DOMAIN_METERS = 16000;
const BASE_NOISE_METERS = 8000;
const SHADOW_HEIGHT_SAMPLES = 8;

/**
 * Camera-centered top-down cloud transmittance map. Follows the camera
 * smoothly (no texel snapping) and tiles with RepeatWrapping so ocean
 * samples never hit a hard domain edge.
 */
export class CloudShadowMap {
  readonly texture: THREE.StorageTexture;

  /** Domain center in render space, updated every frame without snapping. */
  readonly uCenterRender: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;

  private readonly pass: NodeRef;
  private readonly uCenterAbs: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;
  private readonly uSunDir: AnyUniform<THREE.Vector3> = uniform(new THREE.Vector3(0, 1, 0)) as any;
  private readonly uCloudBase: AnyUniform<number> = uniform(1200) as any;
  private readonly uCloudThickness: AnyUniform<number> = uniform(1500) as any;
  private readonly uDensityMult: AnyUniform<number> = uniform(0.6) as any;
  private readonly uGlobalCoverage: AnyUniform<number> = uniform(0.5) as any;
  private readonly uWindOffset: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;

  private lastCoverage = -1;
  private lastDensity = -1;
  private lastConvectivity = -1;
  private lastSunX = 999;
  private lastSunY = 999;
  private lastSunZ = 999;

  constructor(noiseTextures: CloudNoiseTextures, weatherMap: WeatherMap) {
    this.texture = new THREE.StorageTexture(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.texture.name = "cloud-shadow-map";
    this.texture.type = THREE.HalfFloatType;
    this.texture.format = THREE.RGBAFormat;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    (this.texture as any).mipmapsAutoUpdate = false;

    this.pass = this.createPass(noiseTextures, weatherMap);
  }

  update(
    renderer: THREE.WebGPURenderer,
    weather: WeatherState,
    sunDirection: THREE.Vector3,
    weatherMap: WeatherMap,
    cameraAbsX: number,
    cameraAbsZ: number,
    originOffset: { x: number; z: number }
  ): void {
    this.uCenterRender.value.set(cameraAbsX - originOffset.x, cameraAbsZ - originOffset.z);

    const sunChanged =
      Math.abs(sunDirection.x - this.lastSunX) > 0.008 ||
      Math.abs(sunDirection.y - this.lastSunY) > 0.008 ||
      Math.abs(sunDirection.z - this.lastSunZ) > 0.008;
    const weatherChanged =
      Math.abs(weather.cloudCoverage - this.lastCoverage) > 0.0008 ||
      Math.abs(weather.cloudDensity - this.lastDensity) > 0.0008 ||
      Math.abs(weather.convectivity - this.lastConvectivity) > 0.0008;

    if (!sunChanged && !weatherChanged) return;

    this.lastSunX = sunDirection.x;
    this.lastSunY = sunDirection.y;
    this.lastSunZ = sunDirection.z;
    this.lastCoverage = weather.cloudCoverage;
    this.lastDensity = weather.cloudDensity;
    this.lastConvectivity = weather.convectivity;

    this.uCenterAbs.value.set(cameraAbsX, cameraAbsZ);
    this.uSunDir.value.copy(sunDirection).normalize();
    this.uCloudBase.value = weather.cloudBaseMeters;
    this.uCloudThickness.value = Math.max(200, weather.cloudThicknessMeters);
    this.uDensityMult.value = weather.cloudDensity;
    this.uGlobalCoverage.value = weather.cloudCoverage;
    this.uWindOffset.value.copy(weatherMap.windOffsetMeters);

    renderer.compute(this.pass);
  }

  /** Shadow factor (0 = shadowed, 1 = full sun) at render-space XZ. */
  sampleShadow(positionRenderXZ: NodeRef): NodeRef {
    const shadowTex = texture(this.texture);
    const uvNode: NodeRef = fract(
      positionRenderXZ.sub(this.uCenterRender).div(SHADOW_DOMAIN_METERS).add(0.5)
    );
    return shadowTex.sample(uvNode).x;
  }

  dispose(): void {
    this.texture.dispose();
  }

  private createPass(noiseTextures: CloudNoiseTextures, weatherMap: WeatherMap): NodeRef {
    const target = this.texture;
    const n = SHADOW_MAP_SIZE;
    const baseNoise = texture3D(noiseTextures.baseTexture);
    const weatherTex = texture(weatherMap.texture);
    const uCenterAbs = this.uCenterAbs;
    const uSunDir = this.uSunDir;
    const uCloudBase = this.uCloudBase;
    const uCloudThickness = this.uCloudThickness;
    const uDensityMult = this.uDensityMult;
    const uGlobalCoverage = this.uGlobalCoverage;
    const uWindOffset = this.uWindOffset;

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);

      const uvCentered = vec2(x.toFloat(), y.toFloat()).add(0.5).div(n).sub(0.5);
      const groundAbs = uvCentered.mul(SHADOW_DOMAIN_METERS).add(uCenterAbs);

      const sunY = uSunDir.y.max(0.08);
      const slant = uSunDir.xz.div(sunY);

      const opticalDepth = float(0).toVar();
      const stepH = uCloudThickness.div(SHADOW_HEIGHT_SAMPLES);

      for (let s = 0; s < SHADOW_HEIGHT_SAMPLES; s += 1) {
        const altitude = uCloudBase.add(stepH.mul(s + 0.5));
        const posAbsXZ = groundAbs.add(slant.mul(altitude));

        const wuv = fract(posAbsXZ.sub(uWindOffset).div(WEATHER_DOMAIN_METERS));
        const weather: NodeRef = weatherTex.sample(wuv).level(float(0));
        const coverage = weather.x.mul(uGlobalCoverage).clamp(0, 1);
        const cloudType = weather.y;

        const hNorm = altitude.sub(uCloudBase).div(uCloudThickness).clamp(0, 1);
        const layerHeight = mix(float(0.55), float(1.0), cloudType);
        const hRel = hNorm.div(layerHeight).clamp(0, 1.35);
        const bottom = smoothstep(float(0.0), float(0.09), hRel);
        const top = float(1).sub(smoothstep(mix(float(0.22), float(0.72), cloudType), float(1.0), hRel));
        const profile = bottom.mul(top);

        const drift = uWindOffset.mul(hNorm.mul(0.35).add(0.75));
        const noisePos = vec3(posAbsXZ.x.sub(drift.x), altitude, posAbsXZ.y.sub(drift.y));
        const basePN: NodeRef = baseNoise.sample(noisePos.div(BASE_NOISE_METERS)).level(float(0));
        const baseFbm = basePN.y.mul(0.625).add(basePN.z.mul(0.25)).add(basePN.w.mul(0.125));
        const baseShape = remapNode(basePN.x, baseFbm.sub(1), float(1), float(0), float(1));

        const coverageMod = coverage.mul(profile);
        const cloud = remapNode(baseShape, float(1).sub(coverageMod), float(1), float(0), float(1))
          .mul(coverageMod)
          .max(0);

        opticalDepth.addAssign(cloud.mul(uDensityMult.mul(0.032).add(0.008)).mul(stepH));
      }

      const transmittanceOut = exp(opticalDepth.negate().mul(0.7)).clamp(0.06, 1);
      textureStore(target, texel, vec4(transmittanceOut, transmittanceOut, transmittanceOut, 1));
    })().compute(n * n);
  }
}
