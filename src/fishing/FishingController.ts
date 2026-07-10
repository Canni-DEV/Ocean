import * as THREE from "three/webgpu";
import {
  BOOM_ELEVATION_DEFAULT_RAD,
  BOOM_ELEVATION_MAX_RAD,
  BOOM_ELEVATION_MIN_RAD
} from "./FishingBoomAssemblyRig";

export type FishingControlState = {
  reel: number;
  boomElevationRad: number;
};

const INPUT_RESPONSE = 5.5;
const BOOM_SPEED_RAD_PER_SEC = THREE.MathUtils.degToRad(22);

export class FishingController {
  private readonly keys: Record<string, boolean> = {};
  private disposed = false;
  private reel = 0;
  private boomInput = 0;
  private boomElevationRad = BOOM_ELEVATION_DEFAULT_RAD;

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

    this.boomElevationRad = THREE.MathUtils.clamp(
      this.boomElevationRad + this.boomInput * BOOM_SPEED_RAD_PER_SEC * deltaSeconds,
      BOOM_ELEVATION_MIN_RAD,
      BOOM_ELEVATION_MAX_RAD
    );

    return {
      reel: this.reel,
      boomElevationRad: this.boomElevationRad
    };
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
