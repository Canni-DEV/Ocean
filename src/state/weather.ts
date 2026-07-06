import type { WeatherPresetName, WeatherState } from "../engine/types";

export const WEATHER_PRESETS: Record<WeatherPresetName, WeatherState> = {
  clear: {
    windDirectionRad: Math.PI * 0.12,
    windSpeedMs: 7,
    swellDirectionRad: Math.PI * 0.1,
    swellStrength: 0.38,
    cloudCoverage: 0.16,
    cloudDensity: 0.3,
    cloudBaseMeters: 1900,
    cloudThicknessMeters: 900,
    cloudDarkening: 0.08,
    convectivity: 0.22,
    cirrusAmount: 0.3,
    lightningRate: 0,
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
    cloudCoverage: 0.58,
    cloudDensity: 0.58,
    cloudBaseMeters: 1150,
    cloudThicknessMeters: 1600,
    cloudDarkening: 0.38,
    convectivity: 0.42,
    cirrusAmount: 0.5,
    lightningRate: 0,
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
    cloudCoverage: 0.78,
    cloudDensity: 0.84,
    cloudBaseMeters: 620,
    cloudThicknessMeters: 2600,
    cloudDarkening: 0.72,
    convectivity: 0.68,
    cirrusAmount: 0.2,
    lightningRate: 0,
    humidity: 0.96,
    precipitation: 0.75,
    visibilityKm: 7,
    aerosolDensity: 0.55,
    stormIntensity: 0.7,
    transitionProgress: 1
  },
  storm: {
    windDirectionRad: Math.PI * 0.78,
    windSpeedMs: 28,
    swellDirectionRad: Math.PI * 0.72,
    swellStrength: 1,
    cloudCoverage: 0.88,
    cloudDensity: 0.98,
    cloudBaseMeters: 450,
    cloudThicknessMeters: 6200,
    cloudDarkening: 0.9,
    convectivity: 1,
    cirrusAmount: 0.08,
    lightningRate: 14,
    humidity: 0.99,
    precipitation: 1,
    visibilityKm: 3.5,
    aerosolDensity: 0.68,
    stormIntensity: 1,
    transitionProgress: 1
  }
};

/** Default Beaufort sea state suggested by each weather preset. */
export const WEATHER_DEFAULT_BEAUFORT: Record<WeatherPresetName, number> = {
  clear: 3.5,
  cloudy: 5.5,
  rain: 8,
  storm: 9.5
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
    convectivity: lerp(from.convectivity, to.convectivity, k),
    cirrusAmount: lerp(from.cirrusAmount, to.cirrusAmount, k),
    lightningRate: lerp(from.lightningRate, to.lightningRate, k),
    humidity: lerp(from.humidity, to.humidity, k),
    precipitation: lerp(from.precipitation, to.precipitation, k),
    visibilityKm: lerp(from.visibilityKm, to.visibilityKm, k),
    aerosolDensity: lerp(from.aerosolDensity, to.aerosolDensity, k),
    stormIntensity: lerp(from.stormIntensity, to.stormIntensity, k),
    transitionProgress: k
  };
}

/** Smoothstep easing for weather transitions so changes ramp in and out gently. */
export function easeWeatherProgress(linearProgress: number): number {
  const t = Math.max(0, Math.min(1, linearProgress));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}
