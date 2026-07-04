import * as THREE from "three/webgpu";

const RAD2DEG = 180 / Math.PI;

/** Elevation in degrees from the horizon for a unit direction's Y component. */
export function elevationDegrees(directionY: number): number {
  return Math.asin(Math.max(-1, Math.min(1, directionY))) * RAD2DEG;
}

/**
 * Direct-light visibility for a celestial body (MSFS-style twilight fade).
 * Full strength above +2°, zero below -4°.
 */
export function directLightMask(directionY: number): number {
  const elevDeg = elevationDegrees(directionY);
  return THREE.MathUtils.smoothstep(elevDeg, -4, 2);
}

/**
 * Residual twilight factor for ambient sky glow and subdued IBL on water.
 * Peaks near the horizon crossing and decays after the sun is well below.
 */
export function twilightFactor(sunY: number): number {
  const elevDeg = elevationDegrees(sunY);
  const nearHorizon = Math.exp(-Math.abs(elevDeg) * 0.35);
  const belowHorizon = THREE.MathUtils.smoothstep(elevDeg, 2, -8);
  return nearHorizon * belowHorizon;
}
