import * as THREE from "three/webgpu";
import {
  Fn,
  exp,
  float,
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
 * Top-down cloud transmittance map: for each texel the density field is
 * integrated vertically through the cloud slab (weather map + base noise, no
 * detail erosion) along the sun's slant, producing moving patches of light and
 * shadow that the ocean material samples to modulate direct sunlight.
 */
export class CloudShadowMap {
  readonly texture: THREE.StorageTexture;

  /** Snapped domain center in absolute world coordinates. */
  readonly domainCenterAbs = new THREE.Vector2();

  /** Uniform with the domain center in render space, consumed by samplers. */
  readonly uCenterRender: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;

  private readonly pass: NodeRef;
  private readonly uCenterAbs: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;
  private readonly uSunDir: AnyUniform<THREE.Vector3> = uniform(new THREE.Vector3(0, 1, 0)) as any;
  private readonly uCloudBase: AnyUniform<number> = uniform(1200) as any;
  private readonly uCloudThickness: AnyUniform<number> = uniform(1500) as any;
  private readonly uDensityMult: AnyUniform<number> = uniform(0.6) as any;
  private readonly uWeatherCenter: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;
  private readonly uWindOffset: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;

  private lastKey = "";

  constructor(noiseTextures: CloudNoiseTextures, weatherMap: WeatherMap) {
    this.texture = new THREE.StorageTexture(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.texture.name = "cloud-shadow-map";
    this.texture.type = THREE.HalfFloatType;
    this.texture.format = THREE.RGBAFormat;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
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
    const texel = SHADOW_DOMAIN_METERS / SHADOW_MAP_SIZE;
    const snappedX = Math.round(cameraAbsX / texel) * texel;
    const snappedZ = Math.round(cameraAbsZ / texel) * texel;
    this.domainCenterAbs.set(snappedX, snappedZ);
    this.uCenterRender.value.set(snappedX - originOffset.x, snappedZ - originOffset.z);

    const key = [
      snappedX,
      snappedZ,
      Math.round(weatherMap.windOffsetMeters.x / texel),
      Math.round(weatherMap.windOffsetMeters.y / texel),
      weather.cloudCoverage.toFixed(3),
      weather.cloudDensity.toFixed(3),
      weather.convectivity.toFixed(3),
      sunDirection.x.toFixed(2),
      sunDirection.y.toFixed(2),
      sunDirection.z.toFixed(2)
    ].join("|");
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.uCenterAbs.value.set(snappedX, snappedZ);
    this.uSunDir.value.copy(sunDirection).normalize();
    this.uCloudBase.value = weather.cloudBaseMeters;
    this.uCloudThickness.value = Math.max(200, weather.cloudThicknessMeters);
    this.uDensityMult.value = weather.cloudDensity;
    this.uWeatherCenter.value.copy(weatherMap.domainCenterAbs);
    this.uWindOffset.value.copy(weatherMap.windOffsetMeters);

    renderer.compute(this.pass);
  }

  /**
   * TSL helper: shadow factor (0 = fully shadowed, 1 = full sun) at a
   * render-space world position. Falls back to 1 outside the domain.
   */
  sampleShadow(positionRenderXZ: NodeRef): NodeRef {
    const shadowTex = texture(this.texture);
    const uvNode: NodeRef = positionRenderXZ.sub(this.uCenterRender).div(SHADOW_DOMAIN_METERS).add(0.5);
    const centered: NodeRef = uvNode.sub(0.5).abs();
    const inDomain: NodeRef = smoothstep(float(0.5), float(0.46), centered.x.max(centered.y));
    const shadow: NodeRef = shadowTex.sample(uvNode).x;
    return mix(float(1), shadow, inDomain.clamp(0, 1));
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
    const uWeatherCenter = this.uWeatherCenter;
    const uWindOffset = this.uWindOffset;

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);

      const uvCentered = vec2(x.toFloat(), y.toFloat()).add(0.5).div(n).sub(0.5);
      const groundAbs = uvCentered.mul(SHADOW_DOMAIN_METERS).add(uCenterAbs);

      // Slant: horizontal drift of the sun ray per meter of altitude
      const sunY = uSunDir.y.max(0.08);
      const slant = uSunDir.xz.div(sunY);

      const opticalDepth = float(0).toVar();
      const stepH = uCloudThickness.div(SHADOW_HEIGHT_SAMPLES);

      for (let s = 0; s < SHADOW_HEIGHT_SAMPLES; s += 1) {
        const altitude = uCloudBase.add(stepH.mul(s + 0.5));
        const posAbsXZ = groundAbs.add(slant.mul(altitude));

        const wuv = posAbsXZ.sub(uWeatherCenter).div(WEATHER_DOMAIN_METERS).add(0.5);
        const weather: NodeRef = weatherTex.sample(wuv).level(float(0));
        const coverage = weather.x;
        const cloudType = weather.y;

        const hNorm = altitude.sub(uCloudBase).div(uCloudThickness).clamp(0, 1);
        const layerHeight = mix(float(0.28), float(1.0), cloudType);
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

      // Soften: clouds are far above, sun shadows have wide penumbras at sea level
      const transmittanceOut = exp(opticalDepth.negate().mul(0.7)).clamp(0.06, 1);

      textureStore(target, texel, vec4(transmittanceOut, transmittanceOut, transmittanceOut, 1));
    })().compute(n * n);
  }
}
