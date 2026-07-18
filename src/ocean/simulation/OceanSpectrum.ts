import * as THREE from "three/webgpu";
import {
  Fn,
  atan,
  cos,
  exp,
  float,
  hash,
  instanceIndex,
  log,
  max,
  pow,
  select,
  sin,
  sqrt,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec2,
  vec4
} from "three/tsl";
import { GRAVITY_MS2, jonswapAlpha, jonswapPeakOmega, type SeaStateParams } from "../../state/seaState";
import type { CascadeConfig } from "./OceanFFT";

type NodeRef = any;

const TWO_PI = Math.PI * 2;
const INV_SQRT2 = Math.SQRT1_2;
/** Swell peak angular frequency (~11 s period, ~190 m wavelength). */
const SWELL_OMEGA = 0.57;
/**
 * Compensates the double energy count from packing h0(+k) and h0(-k) per texel
 * (each carries the full spectral amplitude, doubling the surface variance).
 */
const ENERGY_SCALE = 0.5;

export type SpectrumUniforms = {
  alpha: NodeRef;
  peakOmega: NodeRef;
  gamma: NodeRef;
  windDirection: NodeRef;
  swellAmount: NodeRef;
  swellDirection: NodeRef;
  cascadeSeed: NodeRef;
};

export function createSpectrumUniforms(): SpectrumUniforms {
  return {
    alpha: uniform(0.01),
    peakOmega: uniform(1),
    gamma: uniform(3.3),
    windDirection: uniform(0),
    swellAmount: uniform(0.3),
    swellDirection: uniform(0),
    cascadeSeed: uniform(0)
  };
}

export function applySeaStateToSpectrum(uniforms: SpectrumUniforms, params: SeaStateParams, cascadeSeed: number): void {
  uniforms.alpha.value = jonswapAlpha(params.windSpeedMs, params.fetchMeters);
  uniforms.peakOmega.value = jonswapPeakOmega(params.windSpeedMs, params.fetchMeters);
  uniforms.gamma.value = params.gamma;
  uniforms.windDirection.value = params.windDirectionRad;
  uniforms.swellAmount.value = params.swellAmount;
  uniforms.swellDirection.value = params.swellDirectionRad;
  uniforms.cascadeSeed.value = cascadeSeed & 0x00ffffff;
}

export function createSpectrumStorageTexture(resolution: number, name: string): THREE.StorageTexture {
  const texture = new THREE.StorageTexture(resolution, resolution);
  texture.name = name;
  texture.type = THREE.FloatType;
  texture.format = THREE.RGBAFormat;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  (texture as any).mipmapsAutoUpdate = false;
  return texture;
}

/**
 * JONSWAP + directional spreading + swell ridge, evaluated for one wave vector.
 * Returns the per-texel amplitude sqrt(2 * S(omega, theta) * domega/dk / k) * dk.
 */
function spectrumAmplitude(
  kx: NodeRef,
  kz: NodeRef,
  kLen: NodeRef,
  dk: number,
  config: CascadeConfig,
  u: SpectrumUniforms
): NodeRef {
  const safeK = max(kLen, float(1e-5));
  const omega = sqrt(safeK.mul(GRAVITY_MS2));
  const dOmegaDk = float(GRAVITY_MS2).div(omega.mul(2));

  // JONSWAP frequency spectrum
  const wp = max(u.peakOmega, float(1e-3));
  const sigma = select(omega.lessThanEqual(wp), float(0.07), float(0.09));
  const omegaDelta = omega.sub(wp);
  const peakExponent = omegaDelta.mul(omegaDelta).div(sigma.mul(sigma).mul(wp).mul(wp).mul(2)).negate();
  const jonswap = u.alpha
    .mul(GRAVITY_MS2 * GRAVITY_MS2)
    .div(omega.pow(5))
    .mul(exp(wp.div(omega).pow(4).mul(-1.25)))
    .mul(pow(u.gamma, exp(peakExponent)));

  // Hasselmann-style directional spreading, cos^{2s}((theta - windDir)/2)
  const theta = atan(kz, kx);
  const deltaWind = theta.sub(u.windDirection);
  const cosHalf = cos(deltaWind.mul(0.5)).abs();
  const ratio = omega.div(wp);
  const spreadPower = select(
    ratio.lessThan(1),
    ratio.pow(4.06).mul(6.97),
    ratio.pow(-2.33).mul(9.77)
  ).clamp(0.2, 24);
  const spreadNorm = max(float(1 / TWO_PI), sqrt(spreadPower.div(Math.PI)).mul(0.5));
  const spread = spreadNorm.mul(pow(max(cosHalf, float(1e-4)), spreadPower.mul(2)));

  let totalSpectrum: NodeRef = jonswap.mul(spread);

  // Narrow long-period swell ridge aimed at swellDirection
  const swellSigma = 0.14 * SWELL_OMEGA;
  const swellDelta = omega.sub(SWELL_OMEGA);
  const swellRidge = exp(swellDelta.mul(swellDelta).div(2 * swellSigma * swellSigma).negate());
  const swellSpread = pow(max(cos(theta.sub(u.swellDirection)), float(0)), float(64)).mul(3.2);
  totalSpectrum = totalSpectrum.add(
    u.swellAmount.mul(u.swellAmount).mul(0.12).mul(swellRidge).mul(swellSpread)
  );

  const variance = totalSpectrum.mul(dOmegaDk).div(safeK).mul(dk * dk).mul(ENERGY_SCALE);
  const amplitude = sqrt(variance.mul(2));

  let bandWeight: NodeRef = float(1);
  if (config.lowerCrossover !== null) {
    const start = Math.log(config.lowerCrossover / (1 + config.overlapRatio));
    const end = Math.log(config.lowerCrossover * (1 + config.overlapRatio));
    const t = log(safeK).sub(start).div(end - start).clamp(0, 1);
    bandWeight = bandWeight.mul(sin(t.mul(Math.PI * 0.5)));
  }
  if (config.upperCrossover !== null) {
    const start = Math.log(config.upperCrossover / (1 + config.overlapRatio));
    const end = Math.log(config.upperCrossover * (1 + config.overlapRatio));
    const t = log(safeK).sub(start).div(end - start).clamp(0, 1);
    bandWeight = bandWeight.mul(cos(t.mul(Math.PI * 0.5)));
  }
  const inBand = kLen.greaterThanEqual(float(config.kMin)).and(kLen.lessThan(float(config.kMax)));
  return select(inBand, amplitude.mul(bandWeight), float(0));
}

/** Two independent standard gaussians from a deterministic per-texel seed. */
function gaussianPair(seedIndex: NodeRef, saltA: number, saltB: number): NodeRef {
  const u1 = max(hash(seedIndex.add(saltA)), float(1e-6));
  const u2 = hash(seedIndex.add(saltB));
  const radius = sqrt(log(u1).mul(-2));
  const phi = u2.mul(TWO_PI);
  return vec2(cos(phi), sin(phi)).mul(radius);
}

/**
 * Compute pass that (re)generates the initial spectrum h0 for one cascade.
 * Output texel: (h0(k).re, h0(k).im, h0(-k).re, h0(-k).im).
 * The RNG is a pure function of the texel coordinates so that texel k and its
 * mirror texel -k always agree on the random draws (keeps the surface real-valued).
 */
export function createInitialSpectrumPass(
  target: THREE.StorageTexture,
  resolution: number,
  patchSize: number,
  config: CascadeConfig,
  u: SpectrumUniforms
): NodeRef {
  const n = resolution;
  const dk = TWO_PI / patchSize;

  return Fn(() => {
    const x = instanceIndex.mod(uint(n));
    const y = instanceIndex.div(uint(n));

    const freqX = select(x.lessThan(uint(n / 2)), x.toFloat(), x.toFloat().sub(n));
    const freqZ = select(y.lessThan(uint(n / 2)), y.toFloat(), y.toFloat().sub(n));
    const kx = freqX.mul(dk);
    const kz = freqZ.mul(dk);
    const kLen = sqrt(kx.mul(kx).add(kz.mul(kz)));

    const mirrorX = uint(n).sub(x).mod(uint(n));
    const mirrorY = uint(n).sub(y).mod(uint(n));
    const seedSelf = x.add(y.mul(uint(n))).toFloat().add(u.cascadeSeed);
    const seedMirror = mirrorX.add(mirrorY.mul(uint(n))).toFloat().add(u.cascadeSeed);

    const gaussSelf = gaussianPair(seedSelf, 1, n * n + 7);
    const gaussMirror = gaussianPair(seedMirror, 1, n * n + 7);

    const ampPlus = spectrumAmplitude(kx, kz, kLen, dk, config, u);
    const ampMinus = spectrumAmplitude(kx.negate(), kz.negate(), kLen, dk, config, u);

    const h0k = gaussSelf.mul(ampPlus.mul(INV_SQRT2));
    const h0MinusK = gaussMirror.mul(ampMinus.mul(INV_SQRT2));

    textureStore(target, uvec2(x, y), vec4(h0k, h0MinusK));
  })().compute(n * n);
}
