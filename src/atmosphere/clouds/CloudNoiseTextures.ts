import * as THREE from "three/webgpu";
import { Fn, float, instanceIndex, storageTexture3D, uint, uvec3, vec3, vec4 } from "three/tsl";
import { perlinFbm3, remapNode, worleyFbm3 } from "./noise";

type NodeRef = any;

export const BASE_NOISE_SIZE = 128;
export const DETAIL_NOISE_SIZE = 32;

/**
 * One-time compute generation of the volumetric cloud noise fields
 * (Schneider/Nubis style):
 *
 * - base 128^3 RGBA: R = Perlin-Worley (cloud macro shape),
 *   GBA = inverted Worley FBM at increasing frequencies (shape erosion).
 * - detail 32^3 RGBA: high-frequency Worley FBM octaves (edge erosion).
 *
 * Both textures are tileable and sampled with repeat wrapping.
 */
export class CloudNoiseTextures {
  readonly baseTexture: THREE.Storage3DTexture;
  readonly detailTexture: THREE.Storage3DTexture;

  private readonly basePass: NodeRef;
  private readonly detailPass: NodeRef;
  private generated = false;

  constructor() {
    this.baseTexture = createNoiseTexture(BASE_NOISE_SIZE, "cloud-base-noise");
    this.detailTexture = createNoiseTexture(DETAIL_NOISE_SIZE, "cloud-detail-noise");
    this.basePass = createBaseNoisePass(this.baseTexture, BASE_NOISE_SIZE);
    this.detailPass = createDetailNoisePass(this.detailTexture, DETAIL_NOISE_SIZE);
  }

  /** Runs the generation passes once; later calls are no-ops. */
  ensureGenerated(renderer: THREE.WebGPURenderer): void {
    if (this.generated) return;
    this.generated = true;
    renderer.compute(this.basePass);
    renderer.compute(this.detailPass);
  }

  dispose(): void {
    this.baseTexture.dispose();
    this.detailTexture.dispose();
  }
}

function createNoiseTexture(size: number, name: string): THREE.Storage3DTexture {
  const texture = new THREE.Storage3DTexture(size, size, size);
  texture.name = name;
  texture.type = THREE.HalfFloatType;
  texture.format = THREE.RGBAFormat;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  (texture as any).mipmapsAutoUpdate = false;
  return texture;
}

function texelToUVW(size: number): { coord: NodeRef; uvw: NodeRef } {
  const n = uint(size);
  const x = instanceIndex.mod(n);
  const y = instanceIndex.div(n).mod(n);
  const z = instanceIndex.div(uint(size * size));
  const coord = uvec3(x, y, z);
  const uvw = vec3(x.toFloat(), y.toFloat(), z.toFloat()).add(0.5).div(size);
  return { coord, uvw };
}

function createBaseNoisePass(target: THREE.Storage3DTexture, size: number): NodeRef {
  return Fn(() => {
    const { coord, uvw } = texelToUVW(size);

    const perlin = perlinFbm3(uvw, float(4), 7);
    const worleyLow = worleyFbm3(uvw, float(6));
    const worleyMid = worleyFbm3(uvw, float(12));
    const worleyHigh = worleyFbm3(uvw, float(24));

    // Perlin-Worley: dilate billowy Worley cells with Perlin connectivity
    const perlinWorley = remapNode(perlin, worleyLow.oneMinus().negate(), float(1), float(0), float(1)).clamp(0, 1);

    storageTexture3D(target, coord, vec4(perlinWorley, worleyLow, worleyMid, worleyHigh)).toStack();
  })().compute(size * size * size);
}

function createDetailNoisePass(target: THREE.Storage3DTexture, size: number): NodeRef {
  return Fn(() => {
    const { coord, uvw } = texelToUVW(size);

    const w0 = worleyFbm3(uvw, float(2));
    const w1 = worleyFbm3(uvw, float(4));
    const w2 = worleyFbm3(uvw, float(8));

    storageTexture3D(target, coord, vec4(w0, w1, w2, 1)).toStack();
  })().compute(size * size * size);
}
