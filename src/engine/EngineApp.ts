import * as THREE from "three/webgpu";
import { AtmosphereSystem } from "../atmosphere/AtmosphereSystem";
import { OceanPhysicsSampler } from "../ocean/OceanPhysicsSampler";
import { OceanRenderer } from "../ocean/OceanRenderer";
import { OceanSimulation, OCEAN_QUALITY } from "../ocean/simulation/OceanSimulation";
import { cloneWeather, easeWeatherProgress, lerpWeather, WEATHER_PRESETS } from "../state/weather";
import { buildSeaState, lerpSeaState, type SeaStateParams } from "../state/seaState";
import { FrameStats } from "./FrameStats";
import { InputController } from "./InputController";
import type { DebugSettings, EngineMetrics, QualityTier, WeatherPresetName, WeatherState } from "./types";

type EngineAppOptions = {
  canvas: HTMLCanvasElement;
  initialSettings: DebugSettings;
  onMetrics: (metrics: EngineMetrics) => void;
};

const FLOATING_ORIGIN_THRESHOLD_METERS = 5000;
const BASE_TONE_MAPPING_EXPOSURE = 0.38;

export class EngineApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly onMetrics: (metrics: EngineMetrics) => void;
  private readonly scene = new THREE.Scene();
  private readonly input: InputController;
  private readonly stats = new FrameStats();

  private renderer: THREE.WebGPURenderer | null = null;
  private simulation: OceanSimulation | null = null;
  private ocean: OceanRenderer | null = null;
  private physics: OceanPhysicsSampler | null = null;
  private atmosphere: AtmosphereSystem | null = null;
  private animationFrame = 0;
  private lastFrameMs = performance.now();
  private lastMetricsMs = 0;
  private disposed = false;
  private settings: DebugSettings;
  private activeQuality: QualityTier;
  private worldTimeHours: number;
  private weatherPreset: WeatherPresetName;
  private weatherSource: WeatherState;
  private weatherTarget: WeatherState;
  private weatherCurrent: WeatherState;
  private weatherTransitionSeconds = Number.POSITIVE_INFINITY;
  private seaStateCurrent: SeaStateParams | null = null;
  private originOffsetMeters = { x: 0, z: 0 };
  private oceanComputeMs: number | null = null;
  private cloudComputeMs: number | null = null;
  private simulationTimeSeconds = 0;
  private status: EngineMetrics["status"] = "booting";
  private error: string | null = null;

  constructor(options: EngineAppOptions) {
    this.canvas = options.canvas;
    this.onMetrics = options.onMetrics;
    this.settings = { ...options.initialSettings };
    this.activeQuality = options.initialSettings.quality;
    this.worldTimeHours = options.initialSettings.worldTimeHours;
    this.weatherPreset = options.initialSettings.weatherPreset;
    this.weatherSource = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
    this.weatherTarget = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
    this.weatherCurrent = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
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

    if (settings.quality !== this.activeQuality && this.renderer) {
      this.rebuildOcean(settings.quality);
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
    this.simulation?.dispose();
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
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = BASE_TONE_MAPPING_EXPOSURE;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      // Required so the sun light's custom cloud-shadow node is evaluated
      this.renderer.shadowMap.enabled = true;
      await this.renderer.init();

      this.atmosphere = new AtmosphereSystem(this.scene);
      this.createOcean(this.settings.quality);
      this.atmosphere.applySettings(this.settings);
      this.ocean?.applySettings(this.settings);

      window.addEventListener("resize", this.resize);
      this.resize();
      this.status = "running";
      (window as any).__engine = this;
      this.loop();
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.publishMetrics();
    }
  }

  private createOcean(tier: QualityTier): void {
    this.activeQuality = tier;
    const simulation = new OceanSimulation(tier);
    const ocean = new OceanRenderer({
      scene: this.scene,
      simulation,
      cloudShadows: this.atmosphere?.cloudShadows ?? null
    });
    ocean.applySettings(this.settings);
    this.simulation = simulation;
    this.ocean = ocean;
    this.physics = new OceanPhysicsSampler(simulation);
    this.seaStateCurrent = null;

    const quality = OCEAN_QUALITY[tier];
    this.atmosphere?.setEnvironmentQuality(quality.envMapSize, quality.envMapIntervalMs);
    this.atmosphere?.setCloudQuality(tier);
  }

  private rebuildOcean(tier: QualityTier): void {
    this.ocean?.dispose();
    this.simulation?.dispose();
    this.ocean = null;
    this.simulation = null;
    this.physics = null;
    this.createOcean(tier);
  }

  private readonly resize = (): void => {
    if (!this.renderer) return;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.input.resize(width, height);
    const pixelRatio = this.renderer.getPixelRatio();
    this.atmosphere?.resize(width * pixelRatio, height * pixelRatio);
  };

  private loop = (): void => {
    if (this.disposed || !this.renderer || !this.ocean || !this.simulation || !this.atmosphere) {
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
      this.simulationTimeSeconds += deltaSeconds;
    }

    const tunedWeather = this.applyDebugWeatherOverrides(this.weatherCurrent);
    const environment = this.atmosphere.update({
      renderer: this.renderer,
      camera: this.input.camera,
      deltaSeconds,
      weather: tunedWeather,
      worldTimeHours: this.worldTimeHours,
      originOffsetMeters: this.originOffsetMeters,
      timeSeconds: this.simulationTimeSeconds
    });
    this.cloudComputeMs = this.atmosphere.cloudComputeMs;

    this.renderer.toneMappingExposure = BASE_TONE_MAPPING_EXPOSURE * environment.exposure;

    // Smoothly track the target sea state and run the spectral simulation
    this.updateSeaState(tunedWeather, deltaSeconds);
    if (!this.settings.paused) {
      this.simulation.update(this.renderer, this.simulationTimeSeconds, deltaSeconds);
    }
    this.oceanComputeMs = this.simulation.computeMs;

    this.ocean.update(
      this.input.camera,
      tunedWeather,
      environment,
      this.settings,
      this.originOffsetMeters,
      this.simulationTimeSeconds
    );

    this.physics?.update(
      this.renderer,
      this.input.camera.position.x + this.originOffsetMeters.x,
      this.input.camera.position.z + this.originOffsetMeters.z
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

  private updateSeaState(weather: WeatherState, deltaSeconds: number): void {
    if (!this.simulation) return;

    const target = buildSeaState(weather, this.settings);
    if (this.seaStateCurrent === null) {
      this.seaStateCurrent = target;
    } else {
      // Exponential smoothing (~2 s time constant) for gentle spectrum shifts
      const blend = 1 - Math.exp(-deltaSeconds / 2);
      this.seaStateCurrent = lerpSeaState(this.seaStateCurrent, target, blend);
    }

    this.simulation.setSeaState(this.seaStateCurrent);
  }

  private updateWeather(deltaSeconds: number): void {
    const duration = Math.max(1, this.settings.weatherTransitionSeconds);
    this.weatherTransitionSeconds = Math.min(duration, this.weatherTransitionSeconds + deltaSeconds);
    const progress = easeWeatherProgress(this.weatherTransitionSeconds / duration);
    this.weatherCurrent = lerpWeather(this.weatherSource, this.weatherTarget, progress);
  }

  private applyDebugWeatherOverrides(weather: WeatherState): WeatherState {
    return {
      ...weather,
      cloudCoverage: THREE.MathUtils.clamp(weather.cloudCoverage + this.settings.cloudCoverageBias, 0, 1),
      cloudDensity: THREE.MathUtils.clamp(weather.cloudDensity + this.settings.cloudDensityBias, 0, 1),
      swellDirectionRad: (this.settings.swellDirectionDeg * Math.PI) / 180
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
    const seaLevel = this.physics?.getHeightAt(
      camera.x + this.originOffsetMeters.x,
      camera.z + this.originOffsetMeters.z
    );

    this.onMetrics({
      backend: "webgpu",
      fps: this.stats.fps,
      frameMs: this.stats.frameMs,
      cpuMs: this.stats.cpuMs,
      gpuMs: null,
      oceanComputeMs: this.oceanComputeMs,
      cloudComputeMs: this.cloudComputeMs,
      seaLevelAtCameraM: seaLevel ?? null,
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
