import { writable } from "svelte/store";
import type { DebugSettings, EngineMetrics } from "../engine/types";

export const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
  quality: "medium",
  renderMode: "final",
  weatherPreset: "clear",
  worldTimeHours: 16.25,
  timeScale: 180,
  showSky: true,
  showOcean: true,
  oceanDisplacement: true,
  showFoam: true,
  showRain: true,
  wireframe: false,
  paused: false,
  cloudCoverageBias: 0,
  cloudDensityBias: 0,
  stormBias: 0,
  waveScale: 1,
  waterRoughnessBias: 0,
  foamIntensity: 1,
  exposureBias: 0
};

export const DEFAULT_ENGINE_METRICS: EngineMetrics = {
  backend: "webgpu",
  fps: 0,
  frameMs: 0,
  cpuMs: 0,
  gpuMs: null,
  oceanComputeMs: null,
  worldTimeHours: DEFAULT_DEBUG_SETTINGS.worldTimeHours,
  camera: { x: 0, y: 14, z: 32, yawDeg: 0, pitchDeg: -12 },
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
