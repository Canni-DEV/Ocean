import * as THREE from "three/webgpu";
import type { DebugSettings, WeatherState } from "../engine/types";

export type WaveSample = {
  height: number;
  normal: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  slope: number;
  curvature: number;
  crestCompression: number;
  breaking: number;
  foam: number;
};

export type WaveComponent = {
  directionRad: number;
  wavelengthMeters: number;
  amplitudeMeters: number;
  speedMs: number;
  steepness: number;
};

export type WaveUniforms = {
  origin: THREE.Vector2;
  windDirectionRad: number;
  swellDirectionRad: number;
  windSpeedMs: number;
  swellStrength: number;
  stormIntensity: number;
  waveScale: number;
  foamIntensity: number;
};

const GRAVITY_MS2 = 9.81;

const BASE_WAVES: WaveComponent[] = [
  { directionRad: 0.0, wavelengthMeters: 210, amplitudeMeters: 1.12, speedMs: 11.4, steepness: 0.48 },
  { directionRad: 0.31, wavelengthMeters: 118, amplitudeMeters: 0.78, speedMs: 9.1, steepness: 0.38 },
  { directionRad: -0.27, wavelengthMeters: 64, amplitudeMeters: 0.42, speedMs: 7.0, steepness: 0.32 },
  { directionRad: 0.74, wavelengthMeters: 37, amplitudeMeters: 0.24, speedMs: 5.5, steepness: 0.25 },
  { directionRad: -0.88, wavelengthMeters: 22, amplitudeMeters: 0.13, speedMs: 4.2, steepness: 0.18 },
  { directionRad: 1.42, wavelengthMeters: 13, amplitudeMeters: 0.065, speedMs: 3.1, steepness: 0.12 },
  { directionRad: -1.55, wavelengthMeters: 8.5, amplitudeMeters: 0.035, speedMs: 2.4, steepness: 0.08 }
];

export class WaveField {
  private weather: WeatherState;
  private settings: DebugSettings;
  private readonly uniforms: WaveUniforms = {
    origin: new THREE.Vector2(),
    windDirectionRad: 0,
    swellDirectionRad: 0,
    windSpeedMs: 0,
    swellStrength: 0,
    stormIntensity: 0,
    waveScale: 1,
    foamIntensity: 1
  };

  constructor(weather: WeatherState, settings: DebugSettings) {
    this.weather = weather;
    this.settings = settings;
    this.update(weather, settings);
  }

  update(weather: WeatherState, settings: DebugSettings): void {
    this.weather = weather;
    this.settings = settings;
    this.uniforms.windDirectionRad = weather.windDirectionRad;
    this.uniforms.swellDirectionRad = weather.swellDirectionRad;
    this.uniforms.windSpeedMs = weather.windSpeedMs;
    this.uniforms.swellStrength = weather.swellStrength;
    this.uniforms.stormIntensity = weather.stormIntensity;
    this.uniforms.waveScale = settings.waveScale;
    this.uniforms.foamIntensity = settings.foamIntensity;
  }

  setOrigin(x: number, z: number): void {
    this.uniforms.origin.set(x, z);
  }

  getGpuUniforms(): WaveUniforms {
    return this.uniforms;
  }

  getComponents(): readonly WaveComponent[] {
    return BASE_WAVES;
  }

  sample(x: number, z: number, timeSeconds: number): WaveSample {
    const waveScale = this.settings.waveScale * THREE.MathUtils.lerp(0.85, 2.2, this.weather.swellStrength);
    const stormScale = THREE.MathUtils.lerp(0.85, 1.85, this.weather.stormIntensity);
    let height = 0;
    let dx = 0;
    let dz = 0;
    let vy = 0;
    let curvature = 0;
    let crestCompression = 0;

    for (let i = 0; i < BASE_WAVES.length; i += 1) {
      const wave = BASE_WAVES[i];
      const direction = this.directionFor(wave, i);
      const dirX = Math.cos(direction);
      const dirZ = Math.sin(direction);
      const k = (Math.PI * 2) / wave.wavelengthMeters;
      const amplitude = wave.amplitudeMeters * waveScale * stormScale;
      const omega = Math.sqrt(GRAVITY_MS2 * k) * THREE.MathUtils.lerp(0.9, 1.18, this.weather.windSpeedMs / 28);
      const phase = (x * dirX + z * dirZ) * k - timeSeconds * omega;
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      const shaped = Math.sign(s) * Math.pow(Math.abs(s), THREE.MathUtils.lerp(1.15, 0.72, wave.steepness));
      height += shaped * amplitude;
      dx += c * amplitude * k * dirX;
      dz += c * amplitude * k * dirZ;
      vy += -c * amplitude * omega;

      const localSteepness = amplitude * k * wave.steepness;
      const crestGate = THREE.MathUtils.smoothstep(shaped, 0.74, 0.96);
      const localCurvature = Math.max(0, s * amplitude * k * k);
      curvature = Math.max(curvature, THREE.MathUtils.clamp(localCurvature * 42, 0, 1));
      crestCompression = Math.max(
        crestCompression,
        THREE.MathUtils.clamp(localSteepness * crestGate * 3.4, 0, 1)
      );
    }

    const normal = new THREE.Vector3(-dx, 1, -dz).normalize();
    const slope = THREE.MathUtils.clamp(Math.hypot(dx, dz) * 3.5, 0, 1);
    const breaking = THREE.MathUtils.clamp(
      THREE.MathUtils.smoothstep(slope, 0.2, 0.82) * 0.42 +
        crestCompression * 0.48 +
        curvature * 0.34 +
        this.weather.stormIntensity * 0.18 +
        this.weather.precipitation * 0.08,
      0,
      1
    );
    const foam = this.settings.showFoam
      ? THREE.MathUtils.clamp(breaking * this.settings.foamIntensity, 0, 1)
      : 0;

    return {
      height,
      normal: { x: normal.x, y: normal.y, z: normal.z },
      velocity: { x: 0, y: vy, z: 0 },
      slope,
      curvature,
      crestCompression,
      breaking,
      foam
    };
  }

  private directionFor(wave: WaveComponent, index: number): number {
    if (index < 2) {
      return this.weather.swellDirectionRad + wave.directionRad;
    }

    return THREE.MathUtils.lerp(this.weather.windDirectionRad, this.weather.swellDirectionRad, 0.35) + wave.directionRad;
  }
}
