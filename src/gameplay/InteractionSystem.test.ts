import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { MeshBVH } from "three-mesh-bvh";
import { BoatSystems } from "../boat/BoatSystems";
import {
  COCKPIT_ACCESSORY_BANK_LAYOUT,
  COCKPIT_RADIO_FREQUENCY_LAYOUT,
  COCKPIT_RADIO_KNOB_LAYOUT,
  COCKPIT_SWITCH_BANK_LAYOUT,
  type CockpitRig
} from "../boat/CockpitRig";
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

  it("maps the four accessory controls to separated right-hand push-buttons", () => {
    const layout = COCKPIT_ACCESSORY_BANK_LAYOUT;
    expect(layout.ids).toEqual(["anchorLight", "instrumentLights", "wipers", "bilgePump"]);
    expect(layout.buttonPositions).toHaveLength(layout.ids.length);
    const minimumSpacing = Math.min(
      ...layout.buttonPositions.slice(1).map((position, index) =>
        position[0] - layout.buttonPositions[index][0]
      )
    );
    expect(layout.hitboxSize[0]).toBeLessThan(minimumSpacing);
    expect(Math.hypot(...layout.surfaceNormal)).toBeCloseTo(1, 5);
    expect(layout.surfaceNormal[1]).toBeGreaterThan(0.9);
    expect(layout.surfaceNormal[2]).toBeGreaterThan(0);
    expect(layout.indicatorRadius).toBeLessThan(layout.hoverInnerRadius);
    expect(layout.hoverInnerRadius).toBeLessThan(layout.hoverOuterRadius);
  });

  it("maps both radio controls to the original coplanar GLB knobs", () => {
    const layout = COCKPIT_RADIO_KNOB_LAYOUT;
    expect(layout.ids).toEqual(["radioPowerVolume", "radioTuning"]);
    expect(layout.positions).toHaveLength(layout.ids.length);
    const [left, right] = layout.positions;
    expect(left[0]).toBeLessThan(right[0]);
    expect(left[1]).toBeCloseTo(right[1], 5);
    expect(left[2]).toBeCloseTo(right[2], 5);
    expect(layout.hitboxSize[0]).toBeLessThan(right[0] - left[0]);
    expect(layout.surfaceNormal).toEqual([0, 0, 1]);
    expect(Math.hypot(...layout.surfaceNormal)).toBeCloseTo(1, 5);
    expect(layout.indicatorRadius).toBeLessThan(layout.hoverInnerRadius);
    expect(layout.hoverInnerRadius).toBeLessThan(layout.hoverOuterRadius);
  });

  it("maps five passive station lights to the original radio frequency row", () => {
    const layout = COCKPIT_RADIO_FREQUENCY_LAYOUT;
    expect(layout.positions).toHaveLength(6);
    expect(layout.stationCount).toBe(6);
    expect(layout.stationCount).toBeLessThanOrEqual(layout.positions.length);
    const activePositions = layout.positions.slice(0, layout.stationCount);
    expect(new Set(activePositions.map((position) => position[1])).size).toBe(1);
    expect(new Set(activePositions.map((position) => position[2])).size).toBe(1);
    const minimumSpacing = Math.min(
      ...activePositions.slice(1).map((position, index) => position[0] - activePositions[index][0])
    );
    expect(layout.indicatorRadius * 2).toBeLessThan(minimumSpacing);
  });

  it("activates a centered nearby control", () => {
    const interaction = new InteractionSystem();
    const systems = new BoatSystems();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const result = interaction.update(camera, fakeRig(3.8), systems, frame(true), true);
    expect(result.controlHit?.kind).toBe("control");
    expect(result.activatedControl).toBe("cabinLight");
    expect(systems.state.cabinLight).toBe(true);
  });

  it("reports activation once on press instead of repeating while held", () => {
    const interaction = new InteractionSystem();
    const systems = new BoatSystems();
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const rig = fakeRig(3.8);
    const pressed = interaction.update(camera, rig, systems, frame(true), true);
    const held = interaction.update(
      camera,
      rig,
      systems,
      { ...frame(false), primaryDown: true },
      true
    );
    expect(pressed.activatedControl).toBe("cabinLight");
    expect(held.activatedControl).toBeNull();
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
