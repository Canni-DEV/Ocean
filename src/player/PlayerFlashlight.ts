import * as THREE from "three/webgpu";
import type { QualityTier } from "../engine/types";
import type { FlashlightLevel, FlashlightState } from "../gameplay/types";
import { tagOceanLight } from "../ocean/OceanLightRoles";

export type FlashlightConfig = {
  capacitySeconds: number;
  rechargeSeconds: number;
  intensityCd: number;
  rangeM: number;
  halfAngleDeg: number;
  penumbra: number;
  lowThreshold: number;
  criticalThreshold: number;
};

export type FlashlightCue = "toggle" | "empty" | "charged";

const SPILL_INTENSITY = 24;

export class FlashlightBattery {
  private config: FlashlightConfig;
  private charge01 = 1;
  private powered = false;
  private charging = false;
  private poweredElapsedS = 0;
  private cue: FlashlightCue | null = null;

  constructor(config: FlashlightConfig) {
    this.config = normalizeConfig(config);
  }

  applyConfig(config: FlashlightConfig): void {
    this.config = normalizeConfig(config);
  }

  toggle(): boolean {
    if (!this.powered && this.charge01 <= 0) {
      this.cue = "empty";
      return false;
    }
    this.powered = !this.powered;
    this.charging = false;
    this.cue = "toggle";
    return true;
  }

  update(deltaSeconds: number, chargingAllowed: boolean, paused: boolean): void {
    if (paused || deltaSeconds <= 0) {
      this.charging = false;
      return;
    }

    if (this.powered) {
      this.poweredElapsedS += deltaSeconds;
      this.charge01 = Math.max(0, this.charge01 - deltaSeconds / this.config.capacitySeconds);
      this.charging = false;
      if (this.charge01 <= 0) {
        this.powered = false;
        this.cue = "empty";
      }
      return;
    }

    this.charging = chargingAllowed && this.charge01 < 1;
    if (this.charging) {
      const wasIncomplete = this.charge01 < 1;
      this.charge01 = Math.min(1, this.charge01 + deltaSeconds / this.config.rechargeSeconds);
      if (wasIncomplete && this.charge01 >= 1) {
        this.charging = false;
        this.cue = "charged";
      }
    }
  }

  refill(): void {
    const wasIncomplete = this.charge01 < 1;
    this.charge01 = 1;
    this.charging = false;
    if (wasIncomplete) this.cue = "charged";
  }

  consumeCue(): FlashlightCue | null {
    const cue = this.cue;
    this.cue = null;
    return cue;
  }

  getState(): FlashlightState {
    return {
      powered: this.powered,
      charge01: this.charge01,
      charging: this.charging,
      level: this.getLevel()
    };
  }

  getIntensityFactor(): number {
    if (!this.powered || this.charge01 <= 0) return 0;
    const { lowThreshold, criticalThreshold } = this.config;
    let factor = 1;
    if (this.charge01 < lowThreshold) {
      const span = Math.max(1e-4, lowThreshold - criticalThreshold);
      factor = THREE.MathUtils.lerp(0.7, 1, THREE.MathUtils.clamp((this.charge01 - criticalThreshold) / span, 0, 1));
    }
    if (this.charge01 <= criticalThreshold && this.poweredElapsedS % 1.28 < 0.08) return 0;
    return factor;
  }

  private getLevel(): FlashlightLevel {
    if (this.charge01 <= 0) return "empty";
    if (this.charge01 <= this.config.criticalThreshold) return "critical";
    if (this.charge01 <= this.config.lowThreshold) return "low";
    return "normal";
  }
}

export class PlayerFlashlight {
  private readonly group = new THREE.Group();
  // Intensity 0 when idle keeps lights in the WebGPU light set (avoids pipeline rebuilds on toggle / critical flicker).
  private readonly spotlight = tagOceanLight(
    new THREE.SpotLight(0xffdfc4, 0, 55, THREE.MathUtils.degToRad(16), 0.5, 2),
    "flashlight-spot"
  );
  private readonly spill = tagOceanLight(new THREE.PointLight(0xffe5cc, 0, 4, 2), "flashlight-spill");
  private readonly target = new THREE.Object3D();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraQuaternion = new THREE.Quaternion();
  private readonly battery: FlashlightBattery;
  private config: FlashlightConfig;
  private active = false;
  private contributionFactor = 0;
  private quality: QualityTier | null = null;

  constructor(scene: THREE.Scene, config: FlashlightConfig, quality: QualityTier) {
    this.config = normalizeConfig(config);
    this.battery = new FlashlightBattery(this.config);
    this.group.name = "Player flashlight";
    this.spotlight.name = "Player flashlight beam";
    this.target.name = "Player flashlight target";
    this.target.position.set(0, 0, -1);
    this.spotlight.target = this.target;
    this.spotlight.position.set(0.035, -0.025, -0.04);
    this.spill.position.set(0, -0.04, -0.12);
    // No spotlight.map cookie: WebGPU SpotLightNode keeps unmodulated light outside the
    // projected UV square, which draws a bright screen-aligned rectangle. Cone + penumbra only.
    this.spotlight.map = null;
    this.group.visible = true;
    this.group.add(this.spotlight, this.spill, this.target);
    scene.add(this.group);
    this.applyConfig(config);
    this.setQuality(quality);
    this.syncLightContribution(0);
  }

  applyConfig(config: FlashlightConfig): void {
    this.config = normalizeConfig(config);
    this.battery.applyConfig(this.config);
    this.spotlight.distance = this.config.rangeM;
    this.spotlight.angle = THREE.MathUtils.degToRad(this.config.halfAngleDeg);
    this.spotlight.penumbra = this.config.penumbra;
    this.spotlight.decay = 2;
    this.spotlight.shadow.camera.near = 0.05;
    this.spotlight.shadow.camera.far = this.config.rangeM;
    this.spotlight.shadow.bias = -0.00035;
    this.spotlight.shadow.normalBias = 0.025;
    this.spotlight.shadow.camera.updateProjectionMatrix();
    this.applyContributionIntensities();
  }

  setQuality(quality: QualityTier): void {
    if (quality === this.quality) return;
    this.quality = quality;
    // Keep castShadow stable for the tier so shadow membership is compiled at load / quality change, not on first F.
    this.spotlight.castShadow = quality !== "low";
    const mapSize = quality === "high" ? 2048 : 1024;
    this.spotlight.shadow.mapSize.set(mapSize, mapSize);
    this.spotlight.shadow.map?.dispose();
    this.spotlight.shadow.map = null;
  }

  toggle(): boolean {
    return this.battery.toggle();
  }

  refill(): void {
    this.battery.refill();
  }

  update(options: {
    deltaSeconds: number;
    camera: THREE.Camera;
    active: boolean;
    chargingAllowed: boolean;
    paused: boolean;
  }): void {
    this.active = options.active;
    this.battery.update(options.deltaSeconds, options.chargingAllowed, options.paused);
    options.camera.getWorldPosition(this.cameraPosition);
    options.camera.getWorldQuaternion(this.cameraQuaternion);
    this.group.position.copy(this.cameraPosition);
    this.group.quaternion.copy(this.cameraQuaternion);
    this.group.updateMatrixWorld(true);
    this.syncLightContribution(this.battery.getIntensityFactor());
  }

  getState(): FlashlightState {
    return this.battery.getState();
  }

  consumeCue(): FlashlightCue | null {
    return this.battery.consumeCue();
  }

  dispose(): void {
    this.spotlight.shadow.map?.dispose();
    this.group.removeFromParent();
  }

  private syncLightContribution(intensityFactor: number): void {
    this.contributionFactor = this.active ? intensityFactor : 0;
    this.applyContributionIntensities();
  }

  private applyContributionIntensities(): void {
    this.spotlight.intensity = this.config.intensityCd * this.contributionFactor;
    this.spill.intensity = SPILL_INTENSITY * this.contributionFactor;
  }
}

function normalizeConfig(config: FlashlightConfig): FlashlightConfig {
  const lowThreshold = THREE.MathUtils.clamp(config.lowThreshold, 0.02, 0.95);
  const criticalThreshold = THREE.MathUtils.clamp(config.criticalThreshold, 0.01, lowThreshold - 0.01);
  return {
    capacitySeconds: THREE.MathUtils.clamp(config.capacitySeconds, 5 * 60, 120 * 60),
    rechargeSeconds: THREE.MathUtils.clamp(config.rechargeSeconds, 60, 60 * 60),
    intensityCd: THREE.MathUtils.clamp(config.intensityCd, 100, 2500),
    rangeM: THREE.MathUtils.clamp(config.rangeM, 10, 100),
    halfAngleDeg: THREE.MathUtils.clamp(config.halfAngleDeg, 8, 35),
    penumbra: THREE.MathUtils.clamp(config.penumbra, 0, 1),
    lowThreshold,
    criticalThreshold
  };
}
