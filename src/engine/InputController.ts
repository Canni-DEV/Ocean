import * as THREE from "three/webgpu";

type KeyState = Record<string, boolean>;

export class InputController {
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.1, 100000);

  private readonly canvas: HTMLCanvasElement;
  private readonly keys: KeyState = {};
  private yaw = 0;
  private pitch = -0.2;
  private disposed = false;
  private enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera.position.set(0, 16, 44);
    this.syncRotation();

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("click", this.onCanvasClick);
  }

  update(deltaSeconds: number): void {
    if (!this.enabled) return;

    const boost = this.keys.ShiftLeft || this.keys.ShiftRight ? 4 : 1;
    const speed = 22 * boost;
    const distance = speed * deltaSeconds;

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const movement = new THREE.Vector3();

    if (this.keys.KeyW) movement.add(forward);
    if (this.keys.KeyS) movement.sub(forward);
    if (this.keys.KeyA) movement.sub(right);
    if (this.keys.KeyD) movement.add(right);
    if (this.keys.Space) movement.y += 1;
    if (this.keys.KeyC) movement.y -= 1;

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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("click", this.onCanvasClick);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.keys[event.code] = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys[event.code] = false;
  };

  private readonly onCanvasClick = (): void => {
    void this.canvas.requestPointerLock();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;

    this.yaw -= event.movementX * 0.002;
    this.pitch -= event.movementY * 0.002;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.45, 1.25);
    this.syncRotation();
  };

  private syncRotation(): void {
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = 0;
  }
}
