import * as THREE from "three";
import type { DebugRenderMode, DebugSettings, LightningOverride, QualityTier, WeatherPresetName } from "../engine/types";
import type { BoatSystemsState } from "../gameplay/types";

type CameraPreset = "rail" | "railForward" | "bow" | "bridge" | "aerial50" | "aerial150" | "aerial300";
type SeaPreset = "low" | "medium" | "high";
export type ValidationCameraMotion = "static" | "pan-slow";
export type ValidationLightName = "work" | "flashlight" | "cabin" | "navigation" | "anchor";
export type ValidationLightState = Readonly<Record<ValidationLightName, boolean>>;

export type OceanValidationScenario = {
  id: string;
  camera: CameraPreset;
  sea: SeaPreset;
  weather: WeatherPresetName;
  worldTimeHours: number;
  simulationTimeSeconds: number;
  foam: boolean;
  seed: number;
  lights: ValidationLightState;
  lightning: LightningOverride;
  cameraMotion: ValidationCameraMotion;
  debugView: DebugRenderMode;
  quality: QualityTier;
};

type ScenarioInput = Omit<OceanValidationScenario, "lights" | "lightning" | "cameraMotion" | "debugView" | "quality"> &
  Partial<Pick<OceanValidationScenario, "lights" | "lightning" | "cameraMotion" | "debugView" | "quality">>;

const LIGHTS_OFF: ValidationLightState = Object.freeze({
  work: false,
  flashlight: false,
  cabin: false,
  navigation: false,
  anchor: false
});
const CAMERA_PAN_TARGET = new THREE.Vector3();

function scenario(input: ScenarioInput): OceanValidationScenario {
  return {
    ...input,
    lights: Object.freeze({ ...LIGHTS_OFF, ...input.lights }),
    lightning: input.lightning ?? "off",
    cameraMotion: input.cameraMotion ?? "static",
    debugView: input.debugView ?? "final",
    quality: input.quality ?? "high"
  };
}

const CAMERA_STATES: Record<CameraPreset, { position: [number, number, number]; target: [number, number, number] }> = {
  rail: { position: [3.4, 2.2, 0.5], target: [18, 0.2, -8] },
  railForward: { position: [3.4, 2.2, 0.5], target: [0, 0.2, -45] },
  bow: { position: [0, 2.6, -5.8], target: [0, 0.3, -45] },
  bridge: { position: [0, 4.2, 3.2], target: [0, 0.4, -35] },
  aerial50: { position: [32, 50, 28], target: [0, 0, -10] },
  aerial150: { position: [72, 150, 66], target: [0, 0, -18] },
  // A tiny horizontal offset avoids the undefined up vector of an exact 90-degree look-down.
  aerial300: { position: [1, 300, 1], target: [0, 0, -0.5] }
};

const SEA_BEAUFORT: Record<SeaPreset, number> = { low: 2, medium: 5, high: 8 };
const CAMERA_WEATHER: Record<CameraPreset, { weather: WeatherPresetName; hour: number }> = {
  rail: { weather: "clear", hour: 13.5 },
  railForward: { weather: "clear", hour: 13.5 },
  bow: { weather: "clear", hour: 18.4 },
  bridge: { weather: "cloudy", hour: 15.2 },
  aerial50: { weather: "clear", hour: 13.5 },
  aerial150: { weather: "clear", hour: 16 },
  aerial300: { weather: "storm", hour: 15 }
};

const DECK_VALIDATION_SCENARIOS: readonly OceanValidationScenario[] = (
  ["rail", "bow", "bridge"] as const
).flatMap((camera) =>
  (["low", "medium", "high"] as const).map((sea) => scenario({
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
  scenario({ id: "aerial-clear-50", camera: "aerial50", sea: "low", weather: "clear", worldTimeHours: 13.5, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "aerial-clear-150", camera: "aerial150", sea: "medium", weather: "clear", worldTimeHours: 16, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "aerial-storm-300", camera: "aerial300", sea: "high", weather: "storm", worldTimeHours: 15, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "optical-rail-lateral", camera: "rail", sea: "medium", weather: "clear", worldTimeHours: 14.5, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "optical-bow-low-sun", camera: "bow", sea: "medium", weather: "clear", worldTimeHours: 17.4, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "optical-cloudy-high", camera: "bridge", sea: "high", weather: "cloudy", worldTimeHours: 15.2, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "pr6b-rail-night-off", camera: "railForward", sea: "medium", weather: "clear", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "pr6b-rail-night-work", camera: "railForward", sea: "medium", weather: "clear", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337, lights: { ...LIGHTS_OFF, work: true } }),
  scenario({ id: "pr6b-bow-night-off", camera: "bow", sea: "medium", weather: "clear", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "pr6b-bow-night-flashlight", camera: "bow", sea: "medium", weather: "clear", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337, lights: { ...LIGHTS_OFF, flashlight: true } }),
  scenario({ id: "pr6b-cabin-night", camera: "bridge", sea: "low", weather: "clear", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337, lights: { ...LIGHTS_OFF, cabin: true } }),
  scenario({ id: "pr6b-navigation-night", camera: "aerial50", sea: "low", weather: "clear", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337, lights: { ...LIGHTS_OFF, navigation: true } }),
  scenario({ id: "pr6b-anchor-night", camera: "aerial50", sea: "low", weather: "clear", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337, lights: { ...LIGHTS_OFF, anchor: true } }),
  scenario({ id: "pr6b-bridge-moon", camera: "bridge", sea: "medium", weather: "clear", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "pr6b-storm-fixed-lightning", camera: "bridge", sea: "high", weather: "storm", worldTimeHours: 1, simulationTimeSeconds: 120, foam: true, seed: 1337, lightning: "fixed" }),
  scenario({ id: "pr6b-low-sun-bow", camera: "bow", sea: "medium", weather: "clear", worldTimeHours: 17.4, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "pr6b-sun-lateral", camera: "rail", sea: "medium", weather: "clear", worldTimeHours: 14.5, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "pr6b-cloudy-deck", camera: "bridge", sea: "medium", weather: "cloudy", worldTimeHours: 15.2, simulationTimeSeconds: 120, foam: true, seed: 1337 }),
  scenario({ id: "pr6b-horizon-pan", camera: "bridge", sea: "medium", weather: "clear", worldTimeHours: 16, simulationTimeSeconds: 120, foam: false, seed: 1337, cameraMotion: "pan-slow" })
];

export function readOceanValidationScenario(search: string): OceanValidationScenario | null {
  const params = new URLSearchParams(search);
  const id = params.get("oceanValidation");
  if (!id) return null;
  const base = OCEAN_VALIDATION_SCENARIOS.find((entry) => entry.id === id);
  if (!base) throw new Error(`Unknown ocean validation scenario: ${id}`);
  return {
    ...base,
    foam: params.get("foam") === null ? base.foam : params.get("foam") !== "0",
    seed: parseFinite(params.get("seed"), base.seed),
    lightning: parseLightningOverride(params.get("lightning"), base.lightning),
    lights: parseLights(params.get("lights"), base.lights),
    debugView: parseOceanDebugView(params.get("debugOcean"), base.debugView),
    quality: parseQuality(params.get("quality"), base.quality)
  };
}

export function applyOceanValidationSettings(
  settings: DebugSettings,
  current: OceanValidationScenario
): DebugSettings {
  return {
    ...settings,
    quality: current.quality,
    firstPerson: false,
    weatherPreset: current.weather,
    worldTimeHours: current.worldTimeHours,
    timeScale: 0,
    seaStateControlMode: "manual-overrides",
    beaufort: SEA_BEAUFORT[current.sea],
    oceanSeed: current.seed,
    showFoam: current.foam,
    renderMode: current.debugView,
    boatLightsOn: current.lights.work,
    lightningOverride: current.lightning,
    boatWaterInteraction: false,
    paused: false
  };
}

export function applyOceanValidationLights(state: BoatSystemsState, current: OceanValidationScenario): void {
  state.workLight = current.lights.work;
  state.cabinLight = current.lights.cabin;
  state.navigationLights = current.lights.navigation;
  state.anchorLight = current.lights.anchor;
}

export function validationFlashlightEnabled(current: OceanValidationScenario | null): boolean {
  return current?.lights.flashlight ?? false;
}

export function applyOceanValidationCamera(
  camera: THREE.PerspectiveCamera,
  current: OceanValidationScenario,
  elapsedSeconds = 0
): void {
  const state = CAMERA_STATES[current.camera];
  camera.position.set(...state.position);
  if (current.cameraMotion === "pan-slow") {
    const yaw = THREE.MathUtils.degToRad(Math.sin(elapsedSeconds * 0.16) * 6);
    CAMERA_PAN_TARGET.set(...state.target)
      .sub(camera.position)
      .applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw)
      .add(camera.position);
    camera.lookAt(CAMERA_PAN_TARGET);
    return;
  }
  camera.lookAt(...state.target);
}

function parseFinite(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseLightningOverride(raw: string | null, fallback: LightningOverride): LightningOverride {
  return raw === "weather" || raw === "off" || raw === "fixed" ? raw : fallback;
}

function parseLights(raw: string | null, fallback: ValidationLightState): ValidationLightState {
  if (raw === null) return fallback;
  const requested = new Set(raw.split(",").map((entry) => entry.trim()));
  return Object.freeze({
    work: requested.has("work"),
    flashlight: requested.has("flashlight"),
    cabin: requested.has("cabin"),
    navigation: requested.has("navigation"),
    anchor: requested.has("anchor")
  });
}

function parseOceanDebugView(raw: string | null, fallback: DebugRenderMode): DebugRenderMode {
  const values: readonly DebugRenderMode[] = [
    "final", "wireframe", "height", "normal", "foam", "boatInteraction", "jacobian", "slope", "rawSlope",
    "filteredSlope", "slopeMip", "slopeVariance", "anisotropy", "roughness", "jacobianTerms",
    "geometryLodWeight", "normalLodWeight", "unresolvedEnergy", "cascades", "fresnel", "opticalDepth",
    "waterVolume", "localSpecular", "localVolume", "localLightRoles", "sunGlitter", "moonGlitter",
    "ambientVolume", "foamLighting", "luminanceHeatmap", "clippingMask"
  ];
  return raw !== null && values.includes(raw as DebugRenderMode) ? raw as DebugRenderMode : fallback;
}

function parseQuality(raw: string | null, fallback: QualityTier): QualityTier {
  return raw === "low" || raw === "medium" || raw === "high" ? raw : fallback;
}
