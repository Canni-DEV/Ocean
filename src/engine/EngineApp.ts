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
import { OceanSceneCapturePass } from "../ocean/OceanSceneCapturePass";
import { OceanSurfaceDataPass } from "../ocean/OceanSurfaceDataPass";
import { OceanScreenSpaceReflectionPass } from "../ocean/OceanScreenSpaceReflectionPass";
import { BoatWaterInteraction } from "../ocean/BoatWaterInteraction";
import {
  applyOceanValidationCamera,
  applyOceanValidationLights,
  applyOceanValidationSettings,
  readOceanValidationScenario,
  validationFlashlightEnabled,
  type OceanValidationScenario
} from "../ocean/OceanValidationHarness";
import { CameraFovZoom } from "../player/CameraFovZoom";
import { FirstPersonController } from "../player/FirstPersonController";
import { PlayerFlashlight, type FlashlightConfig } from "../player/PlayerFlashlight";
import { OceanSimulation, OCEAN_QUALITY } from "../ocean/simulation/OceanSimulation";
import { cloneWeather, easeWeatherProgress, lerpWeather, WEATHER_PRESETS } from "../state/weather";
import { buildSeaState, lerpSeaState, type SeaStateParams } from "../state/seaState";
import { FrameStats } from "./FrameStats";
import { InputController } from "./InputController";
import { SceneDepthPass } from "./SceneDepthPass";
import type { DebugSettings, EngineMetrics, FishingDebugState, QualityTier, WeatherPresetName, WeatherState } from "./types";
import { GameplayInputRouter } from "../gameplay/GameplayInputRouter";
import { InteractionSystem, type InteractionFrame } from "../gameplay/InteractionSystem";
import { StationInteractionSystem, type StationCandidate } from "../gameplay/StationInteractionSystem";
import type { GameplayMode, GameplayUiState, InputActionSnapshot } from "../gameplay/types";
import { BoatSystems } from "../boat/BoatSystems";
import { CabinAudio } from "../audio/CabinAudio";

type EngineAppOptions = {
  canvas: HTMLCanvasElement;
  initialSettings: DebugSettings;
  onMetrics: (metrics: EngineMetrics) => void;
  onGameplayUi?: (state: GameplayUiState) => void;
};

const FLOATING_ORIGIN_THRESHOLD_METERS = 5000;
const BASE_TONE_MAPPING_EXPOSURE = 0.38;

export class EngineApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly onMetrics: (metrics: EngineMetrics) => void;
  private readonly onGameplayUi: (state: GameplayUiState) => void;
  private readonly scene = new THREE.Scene();
  private readonly input: InputController;
  private readonly gameplayInput: GameplayInputRouter;
  private readonly boatController = new BoatController();
  private readonly fishingController = new FishingController();
  private readonly boatPhysics = new BoatPhysics();
  private readonly boatVisual = new BoatVisual();
  private readonly fishingRopeSystem: FishingRopeSystem;
  private readonly firstPerson: FirstPersonController;
  private readonly cameraFovZoom = new CameraFovZoom();
  private readonly sceneDepthPass = new SceneDepthPass();
  private readonly stats = new FrameStats();
  private readonly systems = new BoatSystems();
  private readonly interaction = new InteractionSystem();
  private readonly stationInteraction = new StationInteractionSystem();
  private readonly audio = new CabinAudio();
  private readonly flashlight: PlayerFlashlight;
  private readonly stationPosition = new THREE.Vector3();
  private readonly chargerPosition = new THREE.Vector3();

  private renderer: THREE.WebGPURenderer | null = null;
  private simulation: OceanSimulation | null = null;
  private ocean: OceanRenderer | null = null;
  private oceanSceneCapture: OceanSceneCapturePass | null = null;
  private oceanSurfaceData: OceanSurfaceDataPass | null = null;
  private oceanSsr: OceanScreenSpaceReflectionPass | null = null;
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
  private gpuComputeMs: number | null = null;
  private gpuRenderMs: number | null = null;
  private gpuResolveInFlight = false;
  private gpuResolvePromise: Promise<void> | null = null;
  private lastGpuResolveMs = 0;
  private readonly validationFrameSamples: number[] = [];
  private readonly validationComputeSamples: number[] = [];
  private readonly validationRenderSamples: number[] = [];
  private simulationTimeSeconds = 0;
  private firstPersonActive = false;
  private gameplayMode: GameplayMode = "walking";
  private hasSpawnedPlayer = false;
  private readonly inspectCabinOnStart = import.meta.env.DEV && new URLSearchParams(window.location.search).has("inspectCabin");
  private lastGameplayUiKey = "";
  private fishingMetrics: FishingDebugState | null = null;
  private fishingRopeBound = false;
  private flashlightIndicatorRemainingS = 0;
  private flashlightStatusMessage: string | null = null;
  private status: EngineMetrics["status"] = "booting";
  private error: string | null = null;
  private readonly validationScenario: OceanValidationScenario | null;
  private validationElapsedSeconds = 0;
  private oceanSceneCaptureMs: number | null = null;
  private oceanSurfaceDataMs: number | null = null;
  private oceanSsrMs: number | null = null;

  constructor(options: EngineAppOptions) {
    this.canvas = options.canvas;
    this.onMetrics = options.onMetrics;
    this.onGameplayUi = options.onGameplayUi ?? (() => {});
    this.validationScenario = readOceanValidationScenario(window.location.search);
    this.settings = this.validationScenario
      ? applyOceanValidationSettings(options.initialSettings, this.validationScenario)
      : { ...options.initialSettings };
    this.activeQuality = this.settings.quality;
    this.worldTimeHours = this.settings.worldTimeHours;
    this.weatherPreset = this.settings.weatherPreset;
    this.weatherSource = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
    this.weatherTarget = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
    this.weatherCurrent = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
    this.input = new InputController(this.canvas);
    this.gameplayInput = new GameplayInputRouter(this.canvas);
    this.firstPerson = new FirstPersonController(this.input.camera, this.canvas);
    this.flashlight = new PlayerFlashlight(this.scene, flashlightConfigFromSettings(this.settings), this.activeQuality);
    this.boatVisual.setQuality(this.activeQuality);
    this.fishingRopeSystem = new FishingRopeSystem({
      enabled: this.settings.fishingRopeEnabled,
      minLengthM: this.settings.fishingRopeMinLengthM,
      maxLengthM: this.settings.fishingRopeMaxLengthM,
      initialLengthM: this.settings.fishingRopeInitialLengthM,
      reelSpeedMs: this.settings.fishingReelSpeedMs,
      ropeRadius: this.settings.fishingRopeRadius,
      renderMode: this.settings.fishingRopeRenderMode,
      segmentCount: 28
    });
  }

  start(): void {
    void this.init();
  }

  applySettings(settings: DebugSettings): void {
    const previousPreset = this.settings.weatherPreset;
    const previousConfiguredTime = this.settings.worldTimeHours;
    const previousDebugLight = this.settings.boatLightsOn;
    const previousFirstPerson = this.settings.firstPerson;
    const previousPaused = this.settings.paused;
    const previousSsr = this.settings.oceanSsrEnabled;
    const previousTemporal = this.settings.oceanSsrTemporalEnabled;
    this.settings = { ...settings };

    if (Math.abs(settings.worldTimeHours - previousConfiguredTime) > 0.001) {
      this.worldTimeHours = settings.worldTimeHours;
    }

    if (settings.weatherPreset !== previousPreset) {
      this.weatherPreset = settings.weatherPreset;
      this.weatherSource = cloneWeather(this.weatherCurrent);
      this.weatherTarget = cloneWeather(WEATHER_PRESETS[this.weatherPreset]);
      this.weatherTransitionSeconds = 0;
      this.oceanSsr?.resetHistory();
    }
    if (Math.abs(settings.worldTimeHours - previousConfiguredTime) > 0.001
      || settings.firstPerson !== previousFirstPerson) this.oceanSsr?.resetHistory();

    if (settings.quality !== this.activeQuality && this.renderer) {
      this.rebuildOcean(settings.quality);
    }
    this.flashlight.applyConfig(flashlightConfigFromSettings(settings));
    this.flashlight.setQuality(settings.quality);
    this.boatVisual.setQuality(settings.quality);
    if (settings.boatLightsOn !== previousDebugLight) this.systems.state.workLight = settings.boatLightsOn;

    this.ocean?.applySettings(settings);
    this.oceanSsr?.setEnabled(settings.oceanSsrEnabled, settings.oceanSsrTemporalEnabled);
    if (previousPaused !== settings.paused || previousSsr !== settings.oceanSsrEnabled
      || previousTemporal !== settings.oceanSsrTemporalEnabled) {
      this.oceanSsr?.resetHistory();
    }
    this.atmosphere?.applySettings(settings);
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
    if (settings.firstPerson !== previousFirstPerson) this.setDebugFreeCamera(!settings.firstPerson);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.input.dispose();
    this.gameplayInput.dispose();
    this.firstPerson.dispose();
    this.boatController.dispose();
    this.fishingController.dispose();
    this.fishingRopeSystem.dispose();
    this.boatVisual.dispose();
    this.ocean?.dispose();
    this.oceanSceneCapture?.dispose();
    this.oceanSurfaceData?.dispose();
    this.oceanSsr?.dispose();
    this.boatInteraction?.dispose();
    this.simulation?.dispose();
    this.atmosphere?.dispose();
    this.sceneDepthPass.dispose();
    this.audio.dispose();
    this.flashlight.dispose();
    const renderer = this.renderer;
    this.renderer = null;
    if (renderer) {
      if (this.gpuResolvePromise) {
        void this.gpuResolvePromise.finally(() => renderer.dispose());
      } else {
        renderer.dispose();
      }
    }
  }

  resetBoat(): void {
    const waterHeight = this.boatPhysicsSampler?.getHeightAt(0, 0) ?? this.physics?.getHeightAt(0, 0) ?? null;
    this.boatPhysics.resetToWorldOrigin(this.originOffsetMeters, waterHeight);
    this.boatInteraction?.resetHistory();
    this.boatVisual.syncFromPhysics(this.boatPhysics);
  }

  refuelBoat(): void {
    this.systems.refuel();
  }

  rechargeFlashlight(): void {
    this.flashlight.refill();
    this.flashlightIndicatorRemainingS = 2;
  }

  private async init(): Promise<void> {
    try {
      if (!("gpu" in navigator) || !navigator.gpu) {
        throw new Error("WebGPU is required for this prototype. Use a current Chrome or Edge desktop build with WebGPU enabled.");
      }

      this.renderer = new THREE.WebGPURenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: false,
        trackTimestamp: true,
        // The FFT ocean already occupies the portable WebGPU minimum of 16
        // sampled textures. PR6C adds scene color/depth/SSR; target desktop
        // adapters expose at least 32 and are validated before device creation.
        requiredLimits: {
          maxSampledTexturesPerShaderStage: 32,
          maxSamplersPerShaderStage: 16
        }
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
      // Boat work spots + player flashlight are already in the scene graph at intensity 0
      // so the first WebGPU light pipelines compile here, not on the first switch / F press.
      this.systems.state.workLight = this.settings.boatLightsOn;
      if (this.validationScenario) {
        applyOceanValidationLights(this.systems.state, this.validationScenario);
        if (validationFlashlightEnabled(this.validationScenario)) this.flashlight.toggle();
      }
      this.boatVisual.setLightsOn(this.settings.boatLightsOn);
      this.scene.add(this.boatVisual.group);
      if (this.validationScenario) {
        applyOceanValidationCamera(this.input.camera, this.validationScenario);
        this.simulationTimeSeconds = this.validationScenario.simulationTimeSeconds;
      }
      this.scene.add(this.fishingRopeSystem.group);
      this.resetBoat();
      this.setDebugFreeCamera(!this.settings.firstPerson);

      window.addEventListener("resize", this.resize);
      this.resize();
      // Seal sun+moon sticky membership (+ boat/flashlight) before the first gameplay frame.
      this.atmosphere.warmUpCelestialLights();
      const warmWeather = this.applyDebugWeatherOverrides(this.weatherCurrent);
      const warmEnvironment = this.atmosphere.update({
        renderer: this.renderer,
        camera: this.input.camera,
        deltaSeconds: 0,
        weather: warmWeather,
        worldTimeHours: this.worldTimeHours,
        originOffsetMeters: this.originOffsetMeters,
        timeSeconds: this.simulationTimeSeconds
      });
      this.renderer.toneMappingExposure = BASE_TONE_MAPPING_EXPOSURE * warmEnvironment.exposure;
      this.renderer.render(this.scene, this.input.camera);
      this.status = "running";
      (window as any).__engine = this;
      this.loop();
    } catch (error) {
      console.error("Engine initialization failed", error);
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.publishMetrics();
    }
  }

  private createOcean(tier: QualityTier): void {
    this.activeQuality = tier;
    const simulation = new OceanSimulation(tier);
    const boatInteraction = new BoatWaterInteraction(tier);
    const screenQuality = simulation.quality.screenSpace;
    const sceneCapture = new OceanSceneCapturePass(screenQuality.captureScale);
    const ocean = new OceanRenderer({
      scene: this.scene,
      simulation,
      boatInteraction
    });
    const surfaceData = screenQuality.ssrEnabled
      ? new OceanSurfaceDataPass(screenQuality.captureScale)
      : null;
    const captureTextures = sceneCapture.textures;
    const ssr = surfaceData
      ? new OceanScreenSpaceReflectionPass(
        screenQuality,
        captureTextures.sceneColor,
        captureTextures.sceneNormalRoughness,
        captureTextures.sceneVelocity,
        surfaceData.normalRoughnessTexture,
        surfaceData.normalRoughnessTexture
      )
      : null;
    ssr?.setEnabled(this.settings.oceanSsrEnabled, this.settings.oceanSsrTemporalEnabled);
    ocean.setScreenSpaceInputs({
      ...captureTextures,
      ssrColor: ssr?.texture ?? null,
      ssrConfidence: ssr?.confidenceTexture ?? null,
      oceanSurfaceDepth: surfaceData?.depthTexture ?? null,
      oceanSurfaceNormalRoughness: surfaceData?.normalRoughnessTexture ?? null
    });
    ocean.applySettings(this.settings);
    this.simulation = simulation;
    this.boatInteraction = boatInteraction;
    this.ocean = ocean;
    this.oceanSceneCapture = sceneCapture;
    this.oceanSurfaceData = surfaceData;
    this.oceanSsr = ssr;
    this.physics = new OceanPhysicsSampler(simulation, boatInteraction);
    this.boatPhysicsSampler = new OceanPhysicsSampler(simulation, boatInteraction);
    this.seaStateCurrent = null;

    const quality = OCEAN_QUALITY[tier];
    this.atmosphere?.setEnvironmentQuality(quality.envMapSize, quality.envMapIntervalMs);
    this.atmosphere?.setCloudQuality(tier);
  }

  private rebuildOcean(tier: QualityTier): void {
    this.ocean?.dispose();
    this.oceanSceneCapture?.dispose();
    this.oceanSurfaceData?.dispose();
    this.oceanSsr?.dispose();
    this.boatInteraction?.dispose();
    this.simulation?.dispose();
    this.ocean = null;
    this.oceanSceneCapture = null;
    this.oceanSurfaceData = null;
    this.oceanSsr = null;
    this.boatInteraction = null;
    this.simulation = null;
    this.physics = null;
    this.boatPhysicsSampler = null;
    this.createOcean(tier);
    this.resize();
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
    this.oceanSceneCapture?.setSize(width * pixelRatio, height * pixelRatio);
    this.oceanSurfaceData?.setSize(width * pixelRatio, height * pixelRatio);
    this.oceanSsr?.setSize(width * pixelRatio, height * pixelRatio);
    this.oceanSsr?.resetHistory();
  };

  private loop = (): void => {
    if (this.disposed || !this.renderer || !this.ocean || !this.simulation || !this.atmosphere) {
      return;
    }

    const now = performance.now();
    const deltaMs = Math.min(100, now - this.lastFrameMs);
    const deltaSeconds = deltaMs / 1000;
    if (this.validationScenario) this.validationElapsedSeconds += deltaSeconds;
    this.lastFrameMs = now;
    const statStart = this.stats.begin();
    const frameInput = this.gameplayInput.consumeFrame();
    this.cameraFovZoom.update(
      this.input.camera,
      frameInput.secondaryDown && (frameInput.pointerLocked || this.gameplayMode === "debugFreeCamera"),
      deltaSeconds
    );
    let boatControl: BoatControlState | null = null;
    let fishingControl: FishingControlState = {
      reel: 0,
      boom: 0,
      boomElevationRad: getBoomElevationDefaultRad()
    };

    if (!this.hasSpawnedPlayer && this.boatVisual.isColliderReady() && this.settings.firstPerson) {
      const collider = this.boatVisual.getColliderBVH();
      if (collider) {
        this.firstPerson.spawnOnDeck(collider, this.boatVisual.getDefaultSpawnLocalPosition());
        this.hasSpawnedPlayer = true;
        this.firstPersonActive = true;
        this.firstPerson.setEnabled(true);
        this.input.setEnabled(false);
        if (this.inspectCabinOnStart) {
          this.firstPerson.enterStation();
          this.firstPerson.setViewOrientation(0, -0.58);
          this.setGameplayMode("helm");
        } else {
          this.setGameplayMode("walking");
        }
      }
    }

    const rig = this.boatVisual.getCockpitRig();
    if (!this.settings.paused) {
      if (this.gameplayMode === "debugFreeCamera") {
        this.input.update(deltaSeconds, frameInput);
      } else if (this.firstPersonActive) {
        const collider = this.boatVisual.getColliderBVH();
        if (collider) {
          const station = this.gameplayMode === "helm" || this.gameplayMode === "fishing"
            ? rig?.getStationPosition(this.gameplayMode, this.boatVisual.group, this.stationPosition) ?? null
            : null;
          this.firstPerson.update(
            deltaSeconds,
            this.boatVisual.group,
            collider,
            frameInput,
            this.gameplayMode === "walking",
            station
          );
        }
      }
    }

    const stationCandidate = this.stationInteraction.update(
      this.input.camera,
      rig,
      this.gameplayMode === "walking" && frameInput.pointerLocked
    );
    const engineBeforeInteraction = this.systems.state.engine;
    const interactionFrame = this.interaction.update(
      this.input.camera,
      rig,
      this.systems,
      frameInput,
      this.gameplayMode !== "debugFreeCamera",
      this.boatVisual.group,
      this.boatVisual.getColliderBVH()
    );
    if (interactionFrame.activatedControl) {
      rig?.triggerControlPress(interactionFrame.activatedControl);
      void this.audio.unlock().then(() => this.audio.playControlClick());
    }
    if (engineBeforeInteraction !== "off" && this.systems.state.engine === "off") {
      this.boatController.neutralize();
    }
    this.handleStationInput(frameInput, stationCandidate);
    if (!interactionFrame.activatedControl && (frameInput.primaryPressed || frameInput.flashlightPressed)) {
      void this.audio.unlock();
    }
    if (
      frameInput.flashlightPressed &&
      !this.settings.paused &&
      this.firstPersonActive &&
      this.gameplayMode !== "debugFreeCamera"
    ) {
      this.flashlight.toggle();
      this.flashlightIndicatorRemainingS = 2;
      this.flashlightStatusMessage = null;
    }

    if (!this.settings.paused) {
      boatControl = this.boatController.update(
        deltaSeconds,
        frameInput,
        this.gameplayMode === "helm",
        this.systems.state.engine === "running"
      );
      fishingControl = this.fishingController.update(
        deltaSeconds,
        frameInput,
        this.gameplayMode === "fishing"
      );
      this.boatVisual.setControlState(boatControl);
      this.boatVisual.setFishingState(fishingControl);
      this.worldTimeHours = (this.worldTimeHours + (deltaSeconds * this.settings.timeScale) / 3600) % 24;
      this.updateWeather(deltaSeconds);
      this.applyFloatingOrigin();
      this.simulationTimeSeconds = this.validationScenario
        ? this.validationScenario.simulationTimeSeconds
        : this.simulationTimeSeconds + deltaSeconds;
    }

    const tunedWeather = this.applyDebugWeatherOverrides(this.weatherCurrent);
    if (!this.settings.paused && boatControl && !this.validationScenario) {
      this.updateBoat(boatControl, tunedWeather, deltaSeconds);
      this.updateFishingRope(fishingControl.reel, fishingControl.boomElevationRad, deltaSeconds);
      const engineBeforeSystems = this.systems.state.engine;
      const metrics = this.boatPhysics.getMetrics(this.originOffsetMeters);
      this.systems.update(deltaSeconds, boatControl.throttle, metrics, tunedWeather.precipitation);
      if (engineBeforeSystems !== "off" && this.systems.state.engine === "off") this.boatController.neutralize();
    }
    this.boatVisual.setSystemsState(this.systems.state, tunedWeather.precipitation, deltaSeconds);
    this.flashlightIndicatorRemainingS = Math.max(0, this.flashlightIndicatorRemainingS - deltaSeconds);
    this.flashlight.update({
      deltaSeconds,
      camera: this.input.camera,
      active: validationFlashlightEnabled(this.validationScenario)
        || (this.firstPersonActive && this.gameplayMode !== "debugFreeCamera"),
      chargingAllowed: this.systems.state.engine === "running" && this.isNearHelmCharger(rig),
      paused: this.settings.paused
    });
    const flashlightCue = this.flashlight.consumeCue();
    if (flashlightCue) {
      this.audio.playFlashlightCue(flashlightCue);
      if (flashlightCue === "charged") {
        this.flashlightIndicatorRemainingS = 2;
        this.flashlightStatusMessage = "Carga de linterna completa";
      } else if (flashlightCue === "empty") {
        this.flashlightIndicatorRemainingS = 2;
        this.flashlightStatusMessage = "Linterna sin batería";
      }
    }
    this.audio.update(this.systems.state, this.input.camera, this.boatVisual.group);
    this.publishGameplayUi(frameInput, interactionFrame, stationCandidate);

    if (this.validationScenario) {
      applyOceanValidationCamera(this.input.camera, this.validationScenario, this.validationElapsedSeconds);
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
      this.simulationTimeSeconds,
      this.canvas.height
    );

    if (this.oceanSceneCapture) {
      this.oceanSceneCapture.capture(this.renderer, this.scene, this.input.camera);
      this.oceanSceneCaptureMs = this.oceanSceneCapture.captureMs;
    }
    if (this.oceanSurfaceData && this.oceanSsr) {
      this.oceanSurfaceData.render(this.renderer, this.ocean, this.input.camera);
      this.oceanSurfaceDataMs = this.oceanSurfaceData.renderMs;
      this.oceanSsr.render(this.renderer, this.input.camera);
      this.oceanSsrMs = this.oceanSsr.renderMs;
    } else {
      this.oceanSurfaceDataMs = 0;
      this.oceanSsrMs = 0;
    }
    const screenTextures = this.oceanSceneCapture?.textures;
    if (screenTextures) {
      this.ocean.setScreenSpaceInputs({
        ...screenTextures,
        ssrColor: this.oceanSsr?.texture ?? null,
        ssrConfidence: this.oceanSsr?.confidenceTexture ?? null,
        oceanSurfaceDepth: this.oceanSurfaceData?.depthTexture ?? null,
        oceanSurfaceNormalRoughness: this.oceanSurfaceData?.normalRoughnessTexture ?? null
      });
    }

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
      this.scheduleGpuTimestampResolve(now);
    } catch (error: unknown) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }

    this.stats.end(statStart, deltaMs);
    if (this.validationScenario) pushBounded(this.validationFrameSamples, deltaMs, 3600);

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
    } else if (this.seaStateCurrent.seed !== target.seed) {
      // A seed is a deliberate realization change, not a weather transition.
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
      cloudDensity: THREE.MathUtils.clamp(weather.cloudDensity + this.settings.cloudDensityBias, 0, 1)
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
    this.oceanSsr?.resetHistory();
  }

  private setDebugFreeCamera(enabled: boolean): void {
    if (enabled) {
      this.gameplayMode = "debugFreeCamera";
      this.gameplayInput.setMode("debugFreeCamera");
      this.firstPersonActive = false;
      this.firstPerson.setEnabled(false);
      this.input.setEnabled(true);
      const boatPosition = this.boatPhysics.position;
      this.input.camera.position.set(boatPosition.x, boatPosition.y + 12, boatPosition.z + 18);
      return;
    }

    this.input.setEnabled(false);
    this.firstPerson.setEnabled(true);
    this.firstPersonActive = true;
    this.setGameplayMode("walking");
  }

  private setGameplayMode(mode: GameplayMode): void {
    this.gameplayMode = mode;
    this.gameplayInput.setMode(mode);
    if (mode !== "helm") this.systems.setHorn(false);
  }

  private handleStationInput(input: InputActionSnapshot, stationCandidate: StationCandidate | null): void {
    if (!input.interactPressed || this.gameplayMode === "debugFreeCamera") return;
    if (this.gameplayMode === "helm" || this.gameplayMode === "fishing") {
      const collider = this.boatVisual.getColliderBVH();
      this.firstPerson.exitStation(collider ?? undefined);
      this.setGameplayMode("walking");
      return;
    }
    if (stationCandidate) {
      this.firstPerson.enterStation();
      this.setGameplayMode(stationCandidate.station);
    }
  }

  private publishGameplayUi(
    input: InputActionSnapshot,
    frame: InteractionFrame,
    stationCandidate: StationCandidate | null
  ): void {
    let prompt: string | null = null;
    let detail: string | null = null;
    let targetLabel: string | null = null;
    let status: string | null = null;

    const stationAction = this.gameplayMode === "helm"
      ? "[E] Salir del volante"
      : this.gameplayMode === "fishing"
        ? "[E] Salir del puesto"
        : stationCandidate?.station === "helm"
          ? "[E] Tomar volante"
          : stationCandidate?.station === "fishing"
            ? "[E] Operar brazo de pesca"
            : null;

    if (!input.pointerLocked && this.gameplayMode !== "debugFreeCamera") {
      status = "Click para tomar el control de la cámara";
    } else if (frame.controlHit) {
      targetLabel = frame.controlHit.target.label;
      prompt = frame.controlHit.target.clickLabel ? `[Click] ${frame.controlHit.target.clickLabel}` : null;
      detail = [frame.controlHit.target.wheelLabel, stationAction].filter(Boolean).join(" · ") || null;
    } else if (this.gameplayMode === "walking" && stationAction) {
      prompt = stationAction;
    } else if (this.gameplayMode === "helm") {
      prompt = stationAction;
      detail = "W/S acelerador · A/D timón";
    } else if (this.gameplayMode === "fishing") {
      prompt = stationAction;
      detail = "W/S brazo · A soltar · D recoger";
    }

    if (this.systems.state.engine === "starting") status = "Arrancando motor…";
    if (this.systems.state.fuel <= 0) status = "Sin combustible";
    if (this.systems.state.bilgeLevel >= 0.6) status = "Nivel de sentina elevado";

    const flashlight = this.flashlight.getState();
    if (!status) {
      if (flashlight.charging) status = `Cargando linterna · ${Math.round(flashlight.charge01 * 100)} %`;
      else if (flashlight.level === "critical") status = "Batería de linterna crítica";
      else if (flashlight.level === "low") status = "Batería de linterna baja";
      else if (this.flashlightIndicatorRemainingS > 0) status = this.flashlightStatusMessage;
    }

    const ui: GameplayUiState = {
      mode: this.gameplayMode,
      pointerLocked: input.pointerLocked,
      prompt,
      detail,
      targetLabel,
      reticleActive: frame.controlHit !== null,
      zoomActive: this.cameraFovZoom.isZoomActive(),
      status,
      flashlight,
      flashlightIndicatorVisible:
        this.flashlightIndicatorRemainingS > 0 || flashlight.charging || flashlight.level !== "normal"
    };
    const key = JSON.stringify(ui);
    if (key !== this.lastGameplayUiKey) {
      this.lastGameplayUiKey = key;
      this.onGameplayUi(ui);
    }
  }

  private publishMetrics(): void {
    const camera = this.input.camera.position;
    const yawPitch = this.firstPersonActive ? this.firstPerson.getMetrics() : this.input.getYawPitchDeg();
    const seaLevel = this.physics?.getHeightAt(
      camera.x + this.originOffsetMeters.x,
      camera.z + this.originOffsetMeters.z
    );

    const seaState = this.seaStateCurrent;
    const metrics: EngineMetrics = {
      backend: "webgpu",
      fps: this.stats.fps,
      frameMs: this.stats.frameMs,
      cpuMs: this.stats.cpuMs,
      gpuMs:
        this.gpuComputeMs === null && this.gpuRenderMs === null
          ? null
          : (this.gpuComputeMs ?? 0) + (this.gpuRenderMs ?? 0),
      gpuComputeMs: this.gpuComputeMs,
      gpuRenderMs: this.gpuRenderMs,
      oceanComputeMs: this.oceanComputeMs,
      slopeMomentComputeMs: this.simulation?.slopeMomentComputeMs ?? null,
      boatInteractionComputeMs: this.boatInteractionComputeMs,
      cloudComputeMs: this.cloudComputeMs,
      depthPrepassMs: this.depthPrepassMs,
      oceanSceneCaptureMs: this.oceanSceneCaptureMs,
      oceanSurfaceDataMs: this.oceanSurfaceDataMs,
      oceanSsrMs: this.oceanSsrMs,
      // Individual pass fields are CPU submission timings. Do not mislabel
      // their sum as GPU time; the aggregate render timestamp remains the
      // authoritative asynchronous GPU measurement until scoped public
      // timestamps are available in Three.js.
      oceanPr6cGpuMs: null,
      oceanSpectrum: this.simulation?.metrics.map((metric) => ({ ...metric })) ?? [],
      seaState: seaState ? {
        source: this.settings.seaStateControlMode,
        windSpeedMs: seaState.windSpeedMs,
        windDirectionDeg: radiansToDegrees360(seaState.windDirectionRad),
        swellDirectionDeg: radiansToDegrees360(seaState.swellDirectionRad),
        swellStrength: seaState.swellAmount,
        weatherTransitionProgress: THREE.MathUtils.clamp(this.weatherCurrent.transitionProgress, 0, 1),
        precipitation: THREE.MathUtils.clamp(this.weatherCurrent.precipitation, 0, 1)
      } : null,
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
      systems: structuredClone(this.systems.state),
      flashlight: this.flashlight.getState(),
      gameplayMode: this.gameplayMode,
      originOffsetMeters: { ...this.originOffsetMeters },
      status: this.status,
      error: this.error
    };
    this.onMetrics(metrics);
    if (this.validationScenario) {
      (window as any).__oceanValidation = {
        scenario: this.validationScenario,
        settings: { ...this.settings },
        spectrum: this.simulation?.metrics ?? [],
        metrics,
        samples: {
          frameMs: [...this.validationFrameSamples],
          gpuComputeMs: [...this.validationComputeSamples],
          gpuRenderMs: [...this.validationRenderSamples]
        },
        summary: {
          frameP95Ms: percentile(this.validationFrameSamples, 0.95),
          gpuComputeP95Ms: percentile(this.validationComputeSamples, 0.95),
          gpuRenderP95Ms: percentile(this.validationRenderSamples, 0.95)
        }
      };
    }
  }

  private scheduleGpuTimestampResolve(nowMs: number): void {
    // Each FFT stage is its own compute context; resolve often enough to stay
    // below Three.js' fixed timestamp-query pool without resolving per pass.
    if (!this.renderer || this.gpuResolveInFlight || nowMs - this.lastGpuResolveMs < 100) return;
    this.gpuResolveInFlight = true;
    this.lastGpuResolveMs = nowMs;
    const renderer = this.renderer as any;
    this.gpuResolvePromise = Promise.all([
      renderer.resolveTimestampsAsync("compute") as Promise<number | undefined>,
      renderer.resolveTimestampsAsync("render") as Promise<number | undefined>
    ])
      .then(([compute, render]) => {
        if (Number.isFinite(compute)) {
          this.gpuComputeMs = compute as number;
          if (this.validationScenario) pushBounded(this.validationComputeSamples, compute as number, 600);
        }
        if (Number.isFinite(render)) {
          this.gpuRenderMs = render as number;
          if (this.validationScenario) pushBounded(this.validationRenderSamples, render as number, 600);
        }
      })
      .catch(() => {
        // Timestamp queries are optional on some WebGPU adapters.
      })
      .finally(() => {
        this.gpuResolveInFlight = false;
        this.gpuResolvePromise = null;
      });
  }

  private isNearHelmCharger(rig: ReturnType<BoatVisual["getCockpitRig"]>): boolean {
    if (!rig || !this.firstPersonActive) return false;
    const anchor = rig.getStationWorldPosition("helm", this.chargerPosition);
    if (!anchor) return false;
    this.input.camera.getWorldPosition(this.stationPosition);
    const dx = this.stationPosition.x - anchor.x;
    const dz = this.stationPosition.z - anchor.z;
    return dx * dx + dz * dz <= 1.25 * 1.25 && Math.abs(this.stationPosition.y - anchor.y) <= 1.5;
  }
}

function pushBounded(target: number[], value: number, capacity: number): void {
  target.push(value);
  if (target.length > capacity) target.splice(0, target.length - capacity);
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function radiansToDegrees360(radians: number): number {
  return ((THREE.MathUtils.radToDeg(radians) % 360) + 360) % 360;
}

function flashlightConfigFromSettings(settings: DebugSettings): FlashlightConfig {
  return {
    capacitySeconds: settings.flashlightCapacitySeconds,
    rechargeSeconds: settings.flashlightRechargeSeconds,
    intensityCd: settings.flashlightIntensityCd,
    rangeM: settings.flashlightRangeM,
    halfAngleDeg: settings.flashlightHalfAngleDeg,
    penumbra: settings.flashlightPenumbra,
    lowThreshold: settings.flashlightLowThreshold,
    criticalThreshold: settings.flashlightCriticalThreshold
  };
}
