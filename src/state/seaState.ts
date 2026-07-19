import type { DebugSettings, WeatherState } from "../engine/types";

export const GRAVITY_MS2 = 9.81;

/**
 * Physical sea state parameters that drive the JONSWAP spectrum.
 * All values are in SI units.
 */
export type SeaStateParams = {
  seed: number;
  windSpeedMs: number;
  windDirectionRad: number;
  fetchMeters: number;
  /** JONSWAP peak enhancement factor (1 = Pierson-Moskowitz, 3.3 = typical). */
  gamma: number;
  /** 0-1 amount of long-period swell energy added on top of the wind sea. */
  swellAmount: number;
  swellDirectionRad: number;
  /** Horizontal displacement multiplier (wave choppiness). */
  choppiness: number;
  /** Foam accumulation decay rate, 1/seconds. */
  foamDecay: number;
};

/** Beaufort number to 10 m wind speed (m/s), empirical relation U = 0.836 B^1.5. */
export function beaufortToWindSpeed(beaufort: number): number {
  return 0.836 * Math.pow(Math.max(0, beaufort), 1.5);
}

/** Inverse of the empirical Beaufort relation used by the authoring UI. */
export function windSpeedToBeaufort(windSpeedMs: number): number {
  return Math.pow(Math.max(0, windSpeedMs) / 0.836, 2 / 3);
}

/**
 * JONSWAP peak angular frequency for wind speed U and fetch F, capped at the
 * fully developed (Pierson-Moskowitz) peak so long fetches cannot produce a
 * sea more energetic than the wind can sustain.
 */
export function jonswapPeakOmega(windSpeedMs: number, fetchMeters: number): number {
  const u = Math.max(0.5, windSpeedMs);
  const f = Math.max(1000, fetchMeters);
  const fetchLimited = 22 * Math.pow((GRAVITY_MS2 * GRAVITY_MS2) / (u * f), 1 / 3);
  const fullyDeveloped = (0.855 * GRAVITY_MS2) / u;
  return Math.max(fetchLimited, fullyDeveloped);
}

/** JONSWAP alpha (Phillips constant analogue) for wind speed U and fetch F. */
export function jonswapAlpha(windSpeedMs: number, fetchMeters: number): number {
  const u = Math.max(0.5, windSpeedMs);
  const f = Math.max(1000, fetchMeters);
  return 0.076 * Math.pow((u * u) / (f * GRAVITY_MS2), 0.22);
}

export function buildSeaState(weather: WeatherState, settings: DebugSettings): SeaStateParams {
  const manual = settings.seaStateControlMode === "manual-overrides";
  const windSpeedMs = manual ? beaufortToWindSpeed(settings.beaufort) : weather.windSpeedMs;

  return {
    seed: Math.trunc(settings.oceanSeed) >>> 0,
    windSpeedMs,
    windDirectionRad: weather.windDirectionRad,
    fetchMeters: Math.max(20, settings.fetchKm) * 1000,
    gamma: 3.3,
    swellAmount: manual ? settings.swellAmount : weather.swellStrength,
    swellDirectionRad: manual ? (settings.swellDirectionDeg * Math.PI) / 180 : weather.swellDirectionRad,
    choppiness: settings.choppiness,
    foamDecay: settings.foamDecay
  };
}

export function lerpSeaState(from: SeaStateParams, to: SeaStateParams, t: number): SeaStateParams {
  const k = Math.min(1, Math.max(0, t));
  const angle = (a: number, b: number): number => {
    const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + delta * k;
  };
  const lerp = (a: number, b: number): number => a + (b - a) * k;

  return {
    // A seed transition would change phases; keep the current realization until
    // the smoothed parameters have reached their target.
    seed: k >= 1 ? to.seed : from.seed,
    windSpeedMs: lerp(from.windSpeedMs, to.windSpeedMs),
    windDirectionRad: angle(from.windDirectionRad, to.windDirectionRad),
    fetchMeters: lerp(from.fetchMeters, to.fetchMeters),
    gamma: lerp(from.gamma, to.gamma),
    swellAmount: lerp(from.swellAmount, to.swellAmount),
    swellDirectionRad: angle(from.swellDirectionRad, to.swellDirectionRad),
    choppiness: lerp(from.choppiness, to.choppiness),
    foamDecay: lerp(from.foamDecay, to.foamDecay)
  };
}

export function seaStatesDiffer(a: SeaStateParams, b: SeaStateParams): boolean {
  return (
    a.seed !== b.seed ||
    Math.abs(a.windSpeedMs - b.windSpeedMs) > 0.01 ||
    Math.abs(a.windDirectionRad - b.windDirectionRad) > 0.001 ||
    Math.abs(a.fetchMeters - b.fetchMeters) > 500 ||
    Math.abs(a.gamma - b.gamma) > 0.01 ||
    Math.abs(a.swellAmount - b.swellAmount) > 0.005 ||
    Math.abs(a.swellDirectionRad - b.swellDirectionRad) > 0.001
  );
}
