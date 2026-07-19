import { describe, expect, it } from "vitest";
import { DEFAULT_DEBUG_SETTINGS } from "./debugStore";
import { WEATHER_PRESETS } from "./weather";
import { beaufortToWindSpeed, buildSeaState, windSpeedToBeaufort } from "./seaState";

describe("sea-state source precedence", () => {
  it("round-trips the effective Beaufort value shown by telemetry", () => {
    for (const beaufort of [0, 3.5, 8, 12]) {
      expect(windSpeedToBeaufort(beaufortToWindSpeed(beaufort))).toBeCloseTo(beaufort, 10);
    }
  });

  it("uses weather wind and swell by default", () => {
    const weather = WEATHER_PRESETS.storm;
    const state = buildSeaState(weather, { ...DEFAULT_DEBUG_SETTINGS, seaStateControlMode: "weather" });
    expect(state.windSpeedMs).toBe(weather.windSpeedMs);
    expect(state.swellAmount).toBe(weather.swellStrength);
    expect(state.swellDirectionRad).toBe(weather.swellDirectionRad);
  });

  it("uses explicit manual overrides without replacing wind direction", () => {
    const weather = WEATHER_PRESETS.clear;
    const settings = {
      ...DEFAULT_DEBUG_SETTINGS,
      seaStateControlMode: "manual-overrides" as const,
      beaufort: 7,
      swellAmount: 0.8,
      swellDirectionDeg: 210,
      oceanSeed: 42
    };
    const state = buildSeaState(weather, settings);
    expect(state.windSpeedMs).toBeCloseTo(beaufortToWindSpeed(7));
    expect(state.windDirectionRad).toBe(weather.windDirectionRad);
    expect(state.swellAmount).toBe(0.8);
    expect(state.swellDirectionRad).toBeCloseTo((210 * Math.PI) / 180);
    expect(state.seed).toBe(42);
  });
});
