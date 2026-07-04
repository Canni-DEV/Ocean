import * as THREE from "three/webgpu";
import type { QualityTier } from "../../engine/types";
import { seaStatesDiffer, type SeaStateParams } from "../../state/seaState";
import {
  createSimulationUniforms,
  OceanCascade,
  type CascadeConfig,
  type SimulationUniforms
} from "./OceanFFT";

export type OceanQualityConfig = {
  fftResolution: number;
  cascadeCount: 2 | 3;
  meshRings: number;
  meshSectors: number;
  meshInnerRadius: number;
  envMapSize: number;
  envMapIntervalMs: number;
};

export const OCEAN_QUALITY: Record<QualityTier, OceanQualityConfig> = {
  low: {
    fftResolution: 128,
    cascadeCount: 2,
    meshRings: 110,
    meshSectors: 112,
    meshInnerRadius: 1.6,
    envMapSize: 64,
    envMapIntervalMs: 500
  },
  medium: {
    fftResolution: 256,
    cascadeCount: 3,
    meshRings: 150,
    meshSectors: 168,
    meshInnerRadius: 1.1,
    envMapSize: 128,
    envMapIntervalMs: 250
  },
  high: {
    fftResolution: 512,
    cascadeCount: 3,
    meshRings: 190,
    meshSectors: 224,
    meshInnerRadius: 0.8,
    envMapSize: 256,
    envMapIntervalMs: 100
  }
};

/** Patch sizes with non-integer ratios to avoid visible tiling alignment. */
const CASCADE_PATCH_SIZES: Record<2 | 3, number[]> = {
  2: [217, 27],
  3: [251, 61, 13]
};

function buildCascadeConfigs(resolution: number, cascadeCount: 2 | 3): CascadeConfig[] {
  const patchSizes = CASCADE_PATCH_SIZES[cascadeCount];
  const configs: CascadeConfig[] = [];

  for (let i = 0; i < patchSizes.length; i += 1) {
    const patchSize = patchSizes[i];
    const nyquist = (Math.PI * resolution) / patchSize;
    const isLast = i === patchSizes.length - 1;
    const kMin = i === 0 ? 0.0001 : configs[i - 1].kMax;
    const kMax = isLast ? nyquist * 0.72 : Math.min(nyquist * 0.5, (Math.PI * resolution) / patchSizes[i + 1]);
    configs.push({ patchSize, kMin, kMax });
  }

  return configs;
}

/**
 * Owns the FFT cascades and shared simulation uniforms. Runs all compute work
 * for one frame via `update()`.
 */
export class OceanSimulation {
  readonly cascades: OceanCascade[];
  readonly uniforms: SimulationUniforms;
  readonly quality: OceanQualityConfig;

  private currentSeaState: SeaStateParams | null = null;
  private lastComputeMs = 0;

  constructor(tier: QualityTier) {
    this.quality = OCEAN_QUALITY[tier];
    this.uniforms = createSimulationUniforms();

    const configs = buildCascadeConfigs(this.quality.fftResolution, this.quality.cascadeCount);
    this.cascades = configs.map((config) => new OceanCascade(this.quality.fftResolution, config, this.uniforms));
  }

  get computeMs(): number {
    return this.lastComputeMs;
  }

  setSeaState(params: SeaStateParams): void {
    const changed = this.currentSeaState === null || seaStatesDiffer(this.currentSeaState, params);
    this.currentSeaState = { ...params };

    this.uniforms.choppiness.value = params.choppiness;
    this.uniforms.foamDecay.value = params.foamDecay;

    if (changed) {
      for (const cascade of this.cascades) {
        cascade.applySeaState(params);
        cascade.markSpectrumDirty();
      }
    }
  }

  update(renderer: THREE.WebGPURenderer, timeSeconds: number, deltaSeconds: number): void {
    const start = performance.now();
    this.uniforms.time.value = timeSeconds;
    this.uniforms.deltaTime.value = Math.max(1 / 240, Math.min(0.1, deltaSeconds));

    for (const cascade of this.cascades) {
      cascade.update(renderer);
    }

    this.lastComputeMs = performance.now() - start;
  }

  dispose(): void {
    this.cascades.forEach((cascade) => cascade.dispose());
  }
}
