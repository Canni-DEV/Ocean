import * as THREE from "three/webgpu";
import type { InputActionSnapshot } from "../gameplay/types";
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
  private reel = 0;
  private boomInput = 0;
  private boomElevationRad = getBoomElevationDefaultRad();

  update(deltaSeconds: number, input: InputActionSnapshot | null, active: boolean): FishingControlState {
    const targetReel = active && input ? -input.right : 0;
    const targetBoom = active && input ? input.forward : 0;
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

  dispose(): void {}
}
