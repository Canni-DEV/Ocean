import * as THREE from "three/webgpu";
import {
  Fn,
  cos,
  exp,
  float,
  instanceIndex,
  mx_noise_float,
  smoothstep,
  step,
  texture,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec2,
  vec4
} from "three/tsl";
import type { BoatWaterInteractionState } from "../boat/BoatPhysics";
import type { DebugSettings, QualityTier } from "../engine/types";

type NodeRef = any;
type AnyUniform<T> = any & { value: T };

const QUALITY_RESOLUTION: Record<QualityTier, number> = {
  low: 128,
  medium: 192,
  high: 256
};

const QUALITY_SIZE_METERS: Record<QualityTier, number> = {
  low: 96,
  medium: 112,
  high: 128
};

const HULL_WAKE_SPEED_START_MS = 0.8;
const HULL_WAKE_SPEED_FULL_MS = 7.5;
const HISTORY_RESET_DISTANCE_RATIO = 0.1;

type BoatWaterInteractionUniforms = {
  origin: AnyUniform<THREE.Vector2>;
  previousOrigin: AnyUniform<THREE.Vector2>;
  boatPosition: AnyUniform<THREE.Vector2>;
  previousBoatPosition: AnyUniform<THREE.Vector2>;
  boatForward: AnyUniform<THREE.Vector2>;
  boatRight: AnyUniform<THREE.Vector2>;
  boatMotionDirection: AnyUniform<THREE.Vector2>;
  propChurnDirection: AnyUniform<THREE.Vector2>;
  deltaTime: AnyUniform<number>;
  foamDecay: AnyUniform<number>;
  enabled: AnyUniform<number>;
  historyValid: AnyUniform<number>;
  waveIntensity: AnyUniform<number>;
  foamIntensity: AnyUniform<number>;
  hullWakeAmount: AnyUniform<number>;
  propChurnAmount: AnyUniform<number>;
  lateralSlipAmount: AnyUniform<number>;
  rudderAmount: AnyUniform<number>;
  lengthMeters: AnyUniform<number>;
  beamMeters: AnyUniform<number>;
  draftMeters: AnyUniform<number>;
};

type BoatWakeKinematics = {
  currentPosition: THREE.Vector2;
  previousPosition: THREE.Vector2;
  forward: THREE.Vector2;
  right: THREE.Vector2;
  motionDirection: THREE.Vector2;
  propChurnDirection: THREE.Vector2;
};

type WakeEmissionParams = {
  hullWakeAmount: number;
  propChurnAmount: number;
  lateralSlipAmount: number;
  rudderAmount: number;
};

type WakeFieldSample = {
  dynamicsTexture: THREE.StorageTexture;
  foamTexture: THREE.StorageTexture;
  origin: THREE.Vector2;
  sizeMeters: number;
  resolution: number;
  enabled: boolean;
};

export type BoatInteractionSampleState = WakeFieldSample;

export type BoatWaterInteractionUpdateOptions = {
  renderer: THREE.WebGPURenderer;
  boat: BoatWaterInteractionState;
  settings: DebugSettings;
  deltaSeconds: number;
};

function u<T>(value: T): AnyUniform<T> {
  return uniform(value as never) as unknown as AnyUniform<T>;
}

function smooth01(value: number): number {
  const x = Math.min(1, Math.max(0, value));
  return x * x * (3 - 2 * x);
}

function computeHullWakeAmount(speedMs: number): number {
  return smooth01((speedMs - HULL_WAKE_SPEED_START_MS) / (HULL_WAKE_SPEED_FULL_MS - HULL_WAKE_SPEED_START_MS));
}

function computePropChurnAmount(throttle: number): number {
  return smooth01(Math.max(0, Math.abs(throttle) - 0.04) / 0.96);
}

function computeMotionDirection(velocity: { x: number; z: number }, fallbackForward: THREE.Vector2): THREE.Vector2 {
  const direction = new THREE.Vector2(velocity.x, velocity.z);
  return direction.lengthSq() > 0.35 * 0.35 ? direction.normalize() : fallbackForward.clone();
}

function createInteractionTexture(resolution: number, name: string): THREE.StorageTexture {
  const texture = new THREE.StorageTexture(resolution, resolution);
  texture.name = name;
  texture.type = THREE.HalfFloatType;
  texture.format = THREE.RGBAFormat;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  (texture as any).mipmapsAutoUpdate = false;
  return texture;
}

/**
 * Local boat-water interaction field.
 *
 * Dynamics texture:
 * - r: local vertical displacement in meters
 * - g/b: horizontal surface velocity X/Z
 * - a: reserved
 *
 * Foam texture:
 * - r: persistent hull wake foam
 * - g: short-lived prop churn foam
 * - b: contact/slip foam around the hull
 * - a: debug/reserve
 */
export class BoatWaterInteraction {
  readonly resolution: number;
  readonly sizeMeters: number;
  readonly origin = new THREE.Vector2();

  private readonly dynamicsTextures: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly foamTextures: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly uniforms: BoatWaterInteractionUniforms;
  private readonly passes: [NodeRef, NodeRef];
  private readonly currentBoatPosition = new THREE.Vector2();
  private readonly previousBoatPosition = new THREE.Vector2();
  private readonly kinematics: BoatWakeKinematics;
  private frameParity: 0 | 1 = 0;
  private lastComputeMs = 0;
  private hasOrigin = false;
  private hasBoatPosition = false;
  private propThrottle = 0;
  private active = true;

  constructor(tier: QualityTier) {
    this.resolution = QUALITY_RESOLUTION[tier];
    this.sizeMeters = QUALITY_SIZE_METERS[tier];
    this.dynamicsTextures = [
      createInteractionTexture(this.resolution, "boat-water-dynamics-0"),
      createInteractionTexture(this.resolution, "boat-water-dynamics-1")
    ];
    this.foamTextures = [
      createInteractionTexture(this.resolution, "boat-water-foam-0"),
      createInteractionTexture(this.resolution, "boat-water-foam-1")
    ];
    this.kinematics = {
      currentPosition: this.currentBoatPosition,
      previousPosition: this.previousBoatPosition,
      forward: new THREE.Vector2(0, -1),
      right: new THREE.Vector2(1, 0),
      motionDirection: new THREE.Vector2(0, -1),
      propChurnDirection: new THREE.Vector2(0, 1)
    };
    this.uniforms = {
      origin: u(new THREE.Vector2()),
      previousOrigin: u(new THREE.Vector2()),
      boatPosition: u(new THREE.Vector2()),
      previousBoatPosition: u(new THREE.Vector2()),
      boatForward: u(new THREE.Vector2(0, -1)),
      boatRight: u(new THREE.Vector2(1, 0)),
      boatMotionDirection: u(new THREE.Vector2(0, -1)),
      propChurnDirection: u(new THREE.Vector2(0, 1)),
      deltaTime: u(1 / 60),
      foamDecay: u(0.28),
      enabled: u(1),
      historyValid: u(0),
      waveIntensity: u(1),
      foamIntensity: u(1),
      hullWakeAmount: u(0),
      propChurnAmount: u(0),
      lateralSlipAmount: u(0),
      rudderAmount: u(0),
      lengthMeters: u(8),
      beamMeters: u(2.6),
      draftMeters: u(0.45)
    };
    this.passes = [this.createPass(0), this.createPass(1)];
  }

  get currentDynamicsTexture(): THREE.StorageTexture {
    return this.dynamicsTextures[this.frameParity];
  }

  get currentFoamTexture(): THREE.StorageTexture {
    return this.foamTextures[this.frameParity];
  }

  get computeMs(): number {
    return this.lastComputeMs;
  }

  get sampleState(): BoatInteractionSampleState {
    return {
      dynamicsTexture: this.currentDynamicsTexture,
      foamTexture: this.currentFoamTexture,
      origin: this.origin,
      sizeMeters: this.sizeMeters,
      resolution: this.resolution,
      enabled: this.active
    };
  }

  resetHistory(): void {
    this.hasOrigin = false;
    this.hasBoatPosition = false;
    this.propThrottle = 0;
  }

  update(options: BoatWaterInteractionUpdateOptions): void {
    const start = performance.now();
    const safeDeltaSeconds = Math.max(1 / 240, Math.min(0.1, options.deltaSeconds));
    const previousOriginX = this.hasOrigin ? this.origin.x : options.boat.position.x - this.sizeMeters * 0.5;
    const previousOriginZ = this.hasOrigin ? this.origin.y : options.boat.position.z - this.sizeMeters * 0.5;
    const historyValid = this.updateKinematics(
      options.boat,
      safeDeltaSeconds,
      options.settings.boatWaterInteraction
    );
    const emissions = this.computeEmissionParams(options.boat);

    this.origin.set(options.boat.position.x - this.sizeMeters * 0.5, options.boat.position.z - this.sizeMeters * 0.5);
    this.hasOrigin = true;
    this.hasBoatPosition = true;

    this.uniforms.origin.value.copy(this.origin);
    this.uniforms.previousOrigin.value.set(previousOriginX, previousOriginZ);
    this.uniforms.boatPosition.value.copy(this.kinematics.currentPosition);
    this.uniforms.previousBoatPosition.value.copy(this.kinematics.previousPosition);
    this.uniforms.boatForward.value.copy(this.kinematics.forward);
    this.uniforms.boatRight.value.copy(this.kinematics.right);
    this.uniforms.boatMotionDirection.value.copy(this.kinematics.motionDirection);
    this.uniforms.propChurnDirection.value.copy(this.kinematics.propChurnDirection);
    this.uniforms.deltaTime.value = safeDeltaSeconds;
    this.uniforms.foamDecay.value = options.settings.foamDecay;
    this.uniforms.enabled.value = this.active ? 1 : 0;
    this.uniforms.historyValid.value = historyValid ? 1 : 0;
    this.uniforms.waveIntensity.value = options.settings.boatWakeIntensity;
    this.uniforms.foamIntensity.value = options.settings.boatWakeFoamIntensity;
    this.uniforms.hullWakeAmount.value = emissions.hullWakeAmount;
    this.uniforms.propChurnAmount.value = emissions.propChurnAmount;
    this.uniforms.lateralSlipAmount.value = emissions.lateralSlipAmount;
    this.uniforms.rudderAmount.value = emissions.rudderAmount;
    this.uniforms.lengthMeters.value = options.boat.lengthMeters;
    this.uniforms.beamMeters.value = options.boat.beamMeters;
    this.uniforms.draftMeters.value = options.boat.draftMeters;

    this.frameParity = (1 - this.frameParity) as 0 | 1;
    options.renderer.compute(this.passes[this.frameParity]);
    this.previousBoatPosition.copy(this.currentBoatPosition);
    this.lastComputeMs = performance.now() - start;
  }

  dispose(): void {
    this.dynamicsTextures.forEach((texture) => texture.dispose());
    this.foamTextures.forEach((texture) => texture.dispose());
  }

  private updateKinematics(
    boat: BoatWaterInteractionState,
    deltaSeconds: number,
    interactionEnabled: boolean
  ): boolean {
    this.currentBoatPosition.set(boat.position.x, boat.position.z);
    this.kinematics.forward.set(boat.forward.x, boat.forward.z).normalize();
    this.kinematics.right.set(boat.right.x, boat.right.z).normalize();

    const historyValid =
      this.hasOrigin &&
      this.hasBoatPosition &&
      this.previousBoatPosition.distanceTo(this.currentBoatPosition) <= this.sizeMeters * HISTORY_RESET_DISTANCE_RATIO;
    if (!historyValid) {
      this.previousBoatPosition.copy(this.currentBoatPosition);
    }

    this.active = interactionEnabled && !boat.capsized;
    if (!this.active) {
      this.propThrottle = 0;
    } else {
      const response = 1 - Math.exp(-deltaSeconds * 1.15);
      this.propThrottle += (boat.throttle - this.propThrottle) * response;
    }

    this.kinematics.motionDirection.copy(computeMotionDirection(boat.velocity, this.kinematics.forward));
    const propSign = Math.sign(this.propThrottle);
    this.kinematics.propChurnDirection
      .copy(this.kinematics.forward)
      .multiplyScalar(propSign < 0 ? 1 : -1);
    this.kinematics.previousPosition.copy(this.previousBoatPosition);
    return historyValid && this.active;
  }

  private computeEmissionParams(boat: BoatWaterInteractionState): WakeEmissionParams {
    if (!this.active) {
      return { hullWakeAmount: 0, propChurnAmount: 0, lateralSlipAmount: 0, rudderAmount: 0 };
    }

    const hullWakeAmount = computeHullWakeAmount(boat.speedMs);
    return {
      hullWakeAmount,
      propChurnAmount: computePropChurnAmount(this.propThrottle),
      lateralSlipAmount: smooth01(boat.lateralSpeedMs / 4.8),
      rudderAmount: Math.abs(boat.rudder) * hullWakeAmount
    };
  }

  private createPass(parity: 0 | 1): NodeRef {
    const n = this.resolution;
    const dynamicsSource = this.dynamicsTextures[1 - parity];
    const foamSource = this.foamTextures[1 - parity];
    const dynamicsSourceNode = texture(dynamicsSource);
    const foamSourceNode = texture(foamSource);
    const dynamicsTarget = this.dynamicsTextures[parity];
    const foamTarget = this.foamTextures[parity];
    const uniforms = this.uniforms;
    const sizeMeters = this.sizeMeters;
    const invResolution = 1 / n;
    const cellMeters = sizeMeters / n;

    const samplePreviousDynamics = (uv: NodeRef): NodeRef => {
      const inside = step(float(0), uv.x)
        .mul(step(uv.x, float(1)))
        .mul(step(float(0), uv.y))
        .mul(step(uv.y, float(1)))
        .mul(uniforms.historyValid);
      return (dynamicsSourceNode as any).sample(uv).level(float(0)).mul(inside);
    };

    const samplePreviousFoam = (uv: NodeRef): NodeRef => {
      const inside = step(float(0), uv.x)
        .mul(step(uv.x, float(1)))
        .mul(step(float(0), uv.y))
        .mul(step(uv.y, float(1)))
        .mul(uniforms.historyValid);
      return (foamSourceNode as any).sample(uv).level(float(0)).mul(inside);
    };

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);
      const uv = vec2(x.toFloat().add(0.5), y.toFloat().add(0.5)).mul(invResolution);
      const worldXZ = uniforms.origin.add(uv.mul(sizeMeters));
      const previousUv = worldXZ.sub(uniforms.previousOrigin).div(sizeMeters);

      const centerDynamics = samplePreviousDynamics(previousUv);
      const left = samplePreviousDynamics(previousUv.sub(vec2(invResolution, 0)));
      const right = samplePreviousDynamics(previousUv.add(vec2(invResolution, 0)));
      const down = samplePreviousDynamics(previousUv.sub(vec2(0, invResolution)));
      const up = samplePreviousDynamics(previousUv.add(vec2(0, invResolution)));
      const centerFoam = samplePreviousFoam(previousUv);

      const dt = uniforms.deltaTime;
      const heightDamping = exp(dt.mul(-0.34));
      const velocityDamping = exp(dt.mul(-0.72));
      const hullFoamDamping = exp(uniforms.foamDecay.mul(-0.72).mul(dt));
      const propFoamDamping = exp(uniforms.foamDecay.mul(-2.4).sub(1.8).mul(dt));
      const contactFoamDamping = exp(uniforms.foamDecay.mul(-1.5).sub(0.75).mul(dt));

      const gradientX = right.r.sub(left.r).div(cellMeters * 2);
      const gradientZ = up.r.sub(down.r).div(cellMeters * 2);
      const surfaceVelocity = centerDynamics.gb
        .sub(vec2(gradientX, gradientZ).mul(dt).mul(4.8))
        .mul(velocityDamping);
      const divergence = right.g.sub(left.g).add(up.b.sub(down.b)).div(cellMeters * 2);
      let height = centerDynamics.r.sub(divergence.mul(dt).mul(0.9)).mul(heightDamping);

      const boatDelta = worldXZ.sub(uniforms.boatPosition);
      const previousBoatDelta = worldXZ.sub(uniforms.previousBoatPosition);
      const sweptSegment = uniforms.boatPosition.sub(uniforms.previousBoatPosition);
      const sweptDistanceSq = sweptSegment.dot(sweptSegment).max(0.001);
      const sweptT = previousBoatDelta.dot(sweptSegment).div(sweptDistanceSq).clamp(0, 1);
      const sweptClosest = uniforms.previousBoatPosition.add(sweptSegment.mul(sweptT));
      const sweptDistance = worldXZ.sub(sweptClosest).length();
      const sweptTravel = sweptDistanceSq.sqrt();
      const halfLength = uniforms.lengthMeters.mul(0.5);
      const halfBeam = uniforms.beamMeters.mul(0.5);
      const forwardDistance = boatDelta.dot(uniforms.boatForward);
      const sideDistance = boatDelta.dot(uniforms.boatRight);
      const absSide = sideDistance.abs();

      const sideContact = float(1).sub(smoothstep(halfBeam.mul(0.14), halfBeam.mul(0.42), absSide.sub(halfBeam.mul(0.72)).abs()));
      const longitudinalContact = float(1).sub(smoothstep(halfLength.mul(0.54), halfLength.mul(0.75), forwardDistance.abs()));
      const contactMask = sideContact.mul(longitudinalContact);

      const sweptWidth = halfBeam.mul(0.76).add(uniforms.hullWakeAmount.mul(0.25));
      const sweptWakeMask = float(1)
        .sub(smoothstep(sweptWidth, sweptWidth.mul(1.7), sweptDistance))
        // The previous 15 cm lower bound made the wake frame-rate dependent:
        // at 144 FPS a boat had to exceed 21 m/s before emitting anything.
        .mul(step(float(0.0001), sweptTravel))
        .mul(uniforms.hullWakeAmount);

      const leadingDistance = boatDelta.dot(uniforms.boatMotionDirection);
      const leadingShape = vec2(
        sideDistance.div(halfBeam.mul(1.05)),
        leadingDistance.sub(halfLength.mul(0.54)).div(uniforms.lengthMeters.mul(0.22))
      ).length();
      const leadingPressure = float(1).sub(smoothstep(float(0.16), float(1.0), leadingShape)).mul(uniforms.hullWakeAmount);

      // A steady Kelvin wake is generated in the boat frame while the shallow
      // water field carries the resulting height and velocity in world space.
      // The previous rewrite removed these broad sources, leaving only a
      // sub-metre pressure halo that the radial ocean mesh could not resolve.
      const behindDistance = forwardDistance.negate().sub(halfLength.mul(0.18)).max(0);
      const wakeFade = float(1).sub(smoothstep(float(6), float(sizeMeters * 0.46), behindDistance));
      const wakeStart = smoothstep(float(0.25), float(3.0), behindDistance);
      const wakeWidth = halfBeam.mul(0.68).add(behindDistance.mul(0.105));
      const centerWake = float(1)
        .sub(smoothstep(wakeWidth, wakeWidth.mul(1.85), absSide))
        .mul(wakeStart)
        .mul(wakeFade)
        .mul(uniforms.hullWakeAmount);
      const kelvinRatio = absSide.div(behindDistance.add(1.2));
      const kelvinArms = float(1)
        .sub(smoothstep(float(0.045), float(0.14), kelvinRatio.sub(0.36).abs()))
        .mul(wakeStart)
        .mul(wakeFade)
        .mul(uniforms.hullWakeAmount);

      const propOrigin = uniforms.boatPosition.sub(uniforms.boatForward.mul(halfLength.mul(0.47)));
      const propDelta = worldXZ.sub(propOrigin);
      const propAlong = propDelta.dot(uniforms.propChurnDirection);
      const propLateral = propDelta.dot(uniforms.boatRight).abs();
      const propLongitudinal = propDelta.dot(uniforms.boatForward).abs();
      const propDisk = float(1)
        .sub(smoothstep(halfBeam.mul(0.16), halfBeam.mul(0.48), propLateral))
        .mul(float(1).sub(smoothstep(float(0.18), float(1.35), propLongitudinal)));
      const propShortPlume = float(1)
        .sub(smoothstep(halfBeam.mul(0.24), halfBeam.mul(0.82), propLateral))
        .mul(smoothstep(float(-0.15), float(0.35), propAlong))
        .mul(float(1).sub(smoothstep(float(1.3), float(3.2), propAlong)));
      const propChurn = propDisk
        .mul(0.72)
        .add(propShortPlume.mul(0.28))
        .mul(uniforms.propChurnAmount);
      const propChurnDebug: NodeRef = propChurn;

      const slipFoam = contactMask
        .mul(uniforms.lateralSlipAmount.mul(0.45).add(uniforms.rudderAmount.mul(0.55)).clamp(0, 1));
      const noise = mx_noise_float(worldXZ.mul(0.46)).mul(0.5).add(0.5);

      const transversePhase = cos(behindDistance.mul(1.25));
      const divergentPhase = cos(behindDistance.mul(1.55).add(absSide.mul(0.42)));
      const waveTarget = leadingPressure.mul(0.34)
        .add(kelvinArms.mul(divergentPhase).mul(0.2))
        .add(centerWake.mul(transversePhase.mul(0.075).sub(0.025)))
        .add(propChurn.mul(0.035))
        .add(slipFoam.mul(0.04))
        .mul(uniforms.waveIntensity);
      const waveSourceMask = leadingPressure
        .max(kelvinArms)
        .max(centerWake)
        .max(propChurn.mul(0.65))
        .max(slipFoam)
        .clamp(0, 1);
      const waveSourceResponse = float(1).sub(exp(dt.mul(-12)));
      height = height
        .add(waveTarget.sub(height).mul(waveSourceMask).mul(waveSourceResponse).mul(uniforms.enabled))
        .clamp(-0.35, 0.5);

      const injectedVelocity = uniforms.boatMotionDirection.negate().mul(sweptWakeMask.mul(0.08))
        .add(uniforms.propChurnDirection.mul(propChurn.mul(0.06)))
        .add(uniforms.boatRight.mul(sideDistance.sign()).mul(slipFoam.mul(0.18)))
        .mul(uniforms.enabled);
      const nextVelocity = surfaceVelocity.add(injectedVelocity.mul(dt).mul(uniforms.waveIntensity)).clamp(-2.2, 2.2);

      const foamGain = uniforms.foamIntensity.mul(noise.mul(0.32).add(0.82)).mul(uniforms.enabled);
      // These are target coverages, not rates. Multiplying them by dt made a
      // texel receive only a few thousandths while the boat crossed it, well
      // below the renderer's foam threshold at every normal frame rate.
      const hullWakeFoam = centerFoam.r
        .mul(hullFoamDamping)
        .max(sweptWakeMask.mul(0.78).mul(foamGain))
        .clamp(0, 0.78);
      const propChurnFoam = centerFoam.g
        .mul(propFoamDamping)
        .max(propChurn.mul(0.72).mul(foamGain))
        .clamp(0, 0.72);
      const contactSource = contactMask
        .mul(uniforms.hullWakeAmount.mul(0.22))
        .add(slipFoam.mul(0.58))
        .mul(foamGain);
      const contactFoam = centerFoam.b
        .mul(contactFoamDamping)
        .max(contactSource)
        .clamp(0, 0.6);

      textureStore(dynamicsTarget, texel, vec4(height, nextVelocity.x, nextVelocity.y, 0));
      textureStore(foamTarget, texel, vec4(hullWakeFoam, propChurnFoam, contactFoam, propChurnDebug));
    })().compute(n * n);
  }
}
