import {
  Fn,
  abs,
  dot,
  float,
  floor,
  fract,
  mix,
  sin,
  vec2,
  vec3
} from "three/tsl";

type NodeRef = any;

/**
 * Shared TSL noise helpers for the volumetric cloud system. All lattice-based
 * functions are tileable: lattice coordinates are wrapped by an integer period
 * so generated 3D/2D textures can be sampled with repeat wrapping.
 */

/** Positive modulo for lattice coordinates (works for negative cells). */
const wrapCell = (cell: NodeRef, period: NodeRef): NodeRef =>
  cell.sub(floor(cell.div(period)).mul(period));

/** Deterministic vec3 hash in [0, 1). Good enough for offline texture baking. */
export const hash33 = /*@__PURE__*/ Fn(([p]: NodeRef[]) => {
  const q = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(q).mul(43758.5453123));
});

/** Deterministic vec2 hash in [0, 1). */
export const hash22 = /*@__PURE__*/ Fn(([p]: NodeRef[]) => {
  const q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(q).mul(43758.5453123));
});

/** Scalar hash of a 2D point in [0, 1). */
export const hash21 = /*@__PURE__*/ Fn(([p]: NodeRef[]) => {
  return fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
});

/** Tileable 3D gradient (Perlin-style) noise in [-1, 1], period is per-axis integer. */
export const perlin3 = /*@__PURE__*/ Fn(([p, period]: NodeRef[]) => {
  const pi: NodeRef = floor(p);
  const pf: NodeRef = fract(p);
  // Quintic fade for C2-continuous interpolation
  const w: NodeRef = pf.mul(pf).mul(pf).mul(pf.mul(pf.mul(6).sub(15)).add(10));

  const gradDot = (ox: number, oy: number, oz: number): NodeRef => {
    const corner = vec3(ox, oy, oz);
    const grad = hash33(wrapCell(pi.add(corner), period)).mul(2).sub(1);
    return dot(grad, pf.sub(corner));
  };

  const x00 = mix(gradDot(0, 0, 0), gradDot(1, 0, 0), w.x);
  const x10 = mix(gradDot(0, 1, 0), gradDot(1, 1, 0), w.x);
  const x01 = mix(gradDot(0, 0, 1), gradDot(1, 0, 1), w.x);
  const x11 = mix(gradDot(0, 1, 1), gradDot(1, 1, 1), w.x);
  const y0 = mix(x00, x10, w.y);
  const y1 = mix(x01, x11, w.y);
  return mix(y0, y1, w.z).mul(1.15);
});

/** Tileable 3D Worley (cellular) noise: 0 at feature points, ~1 far away. */
export const worley3 = /*@__PURE__*/ Fn(([p, period]: NodeRef[]) => {
  const pi = floor(p);
  const pf = fract(p);
  const minDist = float(10).toVar();

  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const offset = vec3(dx, dy, dz);
        const feature = hash33(wrapCell(pi.add(offset), period)).add(offset);
        const delta = feature.sub(pf);
        minDist.assign(minDist.min(dot(delta, delta)));
      }
    }
  }

  return minDist.sqrt().clamp(0, 1);
});

/** Inverted Worley FBM (bulbous cloud cells), 3 octaves, result in [0, 1]. */
export const worleyFbm3 = /*@__PURE__*/ Fn(([p, frequency]: NodeRef[]) => {
  const w0 = float(1).sub(worley3(p.mul(frequency), frequency));
  const w1 = float(1).sub(worley3(p.mul(frequency.mul(2)), frequency.mul(2)));
  const w2 = float(1).sub(worley3(p.mul(frequency.mul(4)), frequency.mul(4)));
  return w0.mul(0.625).add(w1.mul(0.25)).add(w2.mul(0.125));
});

/** Tileable Perlin FBM in [0, 1], `octaves` fixed at build time. */
export const perlinFbm3 = (p: NodeRef, frequency: NodeRef, octaves: number): NodeRef => {
  let sum: NodeRef = float(0);
  let amplitude = 0.5;
  let totalAmplitude = 0;
  let freq: NodeRef = frequency;

  for (let i = 0; i < octaves; i += 1) {
    sum = sum.add(perlin3(p.mul(freq), freq).mul(amplitude));
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    freq = freq.mul(2);
  }

  return sum.div(totalAmplitude).mul(0.5).add(0.5);
};

/** Non-tileable 2D value noise in [0, 1] for weather-map style fields. */
export const valueNoise2 = /*@__PURE__*/ Fn(([p]: NodeRef[]) => {
  const pi: NodeRef = floor(p);
  const pf: NodeRef = fract(p);
  const w: NodeRef = pf.mul(pf).mul(float(3).sub(pf.mul(2)));

  const v00 = hash21(pi);
  const v10 = hash21(pi.add(vec2(1, 0)));
  const v01 = hash21(pi.add(vec2(0, 1)));
  const v11 = hash21(pi.add(vec2(1, 1)));
  return mix(mix(v00, v10, w.x), mix(v01, v11, w.x), w.y);
});

/** 2D value-noise FBM in [0, 1], octave count fixed at build time. */
export const valueFbm2 = (p: NodeRef, octaves: number): NodeRef => {
  let sum: NodeRef = float(0);
  let amplitude = 0.5;
  let totalAmplitude = 0;
  let current: NodeRef = p;

  for (let i = 0; i < octaves; i += 1) {
    sum = sum.add(valueNoise2(current).mul(amplitude));
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    current = current.mul(2.03).add(vec2(19.7, 7.3));
  }

  return sum.div(totalAmplitude);
};

/** Tileable 2D value noise in [0, 1], period is per-axis integer lattice size. */
export const periodicValueNoise2 = /*@__PURE__*/ Fn(([p, period]: NodeRef[]) => {
  const pi: NodeRef = floor(p);
  const pf: NodeRef = fract(p);
  const w: NodeRef = pf.mul(pf).mul(float(3).sub(pf.mul(2)));

  const h = (offset: NodeRef): NodeRef => hash21(wrapCell(pi.add(offset), period));
  const v00 = h(vec2(0, 0));
  const v10 = h(vec2(1, 0));
  const v01 = h(vec2(0, 1));
  const v11 = h(vec2(1, 1));
  return mix(mix(v00, v10, w.x), mix(v01, v11, w.x), w.y);
});

/** Tileable 2D value-noise FBM in [0, 1], octave count fixed at build time. */
export const periodicValueFbm2 = (p: NodeRef, period: NodeRef, octaves: number): NodeRef => {
  let sum: NodeRef = float(0);
  let amplitude = 0.5;
  let totalAmplitude = 0;
  let current: NodeRef = p;
  let currentPeriod: NodeRef = period;

  for (let i = 0; i < octaves; i += 1) {
    sum = sum.add(periodicValueNoise2(current, currentPeriod).mul(amplitude));
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    current = current.mul(2);
    currentPeriod = currentPeriod.mul(2);
  }

  return sum.div(totalAmplitude);
};

/** 2D Worley noise (non-tileable), 0 at feature points. */
export const worley2 = /*@__PURE__*/ Fn(([p]: NodeRef[]) => {
  const pi = floor(p);
  const pf = fract(p);
  const minDist = float(10).toVar();

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const offset = vec2(dx, dy);
      const feature = hash22(pi.add(offset)).add(offset);
      const delta = feature.sub(pf);
      minDist.assign(minDist.min(dot(delta, delta)));
    }
  }

  return minDist.sqrt().clamp(0, 1);
});

/** Tileable 2D Worley noise, 0 at feature points. */
export const periodicWorley2 = /*@__PURE__*/ Fn(([p, period]: NodeRef[]) => {
  const pi = floor(p);
  const pf = fract(p);
  const minDist = float(10).toVar();

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const offset = vec2(dx, dy);
      const cell = wrapCell(pi.add(offset), period);
      const feature = hash22(cell).add(offset);
      const delta = feature.sub(pf);
      minDist.assign(minDist.min(dot(delta, delta)));
    }
  }

  return minDist.sqrt().clamp(0, 1);
});

/** Remap helper: maps x from [oldMin, oldMax] to [newMin, newMax], unclamped. */
export const remapNode = (
  x: NodeRef,
  oldMin: NodeRef,
  oldMax: NodeRef,
  newMin: NodeRef,
  newMax: NodeRef
): NodeRef => {
  return x.sub(oldMin).div(oldMax.sub(oldMin).max(1e-5)).mul(newMax.sub(newMin)).add(newMin);
};

/** Cheap analytic ridged detail used to distort cloud edges (wispy look). */
export const ridge = (x: NodeRef): NodeRef => float(1).sub(abs(x.mul(2).sub(1)));
