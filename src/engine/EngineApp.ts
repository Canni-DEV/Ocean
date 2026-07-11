import * as THREE from "three/webgpu";
import { AtmosphereSystem } from "../atmosphere/AtmosphereSystem";
import { BoatController, type BoatControlState } from "../boat/BoatController";
import { BoatPhysics } from "../boat/BoatPhysics";
import { BoatVisual } from "../boat/BoatVisual";
import { FishingController, type FishingControlState } from "../fishing/FishingController";
import { getBoomElevationDefaultRad, setBoomElevationLimitsDeg, boomElevationRadToDeg, getBoomElevationLimitsDeg } from "../fishing/boomElevationLimits";
import { FishingRopeSystem } from "../fishing/FishingRopeSystem";
import { OceanPhysicsSampler } from "../ocean/OceanPhysicsSampler";
import { OceanRenderer } from "../ocean/OceanRenderer";
import { BoatWaterInteraction } from "../ocean/BoatWaterInteraction";
import { FirstPersonController } from "../player/FirstPersonController";
import { OceanSimulation, OCEAN_QUALITY } from "../ocean/simulation/OceanSimulation";
import { cloneWeather, easeWeatherProgress, lerpWeather, WEATHER_PRESETS } from "../state/weather";
import { buildSeaState, lerpSeaState, type SeaStateParams } from "../state/seaState";
import { FrameStats } from "./FrameStats";
import { InputController } from "./InputController";
import { SceneDepthPass } from "./SceneDepthPass";
import type { DebugSettings, EngineMetrics, FishingDebugState, QualityTier, WeatherPresetName, WeatherState } from "./types";

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
  private readonly boatController = new BoatController();
  private readonly fishingController = new FishingController();
  private readonly boatPhysics = new BoatPhysics();
  private readonly boatVisual = new BoatVisual();
  private readonly fishingRopeSystem: FishingRopeSystem;
  private readonly firstPerson: FirstPersonController;
  private readonly sceneDepthPass = new SceneDepthPass();
  private readonly stats = new FrameStats();

  private renderer: THREE.WebGPURenderer | null = null;
  private simulation: OceanSimulation | null = null;
  private ocean: OceanRenderer | null = null;
  private boatInteraction: BoatWaterInteraction | null = null;
  private physics: OceanPhysicsSampler | null = null;
  private boatPhysicsSampler: OceanPhysicsSampler | null = null;
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
  private boatInteractionComputeMs: number | null = null;
  private cloudComputeMs: number | null = null;
  private depthPrepassMs: number | null = null;
  private simulationTimeSeconds = 0;
  private firstPersonActive = false;
  private fishingMetrics: FishingDebugState | null = null;
  private fishingRopeBound = false;
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
    this.firstPerson = new FirstPersonController(this.input.camera, this.canvas);
    this.fishingRopeSystem = new FishingRopeSystem({
      enabled: options.initialSettings.fishingRopeEnabled,
      minLengthM: options.initialSettings.fishingRopeMinLengthM,
      maxLengthM: options.initialSettings.fishingRopeMaxLengthM,
      initialLengthM: options.initialSettings.fishingRopeInitialLengthM,
      reelSpeedMs: options.initialSettings.fishingReelSpeedMs,
      ropeRadius: options.initialSettings.fishingRopeRadius,
      renderMode: options.initialSettings.fishingRopeRenderMode,
      segmentCount: 28
    });
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
    this.boatVisual.setLightsOn(settings.boatLightsOn);
    this.fishingRopeSystem.applySettings({
      enabled: settings.fishingRopeEnabled,
      minLengthM: settings.fishingRopeMinLengthM,
      maxLengthM: settings.fishingRopeMaxLengthM,
      initialLengthM: settings.fishingRopeInitialLengthM,
      reelSpeedMs: settings.fishingReelSpeedMs,
      ropeRadius: settings.fishingRopeRadius,
      renderMode: settings.fishingRopeRenderMode
    });
    setBoomElevationLimitsDeg({
      minDeg: settings.fishingBoomMinDeg,
      maxDeg: settings.fishingBoomMaxDeg,
      defaultDeg: settings.fishingBoomDefaultDeg
    });
    this.fishingController.applyBoomLimits();
    this.syncFirstPersonMode(settings.firstPerson);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.input.dispose();
    this.firstPerson.dispose();
    this.boatController.dispose();
    this.fishingController.dispose();
    this.fishingRopeSystem.dispose();
    this.boatVisual.dispose();
    this.ocean?.dispose();
    this.boatInteraction?.dispose();
    this.simulation?.dispose();
    this.atmosphere?.dispose();
    this.sceneDepthPass.dispose();
    this.renderer?.dispose();
  }

  resetBoat(): void {
    const waterHeight = this.boatPhysicsSampler?.getHeightAt(0, 0) ?? this.physics?.getHeightAt(0, 0) ?? null;
    this.boatPhysics.resetToWorldOrigin(this.originOffsetMeters, waterHeight);
    this.boatInteraction?.resetHistory();
    this.boatVisual.syncFromPhysics(this.boatPhysics);
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
      this.boatVisual.setLightsOn(this.settings.boatLightsOn);
      this.scene.add(this.boatVisual.group);
      this.scene.add(this.fishingRopeSystem.group);
      this.resetBoat();
      this.syncFirstPersonMode(this.settings.firstPerson);

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
    const boatInteraction = new BoatWaterInteraction(tier);
    const ocean = new OceanRenderer({
      scene: this.scene,
      simulation,
      boatInteraction,
      cloudShadows: this.atmosphere?.cloudShadows ?? null
    });
    ocean.applySettings(this.settings);
    this.simulation = simulation;
    this.boatInteraction = boatInteraction;
    this.ocean = ocean;
    this.physics = new OceanPhysicsSampler(simulation, boatInteraction);
    this.boatPhysicsSampler = new OceanPhysicsSampler(simulation, boatInteraction);
    this.seaStateCurrent = null;

    const quality = OCEAN_QUALITY[tier];
    this.atmosphere?.setEnvironmentQuality(quality.envMapSize, quality.envMapIntervalMs);
    this.atmosphere?.setCloudQuality(tier);
  }

  private rebuildOcean(tier: QualityTier): void {
    this.ocean?.dispose();
    this.boatInteraction?.dispose();
    this.simulation?.dispose();
    this.ocean = null;
    this.boatInteraction = null;
    this.simulation = null;
    this.physics = null;
    this.boatPhysicsSampler = null;
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
    this.sceneDepthPass.setSize(width * pixelRatio, height * pixelRatio);
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
    let boatControl: BoatControlState | null = null;
    let fishingControl: FishingControlState = {
      reel: 0,
      boom: 0,
      boomElevationRad: getBoomElevationDefaultRad()
    };

    if (!this.settings.paused) {
      if (this.firstPersonActive) {
        const collider = this.boatVisual.getColliderBVH();
        if (collider) {
          this.firstPerson.update(deltaSeconds, this.boatVisual.group, collider);
        }
      } else {
        this.input.update(deltaSeconds);
      }

      boatControl = this.boatController.update(deltaSeconds);
      fishingControl = this.fishingController.update(deltaSeconds);
      this.boatVisual.setControlState(boatControl);
      this.boatVisual.setFishingState(fishingControl);
      this.worldTimeHours = (this.worldTimeHours + (deltaSeconds * this.settings.timeScale) / 3600) % 24;
      this.updateWeather(deltaSeconds);
      this.applyFloatingOrigin();
      this.simulationTimeSeconds += deltaSeconds;
    }

    if (this.settings.firstPerson && !this.firstPersonActive && this.boatVisual.isColliderReady()) {
      this.syncFirstPersonMode(true);
    }

    const tunedWeather = this.applyDebugWeatherOverrides(this.weatherCurrent);
    if (!this.settings.paused && boatControl) {
      this.updateBoat(boatControl, tunedWeather, deltaSeconds);
      this.updateFishingRope(fishingControl.reel, fishingControl.boomElevationRad, deltaSeconds);
    }

    if (this.firstPersonActive) {
      const collider = this.boatVisual.getColliderBVH();
      if (collider) {
        this.firstPerson.update(0, this.boatVisual.group, collider);
      }
    }

    const environment = this.atmosphere.update({
      renderer: this.renderer,
      camera: this.input.camera,
      deltaSeconds,
      weather: tunedWeather,
      worldTimeHours: this.worldTimeHours,
      originOffsetMeters: this.originOffsetMeters,
      timeSeconds: this.simulationTimeSeconds
    });

    this.renderer.toneMappingExposure = BASE_TONE_MAPPING_EXPOSURE * environment.exposure;

    // Smoothly track the target sea state and run the spectral simulation
    this.updateSeaState(tunedWeather, deltaSeconds);
    if (!this.settings.paused) {
      this.simulation.update(this.renderer, this.simulationTimeSeconds, deltaSeconds);
      this.boatInteraction?.update({
        renderer: this.renderer,
        boat: this.boatPhysics.getWaterInteractionState(this.originOffsetMeters),
        settings: this.settings,
        deltaSeconds
      });
    }
    this.oceanComputeMs = this.simulation.computeMs;
    this.boatInteractionComputeMs = this.boatInteraction?.computeMs ?? null;

    this.ocean.update(
      this.input.camera,
      tunedWeather,
      environment,
      this.settings,
      this.originOffsetMeters,
      this.simulationTimeSeconds
    );

    const depthStart = performance.now();
    this.sceneDepthPass.capture(this.renderer, this.scene, this.input.camera);
    this.depthPrepassMs = performance.now() - depthStart;

    this.atmosphere.renderClouds(this.renderer, this.input.camera, this.originOffsetMeters, {
      texture: this.sceneDepthPass.texture,
      width: this.canvas.width,
      height: this.canvas.height
    });
    this.cloudComputeMs = this.atmosphere.cloudComputeMs;

    this.physics?.update(
      this.renderer,
      this.input.camera.position.x + this.originOffsetMeters.x,
      this.input.camera.position.z + this.originOffsetMeters.z
    );
    this.boatPhysicsSampler?.update(
      this.renderer,
      this.boatPhysics.position.x + this.originOffsetMeters.x,
      this.boatPhysics.position.z + this.originOffsetMeters.z
    );
    if (this.settings.paused) {
      this.boatVisual.syncFromPhysics(this.boatPhysics);
    }

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

  private updateBoat(control: BoatControlState, weather: WeatherState, deltaSeconds: number): void {
    this.boatPhysics.update({
      deltaSeconds,
      control,
      sampler: this.boatPhysicsSampler,
      weather,
      originOffsetMeters: this.originOffsetMeters
    });
    this.boatVisual.syncFromPhysics(this.boatPhysics);
  }

  private updateFishingRope(reel: number, boomElevationRad: number, deltaSeconds: number): void {
    const limits = getBoomElevationLimitsDeg();
    const boomMetrics: FishingDebugState = {
      paidOutLengthM: 0,
      ropeTension: 0,
      boomElevationDeg: boomElevationRadToDeg(boomElevationRad),
      boomMinDeg: limits.minDeg,
      boomMaxDeg: limits.maxDeg
    };

    if (!this.settings.fishingRopeEnabled) {
      this.fishingMetrics = this.boatVisual.isModelReady() ? boomMetrics : null;
      this.fishingRopeSystem.group.visible = false;
      return;
    }

    if (!this.fishingRopeBound && this.boatVisual.isModelReady()) {
      const rig = this.boatVisual.getFishingRig();
      if (rig) {
        this.fishingRopeSystem.bind(rig, this.boatVisual.group);
        this.fishingRopeBound = this.fishingRopeSystem.isBound();
      }
    }

    this.fishingRopeSystem.group.visible = this.fishingRopeBound;
    if (!this.fishingRopeBound) {
      this.fishingMetrics = this.boatVisual.isModelReady() ? boomMetrics : null;
      return;
    }

    const ropeMetrics = this.fishingRopeSystem.update(deltaSeconds, {
      reel,
      boatGroup: this.boatVisual.group,
      originOffset: this.originOffsetMeters,
      sampler: this.boatPhysicsSampler,
      collider: this.boatVisual.getColliderBVH()
    });
    this.fishingMetrics = { ...ropeMetrics, ...boomMetrics };
  }

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

    const shiftX = position.x;
    const shiftZ = position.z;
    this.originOffsetMeters.x += shiftX;
    this.originOffsetMeters.z += shiftZ;
    position.x = 0;
    position.z = 0;
    this.boatPhysics.applyOriginShift(shiftX, shiftZ);
    this.fishingRopeSystem.applyOriginShift(shiftX, shiftZ);
    this.boatVisual.syncFromPhysics(this.boatPhysics);
  }

  private syncFirstPersonMode(requested: boolean): void {
    if (requested && !this.boatVisual.isColliderReady()) {
      this.firstPersonActive = false;
      this.firstPerson.setEnabled(false);
      this.input.setEnabled(true);
      return;
    }

    if (requested === this.firstPersonActive) return;

    this.firstPersonActive = requested;
    this.firstPerson.setEnabled(requested);
    this.input.setEnabled(!requested);

    if (requested) {
      const collider = this.boatVisual.getColliderBVH();
      if (collider) {
        this.firstPerson.spawnOnDeck(collider, this.boatVisual.getDefaultSpawnLocalPosition());
      }
      return;
    }

    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }

    const boatPosition = this.boatPhysics.position;
    const yawPitch = this.firstPerson.getMetrics();
    this.input.setViewOrientation(
      THREE.MathUtils.degToRad(yawPitch.yawDeg),
      THREE.MathUtils.degToRad(yawPitch.pitchDeg)
    );
    this.input.camera.position.set(
      boatPosition.x,
      boatPosition.y + 12,
      boatPosition.z + 18
    );
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
      boatInteractionComputeMs: this.boatInteractionComputeMs,
      cloudComputeMs: this.cloudComputeMs,
      depthPrepassMs: this.depthPrepassMs,
      seaLevelAtCameraM: seaLevel ?? null,
      worldTimeHours: this.worldTimeHours,
      camera: {
        x: camera.x + this.originOffsetMeters.x,
        y: camera.y,
        z: camera.z + this.originOffsetMeters.z,
        yawDeg: yawPitch.yawDeg,
        pitchDeg: yawPitch.pitchDeg
      },
      boat: this.boatPhysics.getMetrics(this.originOffsetMeters),
      firstPerson: this.firstPersonActive ? this.firstPerson.getMetrics() : null,
      fishing: this.fishingMetrics,
      originOffsetMeters: { ...this.originOffsetMeters },
      status: this.status,
      error: this.error
    });
  }
}
