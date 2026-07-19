import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  anisotropicGgx,
  broadenRoughnessForAngularRadius,
  distanceAttenuation,
  fresnelSchlick,
  henyeyGreenstein,
  localBeerLambert,
  spotAttenuation,
  waterF0
} from "./OceanLightingMath";
import { getOceanLightRole, tagOceanLight } from "./OceanLightRoles";
import { ATLANTIC_DEEP, clampOceanOpticsOverride, OCEAN_OPTICS_OVERRIDE_LIMITS } from "./OceanOpticsProfile";

describe("PR6B optical references", () => {
  it("computes the water Fresnel endpoints", () => {
    expect(waterF0()).toBeCloseTo(0.02037, 4);
    expect(fresnelSchlick(1)).toBeCloseTo(waterF0(), 7);
    expect(fresnelSchlick(0)).toBeCloseTo(1, 7);
  });

  it("normalizes Henyey-Greenstein over the sphere", () => {
    const steps = 20_000;
    let integral = 0;
    for (let index = 0; index < steps; index += 1) {
      const cosine = -1 + (index + 0.5) * (2 / steps);
      integral += henyeyGreenstein(cosine, ATLANTIC_DEEP.localPhaseG) * (2 / steps) * 2 * Math.PI;
    }
    expect(integral).toBeCloseTo(1, 3);
    expect(Number.isFinite(henyeyGreenstein(1, 0.85))).toBe(true);
  });

  it("applies Beer-Lambert per channel and clamps the local path", () => {
    expect(localBeerLambert([1, 0.5, 0], 10, 2)).toEqual([
      Math.exp(-2),
      Math.exp(-1),
      1
    ]);
    expect(localBeerLambert([1, 1, 1], -4)).toEqual([1, 1, 1]);
  });

  it("keeps distance and spotlight attenuation finite and continuous", () => {
    expect(Number.isFinite(distanceAttenuation(0, 50))).toBe(true);
    expect(distanceAttenuation(50, 50)).toBe(0);
    expect(distanceAttenuation(5, 50)).toBeGreaterThan(distanceAttenuation(10, 50));
    const outer = Math.cos(0.5);
    const inner = Math.cos(0.25);
    expect(spotAttenuation(outer, outer, inner)).toBe(0);
    expect(spotAttenuation(inner, outer, inner)).toBe(1);
    expect(spotAttenuation((outer + inner) * 0.5, outer, inner)).toBeCloseTo(0.5, 8);
  });

  it("broadens celestial roughness without sharpening the lobe", () => {
    const broadened = broadenRoughnessForAngularRadius(0.08, ATLANTIC_DEEP.celestialAngularRadiusDeg);
    expect(broadened).toBeGreaterThanOrEqual(0.08);
    expect(broadenRoughnessForAngularRadius(0.3, 0)).toBeCloseTo(0.3, 8);
  });

  it("keeps the anisotropic GGX reference finite and reciprocal", () => {
    const base = {
      dotNL: 0.76,
      dotNV: 0.63,
      dotNH: 0.91,
      dotVH: 0.84,
      dotTL: 0.42,
      dotTV: 0.25,
      dotTH: 0.34,
      dotBL: 0.31,
      dotBV: 0.51,
      dotBH: 0.28,
      alphaT: 0.08,
      alphaB: 0.16
    };
    const forward = anisotropicGgx(base);
    const reciprocal = anisotropicGgx({
      ...base,
      dotNL: base.dotNV,
      dotNV: base.dotNL,
      dotTL: base.dotTV,
      dotTV: base.dotTL,
      dotBL: base.dotBV,
      dotBV: base.dotBL
    });
    expect(Number.isFinite(forward)).toBe(true);
    expect(forward).toBeGreaterThanOrEqual(0);
    expect(reciprocal).toBeCloseTo(forward, 10);
  });

  it("matches the closed-form anisotropic GGX value at normal incidence", () => {
    const alphaT = 0.08;
    const alphaB = 0.16;
    const actual = anisotropicGgx({
      dotNL: 1,
      dotNV: 1,
      dotNH: 1,
      dotVH: 1,
      dotTL: 0,
      dotTV: 0,
      dotTH: 0,
      dotBL: 0,
      dotBV: 0,
      dotBH: 0,
      alphaT,
      alphaB
    });
    // At L=V=N: D=1/(PI*alphaT*alphaB), V=1/4 and F=F0.
    const expected = waterF0() / (4 * Math.PI * alphaT * alphaB);
    expect(actual).toBeCloseTo(expected, 10);
  });

  it("conserves directional energy when numerically integrated over the hemisphere", () => {
    const thetaSteps = 96;
    const phiSteps = 192;
    const dTheta = (Math.PI * 0.5) / thetaSteps;
    const dPhi = (Math.PI * 2) / phiSteps;
    let reflectedEnergy = 0;

    for (let thetaIndex = 0; thetaIndex < thetaSteps; thetaIndex += 1) {
      const theta = (thetaIndex + 0.5) * dTheta;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      for (let phiIndex = 0; phiIndex < phiSteps; phiIndex += 1) {
        const phi = (phiIndex + 0.5) * dPhi;
        const lightX = sinTheta * Math.cos(phi);
        const lightY = sinTheta * Math.sin(phi);
        const halfLength = Math.hypot(lightX, lightY, cosTheta + 1);
        const halfX = lightX / halfLength;
        const halfY = lightY / halfLength;
        const halfZ = (cosTheta + 1) / halfLength;
        const brdf = anisotropicGgx({
          dotNL: cosTheta,
          dotNV: 1,
          dotNH: halfZ,
          dotVH: halfZ,
          dotTL: lightX,
          dotTV: 0,
          dotTH: halfX,
          dotBL: lightY,
          dotBV: 0,
          dotBH: halfY,
          alphaT: 0.06,
          alphaB: 0.18
        });
        reflectedEnergy += brdf * cosTheta * sinTheta * dTheta * dPhi;
      }
    }

    expect(reflectedEnergy).toBeGreaterThan(0);
    expect(reflectedEnergy).toBeLessThanOrEqual(1.001);
  });
});

describe("ocean light roles and profile", () => {
  it("tags lights without creating parallel state", () => {
    const light = tagOceanLight(new THREE.PointLight(), "anchor");
    expect(getOceanLightRole(light)).toBe("anchor");
  });

  it("falls back to generic and warns once in development", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const light = new THREE.PointLight();
    expect(getOceanLightRole(light)).toBe("generic");
    expect(getOceanLightRole(light)).toBe("generic");
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it("keeps optical overrides inside their documented limits", () => {
    expect(clampOceanOpticsOverride(-10, OCEAN_OPTICS_OVERRIDE_LIMITS.phaseG)).toBe(0);
    expect(clampOceanOpticsOverride(10, OCEAN_OPTICS_OVERRIDE_LIMITS.phaseG)).toBe(0.85);
    expect(clampOceanOpticsOverride(Number.NaN, OCEAN_OPTICS_OVERRIDE_LIMITS.localOpticalPathM)).toBe(1);
  });

  it("does not hide celestial calibration in water-only default gains", () => {
    expect(ATLANTIC_DEEP.sunGlitterGain).toBe(1);
    expect(ATLANTIC_DEEP.moonGlitterGain).toBe(1);
    expect(ATLANTIC_DEEP.lunarSkyIrradianceFactor).toBeGreaterThan(0);
    expect(ATLANTIC_DEEP.lunarSkyIrradianceFactor).toBeLessThan(2);
  });
});
