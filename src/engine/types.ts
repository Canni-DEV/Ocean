export type QualityTier = "low" | "medium" | "high";

export type WeatherPresetName = "clear" | "cloudy" | "rain";

export type DebugRenderMode =
  | "final"
  | "wireframe"
  | "ocean-height"
  | "ocean-normal"
  | "foam"
  | "breaking"
  | "curvature"
  | "detail-normal"
  | "roughness"
  | "fresnel"
  | "wave-slope"
  | "weather";

export type WeatherState = {
  windDirectionRad: number;
  windSpeedMs: number;
  swellDirectionRad: number;
  swellStrength: number;
  cloudCoverage: number;
  cloudDensity: number;
  cloudBaseMeters: number;
  cloudThicknessMeters: number;
  cloudDarkening: number;
  humidity: number;
  precipitation: number;
  visibilityKm: number;
  aerosolDensity: number;
  stormIntensity: number;
  transitionProgress: number;
};

export type CelestialState = {
  sunDirection: { x: number; y: number; z: number };
  moonDirection: { x: number; y: number; z: number };
  sunVisibility: number;
  moonVisibility: number;
  starVisibility: number;
  moonPhase: number;
};

export type EnvironmentState = {
  skyZenithColor: string;
  skyHorizonColor: string;
  fogColor: string;
  fogDensity: number;
  ambientColor: string;
  ambientIntensity: number;
  sunColor: string;
  sunIntensity: number;
  moonColor: string;
  moonIntensity: number;
  cloudShadow: number;
  reflectionColor: string;
  waterAbsorptionColor: string;
  exposure: number;
  celestial: CelestialState;
};

export type OceanSettings = {
  resolution: 256;
  patchSizeMeters: number;
  windDirectionRad: number;
  windSpeedMs: number;
  choppiness: number;
};

export type CameraDebugState = {
  x: number;
  y: number;
  z: number;
  yawDeg: number;
  pitchDeg: number;
};

export type EngineMetrics = {
  backend: "webgpu";
  fps: number;
  frameMs: number;
  cpuMs: number;
  gpuMs: number | null;
  oceanComputeMs: number | null;
  worldTimeHours: number;
  camera: CameraDebugState;
  originOffsetMeters: { x: number; z: number };
  status: "booting" | "running" | "error";
  error: string | null;
};

export type DebugSettings = {
  quality: QualityTier;
  renderMode: DebugRenderMode;
  weatherPreset: WeatherPresetName;
  worldTimeHours: number;
  timeScale: number;
  showSky: boolean;
  showOcean: boolean;
  oceanDisplacement: boolean;
  showFoam: boolean;
  showRain: boolean;
  wireframe: boolean;
  paused: boolean;
  cloudCoverageBias: number;
  cloudDensityBias: number;
  stormBias: number;
  waveScale: number;
  waterRoughnessBias: number;
  foamIntensity: number;
  exposureBias: number;
};
