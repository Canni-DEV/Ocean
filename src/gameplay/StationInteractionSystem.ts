import * as THREE from "three/webgpu";
import type { CockpitRig, StationZoneDescriptor } from "../boat/CockpitRig";
import type { StationId } from "./types";

const ACQUIRE_HALF_ANGLE_RAD = THREE.MathUtils.degToRad(60);
const RETAIN_HALF_ANGLE_RAD = THREE.MathUtils.degToRad(65);
const EXIT_MARGIN_M = 0.1;

export type StationCandidate = { station: StationId; distance: number; alignment: number };

export class StationInteractionSystem {
  private activeStation: StationId | null = null;
  private readonly playerWorld = new THREE.Vector3();
  private readonly localPosition = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private readonly targetWorld = new THREE.Vector3();
  private readonly worldScale = new THREE.Vector3();

  update(camera: THREE.Camera, rig: CockpitRig | null, enabled: boolean): StationCandidate | null {
    if (!rig || !enabled) {
      this.activeStation = null;
      return null;
    }

    camera.getWorldPosition(this.playerWorld);
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 0, -1);
    else this.forward.normalize();

    const candidates: StationCandidate[] = [];
    for (const zone of rig.getStationZones()) {
      const retaining = zone.id === this.activeStation;
      const candidate = this.evaluateZone(zone, retaining);
      if (candidate) candidates.push(candidate);
    }
    candidates.sort((a, b) => b.alignment - a.alignment || a.distance - b.distance);
    const selected = candidates[0] ?? null;
    this.activeStation = selected?.station ?? null;
    return selected;
  }

  clear(): void {
    this.activeStation = null;
  }

  private evaluateZone(zone: StationZoneDescriptor, retaining: boolean): StationCandidate | null {
    this.localPosition.copy(this.playerWorld);
    zone.volume.worldToLocal(this.localPosition);
    zone.volume.getWorldScale(this.worldScale);
    const minScale = Math.max(1e-4, Math.min(this.worldScale.x, this.worldScale.y, this.worldScale.z));
    const margin = retaining ? EXIT_MARGIN_M / minScale : 0;
    const halfX = zone.size.x * 0.5 + margin;
    const halfY = zone.size.y * 0.5 + margin;
    const halfZ = zone.size.z * 0.5 + margin;
    if (
      Math.abs(this.localPosition.x) > halfX ||
      Math.abs(this.localPosition.y) > halfY ||
      Math.abs(this.localPosition.z) > halfZ
    ) return null;

    zone.facingTarget.getWorldPosition(this.targetWorld);
    this.toTarget.subVectors(this.targetWorld, this.playerWorld);
    this.toTarget.y = 0;
    const distance = this.toTarget.length();
    if (distance < 1e-5) return null;
    this.toTarget.divideScalar(distance);
    const alignment = this.forward.dot(this.toTarget);
    const threshold = Math.cos(retaining ? RETAIN_HALF_ANGLE_RAD : ACQUIRE_HALF_ANGLE_RAD);
    return alignment >= threshold ? { station: zone.id, distance, alignment } : null;
  }
}
