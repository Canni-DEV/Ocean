import * as THREE from "three/webgpu";
import type { QualityTier } from "../../engine/types";
import { jonswapAlpha, jonswapPeakOmega, seaStatesDiffer, type SeaStateParams } from "../../state/seaState";
import {
  createSimulationUniforms,
  OceanCascade,
  type CascadeConfig,
  type CascadeRole,
  type SimulationUniforms
} from "./OceanFFT";

export type CascadeProfile = {
  role: CascadeRole;
  patchSize: number;
  resolution: number;
  choppinessScale: number;
  choppinessLimit: number;
  slopeVariance: number;
};

export type OceanQualityConfig = {
  cascades: readonly CascadeProfile[];
  slopeMoments: "full-mip-chain";
  meshRings: number;
  meshSectors: number;
  meshInnerRadius: number;
  envMapSize: number;
  envMapIntervalMs: number;
};

export const OCEAN_QUALITY: Record<QualityTier, OceanQualityConfig> = {
  low: {
    cascades: [
      { role: "swell", patchSize: 1024, resolution: 128, choppinessScale: 0.75, choppinessLimit: 0.8, slopeVariance: 0.012 },
      { role: "windSea", patchSize: 128, resolution: 128, choppinessScale: 1.0, choppinessLimit: 1.0, slopeVariance: 0.045 }
    ],
    slopeMoments: "full-mip-chain",
    meshRings: 110,
    meshSectors: 112,
    meshInnerRadius: 1.6,
    envMapSize: 64,
    envMapIntervalMs: 500
  },
  medium: {
    cascades: [
      { role: "swell", patchSize: 1536, resolution: 256, choppinessScale: 0.75, choppinessLimit: 0.8, slopeVariance: 0.012 },
      { role: "windSea", patchSize: 384, resolution: 256, choppinessScale: 1.0, choppinessLimit: 1.0, slopeVariance: 0.035 },
      { role: "chop", patchSize: 96, resolution: 256, choppinessScale: 1.1, choppinessLimit: 1.1, slopeVariance: 0.075 }
    ],
    slopeMoments: "full-mip-chain",
    meshRings: 150,
    meshSectors: 168,
    meshInnerRadius: 1.1,
    envMapSize: 128,
    envMapIntervalMs: 250
  },
  high: {
    cascades: [
      { role: "swell", patchSize: 2048, resolution: 256, choppinessScale: 0.75, choppinessLimit: 0.8, slopeVariance: 0.012 },
      { role: "windSea", patchSize: 512, resolution: 512, choppinessScale: 1.0, choppinessLimit: 1.0, slopeVariance: 0.035 },
      { role: "chop", patchSize: 128, resolution: 512, choppinessScale: 1.1, choppinessLimit: 1.1, slopeVariance: 0.075 }
    ],
    slopeMoments: "full-mip-chain",
    meshRings: 190,
    meshSectors: 224,
    meshInnerRadius: 0.8,
    envMapSize: 256,
    envMapIntervalMs: 100
  }
};

const OVERLAP_RATIO = 0.2;

function buildCascadeConfigs(profiles: readonly CascadeProfile[]): CascadeConfig[] {
  const safeMax = profiles.map((profile) => (Math.PI * profile.resolution * 0.72) / profile.patchSize);
  const crossovers = safeMax.slice(0, -1);

  return profiles.map((profile, index) => {
    const fundamental = (Math.PI * 2) / profile.patchSize;
    const lowerCrossover = index === 0 ? null : crossovers[index - 1];
    const upperCrossover = index === profiles.length - 1 ? null : crossovers[index];
    return {
      index,
      role: profile.role,
      patchSize: profile.patchSize,
      resolution: profile.resolution,
      kMin: lowerCrossover === null ? fundamental : lowerCrossover / (1 + OVERLAP_RATIO),
      kMax: upperCrossover === null ? safeMax[index] : upperCrossover * (1 + OVERLAP_RATIO),
      lowerCrossover,
      upperCrossover,
      overlapRatio: OVERLAP_RATIO,
      choppinessScale: profile.choppinessScale,
      choppinessLimit: profile.choppinessLimit,
      // Spectrum generation intentionally stops at 72% of Nyquist. Report the
      // shortest wavelength that is actually present, not the ideal 2-cell one.
      representativeWavelength: (profile.patchSize / profile.resolution) * (2 / 0.72),
      slopeVariance: profile.slopeVariance
    };
  });
}

export type OceanSpectrumMetrics = {
  energy: number;
  heightVariance: number;
  slopeVariance: number;
  correlation: number;
};

export class OceanSimulation {
  readonly cascades: OceanCascade[];
  readonly uniforms: SimulationUniforms;
  readonly quality: OceanQualityConfig;

  private currentSeaState: SeaStateParams | null = null;
  private lastComputeMs = 0;
  private spectrumMetrics: OceanSpectrumMetrics[] = [];

  constructor(tier: QualityTier) {
    this.quality = OCEAN_QUALITY[tier];
    this.uniforms = createSimulationUniforms();
    const configs = buildCascadeConfigs(this.quality.cascades);
    this.cascades = configs.map((config) => new OceanCascade(config, this.uniforms));
    this.spectrumMetrics = configs.map((config) => ({
      energy: config.slopeVariance * config.patchSize,
      heightVariance: config.slopeVariance * config.representativeWavelength ** 2 / (Math.PI * Math.PI * 4),
      slopeVariance: config.slopeVariance,
      correlation: 0
    }));
  }

  get computeMs(): number {
    return this.lastComputeMs;
  }

  get metrics(): readonly OceanSpectrumMetrics[] {
    return this.spectrumMetrics;
  }

  get slopeMomentComputeMs(): number {
    return this.cascades.reduce((sum, cascade) => sum + cascade.slopeMomentComputeMs, 0);
  }

  setSeaState(params: SeaStateParams): void {
    const changed = this.currentSeaState === null || seaStatesDiffer(this.currentSeaState, params);
    this.currentSeaState = { ...params };
    this.uniforms.choppiness.value = params.choppiness;
    this.uniforms.foamDecay.value = params.foamDecay;

    if (changed) {
      const alpha = jonswapAlpha(params.windSpeedMs, params.fetchMeters);
      const peakOmega = jonswapPeakOmega(params.windSpeedMs, params.fetchMeters);
      this.spectrumMetrics = this.cascades.map((cascade) => {
        const seaScale = Math.max(0.05, alpha * 100) * (1 + params.swellAmount * (cascade.config.role === "swell" ? 0.7 : 0.1));
        const slopeVariance = cascade.config.slopeVariance * seaScale;
        return {
          energy: slopeVariance * cascade.config.patchSize / Math.max(0.2, peakOmega),
          heightVariance: slopeVariance * cascade.config.representativeWavelength ** 2 / (Math.PI * Math.PI * 4),
          slopeVariance,
          correlation: 0
        };
      });
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
    for (const cascade of this.cascades) cascade.update(renderer);
    this.lastComputeMs = performance.now() - start;
  }

  dispose(): void {
    this.cascades.forEach((cascade) => cascade.dispose());
  }
}
