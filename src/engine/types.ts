import type { BoatSystemsState, FlashlightState, GameplayMode } from "../gameplay/types";

export type QualityTier = "low" | "medium" | "high";
export type LightningOverride = "weather" | "off" | "fixed";

export type WeatherPresetName = "clear" | "cloudy" | "rain" | "storm";

export type AtmosphereDebugMode =
  | "off"
  | "weatherCoverage"
  | "weatherType"
  | "precipitation"
  | "erosion"
  | "densitySlice"
  | "historyWeight"
  | "seamGrid"
  | "sceneDepth"
  | "cloudRayEnd"
  | "cloudFirstHit"
  | "cloudOcclusionMask";

export type DebugRenderMode =
  | "final"
  | "wireframe"
  | "height"
  | "normal"
  | "foam"
  | "boatInteraction"
  | "jacobian"
  | "slope"
  | "rawSlope"
  | "filteredSlope"
  | "slopeMip"
  | "slopeVariance"
  | "anisotropy"
  | "roughness"
  | "jacobianTerms"
  | "geometryLodWeight"
  | "normalLodWeight"
  | "unresolvedEnergy"
  | "cascades"
  | "fresnel"
  | "opticalDepth"
  | "waterVolume"
  | "localSpecular"
  | "localVolume"
  | "localLightRoles"
  | "sunGlitter"
  | "moonGlitter"
  | "ambientVolume"
  | "foamLighting"
  | "luminanceHeatmap"
  | "clippingMask";

export type SeaStateControlMode = "weather" | "manual-overrides";

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
  /** 0 = flat stratus layer, 1 = tall convective cumulonimbus towers. */
  convectivity: number;
  /** 0-1 amount of high-altitude cirrus haze. */
  cirrusAmount: number;
  /** Average lightning strikes per minute at full storm intensity. */
  lightningRate: number;
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
  /** 0-1 direct sun light/reflection mask (horizon elevation fade). */
  sunDirectMask: number;
  /** 0-1 direct moon light/reflection mask (horizon elevation fade). */
  moonDirectMask: number;
  /** Residual twilight for ambient sky and subdued water IBL. */
  twilightFactor: number;
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
  exposure: number;
  celestial: CelestialState;
};

export type CameraDebugState = {
  x: number;
  y: number;
  z: number;
  yawDeg: number;
  pitchDeg: number;
};

export type BoatDebugState = {
  position: { x: number; y: number; z: number };
  speedMs: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  throttle: number;
  rudder: number;
  capsized: boolean;
  waterHeightM: number | null;
};

export type FirstPersonDebugState = {
  localX: number;
  localY: number;
  localZ: number;
  yawDeg: number;
  pitchDeg: number;
  onGround: boolean;
};

export type FishingDebugState = {
  paidOutLengthM: number;
  ropeTension: number;
  boomElevationDeg: number;
  boomMinDeg: number;
  boomMaxDeg: number;
};

export type EngineMetrics = {
  backend: "webgpu";
  fps: number;
  frameMs: number;
  cpuMs: number;
  gpuMs: number | null;
  gpuComputeMs: number | null;
  gpuRenderMs: number | null;
  oceanComputeMs: number | null;
  slopeMomentComputeMs: number | null;
  cloudComputeMs: number | null;
  depthPrepassMs: number | null;
  boatInteractionComputeMs: number | null;
  oceanSpectrum: Array<{
    energy: number;
    heightVariance: number;
    slopeVariance: number;
    correlation: number;
  }>;
  seaLevelAtCameraM: number | null;
  worldTimeHours: number;
  camera: CameraDebugState;
  boat: BoatDebugState | null;
  firstPerson: FirstPersonDebugState | null;
  fishing: FishingDebugState | null;
  systems: BoatSystemsState | null;
  flashlight: FlashlightState;
  gameplayMode: GameplayMode;
  originOffsetMeters: { x: number; z: number };
  status: "booting" | "running" | "error";
  error: string | null;
};

export type FishingRopeRenderMode = "tube" | "line";

export type DebugSettings = {
  quality: QualityTier;
  renderMode: DebugRenderMode;
  atmosphereDebugMode: AtmosphereDebugMode;
  weatherPreset: WeatherPresetName;
  worldTimeHours: number;
  timeScale: number;
  /** Master sea state control, Beaufort scale 0-12. */
  beaufort: number;
  /** Weather owns wind/swell unless explicit manual overrides are enabled. */
  seaStateControlMode: SeaStateControlMode;
  /** Stable world seed used to derive statistically independent cascade seeds. */
  oceanSeed: number;
  showSky: boolean;
  showOcean: boolean;
  oceanDisplacement: boolean;
  showFoam: boolean;
  showRain: boolean;
  showClouds: boolean;
  boatWaterInteraction: boolean;
  /** Weather preset transition duration in seconds. */
  weatherTransitionSeconds: number;
  wireframe: boolean;
  paused: boolean;
  /** Advanced physical spectrum parameters. */
  fetchKm: number;
  swellAmount: number;
  swellDirectionDeg: number;
  choppiness: number;
  foamIntensity: number;
  foamDecay: number;
  boatWakeIntensity: number;
  boatWakeFoamIntensity: number;
  waterTurbidity: number;
  oceanLocalScatterGain: number;
  oceanPhaseG: number;
  oceanNightUpwellingGain: number;
  oceanSunGlitterGain: number;
  oceanMoonGlitterGain: number;
  oceanLocalOpticalPathM: number;
  /** PR6B diagnostic: disables covariance-driven anisotropy without changing waves. */
  oceanAnisotropyEnabled: boolean;
  /** PR6B diagnostic: -1 selects projected mip automatically, otherwise fixes a mip level. */
  oceanSlopeMipOverride: number;
  lightningOverride: LightningOverride;
  cloudCoverageBias: number;
  cloudDensityBias: number;
  exposureBias: number;
  /** Master toggle for all boat lights (spotlights). Off by default. */
  boatLightsOn: boolean;
  firstPerson: boolean;
  flashlightCapacitySeconds: number;
  flashlightRechargeSeconds: number;
  flashlightIntensityCd: number;
  flashlightRangeM: number;
  flashlightHalfAngleDeg: number;
  flashlightPenumbra: number;
  flashlightLowThreshold: number;
  flashlightCriticalThreshold: number;
  fishingRopeEnabled: boolean;
  fishingRopeRadius: number;
  fishingRopeRenderMode: FishingRopeRenderMode;
  fishingRopeMinLengthM: number;
  fishingRopeMaxLengthM: number;
  fishingRopeInitialLengthM: number;
  fishingReelSpeedMs: number;
  /** Allowed boom pitch range in degrees (X axis, Y/H controls). */
  fishingBoomMinDeg: number;
  fishingBoomMaxDeg: number;
  fishingBoomDefaultDeg: number;
};
