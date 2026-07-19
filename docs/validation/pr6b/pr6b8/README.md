# PR6B.8 — coherencia de tormenta y gate nocturno

Validación local WebGPU realizada con seed `1337`, simulación congelada en
`120 s` y cámara fija. Las capturas documentan el A/B y las métricas se calculan
sobre ROI lineales a partir de la salida SDR.

## Cambios validados

- Se eliminaron las dos perturbaciones de normal `Rain ripples`.
- La precipitación superficial sólo añade hasta `0.002` de varianza estadística
  de pendiente; no existe doble conteo normal + roughness.
- El grano fino de espuma conserva coordenadas de mundo pero queda congelado.
- `storm-surface-off/on` conserva seed, cámara, mar, tiempo y FFT. `foam=0/1`
  completa el A/B de cuatro estados.
- El HUD informa viento efectivo, dirección de viento, dirección de swell y
  progreso real de transición.
- La luna aporta irradiancia indirecta de cielo a la radiancia ascendente sin
  alterar exposición ni añadir un color constante autoiluminado.
- Foco, linterna, cabina, navegación, fondeo y relámpago participan mediante
  las luces reales compartidas con el resto de la escena.

## Métricas del gate

| Gate | Off | On | Resultado |
|---|---:|---:|---|
| Foco, mediana ROI | `0.01226` | `0.05918` | `4.83×`, sin clipping |
| Linterna, mediana ROI | `0.01927` | `0.08255` | `4.28×`, sin clipping |
| Fuera del cono del foco | `0.01557` | `0.01557` | variación despreciable |
| Luna, mediana ROI agua | — | `0.01949` | dentro de `0.015–0.08` |
| Luna, negro digital | — | `0%` | menor de `5%` |

El smoke de cabina, navegación, fondeo, relámpago, Medium y Low terminó sin
errores WebGPU. El máximo clipping observado fue `0.177%` en la escena de cabina,
por debajo del límite de `0.5%`.

## Evidencia

- `storm-surface-off-foam-off.jpg`
- `storm-surface-on-foam-off.jpg`
- `storm-surface-off-foam-on.jpg`
- `storm-surface-on-foam-on.jpg`
- `night-moon-gate-final.jpg`
- `work-off-final.jpg` / `work-on-gate.jpg`
- `flash-off-final.jpg` / `flash-on-gate.jpg`
- `storm-hud-effective-state.jpg`

La aprobación estética final queda a cargo del responsable visual; los gates
técnicos y cuantitativos sí quedan cerrados.
