import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import boatModelUrl from "../../assets/fishing_boat.glb?url";
import { DEFAULT_BOAT_CONFIG, type BoatConfig, type BoatPhysics } from "./BoatPhysics";

export class BoatPlaceholder {
  readonly group = new THREE.Group();

  private readonly config: BoatConfig;
  private readonly placeholderGroup = new THREE.Group();
  private readonly modelGroup = new THREE.Group();
  private readonly lightGroup = new THREE.Group();
  private readonly spotlight = new THREE.SpotLight(0xfff0d0, 600, 300, 0.9, 0.48, 1.35);
  private readonly spotlightInner = new THREE.SpotLight(0xfff0d0, 100, 100, 0.75, 0.48, 1.35);
  private readonly spotlightCabin = new THREE.SpotLight(0xfff0d0, 100, 300, 2.5, 0.48, 1.35);
  private readonly spotlightTarget = new THREE.Object3D();
  private readonly spotlightInnerTarget = new THREE.Object3D();
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

  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.group.removeFromParent();
  }

  private async loadModel(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(boatModelUrl);
      const model = gltf.scene;
      model.name = "Fishing boat model";
      this.prepareModel(model);
      this.modelGroup.add(model);
      this.modelReady = true;
      this.syncVisibility();
    } catch {
      this.modelReady = false;
      this.syncVisibility();
    }
  }

  private prepareModel(model: THREE.Object3D): void {
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
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
    this.lightGroup.visible = this.modelGroup.visible;
  }

  private createSpotlight(): THREE.Group {
    const lightMount = new THREE.Group();
    //Positions
    const lightPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 2.8,
      -this.config.lengthMeters * 0.31
    );

     const lightInnerPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 1.5,
      -this.config.lengthMeters *  -0.07
    );

     const lightCabinPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 1.25,
      -this.config.lengthMeters *  -0.175
    );

    const targetPosition = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 0.3,
      -this.config.lengthMeters * 2.5
    );

     const targetPositionBoat = new THREE.Vector3(
      -this.config.beamMeters * 0.02,
      this.config.hullHeightMeters * 0.3,
      -this.config.lengthMeters * 0.15  
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

    //Inner
    this.spotlightInner.name = "Boat forward1 spotlight";
    this.spotlightInner.position.copy(lightInnerPosition);
    this.spotlightInner.target = this.spotlightInnerTarget;
    this.spotlightInner.castShadow = true;

    this.spotlightInnerTarget.name = "Boat forward1 spotlight target";
    this.spotlightInnerTarget.position.copy(targetPositionBoat);

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
    lightMount.add(this.spotlightInner, this.spotlightInnerTarget);
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

  private createBowMarker(): THREE.Mesh {
    const geometry = new THREE.ConeGeometry(0.18, 0.55, 4);
    const mesh = new THREE.Mesh(geometry, this.trimMaterial);
    mesh.position.set(0, this.config.hullHeightMeters * 0.52, -this.config.lengthMeters * 0.43);
    mesh.rotation.x = Math.PI / 2;
    mesh.castShadow = true;
    return mesh;
  }
}
