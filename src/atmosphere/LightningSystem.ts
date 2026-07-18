import * as THREE from "three/webgpu";
import type { LightningOverride, WeatherState } from "../engine/types";
import type { LightningLightInput } from "./clouds/VolumetricCloudPass";
import { tagOceanLight } from "../ocean/OceanLightRoles";

const MAX_STRIKES = 2;
const BOLT_COLOR = new THREE.Color(0.76, 0.82, 1);
const LIGHTNING_POINT_INTENSITY = 2e4;

type Strike = {
  active: boolean;
  ageSeconds: number;
  lifetimeSeconds: number;
  /** Flicker pulse times within the lifetime. */
  pulses: number[];
  position: THREE.Vector3; // render space, y = bolt top
  bolt: THREE.LineSegments;
  boltMaterial: THREE.LineBasicMaterial;
  light: THREE.PointLight;
  envelope: number;
};

/**
 * Storm lightning: Poisson-scheduled strikes that combine a procedural jagged
 * bolt mesh (cloud base to sea), a point light for ocean specular reflections
 * and in-cloud flash uniforms consumed by the volumetric raymarcher.
 */
export class LightningSystem {
  private readonly strikes: Strike[] = [];
  private readonly rng = mulberry32(0x11cafe);
  private readonly fixedDirection = new THREE.Vector3();
  private readonly fixedPosition = new THREE.Vector3();
  private flash = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX_STRIKES; i += 1) {
      const material = new THREE.LineBasicMaterial({
        color: BOLT_COLOR,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
      });
      const bolt = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      bolt.name = `Lightning bolt ${i}`;
      bolt.frustumCulled = false;
      bolt.renderOrder = 10001; // drawn after the cloud composite
      bolt.visible = false;
      bolt.userData.depthPass = "exclude";
      scene.add(bolt);

      // Persistent light (intensity 0 when idle) avoids pipeline rebuilds
      const light = tagOceanLight(new THREE.PointLight(BOLT_COLOR, 0, 0, 2), "lightning");
      light.name = `Lightning light ${i}`;
      light.userData.depthPass = "exclude";
      scene.add(light);

      this.strikes.push({
        active: false,
        ageSeconds: 0,
        lifetimeSeconds: 0,
        pulses: [],
        position: new THREE.Vector3(),
        bolt,
        boltMaterial: material,
        light,
        envelope: 0
      });
    }
  }

  /** Normalized 0-1 flash amount this frame (for ambient/exposure boosts). */
  get flashIntensity(): number {
    return this.flash;
  }

  update(
    deltaSeconds: number,
    weather: WeatherState,
    camera: THREE.Camera,
    enabled: boolean,
    override: LightningOverride = "weather"
  ): void {
    if (override === "off") {
      this.disableAll();
      return;
    }
    if (override === "fixed") {
      this.applyFixedStrike(camera);
      return;
    }

    // Poisson process: expected strikes/sec from the interpolated weather
    const ratePerSecond = enabled
      ? (weather.lightningRate / 60) * THREE.MathUtils.smoothstep(weather.stormIntensity, 0.45, 1)
      : 0;
    if (ratePerSecond > 0 && this.rng() < 1 - Math.exp(-ratePerSecond * deltaSeconds)) {
      this.spawnStrike(weather, camera);
    }

    this.flash = 0;
    for (const strike of this.strikes) {
      if (!strike.active) continue;
      strike.ageSeconds += deltaSeconds;

      if (strike.ageSeconds >= strike.lifetimeSeconds) {
        strike.active = false;
        strike.envelope = 0;
        strike.bolt.visible = false;
        strike.boltMaterial.opacity = 0;
        strike.light.intensity = 0;
        continue;
      }

      // Sharp attack, fast decay around each pulse
      let envelope = 0;
      for (const pulse of strike.pulses) {
        const dt = strike.ageSeconds - pulse;
        if (dt >= 0) envelope += Math.exp(-dt * 26);
        else envelope += Math.exp(dt * 90);
      }
      strike.envelope = Math.min(1.4, envelope);

      strike.boltMaterial.opacity = THREE.MathUtils.clamp(strike.envelope, 0, 1);
      strike.bolt.visible = strike.boltMaterial.opacity > 0.02;
      strike.light.intensity = strike.envelope * LIGHTNING_POINT_INTENSITY;
      this.flash = Math.max(this.flash, Math.min(1, strike.envelope));
    }
  }

  private disableAll(): void {
    this.flash = 0;
    for (const strike of this.strikes) {
      strike.active = false;
      strike.envelope = 0;
      strike.bolt.visible = false;
      strike.boltMaterial.opacity = 0;
      strike.light.intensity = 0;
    }
  }

  private applyFixedStrike(camera: THREE.Camera): void {
    this.disableAll();
    const strike = this.strikes[0];
    camera.getWorldDirection(this.fixedDirection);
    this.fixedDirection.y = 0;
    if (this.fixedDirection.lengthSq() < 1e-6) this.fixedDirection.set(0, 0, -1);
    this.fixedDirection.normalize();
    this.fixedPosition
      .copy(camera.position)
      .addScaledVector(this.fixedDirection, 1800);
    this.fixedPosition.x -= 500;
    this.fixedPosition.y += 700;
    strike.position.copy(this.fixedPosition);
    strike.light.position.copy(this.fixedPosition);
    strike.active = true;
    strike.envelope = 0.72;
    strike.light.intensity = strike.envelope * LIGHTNING_POINT_INTENSITY;
    this.flash = strike.envelope;
  }

  /** In-cloud flash lights for the volumetric raymarcher (render space). */
  getCloudLights(): LightningLightInput[] {
    const lights: LightningLightInput[] = [];
    for (const strike of this.strikes) {
      if (!strike.active || strike.envelope <= 0.01) continue;
      lights.push({
        position: strike.position,
        color: BOLT_COLOR,
        intensity: strike.envelope * 2.6e7
      });
    }
    return lights;
  }

  dispose(): void {
    for (const strike of this.strikes) {
      strike.bolt.geometry.dispose();
      strike.boltMaterial.dispose();
      strike.bolt.removeFromParent();
      strike.light.removeFromParent();
    }
  }

  private spawnStrike(weather: WeatherState, camera: THREE.Camera): void {
    const slot = this.strikes.find((strike) => !strike.active);
    if (!slot) return;

    const angle = this.rng() * Math.PI * 2;
    const distance = 2200 + this.rng() * 9500;
    const topY = weather.cloudBaseMeters + weather.cloudThicknessMeters * (0.25 + this.rng() * 0.3);
    const x = camera.position.x + Math.cos(angle) * distance;
    const z = camera.position.z + Math.sin(angle) * distance;

    slot.active = true;
    slot.ageSeconds = 0;
    slot.lifetimeSeconds = 0.28 + this.rng() * 0.35;
    const pulseCount = 2 + Math.floor(this.rng() * 3);
    slot.pulses = [0.015];
    for (let i = 1; i < pulseCount; i += 1) {
      slot.pulses.push(0.05 + this.rng() * (slot.lifetimeSeconds - 0.08));
    }
    // Light sits inside the cloud, above the visible bolt top
    slot.position.set(x, weather.cloudBaseMeters + weather.cloudThicknessMeters * 0.4, z);
    slot.light.position.set(x, Math.max(300, weather.cloudBaseMeters * 0.7), z);

    this.rebuildBolt(slot, new THREE.Vector3(x, topY, z));
  }

  /** Midpoint-displacement jagged bolt with a couple of branches. */
  private rebuildBolt(slot: Strike, top: THREE.Vector3): void {
    const positions: number[] = [];

    const buildChannel = (from: THREE.Vector3, to: THREE.Vector3, iterations: number, jag: number): THREE.Vector3[] => {
      let points = [from.clone(), to.clone()];
      for (let it = 0; it < iterations; it += 1) {
        const next: THREE.Vector3[] = [points[0]];
        for (let i = 0; i < points.length - 1; i += 1) {
          const a = points[i];
          const b = points[i + 1];
          const mid = a.clone().add(b).multiplyScalar(0.5);
          const segment = a.distanceTo(b);
          mid.x += (this.rng() - 0.5) * segment * jag;
          mid.z += (this.rng() - 0.5) * segment * jag;
          mid.y += (this.rng() - 0.5) * segment * jag * 0.35;
          next.push(mid, b);
        }
        points = next;
      }
      return points;
    };

    const pushPolyline = (points: THREE.Vector3[]): void => {
      for (let i = 0; i < points.length - 1; i += 1) {
        positions.push(points[i].x, points[i].y, points[i].z);
        positions.push(points[i + 1].x, points[i + 1].y, points[i + 1].z);
      }
    };

    const ground = new THREE.Vector3(
      top.x + (this.rng() - 0.5) * top.y * 0.5,
      0,
      top.z + (this.rng() - 0.5) * top.y * 0.5
    );
    const main = buildChannel(top, ground, 6, 0.36);
    pushPolyline(main);

    const branchCount = 1 + Math.floor(this.rng() * 2);
    for (let b = 0; b < branchCount; b += 1) {
      const originIndex = Math.floor(main.length * (0.25 + this.rng() * 0.45));
      const origin = main[originIndex];
      const branchEnd = origin
        .clone()
        .add(
          new THREE.Vector3(
            (this.rng() - 0.5) * origin.y * 0.9,
            -origin.y * (0.35 + this.rng() * 0.4),
            (this.rng() - 0.5) * origin.y * 0.9
          )
        );
      pushPolyline(buildChannel(origin, branchEnd, 4, 0.42));
    }

    slot.bolt.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    slot.bolt.geometry = geometry;
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
