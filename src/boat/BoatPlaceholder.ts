import * as THREE from "three/webgpu";
import { DEFAULT_BOAT_CONFIG, type BoatConfig, type BoatPhysics } from "./BoatPhysics";

export class BoatPlaceholder {
  readonly group = new THREE.Group();

  private readonly config: BoatConfig;
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

  constructor(config: BoatConfig = DEFAULT_BOAT_CONFIG) {
    this.config = config;
    this.group.name = "Player boat placeholder";
    this.group.add(this.createHull(), this.createDeck(), this.createCabin(), this.createBowMarker());
  }

  syncFromPhysics(physics: BoatPhysics): void {
    this.group.position.copy(physics.position);
    this.group.quaternion.copy(physics.quaternion);
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
      }
    });
    this.hullMaterial.dispose();
    this.deckMaterial.dispose();
    this.trimMaterial.dispose();
    this.group.removeFromParent();
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
      0, 1, 2, 0, 2, 3,
      0, 4, 5, 0, 5, 1,
      0, 3, 7, 0, 7, 4,
      1, 5, 6, 1, 6, 2,
      3, 2, 6, 3, 6, 7,
      4, 7, 8, 5, 8, 6,
      4, 8, 5, 7, 6, 8
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
