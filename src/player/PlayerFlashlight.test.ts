import { describe, expect, it } from "vitest";
import { FlashlightBattery, type FlashlightConfig } from "./PlayerFlashlight";

const CONFIG: FlashlightConfig = {
  capacitySeconds: 300,
  rechargeSeconds: 60,
  intensityCd: 1100,
  rangeM: 55,
  halfAngleDeg: 16,
  penumbra: 0.5,
  lowThreshold: 0.15,
  criticalThreshold: 0.05
};

describe("FlashlightBattery", () => {
  it("consumes real elapsed time, pauses, and recharges only when allowed", () => {
    const battery = new FlashlightBattery(CONFIG);
    expect(battery.toggle()).toBe(true);
    battery.consumeCue();
    battery.update(150, false, false);
    expect(battery.getState().charge01).toBeCloseTo(0.5);
    battery.update(20, false, true);
    expect(battery.getState().charge01).toBeCloseTo(0.5);
    battery.toggle();
    battery.consumeCue();
    battery.update(30, false, false);
    expect(battery.getState().charge01).toBeCloseTo(0.5);
    battery.update(30, true, false);
    expect(battery.getState().charge01).toBeCloseTo(1);
    expect(battery.consumeCue()).toBe("charged");
  });

  it("turns off at empty and rejects an empty toggle", () => {
    const battery = new FlashlightBattery(CONFIG);
    battery.toggle();
    battery.consumeCue();
    battery.update(300, false, false);
    expect(battery.getState()).toMatchObject({ powered: false, charge01: 0, level: "empty" });
    expect(battery.consumeCue()).toBe("empty");
    expect(battery.toggle()).toBe(false);
    expect(battery.consumeCue()).toBe("empty");
  });

  it("preserves normalized charge when tuning capacity", () => {
    const battery = new FlashlightBattery(CONFIG);
    battery.toggle();
    battery.consumeCue();
    battery.update(75, false, false);
    const before = battery.getState().charge01;
    battery.applyConfig({ ...CONFIG, capacitySeconds: 600 });
    expect(battery.getState().charge01).toBe(before);
  });

  it("reports low and critical levels with reduced but deterministic output", () => {
    const battery = new FlashlightBattery(CONFIG);
    battery.toggle();
    battery.consumeCue();
    battery.update(270, false, false);
    expect(battery.getState().level).toBe("low");
    expect(battery.getIntensityFactor()).toBeLessThan(1);
    battery.update(16, false, false);
    expect(battery.getState().level).toBe("critical");
    expect(battery.getIntensityFactor()).toBeGreaterThanOrEqual(0);
    expect(battery.getIntensityFactor()).toBeLessThanOrEqual(0.7);
  });
});
