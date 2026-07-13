import * as THREE from "three/webgpu";
import { MeshBVH } from "three-mesh-bvh";
import type { CockpitRig, CockpitHit } from "../boat/CockpitRig";
import type { InputActionSnapshot } from "./types";
import { BoatSystems } from "../boat/BoatSystems";

export type InteractionFrame = {
  controlHit: CockpitHit | null;
  controlObject: THREE.Object3D | null;
  controlDistance: number | null;
};

type AssistedCandidate = {
  hit: CockpitHit;
  object: THREE.Object3D;
  distance: number;
  angle: number;
};

const CONTROL_REACH_M = 4;
const ASSIST_ACQUIRE_RAD = THREE.MathUtils.degToRad(1.25);
const ASSIST_RETAIN_RAD = THREE.MathUtils.degToRad(1.5);
const ASSIST_SWITCH_ADVANTAGE_RAD = THREE.MathUtils.degToRad(0.25);
const SURFACE_EPSILON_M = 0.05;

export class InteractionSystem {
  private readonly raycaster = new THREE.Raycaster();
  private readonly screenCenter = new THREE.Vector2(0, 0);
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetDirection = new THREE.Vector3();
  private readonly occlusionRay = new THREE.Ray();
  private readonly inverseBoatMatrix = new THREE.Matrix4();
  private assistedObject: THREE.Object3D | null = null;

  update(
    camera: THREE.Camera,
    rig: CockpitRig | null,
    systems: BoatSystems,
    input: InputActionSnapshot,
    canInteract: boolean,
    boatRoot?: THREE.Object3D,
    collider?: MeshBVH | null
  ): InteractionFrame {
    if (!rig || !input.pointerLocked || !canInteract) {
      this.clear(rig, systems);
      return { controlHit: null, controlObject: null, controlDistance: null };
    }

    this.raycaster.setFromCamera(this.screenCenter, camera);
    this.raycaster.near = 0;
    this.raycaster.far = CONTROL_REACH_M;
    camera.getWorldPosition(this.cameraPosition);
    camera.getWorldDirection(this.cameraForward).normalize();

    const exact = this.resolveExact(rig, boatRoot, collider);
    const resolved = exact ?? this.resolveAssisted(rig, boatRoot, collider);
    this.assistedObject = exact ? null : resolved?.object ?? null;
    rig.setHighlighted(resolved?.object ?? null);

    if (resolved?.hit) {
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

    return {
      controlHit: resolved?.hit ?? null,
      controlObject: resolved?.object ?? null,
      controlDistance: resolved?.distance ?? null
    };
  }

  clear(rig: CockpitRig | null, systems: BoatSystems): void {
    rig?.setHighlighted(null);
    systems.setHorn(false);
    this.assistedObject = null;
  }

  private resolveExact(
    rig: CockpitRig,
    boatRoot?: THREE.Object3D,
    collider?: MeshBVH | null
  ): AssistedCandidate | null {
    const intersections = this.raycaster.intersectObjects(rig.getControlRaycastObjects(), false);
    for (const intersection of intersections) {
      if (intersection.distance > CONTROL_REACH_M) continue;
      const hit = rig.resolveHit(intersection.object);
      if (!hit) continue;
      if (this.isOccluded(intersection.point, intersection.distance, boatRoot, collider)) continue;
      return { hit, object: intersection.object, distance: intersection.distance, angle: 0 };
    }
    return null;
  }

  private resolveAssisted(
    rig: CockpitRig,
    boatRoot?: THREE.Object3D,
    collider?: MeshBVH | null
  ): AssistedCandidate | null {
    const candidates: AssistedCandidate[] = [];
    for (const object of rig.getControlRaycastObjects()) {
      const hit = rig.resolveHit(object);
      if (!hit) continue;
      object.getWorldPosition(this.targetPosition);
      this.targetDirection.subVectors(this.targetPosition, this.cameraPosition);
      const distance = this.targetDirection.length();
      if (distance <= 1e-5 || distance > CONTROL_REACH_M) continue;
      this.targetDirection.divideScalar(distance);
      const angle = Math.acos(THREE.MathUtils.clamp(this.cameraForward.dot(this.targetDirection), -1, 1));
      const limit = object === this.assistedObject ? ASSIST_RETAIN_RAD : ASSIST_ACQUIRE_RAD;
      if (angle > limit || this.isOccluded(this.targetPosition, distance, boatRoot, collider)) continue;
      candidates.push({ hit, object, distance, angle });
    }
    candidates.sort((a, b) => a.angle - b.angle || a.distance - b.distance);
    const best = candidates[0] ?? null;
    if (!best || !this.assistedObject || best.object === this.assistedObject) return best;
    const previous = candidates.find((candidate) => candidate.object === this.assistedObject);
    if (previous && previous.angle - best.angle < ASSIST_SWITCH_ADVANTAGE_RAD) return previous;
    return best;
  }

  private isOccluded(
    target: THREE.Vector3,
    targetDistance: number,
    boatRoot?: THREE.Object3D,
    collider?: MeshBVH | null
  ): boolean {
    if (!boatRoot || !collider) return false;
    boatRoot.updateMatrixWorld(true);
    this.inverseBoatMatrix.copy(boatRoot.matrixWorld).invert();
    this.targetDirection.subVectors(target, this.cameraPosition).normalize();
    this.occlusionRay.set(this.cameraPosition, this.targetDirection).applyMatrix4(this.inverseBoatMatrix);
    const blocker = collider.raycastFirst(this.occlusionRay);
    return blocker !== null && blocker.distance < targetDistance - SURFACE_EPSILON_M;
  }
}
