# PR6C candidate

Capturas reproducibles de la implementación candidata de PR6C. Se generan con:

```text
npm run capture:ocean-pr6c
```

La matriz fija seed, simulación, cámara, clima, espuma, resolución y DPR, e incluye
SSR A/B, waterline/contacto A/B, noche y horizonte a 2/50/150/300 m. Los JSON
adyacentes registran navegador, resolución, estado del harness y métricas de imagen.

Estado de gates:

- Typecheck, Vitest y smoke WebGPU: automatizados.
- High/Medium/Low y modos debug: cubiertos por `tests/visual/ocean-pr6c.spec.ts`.
- Los tiempos por pass (`oceanSceneCaptureMs`, `oceanSurfaceDataMs`, `oceanSsrMs`)
  miden envío CPU. No se presentan como timestamps GPU.
- Pendientes antes del cierre: p95 real a 2560×1440, soak de 30 minutos y aprobación
  visual humana de las capturas.
