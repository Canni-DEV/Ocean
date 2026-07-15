# Ocean Technical Prototype Notes

This prototype is intentionally WebGPU-only. It should fail with a clear message on browsers without `navigator.gpu`.

## Controls

- `` ` `` (`Backquote`): show or hide the debug menu.
- Click the canvas to enter pointer lock; `Esc` releases it without leaving an occupied station.
- Walking: `WASD` moves the player around the boat and the mouse controls the view.
- Stand near and face the helm or fishing controls, then press `E` to occupy that station; press `E` again to leave it.
- `F` toggles the player's maritime flashlight. Its real-time battery recharges while off near the helm when the engine is running.
- Helm: `W/S` adjusts persistent throttle and `A/D` operates the self-centering rudder.
- Fishing: `W/S` raises/lowers the boom and `A/D` pays out/reels in the rope.
- Cabin controls use the center reticle: left click toggles switches, holding click sounds the horn, and the mouse wheel adjusts radio volume/tuning.
- The old `IJKL`, `YHUP`, and `O` gameplay shortcuts have been removed.

## Gameplay systems

- `GameplayInputRouter` is the sole owner of keyboard, mouse and pointer-lock events. It routes one frame snapshot to walking, helm, fishing, flashlight or debug-free-camera mode.
- Station entry uses dedicated proximity/orientation zones; cockpit buttons use a separate control-only raycast with subtle aim assistance and hull occlusion.
- The runtime cockpit rig adds non-colliding hit proxies, animated switches, six live instruments, navigation/anchor/cabin lights, wiper, wet glass and visible bilge water without modifying the source GLB.
- Motor state gates propulsion and consumes a four-hour normalized fuel tank. Electrical accessories remain independent.
- Radio tunes six free laut.fm streams through an `HTMLAudioElement` fed into the cabin Web Audio graph; power off pauses the active stream.

## Architecture

- Vite + TypeScript + Svelte + Tailwind scaffold, Three.js `WebGPURenderer` with TSL node materials and compute.
- **Spectral ocean simulation** (`src/ocean/simulation/`):
  - JONSWAP spectrum with Hasselmann directional spreading plus a separate narrow swell ridge, generated on GPU (`OceanSpectrum.ts`). Regenerated only when the sea state changes.
  - 2-3 band-limited cascades (patch sizes ~251/61/13 m) evolved per frame and inverted with a Stockham radix-2 inverse FFT in compute (`OceanFFT.ts`). Outputs per cascade: displacement XYZ + jacobian, and jacobian-corrected slopes + accumulated foam.
  - Quality tiers (`OceanSimulation.ts`): FFT 128/256/512, cascade count, mesh density and environment cubemap size/update rate.
- **Ocean surface** (`OceanRenderer.ts`): camera-centered radial grid with exponential ring spacing (dense near the camera, reaches the horizon). PBR water via `MeshPhysicalNodeMaterial` (IOR 1.333): environment-map reflections from the dynamic sky cubemap, GGX sun specular, approximate subsurface scattering on crests, jacobian-driven foam with temporal accumulation, rain ripples and distance fading of high-frequency cascades converted into micro-roughness. The same FFT displacement node drives a depth-only material used by the cloud prepass, so displaced crests occlude distant volumetrics without evaluating the water PBR shader twice. Direct sun SSS and cubemap IBL are gated by celestial elevation masks so no ghost specular column appears when the sun is below the horizon.
- **Atmosphere** (`AtmosphereSystem.ts`): physically based single-scattering sky (`SkyMesh`, Preetham model) driven by weather (turbidity, mie), captured into a throttled `CubeRenderTarget` used as `scene.environment` (PMREM) for water reflections and IBL. Sun/moon directional lights, stars, exponential fog, rain particles. ACES tone mapping. Celestial elevation masks (`celestialMask.ts`) fade direct sun/moon light, discs and cloud key lighting between +2° and −4° below the horizon (MSFS-style twilight).
- **Volumetric clouds** (`src/atmosphere/clouds/`): AAA-style raymarched cloud layer (Schneider/Nubis density + Frostbite energy integration + Wrenninge multi-scatter approximation). World-tiled 512² weather map (RepeatWrapping) with smooth wind advection via sample offset — no camera snapping. Half-resolution render with temporal accumulation, followed by a full-resolution scene-depth composite so moving meshes and FFT-displaced waves occlude clouds without entering the temporal history. Includes cirrus, horizon stratus fill, projected cloud shadows on the ocean and storm lightning (procedural bolts + in-cloud flashes). Four weather presets with configurable 5–120 s eased transitions.
- **Sea state**: master Beaufort control (0-12) mapped to wind speed / JONSWAP parameters (`src/state/seaState.ts`); weather presets suggest a default Beaufort. Advanced panel exposes fetch, choppiness, swell, foam and turbidity.
- **Physics sampling** (`OceanPhysicsSampler.ts`): compute pass evaluates the exact displacement cascades on a 64x64 grid around the camera and reads it back asynchronously (1-2 frame latency, no stall). Public API: `getHeightAt(x, z)`, `getNormalAt(x, z)`, `isReady()`, with horizontal-displacement compensation. The HUD "Sea Level" metric is fed by it.
- **Fishing rope** (`src/fishing/`): Verlet particle chain anchored at the bow pulley with a terminal weight, reel-controlled paid-out length (1-50 m, default 2 m), hull BVH collision, and ocean height sampling for submerged nodes (inherits the sampler's 1-2 frame latency). Visualized as a configurable thick tube or line mesh.

## Celestial elevation masks

`src/atmosphere/celestialMask.ts` exports shared helpers used by the atmosphere and ocean:

- `directLightMask(y)`: smooth 0→1 between −4° and +2° elevation; zero direct sun/moon contribution at night.
- `twilightFactor(y)`: residual twilight for subdued cubemap IBL on water after sunset.

`CelestialState` carries `sunDirectMask`, `moonDirectMask` and `twilightFactor` each frame.

## Visual validation checklist

| Scenario | Expected |
|---|---|
| Sunset (~18–20 h) | Sun specular on water fades smoothly as the disc crosses the horizon |
| Night (~22–4 h) | No solar specular column; moon only when above the horizon |
| Moon below horizon | No lunar direct reflection |

## Deliberately Deferred

- WebGL2 fallback.
- Island or chunk generation.
- Bruneton atmospheric LUTs.
- TAA, SSR, bloom and auto exposure.
