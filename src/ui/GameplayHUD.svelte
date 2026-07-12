<script lang="ts">
  import type { GameplayUiState } from "../gameplay/types";

  type Props = { state: GameplayUiState; hidden?: boolean };
  let { state, hidden = false }: Props = $props();

  const modeLabel = $derived(
    state.mode === "helm" ? "CONDUCCIÓN" : state.mode === "fishing" ? "PESCA" : null
  );
</script>

{#if !hidden && state.mode !== "debugFreeCamera"}
  <div class="pointer-events-none absolute inset-0 z-20 select-none" aria-live="polite">
    {#if state.pointerLocked}
      <div class:active={state.reticleActive} class="reticle" aria-hidden="true"></div>
    {/if}

    {#if modeLabel}
      <div class="mode-badge">{modeLabel}</div>
    {/if}

    <div class="interaction-copy">
      {#if state.targetLabel}<div class="target">{state.targetLabel}</div>{/if}
      {#if state.prompt}<div class="prompt">{state.prompt}</div>{/if}
      {#if state.detail}<div class="detail">{state.detail}</div>{/if}
      {#if state.status}<div class="status">{state.status}</div>{/if}
    </div>
  </div>
{/if}

<style>
  .reticle {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 5px;
    height: 5px;
    transform: translate(-50%, -50%);
    border: 1px solid rgb(226 232 240 / 0.85);
    border-radius: 50%;
    box-shadow: 0 0 6px rgb(0 0 0 / 0.8);
    transition: 100ms ease;
  }
  .reticle.active {
    width: 9px;
    height: 9px;
    border-color: #7dd3fc;
    box-shadow: 0 0 9px rgb(56 189 248 / 0.65);
  }
  .mode-badge {
    position: absolute;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    padding: 5px 10px;
    border: 1px solid rgb(125 211 252 / 0.3);
    border-radius: 3px;
    background: rgb(3 12 22 / 0.55);
    color: #bae6fd;
    font-size: 10px;
    letter-spacing: 0.18em;
    backdrop-filter: blur(5px);
  }
  .interaction-copy {
    position: absolute;
    left: 50%;
    bottom: 9%;
    min-width: 280px;
    transform: translateX(-50%);
    text-align: center;
    text-shadow: 0 2px 5px #000;
  }
  .target { color: #e2e8f0; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
  .prompt { margin-top: 5px; color: #f8fafc; font-size: 15px; font-weight: 650; }
  .detail { margin-top: 4px; color: #94a3b8; font-size: 11px; }
  .status { margin-top: 10px; color: #fbbf24; font-size: 12px; }
  @media (prefers-reduced-motion: reduce) { .reticle { transition: none; } }
</style>
