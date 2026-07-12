import * as THREE from "three/webgpu";

export type BoomElevationLimitsDeg = {
  minDeg: number;
  maxDeg: number;
  defaultDeg: number;
};

/** Collision-safe defaults for the outward-facing boom pitch (degrees, X axis). */
export const DEFAULT_BOOM_ELEVATION_LIMITS_DEG: BoomElevationLimitsDeg = {
  minDeg: -12,
  maxDeg: 60,
  defaultDeg: -10
};

let limitsDeg: BoomElevationLimitsDeg = { ...DEFAULT_BOOM_ELEVATION_LIMITS_DEG };

export function setBoomElevationLimitsDeg(next: Partial<BoomElevationLimitsDeg>): BoomElevationLimitsDeg {
  const minDeg = next.minDeg ?? limitsDeg.minDeg;
  const maxDeg = Math.max(next.maxDeg ?? limitsDeg.maxDeg, minDeg);
  const defaultDeg = THREE.MathUtils.clamp(next.defaultDeg ?? limitsDeg.defaultDeg, minDeg, maxDeg);
  limitsDeg = { minDeg, maxDeg, defaultDeg };
  return { ...limitsDeg };
}

export function getBoomElevationLimitsDeg(): BoomElevationLimitsDeg {
  return { ...limitsDeg };
}

export function getBoomElevationMinRad(): number {
  return THREE.MathUtils.degToRad(limitsDeg.minDeg);
}

export function getBoomElevationMaxRad(): number {
  return THREE.MathUtils.degToRad(limitsDeg.maxDeg);
}

export function getBoomElevationDefaultRad(): number {
  return THREE.MathUtils.degToRad(limitsDeg.defaultDeg);
}

export function clampBoomElevationRad(angleRad: number): number {
  return THREE.MathUtils.clamp(angleRad, getBoomElevationMinRad(), getBoomElevationMaxRad());
}

export function boomElevationRadToDeg(angleRad: number): number {
  return THREE.MathUtils.radToDeg(angleRad);
}
