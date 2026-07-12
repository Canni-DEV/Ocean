import * as THREE from "three/webgpu";
import {
  clampBoomElevationRad,
  getBoomElevationDefaultRad
} from "./boomElevationLimits";

export type FishingControlState = {
  reel: number;
  boom: number;
  boomElevationRad: number;
};

const INPUT_RESPONSE = 5.5;
const BOOM_SPEED_RAD_PER_SEC = THREE.MathUtils.degToRad(22);

export class FishingController {
  private readonly keys: Record<string, boolean> = {};
  private disposed = false;
  private reel = 0;
  private boomInput = 0;
  private boomElevationRad = getBoomElevationDefaultRad();

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  update(deltaSeconds: number): FishingControlState {
    const targetReel = (this.keys.KeyU ? 1 : 0) + (this.keys.KeyP ? -1 : 0);
    const targetBoom = (this.keys.KeyY ? 1 : 0) + (this.keys.KeyH ? -1 : 0);
    const blend = 1 - Math.exp(-deltaSeconds * INPUT_RESPONSE);

    this.reel += (targetReel - this.reel) * blend;
    this.boomInput += (targetBoom - this.boomInput) * blend;

    this.boomElevationRad = clampBoomElevationRad(
      this.boomElevationRad + this.boomInput * BOOM_SPEED_RAD_PER_SEC * deltaSeconds
    );

    return {
      reel: this.reel,
      boom: this.boomInput,
      boomElevationRad: this.boomElevationRad
    };
  }

  applyBoomLimits(): void {
    this.boomElevationRad = clampBoomElevationRad(this.boomElevationRad);
  }

  setBoomElevationRad(angleRad: number): void {
    this.boomElevationRad = clampBoomElevationRad(angleRad);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.keys[event.code] = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys[event.code] = false;
  };
}
