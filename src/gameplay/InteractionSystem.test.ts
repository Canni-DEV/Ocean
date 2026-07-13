import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { MeshBVH } from "three-mesh-bvh";
import { BoatSystems } from "../boat/BoatSystems";
import { COCKPIT_SWITCH_BANK_LAYOUT, type CockpitRig } from "../boat/CockpitRig";
import { InteractionSystem } from "./InteractionSystem";
import type { InputActionSnapshot } from "./types";

const frame = (primaryPressed = false): InputActionSnapshot => ({
  forward: 0, right: 0, vertical: 0, boost: false, interactPressed: false, flashlightPressed: false,
  primaryPressed, primaryReleased: false, primaryDown: primaryPressed,
  wheelSteps: 0, lookDeltaX: 0, lookDeltaY: 0, pointerLocked: true
});

function fakeRig(distance: number, x = 0, size = 0.2): CockpitRig {
  const object = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial());
  object.position.set(x, 0, -distance);
  object.userData.cockpitHit = {
    kind: "control",
    target: { id: "cabinLight", label: "Luz de cabina", clickLabel: "Alternar" }
  };
  object.updateMatrixWorld(true);
  return {
    getControlRaycastObjects: () => [object],
    resolveHit: (candidate: THREE.Object3D) => candidate.userData.cockpitHit ?? null,
    setHighlighted: () => {}
  } as unknown as CockpitRig;
}

describe("InteractionSystem", () => {
  it("keeps the lower switch bank inside the original GLB plate", () => {
    const layout = COCKPIT_SWITCH_BANK_LAYOUT;
    expect(layout.switchX).toBeGreaterThan(-0.3747);
    expect(layout.switchX).toBeLessThan(-0.33);
    expect(Math.min(...layout.rowY)).toBeGreaterThan(1.4406);
    expect(Math.max(...layout.rowY)).toBeLessThan(1.6046);
    expect(layout.indicatorX).toBeCloseTo(-0.2306, 3);
    const minimumRowSpacing = Math.min(
      ...layout.rowY.slice(0, -1).map((row, index) => row - layout.rowY[index + 1])
    );
    expect(layout.hitboxSize[1]).toBeLessThan(minimumRowSpacing);
  });

  it("activates a centered nearby control", () => {
    const interaction = new InteractionSystem();
    const systems = new BoatSystems();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const result = interaction.update(camera, fakeRig(3.8), systems, frame(true), true);
    expect(result.controlHit?.kind).toBe("control");
    expect(systems.state.cabinLight).toBe(true);
  });

  it("rejects controls outside interaction range", () => {
    const interaction = new InteractionSystem();
    const systems = new BoatSystems();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const result = interaction.update(camera, fakeRig(4.3), systems, frame(true), true);
    expect(result.controlHit).toBeNull();
    expect(systems.state.cabinLight).toBe(false);
  });

  it("acquires a tiny control within the subtle angular assist cone", () => {
    const interaction = new InteractionSystem();
    const systems = new BoatSystems();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const result = interaction.update(camera, fakeRig(3.8, Math.tan(THREE.MathUtils.degToRad(1)) * 3.8, 0.005), systems, frame(), true);
    expect(result.controlHit?.target.id).toBe("cabinLight");
  });

  it("rejects a control hidden behind the boat collider", () => {
    const interaction = new InteractionSystem();
    const systems = new BoatSystems();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const blockerGeometry = new THREE.BoxGeometry(2, 2, 0.1).translate(0, 0, -2);
    const collider = new MeshBVH(blockerGeometry);
    const boatRoot = new THREE.Object3D();
    boatRoot.updateMatrixWorld(true);
    const result = interaction.update(camera, fakeRig(3.8), systems, frame(), true, boatRoot, collider);
    expect(result.controlHit).toBeNull();
    blockerGeometry.dispose();
  });
});
