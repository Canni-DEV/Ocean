export const TWO_PI = Math.PI * 2;

export type SurfaceDerivatives = {
  dYdX: number;
  dYdZ: number;
  dXdX: number;
  dXdZ: number;
  dZdX: number;
  dZdZ: number;
};

export type LodWeights = {
  projectedPixels: number;
  geometry: number;
  normal: number;
  unresolved: number;
};

export type SlopeMoments = {
  meanX: number;
  meanZ: number;
  secondX: number;
  secondZ: number;
  crossXZ: number;
};

export type SlopeCovariance = {
  varianceX: number;
  varianceZ: number;
  covarianceXZ: number;
};

export function hash32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function deriveCascadeSeed(oceanSeed: number, cascadeIndex: number): number {
  return hash32((oceanSeed >>> 0) ^ Math.imul(cascadeIndex + 1, 0x9e3779b1));
}

function smoothstep01(value: number): number {
  const x = Math.min(1, Math.max(0, value));
  return x * x * (3 - 2 * x);
}

/** Complementary amplitude weights across a logarithmic crossover. */
export function overlapWeights(k: number, crossover: number, overlapRatio = 0.2): [number, number] {
  const halfWidth = Math.max(1e-6, Math.log1p(overlapRatio));
  const t = smoothstep01((Math.log(Math.max(k, 1e-9) / crossover) + halfWidth) / (halfWidth * 2));
  const angle = t * Math.PI * 0.5;
  return [Math.cos(angle), Math.sin(angle)];
}

export function projectedWavelengthPixels(
  wavelengthMeters: number,
  distanceMeters: number,
  verticalFovRad: number,
  renderHeightPixels: number
): number {
  const focalPixels = renderHeightPixels / (2 * Math.tan(verticalFovRad * 0.5));
  return (wavelengthMeters * focalPixels) / Math.max(distanceMeters, 0.01);
}

/** Distance from a camera to a point on the mean ocean plane. */
export function cameraSurfaceDistance(horizontalMeters: number, cameraHeightMeters: number): number {
  return Math.hypot(horizontalMeters, cameraHeightMeters);
}

/**
 * Variance assigned to sub-cascade wind ripples (roughly 8-45 cm). Keeping
 * this bounded is important: it is a normal/BRDF signal, not extra wave height.
 */
export function microSlopeVarianceForWind(windSpeedMs: number): number {
  // Cox-Munk-style mean-square slope fit for a wind-roughened sea, clamped
  // before severe-weather spray/whitecaps become the dominant phenomenon.
  return Math.min(0.09, Math.max(0.004, 0.003 + 0.00512 * Math.max(0, windSpeedMs)));
}

/**
 * Rain is rendered geometrically as particles. At the ocean surface it only
 * broadens the unresolved facet distribution very slightly; it must not add a
 * second animated normal field unrelated to the FFT.
 */
export function precipitationSlopeVariance(precipitation: number): number {
  return Math.min(1, Math.max(0, precipitation)) * 0.002;
}

export function slopeMoments(slopeX: number, slopeZ: number): SlopeMoments {
  return {
    meanX: slopeX,
    meanZ: slopeZ,
    secondX: slopeX * slopeX,
    secondZ: slopeZ * slopeZ,
    crossXZ: slopeX * slopeZ
  };
}

/** Exact box-filter reduction used by every 2x2 slope-moment mip. */
export function reduceSlopeMoments(samples: readonly SlopeMoments[]): SlopeMoments {
  if (samples.length === 0) throw new Error("Slope moment reduction requires at least one sample");
  const sum = samples.reduce<SlopeMoments>((result, sample) => ({
    meanX: result.meanX + sample.meanX,
    meanZ: result.meanZ + sample.meanZ,
    secondX: result.secondX + sample.secondX,
    secondZ: result.secondZ + sample.secondZ,
    crossXZ: result.crossXZ + sample.crossXZ
  }), { meanX: 0, meanZ: 0, secondX: 0, secondZ: 0, crossXZ: 0 });
  const inverseCount = 1 / samples.length;
  return {
    meanX: sum.meanX * inverseCount,
    meanZ: sum.meanZ * inverseCount,
    secondX: sum.secondX * inverseCount,
    secondZ: sum.secondZ * inverseCount,
    crossXZ: sum.crossXZ * inverseCount
  };
}

export function covarianceFromMoments(moments: SlopeMoments): SlopeCovariance {
  return {
    varianceX: Math.max(moments.secondX - moments.meanX * moments.meanX, 0),
    varianceZ: Math.max(moments.secondZ - moments.meanZ * moments.meanZ, 0),
    covarianceXZ: moments.crossXZ - moments.meanX * moments.meanZ
  };
}

export function slopeCovarianceEigenvalues(covariance: SlopeCovariance): [number, number] {
  const trace = covariance.varianceX + covariance.varianceZ;
  const delta = covariance.varianceX - covariance.varianceZ;
  const discriminant = Math.sqrt(Math.max(0, delta * delta + 4 * covariance.covarianceXZ ** 2));
  return [Math.max(0, (trace + discriminant) * 0.5), Math.max(0, (trace - discriminant) * 0.5)];
}

export function projectSlopeCovariancePsd(covariance: SlopeCovariance): SlopeCovariance {
  const varianceX = Math.max(0, covariance.varianceX);
  const varianceZ = Math.max(0, covariance.varianceZ);
  const limit = Math.sqrt(varianceX * varianceZ);
  return {
    varianceX,
    varianceZ,
    covarianceXZ: Math.min(limit, Math.max(-limit, covariance.covarianceXZ))
  };
}

export function windAlignedAnisotropyStrength(microSlopeVariance: number): number {
  const confidence = smoothstep01((Math.max(0, microSlopeVariance) - 0.006) / (0.04 - 0.006));
  // Cox-Munk directional split used by the renderer: 65% along wind, 35%
  // across wind. Keep the resulting lobe deliberately subtle.
  const directionality = (0.65 - 0.35) / (0.65 + 0.35);
  return Math.min(0.04, directionality * confidence * 0.12);
}

export function projectedMomentMip(texelFootprintPixels: number, maxMip: number): number {
  return Math.min(maxMip, Math.max(0, Math.log2(Math.max(texelFootprintPixels, 1))));
}

export function roughnessFromSlopeVariance(
  varianceX: number,
  varianceZ: number,
  coxMunkVariance = 0,
  screenVariance = 0
): number {
  const sigmaSquared = 0.5 * (varianceX + varianceZ) + coxMunkVariance + screenVariance;
  const alphaSquared = (0.08 ** 2) ** 2 + 0.22 * Math.max(0, sigmaSquared);
  return Math.min(0.48, Math.max(0.08, alphaSquared ** 0.25));
}

export function fresnelSchlickWater(cosIncident: number): number {
  const f0 = ((1.333 - 1) / (1.333 + 1)) ** 2;
  const cosine = Math.min(1, Math.max(0, cosIncident));
  return f0 + (1 - f0) * (1 - cosine) ** 5;
}

export function refractedCosine(cosIncident: number, incidentIor = 1, transmittedIor = 1.333): number {
  const cosine = Math.min(1, Math.max(0, cosIncident));
  const eta = incidentIor / transmittedIor;
  return Math.sqrt(Math.max(0, 1 - eta * eta * (1 - cosine * cosine)));
}

export function beerLambert(extinction: readonly [number, number, number], pathMeters: number): [number, number, number] {
  const path = Math.max(0, pathMeters);
  return extinction.map((coefficient) => Math.exp(-Math.max(0, coefficient) * path)) as [number, number, number];
}

export function spectralLodWeights(projectedPixels: number): LodWeights {
  // Without slope-moment mips we deliberately require a larger footprint
  // before retaining explicit signal. This is the conservative PR3 guardrail.
  const geometry = smoothstep01((projectedPixels - 2) / 2);
  const normal = smoothstep01((projectedPixels - 0.75) / 1.25);
  return {
    projectedPixels,
    geometry,
    normal,
    unresolved: 1 - normal
  };
}

export function normalFromDerivatives(d: SurfaceDerivatives): { x: number; y: number; z: number } {
  const tx = { x: 1 + d.dXdX, y: d.dYdX, z: d.dZdX };
  const tz = { x: d.dXdZ, y: d.dYdZ, z: 1 + d.dZdZ };
  const x = tz.y * tx.z - tz.z * tx.y;
  const y = tz.z * tx.x - tz.x * tx.z;
  const z = tz.x * tx.y - tz.y * tx.x;
  const invLength = 1 / Math.max(1e-12, Math.hypot(x, y, z));
  return { x: x * invLength, y: y * invLength, z: z * invLength };
}

export function pearsonCorrelation(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error("Correlation inputs must have equal non-zero length");
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= a.length;
  meanB /= b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  return covariance / Math.max(1e-12, Math.sqrt(varianceA * varianceB));
}
