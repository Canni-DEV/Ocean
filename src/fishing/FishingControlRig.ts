import * as THREE from "three/webgpu";

const PULLEY_OBJECT_NAMES = ["Cylinder.013", "Cylinder.017"] as const;
const ROPE_LEVER_OBJECT_NAME = "Cylinder.014";
const BOOM_LEVER_OBJECT_NAME = "Cylinder.015";

const MAX_ROPE_LEVER_ROTATION_RAD = THREE.MathUtils.degToRad(32);
const ROPE_LEVER_ROTATION_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Runtime rig for the bow fishing controls in the flattened boat GLB.
 * Palanca 1 animates with reel input; palanca 2 stays at rest (boom deferred).
 */
export class FishingControlRig {
  readonly pulleySocket: THREE.Object3D;

  private readonly ropeLeverPivot: THREE.Group;
  private readonly boomLeverPivot: THREE.Group;

  private constructor(
    pulleySocket: THREE.Object3D,
    ropeLeverPivot: THREE.Group,
    boomLeverPivot: THREE.Group
  ) {
    this.pulleySocket = pulleySocket;
    this.ropeLeverPivot = ropeLeverPivot;
    this.boomLeverPivot = boomLeverPivot;
  }

  static bind(model: THREE.Object3D): FishingControlRig | null {
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

    const pulleySocket = createSocketAtObjectCenter(model, pulley, "Fishing pulley socket");

    const ropeLeverPivot = createLeverPivot(model, ropeLever, "Fishing rope lever pivot");
    ropeLeverPivot.attach(ropeLever);

    const boomLeverPivot = createLeverPivot(model, boomLever, "Fishing boom lever pivot");
    boomLeverPivot.attach(boomLever);

    markExcludedFromCollider(ropeLever);
    markExcludedFromCollider(boomLever);

    model.updateMatrixWorld(true);
    return new FishingControlRig(pulleySocket, ropeLeverPivot, boomLeverPivot);
  }

  update(reel: number): void {
    const clampedReel = THREE.MathUtils.clamp(reel, -1, 1);
    this.ropeLeverPivot.quaternion.setFromAxisAngle(
      ROPE_LEVER_ROTATION_AXIS,
      -clampedReel * MAX_ROPE_LEVER_ROTATION_RAD
    );
    this.boomLeverPivot.quaternion.identity();
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

function createSocketAtObjectCenter(
  model: THREE.Object3D,
  object: THREE.Object3D,
  name: string
): THREE.Object3D {
  const centerWorld = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  const socket = new THREE.Object3D();
  socket.name = name;
  socket.position.copy(model.worldToLocal(centerWorld));
  model.add(socket);
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
