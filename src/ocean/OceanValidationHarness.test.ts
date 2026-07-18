import { describe, expect, it } from "vitest";
import { DEFAULT_DEBUG_SETTINGS } from "../state/debugStore";
import {
  applyOceanValidationSettings,
  OCEAN_VALIDATION_SCENARIOS,
  readOceanValidationScenario
} from "./OceanValidationHarness";

describe("ocean validation harness", () => {
  it("defines unique baseline, optical and PR6B validation scenarios", () => {
    expect(OCEAN_VALIDATION_SCENARIOS).toHaveLength(29);
    expect(new Set(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).size).toBe(29);
    expect(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).toContain("aerial-storm-300");
    expect(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).toContain("optical-bow-low-sun");
    expect(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).toContain("pr6b-storm-fixed-lightning");
    expect(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).toContain("pr6b-horizon-pan");
    expect(OCEAN_VALIDATION_SCENARIOS.map((scenario) => scenario.id)).toContain("pr6b-sun-column");
  });

  it("applies deterministic settings and query overrides", () => {
    const scenario = readOceanValidationScenario(
      "?oceanValidation=bow-high&foam=0&seed=99&quality=medium&hour=7.05&anisotropy=0&slopeMip=0"
    );
    expect(scenario).not.toBeNull();
    const settings = applyOceanValidationSettings(DEFAULT_DEBUG_SETTINGS, scenario!);
    expect(settings).toMatchObject({
      quality: "medium",
      weatherPreset: "clear",
      beaufort: 8,
      oceanSeed: 99,
      worldTimeHours: 7.05,
      showFoam: false,
      seaStateControlMode: "manual-overrides",
      oceanAnisotropyEnabled: false,
      oceanSlopeMipOverride: 0
    });
  });

  it("overrides light and lightning state without changing the scenario registry", () => {
    const scenario = readOceanValidationScenario(
      "?oceanValidation=pr6b-rail-night-off&lights=work,anchor&lightning=fixed"
    );
    expect(scenario?.lights).toEqual({
      work: true,
      flashlight: false,
      cabin: false,
      navigation: false,
      anchor: true
    });
    expect(scenario?.lightning).toBe("fixed");
    expect(OCEAN_VALIDATION_SCENARIOS.find((entry) => entry.id === "pr6b-rail-night-off")?.lights.work).toBe(false);
  });
});
