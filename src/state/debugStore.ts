import { writable } from "svelte/store";
import type { DebugSettings, EngineMetrics } from "../engine/types";
import { DEFAULT_BOOM_ELEVATION_LIMITS_DEG } from "../fishing/boomElevationLimits";

export const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
  quality: "medium",
  renderMode: "final",
  atmosphereDebugMode: "off",
  weatherPreset: "clear",
  worldTimeHours: 16.25,
  timeScale: 180,
  beaufort: 3.5,
  showSky: true,
  showOcean: true,
  oceanDisplacement: true,
  showFoam: true,
  showRain: true,
  showClouds: true,
  boatWaterInteraction: true,
  weatherTransitionSeconds: 45,
  wireframe: false,
  paused: false,
  fetchKm: 300,
  swellAmount: 0.35,
  swellDirectionDeg: 25,
  choppiness: 1.25,
  foamIntensity: 1,
  foamDecay: 0.28,
  boatWakeIntensity: 1,
  boatWakeFoamIntensity: 1,
  waterTurbidity: 0.22,
  cloudCoverageBias: 0,
  cloudDensityBias: 0,
  exposureBias: 0,
  boatLightsOn: false,
  firstPerson: false,
  fishingRopeEnabled: true,
  fishingRopeRadius: 0.008,
  fishingRopeRenderMode: "tube",
  fishingRopeMinLengthM: 0.2,
  fishingRopeMaxLengthM: 50,
  fishingRopeInitialLengthM: 0.5,
  fishingReelSpeedMs: 0.5,
  fishingBoomMinDeg: DEFAULT_BOOM_ELEVATION_LIMITS_DEG.minDeg,
  fishingBoomMaxDeg: DEFAULT_BOOM_ELEVATION_LIMITS_DEG.maxDeg,
  fishingBoomDefaultDeg: DEFAULT_BOOM_ELEVATION_LIMITS_DEG.defaultDeg
};

export const DEFAULT_ENGINE_METRICS: EngineMetrics = {
  backend: "webgpu",
  fps: 0,
  frameMs: 0,
  cpuMs: 0,
  gpuMs: null,
  oceanComputeMs: null,
  cloudComputeMs: null,
  depthPrepassMs: null,
  boatInteractionComputeMs: null,
  seaLevelAtCameraM: null,
  worldTimeHours: DEFAULT_DEBUG_SETTINGS.worldTimeHours,
  camera: { x: 0, y: 14, z: 32, yawDeg: 0, pitchDeg: -12 },
  boat: null,
  firstPerson: null,
  fishing: null,
  originOffsetMeters: { x: 0, z: 0 },
  status: "booting",
  error: null
};

export const debugSettings = writable<DebugSettings>({
  ...DEFAULT_DEBUG_SETTINGS
});

export const engineMetrics = writable<EngineMetrics>({
  ...DEFAULT_ENGINE_METRICS
});
