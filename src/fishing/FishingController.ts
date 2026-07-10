export type FishingControlState = {
  reel: number;
};

const INPUT_RESPONSE = 5.5;

export class FishingController {
  private readonly keys: Record<string, boolean> = {};
  private disposed = false;
  private reel = 0;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  update(deltaSeconds: number): FishingControlState {
    const targetReel = (this.keys.KeyU ? 1 : 0) + (this.keys.KeyP ? -1 : 0);
    const blend = 1 - Math.exp(-deltaSeconds * INPUT_RESPONSE);
    this.reel += (targetReel - this.reel) * blend;

    return { reel: this.reel };
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
