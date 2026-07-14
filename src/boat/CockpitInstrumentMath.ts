export type RadarProjection = {
  x: number;
  y: number;
  distance: number;
  visible: boolean;
};

const DEG_TO_RAD = Math.PI / 180;
const GAUGE_START_RAD = 3 * Math.PI / 4;
const GAUGE_END_RAD = -3 * Math.PI / 4;

export function gaugeValueToAngle(value: number, minimum: number, maximum: number): number {
  const span = maximum - minimum;
  const normalized = span > 0 ? Math.min(1, Math.max(0, (value - minimum) / span)) : 0;
  return GAUGE_START_RAD + (GAUGE_END_RAD - GAUGE_START_RAD) * normalized;
}

export function smoothWrappedAngle(
  current: number,
  target: number,
  smoothing: number
): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * Math.min(1, Math.max(0, smoothing));
}

export function headingToCompassAngle(headingDeg: number): number {
  return headingDeg * DEG_TO_RAD;
}

export function projectWorldTargetToHeadUpRadar(
  boatWorldX: number,
  boatWorldZ: number,
  headingDeg: number,
  targetWorldX: number,
  targetWorldZ: number,
  rangeMeters: number,
  output: RadarProjection
): RadarProjection {
  const deltaX = targetWorldX - boatWorldX;
  const deltaZ = targetWorldZ - boatWorldZ;
  const headingRad = headingDeg * DEG_TO_RAD;
  const right = deltaX * Math.cos(headingRad) + deltaZ * Math.sin(headingRad);
  const forward = deltaX * Math.sin(headingRad) - deltaZ * Math.cos(headingRad);
  const safeRange = Math.max(rangeMeters, Number.EPSILON);
  const distance = Math.hypot(deltaX, deltaZ);
  output.x = right / safeRange;
  output.y = forward / safeRange;
  output.distance = distance;
  output.visible = distance <= safeRange;
  return output;
}
