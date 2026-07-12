import type { InputActionSnapshot } from "../gameplay/types";

export type BoatControlState = {
  throttle: number;
  rudder: number;
};

const INPUT_RESPONSE = 5.5;
const THROTTLE_RATE_PER_SECOND = 0.6;

export class BoatController {
  private throttle = 0;
  private rudder = 0;

  update(deltaSeconds: number, input: InputActionSnapshot | null, active: boolean, engineRunning: boolean): BoatControlState {
    if (active && input) {
      this.throttle = Math.max(-1, Math.min(1, this.throttle + input.forward * THROTTLE_RATE_PER_SECOND * deltaSeconds));
      if (Math.abs(this.throttle) < 0.025 && input.forward === 0) this.throttle = 0;
    }
    const targetRudder = active && input ? input.right : 0;
    const blend = 1 - Math.exp(-deltaSeconds * INPUT_RESPONSE);
    this.rudder += (targetRudder - this.rudder) * blend;

    return {
      throttle: engineRunning ? this.throttle : 0,
      rudder: this.rudder
    };
  }

  neutralize(): void {
    this.throttle = 0;
  }

  dispose(): void {}
}
