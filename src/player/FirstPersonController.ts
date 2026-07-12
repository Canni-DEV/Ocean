import * as THREE from "three/webgpu";
import { MeshBVH } from "three-mesh-bvh";
import type { InputActionSnapshot } from "../gameplay/types";

const WALK_SPEED_MS = 2.2;
const EYE_HEIGHT_M = 1.3;
const CAPSULE_RADIUS_M = 0.1;
const CAPSULE_HEIGHT_M = 1.4;
const GRAVITY_MS2 = 28;
const MAX_COLLISION_ITERATIONS = 6;
/** Contact offset kept between the capsule and geometry to avoid jitter/tunneling. */
const SKIN_WIDTH_M = 0.03;
/** Effective radius used for collision resolution (radius + skin). */
const COLLISION_RADIUS_M = CAPSULE_RADIUS_M + SKIN_WIDTH_M;
/** Max displacement per collision sub-step; smaller than radius to prevent tunneling. */
const MAX_SUBSTEP_M = CAPSULE_RADIUS_M * 0.5;
/** Contact normal.y above this counts as walkable ground. */
const WALKABLE_NORMAL_Y = 0.35;
/** Distance the controller will snap down to stick to ground on slopes/steps. */
const GROUND_SNAP_DISTANCE_M = 0.35;
const MOUSE_SENSITIVITY = 0.002;
const PITCH_MIN = -1.45;
const PITCH_MAX = 1.25;

export type FirstPersonMetrics = {
  localX: number;
  localY: number;
  localZ: number;
  yawDeg: number;
  pitchDeg: number;
  onGround: boolean;
};

export class FirstPersonController {
  readonly localPosition = new THREE.Vector3();

  private readonly camera: THREE.PerspectiveCamera;
  private readonly capsuleSegment = new THREE.Line3();
  private readonly tempVector = new THREE.Vector3();
  private readonly tempVector2 = new THREE.Vector3();
  private readonly tempBox = new THREE.Box3();
  private readonly worldPosition = new THREE.Vector3();
  private readonly worldQuaternion = new THREE.Quaternion();
  private readonly lookQuaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly downRay = new THREE.Ray();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3(0, -1, 0);
  private readonly displacement = new THREE.Vector3();
  private readonly subStep = new THREE.Vector3();
  private readonly segmentStartBefore = new THREE.Vector3();
  private readonly correction = new THREE.Vector3();
  private readonly safeWalkingPosition = new THREE.Vector3();

  private yaw = 0;
  private pitch = 0;
  private verticalVelocity = 0;
  private onGround = false;
  private wasOnGround = false;
  private enabled = false;
  private hasSafeWalkingPosition = false;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    void canvas;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.verticalVelocity = 0;
      this.onGround = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  spawnOnDeck(bvh: MeshBVH, spawnHint: THREE.Vector3): void {
    this.yaw = 0;
    this.pitch = 0;
    this.verticalVelocity = 0;
    this.onGround = false;

    const rayStart = spawnHint.clone();
    rayStart.y += 6;
    this.rayOrigin.copy(rayStart);
    this.downRay.set(this.rayOrigin, this.rayDirection);

    const hit = bvh.raycastFirst(this.downRay);
    if (hit) {
      this.localPosition.copy(hit.point);
    } else {
      this.localPosition.copy(spawnHint);
    }
    this.safeWalkingPosition.copy(this.localPosition);
    this.hasSafeWalkingPosition = true;
  }

  /** Preserve a collider-validated walking pose before the camera moves to a station socket. */
  enterStation(): void {
    if (!this.hasSafeWalkingPosition) {
      this.safeWalkingPosition.copy(this.localPosition);
      this.hasSafeWalkingPosition = true;
    }
    this.verticalVelocity = 0;
  }

  /**
   * Station sockets are camera poses, not valid capsule poses. Restore the last
   * grounded walking pose before collision/gravity ownership resumes.
   */
  exitStation(bvh?: MeshBVH): void {
    if (this.hasSafeWalkingPosition) this.localPosition.copy(this.safeWalkingPosition);
    this.verticalVelocity = 0;
    this.wasOnGround = true;
    this.onGround = true;
    if (bvh) this.resolvePenetration(bvh);
  }

  update(
    deltaSeconds: number,
    boatGroup: THREE.Group,
    bvh: MeshBVH,
    input?: InputActionSnapshot,
    allowMovement = true,
    stationPosition?: THREE.Vector3 | null
  ): void {
    if (!this.enabled || deltaSeconds <= 0) return;

    if (input?.pointerLocked) {
      this.yaw -= input.lookDeltaX * MOUSE_SENSITIVITY;
      this.pitch = THREE.MathUtils.clamp(this.pitch - input.lookDeltaY * MOUSE_SENSITIVITY, PITCH_MIN, PITCH_MAX);
    }

    if (stationPosition) {
      const blend = 1 - Math.exp(-deltaSeconds * 14);
      this.localPosition.lerp(stationPosition, blend);
      this.verticalVelocity = 0;
      this.onGround = true;
      this.syncCamera(boatGroup);
      return;
    }

    const forward = this.tempVector.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = this.tempVector2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.displacement.set(0, 0, 0);

    if (allowMovement && input) {
      this.displacement.addScaledVector(forward, input.forward);
      this.displacement.addScaledVector(right, input.right);
    }

    if (this.displacement.lengthSq() > 0) {
      this.displacement.normalize().multiplyScalar(WALK_SPEED_MS * deltaSeconds);
    }

    this.verticalVelocity -= GRAVITY_MS2 * deltaSeconds;
    this.displacement.y += this.verticalVelocity * deltaSeconds;

    this.wasOnGround = this.onGround;
    this.moveWithCollisions(bvh);
    this.applyGroundSnap(bvh);

    if (allowMovement && this.onGround) {
      this.safeWalkingPosition.copy(this.localPosition);
      this.hasSafeWalkingPosition = true;
    }

    this.syncCamera(boatGroup);
  }

  getMetrics(): FirstPersonMetrics {
    return {
      localX: this.localPosition.x,
      localY: this.localPosition.y,
      localZ: this.localPosition.z,
      yawDeg: THREE.MathUtils.radToDeg(this.yaw),
      pitchDeg: THREE.MathUtils.radToDeg(this.pitch),
      onGround: this.onGround
    };
  }

  dispose(): void {
    // Input ownership lives in GameplayInputRouter.
  }

  /**
   * Collide-and-slide: applies the frame displacement split into small
   * sub-steps (to avoid tunneling through thin geometry like railings) and
   * resolves capsule penetration in full 3D after each sub-step.
   */
  private moveWithCollisions(bvh: MeshBVH): void {
    this.onGround = false;

    const distance = this.displacement.length();
    if (distance < 1e-6) {
      this.resolvePenetration(bvh);
      return;
    }

    const steps = Math.max(1, Math.ceil(distance / MAX_SUBSTEP_M));
    this.subStep.copy(this.displacement).divideScalar(steps);

    for (let i = 0; i < steps; i += 1) {
      this.localPosition.add(this.subStep);
      this.resolvePenetration(bvh);
    }

    if (this.onGround && this.verticalVelocity < 0) {
      this.verticalVelocity = 0;
    }
  }

  /** Iteratively pushes the capsule out of any geometry it penetrates. */
  private resolvePenetration(bvh: MeshBVH): void {
    for (let iteration = 0; iteration < MAX_COLLISION_ITERATIONS; iteration += 1) {
      const hadCollision = this.capsuleIntersect(bvh);
      if (!hadCollision) break;
    }
  }

  private capsuleIntersect(bvh: MeshBVH): boolean {
    const capsuleBottom = COLLISION_RADIUS_M;
    const capsuleTop = CAPSULE_HEIGHT_M - COLLISION_RADIUS_M;
    this.capsuleSegment.start.set(
      this.localPosition.x,
      this.localPosition.y + capsuleBottom,
      this.localPosition.z
    );
    this.capsuleSegment.end.set(
      this.localPosition.x,
      this.localPosition.y + capsuleTop,
      this.localPosition.z
    );

    this.tempBox.makeEmpty();
    this.tempBox.expandByPoint(this.capsuleSegment.start);
    this.tempBox.expandByPoint(this.capsuleSegment.end);
    this.tempBox.min.addScalar(-COLLISION_RADIUS_M);
    this.tempBox.max.addScalar(COLLISION_RADIUS_M);

    this.segmentStartBefore.copy(this.capsuleSegment.start);
    let hadCollision = false;

    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(this.tempBox),
      intersectsTriangle: (triangle) => {
        const triPoint = this.tempVector;
        const capsulePoint = this.tempVector2;
        const distance = triangle.closestPointToSegment(this.capsuleSegment, triPoint, capsulePoint);
        if (distance >= COLLISION_RADIUS_M) return;

        hadCollision = true;
        const depth = COLLISION_RADIUS_M - distance;
        const direction = capsulePoint.sub(triPoint);
        if (direction.lengthSq() < 1e-8) {
          direction.set(0, 1, 0);
        } else {
          direction.normalize();
        }

        if (direction.y > WALKABLE_NORMAL_Y) {
          this.onGround = true;
          if (this.verticalVelocity < 0) this.verticalVelocity = 0;
        }

        this.capsuleSegment.start.addScaledVector(direction, depth);
        this.capsuleSegment.end.addScaledVector(direction, depth);
      }
    });

    if (!hadCollision) return false;

    // Apply the FULL 3D correction (x/y/z), not just the vertical component,
    // so walls and railings actually stop the player.
    this.correction.subVectors(this.capsuleSegment.start, this.segmentStartBefore);
    this.localPosition.add(this.correction);

    return true;
  }

  /**
   * Keeps the player glued to the deck when walking down slopes/steps by
   * casting a short ray down and snapping to the surface if within range.
   */
  private applyGroundSnap(bvh: MeshBVH): void {
    if (this.onGround || !this.wasOnGround || this.verticalVelocity > 0) return;

    this.rayOrigin.set(
      this.localPosition.x,
      this.localPosition.y + COLLISION_RADIUS_M,
      this.localPosition.z
    );
    this.downRay.set(this.rayOrigin, this.rayDirection);

    const hit = bvh.raycastFirst(this.downRay);
    if (!hit) return;

    const drop = this.rayOrigin.y - hit.point.y - COLLISION_RADIUS_M;
    if (drop >= 0 && drop <= GROUND_SNAP_DISTANCE_M) {
      this.localPosition.y = hit.point.y;
      this.onGround = true;
      this.verticalVelocity = 0;
      this.resolvePenetration(bvh);
    }
  }

  private syncCamera(boatGroup: THREE.Group): void {
    this.worldPosition.set(
      this.localPosition.x,
      this.localPosition.y + EYE_HEIGHT_M,
      this.localPosition.z
    );
    boatGroup.localToWorld(this.worldPosition);
    this.camera.position.copy(this.worldPosition);

    this.euler.set(this.pitch, this.yaw, 0);
    this.lookQuaternion.setFromEuler(this.euler);
    this.worldQuaternion.copy(boatGroup.quaternion).multiply(this.lookQuaternion);
    this.camera.quaternion.copy(this.worldQuaternion);
  }

}
