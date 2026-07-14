import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshBVH } from "three-mesh-bvh";
import boatModelUrl from "../../assets/fishing_boat.glb?url";
import { BoatControlRig } from "./BoatControlRig";
import type { BoatControlState } from "./BoatController";
import { FishingControlRig } from "../fishing/FishingControlRig";
import { getBoomElevationDefaultRad } from "../fishing/boomElevationLimits";
import type { FishingControlState } from "../fishing/FishingController";
import { DEFAULT_BOAT_CONFIG, type BoatConfig, type BoatPhysics } from "./BoatPhysics";
import { CockpitRig } from "./CockpitRig";
import type { BoatSystemsState } from "../gameplay/types";

/**
 * Meshes del modelo GLB que se ocultan y se excluyen del collider para dejar
 * un vano transitable. La puerta de la cabina (`pCube1.002_Material.001_0`) es
 * un panel independiente colocado sobre un hueco ya recortado en la pared, y
 * `Cube.025_glass_0` es la ventanita superior de esa puerta. Quitar ambas deja
 * el vano libre para que el player entre a la cabina.
 *
 * Nota: GLTFLoader "sanitiza" `mesh.name` (elimina los puntos), por lo que el
 * match se hace contra el nombre original preservado en `userData.name`.
 */
const REMOVED_MODEL_MESH_NAMES = new Set<string>([
  "pCube1.002_Material.001_0",
  "Cube.025_glass_0"
]);

function isRemovedModelMesh(object: THREE.Object3D): boolean {
  const originalName = (object.userData?.name as string | undefined) ?? object.name;
  return REMOVED_MODEL_MESH_NAMES.has(originalName);
}

/** Visual del barco: carga el GLB definitivo al inicio y expone collider/rigs. */
export class BoatVisual {
  readonly group = new THREE.Group();

  private readonly config: BoatConfig;
  private readonly modelGroup = new THREE.Group();
  private readonly lightGroup = new THREE.Group();
  private readonly spotlight = new THREE.SpotLight(0xfff0d0, 1200, 1000, 1.1, 0.48, 1.35);
  private readonly spotlightCabin = new THREE.SpotLight(0xfff0d0, 10, 300, 2.5, 0.48, 1.35);
  private readonly spotlightTarget = new THREE.Object3D();
  private readonly spotlightCabinTarget = new THREE.Object3D();
  private modelReady = false;
  private lightsOn = false;
  private colliderGeometry: THREE.BufferGeometry | null = null;
  private colliderBVH: MeshBVH | null = null;
  private controlRig: BoatControlRig | null = null;
  private fishingControlRig: FishingControlRig | null = null;
  private cockpitRig: CockpitRig | null = null;
  private controlThrottle = 0;
  private controlRudder = 0;
  private fishingReel = 0;
  private fishingBoom = 0;
  private fishingBoomElevationRad = getBoomElevationDefaultRad();

  constructor(config: BoatConfig = DEFAULT_BOAT_CONFIG) {
    this.config = config;
    this.group.name = "Player boat";
    this.modelGroup.name = "Boat GLB model";
    this.lightGroup.name = "Boat model spotlight";
    this.modelGroup.visible = false;
    this.lightGroup.visible = false;
    this.lightGroup.add(this.createSpotlight());
    this.group.add(this.modelGroup, this.lightGroup);
    void this.loadModel();
  }

  syncFromPhysics(physics: BoatPhysics): void {
    this.group.position.copy(physics.position);
    this.group.quaternion.copy(physics.quaternion);
  }

  setLightsOn(lightsOn: boolean): void {
    this.lightsOn = lightsOn;
    this.syncVisibility();
  }

  setSystemsState(state: BoatSystemsState, precipitation: number, deltaSeconds: number): void {
    this.lightsOn = state.workLight;
    this.cockpitRig?.update(state, precipitation, deltaSeconds);
    this.syncVisibility();
  }

  setControlState(control: BoatControlState): void {
    this.controlThrottle = control.throttle;
    this.controlRudder = control.rudder;
    this.controlRig?.update(control);
  }

  setFishingState(control: FishingControlState): void {
    this.fishingReel = control.reel;
    this.fishingBoom = control.boom;
    this.fishingBoomElevationRad = control.boomElevationRad;
    this.fishingControlRig?.update(control.reel, control.boom, control.boomElevationRad);
  }

  isModelReady(): boolean {
    return this.modelReady;
  }

  getFishingRig(): FishingControlRig | null {
    return this.fishingControlRig;
  }

  getCockpitRig(): CockpitRig | null {
    return this.cockpitRig;
  }

  isColliderReady(): boolean {
    return this.colliderBVH !== null;
  }

  getColliderBVH(): MeshBVH | null {
    return this.colliderBVH;
  }

  getColliderGeometry(): THREE.BufferGeometry | null {
    return this.colliderGeometry;
  }

  getDefaultSpawnLocalPosition(): THREE.Vector3 {
    return new THREE.Vector3(0, this.config.hullHeightMeters * 2, this.config.lengthMeters * 0.02);
  }

  dispose(): void {
    this.cockpitRig?.dispose();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.colliderBVH = null;
    this.controlRig = null;
    this.fishingControlRig = null;
    this.cockpitRig = null;
    this.colliderGeometry?.dispose();
    this.colliderGeometry = null;
    this.group.removeFromParent();
  }

  private async loadModel(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(boatModelUrl);
      const model = gltf.scene;
      model.name = "Fishing boat model";
      this.prepareModel(model);
      this.controlRig = BoatControlRig.bind(model);
      this.controlRig?.update({
        throttle: this.controlThrottle,
        rudder: this.controlRudder
      });
      this.fishingControlRig = FishingControlRig.bind(model);
      this.fishingControlRig?.update(this.fishingReel, this.fishingBoom, this.fishingBoomElevationRad);
      this.cockpitRig = CockpitRig.bind(model);
      this.modelGroup.add(model);
      this.modelReady = true;
      this.buildCollider();
      this.syncVisibility();
    } catch (error) {
      this.modelReady = false;
      this.syncVisibility();
      console.error("Failed to load fishing boat GLB:", error);
    }
  }

  private buildCollider(): void {
    this.colliderBVH = null;
    this.colliderGeometry?.dispose();
    this.colliderGeometry = null;

    const merged = mergeMeshesToLocalGeometry(this.modelGroup, this.group);
    if (!merged) return;

    this.colliderGeometry = merged;
    this.colliderBVH = new MeshBVH(merged);
  }

  private prepareModel(model: THREE.Object3D): void {
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (isRemovedModelMesh(mesh)) {
        mesh.visible = false;
        mesh.userData.excludeFromCollider = true;
        return;
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    const initialBox = new THREE.Box3().setFromObject(model);
    const initialSize = initialBox.getSize(new THREE.Vector3());
    const longestAxis = initialSize.x >= initialSize.y && initialSize.x >= initialSize.z
      ? "x"
      : initialSize.y >= initialSize.z
        ? "y"
        : "z";

    if (longestAxis === "x") {
      model.rotation.y = Math.PI / 2;
    } else if (longestAxis === "y") {
      model.rotation.x = Math.PI / 2;
    }

    model.updateMatrixWorld(true);
    const rotatedBox = new THREE.Box3().setFromObject(model);
    const rotatedSize = rotatedBox.getSize(new THREE.Vector3());
    const modelLength = Math.max(rotatedSize.x, rotatedSize.y, rotatedSize.z);
    const scale = modelLength > 0 ? this.config.lengthMeters / modelLength : 1;
    model.scale.setScalar(scale);

    model.updateMatrixWorld(true);
    const fittedBox = new THREE.Box3().setFromObject(model);
    const center = fittedBox.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y += -this.config.hullHeightMeters * 0.64 - fittedBox.min.y;
  }

  private syncVisibility(): void {
    this.modelGroup.visible = this.modelReady;
    this.lightGroup.visible = this.modelReady && this.lightsOn;
  }

  private createSpotlight(): THREE.Group {
    const lightMount = new THREE.Group();
    const lightPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 2.8,
      -this.config.lengthMeters * 0.31
    );

    const lightCabinPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 1.25,
      -this.config.lengthMeters * -0.175
    );

    const targetPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 0.3,
      -this.config.lengthMeters * 75
    );

    const targetPositionCabin = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 0.3,
      -this.config.lengthMeters * -0.2
    );

    this.spotlight.name = "Boat forward spotlight";
    this.spotlight.position.copy(lightPosition);
    this.spotlight.target = this.spotlightTarget;
    this.spotlight.castShadow = false;

    this.spotlightTarget.name = "Boat forward spotlight target";
    this.spotlightTarget.position.copy(targetPosition);

    this.spotlightCabin.name = "Cabin forward1 spotlight";
    this.spotlightCabin.position.copy(lightCabinPosition);
    this.spotlightCabin.target = this.spotlightCabinTarget;
    this.spotlightCabin.castShadow = false;

    this.spotlightCabinTarget.name = "Cabin forward1 spotlight target";
    this.spotlightCabinTarget.position.copy(targetPositionCabin);

    lightMount.add(this.spotlightCabin, this.spotlightCabinTarget);
    lightMount.add(this.spotlight, this.spotlightTarget);
    return lightMount;
  }
}

function mergeMeshesToLocalGeometry(
  sourceRoot: THREE.Object3D,
  spaceRoot: THREE.Object3D
): THREE.BufferGeometry | null {
  spaceRoot.updateMatrixWorld(true);
  const inverseSpace = new THREE.Matrix4().copy(spaceRoot.matrixWorld).invert();
  const geometries: THREE.BufferGeometry[] = [];

  sourceRoot.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (mesh.userData.excludeFromCollider) return;

    const geometry = mesh.geometry.clone();
    const localMatrix = new THREE.Matrix4().multiplyMatrices(inverseSpace, mesh.matrixWorld);
    geometry.applyMatrix4(localMatrix);
    geometries.push(geometry);
  });

  if (geometries.length === 0) return null;
  return mergeBufferGeometries(geometries);
}

function mergeBufferGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  for (const geometry of geometries) {
    const position = geometry.getAttribute("position");
    if (!position) {
      geometry.dispose();
      continue;
    }

    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
    }

    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 1) {
        indices.push(index.getX(i) + vertexOffset);
      }
    } else {
      for (let i = 0; i < position.count; i += 1) {
        indices.push(i + vertexOffset);
      }
    }

    vertexOffset += position.count;
    geometry.dispose();
  }

  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  merged.computeVertexNormals();
  return merged;
}
