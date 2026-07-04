import type { WeatherPresetName, WeatherState } from "../engine/types";

export const WEATHER_PRESETS: Record<WeatherPresetName, WeatherState> = {
  clear: {
    windDirectionRad: Math.PI * 0.12,
    windSpeedMs: 7,
    swellDirectionRad: Math.PI * 0.1,
    swellStrength: 0.38,
    cloudCoverage: 0.08,
    cloudDensity: 0.18,
    cloudBaseMeters: 2100,
    cloudThicknessMeters: 620,
    cloudDarkening: 0.08,
    humidity: 0.42,
    precipitation: 0,
    visibilityKm: 38,
    aerosolDensity: 0.08,
    stormIntensity: 0,
    transitionProgress: 1
  },
  cloudy: {
    windDirectionRad: Math.PI * 0.42,
    windSpeedMs: 13,
    swellDirectionRad: Math.PI * 0.38,
    swellStrength: 0.66,
    cloudCoverage: 0.68,
    cloudDensity: 0.58,
    cloudBaseMeters: 1100,
    cloudThicknessMeters: 1200,
    cloudDarkening: 0.38,
    humidity: 0.78,
    precipitation: 0.08,
    visibilityKm: 18,
    aerosolDensity: 0.22,
    stormIntensity: 0.28,
    transitionProgress: 1
  },
  rain: {
    windDirectionRad: Math.PI * 0.64,
    windSpeedMs: 21,
    swellDirectionRad: Math.PI * 0.58,
    swellStrength: 0.92,
    cloudCoverage: 0.94,
    cloudDensity: 0.88,
    cloudBaseMeters: 520,
    cloudThicknessMeters: 2100,
    cloudDarkening: 0.84,
    humidity: 0.96,
    precipitation: 0.86,
    visibilityKm: 5.5,
    aerosolDensity: 0.55,
    stormIntensity: 0.9,
    transitionProgress: 1
  }
};

/** Default Beaufort sea state suggested by each weather preset. */
export const WEATHER_DEFAULT_BEAUFORT: Record<WeatherPresetName, number> = {
  clear: 3.5,
  cloudy: 5.5,
  rain: 8
};

export function cloneWeather(state: WeatherState): WeatherState {
  return { ...state };
}

export function lerpWeather(
  from: WeatherState,
  to: WeatherState,
  t: number
): WeatherState {
  const k = Math.max(0, Math.min(1, t));

  return {
    windDirectionRad: lerpAngle(from.windDirectionRad, to.windDirectionRad, k),
    windSpeedMs: lerp(from.windSpeedMs, to.windSpeedMs, k),
    swellDirectionRad: lerpAngle(from.swellDirectionRad, to.swellDirectionRad, k),
    swellStrength: lerp(from.swellStrength, to.swellStrength, k),
    cloudCoverage: lerp(from.cloudCoverage, to.cloudCoverage, k),
    cloudDensity: lerp(from.cloudDensity, to.cloudDensity, k),
    cloudBaseMeters: lerp(from.cloudBaseMeters, to.cloudBaseMeters, k),
    cloudThicknessMeters: lerp(from.cloudThicknessMeters, to.cloudThicknessMeters, k),
    cloudDarkening: lerp(from.cloudDarkening, to.cloudDarkening, k),
    humidity: lerp(from.humidity, to.humidity, k),
    precipitation: lerp(from.precipitation, to.precipitation, k),
    visibilityKm: lerp(from.visibilityKm, to.visibilityKm, k),
    aerosolDensity: lerp(from.aerosolDensity, to.aerosolDensity, k),
    stormIntensity: lerp(from.stormIntensity, to.stormIntensity, k),
    transitionProgress: k
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}
