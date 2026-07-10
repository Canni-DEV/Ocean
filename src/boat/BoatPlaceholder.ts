import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshBVH } from "three-mesh-bvh";
import boatModelUrl from "../../assets/fishing_boat.glb?url";
import { BoatControlRig } from "./BoatControlRig";
import type { BoatControlState } from "./BoatController";
import { FishingControlRig } from "../fishing/FishingControlRig";
import { BOOM_ELEVATION_DEFAULT_RAD } from "../fishing/FishingBoomAssemblyRig";
import type { FishingControlState } from "../fishing/FishingController";
import { DEFAULT_BOAT_CONFIG, type BoatConfig, type BoatPhysics } from "./BoatPhysics";

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

export class BoatPlaceholder {
  readonly group = new THREE.Group();

  private readonly config: BoatConfig;
  private readonly placeholderGroup = new THREE.Group();
  private readonly modelGroup = new THREE.Group();
  private readonly lightGroup = new THREE.Group();
  private readonly spotlight = new THREE.SpotLight(0xfff0d0, 1200, 1000, 1.1, 0.48, 1.35);
  private readonly spotlightCabin = new THREE.SpotLight(0xfff0d0, 10, 300, 2.5, 0.48, 1.35);
  private readonly spotlightTarget = new THREE.Object3D();
  private readonly spotlightCabinTarget = new THREE.Object3D();
  private readonly hullMaterial = new THREE.MeshStandardMaterial({
    color: 0xd95f32,
    roughness: 0.62,
    metalness: 0.05
  });
  private readonly deckMaterial = new THREE.MeshStandardMaterial({
    color: 0xf2ede4,
    roughness: 0.7,
    metalness: 0
  });
  private readonly trimMaterial = new THREE.MeshStandardMaterial({
    color: 0x223447,
    roughness: 0.55,
    metalness: 0.02
  });
  // private readonly lightMarkerMaterial = new THREE.MeshBasicMaterial({
  //   color: 0xff0000,
  //   depthTest: false
  // });
  private modelReady = false;
  private useModel = false;
  private lightsOn = false;
  private colliderGeometry: THREE.BufferGeometry | null = null;
  private colliderBVH: MeshBVH | null = null;
  private controlRig: BoatControlRig | null = null;
  private fishingControlRig: FishingControlRig | null = null;
  private controlThrottle = 0;
  private controlRudder = 0;
  private fishingReel = 0;
  private fishingBoomElevationRad = BOOM_ELEVATION_DEFAULT_RAD;

  constructor(config: BoatConfig = DEFAULT_BOAT_CONFIG) {
    this.config = config;
    this.group.name = "Player boat placeholder";
    this.placeholderGroup.name = "Boat debug placeholder";
    this.modelGroup.name = "Boat GLB model";
    this.lightGroup.name = "Boat model spotlight";
    this.modelGroup.visible = false;
    this.placeholderGroup.add(this.createHull(), this.createDeck(), this.createCabin(), this.createBowMarker());
    this.lightGroup.add(this.createSpotlight());
    this.group.add(this.placeholderGroup, this.modelGroup, this.lightGroup);
    void this.loadModel();
  }

  syncFromPhysics(physics: BoatPhysics): void {
    this.group.position.copy(physics.position);
    this.group.quaternion.copy(physics.quaternion);
  }

  setUseModel(useModel: boolean): void {
    this.useModel = useModel;
    this.syncVisibility();
  }

  setLightsOn(lightsOn: boolean): void {
    this.lightsOn = lightsOn;
    this.syncVisibility();
  }

  setControlState(control: BoatControlState): void {
    this.controlThrottle = control.throttle;
    this.controlRudder = control.rudder;
    this.controlRig?.update(control);
  }

  setFishingState(control: FishingControlState): void {
    this.fishingReel = control.reel;
    this.fishingBoomElevationRad = control.boomElevationRad;
    this.fishingControlRig?.update(control.reel, control.boomElevationRad);
  }

  isModelReady(): boolean {
    return this.modelReady;
  }

  getFishingRig(): FishingControlRig | null {
    return this.fishingControlRig;
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

  dispose(): void {
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
      this.fishingControlRig?.update(this.fishingReel, this.fishingBoomElevationRad);
      this.modelGroup.add(model);
      this.modelReady = true;
      this.buildCollider();
      this.syncVisibility();
    } catch {
      this.modelReady = false;
      this.syncVisibility();
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
    this.modelGroup.visible = this.useModel && this.modelReady;
    this.placeholderGroup.visible = !this.modelGroup.visible;
    this.lightGroup.visible = this.modelGroup.visible && this.lightsOn;
  }

  private createSpotlight(): THREE.Group {
    const lightMount = new THREE.Group();
    //Positions
    const lightPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 2.8,
      -this.config.lengthMeters * 0.31
    );

     const lightCabinPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 1.25,
      -this.config.lengthMeters *  -0.175
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

    //Spot
    this.spotlight.name = "Boat forward spotlight";
    this.spotlight.position.copy(lightPosition);
    this.spotlight.target = this.spotlightTarget;
    this.spotlight.castShadow = false;

    this.spotlightTarget.name = "Boat forward spotlight target";
    this.spotlightTarget.position.copy(targetPosition);


    //Cabin
    this.spotlightCabin.name = "Cabin forward1 spotlight";
    this.spotlightCabin.position.copy(lightCabinPosition);
    this.spotlightCabin.target = this.spotlightCabinTarget;
    this.spotlightCabin.castShadow = false;

    this.spotlightCabinTarget.name = "Cabin forward1 spotlight target";
    this.spotlightCabinTarget.position.copy(targetPositionCabin);

    // const marker = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 8), this.lightMarkerMaterial);
    // marker.name = "Boat spotlight red marker";
    // marker.position.copy(lightCabinPosition);
    // marker.renderOrder = 10002;
    // marker.userData.depthPass = "exclude";

    lightMount.add(this.spotlightCabin, this.spotlightCabinTarget);
    lightMount.add(this.spotlight, this.spotlightTarget);
    return lightMount;
  }

  private createHull(): THREE.Mesh {
    const length = this.config.lengthMeters;
    const beam = this.config.beamMeters;
    const height = this.config.hullHeightMeters;
    const halfLength = length / 2;
    const halfBeam = beam / 2;
    const deckY = height * 0.36;
    const keelY = -height * 0.64;

    const vertices = new Float32Array([
      -halfBeam, deckY, halfLength,
      halfBeam, deckY, halfLength,
      halfBeam * 0.72, keelY, halfLength * 0.78,
      -halfBeam * 0.72, keelY, halfLength * 0.78,
      -halfBeam * 0.78, deckY, -halfLength * 0.58,
      halfBeam * 0.78, deckY, -halfLength * 0.58,
      halfBeam * 0.28, keelY, -halfLength * 0.9,
      -halfBeam * 0.28, keelY, -halfLength * 0.9,
      0, deckY * 0.92, -halfLength
    ]);

    const indices = [
      0, 2, 1, 0, 3, 2,
      0, 5, 4, 0, 1, 5,
      0, 7, 3, 0, 4, 7,
      1, 6, 5, 1, 2, 6,
      3, 6, 2, 3, 7, 6,
      4, 8, 7, 5, 6, 8,
      4, 5, 8, 7, 8, 6
    ];

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this.hullMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private createDeck(): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(
      this.config.beamMeters * 0.78,
      0.08,
      this.config.lengthMeters * 0.56
    );
    const mesh = new THREE.Mesh(geometry, this.deckMaterial);
    mesh.position.set(0, this.config.hullHeightMeters * 0.42, this.config.lengthMeters * 0.02);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private createCabin(): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(
      this.config.beamMeters * 0.45,
      this.config.hullHeightMeters * 0.42,
      this.config.lengthMeters * 0.18
    );
    const mesh = new THREE.Mesh(geometry, this.trimMaterial);
    mesh.position.set(0, this.config.hullHeightMeters * 0.68, -this.config.lengthMeters * 0.08);
    mesh.castShadow = true;
    return mesh;
  }

  getDefaultSpawnLocalPosition(): THREE.Vector3 {
    return new THREE.Vector3(0, this.config.hullHeightMeters * 2, this.config.lengthMeters * 0.02);
  }

  private createBowMarker(): THREE.Mesh {
    const geometry = new THREE.ConeGeometry(0.18, 0.55, 4);
    const mesh = new THREE.Mesh(geometry, this.trimMaterial);
    mesh.position.set(0, this.config.hullHeightMeters * 0.52, -this.config.lengthMeters * 0.43);
    mesh.rotation.x = Math.PI / 2;
    mesh.castShadow = true;
    return mesh;
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
