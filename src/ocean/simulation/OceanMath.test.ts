import { describe, expect, it } from "vitest";
import {
  cameraSurfaceDistance,
  beerLambert,
  covarianceFromMoments,
  deriveCascadeSeed,
  fresnelSchlickWater,
  microSlopeVarianceForWind,
  normalFromDerivatives,
  overlapWeights,
  pearsonCorrelation,
  projectedWavelengthPixels,
  projectedMomentMip,
  reduceSlopeMoments,
  refractedCosine,
  roughnessFromSlopeVariance,
  slopeCovarianceEigenvalues,
  slopeMoments,
  spectralLodWeights,
} from "./OceanMath";

describe("ocean math", () => {
  it("derives deterministic independent cascade seeds", () => {
    expect(deriveCascadeSeed(1337, 0)).toBe(deriveCascadeSeed(1337, 0));
    expect(new Set([0, 1, 2].map((index) => deriveCascadeSeed(1337, index))).size).toBe(3);
  });

  it("conserves energy through overlap weights", () => {
    for (let i = 0; i <= 100; i += 1) {
      const k = Math.exp(Math.log(0.8) + (Math.log(1.2) - Math.log(0.8)) * (i / 100));
      const [a, b] = overlapWeights(k, 1, 0.2);
      expect(a * a + b * b).toBeCloseTo(1, 12);
    }
  });

  it("builds the exact tangent-cross normal", () => {
    const normal = normalFromDerivatives({
      dYdX: 0.2,
      dYdZ: -0.1,
      dXdX: 0,
      dXdZ: 0,
      dZdX: 0,
      dZdZ: 0
    });
    const expectedLength = Math.hypot(-0.2, 1, 0.1);
    expect(normal.x).toBeCloseTo(-0.2 / expectedLength, 10);
    expect(normal.y).toBeCloseTo(1 / expectedLength, 10);
    expect(normal.z).toBeCloseTo(0.1 / expectedLength, 10);
  });

  it("transfers subpixel wavelengths from geometry to roughness", () => {
    expect(spectralLodWeights(5)).toMatchObject({ geometry: 1, normal: 1, unresolved: 0 });
    expect(spectralLodWeights(0.1)).toMatchObject({ geometry: 0, normal: 0, unresolved: 1 });
    expect(projectedWavelengthPixels(1, 720, Math.PI / 2, 1440)).toBeCloseTo(1, 8);
  });

  it("includes camera altitude in projected LOD distance", () => {
    expect(cameraSurfaceDistance(0, 300)).toBe(300);
    expect(cameraSurfaceDistance(400, 300)).toBe(500);
  });

  it("keeps unresolved wind-ripple variance bounded and monotonic", () => {
    expect(microSlopeVarianceForWind(0)).toBeCloseTo(0.004, 8);
    expect(microSlopeVarianceForWind(10)).toBeGreaterThan(microSlopeVarianceForWind(4));
    expect(microSlopeVarianceForWind(40)).toBeCloseTo(0.09, 8);
  });

  it("reduces slope moments exactly and reconstructs a PSD covariance", () => {
    const reduced = reduceSlopeMoments([
      slopeMoments(-1, 0), slopeMoments(1, 0),
      slopeMoments(0, -2), slopeMoments(0, 2)
    ]);
    expect(reduced).toEqual({ meanX: 0, meanZ: 0, secondX: 0.5, secondZ: 2, crossXZ: 0 });
    const covariance = covarianceFromMoments(reduced);
    const [major, minor] = slopeCovarianceEigenvalues(covariance);
    expect(major).toBeCloseTo(2, 12);
    expect(minor).toBeCloseTo(0.5, 12);
    expect(minor).toBeGreaterThanOrEqual(0);
  });

  it("preserves mean and second moments through a complete mip reduction", () => {
    let level = Array.from({ length: 16 }, (_, index) => slopeMoments(Math.sin(index), Math.cos(index * 0.7)));
    const reference = reduceSlopeMoments(level);
    while (level.length > 1) {
      level = Array.from({ length: level.length / 4 }, (_, index) => reduceSlopeMoments(level.slice(index * 4, index * 4 + 4)));
    }
    for (const key of Object.keys(reference) as Array<keyof typeof reference>) {
      const relativeError = Math.abs(level[0][key] - reference[key]) / Math.max(Math.abs(reference[key]), 1e-8);
      expect(relativeError).toBeLessThan(0.01);
    }
  });

  it("selects projected mips and changes roughness continuously", () => {
    expect(projectedMomentMip(0.5, 8)).toBe(0);
    expect(projectedMomentMip(4, 8)).toBe(2);
    expect(projectedMomentMip(1024, 8)).toBe(8);
    const a = roughnessFromSlopeVariance(0.02, 0.018, 0.01, 0);
    const b = roughnessFromSlopeVariance(0.021, 0.019, 0.01, 0);
    expect(Math.abs(a - b)).toBeLessThan(0.03);
  });

  it("matches water Fresnel, Snell and Beer-Lambert references", () => {
    expect(fresnelSchlickWater(1)).toBeCloseTo(0.02037, 4);
    expect(fresnelSchlickWater(0)).toBeCloseTo(1, 12);
    expect(refractedCosine(1)).toBeCloseTo(1, 12);
    expect(refractedCosine(0)).toBeCloseTo(Math.sqrt(1 - (1 / 1.333) ** 2), 12);
    const transmission = beerLambert([0.1, 0.2, 0.3], 10);
    expect(transmission[0]).toBeCloseTo(Math.exp(-1), 12);
    expect(transmission[1]).toBeCloseTo(Math.exp(-2), 12);
    expect(transmission[2]).toBeCloseTo(Math.exp(-3), 12);
  });

  it("reports near-zero correlation for orthogonal samples", () => {
    expect(pearsonCorrelation([1, 0, -1, 0], [0, 1, 0, -1])).toBeCloseTo(0, 12);
  });

  it("keeps independently seeded cascade correlation below the acceptance threshold", () => {
    const sample = (seed: number): number[] => {
      let state = seed >>> 0;
      return Array.from({ length: 4096 }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
      });
    };
    const a = sample(deriveCascadeSeed(1337, 0));
    const b = sample(deriveCascadeSeed(1337, 1));
    expect(Math.abs(pearsonCorrelation(a, b))).toBeLessThan(0.05);
  });

  it("matches finite-difference normals for a horizontally displaced surface", () => {
    const errors: number[] = [];
    const point = (x: number, z: number) => ({
      x: x + 0.18 * Math.sin(x * 0.7) * Math.cos(z * 0.4),
      y: 0.65 * Math.sin(x * 0.7) + 0.22 * Math.cos(z * 1.1),
      z: z + 0.12 * Math.cos(x * 0.7) * Math.sin(z * 0.4)
    });
    const normalize = (v: { x: number; y: number; z: number }) => {
      const l = Math.hypot(v.x, v.y, v.z);
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    };
    for (let i = 0; i < 100; i += 1) {
      const x = -4 + i * 0.08;
      const z = -2 + i * 0.037;
      const d = {
        dYdX: 0.65 * 0.7 * Math.cos(x * 0.7),
        dYdZ: -0.22 * 1.1 * Math.sin(z * 1.1),
        dXdX: 0.18 * 0.7 * Math.cos(x * 0.7) * Math.cos(z * 0.4),
        dXdZ: -0.18 * 0.4 * Math.sin(x * 0.7) * Math.sin(z * 0.4),
        dZdX: -0.12 * 0.7 * Math.sin(x * 0.7) * Math.sin(z * 0.4),
        dZdZ: 0.12 * 0.4 * Math.cos(x * 0.7) * Math.cos(z * 0.4)
      };
      const analytic = normalFromDerivatives(d);
      const h = 1e-4;
      const px0 = point(x - h, z);
      const px1 = point(x + h, z);
      const pz0 = point(x, z - h);
      const pz1 = point(x, z + h);
      const tx = { x: px1.x - px0.x, y: px1.y - px0.y, z: px1.z - px0.z };
      const tz = { x: pz1.x - pz0.x, y: pz1.y - pz0.y, z: pz1.z - pz0.z };
      const numeric = normalize({
        x: tz.y * tx.z - tz.z * tx.y,
        y: tz.z * tx.x - tz.x * tx.z,
        z: tz.x * tx.y - tz.y * tx.x
      });
      const dot = Math.min(1, Math.max(-1, analytic.x * numeric.x + analytic.y * numeric.y + analytic.z * numeric.z));
      errors.push((Math.acos(dot) * 180) / Math.PI);
    }
    errors.sort((a, b) => a - b);
    const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    expect(mean).toBeLessThan(1.5);
    expect(errors[Math.floor(errors.length * 0.95)]).toBeLessThan(4);
  });
});
