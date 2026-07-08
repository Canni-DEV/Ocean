<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { get } from "svelte/store";
  import { EngineApp } from "./engine/EngineApp";
  import type { DebugSettings } from "./engine/types";
  import { debugSettings, engineMetrics } from "./state/debugStore";
  import DebugPanel from "./ui/DebugPanel.svelte";

  let canvas: HTMLCanvasElement;
  let engine: EngineApp | null = null;

  onMount(() => {
    engine = new EngineApp({
      canvas,
      initialSettings: get(debugSettings),
      onMetrics: (metrics) => engineMetrics.set(metrics)
    });

    const unsubscribe = debugSettings.subscribe((settings) => {
      engine?.applySettings(settings);
    });

    engine.start();

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribe();
      engine?.dispose();
      engine = null;
    };
  });

  function onKeyDown(event: KeyboardEvent) {
    if (event.repeat || event.code !== "KeyO") return;
    debugSettings.update((settings) => ({ ...settings, boatLightsOn: !settings.boatLightsOn }));
  }

  onDestroy(() => {
    engine?.dispose();
  });

  function updateSettings(next: DebugSettings) {
    debugSettings.set(next);
  }

  function resetBoat() {
    engine?.resetBoat();
  }
</script>

<main class="relative h-full w-full overflow-hidden bg-black">
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>

  <div class="pointer-events-none absolute left-3 top-3 z-10">
    <DebugPanel settings={$debugSettings} metrics={$engineMetrics} onChange={updateSettings} onResetBoat={resetBoat} />
  </div>
</main>
