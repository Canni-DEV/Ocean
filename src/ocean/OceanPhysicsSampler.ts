import * as THREE from "three/webgpu";
import { Fn, float, instancedArray, instanceIndex, step, texture, uint, uniform, vec2, vec3, vec4 } from "three/tsl";
import type { BoatWaterInteraction } from "./BoatWaterInteraction";
import type { OceanSimulation } from "./simulation/OceanSimulation";

type NodeRef = any;

const GRID_SIZE = 64;
const REGION_METERS = 256;

/**
 * Exact-height physics sampling: a small compute pass evaluates the same
 * displacement cascades used for rendering over a camera-centered grid and the
 * result is read back asynchronously (1-2 frames of latency, no GPU stall).
 *
 * The grid stores vertical displacement as a function of the *undisplaced*
 * column position, so `getHeightAt` iteratively compensates the horizontal
 * (choppy) displacement to return the true water height at a world point.
 */
export class OceanPhysicsSampler {
  private readonly buffer: NodeRef;
  private readonly computePass: NodeRef;
  private readonly regionOrigin: NodeRef;
  private readonly boatInteraction: BoatWaterInteraction | null;
  private readonly interactionTexture: NodeRef | null;
  private readonly interactionOrigin: NodeRef;
  private readonly interactionSize: NodeRef;
  private readonly interactionEnabled: NodeRef;

  private readonly heights = new Float32Array(GRID_SIZE * GRID_SIZE);
  private readonly displacementsX = new Float32Array(GRID_SIZE * GRID_SIZE);
  private readonly displacementsZ = new Float32Array(GRID_SIZE * GRID_SIZE);
  private readbackOriginX = 0;
  private readbackOriginZ = 0;
  private pendingOriginX = 0;
  private pendingOriginZ = 0;
  private readbackInFlight = false;
  private hasData = false;

  constructor(simulation: OceanSimulation, boatInteraction: BoatWaterInteraction | null = null) {
    this.boatInteraction = boatInteraction;
    this.buffer = instancedArray(GRID_SIZE * GRID_SIZE, "vec4");
    this.regionOrigin = uniform(new THREE.Vector2());
    this.interactionOrigin = uniform(new THREE.Vector2());
    this.interactionSize = uniform(1);
    this.interactionEnabled = uniform(0);

    const displacementNodes = simulation.cascades.map((cascade) => texture(cascade.displacementTexture));
    this.interactionTexture = boatInteraction ? texture(boatInteraction.currentDynamicsTexture) : null;
    const regionOrigin = this.regionOrigin;
    const interactionTexture = this.interactionTexture;
    const interactionOrigin = this.interactionOrigin;
    const interactionSize = this.interactionSize;
    const interactionEnabled = this.interactionEnabled;
    const buffer = this.buffer;
    const cellSize = REGION_METERS / GRID_SIZE;

    this.computePass = Fn(() => {
      const x = instanceIndex.mod(uint(GRID_SIZE));
      const z = instanceIndex.div(uint(GRID_SIZE));
      const worldXZ = vec2(x.toFloat().mul(cellSize), z.toFloat().mul(cellSize)).add(regionOrigin);

      let displacement: NodeRef = vec3(0, 0, 0);
      simulation.cascades.forEach((cascade, index) => {
        const uv = worldXZ.div(cascade.config.patchSize);
        displacement = displacement.add((displacementNodes[index] as any).sample(uv).level(float(0)).xyz);
      });

      if (interactionTexture) {
        const interactionUv = worldXZ.sub(interactionOrigin).div(interactionSize);
        const inside = step(float(0), interactionUv.x)
          .mul(step(interactionUv.x, float(1)))
          .mul(step(float(0), interactionUv.y))
          .mul(step(interactionUv.y, float(1)))
          .mul(interactionEnabled);
        const interactionHeight = (interactionTexture as any).sample(interactionUv).level(float(0)).r.mul(inside);
        displacement = displacement.add(vec3(0, interactionHeight, 0));
      }

      buffer.element(instanceIndex).assign(vec4(displacement, 0));
    })().compute(GRID_SIZE * GRID_SIZE);
  }

  /** True once the first readback has completed. */
  isReady(): boolean {
    return this.hasData;
  }

  /**
   * Runs the sampling compute pass around the given absolute world position
   * and kicks an async readback if the previous one finished.
   */
  update(renderer: THREE.WebGPURenderer, centerWorldX: number, centerWorldZ: number): void {
    if (this.boatInteraction && this.interactionTexture) {
      const interaction = this.boatInteraction.sampleState;
      this.interactionTexture.value = interaction.dynamicsTexture;
      this.interactionOrigin.value.copy(interaction.origin);
      this.interactionSize.value = interaction.sizeMeters;
      this.interactionEnabled.value = interaction.enabled ? 1 : 0;
    } else {
      this.interactionEnabled.value = 0;
    }

    const half = REGION_METERS / 2;
    this.pendingOriginX = centerWorldX - half;
    this.pendingOriginZ = centerWorldZ - half;
    this.regionOrigin.value.set(this.pendingOriginX, this.pendingOriginZ);
    renderer.compute(this.computePass);

    if (!this.readbackInFlight) {
      this.readbackInFlight = true;
      const originX = this.pendingOriginX;
      const originZ = this.pendingOriginZ;
      const attribute = (this.buffer as any).value;

      renderer
        .getArrayBufferAsync(attribute)
        .then((arrayBuffer: ArrayBuffer) => {
          const data = new Float32Array(arrayBuffer);
          for (let i = 0; i < GRID_SIZE * GRID_SIZE; i += 1) {
            this.displacementsX[i] = data[i * 4];
            this.heights[i] = data[i * 4 + 1];
            this.displacementsZ[i] = data[i * 4 + 2];
          }
          this.readbackOriginX = originX;
          this.readbackOriginZ = originZ;
          this.hasData = true;
        })
        .catch(() => {
          // Device lost or buffer disposed; sampling simply stays stale.
        })
        .finally(() => {
          this.readbackInFlight = false;
        });
    }
  }

  /**
   * Water surface height at an absolute world position, compensating the
   * horizontal choppy displacement with a fixed-point iteration.
   */
  getHeightAt(worldX: number, worldZ: number): number | null {
    if (!this.hasData) return null;

    let sampleX = worldX;
    let sampleZ = worldZ;

    for (let i = 0; i < 3; i += 1) {
      const dx = this.bilinear(this.displacementsX, sampleX, sampleZ);
      const dz = this.bilinear(this.displacementsZ, sampleX, sampleZ);
      if (dx === null || dz === null) return null;
      sampleX = worldX - dx;
      sampleZ = worldZ - dz;
    }

    return this.bilinear(this.heights, sampleX, sampleZ);
  }

  /** Water surface normal at an absolute world position via finite differences. */
  getNormalAt(worldX: number, worldZ: number): { x: number; y: number; z: number } | null {
    const step = REGION_METERS / GRID_SIZE;
    const hL = this.getHeightAt(worldX - step, worldZ);
    const hR = this.getHeightAt(worldX + step, worldZ);
    const hD = this.getHeightAt(worldX, worldZ - step);
    const hU = this.getHeightAt(worldX, worldZ + step);
    if (hL === null || hR === null || hD === null || hU === null) return null;

    const normal = new THREE.Vector3((hL - hR) / (2 * step), 1, (hD - hU) / (2 * step)).normalize();
    return { x: normal.x, y: normal.y, z: normal.z };
  }

  private bilinear(field: Float32Array, worldX: number, worldZ: number): number | null {
    const cellSize = REGION_METERS / GRID_SIZE;
    const gx = (worldX - this.readbackOriginX) / cellSize;
    const gz = (worldZ - this.readbackOriginZ) / cellSize;

    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    if (x0 < 0 || z0 < 0 || x0 >= GRID_SIZE - 1 || z0 >= GRID_SIZE - 1) return null;

    const fx = gx - x0;
    const fz = gz - z0;
    const idx = (x: number, z: number): number => z * GRID_SIZE + x;

    const top = field[idx(x0, z0)] * (1 - fx) + field[idx(x0 + 1, z0)] * fx;
    const bottom = field[idx(x0, z0 + 1)] * (1 - fx) + field[idx(x0 + 1, z0 + 1)] * fx;
    return top * (1 - fz) + bottom * fz;
  }
}
