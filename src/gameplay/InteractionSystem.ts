import * as THREE from "three/webgpu";
import type { CockpitRig, CockpitHit } from "../boat/CockpitRig";
import type { InputActionSnapshot } from "./types";
import { BoatSystems } from "../boat/BoatSystems";

export type InteractionFrame = {
  hit: CockpitHit | null;
  object: THREE.Object3D | null;
  distance: number | null;
};

const CONTROL_REACH_M = 4;
const STATION_REACH_M = 1.25;

export class InteractionSystem {
  private readonly raycaster = new THREE.Raycaster();
  private readonly screenCenter = new THREE.Vector2(0, 0);

  update(
    camera: THREE.Camera,
    rig: CockpitRig | null,
    systems: BoatSystems,
    input: InputActionSnapshot,
    canInteract: boolean
  ): InteractionFrame {
    if (!rig || !input.pointerLocked || !canInteract) {
      rig?.setHighlighted(null);
      systems.setHorn(false);
      return { hit: null, object: null, distance: null };
    }

    this.raycaster.setFromCamera(this.screenCenter, camera);
    this.raycaster.near = 0;
    this.raycaster.far = CONTROL_REACH_M;
    const intersections = this.raycaster.intersectObjects(rig.getRaycastObjects(), false);
    let resolved: InteractionFrame = { hit: null, object: null, distance: null };
    for (const intersection of intersections) {
      const hit = rig.resolveHit(intersection.object);
      if (!hit) continue;
      const reach = hit.kind === "station" ? STATION_REACH_M : CONTROL_REACH_M;
      if (intersection.distance > reach) continue;
      resolved = { hit, object: intersection.object, distance: intersection.distance };
      break;
    }

    rig.setHighlighted(resolved.object);
    if (resolved.hit?.kind === "control") {
      const id = resolved.hit.target.id;
      if (id === "horn") {
        systems.setHorn(input.primaryDown);
      } else {
        systems.setHorn(false);
        if (input.primaryPressed) systems.activate(id);
        if (input.wheelSteps !== 0) systems.adjust(id, input.wheelSteps);
      }
    } else {
      systems.setHorn(false);
    }
    return resolved;
  }

  clear(rig: CockpitRig | null, systems: BoatSystems): void {
    rig?.setHighlighted(null);
    systems.setHorn(false);
  }
}
