<script lang="ts">
  import type {
    AtmosphereDebugMode,
    DebugRenderMode,
    DebugSettings,
    EngineMetrics,
    FishingRopeRenderMode,
    QualityTier,
    WeatherPresetName
  } from "../engine/types";
  import { beaufortToWindSpeed, windSpeedToBeaufort } from "../state/seaState";
  import { ATLANTIC_DEEP, OCEAN_OPTICS_OVERRIDE_LIMITS } from "../ocean/OceanOpticsProfile";

  type Props = {
    settings: DebugSettings;
    metrics: EngineMetrics;
    onChange: (settings: DebugSettings) => void;
    onResetBoat: () => void;
    onRefuel: () => void;
    onRechargeFlashlight: () => void;
  };

  let { settings, metrics, onChange, onResetBoat, onRefuel, onRechargeFlashlight }: Props = $props();
  let showAdvanced = $state(false);
  let opticsCopied = $state(false);

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
    { value: "boatInteraction", label: "Boat Wake" },
    { value: "jacobian", label: "Jacobian" },
    { value: "slope", label: "Slope" },
    { value: "rawSlope", label: "Raw Slope" },
    { value: "filteredSlope", label: "Filtered Slope" },
    { value: "slopeMip", label: "Slope Moment Mip" },
    { value: "slopeVariance", label: "Slope Variance" },
    { value: "anisotropy", label: "Anisotropy" },
    { value: "roughness", label: "Final Roughness" },
    { value: "jacobianTerms", label: "Jacobian Terms" },
    { value: "geometryLodWeight", label: "Geometry LOD" },
    { value: "normalLodWeight", label: "Normal LOD" },
    { value: "unresolvedEnergy", label: "Unresolved Energy" },
    { value: "cascades", label: "Cascades" },
    { value: "fresnel", label: "Fresnel" },
    { value: "opticalDepth", label: "Optical Path" },
    { value: "waterVolume", label: "Water Volume" },
    { value: "localSpecular", label: "Local Specular" },
    { value: "localVolume", label: "Local Volume" },
    { value: "localLightRoles", label: "Local Light Roles" },
    { value: "sunGlitter", label: "Sun Glitter" },
    { value: "moonGlitter", label: "Moon Glitter" },
    { value: "ambientVolume", label: "Ambient Volume" },
    { value: "foamLighting", label: "Foam Lighting" },
    { value: "luminanceHeatmap", label: "Luminance Heatmap" },
    { value: "clippingMask", label: "Clipping Mask" }
  ];

  const atmosphereDebugModes: Array<{ value: AtmosphereDebugMode; label: string }> = [
    { value: "off", label: "Off" },
    { value: "weatherCoverage", label: "Weather Coverage" },
    { value: "weatherType", label: "Weather Type" },
    { value: "precipitation", label: "Precipitation" },
    { value: "erosion", label: "Erosion" },
    { value: "densitySlice", label: "Density Slice" },
    { value: "historyWeight", label: "History Weight" },
    { value: "seamGrid", label: "Seam Grid" },
    { value: "sceneDepth", label: "Scene Depth" },
    { value: "cloudRayEnd", label: "Cloud Ray End" },
    { value: "cloudFirstHit", label: "Cloud First Hit" },
    { value: "cloudOcclusionMask", label: "Cloud Occlusion" }
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
    patch({ weatherPreset: preset });
  }

  function resetOceanOptics() {
    patch({
      oceanLocalScatterGain: ATLANTIC_DEEP.localScatterGain,
      oceanPhaseG: ATLANTIC_DEEP.localPhaseG,
      oceanNightUpwellingGain: ATLANTIC_DEEP.upwellingNight,
      oceanSunGlitterGain: ATLANTIC_DEEP.sunGlitterGain,
      oceanMoonGlitterGain: ATLANTIC_DEEP.moonGlitterGain,
      oceanLocalOpticalPathM: ATLANTIC_DEEP.localOpticalPathM,
      oceanAnisotropyEnabled: true,
      oceanSlopeMipOverride: -1
    });
  }

  async function copyOceanOptics() {
    const payload = {
      profile: ATLANTIC_DEEP.id,
      localScatterGain: settings.oceanLocalScatterGain,
      phaseG: settings.oceanPhaseG,
      nightUpwellingGain: settings.oceanNightUpwellingGain,
      sunGlitterGain: settings.oceanSunGlitterGain,
      moonGlitterGain: settings.oceanMoonGlitterGain,
      localOpticalPathM: settings.oceanLocalOpticalPathM,
      anisotropyEnabled: settings.oceanAnisotropyEnabled,
      slopeMipOverride: settings.oceanSlopeMipOverride
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    opticsCopied = true;
    window.setTimeout(() => { opticsCopied = false; }, 1400);
  }

  const fallbackWindSpeed = $derived(beaufortToWindSpeed(settings.beaufort));
  const effectiveWindSpeed = $derived(metrics.seaState?.windSpeedMs ?? fallbackWindSpeed);
  const effectiveBeaufort = $derived(windSpeedToBeaufort(effectiveWindSpeed));
  const effectiveBeaufortLabel = $derived(
    beaufortLabels[Math.round(Math.min(12, Math.max(0, effectiveBeaufort)))]
  );

  const metricCards = $derived([
    { label: "FPS", value: metrics.fps.toFixed(0) },
    { label: "Frame", value: `${metrics.frameMs.toFixed(1)} ms` },
    { label: "CPU", value: `${metrics.cpuMs.toFixed(1)} ms` },
    { label: "GPU", value: metrics.gpuMs === null ? "n/a" : `${metrics.gpuMs.toFixed(1)} ms` },
    { label: "GPU Compute", value: metrics.gpuComputeMs === null ? "n/a" : `${metrics.gpuComputeMs.toFixed(1)} ms` },
    { label: "GPU Render", value: metrics.gpuRenderMs === null ? "n/a" : `${metrics.gpuRenderMs.toFixed(1)} ms` },
    {
      label: "Ocean Upd",
      value: metrics.oceanComputeMs === null ? "n/a" : `${metrics.oceanComputeMs.toFixed(1)} ms`
    },
    {
      label: "Slope Mips",
      value: metrics.slopeMomentComputeMs === null ? "n/a" : `${metrics.slopeMomentComputeMs.toFixed(2)} ms`
    },
    {
      label: "Boat Wake",
      value: metrics.boatInteractionComputeMs === null ? "n/a" : `${metrics.boatInteractionComputeMs.toFixed(1)} ms`
    },
    {
      label: "Clouds Upd",
      value: metrics.cloudComputeMs === null ? "n/a" : `${metrics.cloudComputeMs.toFixed(1)} ms`
    },
    {
      label: "Depth Pre",
      value: metrics.depthPrepassMs === null ? "n/a" : `${metrics.depthPrepassMs.toFixed(1)} ms`
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

  const boatCards = $derived(
    metrics.boat === null
      ? [{ label: "Boat", value: "n/a" }]
      : [
          { label: "Boat Speed", value: `${metrics.boat.speedMs.toFixed(1)} m/s` },
          { label: "Throttle", value: metrics.boat.throttle.toFixed(2) },
          { label: "Rudder", value: metrics.boat.rudder.toFixed(2) },
          { label: "Heading", value: `${metrics.boat.headingDeg.toFixed(0)} deg` },
          { label: "Pitch", value: `${metrics.boat.pitchDeg.toFixed(1)} deg` },
          { label: "Roll", value: `${metrics.boat.rollDeg.toFixed(1)} deg` },
          { label: "Capsized", value: metrics.boat.capsized ? "yes" : "no" },
          {
            label: "Boat Water",
            value: metrics.boat.waterHeightM === null ? "n/a" : `${metrics.boat.waterHeightM.toFixed(2)} m`
          },
          {
            label: "Boat XZ",
            value: `${metrics.boat.position.x.toFixed(1)}, ${metrics.boat.position.z.toFixed(1)}`
          },
          { label: "Boat Y", value: metrics.boat.position.y.toFixed(2) }
        ]
  );

  const firstPersonCards = $derived(
    metrics.firstPerson === null
      ? [{ label: "FPS", value: "off" }]
      : [
          {
            label: "Local XZ",
            value: `${metrics.firstPerson.localX.toFixed(2)}, ${metrics.firstPerson.localZ.toFixed(2)}`
          },
          { label: "Local Y", value: metrics.firstPerson.localY.toFixed(2) },
          { label: "Yaw", value: `${metrics.firstPerson.yawDeg.toFixed(0)} deg` },
          { label: "Pitch", value: `${metrics.firstPerson.pitchDeg.toFixed(0)} deg` },
          { label: "On Ground", value: metrics.firstPerson.onGround ? "yes" : "no" }
        ]
  );

  const systemCards = $derived(
    metrics.systems === null
      ? [{ label: "Systems", value: "n/a" }]
      : [
          { label: "Mode", value: metrics.gameplayMode },
          { label: "Engine", value: metrics.systems.engine },
          { label: "RPM", value: metrics.systems.instruments.rpm.toFixed(0) },
          { label: "Fuel", value: `${(metrics.systems.fuel * 100).toFixed(1)}%` },
          { label: "Bilge", value: `${(metrics.systems.bilgeLevel * 100).toFixed(1)}%` },
          { label: "Radio", value: metrics.systems.radio.powered ? `CH ${metrics.systems.radio.station}` : "off" },
          {
            label: "Flashlight",
            value: `${metrics.flashlight.powered ? "on" : metrics.flashlight.charging ? "charging" : "off"} ${(metrics.flashlight.charge01 * 100).toFixed(0)}%`
          }
        ]
  );

  const fishingCards = $derived(
    metrics.fishing === null
      ? [{ label: "Fishing", value: "off" }]
      : [
          {
            label: "Boom Angle",
            value: `${metrics.fishing.boomElevationDeg.toFixed(1)}° (${metrics.fishing.boomMinDeg.toFixed(0)}° .. ${metrics.fishing.boomMaxDeg.toFixed(0)}°)`
          },
          ...(settings.fishingRopeEnabled
            ? [
                { label: "Rope Length", value: `${metrics.fishing.paidOutLengthM.toFixed(1)} m` },
                { label: "Rope Tension", value: metrics.fishing.ropeTension.toFixed(3) }
              ]
            : [])
        ]
  );

  const ropeRenderModes: Array<{ value: FishingRopeRenderMode; label: string }> = [
    { value: "tube", label: "Tube" },
    { value: "line", label: "Line" }
  ];

  function toggleFirstPerson() {
    patch({ firstPerson: !settings.firstPerson });
  }

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

<aside class="pointer-events-auto max-h-[calc(100vh-64px)] w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto rounded border border-white/15 bg-slate-950/82 p-3 text-[12px] leading-tight text-slate-100 shadow-2xl backdrop-blur">
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
    <label class="mb-2 block">
      <span class="!text-sky-300">Fuente del mar</span>
      <select
        value={settings.seaStateControlMode}
        onchange={(event) => patch({ seaStateControlMode: value(event) as DebugSettings["seaStateControlMode"] })}
      >
        <option value="weather">Weather</option>
        <option value="manual-overrides">Overrides manuales</option>
      </select>
    </label>
    <label class="block">
      <span class="!text-sky-300">Estado del mar — Beaufort {effectiveBeaufort.toFixed(1)}</span>
      <input disabled={settings.seaStateControlMode === "weather"} min="0" max="12" step="0.1" type="range" value={settings.beaufort} oninput={(event) => patch({ beaufort: numberValue(event) })} />
    </label>
    <p class="mt-1 text-[11px] text-slate-400">
      {effectiveBeaufortLabel} · viento efectivo {effectiveWindSpeed.toFixed(1)} m/s
    </p>
    <p class="mt-0.5 text-[11px] text-slate-400">
      Dir viento {metrics.seaState?.windDirectionDeg.toFixed(0) ?? "n/a"}° ·
      swell {metrics.seaState?.swellDirectionDeg.toFixed(0) ?? "n/a"}° ·
      transición {((metrics.seaState?.weatherTransitionProgress ?? 0) * 100).toFixed(0)}%
    </p>
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
        <input min="0" max="1.2" step="0.01" type="range" value={settings.choppiness} oninput={(event) => patch({ choppiness: numberValue(event) })} />
      </label>
      <label>
        <span>Swell {settings.swellAmount.toFixed(2)}</span>
        <input disabled={settings.seaStateControlMode === "weather"} min="0" max="1" step="0.01" type="range" value={settings.swellAmount} oninput={(event) => patch({ swellAmount: numberValue(event) })} />
      </label>
      <label>
        <span>Swell Dir {settings.swellDirectionDeg.toFixed(0)}°</span>
        <input disabled={settings.seaStateControlMode === "weather"} min="0" max="360" step="1" type="range" value={settings.swellDirectionDeg} oninput={(event) => patch({ swellDirectionDeg: numberValue(event) })} />
      </label>
      <label>
        <span>Ocean Seed</span>
        <input min="0" max="2147483647" step="1" type="number" value={settings.oceanSeed} onchange={(event) => patch({ oceanSeed: numberValue(event) })} />
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
        <span>Boat Wake {settings.boatWakeIntensity.toFixed(2)}</span>
        <input min="0" max="2" step="0.01" type="range" value={settings.boatWakeIntensity} oninput={(event) => patch({ boatWakeIntensity: numberValue(event) })} />
      </label>
      <label>
        <span>Boat Foam {settings.boatWakeFoamIntensity.toFixed(2)}</span>
        <input min="0" max="2" step="0.01" type="range" value={settings.boatWakeFoamIntensity} oninput={(event) => patch({ boatWakeFoamIntensity: numberValue(event) })} />
      </label>
      <label>
        <span>Turbidez {settings.waterTurbidity.toFixed(2)}</span>
        <input min="0" max="1" step="0.01" type="range" value={settings.waterTurbidity} oninput={(event) => patch({ waterTurbidity: numberValue(event) })} />
      </label>
      <label>
        <span>Local Scatter {settings.oceanLocalScatterGain.toFixed(2)}</span>
        <input min={OCEAN_OPTICS_OVERRIDE_LIMITS.localScatterGain[0]} max={OCEAN_OPTICS_OVERRIDE_LIMITS.localScatterGain[1]} step="0.01" type="range" value={settings.oceanLocalScatterGain} oninput={(event) => patch({ oceanLocalScatterGain: numberValue(event) })} />
      </label>
      <label>
        <span>Phase g {settings.oceanPhaseG.toFixed(2)}</span>
        <input min={OCEAN_OPTICS_OVERRIDE_LIMITS.phaseG[0]} max={OCEAN_OPTICS_OVERRIDE_LIMITS.phaseG[1]} step="0.01" type="range" value={settings.oceanPhaseG} oninput={(event) => patch({ oceanPhaseG: numberValue(event) })} />
      </label>
      <label>
        <span>Night Upwelling {settings.oceanNightUpwellingGain.toFixed(2)}</span>
        <input min={OCEAN_OPTICS_OVERRIDE_LIMITS.nightUpwellingGain[0]} max={OCEAN_OPTICS_OVERRIDE_LIMITS.nightUpwellingGain[1]} step="0.01" type="range" value={settings.oceanNightUpwellingGain} oninput={(event) => patch({ oceanNightUpwellingGain: numberValue(event) })} />
      </label>
      <label>
        <span>Sun Glitter {settings.oceanSunGlitterGain.toFixed(2)}</span>
        <input min={OCEAN_OPTICS_OVERRIDE_LIMITS.sunGlitterGain[0]} max={OCEAN_OPTICS_OVERRIDE_LIMITS.sunGlitterGain[1]} step="0.01" type="range" value={settings.oceanSunGlitterGain} oninput={(event) => patch({ oceanSunGlitterGain: numberValue(event) })} />
      </label>
      <label>
        <span>Moon Glitter {settings.oceanMoonGlitterGain.toFixed(2)}</span>
        <input min={OCEAN_OPTICS_OVERRIDE_LIMITS.moonGlitterGain[0]} max={OCEAN_OPTICS_OVERRIDE_LIMITS.moonGlitterGain[1]} step="0.01" type="range" value={settings.oceanMoonGlitterGain} oninput={(event) => patch({ oceanMoonGlitterGain: numberValue(event) })} />
      </label>
      <label>
        <span>Local Path {settings.oceanLocalOpticalPathM.toFixed(1)} m</span>
        <input min={OCEAN_OPTICS_OVERRIDE_LIMITS.localOpticalPathM[0]} max={OCEAN_OPTICS_OVERRIDE_LIMITS.localOpticalPathM[1]} step="0.1" type="range" value={settings.oceanLocalOpticalPathM} oninput={(event) => patch({ oceanLocalOpticalPathM: numberValue(event) })} />
      </label>
      <label>
        <span>Anisotropy diagnostic</span>
        <input type="checkbox" checked={settings.oceanAnisotropyEnabled} onchange={(event) => patch({ oceanAnisotropyEnabled: (event.currentTarget as HTMLInputElement).checked })} />
      </label>
      <label>
        <span>Slope mip diagnostic</span>
        <select value={settings.oceanSlopeMipOverride} onchange={(event) => patch({ oceanSlopeMipOverride: numberValue(event) })}>
          <option value="-1">Auto</option>
          <option value="0">Mip 0</option>
          <option value="1">Mip 1</option>
          <option value="2">Mip 2</option>
          <option value="3">Mip 3</option>
          <option value="4">Mip 4</option>
        </select>
      </label>
      <div class="col-span-2 flex gap-2">
        <button class="flex-1 rounded border border-cyan-200/20 bg-cyan-200/10 px-2 py-1 text-[10px] uppercase text-cyan-100 hover:bg-cyan-200/20" type="button" onclick={resetOceanOptics}>Reset Atlantic</button>
        <button class="flex-1 rounded border border-cyan-200/20 bg-cyan-200/10 px-2 py-1 text-[10px] uppercase text-cyan-100 hover:bg-cyan-200/20" type="button" onclick={copyOceanOptics}>{opticsCopied ? "Copied" : "Copy JSON"}</button>
      </div>
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
      <label class="col-span-2">
        <span>Atmosphere Debug</span>
        <select value={settings.atmosphereDebugMode} onchange={(event) => patch({ atmosphereDebugMode: value(event) as AtmosphereDebugMode })}>
          {#each atmosphereDebugModes as option}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
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
      <span>Boat Wake</span>
      <input type="checkbox" checked={settings.boatWaterInteraction} onchange={(event) => patch({ boatWaterInteraction: checked(event) })} />
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

  <section class="mt-3 rounded border border-orange-300/25 bg-orange-950/20 p-2">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h2 class="text-[11px] font-semibold uppercase tracking-normal text-orange-200">Boat</h2>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <label class="!mb-0 flex min-h-6 items-center gap-1 rounded border border-orange-200/20 bg-orange-200/10 px-2 py-1">
          <span class="!mb-0 !text-[10px] !text-orange-100">Foco (debug)</span>
          <input type="checkbox" checked={settings.boatLightsOn} onchange={(event) => patch({ boatLightsOn: checked(event) })} />
        </label>
        <button
          class="rounded border px-2 py-1 text-[10px] uppercase hover:bg-orange-200/20 {settings.firstPerson
            ? 'border-orange-100 bg-orange-200/25 text-orange-50'
            : 'border-orange-200/20 bg-orange-200/10 text-orange-100'}"
          type="button"
          onclick={toggleFirstPerson}
        >
          Primera persona
        </button>
        <button
          class="rounded border border-orange-200/20 bg-orange-200/10 px-2 py-1 text-[10px] uppercase text-orange-100 hover:bg-orange-200/20"
          type="button"
          onclick={onResetBoat}
        >
          Reset
        </button>
        <button
          class="rounded border border-emerald-200/20 bg-emerald-200/10 px-2 py-1 text-[10px] uppercase text-emerald-100 hover:bg-emerald-200/20"
          type="button"
          onclick={onRefuel}
        >
          Repostar
        </button>
      </div>
    </div>
    <section class="grid grid-cols-2 gap-2">
      {#each boatCards as metric}
        <div class="rounded border border-white/10 bg-white/[0.045] p-2">
          <div class="text-[10px] uppercase text-slate-500">{metric.label}</div>
          <div class="mt-1 truncate font-mono text-[12px] text-slate-100">{metric.value}</div>
        </div>
      {/each}
    </section>
    <section class="mt-2 grid grid-cols-2 gap-2">
      {#each firstPersonCards as metric}
        <div class="rounded border border-white/10 bg-white/[0.045] p-2">
          <div class="text-[10px] uppercase text-slate-500">{metric.label}</div>
          <div class="mt-1 truncate font-mono text-[12px] text-slate-100">{metric.value}</div>
        </div>
      {/each}
    </section>
    <section class="mt-2 grid grid-cols-3 gap-2">
      {#each systemCards as metric}
        <div class="rounded border border-emerald-200/10 bg-emerald-950/15 p-2">
          <div class="text-[10px] uppercase text-emerald-300/55">{metric.label}</div>
          <div class="mt-1 truncate font-mono text-[11px] text-emerald-100">{metric.value}</div>
        </div>
      {/each}
    </section>
    <section class="mt-3 rounded border border-amber-300/20 bg-amber-950/20 p-2">
      <div class="mb-2 flex items-center justify-between gap-2">
        <h2 class="text-[11px] font-semibold uppercase tracking-normal text-amber-200">Player Flashlight</h2>
        <button
          class="rounded border border-amber-200/20 bg-amber-200/10 px-2 py-1 text-[10px] uppercase text-amber-100 hover:bg-amber-200/20"
          type="button"
          onclick={onRechargeFlashlight}
        >
          Cargar linterna
        </button>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label>
          <span>Autonomía {(settings.flashlightCapacitySeconds / 60).toFixed(0)} min</span>
          <input min="5" max="120" step="1" type="range" value={settings.flashlightCapacitySeconds / 60} oninput={(event) => patch({ flashlightCapacitySeconds: numberValue(event) * 60 })} />
        </label>
        <label>
          <span>Recarga {(settings.flashlightRechargeSeconds / 60).toFixed(0)} min</span>
          <input min="1" max="60" step="1" type="range" value={settings.flashlightRechargeSeconds / 60} oninput={(event) => patch({ flashlightRechargeSeconds: numberValue(event) * 60 })} />
        </label>
        <label>
          <span>Intensidad {settings.flashlightIntensityCd.toFixed(0)} cd</span>
          <input min="100" max="5000" step="25" type="range" value={settings.flashlightIntensityCd} oninput={(event) => patch({ flashlightIntensityCd: numberValue(event) })} />
        </label>
        <label>
          <span>Alcance {settings.flashlightRangeM.toFixed(0)} m</span>
          <input min="10" max="100" step="1" type="range" value={settings.flashlightRangeM} oninput={(event) => patch({ flashlightRangeM: numberValue(event) })} />
        </label>
        <label>
          <span>Semicono {settings.flashlightHalfAngleDeg.toFixed(0)}°</span>
          <input min="8" max="35" step="1" type="range" value={settings.flashlightHalfAngleDeg} oninput={(event) => patch({ flashlightHalfAngleDeg: numberValue(event) })} />
        </label>
        <label>
          <span>Suavidad {settings.flashlightPenumbra.toFixed(2)}</span>
          <input min="0" max="1" step="0.05" type="range" value={settings.flashlightPenumbra} oninput={(event) => patch({ flashlightPenumbra: numberValue(event) })} />
        </label>
        <label>
          <span>Batería baja {(settings.flashlightLowThreshold * 100).toFixed(0)}%</span>
          <input min={Math.round((settings.flashlightCriticalThreshold + 0.01) * 100)} max="95" step="1" type="range" value={settings.flashlightLowThreshold * 100} oninput={(event) => patch({ flashlightLowThreshold: numberValue(event) / 100 })} />
        </label>
        <label>
          <span>Batería crítica {(settings.flashlightCriticalThreshold * 100).toFixed(0)}%</span>
          <input min="1" max={Math.round((settings.flashlightLowThreshold - 0.01) * 100)} step="1" type="range" value={settings.flashlightCriticalThreshold * 100} oninput={(event) => patch({ flashlightCriticalThreshold: numberValue(event) / 100 })} />
        </label>
      </div>
    </section>
    <section class="mt-3 rounded border border-cyan-300/20 bg-cyan-950/20 p-2">
      <h2 class="mb-2 text-[11px] font-semibold uppercase tracking-normal text-cyan-200">Fishing Rope</h2>
      <div class="mb-2 grid grid-cols-2 gap-2">
        <label class="flex min-h-8 items-center justify-between gap-2 rounded border border-white/10 bg-white/[0.045] px-2 py-1">
          <span class="!mb-0 !text-[10px] !normal-case !text-slate-200">Enabled</span>
          <input type="checkbox" checked={settings.fishingRopeEnabled} onchange={(event) => patch({ fishingRopeEnabled: checked(event) })} />
        </label>
        <label class="col-span-2">
          <span>Render Mode</span>
          <select value={settings.fishingRopeRenderMode} onchange={(event) => patch({ fishingRopeRenderMode: value(event) as FishingRopeRenderMode })}>
            {#each ropeRenderModes as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Radius {settings.fishingRopeRadius.toFixed(3)} m</span>
          <input min="0.005" max="0.05" step="0.001" type="range" value={settings.fishingRopeRadius} oninput={(event) => patch({ fishingRopeRadius: numberValue(event) })} />
        </label>
        <label>
          <span>Reel Speed {settings.fishingReelSpeedMs.toFixed(2)} m/s</span>
          <input min="0.1" max="2" step="0.05" type="range" value={settings.fishingReelSpeedMs} oninput={(event) => patch({ fishingReelSpeedMs: numberValue(event) })} />
        </label>
        <label>
          <span>Min Length {settings.fishingRopeMinLengthM.toFixed(1)} m</span>
          <input
            min="1"
            max="20"
            step="0.5"
            type="range"
            value={settings.fishingRopeMinLengthM}
            oninput={(event) => {
              const minLengthM = numberValue(event);
              patch({
                fishingRopeMinLengthM: minLengthM,
                fishingRopeMaxLengthM: Math.max(minLengthM, settings.fishingRopeMaxLengthM),
                fishingRopeInitialLengthM: Math.min(
                  Math.max(minLengthM, settings.fishingRopeInitialLengthM),
                  Math.max(minLengthM, settings.fishingRopeMaxLengthM)
                )
              });
            }}
          />
        </label>
        <label>
          <span>Initial Length {settings.fishingRopeInitialLengthM.toFixed(1)} m</span>
          <input
            min={settings.fishingRopeMinLengthM}
            max={settings.fishingRopeMaxLengthM}
            step="0.5"
            type="range"
            value={settings.fishingRopeInitialLengthM}
            oninput={(event) => patch({ fishingRopeInitialLengthM: numberValue(event) })}
          />
        </label>
        <label>
          <span>Max Length {settings.fishingRopeMaxLengthM.toFixed(0)} m</span>
          <input
            min={Math.max(2, settings.fishingRopeMinLengthM + 1)}
            max="100"
            step="1"
            type="range"
            value={settings.fishingRopeMaxLengthM}
            oninput={(event) => {
              const maxLengthM = numberValue(event);
              patch({
                fishingRopeMaxLengthM: maxLengthM,
                fishingRopeInitialLengthM: Math.min(settings.fishingRopeInitialLengthM, maxLengthM)
              });
            }}
          />
        </label>
      </div>
      <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-normal text-cyan-300/80">Boom Elevation (W/S en puesto)</h3>
      <div class="mb-2 grid grid-cols-2 gap-2">
        <label>
          <span>Min Angle {settings.fishingBoomMinDeg.toFixed(0)}°</span>
          <input
            min="-45"
            max="45"
            step="1"
            type="range"
            value={settings.fishingBoomMinDeg}
            oninput={(event) => {
              const minDeg = numberValue(event);
              patch({
                fishingBoomMinDeg: minDeg,
                fishingBoomMaxDeg: Math.max(minDeg, settings.fishingBoomMaxDeg),
                fishingBoomDefaultDeg: Math.min(
                  Math.max(minDeg, settings.fishingBoomDefaultDeg),
                  Math.max(minDeg, settings.fishingBoomMaxDeg)
                )
              });
            }}
          />
        </label>
        <label>
          <span>Max Angle {settings.fishingBoomMaxDeg.toFixed(0)}°</span>
          <input
            min={settings.fishingBoomMinDeg}
            max="60"
            step="1"
            type="range"
            value={settings.fishingBoomMaxDeg}
            oninput={(event) => {
              const maxDeg = numberValue(event);
              patch({
                fishingBoomMaxDeg: maxDeg,
                fishingBoomDefaultDeg: Math.min(settings.fishingBoomDefaultDeg, maxDeg)
              });
            }}
          />
        </label>
        <label class="col-span-2">
          <span>Default Angle {settings.fishingBoomDefaultDeg.toFixed(0)}°</span>
          <input
            min={settings.fishingBoomMinDeg}
            max={settings.fishingBoomMaxDeg}
            step="1"
            type="range"
            value={settings.fishingBoomDefaultDeg}
            oninput={(event) => patch({ fishingBoomDefaultDeg: numberValue(event) })}
          />
        </label>
      </div>
      <section class="grid grid-cols-2 gap-2">
        {#each fishingCards as metric}
          <div class="rounded border border-white/10 bg-white/[0.045] p-2">
            <div class="text-[10px] uppercase text-slate-500">{metric.label}</div>
            <div class="mt-1 truncate font-mono text-[12px] text-slate-100">{metric.value}</div>
          </div>
        {/each}
      </section>
    </section>
  </section>

  <p class="mt-3 text-[11px] leading-snug text-slate-400">
    Gameplay: WASD caminar. Acercate y mirá hacia un puesto, luego presioná E. F alterna la linterna. Volante: W/S acelerador, A/D timón. Pesca: W/S brazo, A/D cuerda. Click y rueda operan la cabina. Esc libera el mouse; E abandona el puesto.
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
