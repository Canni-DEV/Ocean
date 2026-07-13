import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import type { CockpitRig, StationZoneDescriptor } from "../boat/CockpitRig";
import { StationInteractionSystem } from "./StationInteractionSystem";

function rigWithZones(zones: StationZoneDescriptor[]): CockpitRig {
  return { getStationZones: () => zones } as unknown as CockpitRig;
}

function zone(id: "helm" | "fishing", center: THREE.Vector3, target: THREE.Vector3): StationZoneDescriptor {
  const volume = new THREE.Object3D();
  volume.position.copy(center);
  const facingTarget = new THREE.Object3D();
  facingTarget.position.copy(target);
  volume.updateMatrixWorld(true);
  facingTarget.updateMatrixWorld(true);
  return { id, volume, facingTarget, size: new THREE.Vector3(2, 2, 2) };
}

describe("StationInteractionSystem", () => {
  it("selects an in-zone station only while facing its 120 degree cone", () => {
    const system = new StationInteractionSystem();
    const camera = new THREE.PerspectiveCamera();
    const helm = zone("helm", new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld(true);
    expect(system.update(camera, rigWithZones([helm]), true)?.station).toBe("helm");

    camera.lookAt(1, 0, 0);
    camera.updateMatrixWorld(true);
    expect(system.update(camera, rigWithZones([helm]), true)).toBeNull();
  });

  it("retains a station through the ten-centimeter exit margin", () => {
    const system = new StationInteractionSystem();
    const camera = new THREE.PerspectiveCamera();
    const helm = zone("helm", new THREE.Vector3(), new THREE.Vector3(0, 0, -2));
    const rig = rigWithZones([helm]);
    camera.position.set(0.95, 0, 0);
    camera.lookAt(0, 0, -2);
    camera.updateMatrixWorld(true);
    expect(system.update(camera, rig, true)?.station).toBe("helm");
    camera.position.x = 1.05;
    camera.lookAt(0, 0, -2);
    camera.updateMatrixWorld(true);
    expect(system.update(camera, rig, true)?.station).toBe("helm");
    camera.position.x = 1.12;
    camera.updateMatrixWorld(true);
    expect(system.update(camera, rig, true)).toBeNull();
  });

  it("chooses the best aligned station before distance", () => {
    const system = new StationInteractionSystem();
    const camera = new THREE.PerspectiveCamera();
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld(true);
    const helm = zone("helm", new THREE.Vector3(), new THREE.Vector3(-0.4, 0, -1));
    const fishing = zone("fishing", new THREE.Vector3(), new THREE.Vector3(0, 0, -2));
    expect(system.update(camera, rigWithZones([helm, fishing]), true)?.station).toBe("fishing");
  });
});
