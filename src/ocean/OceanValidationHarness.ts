import * as THREE from "three";
import type { DebugSettings, WeatherPresetName } from "../engine/types";

type CameraPreset = "rail" | "bow" | "bridge" | "aerial50" | "aerial150" | "aerial300";
type SeaPreset = "low" | "medium" | "high";

export type OceanValidationScenario = {
  id: string;
  camera: CameraPreset;
  sea: SeaPreset;
  weather: WeatherPresetName;
  worldTimeHours: number;
  simulationTimeSeconds: number;
  foam: boolean;
  seed: number;
};

const CAMERA_STATES: Record<CameraPreset, { position: [number, number, number]; target: [number, number, number] }> = {
  rail: { position: [3.4, 2.2, 0.5], target: [18, 0.2, -8] },
  bow: { position: [0, 2.6, -5.8], target: [0, 0.3, -45] },
  bridge: { position: [0, 4.2, 3.2], target: [0, 0.4, -35] },
  aerial50: { position: [32, 50, 28], target: [0, 0, -10] },
  aerial150: { position: [72, 150, 66], target: [0, 0, -18] },
  // A tiny horizontal offset avoids the undefined up vector of an exact 90° look-down.
  aerial300: { position: [1, 300, 1], target: [0, 0, -0.5] }
};

const SEA_BEAUFORT: Record<SeaPreset, number> = { low: 2, medium: 5, high: 8 };
const CAMERA_WEATHER: Record<CameraPreset, { weather: WeatherPresetName; hour: number }> = {
  rail: { weather: "clear", hour: 13.5 },
  bow: { weather: "clear", hour: 18.4 },
  bridge: { weather: "cloudy", hour: 15.2 },
  aerial50: { weather: "clear", hour: 13.5 },
  aerial150: { weather: "clear", hour: 16 },
  aerial300: { weather: "storm", hour: 15 }
};

const DECK_VALIDATION_SCENARIOS: readonly OceanValidationScenario[] = (
  ["rail", "bow", "bridge"] as const
).flatMap((camera) =>
  (["low", "medium", "high"] as const).map((sea) => ({
    id: `${camera}-${sea}`,
    camera,
    sea,
    weather: CAMERA_WEATHER[camera].weather,
    worldTimeHours: CAMERA_WEATHER[camera].hour,
    simulationTimeSeconds: 120,
    foam: true,
    seed: 1337
  }))
);

export const OCEAN_VALIDATION_SCENARIOS: readonly OceanValidationScenario[] = [
  ...DECK_VALIDATION_SCENARIOS,
  {
    id: "aerial-clear-50",
    camera: "aerial50",
    sea: "low",
    weather: CAMERA_WEATHER.aerial50.weather,
    worldTimeHours: CAMERA_WEATHER.aerial50.hour,
    simulationTimeSeconds: 120,
    foam: true,
    seed: 1337
  },
  {
    id: "aerial-clear-150",
    camera: "aerial150",
    sea: "medium",
    weather: CAMERA_WEATHER.aerial150.weather,
    worldTimeHours: CAMERA_WEATHER.aerial150.hour,
    simulationTimeSeconds: 120,
    foam: true,
    seed: 1337
  },
  {
    id: "aerial-storm-300",
    camera: "aerial300",
    sea: "high",
    weather: CAMERA_WEATHER.aerial300.weather,
    worldTimeHours: CAMERA_WEATHER.aerial300.hour,
    simulationTimeSeconds: 120,
    foam: true,
    seed: 1337
  },
  {
    id: "optical-rail-lateral",
    camera: "rail",
    sea: "medium",
    weather: "clear",
    worldTimeHours: 14.5,
    simulationTimeSeconds: 120,
    foam: true,
    seed: 1337
  },
  {
    id: "optical-bow-low-sun",
    camera: "bow",
    sea: "medium",
    weather: "clear",
    worldTimeHours: 17.4,
    simulationTimeSeconds: 120,
    foam: true,
    seed: 1337
  },
  {
    id: "optical-cloudy-high",
    camera: "bridge",
    sea: "high",
    weather: "cloudy",
    worldTimeHours: 15.2,
    simulationTimeSeconds: 120,
    foam: true,
    seed: 1337
  }
];

export function readOceanValidationScenario(search: string): OceanValidationScenario | null {
  const params = new URLSearchParams(search);
  const id = params.get("oceanValidation");
  if (!id) return null;
  const base = OCEAN_VALIDATION_SCENARIOS.find((scenario) => scenario.id === id);
  if (!base) throw new Error(`Unknown ocean validation scenario: ${id}`);
  return {
    ...base,
    foam: params.get("foam") !== "0",
    seed: Number.isFinite(Number(params.get("seed"))) ? Number(params.get("seed")) : base.seed
  };
}

export function applyOceanValidationSettings(
  settings: DebugSettings,
  scenario: OceanValidationScenario
): DebugSettings {
  return {
    ...settings,
    quality: "high",
    firstPerson: false,
    weatherPreset: scenario.weather,
    worldTimeHours: scenario.worldTimeHours,
    timeScale: 0,
    seaStateControlMode: "manual-overrides",
    beaufort: SEA_BEAUFORT[scenario.sea],
    oceanSeed: scenario.seed,
    showFoam: scenario.foam,
    boatWaterInteraction: false,
    paused: false
  };
}

export function applyOceanValidationCamera(camera: THREE.PerspectiveCamera, scenario: OceanValidationScenario): void {
  const state = CAMERA_STATES[scenario.camera];
  camera.position.set(...state.position);
  camera.lookAt(...state.target);
}
