import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameplayInputRouter } from "./GameplayInputRouter";

let canvas: HTMLCanvasElement;

function dispatchKey(type: "keydown" | "keyup", code: string, repeat = false): void {
  const event = new Event(type);
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: repeat }
  });
  window.dispatchEvent(event);
}

beforeEach(() => {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget() as EventTarget & {
    pointerLockElement: Element | null;
    visibilityState: DocumentVisibilityState;
  };
  canvas = new EventTarget() as unknown as HTMLCanvasElement;
  documentTarget.pointerLockElement = canvas;
  documentTarget.visibilityState = "visible";
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal("document", documentTarget);
});

afterEach(() => vi.unstubAllGlobals());

describe("GameplayInputRouter", () => {
  it("routes E and F to independent one-frame actions and ignores repeats", () => {
    const router = new GameplayInputRouter(canvas);
    dispatchKey("keydown", "KeyE");
    dispatchKey("keydown", "KeyF");
    expect(router.consumeFrame()).toMatchObject({ interactPressed: true, flashlightPressed: true });
    expect(router.consumeFrame()).toMatchObject({ interactPressed: false, flashlightPressed: false });
    dispatchKey("keydown", "KeyF", true);
    expect(router.consumeFrame().flashlightPressed).toBe(false);
    router.dispose();
  });

  it("gates actions without pointer lock and clears held movement on blur", () => {
    const router = new GameplayInputRouter(canvas);
    dispatchKey("keydown", "KeyE");
    (document as unknown as { pointerLockElement: Element | null }).pointerLockElement = null;
    expect(router.consumeFrame().interactPressed).toBe(false);
    (document as unknown as { pointerLockElement: Element | null }).pointerLockElement = canvas;
    dispatchKey("keydown", "KeyW");
    expect(router.consumeFrame().forward).toBe(1);
    window.dispatchEvent(new Event("blur"));
    expect(router.consumeFrame().forward).toBe(0);
    router.dispose();
  });

  it("tracks secondary hold independently of primary and clears on unlock", () => {
    const router = new GameplayInputRouter(canvas);
    canvas.dispatchEvent(Object.assign(new Event("mousedown"), { button: 2 }));
    expect(router.consumeFrame()).toMatchObject({ secondaryDown: true, primaryDown: false });
    canvas.dispatchEvent(Object.assign(new Event("mousedown"), { button: 0 }));
    expect(router.consumeFrame()).toMatchObject({
      secondaryDown: true,
      primaryDown: true,
      primaryPressed: true
    });
    window.dispatchEvent(Object.assign(new Event("mouseup"), { button: 0 }));
    expect(router.consumeFrame()).toMatchObject({
      secondaryDown: true,
      primaryDown: false,
      primaryReleased: true
    });
    (document as unknown as { pointerLockElement: Element | null }).pointerLockElement = null;
    document.dispatchEvent(new Event("pointerlockchange"));
    expect(router.consumeFrame().secondaryDown).toBe(false);
    router.dispose();
  });

  it("prevents the browser context menu on the canvas", () => {
    const router = new GameplayInputRouter(canvas);
    const event = new Event("contextmenu", { cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    router.dispose();
  });
});
