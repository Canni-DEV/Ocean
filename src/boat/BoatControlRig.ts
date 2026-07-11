import * as THREE from "three/webgpu";
import type { BoatControlState } from "./BoatController";

const WHEEL_OBJECT_NAME = "Cylinder.010";
/** Fixed semi-circular housing on the dashboard; Cylinder.012 is the moving lever arm. */
const THROTTLE_LEVER_OBJECT_NAME = "Cylinder.012";

const MAX_WHEEL_ROTATION_RAD = THREE.MathUtils.degToRad(100);
const MAX_THROTTLE_ROTATION_RAD = THREE.MathUtils.degToRad(28);

const WHEEL_LOCAL_NORMAL = new THREE.Vector3(0, 0, 1);
const THROTTLE_ROTATION_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Runtime rig for the interactive controls embedded in the flattened boat GLB.
 * It creates proper pivots without requiring a destructive edit of the source asset.
 */
export class BoatControlRig {
  private readonly wheelPivot: THREE.Group;
  private readonly wheelRotationAxis: THREE.Vector3;
  private readonly throttlePivot: THREE.Group;

  private constructor(
    wheelPivot: THREE.Group,
    wheelRotationAxis: THREE.Vector3,
    throttlePivot: THREE.Group
  ) {
    this.wheelPivot = wheelPivot;
    this.wheelRotationAxis = wheelRotationAxis;
    this.throttlePivot = throttlePivot;
  }

  static bind(model: THREE.Object3D): BoatControlRig | null {
    const wheel = findSourceObject(model, WHEEL_OBJECT_NAME);
    const throttleLever = findSourceObject(model, THROTTLE_LEVER_OBJECT_NAME);

    if (!wheel || !throttleLever) {
      console.warn("Boat control rig could not bind: the expected GLB control nodes are missing.");
      return null;
    }

    model.updateMatrixWorld(true);

    const wheelPivot = createPivotAtObjectCenter(model, wheel, "Boat steering wheel pivot");
    const wheelRotationAxis = getDirectionInModelSpace(model, wheel, WHEEL_LOCAL_NORMAL);
    wheelPivot.attach(wheel);

    const throttlePivot = createThrottlePivot(model, throttleLever);
    throttlePivot.attach(throttleLever);

    // The gameplay collider is baked once. Keeping animated geometry out prevents
    // a stale invisible wheel/lever pose from affecting first-person movement.
    markExcludedFromCollider(wheel);
    markExcludedFromCollider(throttleLever);

    model.updateMatrixWorld(true);
    return new BoatControlRig(wheelPivot, wheelRotationAxis, throttlePivot);
  }

  update(control: BoatControlState): void {
    const rudder = THREE.MathUtils.clamp(control.rudder, -1, 1);
    const throttle = THREE.MathUtils.clamp(control.throttle, -1, 1);

    this.wheelPivot.quaternion.setFromAxisAngle(
      this.wheelRotationAxis,
      -rudder * MAX_WHEEL_ROTATION_RAD
    );
    this.throttlePivot.quaternion.setFromAxisAngle(
      THROTTLE_ROTATION_AXIS,
      -throttle * MAX_THROTTLE_ROTATION_RAD
    );
  }
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

function createPivotAtObjectCenter(
  model: THREE.Object3D,
  object: THREE.Object3D,
  name: string
): THREE.Group {
  const centerWorld = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.copy(model.worldToLocal(centerWorld));
  model.add(pivot);
  pivot.updateMatrixWorld(true);
  return pivot;
}

function createThrottlePivot(model: THREE.Object3D, lever: THREE.Object3D): THREE.Group {
  const leverBounds = new THREE.Box3().setFromObject(lever);
  const pivotWorld = leverBounds.getCenter(new THREE.Vector3());
  pivotWorld.y = leverBounds.min.y;

  const pivot = new THREE.Group();
  pivot.name = "Boat throttle lever pivot";
  pivot.position.copy(model.worldToLocal(pivotWorld));
  model.add(pivot);
  pivot.updateMatrixWorld(true);
  return pivot;
}

function getDirectionInModelSpace(
  model: THREE.Object3D,
  object: THREE.Object3D,
  localDirection: THREE.Vector3
): THREE.Vector3 {
  const direction = localDirection.clone().transformDirection(object.matrixWorld);
  const inverseModelWorld = new THREE.Matrix4().copy(model.matrixWorld).invert();
  return direction.transformDirection(inverseModelWorld);
}

function markExcludedFromCollider(object: THREE.Object3D): void {
  object.traverse((descendant) => {
    const mesh = descendant as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.userData.excludeFromCollider = true;
    }
  });
}
