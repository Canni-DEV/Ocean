import { describe, expect, it } from "vitest";
import {
  beerLambert,
  contactOcclusion,
  earthCurvatureDrop,
  fresnelSchlick,
  geometricHorizonDistance,
  refractionValidity,
  snellRefract,
  ssrConfidence,
  temporalHistoryWeight
} from "./OceanScreenSpaceMath";

describe("PR6C screen-space math", () => {
  it("matches Earth curvature and the 300 m horizon", () => {
    expect(earthCurvatureDrop(80_000)).toBeCloseTo(502.28, 1);
    expect(geometricHorizonDistance(300)).toBeGreaterThan(61_000);
    expect(geometricHorizonDistance(300)).toBeLessThan(63_000);
  });

  it("keeps Fresnel physical and finite", () => {
    expect(fresnelSchlick(1)).toBeCloseTo(0.02037, 5);
    expect(fresnelSchlick(0)).toBeCloseTo(1, 5);
  });

  it("refracts into water and applies Beer-Lambert per channel", () => {
    const refracted = snellRefract({ x: 0.3, y: -0.95, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(refracted).not.toBeNull();
    expect(refracted!.y).toBeLessThan(0);
    const t = beerLambert({ x: 0.32, y: 0.075, z: 0.028 }, 4);
    expect(t.x).toBeLessThan(t.y);
    expect(t.y).toBeLessThan(t.z);
  });

  it("rejects invalid refraction and bounds physical contact", () => {
    expect(refractionValidity(1, -1, { x: 0.5, y: 0.5 })).toBe(0);
    expect(refractionValidity(1, 2, { x: 0.5, y: 0.5 })).toBeGreaterThan(0.9);
    expect(refractionValidity(1, 2, { x: -0.1, y: 0.5 })).toBe(0);
    expect(contactOcclusion(0.01, 2)).toBeGreaterThan(0.2);
    expect(contactOcclusion(1, 2)).toBe(0);
  });

  it("reduces confidence and history on edges, roughness and disocclusion", () => {
    const stable = ssrConfidence({ edgeDistance: 0.2, hitErrorM: 0, thicknessM: 0.2,
      rayDistanceM: 10, maxDistanceM: 120, roughness: 0.12 });
    const rough = ssrConfidence({ edgeDistance: 0.2, hitErrorM: 0, thicknessM: 0.2,
      rayDistanceM: 10, maxDistanceM: 120, roughness: 0.48 });
    expect(stable).toBeGreaterThan(0.9);
    expect(rough).toBe(0);
    expect(temporalHistoryWeight(0.88, stable, 0, 1, 0)).toBeCloseTo(0.88, 4);
    expect(temporalHistoryWeight(0.88, stable, 1, 1, 0)).toBe(0);
  });
});
