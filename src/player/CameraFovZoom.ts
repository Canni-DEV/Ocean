import * as THREE from "three/webgpu";

export const BASE_FOV = 65;
export const ZOOM_FOV = 48;
/** Exponential blend rate so ~0.2 s reaches the target comfortably. */
const ZOOM_LERP_RATE = 12;

export class CameraFovZoom {
  private zoomed = false;

  update(camera: THREE.PerspectiveCamera, secondaryDown: boolean, deltaSeconds: number): void {
    const target = secondaryDown ? ZOOM_FOV : BASE_FOV;
    const next = THREE.MathUtils.damp(camera.fov, target, ZOOM_LERP_RATE, deltaSeconds);
    if (Math.abs(next - camera.fov) > 1e-4) {
      camera.fov = next;
      camera.updateProjectionMatrix();
    } else if (camera.fov !== target) {
      camera.fov = target;
      camera.updateProjectionMatrix();
    }
    this.zoomed = secondaryDown || camera.fov < BASE_FOV - 0.5;
  }

  isZoomActive(): boolean {
    return this.zoomed;
  }

  getLookScale(camera: THREE.PerspectiveCamera): number {
    return camera.fov / BASE_FOV;
  }
}
