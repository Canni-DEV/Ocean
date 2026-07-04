# Ocean Technical Prototype Notes

This prototype is intentionally WebGPU-only. It should fail with a clear message on browsers without `navigator.gpu`.

## Controls

- Click the canvas to enter pointer lock.
- `WASD`: horizontal movement.
- `Space`: move up.
- `C`: move down.
- `Shift`: speed boost.
- `Esc`: release pointer lock.

## Implemented

- Vite + TypeScript + Svelte + Tailwind scaffold.
- Three.js `WebGPURenderer` boot path.
- Camera-only debug exploration.
- Weather presets: clear, cloudy, rain.
- Procedural atmospheric gradient, deterministic stars, fog, rain particles, visible sun and moon discs.
- Shared environment state for sky colors, fog, ambient light, sun/moon light, cloud shadow and water color.
- Real-time ocean renderer with projected grid, multi-component directional waves, derived normals, Fresnel-style reflection, absorption color, roughness and foam debug modes.
- Layered volumetric cloud approximation with a procedural cloud shell and lower cloud strata driven by unified weather state.
- Legacy WebGPU compute ocean cascade remains available as a technical reference/debug path, but it is not required for normal rendering.
- HUD metrics and debug render modes.

## Deliberately Deferred

- WebGL2 fallback.
- Boat, buoyancy and gameplay controls.
- Island or chunk generation.
- Bruneton atmospheric LUTs.
- TAA, SSR, bloom and auto exposure implementation.
- Multi-cascade ocean.

The normal ocean path no longer depends on CPU readback from WebGPU. The current cloud renderer is a pragmatic volumetric approximation rather than a final half-resolution raymarch pass; it is structured as a separate `CloudSystem` so a render-target raymarch can replace it later.
