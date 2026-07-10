import * as THREE from "three/webgpu";

export type RopeRenderMode = "tube" | "line";

export type RopeRendererConfig = {
  radius: number;
  renderMode: RopeRenderMode;
  radialSegments: number;
  tubularSegments: number;
  weightRadius: number;
};

export class RopeRenderer {
  readonly group = new THREE.Group();

  private readonly ropeMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a2f24,
    roughness: 0.92,
    metalness: 0.02
  });
  private readonly lineMaterial = new THREE.LineBasicMaterial({
    color: 0x3a2f24,
    linewidth: 1
  });
  private readonly weightMaterial = new THREE.MeshStandardMaterial({
    color: 0x5a5a5a,
    roughness: 0.35,
    metalness: 0.75
  });

  private ropeMesh: THREE.Mesh | null = null;
  private ropeLine: THREE.Line | null = null;
  private weightMesh: THREE.Mesh;
  private config: RopeRendererConfig;
  private readonly curvePoints: THREE.Vector3[] = [];

  constructor(config: RopeRendererConfig) {
    this.config = { ...config };
    this.group.name = "Fishing rope visuals";
    this.weightMesh = new THREE.Mesh(
      new THREE.SphereGeometry(config.weightRadius, 16, 12),
      this.weightMaterial
    );
    this.weightMesh.name = "Fishing rope weight";
    this.weightMesh.castShadow = true;
    this.group.add(this.weightMesh);
    this.rebuildRopeMesh();
  }

  setConfig(config: Partial<RopeRendererConfig>): void {
    const next = { ...this.config, ...config };
    const radiusChanged = next.radius !== this.config.radius
      || next.renderMode !== this.config.renderMode
      || next.radialSegments !== this.config.radialSegments
      || next.weightRadius !== this.config.weightRadius;
    this.config = next;

    if (radiusChanged) {
      this.weightMesh.geometry.dispose();
      this.weightMesh.geometry = new THREE.SphereGeometry(this.config.weightRadius, 16, 12);
      this.rebuildRopeMesh();
    }
  }

  update(positions: ReadonlyArray<THREE.Vector3>): void {
    if (positions.length < 2) return;

    this.curvePoints.length = 0;
    for (const position of positions) {
      this.curvePoints.push(position.clone());
    }

    if (this.config.renderMode === "tube") {
      this.updateTube();
    } else {
      this.updateLine();
    }

    const weightPosition = positions[positions.length - 1];
    this.weightMesh.position.copy(weightPosition);
  }

  dispose(): void {
    this.ropeMesh?.geometry.dispose();
    this.ropeLine?.geometry.dispose();
    this.weightMesh.geometry.dispose();
    this.ropeMaterial.dispose();
    this.lineMaterial.dispose();
    this.weightMaterial.dispose();
    this.group.removeFromParent();
  }

  private rebuildRopeMesh(): void {
    if (this.ropeMesh) {
      this.ropeMesh.geometry.dispose();
      this.group.remove(this.ropeMesh);
      this.ropeMesh = null;
    }
    if (this.ropeLine) {
      this.ropeLine.geometry.dispose();
      this.group.remove(this.ropeLine);
      this.ropeLine = null;
    }
  }

  private updateTube(): void {
    const curve = new THREE.CatmullRomCurve3(this.curvePoints, false, "centripetal");
    const geometry = new THREE.TubeGeometry(
      curve,
      this.config.tubularSegments,
      this.config.radius,
      this.config.radialSegments,
      false
    );

    if (this.ropeMesh) {
      this.ropeMesh.geometry.dispose();
      this.ropeMesh.geometry = geometry;
    } else {
      if (this.ropeLine) {
        this.ropeLine.geometry.dispose();
        this.group.remove(this.ropeLine);
        this.ropeLine = null;
      }
      this.ropeMesh = new THREE.Mesh(geometry, this.ropeMaterial);
      this.ropeMesh.name = "Fishing rope tube";
      this.ropeMesh.castShadow = true;
      this.group.add(this.ropeMesh);
    }
  }

  private updateLine(): void {
    const geometry = new THREE.BufferGeometry().setFromPoints(this.curvePoints);
    if (this.ropeLine) {
      this.ropeLine.geometry.dispose();
      this.ropeLine.geometry = geometry;
    } else {
      if (this.ropeMesh) {
        this.ropeMesh.geometry.dispose();
        this.group.remove(this.ropeMesh);
        this.ropeMesh = null;
      }
      this.ropeLine = new THREE.Line(geometry, this.lineMaterial);
      this.ropeLine.name = "Fishing rope line";
      this.group.add(this.ropeLine);
    }
  }
}
