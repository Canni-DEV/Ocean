import * as THREE from "three/webgpu";

export type RopeRenderMode = "tube" | "line";

export type RopeRendererConfig = {
  radius: number;
  renderMode: RopeRenderMode;
  radialSegments: number;
  tubularSegments: number;
  weightRadius: number;
};

/** Solid celeste for line mode — saturated enough to survive scene exposure. */
const ROPE_LINE_COLOR = 0x6b96b3;

export class RopeRenderer {
  readonly group = new THREE.Group();

  private readonly ropeTexture = createBoatRopeBraidTexture();
  private readonly ropeMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: this.ropeTexture,
    roughness: 0.78,
    metalness: 0.02
  });
  private readonly lineMaterial = new THREE.LineBasicMaterial({
    color: ROPE_LINE_COLOR,
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
    this.ropeTexture.dispose();
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
    const ropeLength = curve.getLength();
    this.ropeTexture.repeat.set(Math.max(1, ropeLength * 3.5), 1);

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

/**
 * Mottled white + celeste braid pattern sampled from the boat GLB rope spool.
 * Uses a saturated sky-blue so it stays visible under ACES tone mapping.
 */
function createBoatRopeBraidTexture(): THREE.CanvasTexture {
  const width = 128;
  const height = 32;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const fallback = new THREE.CanvasTexture(canvas);
    fallback.colorSpace = THREE.SRGBColorSpace;
    return fallback;
  }

  const white = "#edf4f8";
  const celeste = "#6b96b3";
  const celesteDeep = "#4f7f9c";
  const celesteLight = "#8eb3c9";

  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const braidBand = Math.floor((x + y * 2) / 5) % 4;
      const fleck = (x * 5 + y * 3) % 11;
      let hex = celeste;

      if (braidBand === 0) {
        hex = white;
      } else if (braidBand === 1) {
        hex = celesteLight;
      } else if (braidBand === 2) {
        hex = celeste;
      } else {
        hex = celesteDeep;
      }

      if (fleck < 2) {
        hex = white;
      } else if (fleck > 8) {
        hex = celesteDeep;
      }

      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const index = (y * width + x) * 4;
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
