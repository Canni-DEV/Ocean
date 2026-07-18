const PI = Math.PI;
const EPSILON = 1e-6;

export function waterF0(ior = 1.333): number {
  const ratio = (ior - 1) / (ior + 1);
  return ratio * ratio;
}

export function fresnelSchlick(cosine: number, f0 = waterF0()): number {
  const c = Math.min(1, Math.max(0, cosine));
  return f0 + (1 - f0) * (1 - c) ** 5;
}

export function henyeyGreenstein(cosTheta: number, g: number): number {
  const cosine = Math.min(1, Math.max(-1, cosTheta));
  const asymmetry = Math.min(0.95, Math.max(-0.95, g));
  const g2 = asymmetry * asymmetry;
  const denominator = Math.max(EPSILON, 1 + g2 - 2 * asymmetry * cosine);
  return (1 - g2) / (4 * PI * denominator ** 1.5);
}

export function localBeerLambert(
  extinction: readonly [number, number, number],
  opticalPathM: number,
  maximumPathM = Number.POSITIVE_INFINITY
): [number, number, number] {
  const path = Math.min(Math.max(0, opticalPathM), Math.max(0, maximumPathM));
  return extinction.map((coefficient) => Math.exp(-Math.max(0, coefficient) * path)) as [number, number, number];
}

export function distanceAttenuation(distanceM: number, rangeM: number, decay = 2): number {
  const distance = Math.max(distanceM, 0.01);
  const inverse = 1 / Math.max(distance ** Math.max(decay, 0), 0.01);
  if (rangeM <= 0) return inverse;
  const ratio = Math.min(1, Math.max(0, distance / rangeM));
  const rangeWindow = Math.max(0, 1 - ratio ** 4) ** 2;
  return inverse * rangeWindow;
}

export function spotAttenuation(angleCosine: number, outerConeCos: number, innerConeCos: number): number {
  const width = Math.max(EPSILON, innerConeCos - outerConeCos);
  const x = Math.min(1, Math.max(0, (angleCosine - outerConeCos) / width));
  return x * x * (3 - 2 * x);
}

export function broadenRoughnessForAngularRadius(roughness: number, angularRadiusDeg: number): number {
  const alpha = Math.max(0.001, roughness) ** 2;
  const sourceAlpha = Math.tan(Math.max(0, angularRadiusDeg) * PI / 180);
  return Math.sqrt(Math.sqrt(alpha * alpha + sourceAlpha * sourceAlpha));
}

export type GgxInputs = {
  dotNL: number;
  dotNV: number;
  dotNH: number;
  dotVH: number;
  dotTL: number;
  dotTV: number;
  dotTH: number;
  dotBL: number;
  dotBV: number;
  dotBH: number;
  alphaT: number;
  alphaB: number;
  f0?: number;
};

/** Scalar anisotropic GGX reference used by Vitest to validate the TSL implementation. */
export function anisotropicGgx(inputs: GgxInputs): number {
  const dotNL = Math.min(1, Math.max(0, inputs.dotNL));
  const dotNV = Math.min(1, Math.max(0, inputs.dotNV));
  const dotNH = Math.min(1, Math.max(0, inputs.dotNH));
  const dotVH = Math.min(1, Math.max(0, inputs.dotVH));
  const alphaT = Math.max(0.001, inputs.alphaT);
  const alphaB = Math.max(0.001, inputs.alphaB);
  const a2 = alphaT * alphaB;
  const vx = alphaB * inputs.dotTH;
  const vy = alphaT * inputs.dotBH;
  const vz = a2 * dotNH;
  const distribution = a2 / Math.max(EPSILON, PI * (vx * vx + vy * vy + vz * vz) ** 2);
  const gv = dotNL * Math.hypot(alphaT * inputs.dotTV, alphaB * inputs.dotBV, dotNV);
  const gl = dotNV * Math.hypot(alphaT * inputs.dotTL, alphaB * inputs.dotBL, dotNL);
  const visibility = 0.5 / Math.max(EPSILON, gv + gl);
  return fresnelSchlick(dotVH, inputs.f0) * visibility * distribution;
}
