import type { GameplayMode, InputActionSnapshot } from "./types";

export class GameplayInputRouter {
  private readonly canvas: HTMLCanvasElement;
  private readonly keys = new Set<string>();
  private mode: GameplayMode = "walking";
  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private wheelSteps = 0;
  private interactPressed = false;
  private flashlightPressed = false;
  private primaryPressed = false;
  private primaryReleased = false;
  private primaryDown = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clearHeldInput);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("mousedown", this.onMouseDown);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  setMode(mode: GameplayMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.clearHeldInput();
  }

  getMode(): GameplayMode {
    return this.mode;
  }

  consumeFrame(): InputActionSnapshot {
    const pointerLocked = document.pointerLockElement === this.canvas;
    const snapshot: InputActionSnapshot = {
      forward: pointerLocked ? (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0) : 0,
      right: pointerLocked ? (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0) : 0,
      vertical: pointerLocked ? (this.keys.has("Space") ? 1 : 0) - (this.keys.has("KeyC") ? 1 : 0) : 0,
      boost: pointerLocked && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")),
      interactPressed: pointerLocked && this.interactPressed,
      flashlightPressed: pointerLocked && this.flashlightPressed,
      primaryPressed: this.primaryPressed,
      primaryReleased: this.primaryReleased,
      primaryDown: this.primaryDown,
      wheelSteps: this.wheelSteps,
      lookDeltaX: this.lookDeltaX,
      lookDeltaY: this.lookDeltaY,
      pointerLocked
    };
    this.interactPressed = false;
    this.flashlightPressed = false;
    this.primaryPressed = false;
    this.primaryReleased = false;
    this.wheelSteps = 0;
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    return snapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clearHeldInput);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "KeyE" && !event.repeat) this.interactPressed = true;
    if (event.code === "KeyF" && !event.repeat) this.flashlightPressed = true;
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.canvas) return;
    this.lookDeltaX += event.movementX;
    this.lookDeltaY += event.movementY;
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock();
      return;
    }
    this.primaryDown = true;
    this.primaryPressed = true;
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.primaryDown = false;
    this.primaryReleased = true;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (document.pointerLockElement !== this.canvas) return;
    event.preventDefault();
    this.wheelSteps += Math.sign(event.deltaY);
  };

  private readonly onPointerLockChange = (): void => {
    if (document.pointerLockElement !== this.canvas) this.clearHeldInput();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") this.clearHeldInput();
  };

  private readonly clearHeldInput = (): void => {
    this.keys.clear();
    this.primaryDown = false;
    this.primaryReleased = true;
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
  };
}
