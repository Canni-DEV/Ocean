import * as THREE from "three/webgpu";
import type { InputActionSnapshot } from "../gameplay/types";

export class InputController {
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.1, 100000);

  private yaw = 0;
  private pitch = -0.2;
  private enabled = true;

  constructor(_canvas: HTMLCanvasElement) {
    this.camera.position.set(0, 16, 44);
    this.syncRotation();
  }

  update(deltaSeconds: number, input: InputActionSnapshot): void {
    if (!this.enabled) return;

    this.yaw -= input.lookDeltaX * 0.002;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.lookDeltaY * 0.002, -1.45, 1.25);
    this.syncRotation();

    const boost = input.boost ? 4 : 1;
    const speed = 22 * boost;
    const distance = speed * deltaSeconds;

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const movement = new THREE.Vector3();

    movement.addScaledVector(forward, input.forward);
    movement.addScaledVector(right, input.right);
    movement.y += input.vertical;

    if (movement.lengthSq() > 0) {
      movement.normalize().multiplyScalar(distance);
      this.camera.position.add(movement);
      this.camera.position.y = Math.max(1.5, this.camera.position.y);
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  getYawPitchDeg(): { yawDeg: number; pitchDeg: number } {
    return {
      yawDeg: THREE.MathUtils.radToDeg(this.yaw),
      pitchDeg: THREE.MathUtils.radToDeg(this.pitch)
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setViewOrientation(yawRad: number, pitchRad: number): void {
    this.yaw = yawRad;
    this.pitch = pitchRad;
    this.syncRotation();
  }

  dispose(): void {}

  private syncRotation(): void {
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = 0;
  }
}
