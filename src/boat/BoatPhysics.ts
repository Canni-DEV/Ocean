import * as THREE from "three/webgpu";
import type { WeatherState } from "../engine/types";
import type { OceanPhysicsSampler } from "../ocean/OceanPhysicsSampler";
import type { BoatControlState } from "./BoatController";

export type BoatConfig = {
  lengthMeters: number;
  beamMeters: number;
  hullHeightMeters: number;
  draftMeters: number;
  massKg: number;
  maxEngineForceN: number;
  maxReverseForceN: number;
  rudderForceN: number;
  windForceCoefficient: number;
  waterDragCoefficient: number;
  verticalDampingCoefficient: number;
  linearDamping: number;
  angularDamping: number;
  capsizeUpDotThreshold: number;
  maxForceN: number;
  maxTorqueNm: number;
  maxLinearSpeedMs: number;
  maxAngularSpeedRad: number;
  maxSimulationDistanceMeters: number;
};

export type BoatPhysicsMetrics = {
  position: { x: number; y: number; z: number };
  speedMs: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  throttle: number;
  rudder: number;
  capsized: boolean;
  waterHeightM: number | null;
};

export type BoatUpdateOptions = {
  deltaSeconds: number;
  control: BoatControlState;
  sampler: OceanPhysicsSampler | null;
  weather: WeatherState;
  originOffsetMeters: { x: number; z: number };
};

const GRAVITY_MS2 = 9.81;
const MAX_STEP_SECONDS = 1 / 120;

export const DEFAULT_BOAT_CONFIG: BoatConfig = {
  lengthMeters: 8,
  beamMeters: 2.6,
  hullHeightMeters: 1,
  draftMeters: 0.45,
  massKg: 2500,
  maxEngineForceN: 5600,
  maxReverseForceN: 2600,
  rudderForceN: 7600,
  windForceCoefficient: 18,
  waterDragCoefficient: 880,
  verticalDampingCoefficient: 1900,
  linearDamping: 0.22,
  angularDamping: 1.35,
  capsizeUpDotThreshold: 0.16,
  maxForceN: 90000,
  maxTorqueNm: 180000,
  maxLinearSpeedMs: 32,
  maxAngularSpeedRad: 3.5,
  maxSimulationDistanceMeters: 10000
};

type ForceApplication = {
  force: THREE.Vector3;
  worldPointOffset: THREE.Vector3;
};

export class BoatPhysics {
  readonly position = new THREE.Vector3(0, 0.22, 0);
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly angularVelocity = new THREE.Vector3();

  private readonly config: BoatConfig;
  private readonly inertiaLocal: THREE.Vector3;
  private readonly inverseInertiaLocal: THREE.Vector3;
  private readonly buoyancyPoints: THREE.Vector3[];
  private readonly forceAccumulator = new THREE.Vector3();
  private readonly torqueAccumulator = new THREE.Vector3();
  private lastControl: BoatControlState = { throttle: 0, rudder: 0 };
  private waterHeightAtCenter: number | null = null;
  private capsized = false;

  constructor(config: BoatConfig = DEFAULT_BOAT_CONFIG) {
    this.config = config;
    this.inertiaLocal = new THREE.Vector3(
      (config.massKg / 12) * (config.hullHeightMeters ** 2 + config.lengthMeters ** 2),
      (config.massKg / 12) * (config.beamMeters ** 2 + config.lengthMeters ** 2),
      (config.massKg / 12) * (config.beamMeters ** 2 + config.hullHeightMeters ** 2)
    );
    this.inverseInertiaLocal = new THREE.Vector3(
      1 / this.inertiaLocal.x,
      1 / this.inertiaLocal.y,
      1 / this.inertiaLocal.z
    );
    this.buoyancyPoints = this.createBuoyancyPoints();
  }

  resetToWorldOrigin(originOffsetMeters: { x: number; z: number }, waterHeight: number | null): void {
    const safeWaterHeight = isFiniteNumber(waterHeight) ? waterHeight : 0;
    this.position.set(
      -originOffsetMeters.x,
      safeWaterHeight + this.config.draftMeters * 0.45,
      -originOffsetMeters.z
    );
    this.quaternion.identity();
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.capsized = false;
    this.waterHeightAtCenter = safeWaterHeight;
    this.lastControl = { throttle: 0, rudder: 0 };
  }

  applyOriginShift(shiftX: number, shiftZ: number): void {
    if (!isFiniteNumber(shiftX) || !isFiniteNumber(shiftZ)) return;
    this.position.x -= shiftX;
    this.position.z -= shiftZ;
  }

  update(options: BoatUpdateOptions): void {
    this.lastControl = options.control;
    if (!this.hasFiniteState()) {
      this.resetToWorldOrigin(options.originOffsetMeters, null);
    }

    if (!options.sampler?.isReady()) {
      return;
    }

    const centerWorldX = this.position.x + options.originOffsetMeters.x;
    const centerWorldZ = this.position.z + options.originOffsetMeters.z;
    if (!isFiniteNumber(centerWorldX) || !isFiniteNumber(centerWorldZ)) {
      this.resetToWorldOrigin(options.originOffsetMeters, null);
      return;
    }

    this.waterHeightAtCenter = this.sampleHeight(options.sampler, centerWorldX, centerWorldZ);

    let remaining = Math.min(options.deltaSeconds, 0.1);
    while (remaining > 0) {
      const step = Math.min(MAX_STEP_SECONDS, remaining);
      this.integrateStep(step, options);
      if (!this.hasFiniteState() || this.isOutOfSimulationBounds(options.originOffsetMeters)) {
        this.resetToWorldOrigin(options.originOffsetMeters, this.waterHeightAtCenter);
        return;
      }
      remaining -= step;
    }
  }

  getMetrics(originOffsetMeters: { x: number; z: number }): BoatPhysicsMetrics {
    const euler = new THREE.Euler().setFromQuaternion(this.quaternion, "YXZ");
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
    const headingDeg = THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z));

    return {
      position: {
        x: this.position.x + originOffsetMeters.x,
        y: this.position.y,
        z: this.position.z + originOffsetMeters.z
      },
      speedMs: this.velocity.length(),
      headingDeg,
      pitchDeg: THREE.MathUtils.radToDeg(euler.x),
      rollDeg: THREE.MathUtils.radToDeg(euler.z),
      throttle: this.lastControl.throttle,
      rudder: this.lastControl.rudder,
      capsized: this.capsized,
      waterHeightM: this.waterHeightAtCenter
    };
  }

  private integrateStep(deltaSeconds: number, options: BoatUpdateOptions): void {
    if (!isFiniteNumber(deltaSeconds) || deltaSeconds <= 0) return;

    this.forceAccumulator.set(0, -this.config.massKg * GRAVITY_MS2, 0);
    this.torqueAccumulator.set(0, 0, 0);

    this.applyBuoyancy(options.sampler, options.originOffsetMeters);
    this.applyEngineAndRudder(options.control);
    this.applyWind(options.weather);
    this.applyGlobalDamping();

    const acceleration = this.forceAccumulator.multiplyScalar(1 / this.config.massKg);
    if (!isFiniteVector(acceleration) || !isFiniteVector(this.torqueAccumulator)) return;

    this.velocity.addScaledVector(acceleration, deltaSeconds);
    clampVectorLength(this.velocity, this.config.maxLinearSpeedMs);
    this.position.addScaledVector(this.velocity, deltaSeconds);

    const angularAcceleration = this.worldTorqueToAngularAcceleration(this.torqueAccumulator);
    if (!isFiniteVector(angularAcceleration)) return;

    this.angularVelocity.addScaledVector(angularAcceleration, deltaSeconds);
    this.angularVelocity.multiplyScalar(Math.exp(-this.config.angularDamping * deltaSeconds));
    clampVectorLength(this.angularVelocity, this.config.maxAngularSpeedRad);
    this.integrateOrientation(deltaSeconds);

    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
    if (up.y < this.config.capsizeUpDotThreshold) {
      this.capsized = true;
    }
  }

  private applyBuoyancy(
    sampler: OceanPhysicsSampler | null,
    originOffsetMeters: { x: number; z: number }
  ): void {
    if (!sampler) return;

    const pointMaxBuoyancy =
      (this.config.massKg * GRAVITY_MS2 * 1.85) / this.buoyancyPoints.length;

    for (const localPoint of this.buoyancyPoints) {
      const offset = localPoint.clone().applyQuaternion(this.quaternion);
      const pointWorld = this.position.clone().add(offset);
      const sampleX = pointWorld.x + originOffsetMeters.x;
      const sampleZ = pointWorld.z + originOffsetMeters.z;
      if (!isFiniteVector(offset) || !isFiniteVector(pointWorld)) continue;

      const waterHeight = this.sampleHeight(sampler, sampleX, sampleZ);
      if (waterHeight === null) continue;

      const normalSample = sampler.getNormalAt(sampleX, sampleZ);
      const normal = this.buildSafeNormal(normalSample);
      const submergedMeters = waterHeight - pointWorld.y;
      if (!isFiniteNumber(submergedMeters) || submergedMeters <= 0) continue;

      const submerged = THREE.MathUtils.clamp(submergedMeters / this.config.draftMeters, 0, 1.35);
      if (!isFiniteNumber(submerged)) continue;

      this.applyForce({
        force: normal.multiplyScalar(pointMaxBuoyancy * submerged),
        worldPointOffset: offset
      });

      const pointVelocity = this.velocity.clone().add(this.angularVelocity.clone().cross(offset));
      if (!isFiniteVector(pointVelocity)) continue;

      const verticalVelocity = normal
        .clone()
        .multiplyScalar(THREE.MathUtils.clamp(pointVelocity.dot(normal), -18, 18));
      const drag = pointVelocity
        .clone()
        .clampLength(0, 24)
        .multiplyScalar(-this.config.waterDragCoefficient * submerged)
        .add(verticalVelocity.multiplyScalar(-this.config.verticalDampingCoefficient * submerged));
      this.applyForce({ force: drag, worldPointOffset: offset });
    }
  }

  private applyEngineAndRudder(control: BoatControlState): void {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion);
    if (!isFiniteVector(forward) || !isFiniteVector(side)) return;

    const throttle = this.capsized ? 0 : control.throttle;
    const forceMagnitude =
      throttle >= 0
        ? throttle * this.config.maxEngineForceN
        : throttle * this.config.maxReverseForceN;
    const sternOffset = new THREE.Vector3(0, -this.config.draftMeters * 0.45, this.config.lengthMeters * 0.38)
      .applyQuaternion(this.quaternion);

    this.applyForce({
      force: forward.multiplyScalar(forceMagnitude),
      worldPointOffset: sternOffset
    });

    const forwardSpeed = this.velocity.dot(new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion));
    if (!isFiniteNumber(forwardSpeed)) return;

    const steeringSpeed = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / 5, 0, 1);
    const rudderSign = forwardSpeed >= 0 ? -1 : 1;
    const rudderForce = side.multiplyScalar(
      control.rudder * rudderSign * this.config.rudderForceN * steeringSpeed * (this.capsized ? 0 : 1)
    );
    this.applyForce({ force: rudderForce, worldPointOffset: sternOffset });
  }

  private applyWind(weather: WeatherState): void {
    if (!isFiniteNumber(weather.windDirectionRad) || !isFiniteNumber(weather.windSpeedMs)) return;

    const windVelocity = new THREE.Vector3(
      Math.cos(weather.windDirectionRad) * weather.windSpeedMs,
      0,
      Math.sin(weather.windDirectionRad) * weather.windSpeedMs
    );
    const boatHorizontalVelocity = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const relativeWind = windVelocity.sub(boatHorizontalVelocity);
    const windSpeed = relativeWind.length();
    if (!isFiniteNumber(windSpeed) || windSpeed < 0.01) return;

    const projectedArea = this.config.lengthMeters * this.config.hullHeightMeters;
    const windForce = relativeWind
      .normalize()
      .multiplyScalar(windSpeed * windSpeed * this.config.windForceCoefficient * projectedArea * 0.08);
    const applicationOffset = new THREE.Vector3(0, this.config.hullHeightMeters * 0.45, 0)
      .applyQuaternion(this.quaternion);
    this.applyForce({ force: windForce, worldPointOffset: applicationOffset });
  }

  private applyGlobalDamping(): void {
    const horizontalVelocity = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    if (!isFiniteVector(horizontalVelocity)) return;

    this.forceAccumulator.addScaledVector(
      horizontalVelocity,
      -this.config.massKg * this.config.linearDamping
    );
  }

  private applyForce(application: ForceApplication): void {
    if (!isFiniteVector(application.force) || !isFiniteVector(application.worldPointOffset)) return;

    const force = application.force.clone().clampLength(0, this.config.maxForceN);
    const torque = application.worldPointOffset.clone().cross(force).clampLength(0, this.config.maxTorqueNm);
    this.forceAccumulator.add(force);
    this.torqueAccumulator.add(torque);
  }

  private worldTorqueToAngularAcceleration(worldTorque: THREE.Vector3): THREE.Vector3 {
    if (!isFiniteVector(worldTorque) || !isFiniteQuaternion(this.quaternion)) {
      return new THREE.Vector3();
    }

    const inverseRotation = this.quaternion.clone().invert();
    const localTorque = worldTorque.clone().applyQuaternion(inverseRotation);
    localTorque.set(
      localTorque.x * this.inverseInertiaLocal.x,
      localTorque.y * this.inverseInertiaLocal.y,
      localTorque.z * this.inverseInertiaLocal.z
    );
    return localTorque.applyQuaternion(this.quaternion);
  }

  private integrateOrientation(deltaSeconds: number): void {
    const angularSpeed = this.angularVelocity.length();
    if (!isFiniteNumber(angularSpeed) || angularSpeed < 1e-5) return;

    const axis = this.angularVelocity.clone().multiplyScalar(1 / angularSpeed);
    const deltaRotation = new THREE.Quaternion().setFromAxisAngle(axis, angularSpeed * deltaSeconds);
    this.quaternion.premultiply(deltaRotation).normalize();
  }

  private sampleHeight(sampler: OceanPhysicsSampler, worldX: number, worldZ: number): number | null {
    if (!isFiniteNumber(worldX) || !isFiniteNumber(worldZ)) return null;

    const height = sampler.getHeightAt(worldX, worldZ);
    return isFiniteNumber(height) ? height : null;
  }

  private buildSafeNormal(normal: { x: number; y: number; z: number } | null): THREE.Vector3 {
    if (!normal || !isFiniteNumber(normal.x) || !isFiniteNumber(normal.y) || !isFiniteNumber(normal.z)) {
      return new THREE.Vector3(0, 1, 0);
    }

    const vector = new THREE.Vector3(normal.x, normal.y, normal.z);
    return vector.lengthSq() > 1e-8 ? vector.normalize() : new THREE.Vector3(0, 1, 0);
  }

  private hasFiniteState(): boolean {
    return (
      isFiniteVector(this.position) &&
      isFiniteVector(this.velocity) &&
      isFiniteVector(this.angularVelocity) &&
      isFiniteQuaternion(this.quaternion)
    );
  }

  private isOutOfSimulationBounds(originOffsetMeters: { x: number; z: number }): boolean {
    const absoluteX = this.position.x + originOffsetMeters.x;
    const absoluteZ = this.position.z + originOffsetMeters.z;
    return (
      !isFiniteNumber(absoluteX) ||
      !isFiniteNumber(this.position.y) ||
      !isFiniteNumber(absoluteZ) ||
      Math.abs(absoluteX) > this.config.maxSimulationDistanceMeters ||
      Math.abs(this.position.y) > this.config.maxSimulationDistanceMeters ||
      Math.abs(absoluteZ) > this.config.maxSimulationDistanceMeters
    );
  }

  private createBuoyancyPoints(): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    const halfBeam = this.config.beamMeters * 0.38;
    const y = -this.config.draftMeters;
    const longitudinal = [-0.38, -0.16, 0.08, 0.32];
    const lateral = [-1, 0, 1];

    for (const zFactor of longitudinal) {
      for (const xFactor of lateral) {
        const bowTaper = zFactor < -0.25 ? 0.72 : 1;
        points.push(new THREE.Vector3(xFactor * halfBeam * bowTaper, y, zFactor * this.config.lengthMeters));
      }
    }

    return points;
  }
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteVector(vector: THREE.Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFiniteQuaternion(quaternion: THREE.Quaternion): boolean {
  return (
    Number.isFinite(quaternion.x) &&
    Number.isFinite(quaternion.y) &&
    Number.isFinite(quaternion.z) &&
    Number.isFinite(quaternion.w)
  );
}

function clampVectorLength(vector: THREE.Vector3, maxLength: number): void {
  const lengthSq = vector.lengthSq();
  if (!Number.isFinite(lengthSq)) {
    vector.set(0, 0, 0);
    return;
  }

  if (lengthSq > maxLength * maxLength) {
    vector.multiplyScalar(maxLength / Math.sqrt(lengthSq));
  }
}
