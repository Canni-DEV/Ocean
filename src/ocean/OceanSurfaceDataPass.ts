import * as THREE from "three/webgpu";
import type { OceanRenderer } from "./OceanRenderer";

export class OceanSurfaceDataPass {
  private readonly target: THREE.RenderTarget;
  private width = 1;
  private height = 1;
  private readonly scale: number;
  private lastRenderMs = 0;

  constructor(scale: number) {
    this.scale = Math.max(0.125, Math.min(1, scale));
    this.target = createTarget(1, 1);
  }

  get normalRoughnessTexture(): THREE.Texture {
    return this.target.texture;
  }

  get depthTexture(): THREE.DepthTexture {
    return this.target.depthTexture as THREE.DepthTexture;
  }

  get renderMs(): number {
    return this.lastRenderMs;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.depthTexture?.dispose();
    this.target.depthTexture = createDepth(w, h);
    this.target.setSize(w, h);
  }

  render(renderer: THREE.WebGPURenderer, ocean: OceanRenderer, camera: THREE.Camera): void {
    const start = performance.now();
    ocean.renderSurfaceData(renderer, camera, this.target);
    this.lastRenderMs = performance.now() - start;
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
  }
}

function createTarget(width: number, height: number): THREE.RenderTarget {
  const target = new THREE.RenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture: createDepth(width, height),
    samples: 0,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter
  });
  target.texture.name = "ocean-surface-normal-roughness";
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

function createDepth(width: number, height: number): THREE.DepthTexture {
  const depth = new THREE.DepthTexture(width, height, THREE.FloatType);
  depth.name = "ocean-surface-depth";
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;
  return depth;
}
