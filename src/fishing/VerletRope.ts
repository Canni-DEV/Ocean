import * as THREE from "three/webgpu";
import type { MeshBVH } from "three-mesh-bvh";
import type { OceanPhysicsSampler } from "../ocean/OceanPhysicsSampler";

export type VerletRopeConfig = {
  segmentCount: number;
  minLengthM: number;
  maxLengthM: number;
  initialLengthM: number;
  reelSpeedMs: number;
  nodeRadiusM: number;
  weightRadiusM: number;
  weightMassRatio: number;
};

export type VerletRopeUpdateContext = {
  anchor: THREE.Vector3;
  reel: number;
  deltaSeconds: number;
  originOffset: { x: number; z: number };
  sampler: OceanPhysicsSampler | null;
  boatGroup: THREE.Group;
  collider: MeshBVH | null;
};

const GRAVITY = 9.81;
const SUBSTEP_COUNT = 6;
const WATER_DRAG = 3.5;
const WATER_BUOYANCY = 8;
const AIR_DRAG = 0.15;
const REEL_PULL_STRENGTH = 12;
const MAX_COLLISION_ITERATIONS = 2;

type Particle = {
  position: THREE.Vector3;
  previous: THREE.Vector3;
  inverseMass: number;
  pinned: boolean;
};

export class VerletRope {
  private readonly particles: Particle[] = [];
  private readonly tempLocal = new THREE.Vector3();
  private readonly tempBox = new THREE.Box3();
  private readonly scratchClosest = new THREE.Vector3();
  private readonly scratchDelta = new THREE.Vector3();
  private paidOutLength: number;
  private tensionAccumulator = 0;
  private tensionSamples = 0;

  constructor(private config: VerletRopeConfig, anchor: THREE.Vector3) {
    this.paidOutLength = THREE.MathUtils.clamp(
      config.initialLengthM,
      config.minLengthM,
      config.maxLengthM
    );

    const segmentRest = this.paidOutLength / config.segmentCount;
    for (let i = 0; i <= config.segmentCount; i += 1) {
      const t = i / config.segmentCount;
      const position = anchor.clone().add(new THREE.Vector3(0, -t * this.paidOutLength, 0));
      const isAnchor = i === 0;
      const isWeight = i === config.segmentCount;
      this.particles.push({
        position,
        previous: position.clone(),
        inverseMass: isAnchor ? 0 : isWeight ? 1 / config.weightMassRatio : 1,
        pinned: isAnchor
      });
      if (i > 0) {
        const prev = this.particles[i - 1].position;
        const dir = position.clone().sub(prev);
        if (dir.lengthSq() > 1e-8) {
          dir.normalize().multiplyScalar(segmentRest);
          position.copy(prev).add(dir);
          this.particles[i].previous.copy(position);
        }
      }
    }
  }

  getPaidOutLength(): number {
    return this.paidOutLength;
  }

  getAverageTension(): number {
    return this.tensionSamples > 0 ? this.tensionAccumulator / this.tensionSamples : 0;
  }

  getPositions(): ReadonlyArray<THREE.Vector3> {
    return this.particles.map((particle) => particle.position);
  }

  getWeightPosition(): THREE.Vector3 {
    return this.particles[this.particles.length - 1].position;
  }

  applyOriginShift(shiftX: number, shiftZ: number): void {
    for (const particle of this.particles) {
      particle.position.x -= shiftX;
      particle.position.z -= shiftZ;
      particle.previous.x -= shiftX;
      particle.previous.z -= shiftZ;
    }
  }

  applyRuntimeConfig(
    partial: Pick<VerletRopeConfig, "minLengthM" | "maxLengthM" | "reelSpeedMs" | "weightRadiusM">
  ): void {
    if (partial.minLengthM !== undefined) {
      this.config.minLengthM = partial.minLengthM;
    }
    if (partial.maxLengthM !== undefined) {
      this.config.maxLengthM = Math.max(partial.maxLengthM, this.config.minLengthM);
    }
    if (partial.reelSpeedMs !== undefined) {
      this.config.reelSpeedMs = partial.reelSpeedMs;
    }
    if (partial.weightRadiusM !== undefined) {
      this.config.weightRadiusM = partial.weightRadiusM;
    }
    this.paidOutLength = THREE.MathUtils.clamp(
      this.paidOutLength,
      this.config.minLengthM,
      this.config.maxLengthM
    );
  }

  setPaidOutLength(lengthM: number): void {
    this.paidOutLength = THREE.MathUtils.clamp(
      lengthM,
      this.config.minLengthM,
      this.config.maxLengthM
    );
  }

  update(ctx: VerletRopeUpdateContext): void {
    const {
      anchor,
      reel,
      deltaSeconds,
      originOffset,
      sampler,
      boatGroup,
      collider
    } = ctx;

    this.tensionAccumulator = 0;
    this.tensionSamples = 0;

    const reelDelta = reel * this.config.reelSpeedMs * deltaSeconds;
    this.paidOutLength = THREE.MathUtils.clamp(
      this.paidOutLength + reelDelta,
      this.config.minLengthM,
      this.config.maxLengthM
    );

    const substepDt = deltaSeconds / SUBSTEP_COUNT;
    const segmentRest = this.paidOutLength / this.config.segmentCount;

    for (let step = 0; step < SUBSTEP_COUNT; step += 1) {
      this.particles[0].position.copy(anchor);
      this.particles[0].previous.copy(anchor);

      for (let i = 1; i < this.particles.length; i += 1) {
        const particle = this.particles[i];
        if (particle.pinned) continue;

        const velocity = particle.position.clone().sub(particle.previous);
        velocity.multiplyScalar(1 - AIR_DRAG * substepDt);
        particle.previous.copy(particle.position);

        particle.position.add(velocity);
        particle.position.y -= GRAVITY * substepDt * substepDt;

        this.applyWaterForces(particle, originOffset, sampler, substepDt);
      }

      for (let iteration = 0; iteration < 3; iteration += 1) {
        this.solveDistanceConstraints(segmentRest);
      }

      if (reel < -0.05) {
        this.applyReelPull(anchor, -reel, substepDt);
      }

      if (collider) {
        for (let i = 1; i < this.particles.length; i += 1) {
          const radius = i === this.particles.length - 1
            ? this.config.weightRadiusM
            : this.config.nodeRadiusM;
          this.resolveHullCollision(this.particles[i], radius, boatGroup, collider);
        }
      }
    }
  }

  private applyWaterForces(
    particle: Particle,
    originOffset: { x: number; z: number },
    sampler: OceanPhysicsSampler | null,
    dt: number
  ): void {
    if (!sampler?.isReady()) return;

    const worldX = particle.position.x + originOffset.x;
    const worldZ = particle.position.z + originOffset.z;
    const waterHeight = sampler.getHeightAt(worldX, worldZ);
    if (waterHeight === null) return;

    const submersion = waterHeight - particle.position.y;
    if (submersion <= 0) return;

    particle.position.y += submersion * WATER_BUOYANCY * dt;
    const velocityX = particle.position.x - particle.previous.x;
    const velocityZ = particle.position.z - particle.previous.z;
    particle.position.x -= velocityX * WATER_DRAG * dt;
    particle.position.z -= velocityZ * WATER_DRAG * dt;
  }

  private solveDistanceConstraints(restLength: number): void {
    for (let i = 0; i < this.particles.length - 1; i += 1) {
      const a = this.particles[i];
      const b = this.particles[i + 1];
      const delta = b.position.clone().sub(a.position);
      const distance = delta.length();
      if (distance < 1e-6) continue;

      const error = distance - restLength;
      this.tensionAccumulator += Math.abs(error);
      this.tensionSamples += 1;

      delta.divideScalar(distance);
      const totalInvMass = a.inverseMass + b.inverseMass;
      if (totalInvMass <= 0) continue;

      const correction = (error / totalInvMass) * 0.5;
      if (!a.pinned) {
        a.position.addScaledVector(delta, correction * a.inverseMass);
      }
      if (!b.pinned) {
        b.position.addScaledVector(delta, -correction * b.inverseMass);
      }
    }
  }

  private applyReelPull(anchor: THREE.Vector3, reelStrength: number, dt: number): void {
    const weight = this.particles[this.particles.length - 1];
    const pull = anchor.clone().sub(weight.position);
    const distance = pull.length();
    if (distance < 1e-4) return;
    pull.divideScalar(distance);
    weight.position.addScaledVector(pull, REEL_PULL_STRENGTH * reelStrength * dt);
  }

  private resolveHullCollision(
    particle: Particle,
    radius: number,
    boatGroup: THREE.Group,
    collider: MeshBVH
  ): void {
    this.tempLocal.copy(particle.position);
    boatGroup.worldToLocal(this.tempLocal);

    for (let iteration = 0; iteration < MAX_COLLISION_ITERATIONS; iteration += 1) {
      this.tempBox.makeEmpty();
      this.tempBox.expandByPoint(this.tempLocal);
      this.tempBox.min.addScalar(-radius);
      this.tempBox.max.addScalar(radius);

      let hadCollision = false;

      collider.shapecast({
        intersectsBounds: (box) => box.intersectsBox(this.tempBox),
        intersectsTriangle: (triangle) => {
          triangle.closestPointToPoint(this.tempLocal, this.scratchClosest);
          this.scratchDelta.subVectors(this.tempLocal, this.scratchClosest);
          const distance = this.scratchDelta.length();
          if (distance >= radius) return;

          hadCollision = true;
          const depth = radius - distance;
          if (distance < 1e-8) {
            this.scratchDelta.set(0, 1, 0);
          } else {
            this.scratchDelta.divideScalar(distance);
          }
          this.tempLocal.addScaledVector(this.scratchDelta, depth);
        }
      });

      if (!hadCollision) break;
    }

    boatGroup.localToWorld(this.tempLocal);
    particle.position.copy(this.tempLocal);
  }
}
