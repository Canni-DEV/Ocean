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
/** World-space tile size for the repeating weather field, in meters. */
export const WEATHER_DOMAIN_METERS = 60000;

/**
 * World-tiled 2D weather field (RepeatWrapping). Cloud motion comes from
 * subtracting `windOffsetMeters` at sample time in the raymarcher — the
 * texture stays fixed in world space so wind advection is perfectly smooth.
 *
 * Channels: R = local coverage, G = cloud type, B = precipitation cells.
 */
export class WeatherMap {
  readonly texture: THREE.StorageTexture;

  /** Accumulated wind advection offset in absolute world space (meters). */
  readonly windOffsetMeters = new THREE.Vector2();

  private readonly pass: NodeRef;
  private readonly uCoverage: AnyUniform<number> = uniform(0.5) as any;
  private readonly uConvectivity: AnyUniform<number> = uniform(0.3) as any;
  private readonly uPrecipitation: AnyUniform<number> = uniform(0) as any;
  private readonly uStorm: AnyUniform<number> = uniform(0) as any;
  private readonly uMorphTime: AnyUniform<number> = uniform(0) as any;

  private lastCoverage = -1;
  private lastConvectivity = -1;
  private lastPrecipitation = -1;
  private lastStorm = -1;

  constructor() {
    this.texture = new THREE.StorageTexture(WEATHER_MAP_SIZE, WEATHER_MAP_SIZE);
    this.texture.name = "cloud-weather-map";
    this.texture.type = THREE.HalfFloatType;
    this.texture.format = THREE.RGBAFormat;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    (this.texture as any).mipmapsAutoUpdate = false;

    this.pass = this.createPass();
  }

  /**
   * Advects wind offset smoothly every frame. The weather texture is
   * regenerated when scalar weather parameters change or for slow morph
   * animation — never when the camera moves.
   */
  update(
    renderer: THREE.WebGPURenderer,
    weather: WeatherState,
    deltaSeconds: number,
    timeSeconds: number
  ): void {
    this.windOffsetMeters.x += Math.cos(weather.windDirectionRad) * weather.windSpeedMs * deltaSeconds;
    this.windOffsetMeters.y += Math.sin(weather.windDirectionRad) * weather.windSpeedMs * deltaSeconds;

    const morphTime = timeSeconds * 0.003;

    const coverageChanged = Math.abs(weather.cloudCoverage - this.lastCoverage) > 0.0008;
    const convectivityChanged = Math.abs(weather.convectivity - this.lastConvectivity) > 0.0008;
    const precipChanged = Math.abs(weather.precipitation - this.lastPrecipitation) > 0.0008;
    const stormChanged = Math.abs(weather.stormIntensity - this.lastStorm) > 0.0008;

    if (!coverageChanged && !convectivityChanged && !precipChanged && !stormChanged) {
      return;
    }

    this.lastCoverage = weather.cloudCoverage;
    this.lastConvectivity = weather.convectivity;
    this.lastPrecipitation = weather.precipitation;
    this.lastStorm = weather.stormIntensity;

    this.uCoverage.value = weather.cloudCoverage;
    this.uConvectivity.value = weather.convectivity;
    this.uPrecipitation.value = weather.precipitation;
    this.uStorm.value = weather.stormIntensity;
    this.uMorphTime.value = morphTime;

    renderer.compute(this.pass);
  }

  dispose(): void {
    this.texture.dispose();
  }

  private createPass(): NodeRef {
    const target = this.texture;
    const n = WEATHER_MAP_SIZE;
    const uCoverage = this.uCoverage;
    const uConvectivity = this.uConvectivity;
    const uPrecipitation = this.uPrecipitation;
    const uStorm = this.uStorm;
    const uMorphTime = this.uMorphTime;

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);

      // Fixed world tile: repeats seamlessly via RepeatWrapping at sample time
      const worldCell = vec2(x.toFloat(), y.toFloat()).add(0.5).div(n);
      const p = worldCell.mul(WEATHER_DOMAIN_METERS);

      const macroRaw = valueFbm2(p.div(16000).add(vec2(uMorphTime, uMorphTime.mul(0.7))), 5);
      const macro = smoothstep(float(0.32), float(0.68), macroRaw);

      const cellCore = float(1).sub(worley2(p.div(7500).add(vec2(uMorphTime.mul(1.6), 0))));
      const cellSharp = smoothstep(float(0.45), float(0.95), cellCore);

      const convectiveMix = uConvectivity.mul(0.65).add(uStorm.mul(0.35)).clamp(0, 1);
      const signal = mix(macro, macro.max(cellSharp.mul(0.75).add(macro.mul(0.25))), convectiveMix);

      const threshold = float(1).sub(uCoverage);
      const coverage: NodeRef = smoothstep(threshold.sub(0.12), threshold.add(0.22), signal).clamp(0, 1);

      const type: NodeRef = uConvectivity
        .mul(0.45)
        .add(cellSharp.mul(uConvectivity.mul(0.5).add(uStorm.mul(0.35))))
        .add(uStorm.mul(0.2))
        .clamp(0, 1);

      const precip: NodeRef = smoothstep(float(0.35), float(0.85), cellSharp.mul(0.6).add(coverage.mul(0.4)))
        .mul(uPrecipitation)
        .clamp(0, 1);

      textureStore(target, texel, vec4(coverage, type, precip, 1));
    })().compute(n * n);
  }
}
