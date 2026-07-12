import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { BoatSystems } from "../boat/BoatSystems";
import type { CockpitRig } from "../boat/CockpitRig";
import { InteractionSystem } from "./InteractionSystem";
import type { InputActionSnapshot } from "./types";

const frame = (primaryPressed = false): InputActionSnapshot => ({
  forward: 0, right: 0, vertical: 0, boost: false, stationPressed: false,
  primaryPressed, primaryReleased: false, primaryDown: primaryPressed,
  wheelSteps: 0, lookDeltaX: 0, lookDeltaY: 0, pointerLocked: true
});

function fakeRig(distance: number): CockpitRig {
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial());
  object.position.z = -distance;
  object.userData.cockpitHit = {
    kind: "control",
    target: { id: "cabinLight", label: "Luz de cabina", clickLabel: "Alternar" }
  };
  object.updateMatrixWorld(true);
  return {
    getRaycastObjects: () => [object],
    resolveHit: (candidate: THREE.Object3D) => candidate.userData.cockpitHit ?? null,
    setHighlighted: () => {}
  } as unknown as CockpitRig;
}

describe("InteractionSystem", () => {
  it("activates a centered nearby control", () => {
    const interaction = new InteractionSystem();
    const systems = new BoatSystems();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const result = interaction.update(camera, fakeRig(1), systems, frame(true), true);
    expect(result.hit?.kind).toBe("control");
    expect(systems.state.cabinLight).toBe(true);
  });

  it("rejects controls outside interaction range", () => {
    const interaction = new InteractionSystem();
    const systems = new BoatSystems();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const result = interaction.update(camera, fakeRig(2), systems, frame(true), true);
    expect(result.hit).toBeNull();
    expect(systems.state.cabinLight).toBe(false);
  });
});
