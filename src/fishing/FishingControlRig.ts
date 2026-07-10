import * as THREE from "three/webgpu";
import {
  BOOM_ELEVATION_MAX_RAD,
  BOOM_ELEVATION_MIN_RAD,
  FishingBoomAssemblyRig
} from "./FishingBoomAssemblyRig";

const PULLEY_OBJECT_NAMES = ["Cylinder.013", "Cylinder.017"] as const;
const ROPE_LEVER_OBJECT_NAME = "Cylinder.014";
const BOOM_LEVER_OBJECT_NAME = "Cylinder.015";

const MAX_ROPE_LEVER_ROTATION_RAD = THREE.MathUtils.degToRad(32);
const MAX_BOOM_LEVER_ROTATION_RAD = THREE.MathUtils.degToRad(36);
const ROPE_LEVER_ROTATION_AXIS = new THREE.Vector3(1, 0, 0);
const BOOM_LEVER_ROTATION_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Runtime rig for the bow fishing controls embedded in the flattened boat GLB.
 */
export class FishingControlRig {
  readonly pulleySocket: THREE.Object3D;

  private readonly ropeLeverPivot: THREE.Group;
  private readonly boomLeverPivot: THREE.Group;
  private readonly boomAssembly: FishingBoomAssemblyRig | null;

  private constructor(
    pulleySocket: THREE.Object3D,
    ropeLeverPivot: THREE.Group,
    boomLeverPivot: THREE.Group,
    boomAssembly: FishingBoomAssemblyRig | null
  ) {
    this.pulleySocket = pulleySocket;
    this.ropeLeverPivot = ropeLeverPivot;
    this.boomLeverPivot = boomLeverPivot;
    this.boomAssembly = boomAssembly;
  }

  static bind(model: THREE.Object3D): FishingControlRig | null {
    const boomAssembly = FishingBoomAssemblyRig.apply(model);

    const pulley = findPulleyObject(model);
    const ropeLever = findSourceObject(model, ROPE_LEVER_OBJECT_NAME);
    const boomLever = findSourceObject(model, BOOM_LEVER_OBJECT_NAME);

    if (!pulley || !ropeLever || !boomLever) {
      console.warn(
        "Fishing control rig could not bind: expected pulley and bow lever nodes are missing.",
        { pulley: !!pulley, ropeLever: !!ropeLever, boomLever: !!boomLever }
      );
      return null;
    }

    model.updateMatrixWorld(true);

    const pulleySocket = createPulleySocket(pulley);

    const ropeLeverPivot = createLeverPivot(model, ropeLever, "Fishing rope lever pivot");
    ropeLeverPivot.attach(ropeLever);

    const boomLeverPivot = createLeverPivot(model, boomLever, "Fishing boom lever pivot");
    boomLeverPivot.attach(boomLever);

    markExcludedFromCollider(ropeLever);
    markExcludedFromCollider(boomLever);

    model.updateMatrixWorld(true);
    return new FishingControlRig(pulleySocket, ropeLeverPivot, boomLeverPivot, boomAssembly);
  }

  update(reel: number, boomElevationRad: number): void {
    const clampedReel = THREE.MathUtils.clamp(reel, -1, 1);
    this.ropeLeverPivot.quaternion.setFromAxisAngle(
      ROPE_LEVER_ROTATION_AXIS,
      -clampedReel * MAX_ROPE_LEVER_ROTATION_RAD
    );

    this.boomAssembly?.setElevation(boomElevationRad);

    const boomSpan = BOOM_ELEVATION_MAX_RAD - BOOM_ELEVATION_MIN_RAD;
    const boomNormalized = boomSpan > 0
      ? (boomElevationRad - BOOM_ELEVATION_MIN_RAD) / boomSpan
      : 0;
    const boomLeverAngle = (boomNormalized * 2 - 1) * MAX_BOOM_LEVER_ROTATION_RAD;
    this.boomLeverPivot.quaternion.setFromAxisAngle(
      BOOM_LEVER_ROTATION_AXIS,
      -boomLeverAngle
    );
  }
}

function findPulleyObject(model: THREE.Object3D): THREE.Object3D | null {
  for (const name of PULLEY_OBJECT_NAMES) {
    const match = findSourceObject(model, name);
    if (match) return match;
  }

  let best: THREE.Object3D | null = null;
  let bestY = Number.NEGATIVE_INFINITY;
  model.traverse((object) => {
    const originalName = (object.userData?.name as string | undefined) ?? object.name;
    if (!originalName.startsWith("Cylinder.")) return;
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    if (center.y > bestY && center.z < -2) {
      bestY = center.y;
      best = object;
    }
  });
  return best;
}

function findSourceObject(root: THREE.Object3D, sourceName: string): THREE.Object3D | null {
  let match: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (match) return;
    const originalName = (object.userData?.name as string | undefined) ?? object.name;
    if (originalName === sourceName) {
      match = object;
    }
  });
  return match;
}

function createPulleySocket(pulley: THREE.Object3D): THREE.Object3D {
  const centerWorld = new THREE.Box3().setFromObject(pulley).getCenter(new THREE.Vector3());
  const socket = new THREE.Object3D();
  socket.name = "Fishing pulley socket";
  pulley.updateMatrixWorld(true);
  socket.position.copy(pulley.worldToLocal(centerWorld));
  pulley.add(socket);
  socket.updateMatrixWorld(true);
  return socket;
}

function createLeverPivot(
  model: THREE.Object3D,
  lever: THREE.Object3D,
  name: string
): THREE.Group {
  const bounds = new THREE.Box3().setFromObject(lever);
  const pivotWorld = bounds.getCenter(new THREE.Vector3());
  pivotWorld.y = bounds.min.y;

  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.copy(model.worldToLocal(pivotWorld));
  model.add(pivot);
  pivot.updateMatrixWorld(true);
  return pivot;
}

function markExcludedFromCollider(object: THREE.Object3D): void {
  object.traverse((descendant) => {
    const mesh = descendant as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.userData.excludeFromCollider = true;
    }
  });
}
