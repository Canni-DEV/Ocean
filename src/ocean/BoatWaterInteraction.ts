import * as THREE from "three/webgpu";
import {
  Fn,
  exp,
  float,
  instanceIndex,
  mx_noise_float,
  smoothstep,
  step,
  textureLoad,
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

type BoatWaterInteractionUniforms = {
  origin: AnyUniform<THREE.Vector2>;
  previousOrigin: AnyUniform<THREE.Vector2>;
  boatPosition: AnyUniform<THREE.Vector2>;
  boatForward: AnyUniform<THREE.Vector2>;
  boatRight: AnyUniform<THREE.Vector2>;
  boatVelocity: AnyUniform<THREE.Vector2>;
  deltaTime: AnyUniform<number>;
  foamDecay: AnyUniform<number>;
  enabled: AnyUniform<number>;
  waveIntensity: AnyUniform<number>;
  foamIntensity: AnyUniform<number>;
  boatSpeed: AnyUniform<number>;
  lateralSpeed: AnyUniform<number>;
  throttle: AnyUniform<number>;
  rudder: AnyUniform<number>;
  lengthMeters: AnyUniform<number>;
  beamMeters: AnyUniform<number>;
  draftMeters: AnyUniform<number>;
};

export type BoatInteractionSampleState = {
  texture: THREE.StorageTexture;
  origin: THREE.Vector2;
  sizeMeters: number;
  resolution: number;
  enabled: boolean;
};

export type BoatWaterInteractionUpdateOptions = {
  renderer: THREE.WebGPURenderer;
  boat: BoatWaterInteractionState;
  settings: DebugSettings;
  deltaSeconds: number;
};

function u<T>(value: T): AnyUniform<T> {
  return uniform(value as never) as unknown as AnyUniform<T>;
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
 * Local, boat-centered wake field. RGBA packs height, surface velocity X/Z and
 * accumulated foam/turbulence. The field is reprojected in absolute world
 * space every frame, so the wake remains visually attached to the water while
 * the simulation window follows the player boat.
 */
export class BoatWaterInteraction {
  readonly resolution: number;
  readonly sizeMeters: number;
  readonly origin = new THREE.Vector2();

  private readonly textures: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly uniforms: BoatWaterInteractionUniforms;
  private readonly passes: [NodeRef, NodeRef];
  private frameParity: 0 | 1 = 0;
  private lastComputeMs = 0;
  private hasOrigin = false;
  private active = true;

  constructor(tier: QualityTier) {
    this.resolution = QUALITY_RESOLUTION[tier];
    this.sizeMeters = QUALITY_SIZE_METERS[tier];
    this.textures = [
      createInteractionTexture(this.resolution, "boat-water-interaction-0"),
      createInteractionTexture(this.resolution, "boat-water-interaction-1")
    ];
    this.uniforms = {
      origin: u(new THREE.Vector2()),
      previousOrigin: u(new THREE.Vector2()),
      boatPosition: u(new THREE.Vector2()),
      boatForward: u(new THREE.Vector2(0, -1)),
      boatRight: u(new THREE.Vector2(1, 0)),
      boatVelocity: u(new THREE.Vector2()),
      deltaTime: u(1 / 60),
      foamDecay: u(0.28),
      enabled: u(1),
      waveIntensity: u(1),
      foamIntensity: u(1),
      boatSpeed: u(0),
      lateralSpeed: u(0),
      throttle: u(0),
      rudder: u(0),
      lengthMeters: u(8),
      beamMeters: u(2.6),
      draftMeters: u(0.45)
    };
    this.passes = [this.createPass(0), this.createPass(1)];
  }

  get currentTexture(): THREE.StorageTexture {
    return this.textures[this.frameParity];
  }

  get computeMs(): number {
    return this.lastComputeMs;
  }

  get sampleState(): BoatInteractionSampleState {
    return {
      texture: this.currentTexture,
      origin: this.origin,
      sizeMeters: this.sizeMeters,
      resolution: this.resolution,
      enabled: this.active
    };
  }

  update(options: BoatWaterInteractionUpdateOptions): void {
    const start = performance.now();
    const halfSize = this.sizeMeters * 0.5;
    const nextOriginX = options.boat.position.x - halfSize;
    const nextOriginZ = options.boat.position.z - halfSize;
    const previousOriginX = this.hasOrigin ? this.origin.x : nextOriginX;
    const previousOriginZ = this.hasOrigin ? this.origin.y : nextOriginZ;

    this.origin.set(nextOriginX, nextOriginZ);
    this.hasOrigin = true;
    this.active = options.settings.boatWaterInteraction && !options.boat.capsized;

    this.uniforms.origin.value.copy(this.origin);
    this.uniforms.previousOrigin.value.set(previousOriginX, previousOriginZ);
    this.uniforms.boatPosition.value.set(options.boat.position.x, options.boat.position.z);
    this.uniforms.boatForward.value.set(options.boat.forward.x, options.boat.forward.z);
    this.uniforms.boatRight.value.set(options.boat.right.x, options.boat.right.z);
    this.uniforms.boatVelocity.value.set(options.boat.velocity.x, options.boat.velocity.z);
    this.uniforms.deltaTime.value = Math.max(1 / 240, Math.min(0.1, options.deltaSeconds));
    this.uniforms.foamDecay.value = options.settings.foamDecay;
    this.uniforms.enabled.value = this.active ? 1 : 0;
    this.uniforms.waveIntensity.value = options.settings.boatWakeIntensity;
    this.uniforms.foamIntensity.value = options.settings.boatWakeFoamIntensity;
    this.uniforms.boatSpeed.value = options.boat.speedMs;
    this.uniforms.lateralSpeed.value = options.boat.lateralSpeedMs;
    this.uniforms.throttle.value = options.boat.throttle;
    this.uniforms.rudder.value = options.boat.rudder;
    this.uniforms.lengthMeters.value = options.boat.lengthMeters;
    this.uniforms.beamMeters.value = options.boat.beamMeters;
    this.uniforms.draftMeters.value = options.boat.draftMeters;

    this.frameParity = (1 - this.frameParity) as 0 | 1;
    options.renderer.compute(this.passes[this.frameParity]);
    this.lastComputeMs = performance.now() - start;
  }

  dispose(): void {
    this.textures.forEach((texture) => texture.dispose());
  }

  private createPass(parity: 0 | 1): NodeRef {
    const n = this.resolution;
    const source = this.textures[1 - parity];
    const target = this.textures[parity];
    const uniforms = this.uniforms;
    const sizeMeters = this.sizeMeters;
    const invResolution = 1 / n;
    const cellMeters = sizeMeters / n;

    const samplePrevious = (uv: NodeRef): NodeRef => {
      const inside = step(float(0), uv.x)
        .mul(step(uv.x, float(1)))
        .mul(step(float(0), uv.y))
        .mul(step(uv.y, float(1)));
      const texel = uvec2(uv.mul(n).floor().clamp(0, n - 1));
      return textureLoad(source, texel).mul(inside);
    };

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);
      const uv = vec2(x.toFloat().add(0.5), y.toFloat().add(0.5)).mul(invResolution);
      const worldXZ = uniforms.origin.add(uv.mul(sizeMeters));
      const previousUv = worldXZ.sub(uniforms.previousOrigin).div(sizeMeters);

      const center = samplePrevious(previousUv);
      const left = samplePrevious(previousUv.sub(vec2(invResolution, 0)));
      const right = samplePrevious(previousUv.add(vec2(invResolution, 0)));
      const down = samplePrevious(previousUv.sub(vec2(0, invResolution)));
      const up = samplePrevious(previousUv.add(vec2(0, invResolution)));

      const dt = uniforms.deltaTime;
      const heightDamping = exp(dt.mul(-0.52));
      const velocityDamping = exp(dt.mul(-1.35));
      const foamDamping = exp(uniforms.foamDecay.negate().mul(dt));

      const gradientX = right.r.sub(left.r).div(cellMeters * 2);
      const gradientZ = up.r.sub(down.r).div(cellMeters * 2);
      const velocity = center.gb
        .sub(vec2(gradientX, gradientZ).mul(dt).mul(5.2))
        .mul(velocityDamping);
      const divergence = right.g.sub(left.g).add(up.b.sub(down.b)).div(cellMeters * 2);
      let height = center.r.sub(divergence.mul(dt).mul(1.15)).mul(heightDamping);

      const boatDelta = worldXZ.sub(uniforms.boatPosition);
      const forwardDistance = boatDelta.dot(uniforms.boatForward);
      const sideDistance = boatDelta.dot(uniforms.boatRight);
      const absSide = sideDistance.abs();
      const halfLength = uniforms.lengthMeters.mul(0.5);
      const halfBeam = uniforms.beamMeters.mul(0.5);
      const speedNorm = uniforms.boatSpeed.div(13).clamp(0, 1);
      const speedEnergy = speedNorm.mul(speedNorm);
      const throttleEnergy = uniforms.throttle.abs().mul(0.55).add(speedNorm.mul(0.45)).clamp(0, 1);

      const hullLongitudinal = float(1).sub(smoothstep(halfLength.mul(0.56), halfLength.mul(0.72), forwardDistance.abs()));
      const sideBand = float(1).sub(smoothstep(halfBeam.mul(0.18), halfBeam.mul(0.46), absSide.sub(halfBeam.mul(0.62)).abs()));
      const contactMask = hullLongitudinal.mul(sideBand);

      const bowOffset = forwardDistance.sub(halfLength.mul(0.55));
      const bowShape = vec2(sideDistance.div(halfBeam.mul(0.95)), bowOffset.div(uniforms.lengthMeters.mul(0.22))).length();
      const bowMask = float(1).sub(smoothstep(float(0.12), float(1.05), bowShape)).mul(speedEnergy);

      const behindDistance = forwardDistance.negate().sub(halfLength.mul(0.18)).max(0);
      const wakeFade = float(1).sub(smoothstep(float(8), float(sizeMeters * 0.46), behindDistance));
      const wakeStart = smoothstep(float(0.2), float(4.0), behindDistance);
      const wakeWidth = halfBeam.mul(0.72).add(behindDistance.mul(0.12));
      const centerWake = float(1)
        .sub(smoothstep(wakeWidth, wakeWidth.mul(1.9), absSide))
        .mul(wakeStart)
        .mul(wakeFade)
        .mul(throttleEnergy);

      const kelvinRatio = absSide.div(behindDistance.add(1.2));
      const kelvinArms = float(1)
        .sub(smoothstep(float(0.035), float(0.13), kelvinRatio.sub(0.36).abs()))
        .mul(wakeStart)
        .mul(wakeFade)
        .mul(speedEnergy);

      const propWidth = halfBeam.mul(0.35).add(behindDistance.mul(0.045));
      const propWash = float(1)
        .sub(smoothstep(propWidth, propWidth.mul(2.1), absSide))
        .mul(smoothstep(float(0.4), float(5.5), behindDistance))
        .mul(float(1).sub(smoothstep(float(7), float(34), behindDistance)))
        .mul(throttleEnergy);

      const slipEnergy = uniforms.lateralSpeed.div(4.5).clamp(0, 1).add(uniforms.rudder.abs().mul(speedNorm).mul(0.65)).clamp(0, 1);
      const slipFoam = contactMask.mul(slipEnergy);

      const waveNoise = mx_noise_float(worldXZ.mul(0.42)).mul(0.5).add(0.5);
      const bowHeight = bowMask.mul(0.34).sub(
        float(1)
          .sub(smoothstep(float(0.2), float(1.2), bowShape.sub(0.9).abs()))
          .mul(speedEnergy)
          .mul(0.08)
      );
      const wakeHeight = kelvinArms.mul(0.12).add(centerWake.mul(-0.05)).add(propWash.mul(0.035));
      height = height
        .add(bowHeight.add(wakeHeight).mul(uniforms.waveIntensity).mul(uniforms.enabled))
        .clamp(-0.55, 0.72);

      const sourceVelocity = uniforms.boatForward
        .mul(propWash.mul(0.9).add(centerWake.mul(0.35)).mul(speedNorm))
        .add(uniforms.boatRight.mul(sideDistance.sign()).mul(contactMask.mul(slipEnergy).mul(0.45)))
        .mul(uniforms.enabled);

      const nextVelocity = velocity.add(sourceVelocity.mul(dt).mul(uniforms.waveIntensity)).clamp(-4, 4);

      const foamSource = contactMask
        .mul(0.24)
        .add(bowMask.mul(0.75))
        .add(kelvinArms.mul(0.48))
        .add(centerWake.mul(0.34))
        .add(propWash.mul(0.88))
        .add(slipFoam.mul(0.62))
        .mul(uniforms.foamIntensity)
        .mul(waveNoise.mul(0.34).add(0.83))
        .mul(uniforms.enabled)
        .clamp(0, 1);
      const foam = center.a.mul(foamDamping).max(foamSource).clamp(0, 1);

      textureStore(target, texel, vec4(height, nextVelocity.x, nextVelocity.y, foam));
    })().compute(n * n);
  }
}
