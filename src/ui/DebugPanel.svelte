<script lang="ts">
  import type { DebugRenderMode, DebugSettings, EngineMetrics, QualityTier, WeatherPresetName } from "../engine/types";
  import { WEATHER_DEFAULT_BEAUFORT } from "../state/weather";
  import { beaufortToWindSpeed } from "../state/seaState";

  type Props = {
    settings: DebugSettings;
    metrics: EngineMetrics;
    onChange: (settings: DebugSettings) => void;
  };

  let { settings, metrics, onChange }: Props = $props();
  let showAdvanced = $state(false);

  const weatherOptions: Array<{ value: WeatherPresetName; label: string }> = [
    { value: "clear", label: "Despejado" },
    { value: "cloudy", label: "Nuboso" },
    { value: "rain", label: "Lluvia" },
    { value: "storm", label: "Tormenta" }
  ];

  const qualityOptions: Array<{ value: QualityTier; label: string }> = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" }
  ];

  const debugModes: Array<{ value: DebugRenderMode; label: string }> = [
    { value: "final", label: "Final" },
    { value: "wireframe", label: "Wire" },
    { value: "height", label: "Height" },
    { value: "normal", label: "Normal" },
    { value: "foam", label: "Foam" },
    { value: "jacobian", label: "Jacobian" },
    { value: "slope", label: "Slope" },
    { value: "cascades", label: "Cascades" },
    { value: "fresnel", label: "Fresnel" }
  ];

  const beaufortLabels = [
    "Calma",
    "Ventolina",
    "Brisa muy débil",
    "Brisa débil",
    "Brisa moderada",
    "Brisa fresca",
    "Brisa fuerte",
    "Viento fuerte",
    "Temporal",
    "Temporal fuerte",
    "Temporal duro",
    "Temporal muy duro",
    "Huracán"
  ];

  function patch(next: Partial<DebugSettings>) {
    onChange({ ...settings, ...next });
  }

  function selectWeather(preset: WeatherPresetName) {
    patch({ weatherPreset: preset, beaufort: WEATHER_DEFAULT_BEAUFORT[preset] });
  }

  const beaufortLabel = $derived(beaufortLabels[Math.round(Math.min(12, Math.max(0, settings.beaufort)))]);
  const windSpeed = $derived(beaufortToWindSpeed(settings.beaufort));

  const metricCards = $derived([
    { label: "FPS", value: metrics.fps.toFixed(0) },
    { label: "Frame", value: `${metrics.frameMs.toFixed(1)} ms` },
    { label: "CPU", value: `${metrics.cpuMs.toFixed(1)} ms` },
    {
      label: "Ocean Upd",
      value: metrics.oceanComputeMs === null ? "n/a" : `${metrics.oceanComputeMs.toFixed(1)} ms`
    },
    {
      label: "Clouds Upd",
      value: metrics.cloudComputeMs === null ? "n/a" : `${metrics.cloudComputeMs.toFixed(1)} ms`
    },
    {
      label: "Sea Level",
      value: metrics.seaLevelAtCameraM === null ? "n/a" : `${metrics.seaLevelAtCameraM.toFixed(2)} m`
    },
    { label: "Backend", value: metrics.backend.toUpperCase() }
  ]);

  const cameraCards = $derived([
    { label: "World Time", value: `${metrics.worldTimeHours.toFixed(2)} h` },
    {
      label: "Origin",
      value: `${metrics.originOffsetMeters.x.toFixed(0)}, ${metrics.originOffsetMeters.z.toFixed(0)}`
    },
    { label: "Camera XZ", value: `${metrics.camera.x.toFixed(1)}, ${metrics.camera.z.toFixed(1)}` },
    { label: "Camera Y", value: metrics.camera.y.toFixed(1) },
    { label: "Yaw", value: `${metrics.camera.yawDeg.toFixed(0)} deg` },
    { label: "Pitch", value: `${metrics.camera.pitchDeg.toFixed(0)} deg` }
  ]);

  function checked(event: Event): boolean {
    return (event.currentTarget as HTMLInputElement).checked;
  }

  function value(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function numberValue(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement).value);
  }
</script>

<aside class="pointer-events-auto w-[360px] max-w-[calc(100vw-24px)] rounded border border-white/15 bg-slate-950/82 p-3 text-[12px] leading-tight text-slate-100 shadow-2xl backdrop-blur">
  <div class="mb-3 flex items-start justify-between gap-3">
    <div>
      <h1 class="text-sm font-semibold tracking-normal">Ocean Prototype</h1>
      <p class="mt-1 text-slate-400">FFT spectral ocean, WebGPU</p>
    </div>
    <span class:status-ok={metrics.status === "running"} class:status-error={metrics.status === "error"} class="rounded px-2 py-1 text-[11px] uppercase">
      {metrics.status}
    </span>
  </div>

  {#if metrics.error}
    <div class="mb-3 rounded border border-red-400/50 bg-red-950/70 p-2 text-red-100">
      {metrics.error}
    </div>
  {/if}

  <section class="grid grid-cols-3 gap-2">
    {#each metricCards as metric}
      <div class="rounded border border-white/10 bg-white/[0.045] p-2">
        <div class="text-[10px] uppercase text-slate-500">{metric.label}</div>
        <div class="mt-1 truncate font-mono text-[12px] text-slate-100">{metric.value}</div>
      </div>
    {/each}
  </section>

  <section class="mt-3 grid grid-cols-2 gap-2">
    <label>
      <span>Weather</span>
      <select value={settings.weatherPreset} onchange={(event) => selectWeather(value(event) as WeatherPresetName)}>
        {#each weatherOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Quality</span>
      <select value={settings.quality} onchange={(event) => patch({ quality: value(event) as QualityTier })}>
        {#each qualityOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Debug View</span>
      <select value={settings.renderMode} onchange={(event) => patch({ renderMode: value(event) as DebugRenderMode })}>
        {#each debugModes as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Time Scale</span>
      <input min="0" max="1200" step="10" type="range" value={settings.timeScale} oninput={(event) => patch({ timeScale: numberValue(event) })} />
    </label>
    <label class="col-span-2">
      <span>World Hour {settings.worldTimeHours.toFixed(2)}</span>
      <input min="0" max="24" step="0.05" type="range" value={settings.worldTimeHours} oninput={(event) => patch({ worldTimeHours: numberValue(event) })} />
    </label>
    <label class="col-span-2">
      <span>Transición clima {settings.weatherTransitionSeconds.toFixed(0)} s</span>
      <input min="5" max="120" step="1" type="range" value={settings.weatherTransitionSeconds} oninput={(event) => patch({ weatherTransitionSeconds: numberValue(event) })} />
    </label>
  </section>

  <section class="mt-3 rounded border border-sky-400/25 bg-sky-950/30 p-2">
    <label class="block">
      <span class="!text-sky-300">Estado del mar — Beaufort {settings.beaufort.toFixed(1)}</span>
      <input min="0" max="12" step="0.1" type="range" value={settings.beaufort} oninput={(event) => patch({ beaufort: numberValue(event) })} />
    </label>
    <p class="mt-1 text-[11px] text-slate-400">{beaufortLabel} · viento {windSpeed.toFixed(1)} m/s</p>
  </section>

  <button
    class="mt-3 w-full rounded border border-white/10 bg-white/[0.045] px-2 py-1.5 text-left text-[11px] uppercase tracking-wide text-slate-400 hover:bg-white/[0.08]"
    onclick={() => (showAdvanced = !showAdvanced)}
  >
    {showAdvanced ? "▾" : "▸"} Parámetros avanzados
  </button>

  {#if showAdvanced}
    <section class="mt-2 grid grid-cols-2 gap-2">
      <label>
        <span>Fetch {settings.fetchKm.toFixed(0)} km</span>
        <input min="20" max="1000" step="10" type="range" value={settings.fetchKm} oninput={(event) => patch({ fetchKm: numberValue(event) })} />
      </label>
      <label>
        <span>Choppiness {settings.choppiness.toFixed(2)}</span>
        <input min="0" max="2" step="0.01" type="range" value={settings.choppiness} oninput={(event) => patch({ choppiness: numberValue(event) })} />
      </label>
      <label>
        <span>Swell {settings.swellAmount.toFixed(2)}</span>
        <input min="0" max="1" step="0.01" type="range" value={settings.swellAmount} oninput={(event) => patch({ swellAmount: numberValue(event) })} />
      </label>
      <label>
        <span>Swell Dir {settings.swellDirectionDeg.toFixed(0)}°</span>
        <input min="0" max="360" step="1" type="range" value={settings.swellDirectionDeg} oninput={(event) => patch({ swellDirectionDeg: numberValue(event) })} />
      </label>
      <label>
        <span>Foam {settings.foamIntensity.toFixed(2)}</span>
        <input min="0" max="2" step="0.01" type="range" value={settings.foamIntensity} oninput={(event) => patch({ foamIntensity: numberValue(event) })} />
      </label>
      <label>
        <span>Foam Decay {settings.foamDecay.toFixed(2)}</span>
        <input min="0.02" max="0.6" step="0.01" type="range" value={settings.foamDecay} oninput={(event) => patch({ foamDecay: numberValue(event) })} />
      </label>
      <label>
        <span>Turbidez {settings.waterTurbidity.toFixed(2)}</span>
        <input min="0" max="1" step="0.01" type="range" value={settings.waterTurbidity} oninput={(event) => patch({ waterTurbidity: numberValue(event) })} />
      </label>
      <label>
        <span>Exposure {settings.exposureBias.toFixed(2)}</span>
        <input min="-0.45" max="0.45" step="0.01" type="range" value={settings.exposureBias} oninput={(event) => patch({ exposureBias: numberValue(event) })} />
      </label>
      <label>
        <span>Cloud Cover {settings.cloudCoverageBias.toFixed(2)}</span>
        <input min="-0.5" max="0.5" step="0.01" type="range" value={settings.cloudCoverageBias} oninput={(event) => patch({ cloudCoverageBias: numberValue(event) })} />
      </label>
      <label>
        <span>Cloud Density {settings.cloudDensityBias.toFixed(2)}</span>
        <input min="-0.5" max="0.5" step="0.01" type="range" value={settings.cloudDensityBias} oninput={(event) => patch({ cloudDensityBias: numberValue(event) })} />
      </label>
    </section>
  {/if}

  <section class="mt-3 grid grid-cols-2 gap-2">
    <label class="flex min-h-8 items-center justify-between gap-2 rounded border border-white/10 bg-white/[0.045] px-2 py-1">
      <span>Sky</span>
      <input type="checkbox" checked={settings.showSky} onchange={(event) => patch({ showSky: checked(event) })} />
    </label>
    <label class="flex min-h-8 items-center justify-between gap-2 rounded border border-white/10 bg-white/[0.045] px-2 py-1">
      <span>Ocean</span>
      <input type="checkbox" checked={settings.showOcean} onchange={(event) => patch({ showOcean: checked(event) })} />
    </label>
    <label class="flex min-h-8 items-center justify-between gap-2 rounded border border-white/10 bg-white/[0.045] px-2 py-1">
      <span>Displace</span>
      <input type="checkbox" checked={settings.oceanDisplacement} onchange={(event) => patch({ oceanDisplacement: checked(event) })} />
    </label>
    <label class="flex min-h-8 items-center justify-between gap-2 rounded border border-white/10 bg-white/[0.045] px-2 py-1">
      <span>Foam</span>
      <input type="checkbox" checked={settings.showFoam} onchange={(event) => patch({ showFoam: checked(event) })} />
    </label>
    <label class="flex min-h-8 items-center justify-between gap-2 rounded border border-white/10 bg-white/[0.045] px-2 py-1">
      <span>Rain</span>
      <input type="checkbox" checked={settings.showRain} onchange={(event) => patch({ showRain: checked(event) })} />
    </label>
    <label class="flex min-h-8 items-center justify-between gap-2 rounded border border-white/10 bg-white/[0.045] px-2 py-1">
      <span>Clouds</span>
      <input type="checkbox" checked={settings.showClouds} onchange={(event) => patch({ showClouds: checked(event) })} />
    </label>
    <label class="flex min-h-8 items-center justify-between gap-2 rounded border border-white/10 bg-white/[0.045] px-2 py-1">
      <span>Wireframe</span>
      <input type="checkbox" checked={settings.wireframe} onchange={(event) => patch({ wireframe: checked(event) })} />
    </label>
  </section>

  <section class="mt-3 grid grid-cols-2 gap-2">
    {#each cameraCards as metric}
      <div class="rounded border border-white/10 bg-white/[0.045] p-2">
        <div class="text-[10px] uppercase text-slate-500">{metric.label}</div>
        <div class="mt-1 truncate font-mono text-[12px] text-slate-100">{metric.value}</div>
      </div>
    {/each}
  </section>

  <p class="mt-3 text-[11px] leading-snug text-slate-400">
    Click canvas for pointer lock. WASD move, Space/C vertical, Shift boost, Esc releases.
  </p>
</aside>

<style>
  label span {
    display: block;
    margin-bottom: 4px;
    color: rgb(148 163 184);
    font-size: 10px;
    text-transform: uppercase;
  }

  select,
  input[type="range"] {
    width: 100%;
  }

  select {
    min-height: 30px;
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 4px;
    background: rgb(15 23 42 / 0.95);
    padding: 0 8px;
    color: rgb(226 232 240);
  }

  input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: #38bdf8;
  }

  .status-ok {
    background: rgb(6 78 59 / 0.7);
    color: rgb(167 243 208);
  }

  .status-error {
    background: rgb(127 29 29 / 0.7);
    color: rgb(254 202 202);
  }
</style>
