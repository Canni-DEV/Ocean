import * as THREE from "three/webgpu";
import {
  Fn,
  cos,
  exp,
  float,
  instanceIndex,
  max,
  min,
  select,
  sin,
  sqrt,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec2,
  vec4
} from "three/tsl";
import { GRAVITY_MS2, type SeaStateParams } from "../../state/seaState";
import {
  applySeaStateToSpectrum,
  createInitialSpectrumPass,
  createSpectrumStorageTexture,
  createSpectrumUniforms,
  type SpectrumUniforms
} from "./OceanSpectrum";
import { deriveCascadeSeed } from "./OceanMath";

type NodeRef = any;

const TWO_PI = Math.PI * 2;

export type CascadeRole = "swell" | "windSea" | "chop";

export type CascadeConfig = {
  index: number;
  role: CascadeRole;
  patchSize: number;
  resolution: number;
  kMin: number;
  kMax: number;
  lowerCrossover: number | null;
  upperCrossover: number | null;
  overlapRatio: number;
  choppinessScale: number;
  choppinessLimit: number;
  representativeWavelength: number;
  slopeVariance: number;
};

export type SimulationUniforms = {
  time: NodeRef;
  deltaTime: NodeRef;
  choppiness: NodeRef;
  foamDecay: NodeRef;
  foamBias: NodeRef;
  foamScale: NodeRef;
};

/** Complex multiply helper (a, b are vec2 nodes packing re/im). */
function cMul(a: NodeRef, b: NodeRef): NodeRef {
  return vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));
}

function createFloatOutputTexture(resolution: number, name: string): THREE.StorageTexture {
  const texture = new THREE.StorageTexture(resolution, resolution);
  texture.name = name;
  texture.type = THREE.HalfFloatType;
  texture.format = THREE.RGBAFormat;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  (texture as any).mipmapsAutoUpdate = false;
  return texture;
}

function createFoamOutputTexture(resolution: number, name: string): THREE.StorageTexture {
  const texture = createFloatOutputTexture(resolution, name);
  // r16float is a core WebGPU storage format. RGBA16F remains the natural
  // fallback: changing this format back does not alter the shader contract.
  texture.format = THREE.RedFormat;
  return texture;
}

function createSlopeMomentTexture(resolution: number, name: string): THREE.StorageTexture {
  const texture = createFloatOutputTexture(resolution, name);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // The WebGPU backend performs a box reduction after the level-zero compute
  // write. Since the texels contain raw moments, linear mip generation is the
  // exact reduction required for means and second moments.
  (texture as any).mipmapsAutoUpdate = true;
  return texture;
}

/**
 * One FFT cascade: band-limited JONSWAP spectrum, evolved in time and converted
 * to spatial displacement + derivative maps through a Stockham inverse FFT.
 *
 * Texture packing (two RGBA32F ping-pong pairs, each channel pair one complex):
 * - texA.rg: Dx + i*Dz          -> after IFFT: (Dx, Dz)
 * - texA.ba: Dy + i*dDy/dx      -> after IFFT: (Dy, slopeX)
 * - texB.rg: dDy/dz + i*dDx/dx  -> after IFFT: (slopeZ, Jxx)
 * - texB.ba: dDz/dz + i*dDx/dz  -> after IFFT: (Jzz, Jxz)
 *
 * Outputs keep raw derivatives so the renderer can sum all cascades before
 * constructing the total displaced-surface tangents and normal.
 */
export class OceanCascade {
  readonly config: CascadeConfig;
  readonly resolution: number;
  readonly displacementTexture: THREE.StorageTexture;
  readonly derivativeTexture0: THREE.StorageTexture;
  readonly derivativeTexture1: THREE.StorageTexture;
  readonly foamTextures: [THREE.StorageTexture, THREE.StorageTexture];
  readonly slopeMomentTexture0: THREE.StorageTexture;
  readonly slopeMomentTexture1: THREE.StorageTexture;
  readonly slopeMomentMipCount: number;

  private readonly h0Texture: THREE.StorageTexture;
  private readonly spectrumA: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly spectrumB: [THREE.StorageTexture, THREE.StorageTexture];
  private readonly spectrumUniforms: SpectrumUniforms;
  private readonly initialSpectrumPass: NodeRef;
  private readonly evolvePass: NodeRef;
  private readonly fftPasses: NodeRef[];
  private readonly assemblePasses: [NodeRef, NodeRef];
  private readonly slopeMomentBasePass: NodeRef;
  private frameParity = 0;
  private spectrumDirty = true;
  private lastSlopeMomentComputeMs = 0;

  constructor(config: CascadeConfig, uniforms: SimulationUniforms) {
    this.resolution = config.resolution;
    this.config = config;

    const n = config.resolution;
    const label = `cascade-${config.patchSize}m`;

    this.h0Texture = createSpectrumStorageTexture(n, `${label}-h0`);
    this.spectrumA = [
      createSpectrumStorageTexture(n, `${label}-specA0`),
      createSpectrumStorageTexture(n, `${label}-specA1`)
    ];
    this.spectrumB = [
      createSpectrumStorageTexture(n, `${label}-specB0`),
      createSpectrumStorageTexture(n, `${label}-specB1`)
    ];
    this.displacementTexture = createFloatOutputTexture(n, `${label}-displacement`);
    this.derivativeTexture0 = createFloatOutputTexture(n, `${label}-derivatives0`);
    this.derivativeTexture1 = createFloatOutputTexture(n, `${label}-derivatives1`);
    this.slopeMomentTexture0 = createSlopeMomentTexture(n, `${label}-slope-moments0`);
    this.slopeMomentTexture1 = createSlopeMomentTexture(n, `${label}-slope-moments1`);
    this.slopeMomentMipCount = Math.floor(Math.log2(n)) + 1;
    this.foamTextures = [
      createFoamOutputTexture(n, `${label}-foam0`),
      createFoamOutputTexture(n, `${label}-foam1`)
    ];

    this.spectrumUniforms = createSpectrumUniforms();
    this.initialSpectrumPass = createInitialSpectrumPass(
      this.h0Texture,
      n,
      config.patchSize,
      config,
      this.spectrumUniforms
    );

    this.evolvePass = this.createEvolvePass(uniforms);
    this.fftPasses = this.createFFTPasses();
    this.assemblePasses = [this.createAssemblePass(uniforms, 0), this.createAssemblePass(uniforms, 1)];
    this.slopeMomentBasePass = this.createSlopeMomentBasePass();
  }

  get currentFoamTexture(): THREE.StorageTexture {
    return this.foamTextures[this.frameParity];
  }

  get slopeMomentComputeMs(): number {
    return this.lastSlopeMomentComputeMs;
  }

  markSpectrumDirty(): void {
    this.spectrumDirty = true;
  }

  applySeaState(params: SeaStateParams): void {
    applySeaStateToSpectrum(this.spectrumUniforms, params, deriveCascadeSeed(params.seed, this.config.index));
  }

  update(renderer: THREE.WebGPURenderer): void {
    if (this.spectrumDirty) {
      renderer.compute(this.initialSpectrumPass);
      this.spectrumDirty = false;
    }

    this.frameParity = 1 - this.frameParity;
    renderer.compute(this.evolvePass);
    for (const pass of this.fftPasses) {
      renderer.compute(pass);
    }
    renderer.compute(this.assemblePasses[this.frameParity]);
    const momentStart = performance.now();
    renderer.compute(this.slopeMomentBasePass);
    this.lastSlopeMomentComputeMs = performance.now() - momentStart;
  }

  dispose(): void {
    this.h0Texture.dispose();
    this.spectrumA.forEach((texture) => texture.dispose());
    this.spectrumB.forEach((texture) => texture.dispose());
    this.displacementTexture.dispose();
    this.derivativeTexture0.dispose();
    this.derivativeTexture1.dispose();
    this.slopeMomentTexture0.dispose();
    this.slopeMomentTexture1.dispose();
    this.foamTextures.forEach((texture) => texture.dispose());
  }

  /**
   * Level zero stores the raw mean and second moments. WebGPU's storage-texture
   * mip generator performs the remaining 2x2 reductions before shader reads.
   */
  private createSlopeMomentBasePass(): NodeRef {
    const n = this.resolution;
    const derivatives0 = this.derivativeTexture0;
    const derivatives1 = this.derivativeTexture1;
    const target0 = this.slopeMomentTexture0;
    const target1 = this.slopeMomentTexture1;

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);
      const raw0 = textureLoad(derivatives0, texel);
      const raw1 = textureLoad(derivatives1, texel);
      const slope = raw0.xy;
      textureStore(target0, texel, vec4(slope.x, slope.y, slope.x.mul(slope.x), slope.y.mul(slope.y)));
      // The base level's spare channels keep the horizontal derivatives so the
      // render material does not need six additional derivative bindings.
      textureStore(target1, texel, vec4(slope.x.mul(slope.y), raw0.z, raw0.w, raw1.x));
    })().compute(n * n);
  }

  /** Evolves h0 to time t and packs displacement/derivative spectra. */
  private createEvolvePass(uniforms: SimulationUniforms): NodeRef {
    const n = this.resolution;
    const dk = TWO_PI / this.config.patchSize;
    const h0Texture = this.h0Texture;
    const targetA = this.spectrumA[0];
    const targetB = this.spectrumB[0];

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);

      const freqX = select(x.lessThan(uint(n / 2)), x.toFloat(), x.toFloat().sub(n));
      const freqZ = select(y.lessThan(uint(n / 2)), y.toFloat(), y.toFloat().sub(n));
      const kx = freqX.mul(dk);
      const kz = freqZ.mul(dk);
      const kLen = sqrt(kx.mul(kx).add(kz.mul(kz)));
      const safeK = max(kLen, float(1e-5));

      const h0: NodeRef = textureLoad(h0Texture, texel);
      const omega = sqrt(safeK.mul(GRAVITY_MS2));
      const phase = omega.mul(uniforms.time);
      const c = cos(phase);
      const s = sin(phase);

      // h = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t}
      const hr: NodeRef = h0.x.mul(c).sub(h0.y.mul(s)).add(h0.z.mul(c).sub(h0.w.mul(s)));
      const hi: NodeRef = h0.x.mul(s).add(h0.y.mul(c)).sub(h0.z.mul(s).add(h0.w.mul(c)));
      const h: NodeRef = vec2(hr, hi);

      const kxOverK = kx.div(safeK);
      const kzOverK = kz.div(safeK);

      // Horizontal displacement spectra: D = -i k/|k| h
      const dx = vec2(h.y.mul(kxOverK), h.x.negate().mul(kxOverK));
      const dz = vec2(h.y.mul(kzOverK), h.x.negate().mul(kzOverK));
      // Slope spectra: S = i k h
      const sx = vec2(h.y.negate().mul(kx), h.x.mul(kx));
      const sz = vec2(h.y.negate().mul(kz), h.x.mul(kz));
      // Jacobian spectra: real multipliers of h
      const jxx = h.mul(kx.mul(kx).div(safeK));
      const jzz = h.mul(kz.mul(kz).div(safeK));
      const jxz = h.mul(kx.mul(kz).div(safeK));

      // Pack two real signals per complex channel: C = A + i*B
      const packedA = vec4(
        dx.x.sub(dz.y),
        dx.y.add(dz.x),
        h.x.sub(sx.y),
        h.y.add(sx.x)
      );
      const packedB = vec4(
        sz.x.sub(jxx.y),
        sz.y.add(jxx.x),
        jzz.x.sub(jxz.y),
        jzz.y.add(jxz.x)
      );

      textureStore(targetA, texel, packedA);
      textureStore(targetB, texel, packedB);
    })().compute(n * n);
  }

  /**
   * Stockham radix-2 inverse FFT. Each pass processes n/2 butterflies per row
   * (or column) for both packed texture pairs at once.
   */
  private createFFTPasses(): NodeRef[] {
    const n = this.resolution;
    const stages = Math.round(Math.log2(n));
    const passes: NodeRef[] = [];
    let sourceIndex = 0;

    for (let direction = 0; direction < 2; direction += 1) {
      const horizontal = direction === 0;
      for (let stage = 0; stage < stages; stage += 1) {
        const ns = 1 << stage;
        const srcA = this.spectrumA[sourceIndex];
        const srcB = this.spectrumB[sourceIndex];
        const dstA = this.spectrumA[1 - sourceIndex];
        const dstB = this.spectrumB[1 - sourceIndex];
        passes.push(this.createFFTPass(srcA, srcB, dstA, dstB, ns, horizontal));
        sourceIndex = 1 - sourceIndex;
      }
    }

    if (sourceIndex !== 0) {
      throw new Error("Ocean FFT pass count must leave the result in the first spectrum texture");
    }

    return passes;
  }

  private createFFTPass(
    srcA: THREE.StorageTexture,
    srcB: THREE.StorageTexture,
    dstA: THREE.StorageTexture,
    dstB: THREE.StorageTexture,
    ns: number,
    horizontal: boolean
  ): NodeRef {
    const n = this.resolution;
    const half = n / 2;

    return Fn(() => {
      const t = instanceIndex.mod(uint(half));
      const line = instanceIndex.div(uint(half));

      const p = t.mod(uint(ns));
      const groupBase = t.div(uint(ns)).mul(uint(ns * 2));
      const outEvenIndex = groupBase.add(p);
      const outOddIndex = outEvenIndex.add(uint(ns));

      // Inverse transform twiddle e^{+2 pi i p / (2 Ns)}
      const angle = p.toFloat().mul(Math.PI / ns);
      const twiddle = vec2(cos(angle), sin(angle));

      const readEven = horizontal ? uvec2(t, line) : uvec2(line, t);
      const readOdd = horizontal ? uvec2(t.add(uint(half)), line) : uvec2(line, t.add(uint(half)));
      const writeEven = horizontal ? uvec2(outEvenIndex, line) : uvec2(line, outEvenIndex);
      const writeOdd = horizontal ? uvec2(outOddIndex, line) : uvec2(line, outOddIndex);

      const a0: NodeRef = textureLoad(srcA, readEven);
      const a1: NodeRef = textureLoad(srcA, readOdd);
      const b0: NodeRef = textureLoad(srcB, readEven);
      const b1: NodeRef = textureLoad(srcB, readOdd);

      const a1First = cMul(twiddle, a1.xy);
      const a1Second = cMul(twiddle, a1.zw);
      const b1First = cMul(twiddle, b1.xy);
      const b1Second = cMul(twiddle, b1.zw);

      textureStore(dstA, writeEven, vec4(a0.xy.add(a1First), a0.zw.add(a1Second)));
      textureStore(dstA, writeOdd, vec4(a0.xy.sub(a1First), a0.zw.sub(a1Second)));
      textureStore(dstB, writeEven, vec4(b0.xy.add(b1First), b0.zw.add(b1Second)));
      textureStore(dstB, writeOdd, vec4(b0.xy.sub(b1First), b0.zw.sub(b1Second)));
    })().compute(n * half);
  }

  /** Converts IFFT output to displacement/derivative maps with foam accumulation. */
  private createAssemblePass(uniforms: SimulationUniforms, parity: 0 | 1): NodeRef {
    const n = this.resolution;
    const sourceA = this.spectrumA[0];
    const sourceB = this.spectrumB[0];
    const previousFoamTexture = this.foamTextures[1 - parity];
    const displacementTarget = this.displacementTexture;
    const derivativesTarget0 = this.derivativeTexture0;
    const derivativesTarget1 = this.derivativeTexture1;
    const foamTarget = this.foamTextures[parity];

    return Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const texel = uvec2(x, y);

      const resultA: NodeRef = textureLoad(sourceA, texel);
      const resultB: NodeRef = textureLoad(sourceB, texel);

      const dispX = resultA.x;
      const dispZ = resultA.y;
      const dispY = resultA.z;
      const slopeX = resultA.w;
      const slopeZ = resultB.x;
      const jxx = resultB.y;
      const jzz = resultB.z;
      const jxz = resultB.w;

      const lambda = min(
        uniforms.choppiness.mul(this.config.choppinessScale),
        float(this.config.choppinessLimit)
      );
      const stretchX = jxx.mul(lambda).add(1);
      const stretchZ = jzz.mul(lambda).add(1);
      const shearTerm = jxz.mul(lambda);
      const jacobian = stretchX.mul(stretchZ).sub(shearTerm.mul(shearTerm));

      const foamSource = uniforms.foamBias.sub(jacobian).mul(uniforms.foamScale).clamp(0, 1);
      const previousFoam = textureLoad(previousFoamTexture, texel).x;
      const decayed = previousFoam.mul(exp(uniforms.foamDecay.negate().mul(uniforms.deltaTime)));
      const foam = min(max(foamSource, decayed), float(1));

      textureStore(
        displacementTarget,
        texel,
        vec4(dispX.mul(lambda), dispY, dispZ.mul(lambda), jacobian)
      );
      textureStore(derivativesTarget0, texel, vec4(slopeX, slopeZ, jxx, jzz));
      // The spectral model is symmetric, therefore dDx/dz == dDz/dx.
      textureStore(derivativesTarget1, texel, vec4(jxz, jxz, jacobian, 0));
      textureStore(foamTarget, texel, vec4(foam, 0, 0, 0));
    })().compute(n * n);
  }
}

export function createSimulationUniforms(): SimulationUniforms {
  return {
    time: uniform(0),
    deltaTime: uniform(1 / 60),
    choppiness: uniform(0.7),
    foamDecay: uniform(0.28),
    foamBias: uniform(0.62),
    foamScale: uniform(1.9)
  };
}
