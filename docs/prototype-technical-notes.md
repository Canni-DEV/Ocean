# Ocean Technical Prototype Notes

This prototype is intentionally WebGPU-only. It should fail with a clear message on browsers without `navigator.gpu`.

## Controls

- Click the canvas to enter pointer lock.
- `WASD`: horizontal movement.
- `Space`: move up.
- `C`: move down.
- `Shift`: speed boost.
- `Esc`: release pointer lock.

## Architecture

- Vite + TypeScript + Svelte + Tailwind scaffold, Three.js `WebGPURenderer` with TSL node materials and compute.
- **Spectral ocean simulation** (`src/ocean/simulation/`):
  - JONSWAP spectrum with Hasselmann directional spreading plus a separate narrow swell ridge, generated on GPU (`OceanSpectrum.ts`). Regenerated only when the sea state changes.
  - 2-3 band-limited cascades (patch sizes ~251/61/13 m) evolved per frame and inverted with a Stockham radix-2 inverse FFT in compute (`OceanFFT.ts`). Outputs per cascade: displacement XYZ + jacobian, and jacobian-corrected slopes + accumulated foam.
  - Quality tiers (`OceanSimulation.ts`): FFT 128/256/512, cascade count, mesh density and environment cubemap size/update rate.
- **Ocean surface** (`OceanRenderer.ts`): camera-centered radial grid with exponential ring spacing (dense near the camera, reaches the horizon). PBR water via `MeshPhysicalNodeMaterial` (IOR 1.333): environment-map reflections from the dynamic sky cubemap, GGX sun specular, approximate subsurface scattering on crests, jacobian-driven foam with temporal accumulation, rain ripples and distance fading of high-frequency cascades converted into micro-roughness.
- **Atmosphere** (`AtmosphereSystem.ts`): physically based single-scattering sky (`SkyMesh`, Preetham model) driven by weather (turbidity, mie), captured into a throttled `CubeRenderTarget` used as `scene.environment` (PMREM) for water reflections and IBL. Sun/moon directional lights, stars, exponential fog, rain particles. ACES tone mapping.
- **Volumetric clouds** (`src/atmosphere/clouds/`): AAA-style raymarched cloud layer (Schneider/Nubis density + Frostbite energy integration + Wrenninge multi-scatter approximation). World-tiled 512² weather map (RepeatWrapping) with smooth wind advection via sample offset — no camera snapping. Half-resolution render with temporal accumulation, cirrus layer, horizon stratus fill, projected cloud shadow map on the ocean, storm lightning (procedural bolts + in-cloud flashes). Four weather presets with configurable 5–120 s eased transitions.
- **Sea state**: master Beaufort control (0-12) mapped to wind speed / JONSWAP parameters (`src/state/seaState.ts`); weather presets suggest a default Beaufort. Advanced panel exposes fetch, choppiness, swell, foam and turbidity.
- **Physics sampling** (`OceanPhysicsSampler.ts`): compute pass evaluates the exact displacement cascades on a 64x64 grid around the camera and reads it back asynchronously (1-2 frame latency, no stall). Public API: `getHeightAt(x, z)`, `getNormalAt(x, z)`, `isReady()`, with horizontal-displacement compensation. The HUD "Sea Level" metric is fed by it.

## Deliberately Deferred

- WebGL2 fallback.
- Boat, buoyancy and gameplay controls (the sampler API is ready for them).
- Island or chunk generation.
- Bruneton atmospheric LUTs.
- TAA, SSR, bloom and auto exposure.
