export const EARTH_RADIUS_M = 6_371_000;
export const MAX_REFRACTION_THICKNESS_M = 8;
export const CONTACT_WIDTH_M = 0.35;

export type Vec2Like = { x: number; y: number };
export type Vec3Like = { x: number; y: number; z: number };

export function earthCurvatureDrop(distanceM: number, radiusM = EARTH_RADIUS_M): number {
  if (!Number.isFinite(distanceM) || !Number.isFinite(radiusM) || radiusM <= 0) return 0;
  return Math.max(0, distanceM) ** 2 / (2 * radiusM);
}

export function geometricHorizonDistance(heightM: number, radiusM = EARTH_RADIUS_M): number {
  if (!Number.isFinite(heightM) || heightM <= 0 || radiusM <= 0) return 0;
  return Math.sqrt(2 * radiusM * heightM + heightM * heightM);
}

export function fresnelSchlick(cosTheta: number, f0 = 0.02037): number {
  const c = clamp01(cosTheta);
  return f0 + (1 - f0) * (1 - c) ** 5;
}

export function snellRefract(incident: Vec3Like, normal: Vec3Like, eta = 1 / 1.333): Vec3Like | null {
  const i = normalize3(incident);
  const n = normalize3(normal);
  const dotNI = i.x * n.x + i.y * n.y + i.z * n.z;
  const k = 1 - eta * eta * (1 - dotNI * dotNI);
  if (k < 0) return null;
  const a = eta * dotNI + Math.sqrt(k);
  return normalize3({ x: eta * i.x - a * n.x, y: eta * i.y - a * n.y, z: eta * i.z - a * n.z });
}

export function beerLambert(extinction: Vec3Like, pathM: number): Vec3Like {
  const path = Math.max(0, Number.isFinite(pathM) ? pathM : 0);
  return {
    x: Math.exp(-Math.max(0, extinction.x) * path),
    y: Math.exp(-Math.max(0, extinction.y) * path),
    z: Math.exp(-Math.max(0, extinction.z) * path)
  };
}

export function refractionValidity(mask: number, thicknessM: number, uv: Vec2Like): number {
  if (!Number.isFinite(thicknessM)) return 0;
  const edge = Math.min(uv.x, uv.y, 1 - uv.x, 1 - uv.y);
  const inBounds = smoothstep(0, 0.01, edge);
  const behind = smoothstep(0.002, 0.04, thicknessM);
  const within = 1 - smoothstep(MAX_REFRACTION_THICKNESS_M * 0.85, MAX_REFRACTION_THICKNESS_M, thicknessM);
  return clamp01(mask) * inBounds * behind * within;
}

export function contactOcclusion(thicknessM: number, distanceM: number, enabled = true): number {
  if (!enabled || !Number.isFinite(thicknessM) || thicknessM <= 0) return 0;
  const separation = 1 - smoothstep(0, CONTACT_WIDTH_M, thicknessM);
  const distanceFade = 1 - smoothstep(20, 45, Math.max(0, distanceM));
  return clamp01(separation * distanceFade * 0.25);
}

export function ssrConfidence(input: {
  edgeDistance: number;
  hitErrorM: number;
  thicknessM: number;
  rayDistanceM: number;
  maxDistanceM: number;
  roughness: number;
}): number {
  const edge = smoothstep(0.01, 0.08, input.edgeDistance);
  const hit = 1 - smoothstep(input.thicknessM * 0.5, input.thicknessM, Math.abs(input.hitErrorM));
  const distance = 1 - smoothstep(input.maxDistanceM * 0.7, input.maxDistanceM, input.rayDistanceM);
  const roughness = 1 - smoothstep(0.3, 0.48, input.roughness);
  return clamp01(edge * hit * distance * roughness);
}

export function temporalHistoryWeight(
  maxWeight: number,
  confidence: number,
  depthDeltaM: number,
  normalDot: number,
  velocityUv: number
): number {
  const depth = 1 - smoothstep(0.03, 0.25, Math.abs(depthDeltaM));
  const normal = smoothstep(0.82, 0.97, normalDot);
  const motion = 1 - smoothstep(0.015, 0.08, Math.abs(velocityUv));
  return clamp01(maxWeight) * clamp01(confidence) * depth * normal * motion;
}

function normalize3(value: Vec3Like): Vec3Like {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
