export type OceanOpticsProfile = {
  id: "ATLANTIC_DEEP";
  ior: number;
  absorptionBase: readonly [number, number, number];
  absorptionTurbid: readonly [number, number, number];
  scatteringBase: readonly [number, number, number];
  scatteringTurbid: readonly [number, number, number];
  effectiveDepthBaseM: number;
  effectiveDepthTurbidM: number;
  upwellingDay: number;
  upwellingNight: number;
  nightIblIntensity: number;
  dayIblIntensity: number;
  sunGlitterGain: number;
  moonGlitterGain: number;
  localPhaseG: number;
  localOpticalPathM: number;
  localScatterGain: number;
  waterRoughnessMin: number;
  waterRoughnessMax: number;
  celestialAngularRadiusDeg: number;
  foamColor: `#${string}`;
  foamRoughness: number;
};

export const ATLANTIC_DEEP: Readonly<OceanOpticsProfile> = Object.freeze({
  id: "ATLANTIC_DEEP",
  ior: 1.333,
  absorptionBase: [0.32, 0.075, 0.028] as const,
  absorptionTurbid: [0.42, 0.14, 0.065] as const,
  scatteringBase: [0.006, 0.018, 0.032] as const,
  scatteringTurbid: [0.028, 0.065, 0.052] as const,
  effectiveDepthBaseM: 10,
  effectiveDepthTurbidM: 4,
  upwellingDay: 0.55,
  upwellingNight: 0.75,
  nightIblIntensity: 0.015,
  dayIblIntensity: 0.2,
  sunGlitterGain: 0.035,
  moonGlitterGain: 0.51,
  localPhaseG: 0.55,
  localOpticalPathM: 6,
  localScatterGain: 1,
  waterRoughnessMin: 0.08,
  waterRoughnessMax: 0.48,
  celestialAngularRadiusDeg: 0.266,
  foamColor: "#dbe7e7",
  foamRoughness: 0.72
});

export const OCEAN_OPTICS_OVERRIDE_LIMITS = Object.freeze({
  localScatterGain: [0.25, 2] as const,
  phaseG: [0, 0.85] as const,
  nightUpwellingGain: [0.25, 1.5] as const,
  sunGlitterGain: [0.01, 2] as const,
  moonGlitterGain: [0.02, 2] as const,
  localOpticalPathM: [1, 12] as const
});

export function clampOceanOpticsOverride(value: number, limits: readonly [number, number]): number {
  return Math.min(limits[1], Math.max(limits[0], Number.isFinite(value) ? value : limits[0]));
}
