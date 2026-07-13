import { describe, expect, it } from "vitest";
import { BoatController } from "../boat/BoatController";
import { FishingController } from "../fishing/FishingController";
import { FirstPersonController } from "../player/FirstPersonController";
import * as THREE from "three/webgpu";
import type { InputActionSnapshot } from "./types";

const input = (forward = 0, right = 0): InputActionSnapshot => ({
  forward,
  right,
  vertical: 0,
  boost: false,
  interactPressed: false,
  flashlightPressed: false,
  primaryPressed: false,
  primaryReleased: false,
  primaryDown: false,
  wheelSteps: 0,
  lookDeltaX: 0,
  lookDeltaY: 0,
  pointerLocked: true
});

describe("context-owned controllers", () => {
  it("changes persistent throttle only while the helm owns WASD", () => {
    const controller = new BoatController();
    expect(controller.update(1, input(1), false, true).throttle).toBe(0);
    expect(controller.update(1, input(1), true, true).throttle).toBeCloseTo(0.6);
    expect(controller.update(1, input(), false, true).throttle).toBeCloseTo(0.6);
    controller.neutralize();
    expect(controller.update(0.1, input(), false, true).throttle).toBe(0);
  });

  it("moves fishing controls only in the fishing station", () => {
    const controller = new FishingController();
    const idle = controller.update(1, input(1, 1), false);
    expect(idle.reel).toBe(0);
    expect(idle.boom).toBe(0);
    const active = controller.update(0.1, input(1, -1), true);
    expect(active.boom).toBeGreaterThan(0);
    expect(active.reel).toBeGreaterThan(0);
  });

  it("restores the last safe walking pose after leaving a station", () => {
    const controller = new FirstPersonController(
      new THREE.PerspectiveCamera(),
      {} as HTMLCanvasElement
    );
    controller.localPosition.set(1, 0.75, 2);
    controller.enterStation();
    controller.localPosition.set(0, -3, 0);
    controller.exitStation();
    expect(controller.localPosition.toArray()).toEqual([1, 0.75, 2]);
  });
});
