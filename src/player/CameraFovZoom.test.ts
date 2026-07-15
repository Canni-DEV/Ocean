import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { BASE_FOV, CameraFovZoom, ZOOM_FOV } from "./CameraFovZoom";

describe("CameraFovZoom", () => {
  it("lerps toward zoom FOV while held and back when released", () => {
    const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1000);
    const zoom = new CameraFovZoom();

    zoom.update(camera, true, 0.05);
    expect(camera.fov).toBeLessThan(BASE_FOV);
    expect(camera.fov).toBeGreaterThan(ZOOM_FOV);

    for (let i = 0; i < 40; i++) zoom.update(camera, true, 0.05);
    expect(camera.fov).toBeCloseTo(ZOOM_FOV, 1);
    expect(zoom.isZoomActive()).toBe(true);
    expect(zoom.getLookScale(camera)).toBeCloseTo(ZOOM_FOV / BASE_FOV, 2);

    for (let i = 0; i < 40; i++) zoom.update(camera, false, 0.05);
    expect(camera.fov).toBeCloseTo(BASE_FOV, 1);
    expect(zoom.isZoomActive()).toBe(false);
  });
});
