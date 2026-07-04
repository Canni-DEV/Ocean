import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  instanceIndex,
  mix,
  smoothstep,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec2,
  vec4
} from "three/tsl";
import type { WeatherState } from "../../engine/types";
import { valueFbm2, worley2 } from "./noise";

type NodeRef = any;
type AnyUniform<T> = any & { value: T };

export const WEATHER_MAP_SIZE = 512;
/** World-space extent covered by the weather map, in meters. */
export const WEATHER_DOMAIN_METERS = 60000;

/**
 * 2D weather field driving the volumetric clouds, regenerated on the GPU when
 * the interpolated weather state or the (snapped) camera-centered domain moves:
 *
 * - R: local cloud coverage 0-1
 * - G: cloud type 0-1 (0 = flat stratus, 1 = towering cumulonimbus)
 * - B: precipitation cell intensity 0-1
 *
 * The field is generated in absolute world coordinates minus the accumulated
 * wind offset, so clouds drift with the wind and stay stable across floating
 * origin shifts.
 */
export class WeatherMap {
  readonly texture: THREE.StorageTexture;

  /** Snapped domain center in absolute world coordinates. */
  readonly domainCenterAbs = new THREE.Vector2();
  /** Accumulated wind advection offset in meters (absolute world space). */
  readonly windOffsetMeters = new THREE.Vector2();

  private readonly pass: NodeRef;
  private readonly uCenter: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;
  private readonly uWindOffset: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;
  private readonly uCoverage: AnyUniform<number> = uniform(0.5) as any;
  private readonly uConvectivity: AnyUniform<number> = uniform(0.3) as any;
  private readonly uPrecipitation: AnyUniform<number> = uniform(0) as any;
  private readonly uStorm: AnyUniform<number> = uniform(0) as any;
  private readonly uMorphTime: AnyUniform<number> = uniform(0) as any;

  private lastKey = "";

  constructor() {
    this.texture = new THREE.StorageTexture(WEATHER_MAP_SIZE, WEATHER_MAP_SIZE);
    this.texture.name = "cloud-weather-map";
    this.texture.type = THREE.HalfFloatType;
    this.texture.format = THREE.RGBAFormat;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    (this.texture as any).mipmapsAutoUpdate = false;

    this.pass = this.createPass();
  }

  /**
   * Advects the field with the wind and regenerates the map when inputs moved
   * enough to matter. `cameraAbsX/Z` are absolute world coordinates.
   */
  update(
    renderer: THREE.WebGPURenderer,
    weather: WeatherState,
    cameraAbsX: number,
    cameraAbsZ: number,
    deltaSeconds: number,
    timeSeconds: number
  ): void {
    this.windOffsetMeters.x += Math.cos(weather.windDirectionRad) * weather.windSpeedMs * deltaSeconds;
    this.windOffsetMeters.y += Math.sin(weather.windDirectionRad) * weather.windSpeedMs * deltaSeconds;

    const texel = WEATHER_DOMAIN_METERS / WEATHER_MAP_SIZE;
    const snappedX = Math.round(cameraAbsX / texel) * texel;
    const snappedZ = Math.round(cameraAbsZ / texel) * texel;
    this.domainCenterAbs.set(snappedX, snappedZ);

    // Quantized key: regenerate only when something visible changed.
    const key = [
      snappedX,
      snappedZ,
      Math.round(this.windOffsetMeters.x / texel),
      Math.round(this.windOffsetMeters.y / texel),
      weather.cloudCoverage.toFixed(3),
      weather.convectivity.toFixed(3),
      weather.precipitation.toFixed(3),
      weather.stormIntensity.toFixed(3),
      Math.round(timeSeconds / 4)
    ].join("|");

    if (key === this.lastKey) return;
    this.lastKey = key;

    this.uCenter.value.set(snappedX, snappedZ);
    this.uWindOffset.value.copy(this.windOffsetMeters);
    this.uCoverage.value = weather.cloudCoverage;
    this.uConvectivity.value = weather.convectivity;
    this.uPrecipitation.value = weather.precipitation;
    this.uStorm.value = weather.stormIntensity;
    this.uMorphTime.value = timeSeconds * 0.002;

    renderer.compute(this.pass);
  }

  dispose(): void {
    this.texture.dispose();
  }

  private createPass(): NodeRef {
    const target = this.texture;
    const n = WEATHER_MAP_SIZE;
    const uCenter = this.uCenter;
    const uWindOffset = this.uWindOffset;
    const uCoverage = this.uCoverage;
    const uConvectivity = this.uConvectivity;
    const uPrecipitation = this.uPrecipitation;
    const uStorm = this.uStorm;
    const uMorphTime = this.uMorphTime;

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);

      const uvCentered = vec2(x.toFloat(), y.toFloat()).add(0.5).div(n).sub(0.5);
      const worldAbs = uvCentered.mul(WEATHER_DOMAIN_METERS).add(uCenter);
      // Wind-advected sampling position (the cloud field drifts downwind)
      const p = worldAbs.sub(uWindOffset);

      // Macro coverage variation: km-scale FBM, slowly morphing over time,
      // contrast-stretched so the full 0-1 range is used.
      const macroRaw = valueFbm2(p.div(16000).add(vec2(uMorphTime, uMorphTime.mul(0.7))), 5);
      const macro = smoothstep(float(0.32), float(0.68), macroRaw);

      // Convective cells: inverted Worley cores that become storm towers
      const cellCore = float(1).sub(worley2(p.div(7500).add(vec2(uMorphTime.mul(1.6), 0))));
      const cellSharp = smoothstep(float(0.45), float(0.95), cellCore);

      // Blend macro field with convective cells according to convectivity
      const convectiveMix = uConvectivity.mul(0.65).add(uStorm.mul(0.35)).clamp(0, 1);
      const signal = mix(macro, macro.max(cellSharp.mul(0.75).add(macro.mul(0.25))), convectiveMix);

      // Threshold so the covered area fraction tracks the requested coverage
      // and growing coverage expands existing cells instead of cross-fading.
      const threshold = float(1).sub(uCoverage);
      const coverage: NodeRef = smoothstep(threshold.sub(0.12), threshold.add(0.22), signal).clamp(0, 1);

      // Cloud type: base type from convectivity, boosted to cumulonimbus at cell cores
      const type: NodeRef = uConvectivity
        .mul(0.45)
        .add(cellSharp.mul(uConvectivity.mul(0.5).add(uStorm.mul(0.35))))
        .add(uStorm.mul(0.2))
        .clamp(0, 1);

      // Precipitation cells: strongest under mature convective cores
      const precip: NodeRef = smoothstep(float(0.35), float(0.85), cellSharp.mul(0.6).add(coverage.mul(0.4)))
        .mul(uPrecipitation)
        .clamp(0, 1);

      textureStore(target, texel, vec4(coverage, type, precip, 1));
    })().compute(n * n);
  }
}
