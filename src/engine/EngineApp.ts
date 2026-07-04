import * as THREE from "three/webgpu";
import { AtmosphereSystem } from "../atmosphere/AtmosphereSystem";
import { OceanRenderer } from "../ocean/OceanRenderer";
import { WaveField } from "../ocean/WaveField";
import { cloneWeather, lerpWeather, WEATHER_PRESETS } from "../state/weather";
import { FrameStats } from "./FrameStats";
import { InputController } from "./InputController";
import type { DebugSettings, EngineMetrics, WeatherPresetName, WeatherState } from "./types";

type EngineAppOptions = {
  canvas: HTMLCanvasElement;
  initialSettings: DebugSettings;
  onMetrics: (metrics: EngineMetrics) => void;
};

const FLOATING_ORIGIN_THRESHOLD_METERS = 5000;
const WEATHER_TRANSITION_SECONDS = 8;

export class EngineApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly onMetrics: (metrics: EngineMetrics) => void;
  private readonly scene = new THREE.Scene();
  private readonly input: InputController;
  private readonly stats = new FrameStats();

  private renderer: THREE.WebGPURenderer | null = null;
  private ocean: OceanRenderer | null = null;
  private waveField: WaveField;
  private atmosphere: AtmosphereSystem | null = null;
  private animationFrame = 0;
  private lastFrameMs = performance.now();
  private lastMetricsMs = 0;
  private disposed = false;
  private settings: DebugSettings;
  private worldTimeHours: number;
  private weatherPreset: WeatherPresetName;
  private weatherSource: WeatherState;
  private weatherTarget: WeatherState;
  private weatherCurrent: WeatherState;
  private weatherTransitionSeconds = WEATHER_TRANSITION_SECONDS;
  private originOffsetMeters = { x: 0, z: 0 };
  private oceanComputeMs: number | null = null;
  private status: EngineMetrics["status"] = "booting";
  private error: string | null = null;

  constructor(options: EngineAppOptions) {
    this.canvas = options.canvas;
    this.onMetrics = options.onMetrics;
    this.settings = { ...options.initialSettings };
    this.worldTimeHours = options.initialSettings.worldTimeHours;
    this.weatherPreset = options.initialSettings.weatherPreset;
    this.weatherSource = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
    this.weatherTarget = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
    this.weatherCurrent = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
    this.waveField = new WaveField(this.weatherCurrent, this.settings);
    this.input = new InputController(this.canvas);
  }

  start(): void {
    void this.init();
  }

  applySettings(settings: DebugSettings): void {
    const previousPreset = this.settings.weatherPreset;
    const previousConfiguredTime = this.settings.worldTimeHours;
    this.settings = { ...settings };

    if (Math.abs(settings.worldTimeHours - previousConfiguredTime) > 0.001) {
      this.worldTimeHours = settings.worldTimeHours;
    }

    if (settings.weatherPreset !== previousPreset) {
      this.weatherPreset = settings.weatherPreset;
      this.weatherSource = cloneWeather(this.weatherCurrent);
      this.weatherTarget = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
      this.weatherTransitionSeconds = 0;
    }

    this.ocean?.applySettings(settings);
    this.atmosphere?.applySettings(settings);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.input.dispose();
    this.ocean?.dispose();
    this.atmosphere?.dispose();
    this.renderer?.dispose();
  }

  private async init(): Promise<void> {
    try {
      if (!("gpu" in navigator) || !navigator.gpu) {
        throw new Error("WebGPU is required for this prototype. Use a current Chrome or Edge desktop build with WebGPU enabled.");
      }

      this.renderer = new THREE.WebGPURenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: false
      });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      await this.renderer.init();

      this.atmosphere = new AtmosphereSystem(this.scene);
      this.ocean = new OceanRenderer({ scene: this.scene, waveField: this.waveField });
      this.atmosphere.applySettings(this.settings);
      this.ocean.applySettings(this.settings);

      window.addEventListener("resize", this.resize);
      this.resize();
      this.status = "running";
      this.loop();
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.publishMetrics();
    }
  }

  private readonly resize = (): void => {
    if (!this.renderer) return;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.input.resize(width, height);
  };

  private loop = (): void => {
    if (this.disposed || !this.renderer || !this.ocean || !this.atmosphere) {
      return;
    }

    const now = performance.now();
    const deltaMs = Math.min(100, now - this.lastFrameMs);
    const deltaSeconds = deltaMs / 1000;
    this.lastFrameMs = now;
    const statStart = this.stats.begin();

    if (!this.settings.paused) {
      this.input.update(deltaSeconds);
      this.worldTimeHours = (this.worldTimeHours + (deltaSeconds * this.settings.timeScale) / 3600) % 24;
      this.updateWeather(deltaSeconds);
      this.applyFloatingOrigin();
    }

    const tunedWeather = this.applyDebugWeatherOverrides(this.weatherCurrent);
    const environment = this.atmosphere.update({
      camera: this.input.camera,
      deltaSeconds,
      weather: tunedWeather,
      worldTimeHours: this.worldTimeHours
    });
    this.oceanComputeMs = this.ocean.update(
      this.input.camera,
      tunedWeather,
      environment,
      this.settings,
      now / 1000
    );

    try {
      this.renderer.render(this.scene, this.input.camera);
    } catch (error: unknown) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }

    this.stats.end(statStart, deltaMs);

    if (now - this.lastMetricsMs > 180) {
      this.lastMetricsMs = now;
      this.publishMetrics();
    }

    this.animationFrame = requestAnimationFrame(this.loop);
  };

  private updateWeather(deltaSeconds: number): void {
    this.weatherTransitionSeconds = Math.min(
      WEATHER_TRANSITION_SECONDS,
      this.weatherTransitionSeconds + deltaSeconds
    );
    const progress = this.weatherTransitionSeconds / WEATHER_TRANSITION_SECONDS;
    this.weatherCurrent = lerpWeather(this.weatherSource, this.weatherTarget, progress);
  }

  private applyDebugWeatherOverrides(weather: WeatherState): WeatherState {
    return {
      ...weather,
      cloudCoverage: THREE.MathUtils.clamp(weather.cloudCoverage + this.settings.cloudCoverageBias, 0, 1),
      cloudDensity: THREE.MathUtils.clamp(weather.cloudDensity + this.settings.cloudDensityBias, 0, 1),
      cloudDarkening: THREE.MathUtils.clamp(weather.cloudDarkening + this.settings.stormBias * 0.45, 0, 1),
      precipitation: THREE.MathUtils.clamp(weather.precipitation + this.settings.stormBias * 0.35, 0, 1),
      stormIntensity: THREE.MathUtils.clamp(weather.stormIntensity + this.settings.stormBias, 0, 1),
      visibilityKm: THREE.MathUtils.clamp(weather.visibilityKm - this.settings.stormBias * 12, 2, 45)
    };
  }

  private applyFloatingOrigin(): void {
    const position = this.input.camera.position;
    const distanceSq = position.x * position.x + position.z * position.z;

    if (distanceSq < FLOATING_ORIGIN_THRESHOLD_METERS * FLOATING_ORIGIN_THRESHOLD_METERS) {
      return;
    }

    this.originOffsetMeters.x += position.x;
    this.originOffsetMeters.z += position.z;
    position.x = 0;
    position.z = 0;
  }

  private publishMetrics(): void {
    const camera = this.input.camera.position;
    const yawPitch = this.input.getYawPitchDeg();

    this.onMetrics({
      backend: "webgpu",
      fps: this.stats.fps,
      frameMs: this.stats.frameMs,
      cpuMs: this.stats.cpuMs,
      gpuMs: null,
      oceanComputeMs: this.oceanComputeMs,
      worldTimeHours: this.worldTimeHours,
      camera: {
        x: camera.x + this.originOffsetMeters.x,
        y: camera.y,
        z: camera.z + this.originOffsetMeters.z,
        yawDeg: yawPitch.yawDeg,
        pitchDeg: yawPitch.pitchDeg
      },
      originOffsetMeters: { ...this.originOffsetMeters },
      status: this.status,
      error: this.error
    });
  }
}
