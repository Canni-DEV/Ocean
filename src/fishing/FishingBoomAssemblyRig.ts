import * as THREE from "three/webgpu";
import {
  clampBoomElevationRad,
  getBoomElevationDefaultRad
} from "./boomElevationLimits";

/**
 * Meshes that form the port-side fishing boom assembly in the GLB.
 * They share the same mount and must rotate together.
 */
const BOOM_ASSEMBLY_OBJECT_NAMES = [
  "Vert.009",
  "Cylinder.004",
  "Cylinder.013",
  "Cylinder.017"
] as const;

/**
 * Cradle / rest support under the winch on the rail (`Cube.007`).
 * Slides and yaws with the mount, but must not pitch with boom elevation.
 */
const BOOM_MOUNT_OBJECT_NAMES = ["Cube.007"] as const;

/**
 * Baked decorative rope paths from the GLB. They were authored for the original
 * inboard boom pose and break visually once the assembly is reoriented.
 */
const HIDDEN_DECORATIVE_ROPE_OBJECT_NAMES = [
  "NurbsPath.001",
  "BezierCurve"
] as const;

const PIVOT_OBJECT_NAME = "Cylinder.004";
const BOOM_OUTWARD_ROTATION_Y = Math.PI;
const BOOM_ELEVATION_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Reorients the fishing boom, winch support and pulley from inboard (over deck)
 * to outboard (over the water), then pitches the assembly about the winch base.
 */
export class FishingBoomAssemblyRig {
  private readonly mountPivot: THREE.Group;
  private readonly elevationPivot: THREE.Group;
  private elevationRad = getBoomElevationDefaultRad();

  private constructor(mountPivot: THREE.Group, elevationPivot: THREE.Group) {
    this.mountPivot = mountPivot;
    this.elevationPivot = elevationPivot;
    this.setElevation(this.elevationRad);
  }

  static apply(model: THREE.Object3D): FishingBoomAssemblyRig | null {
    hideDecorativeRopeMeshes(model);

    const assemblyObjects = BOOM_ASSEMBLY_OBJECT_NAMES
      .map((name) => findSourceObject(model, name))
      .filter((object): object is THREE.Object3D => object !== null);

    if (assemblyObjects.length === 0) {
      console.warn("Fishing boom assembly rig could not bind: no assembly nodes were found.");
      return null;
    }

    model.updateMatrixWorld(true);

    const pivotAnchor = findSourceObject(model, PIVOT_OBJECT_NAME) ?? assemblyObjects[0];
    const pivotWorld = new THREE.Box3().setFromObject(pivotAnchor).getCenter(new THREE.Vector3());
    const anchorBounds = new THREE.Box3().setFromObject(pivotAnchor);
    pivotWorld.y = anchorBounds.min.y;

    const mountPivot = new THREE.Group();
    mountPivot.name = "Fishing boom mount pivot";
    mountPivot.position.copy(model.worldToLocal(pivotWorld));
    model.add(mountPivot);

    const elevationPivot = new THREE.Group();
    elevationPivot.name = "Fishing boom elevation pivot";
    mountPivot.add(elevationPivot);

    const attached = new Set<THREE.Object3D>();
    for (const object of assemblyObjects) {
      if (attached.has(object)) continue;
      attached.add(object);
      elevationPivot.attach(object);
      markExcludedFromCollider(object);
    }

    const mountObjects = BOOM_MOUNT_OBJECT_NAMES
      .map((name) => findSourceObject(model, name))
      .filter((object): object is THREE.Object3D => object !== null);
    for (const object of mountObjects) {
      if (attached.has(object)) continue;
      attached.add(object);
      mountPivot.attach(object);
      markExcludedFromCollider(object);
    }

    // Apply outward yaw after attach so Three.js does not bake a compensating local rotation.
    mountPivot.rotation.y = BOOM_OUTWARD_ROTATION_Y;
    mountPivot.position.x = mountPivot.position.x + 0.8 ;
    mountPivot.updateMatrixWorld(true);
    return new FishingBoomAssemblyRig(mountPivot, elevationPivot);
  }

  setElevation(angleRad: number): void {
    this.elevationRad = clampBoomElevationRad(angleRad);
    this.elevationPivot.quaternion.setFromAxisAngle(BOOM_ELEVATION_AXIS, this.elevationRad);
    this.elevationPivot.updateMatrixWorld(true);
  }

  getElevation(): number {
    return this.elevationRad;
  }

  getMountPivot(): THREE.Group {
    return this.mountPivot;
  }
}

function hideDecorativeRopeMeshes(model: THREE.Object3D): void {
  for (const name of HIDDEN_DECORATIVE_ROPE_OBJECT_NAMES) {
    const object = findSourceObject(model, name);
    if (!object) continue;
    object.traverse((descendant) => {
      descendant.visible = false;
      const mesh = descendant as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.userData.excludeFromCollider = true;
      }
    });
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

function markExcludedFromCollider(object: THREE.Object3D): void {
  object.traverse((descendant) => {
    const mesh = descendant as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.userData.excludeFromCollider = true;
    }
  });
}
