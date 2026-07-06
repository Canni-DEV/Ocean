export type BoatControlState = {
  throttle: number;
  rudder: number;
};

const INPUT_RESPONSE = 5.5;

export class BoatController {
  private readonly keys: Record<string, boolean> = {};
  private disposed = false;
  private throttle = 0;
  private rudder = 0;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  update(deltaSeconds: number): BoatControlState {
    const targetThrottle = (this.keys.KeyI ? 1 : 0) + (this.keys.KeyK ? -1 : 0);
    const targetRudder = (this.keys.KeyL ? 1 : 0) + (this.keys.KeyJ ? -1 : 0);
    const blend = 1 - Math.exp(-deltaSeconds * INPUT_RESPONSE);

    this.throttle += (targetThrottle - this.throttle) * blend;
    this.rudder += (targetRudder - this.rudder) * blend;

    return {
      throttle: this.throttle,
      rudder: this.rudder
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
