import * as THREE from "three/webgpu";

type MaterialState = {
  colorWrite: boolean;
};

type MeshMaterialState = {
  mesh: THREE.Mesh;
  material: THREE.Material | THREE.Material[];
};

type VisibilityState = {
  object: THREE.Object3D;
  visible: boolean;
};

/**
 * Captures physical scene depth. Meshes may provide a lightweight
 * `customDepthMaterial`; other meshes keep their production material so custom
 * vertex transforms remain exact. Color writes are disabled in both cases.
 */
export class SceneDepthPass {
  private readonly target: THREE.RenderTarget;
  private width = 1;
  private height = 1;

  constructor() {
    this.target = this.createTarget(1, 1);
  }

  get texture(): THREE.DepthTexture {
    return this.target.depthTexture as THREE.DepthTexture;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;
    this.target.depthTexture = new THREE.DepthTexture(w, h);
    this.target.depthTexture.name = "scene-depth-prepass";
    this.target.setSize(w, h);
  }

  capture(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const visibilityStates: VisibilityState[] = [];
    const materialStates = new Map<THREE.Material, MaterialState>();
    const meshMaterialStates: MeshMaterialState[] = [];
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;

    try {
      scene.traverse((object) => {
        if (object.userData.depthPass === false || object.userData.depthPass === "exclude") {
          visibilityStates.push({ object, visible: object.visible });
          object.visible = false;
          return;
        }
        if (!object.visible) return;

        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;

        if (mesh.customDepthMaterial) {
          meshMaterialStates.push({ mesh, material: mesh.material });
          mesh.material = mesh.customDepthMaterial;
        }

        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (!materialStates.has(material)) {
            materialStates.set(material, { colorWrite: material.colorWrite });
          }
          material.colorWrite = false;
        }
      });

      renderer.autoClear = true;
      renderer.setRenderTarget(this.target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;

      for (const state of meshMaterialStates) {
        state.mesh.material = state.material;
      }
      for (const [material, state] of materialStates) {
        material.colorWrite = state.colorWrite;
      }
      for (const state of visibilityStates) {
        state.object.visible = state.visible;
      }
    }
  }

  dispose(): void {
    this.target.dispose();
    this.target.depthTexture?.dispose();
  }

  private createTarget(width: number, height: number): THREE.RenderTarget {
    const depthTexture = new THREE.DepthTexture(width, height);
    depthTexture.name = "scene-depth-prepass";

    // Explicit samples: 0 keeps this prepass non-MSAA. Cloud composite shaders
    // sample it as a regular depth texture; matching the canvas MSAA sample
    // count would require texture_depth_multisampled_2d and is unsupported here.
    const target = new THREE.RenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
      samples: 0,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter
    });
    target.texture.name = "scene-depth-prepass-color";
    return target;
  }
}
