import { describe, expect, it } from "vitest";
import { DEFAULT_DEBUG_SETTINGS } from "../state/debugStore";
import {
  applyOceanValidationSettings,
  OCEAN_VALIDATION_SCENARIOS,
  readOceanValidationScenario
} from "./OceanValidationHarness";

describe("ocean validation harness", () => {
  it("defines the twelve baseline and three optical validation scenarios", () => {
    expect(OCEAN_VALIDATION_SCENARIOS).toHaveLength(15);
    expect(new Set(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).size).toBe(15);
    expect(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).toContain("aerial-storm-300");
    expect(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).toContain("optical-bow-low-sun");
  });

  it("applies deterministic settings and query overrides", () => {
    const scenario = readOceanValidationScenario("?oceanValidation=bow-high&foam=0&seed=99");
    expect(scenario).not.toBeNull();
    const settings = applyOceanValidationSettings(DEFAULT_DEBUG_SETTINGS, scenario!);
    expect(settings).toMatchObject({
      quality: "high",
      weatherPreset: "clear",
      beaufort: 8,
      oceanSeed: 99,
      showFoam: false,
      seaStateControlMode: "manual-overrides"
    });
  });
});
