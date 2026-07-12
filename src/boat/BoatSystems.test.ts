import { describe, expect, it } from "vitest";
import { BoatSystems } from "./BoatSystems";
import type { BoatPhysicsMetrics } from "./BoatPhysics";

const metrics: BoatPhysicsMetrics = {
  position: { x: 0, y: 0, z: 0 },
  speedMs: 5,
  headingDeg: -10,
  pitchDeg: 0,
  rollDeg: 0,
  throttle: 0,
  rudder: 0,
  capsized: false,
  waterHeightM: 0
};

describe("BoatSystems", () => {
  it("starts, produces bounded instruments and stops when fuel is exhausted", () => {
    const systems = new BoatSystems();
    systems.activate("engine");
    expect(systems.state.engine).toBe("starting");
    systems.update(1, 1, metrics, 0);
    expect(systems.state.engine).toBe("running");
    systems.update(4 * 60 * 60, 1, metrics, 0);
    systems.update(0.1, 0, metrics, 0);
    expect(systems.state.fuel).toBe(0);
    expect(systems.state.engine).toBe("off");
    expect(systems.state.instruments.headingDeg).toBe(350);
    expect(systems.state.instruments.speedKnots).toBeGreaterThan(9);
  });

  it("toggles electrical systems independently and clamps radio controls", () => {
    const systems = new BoatSystems();
    systems.activate("cabinLight");
    systems.activate("navigationLights");
    systems.activate("radioPowerVolume");
    systems.adjust("radioPowerVolume", -30);
    systems.adjust("radioTuning", 1);
    expect(systems.state.cabinLight).toBe(true);
    expect(systems.state.navigationLights).toBe(true);
    expect(systems.state.radio.powered).toBe(true);
    expect(systems.state.radio.volume).toBe(1);
    expect(systems.state.radio.station).toBe(2);
  });

  it("fills and pumps the bilge without leaving normalized bounds", () => {
    const systems = new BoatSystems();
    systems.update(1000, 0, metrics, 1);
    expect(systems.state.bilgeLevel).toBeGreaterThan(0);
    systems.activate("bilgePump");
    systems.update(1000, 0, metrics, 0);
    expect(systems.state.bilgeLevel).toBe(0);
  });
});
