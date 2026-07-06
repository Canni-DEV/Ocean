import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  fract,
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
import { periodicValueFbm2, periodicWorley2 } from "./noise";

type NodeRef = any;
type AnyUniform<T> = any & { value: T };

export const WEATHER_MAP_SIZE = 1024;
/** World-space tile size for the repeating weather field, in meters. */
export const WEATHER_DOMAIN_METERS = 160000;

/**
 * World-tiled 2D weather field (RepeatWrapping). Cloud motion comes from
 * subtracting `windOffsetMeters` at sample time in the raymarcher — the
 * texture stays fixed in world space so wind advection is perfectly smooth.
 *
 * Channels: R = local coverage, G = cloud type, B = precipitation cells,
 * A = clear-air erosion mask. All channels are generated from periodic fields
 * so the repeated weather domain has no hard world-axis seams.
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
  private lastMorphTime = -1;

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
    const morphChanged = Math.abs(morphTime - this.lastMorphTime) > 0.006;

    if (!coverageChanged && !convectivityChanged && !precipChanged && !stormChanged && !morphChanged) {
      return;
    }

    this.lastCoverage = weather.cloudCoverage;
    this.lastConvectivity = weather.convectivity;
    this.lastPrecipitation = weather.precipitation;
    this.lastStorm = weather.stormIntensity;
    this.lastMorphTime = morphTime;

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

      // Fixed seamless world tile. The normalized domain wraps exactly at 0/1;
      // all noise below uses integer periods so RepeatWrapping has no seams.
      const worldCell = vec2(x.toFloat(), y.toFloat()).add(0.5).div(n);
      const uv = worldCell;

      const warpA = periodicValueFbm2(uv.mul(4), vec2(4, 4), 4).sub(0.5);
      const warpB = periodicValueFbm2(uv.yx.mul(4).add(vec2(1.7, 5.3)), vec2(4, 4), 4).sub(0.5);
      const warpedUv = fract(uv.add(vec2(warpA, warpB).mul(0.085)));

      const macroRaw = periodicValueFbm2(warpedUv.mul(5), vec2(5, 5), 5);
      const macro = smoothstep(float(0.24), float(0.76), macroRaw);

      const mesoA = periodicValueFbm2(warpedUv.mul(13).add(vec2(uMorphTime.mul(0.22), uMorphTime.mul(0.13))), vec2(13, 13), 4);
      const mesoB = periodicValueFbm2(warpedUv.yx.mul(17).add(vec2(6.1, 2.4)), vec2(17, 17), 3);
      const meso = smoothstep(float(0.26), float(0.78), mesoA.mul(0.65).add(mesoB.mul(0.35)));

      const cellUv = fract(warpedUv.add(vec2(mesoA.sub(0.5), mesoB.sub(0.5)).mul(0.045)));
      const cellCore = float(1).sub(periodicWorley2(cellUv.mul(11).add(vec2(uMorphTime.mul(0.35), 0)), vec2(11, 11)));
      const cellSecondary = float(1).sub(periodicWorley2(cellUv.yx.mul(23).add(vec2(3.9, uMorphTime.mul(0.18))), vec2(23, 23)));
      const cellSharp = smoothstep(float(0.46), float(0.98), cellCore.mul(0.72).add(cellSecondary.mul(0.28)));

      const clearSlots = periodicValueFbm2(warpedUv.mul(31).add(vec2(11.7, uMorphTime.mul(0.09))), vec2(31, 31), 3);
      const clearAir = smoothstep(float(0.48), float(0.86), clearSlots)
        .mul(smoothstep(float(0.2), float(1.0), uStorm.add(uConvectivity.mul(0.35))))
        .clamp(0, 1);

      const convectiveMix = uConvectivity.mul(0.65).add(uStorm.mul(0.35)).clamp(0, 1);
      const stormCellSignal = macro.mul(0.34).add(meso.mul(0.28)).add(cellSharp.mul(0.72)).clamp(0, 1);
      const signal = mix(macro.mul(0.72).add(meso.mul(0.28)), stormCellSignal, convectiveMix);

      const threshold = float(1).sub(uCoverage);
      const stormBreakup = clearAir.mul(mix(float(0.12), float(0.42), uStorm));
      const coverage: NodeRef = smoothstep(threshold.sub(0.18), threshold.add(0.28), signal.sub(stormBreakup))
        .mul(float(1).sub(clearAir.mul(mix(float(0.08), float(0.38), uStorm))))
        .clamp(0, 0.985);

      const type: NodeRef = uConvectivity
        .mul(0.32)
        .add(cellSharp.mul(uConvectivity.mul(0.48).add(uStorm.mul(0.42))))
        .add(meso.mul(0.18))
        .add(uStorm.mul(0.16))
        .clamp(0, 1);

      const precip: NodeRef = smoothstep(float(0.38), float(0.9), cellSharp.mul(0.68).add(coverage.mul(0.32)))
        .mul(uPrecipitation)
        .mul(float(1).sub(clearAir.mul(0.55)))
        .clamp(0, 1);

      textureStore(target, texel, vec4(coverage, type, precip, clearAir));
    })().compute(n * n);
  }
}
