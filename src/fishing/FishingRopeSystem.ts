import * as THREE from "three/webgpu";
import type { MeshBVH } from "three-mesh-bvh";
import type { OceanPhysicsSampler } from "../ocean/OceanPhysicsSampler";
import type { FishingControlRig } from "./FishingControlRig";
import { RopeRenderer, type RopeRenderMode } from "./RopeRenderer";
import { VerletRope, type VerletRopeConfig } from "./VerletRope";

export type FishingRopeSettings = {
  enabled: boolean;
  minLengthM: number;
  maxLengthM: number;
  initialLengthM: number;
  reelSpeedMs: number;
  ropeRadius: number;
  renderMode: RopeRenderMode;
  segmentCount: number;
};

export type FishingRopeMetrics = {
  paidOutLengthM: number;
  ropeTension: number;
};

const DEFAULT_SEGMENT_COUNT = 28;
const WEIGHT_RADIUS_M = 0.05;

export class FishingRopeSystem {
  readonly group = new THREE.Group();

  private fishingRig: FishingControlRig | null = null;
  private rope: VerletRope | null = null;
  private renderer: RopeRenderer | null = null;
  private readonly anchor = new THREE.Vector3();
  private settings: FishingRopeSettings;
  private bound = false;

  constructor(settings: FishingRopeSettings) {
    this.settings = { ...settings };
    this.group.name = "Fishing rope system";
  }

  bind(rig: FishingControlRig | null, boatGroup: THREE.Group): void {
    this.fishingRig = rig;
    this.bound = rig !== null;
    if (!rig) return;

    rig.pulleySocket.updateMatrixWorld(true);
    rig.pulleySocket.getWorldPosition(this.anchor);

    const config = this.buildVerletConfig();
    this.rope = new VerletRope(config, this.anchor);

    if (!this.renderer) {
      this.renderer = new RopeRenderer({
        radius: this.settings.ropeRadius,
        renderMode: this.settings.renderMode,
        radialSegments: 8,
        tubularSegments: Math.max(16, this.settings.segmentCount),
        weightRadius: WEIGHT_RADIUS_M
      });
      this.group.add(this.renderer.group);
    } else {
      this.syncRendererConfig();
    }

    boatGroup.updateMatrixWorld(true);
  }

  isBound(): boolean {
    return this.bound && this.rope !== null;
  }

  applySettings(settings: Partial<FishingRopeSettings>): void {
    const previous = this.settings;
    const next: FishingRopeSettings = {
      ...this.settings,
      ...settings,
      minLengthM: settings.minLengthM ?? this.settings.minLengthM,
      maxLengthM: settings.maxLengthM ?? this.settings.maxLengthM,
      initialLengthM: settings.initialLengthM ?? this.settings.initialLengthM
    };

    next.maxLengthM = Math.max(next.maxLengthM, next.minLengthM);
    next.initialLengthM = THREE.MathUtils.clamp(
      next.initialLengthM,
      next.minLengthM,
      next.maxLengthM
    );

    this.settings = next;
    this.syncRendererConfig();
    this.syncRopeConfig(previous);
  }

  update(
    deltaSeconds: number,
    ctx: {
      reel: number;
      boatGroup: THREE.Group;
      originOffset: { x: number; z: number };
      sampler: OceanPhysicsSampler | null;
      collider: MeshBVH | null;
    }
  ): FishingRopeMetrics | null {
    if (!this.settings.enabled || !this.fishingRig || !this.rope || !this.renderer) {
      return null;
    }

    this.fishingRig.pulleySocket.getWorldPosition(this.anchor);

    this.rope.update({
      anchor: this.anchor,
      reel: ctx.reel,
      deltaSeconds,
      originOffset: ctx.originOffset,
      sampler: ctx.sampler,
      boatGroup: ctx.boatGroup,
      collider: ctx.collider
    });

    this.renderer.update(this.rope.getPositions());

    return {
      paidOutLengthM: this.rope.getPaidOutLength(),
      ropeTension: this.rope.getAverageTension()
    };
  }

  applyOriginShift(shiftX: number, shiftZ: number): void {
    this.rope?.applyOriginShift(shiftX, shiftZ);
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.rope = null;
    this.fishingRig = null;
    this.bound = false;
    this.group.removeFromParent();
  }

  private syncRendererConfig(): void {
    this.renderer?.setConfig({
      radius: this.settings.ropeRadius,
      renderMode: this.settings.renderMode,
      weightRadius: WEIGHT_RADIUS_M
    });
  }

  private syncRopeConfig(previous: FishingRopeSettings): void {
    if (!this.rope) return;

    this.rope.applyRuntimeConfig({
      minLengthM: this.settings.minLengthM,
      maxLengthM: this.settings.maxLengthM,
      reelSpeedMs: this.settings.reelSpeedMs,
      weightRadiusM: WEIGHT_RADIUS_M
    });

    const lengthLimitsChanged = previous.minLengthM !== this.settings.minLengthM
      || previous.maxLengthM !== this.settings.maxLengthM;
    const initialLengthChanged = previous.initialLengthM !== this.settings.initialLengthM;

    if (initialLengthChanged) {
      this.rope.setPaidOutLength(this.settings.initialLengthM);
    } else if (lengthLimitsChanged) {
      this.rope.setPaidOutLength(this.rope.getPaidOutLength());
    }
  }

  private buildVerletConfig(): VerletRopeConfig {
    return {
      segmentCount: this.settings.segmentCount || DEFAULT_SEGMENT_COUNT,
      minLengthM: this.settings.minLengthM,
      maxLengthM: Math.max(this.settings.maxLengthM, this.settings.minLengthM),
      initialLengthM: THREE.MathUtils.clamp(
        this.settings.initialLengthM,
        this.settings.minLengthM,
        Math.max(this.settings.maxLengthM, this.settings.minLengthM)
      ),
      reelSpeedMs: this.settings.reelSpeedMs,
      nodeRadiusM: 0.03,
      weightRadiusM: WEIGHT_RADIUS_M,
      weightMassRatio: 4
    };
  }
}
