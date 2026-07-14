export type GameplayMode = "walking" | "helm" | "fishing" | "debugFreeCamera";

export type InputActionSnapshot = {
  forward: number;
  right: number;
  vertical: number;
  boost: boolean;
  interactPressed: boolean;
  flashlightPressed: boolean;
  primaryPressed: boolean;
  primaryReleased: boolean;
  primaryDown: boolean;
  wheelSteps: number;
  lookDeltaX: number;
  lookDeltaY: number;
  pointerLocked: boolean;
};

export type StationId = "helm" | "fishing";

export type StationDescriptor = {
  id: StationId;
  enterLabel: string;
  mode: Extract<GameplayMode, "helm" | "fishing">;
};

export type FlashlightLevel = "normal" | "low" | "critical" | "empty";

export type FlashlightState = {
  powered: boolean;
  charge01: number;
  charging: boolean;
  level: FlashlightLevel;
};

export type CockpitControlId =
  | "engine"
  | "cabinLight"
  | "workLight"
  | "horn"
  | "navigationLights"
  | "anchorLight"
  | "instrumentLights"
  | "wipers"
  | "bilgePump"
  | "radioPowerVolume"
  | "radioTuning";

export type InteractionTarget = {
  id: CockpitControlId;
  label: string;
  clickLabel: string;
  wheelLabel?: string;
};

export type RadioState = {
  powered: boolean;
  volume: number;
  station: number;
};

export type InstrumentReadings = {
  rpm: number;
  speedKnots: number;
  fuel: number;
  engineTemperatureC: number;
  voltage: number;
};

export type NavigationReadings = {
  headingDeg: number;
  worldX: number;
  worldZ: number;
};

export type BoatSystemsState = {
  engine: "off" | "starting" | "running";
  engineStartRemainingS: number;
  fuel: number;
  cabinLight: boolean;
  workLight: boolean;
  navigationLights: boolean;
  anchorLight: boolean;
  instrumentLights: boolean;
  horn: boolean;
  wipers: boolean;
  bilgePump: boolean;
  bilgeLevel: number;
  radio: RadioState;
  instruments: InstrumentReadings;
  navigation: NavigationReadings;
};

export type GameplayUiState = {
  mode: GameplayMode;
  pointerLocked: boolean;
  prompt: string | null;
  detail: string | null;
  targetLabel: string | null;
  reticleActive: boolean;
  status: string | null;
  flashlight: FlashlightState;
  flashlightIndicatorVisible: boolean;
};

export const DEFAULT_GAMEPLAY_UI: GameplayUiState = {
  mode: "walking",
  pointerLocked: false,
  prompt: null,
  detail: null,
  targetLabel: null,
  reticleActive: false,
  status: "Click para tomar el control de la cámara",
  flashlight: { powered: false, charge01: 1, charging: false, level: "normal" },
  flashlightIndicatorVisible: false
};
