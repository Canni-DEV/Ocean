import * as THREE from "three/webgpu";
import { depth, materialRoughness, mrt, nodeObject, normalView, output, vec4, velocity } from "three/tsl";

type VisibilityState = { object: THREE.Object3D; visible: boolean };

export type OceanSceneCaptureTextures = {
  sceneColor: THREE.Texture;
  sceneDepth: THREE.DepthTexture;
  sceneVelocity: THREE.Texture;
  sceneNormalRoughness: THREE.Texture;
};

/**
 * Linear HDR capture of reflectable opaque geometry. Atmospheric fullscreen
 * layers, transparent objects and the ocean mark themselves as excluded. MRT
 * keeps color, normal/roughness and velocity coherent in a single scene draw.
 */
export class OceanSceneCapturePass {
  private readonly target: THREE.RenderTarget;
  private readonly mrtNode: any;
  private width = 1;
  private height = 1;
  private scale: number;
  private lastCaptureMs = 0;

  constructor(scale: number) {
    this.scale = scale;
    this.target = this.createTarget(1, 1);
    this.mrtNode = mrt({
      output,
      sceneNormalRoughness: vec4(normalView.mul(0.5).add(0.5), materialRoughness),
      // Depth shares the otherwise unused velocity B channel. This preserves
      // full normal/roughness data without adding a fragment texture binding.
      sceneVelocity: (vec4 as any)(nodeObject(velocity), depth, 1)
    });
  }

  get textures(): OceanSceneCaptureTextures {
    return {
      sceneColor: this.target.textures[0],
      sceneDepth: this.target.depthTexture as THREE.DepthTexture,
      sceneNormalRoughness: this.target.textures[1],
      sceneVelocity: this.target.textures[2]
    };
  }

  get captureMs(): number {
    return this.lastCaptureMs;
  }

  setScale(scale: number): void {
    this.scale = Math.max(0.125, Math.min(1, scale));
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.depthTexture?.dispose();
    this.target.depthTexture = createDepthTexture(w, h);
    this.target.setSize(w, h);
  }

  capture(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const hidden: VisibilityState[] = [];
    const previousTarget = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    const previousAutoClear = renderer.autoClear;
    const previousToneMapping = renderer.toneMapping;
    const previousClearAlpha = renderer.getClearAlpha();
    const previousClearColor = new THREE.Color();
    renderer.getClearColor(previousClearColor);
    const start = performance.now();

    try {
      scene.traverse((object) => {
        if (!object.visible) return;
        const mesh = object as THREE.Mesh;
        const explicitlyExcluded = object.userData.oceanCapture === "exclude"
          || object.userData.depthPass === "exclude"
          || object.userData.depthPass === false;
        const materials = mesh.isMesh && mesh.material
          ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          : [];
        const transparent = materials.some((material) => material.transparent && material.alphaTest <= 0);
        if (explicitlyExcluded || transparent) {
          hidden.push({ object, visible: object.visible });
          object.visible = false;
        }
      });

      renderer.autoClear = true;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.target);
      renderer.setMRT(this.mrtNode);
      renderer.render(scene, camera);
    } finally {
      renderer.setMRT(previousMrt);
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      renderer.toneMapping = previousToneMapping;
      renderer.setClearColor(previousClearColor, previousClearAlpha);
      for (const state of hidden) state.object.visible = state.visible;
      this.lastCaptureMs = performance.now() - start;
    }
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
  }

  private createTarget(width: number, height: number): THREE.RenderTarget {
    const target = new THREE.RenderTarget(width, height, {
      count: 3,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: createDepthTexture(width, height),
      samples: 0,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter
    });
    // MRTNode resolves attachments by texture name; the primary material
    // output must retain the canonical `output` key.
    target.textures[0].name = "output";
    target.textures[1].name = "sceneNormalRoughness";
    target.textures[2].name = "sceneVelocity";
    // Only radiance needs a mip chain. SSR selects it from ray length and water
    // roughness; geometric validation attachments remain at exact level zero.
    target.textures[0].generateMipmaps = true;
    target.textures[0].minFilter = THREE.LinearMipmapLinearFilter;
    target.textures[1].generateMipmaps = false;
    target.textures[2].generateMipmaps = false;
    target.textures.forEach((texture) => {
      texture.colorSpace = THREE.NoColorSpace;
    });
    return target;
  }
}

function createDepthTexture(width: number, height: number): THREE.DepthTexture {
  const depth = new THREE.DepthTexture(width, height, THREE.FloatType);
  depth.name = "ocean-scene-depth";
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;
  return depth;
}
