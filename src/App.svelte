<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { get } from "svelte/store";
  import { EngineApp } from "./engine/EngineApp";
  import type { DebugSettings } from "./engine/types";
  import { debugSettings, engineMetrics } from "./state/debugStore";
  import DebugPanel from "./ui/DebugPanel.svelte";
  import GameplayHUD from "./ui/GameplayHUD.svelte";
  import { DEFAULT_GAMEPLAY_UI, type GameplayUiState } from "./gameplay/types";

  let canvas: HTMLCanvasElement;
  let debugPanel: HTMLDivElement;
  let debugPanelToggle: HTMLButtonElement;
  let engine: EngineApp | null = null;
  let debugPanelVisible = $state(false);
  let gameplayUi = $state<GameplayUiState>({ ...DEFAULT_GAMEPLAY_UI });

  onMount(() => {
    engine = new EngineApp({
      canvas,
      initialSettings: get(debugSettings),
      onMetrics: (metrics) => engineMetrics.set(metrics),
      onGameplayUi: (state) => (gameplayUi = state)
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
    if (event.repeat) return;

    if (event.code === "Backquote") {
      event.preventDefault();
      toggleDebugPanel();
      return;
    }

  }

  function toggleDebugPanel() {
    const focusWasInsidePanel = debugPanel?.contains(document.activeElement);
    debugPanelVisible = !debugPanelVisible;

    if (!debugPanelVisible && focusWasInsidePanel) {
      debugPanelToggle.focus();
    }
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

  function refuelBoat() {
    engine?.refuelBoat();
  }

  function rechargeFlashlight() {
    engine?.rechargeFlashlight();
  }
</script>

<main class="relative h-full w-full overflow-hidden bg-black">
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>
  <GameplayHUD state={gameplayUi} hidden={debugPanelVisible} />

  <div class="pointer-events-none absolute left-3 top-3 z-10 flex flex-col items-start gap-2">
    <button
      bind:this={debugPanelToggle}
      type="button"
      class="pointer-events-auto flex min-h-8 items-center gap-2 rounded border border-white/15 bg-slate-950/82 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-100 shadow-lg backdrop-blur hover:bg-slate-900/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      aria-controls="debug-panel"
      aria-expanded={debugPanelVisible}
      aria-label={debugPanelVisible ? "Ocultar menú de debug" : "Mostrar menú de debug"}
      title={`${debugPanelVisible ? "Ocultar" : "Mostrar"} menú de debug (Backquote)`}
      onclick={toggleDebugPanel}
    >
      <span>Debug</span>
      <span aria-hidden="true">{debugPanelVisible ? "▾" : "▸"}</span>
    </button>

    <div
      bind:this={debugPanel}
      id="debug-panel"
      class:debug-panel-hidden={!debugPanelVisible}
      class="debug-panel-shell"
      aria-hidden={!debugPanelVisible}
      inert={!debugPanelVisible}
    >
      <DebugPanel settings={$debugSettings} metrics={$engineMetrics} onChange={updateSettings} onResetBoat={resetBoat} onRefuel={refuelBoat} onRechargeFlashlight={rechargeFlashlight} />
    </div>
  </div>
</main>

<style>
  .debug-panel-shell {
    visibility: visible;
    opacity: 1;
    transform: translateX(0);
    transition:
      transform 180ms ease-out,
      opacity 140ms ease-out,
      visibility 0s linear;
  }

  .debug-panel-shell.debug-panel-hidden {
    visibility: hidden;
    pointer-events: none;
    opacity: 0;
    transform: translateX(calc(-100% - 12px));
    transition:
      transform 180ms ease-in,
      opacity 140ms ease-in,
      visibility 0s linear 180ms;
  }

  @media (prefers-reduced-motion: reduce) {
    .debug-panel-shell,
    .debug-panel-shell.debug-panel-hidden {
      transition: none;
    }
  }
</style>
