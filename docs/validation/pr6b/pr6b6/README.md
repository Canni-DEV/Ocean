# PR6B.7 — estabilización de reflejos

Validación reproducible del artefacto rectangular observado bajo reflexión solar directa.

## Diagnóstico

La orientación anisotrópica se obtenía por texel a partir del autovector de la covarianza local de pendientes. Aunque los momentos eran correctos para filtrar roughness, pequeñas variaciones e interpolaciones entre texels rotaban el lóbulo GGX en bloques visibles. El artefacto persistía forzando el mip cero y desaparecía al desactivar anisotropía, confirmando la causa.

La corrección conserva la varianza espacial para roughness, pero orienta una anisotropía sutil con el marco Cox–Munk estable del viento. No se modificaron FFT, desplazamiento, fases, choppiness, física ni espuma.

## Escenarios y evidencia

- `01-local-covariance-blocks.jpg`: referencia previa con bloques rectangulares.
- `09-final-sun-column.jpg`: escenario `pr6b-sun-column`, espuma off, anisotropía estable.
- `10-final-lateral.jpg`: escenario `pr6b-sun-lateral`, reflexión lateral.
- `11-final-clipping-mask.jpg`: máscara de clipping para la columna solar.
- `12-final-low-sun-bow.jpg`: sol bajo desde proa.
- `06-direct-sun-column-foam.jpg`: columna solar con espuma activada.

Parámetros comunes: seed `1337`, simulación congelada en `120 s`, calidad Medium, `anisotropy=1`, `slopeMip=auto`.

URL principal:

```text
?oceanValidation=pr6b-sun-column&foam=0&quality=medium&anisotropy=1&slopeMip=auto
```

## Resultado medido

- Errores de consola/shader en navegación limpia: `0`.
- Píxeles tone-mapped `>= 0.99` en la captura solar: `0.001%` del frame completo.
- La máscara de clipping sólo marca fragmentos dispersos dentro de la columna especular; no existe una masa blanca continua.
- Pruebas A/B: el patrón permanece con `slopeMip=0`, pero desaparece con anisotropía desactivada o con el nuevo marco estable.

## Límite conocido

Esta validación cierra el artefacto solar rectangular. La legibilidad nocturna y la energía de luces locales continúan siendo un criterio independiente de PR6B y no se consideran aprobadas por estas capturas.

El proyecto Playwright `chromium` headless de esta máquina expone `navigator.gpu`,
pero Three.js termina construyendo el backend GLSL/WebGL2 y rechaza
`storageTexture`. Su ejecución no es evidencia visual válida: 14 casos fallaron
por backend, 2 pasaron sobre frames negros y 1 quedó omitido. Las capturas de este
directorio proceden de la sesión interactiva WebGPU, donde los escenarios
anteriores no produjeron errores de consola ni de compilación de shader.
