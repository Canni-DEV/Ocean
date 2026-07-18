# Roadmap de implementación del océano AAA

**Estado del documento:** activo

**Última actualización:** 2026-07-18

**Documento de diseño rector:** [`Ocean_AAA_Technical_Design.md`](./Ocean_AAA_Technical_Design.md)

**Objetivo visual:** Atlántico profundo, frío, fotorealista y cinematográfico.

## 1. Propósito

Este documento convierte el diseño técnico del océano en un plan ejecutable y un
checklist de seguimiento. Se debe actualizar al cerrar cada PR, junto con sus
capturas, métricas, pruebas y desviaciones justificadas.

El orden de implementación prioriza el problema visual actual: el movimiento del
océano mejoró, pero la iluminación, los reflejos, la lectura nocturna y el contacto
con el barco todavía no forman un sistema óptico completo.

## 2. Reglas del programa

- [x] Conservar durante PR6B las fases FFT, desplazamiento, choppiness,
  buoyancy y movimiento actuales.
- [x] No recuperar un albedo Lambert azul para simular volumen.
- [x] Mantener agua y espuma como materiales ópticamente distintos en PR6B.
- [x] Evitar ajustes globales de exposición que oculten un error local del agua.
- [x] No introducir ruido pintado para fabricar glitter, bandas claras o crestas.
- [x] PR6B puede aislar sus contribuciones mediante debug y captura A/B.
- [ ] Cada PR debe registrar coste GPU, frame p95 y efecto visual antes/después.
- [ ] High es el tier de aceptación visual; Medium y Low deben compilar y superar
  smoke tests de estabilidad y todos los modos debug.
- [ ] No se cierra una PR únicamente porque compile: debe satisfacer su criterio
  visual reproducible.
- [ ] Separar y revisar los cambios actuales antes de acumular otra refactorización
  grande en el working tree.

## 3. Leyenda de estado

- `[x]`: implementado y verificado dentro del alcance indicado.
- `[ ]`: pendiente, incompleto o todavía no verificado.
- **Parcial**: existe una implementación funcional, pero no alcanza todavía la
  definición de terminado del diseño.
- **Bloqueante visual**: debe resolverse antes de avanzar hacia mejoras que dependan
  de su resultado.

## 4. Línea base actual

### 4.1 Salud del proyecto

- [x] `npm run typecheck`: 0 errores y 0 warnings el 2026-07-18.
- [x] `npm run test:run`: 67 pruebas aprobadas el 2026-07-18.
- [x] Registrar referencias de línea base y candidatos PR6B con seed `1337`.
- [ ] Registrar p50/p95 GPU y CPU de la línea base en High a `2560x1440`.
- [ ] Ejecutar prueba sostenida de 30 minutos.
- [ ] Separar los cambios actuales en commits/PR revisables.

### 4.2 Diagnóstico visual vigente

- [x] El movimiento presenta una jerarquía más natural que la versión inicial.
- [x] Las normales totales redujeron parte de la apariencia gelatinosa anterior.
- [ ] El agua cercana todavía se percibe como plástico azul o aceite.
- [ ] La columna solar es demasiado ancha, difusa y propensa al clipping.
- [x] Las luces locales participan en especular, volumen y espuma del agua.
- [x] La noche tiene calibración reproducible con luna, foco, linterna y relámpago.
- [ ] El barco no aparece de forma suficiente en la reflexión cercana.
- [ ] El horizonte conserva demasiado contraste, saturación y microdetalle.
- [ ] La escala cercana carece de una banda micro espectral dedicada.

## 5. Orden maestro de implementación

| Orden | Hito | Estado | Resultado esperado | Bloquea |
|---:|---|---|---|---|
| 0 | Baseline e instrumentación | Parcial | Comparaciones reproducibles | Todas |
| 1 | PR1 — Derivadas y normal exacta | Parcial avanzada | Superficie coherente | PR4/PR6 |
| 2 | PR2 — Cascadas y espectro reproducible | Parcial avanzada | Bandas estables | PR4/PR5 |
| 3 | PR3 — LOD espectral provisional | Parcial | Menos shimmering | PR4B |
| 4 | PR4 — Slope moments | Parcial | Roughness filtrada | PR6B |
| 5 | PR6A — Óptica Atlántico base | Parcial | Fresnel y volumen base | PR6B |
| 6 | **PR6B — Luces locales, noche y glitter** | **Reabierta: PR6B.6 estabilización implementada; pendiente inspección visual** | Interacción luminosa convincente | PR6C |
| 7 | PR6C — SSR, refracción, contacto y horizonte | Pendiente | Integración con escena | PR7/PR8 |
| 8 | PR4B — Microescala y LOD definitivo | Pendiente | Detalle cercano estable | PR5/PR7 |
| 9 | PR5 — `PhysicalSeaState` | Pendiente | Mar físicamente controlable | PR7 |
| 10 | PR7 — Espuma y spray profesionales | Pendiente | Rompientes legibles | PR8 |
| 11 | PR8 — Wake multiescala | Parcial/legacy | Estela y contacto persistentes | PR9 |
| 12 | PR9 — Física de alta fidelidad | Pendiente | Barco y océano coherentes | Cierre |
| 13 | Validación AAA y optimización | Pendiente | Release candidate | Release |

PR6B y PR6C se adelantan a PR5 porque el principal bloqueo actual es óptico. El
estado de mar no corregirá la ausencia de iluminación local, reflejo cercano ni
lectura nocturna.

## 6. Checklist por hito

### 6.1 Hito 0 — Baseline e instrumentación

- [x] Harness por URL con seed, tiempo, cámara, clima, mar y espuma.
- [x] Escenarios de cubierta, proa, puente y cámaras aéreas.
- [x] Añadir escenarios realmente nocturnos.
- [x] Añadir control reproducible de foco, linterna, cabina, navegación y fondeo.
- [ ] Permitir `boatWaterInteraction` en escenarios que validan contacto.
- [ ] Capturar buffers/debug además del color final.
- [x] Automatizar ROI de agua, porcentaje de clipping y luminancia espacial.
- [x] Guardar JSON por captura: navegador, resolución, DPR,
  seed, tiempo, preset y flags.
- [ ] Registrar baseline de Chrome y Edge en Windows.

### 6.2 PR1 — Cierre de derivadas y normal exacta

- [x] Conservar pendientes y derivadas horizontales crudas.
- [x] Separar la textura de espuma de las derivadas.
- [x] Sumar cascadas antes de construir tangentes y normal total.
- [x] Eliminar división independiente de pendientes por stretch.
- [x] Aplicar choppiness por banda.
- [x] Mantener el contrato de `OceanPhysicsSampler`.
- [x] Añadir debug de pendiente, Jacobiana y normal.
- [x] Pruebas CPU de tangentes y normal total.
- [ ] Comparar normal GPU contra diferencias finitas en campo cercano.
- [ ] Verificar error medio menor de `1.5°` y p95 menor de `4°`.
- [ ] Confirmar ausencia de NaN/Inf en transición de presets.

### 6.3 PR2 — Cierre de cascadas y espectro

- [x] Perfiles de cascada High, Medium y Low.
- [x] Seed determinista estable por cascada y texel.
- [x] Ventanas solapadas seno/coseno.
- [x] Precedencia weather/manual-overrides.
- [ ] Medir energía real de cada espectro GPU; no usar sólo estimaciones.
- [ ] Medir varianza de altura y pendiente reales.
- [ ] Calcular correlación cruzada real; eliminar `correlation: 0` como placeholder.
- [ ] Error de energía integrada menor o igual a `2%`.
- [ ] Correlación absoluta entre cascadas menor de `0.05`.
- [ ] Verificar que preset y overrides conservan seed/fase sin popping.

### 6.4 PR3 — Cierre de LOD provisional

- [x] Pesos separados para geometría y normal.
- [x] Peso dependiente de FOV y altura de render.
- [x] Transferencia inicial de energía eliminada a roughness.
- [x] Debug de pesos y energía no resuelta.
- [ ] Sustituir la longitud de onda representativa por información por frecuencia
  o por subbandas.
- [ ] Validar explícitamente los rangos `>4 px`, `1–4 px`, `0.25–1 px` y
  `<0.25 px`.
- [ ] Medir reducción de shimmering del horizonte mayor o igual a `50%`.
- [ ] Confirmar ausencia de popping al cambiar FOV, DPR y resolución.

### 6.5 PR4 — Cierre de slope moments

- [x] `moments0` con media y segundos momentos.
- [x] `moments1` con covarianza cruzada.
- [x] Cadena mip en todos los tiers.
- [x] Reconstrucción de varianza, covarianza y anisotropía.
- [x] Roughness dependiente de varianza y derivadas de pantalla.
- [x] Normal y tangente base estables en la malla radial.
- [x] Modos debug de mip, varianza, anisotropía y roughness.
- [ ] Reemplazar o verificar la generación automática de mips con reducción
  `2x2` explícita e instrumentable.
- [ ] Medir tiempo GPU real de slope moments mediante timestamps asíncronos.
- [ ] Readback del último mip y comparación con CPU con error menor de `1%`.
- [ ] Verificar continuidad de roughness entre mips menor de `0.03`.
- [ ] Validar estabilidad temporal al cambiar cámara y resolución.

### 6.6 PR6A — Cierre de óptica Atlántico base

- [x] Eliminar altura directa hacia albedo.
- [x] Separar el color/roughness de espuma.
- [x] Fresnel con IOR `1.333`.
- [x] Absorción, scattering y Beer–Lambert base.
- [x] Eliminar emisivo de cresta basado en altura.
- [ ] Consumir coherentemente los parámetros ópticos de `EnvironmentState` o
  eliminar de esa interfaz los valores que ya no sean fuente de verdad.
- [x] Sustituir el volumen puramente ambiental por un modelo que reciba luz
  direccional y local.
- [ ] Incorporar background refracted/scene color cuando PR6C lo habilite.
- [ ] Validar clara, nublada y nocturna como exige el diseño.

## 7. PR6B — Luces locales, noche y glitter

### 7.1 Objetivo

Completar la iluminación directa del agua sin modificar su movimiento. La luz de
proa, la linterna, las luces puntuales relevantes, el sol y la luna deben producir
una respuesta óptica coherente en la superficie y el volumen. El glitter debe
estar localizado y conservar energía sin formar manchas blancas extensas.

### 7.2 Resultado observable

- La luz de proa forma un cono legible sobre el agua, con reflejo especular y
  dispersión volumétrica atenuada por distancia.
- La linterna ilumina una región limitada y responde a su batería/intensidad.
- La espuma recibe iluminación difusa independiente del volumen.
- La luna define forma y dirección durante la noche sin convertir el mar en gris.
- El mar nocturno conserva volumen azul verdoso oscuro y detalle de baja frecuencia.
- El sol genera una columna de glitter controlada, fragmentada y sin clipping masivo.
- Apagar una luz elimina su contribución sin recompilar el pipeline ni producir
  popping.

### 7.3 Fuera de alcance

- SSR y reflejo cercano del barco; se implementan en PR6C.
- Refracción de scene color y fondo somero; PR6C.
- Autoexposición global nueva, bloom nuevo o cambios de ACES.
- Espuma profesional, spray y breaking topology; PR7.
- Nuevas ondas, fases, cascadas o choppiness; PR4B/PR5.
- Sombras volumétricas completas dentro del agua.

### 7.4 Decisiones de arquitectura

1. **No usar diffuse azul.** El agua se compone con reflexión especular, volumen y
   espuma.
2. **Una sola evaluación de energía directa.** Sol y luna no pueden contribuir una
   vez mediante GGX estándar y otra mediante glitter analítico.
3. **Conservar las luces del scene graph.** Barco, linterna, sol y luna seguirán
   iluminando el resto del mundo con las luces Three.js actuales.
4. **Lighting model público de Three.js.** `OceanPhysicalNodeMaterial` reemplaza
   únicamente la iluminación directa mediante `OceanLightingModel`; IBL e
   indirecta conservan la ruta de `PhysicalLightingModel`.
5. **Una fuente de verdad.** Cada luz se etiqueta con `OceanLightRole` en
   `userData`; el lighting model recibe `lightColor` ya atenuado, con cono y sombra.
6. **Unidades coherentes.** Color e intensidad se convertirán a espacio lineal y se
   usará atenuación inversa al cuadrado compatible con `decay = 2`.
7. **Sin feature flag ni arrays paralelos.** La ruta final usa sólo APIs públicas
   de `three/webgpu` y `three/tsl`.

### 7.5 Gate técnico PR6B.0 — Integración TSL/Three

Antes de implementar el modelo completo se debe crear una prueba mínima con un
plano de agua, una directional y una spotlight.

- [x] Probar un `lightsNode`/lighting model específico para el material del océano
  en Three.js `0.185.x`.
- [x] Confirmar que permite distinguir luces direccionales y locales.
- [x] Confirmar que mantiene sombras estándar de SpotLight.
- [x] Confirmar que el entorno/IBL sigue disponible como contribución indirecta.
- [x] Confirmar que sun/moon no se evalúan dos veces.
- [ ] Confirmar pipeline estable al alternar intensidad entre cero y valor activo.
- [ ] Medir coste de la prueba.

**Decisión preferida:** usar el sistema estándar para sombras y datos directos,
pero reemplazar la respuesta directa del material del agua mediante un lighting
model propio. La respuesta volumétrica se suma en ese mismo modelo.

**Fallback:** si el hook no es suficientemente estable, usar un bloque fijo de
uniforms para luces locales y una ruta analítica completa del agua. En ese caso se
debe desactivar explícitamente la especular directa estándar sólo para el material
del océano, conservando IBL, para evitar duplicación.

El gate se considera aprobado únicamente con una captura y un debug que demuestren
las contribuciones separadas.

### 7.6 Contratos de datos implementados

- `OceanLightRole` clasifica sol, luna, foco, linterna, cabina, navegación,
  fondeo, relámpago y fallback `generic`.
- `tagOceanLight()` escribe exclusivamente `light.userData.oceanLightRole`.
- No existen snapshots, slots ni arrays paralelos: Three.js evalúa una vez cada
  luz del scene graph y entrega dirección, color, atenuación, cono y sombra.
- `OceanOpticsProfile` contiene la única instancia tipada `ATLANTIC_DEEP`; sus
  overrides son de diagnóstico y están acotados.

### 7.7 Modelo óptico local

Para una luz local y un punto de agua:

```text
distanceAttenuation = rangeWindow(d, range) / max(d², epsilon)
spotAttenuation = smoothstep(cosOuter, cosInner, dot(lightAxis, toPoint))
incidentRadiance = color * intensity * distanceAttenuation * spotAttenuation
transmittance = exp(-extinction * opticalPath)
phase = HenyeyGreenstein(cosTheta, g)
localInscatter = incidentRadiance
               * scatteringAlbedo
               * (1 - transmittance)
               * phase
               * subsurfaceVisibility
```

Restricciones:

- `opticalPath` debe estar acotado para evitar halos infinitos.
- El factor de fase inicial debe ser moderadamente forward, calibrado en un rango
  seguro y documentado; no usarlo como multiplicador artístico sin límites.
- La contribución debe caer a cero fuera del cono/rango.
- La incidencia bajo la superficie y la orientación de la normal deben evitar que
  una luz desde debajo o detrás ilumine el agua de forma imposible.
- La espuma usa iluminación difusa y roughness `0.72`; no reutiliza `localInscatter`.
- Los valores finales se mantienen HDR hasta ACES.

### 7.8 Glitter solar y lunar

- [x] Obtener normal filtrada, matriz de covarianza y roughness desde slope moments.
- [x] Usar distribución GGX anisotrópica con masking-shadowing.
- [x] Incorporar Fresnel y visibilidad/direct mask del astro.
- [x] Incorporar color e intensidad HDR reales de sol/luna desde
  `EnvironmentState`.
- [x] Incorporar sombra de nubes.
- [x] Definir tamaño angular efectivo del sol y de la luna para evitar una fuente
  puntual infinitamente dura.
- [x] Eliminar el cálculo de glitter que sea sólo debug o conectarlo a la ruta real.
- [x] Evitar cualquier máscara de altura, Perlin o color pintado.
- [x] Añadir un limitador de energía físicamente motivado antes del tone mapping,
  no un clamp RGB posterior.
- [x] Calibrar sol bajo, sol lateral, luna y nublado por separado.

La columna debe concentrarse alrededor de la dirección especular y fragmentarse
por la distribución de pendientes. Fuera de ella no deben persistir bandas claras
que parezcan espuma.

### 7.9 Noche

- [x] Enviar dirección, color, intensidad, visibilidad y máscara directa de luna al
  océano.
- [x] Añadir contribución lunar al glitter y al volumen.
- [x] Usar el ambiente nocturno sólo como radiancia residual, no como relleno gris.
- [x] Definir un suelo físico de radiancia ascendente para evitar negro absoluto.
- [x] Consumir relámpagos como pulso óptico transitorio sin modificar la exposición
  base del agua de forma permanente.
- [ ] Validar transición atardecer-noche-amanecer sin saltos.
- [x] Verificar que el env map nocturno y la luna usan la misma orientación y color.

### 7.10 Cambios por archivo previstos

| Archivo/área | Cambio previsto |
|---|---|
| `src/engine/types.ts` | Estados ópticos, nuevos modos debug y métricas |
| `src/boat/BoatVisual.ts` | Snapshot read-only del foco de proa |
| `src/player/PlayerFlashlight.ts` | Snapshots de spotlight y spill |
| `src/atmosphere/AtmosphereSystem.ts` | Exponer relámpago y estado direccional completo sin duplicar fuentes de verdad |
| `src/engine/EngineApp.ts` | Componer `OceanOpticalLightingState` después de actualizar luces y atmósfera |
| `src/ocean/OceanRenderer.ts` | Uniforms, lighting model, volumen local, glitter real y debug |
| `src/ocean/simulation/OceanMath.ts` | Referencias CPU puras para atenuación, fase, GGX y energía |
| `src/ocean/OceanValidationHarness.ts` | Escenarios nocturnos y estados on/off reproducibles |
| `src/ui/DebugPanel.svelte` | Vistas por contribución y controles de diagnóstico |
| `src/engine/types.ts` / métricas | `oceanLocalLightingMs` y/o coste de la ruta óptica si puede aislarse |

### 7.11 Orden de implementación interno

#### PR6B.0 — Spike y baseline

- [x] Implementar el gate TSL/Three.
- [x] Añadir capturas actuales de sol y noche.
- [x] Congelar seed, cámara, tiempo y exposición.
- [x] Elegir y documentar la ruta de lighting model.

#### PR6B.1 — Flujo de datos de luces

- [x] Crear tipos ópticos y roles de luz.
- [x] Etiquetar las luces propietarias sin snapshots paralelos.
- [x] Consumir directamente el estado del scene graph en el lighting model.
- [x] Mantener luces persistentes con intensidad cero.
- [ ] Pruebas unitarias de transformación a coordenadas mundiales.
- [ ] Prueba de toggle sin recompilación ni popping.

#### PR6B.2 — Respuesta de focos y puntos

- [x] Implementar atenuación de distancia y cono mediante `lightColor` de Three.
- [x] Implementar local specular.
- [x] Implementar local volume/inscatter.
- [x] Separar iluminación de espuma.
- [x] Verificar sombras High/Medium y desactivarlas en Low.
- [x] Debug por roles y contribución.

#### PR6B.3 — Sol, luna y glitter

- [x] Implementar una única ruta directa.
- [x] Integrar slope covariance y GGX anisotrópico.
- [x] Integrar máscaras atmosféricas y cloud shadow.
- [x] Calibrar fuente angular y radiancia HDR.
- [x] Eliminar duplicación con MeshPhysicalNodeMaterial.

#### PR6B.4 — Calibración nocturna

- [x] Ajustar volumen residual y env map nocturno.
- [x] Añadir luna y relámpagos.
- [x] Validar foco y linterna en escenas nocturnas controladas.
- [x] Validar tormenta/nubes sin elevar el negro global.

#### PR6B.5 — QA y rendimiento

- [x] Completar matriz visual candidata en Edge.
- [x] Ejecutar métricas automáticas de ROI.
- [ ] Ejecutar High en Chrome y Edge.
- [x] Smoke Medium/Low.
- [ ] Ejecutar 30 minutos sin crecimiento de memoria.
- [x] No conservar feature flags ni rutas legacy temporales.

### 7.12 Modos debug requeridos

- [x] `localSpecular`.
- [x] `localVolume`.
- [x] `localLightRoles` con color distinto por rol.
- [x] `sunGlitter`.
- [x] `moonGlitter`.
- [x] `ambientVolume`.
- [x] `foamLighting`.
- [x] `luminanceHeatmap`.
- [x] `clippingMask`.

Cada modo debe aislar la contribución, no mostrar una aproximación desconectada del
color final.

### 7.13 Pruebas unitarias PR6B

- [x] Atenuación inversa al cuadrado finita en distancia cero.
- [x] Ventana de rango continua y cero fuera del rango.
- [x] Atenuación spotlight continua entre conos exterior e interior.
- [ ] Transformación de posición/dirección local a mundial.
- [x] Beer–Lambert local por canal.
- [x] Función de fase finita y normalizada en el rango usado.
- [x] Fresnel de agua en incidencia normal y rasante.
- [x] GGX anisotrópico finito, recíproco y conservativo.
- [x] Conservación de energía entre reflexión, volumen y espuma.
- [x] Clasificación por rol y fallback `generic`.
- [x] Defaults y límites de `ATLANTIC_DEEP`.

### 7.14 Escenarios reproducibles PR6B

Todos con seed `1337`, tiempo de simulación fijo y espuma on/off cuando corresponda.

| ID propuesto | Cámara | Hora/clima | Estado luminoso | Objetivo |
|---|---|---|---|---|
| `night-rail-bow-off` | Baranda | 23:00 despejado | Foco off | Baseline nocturna |
| `night-rail-bow-on` | Baranda | 23:00 despejado | Foco on | Cono y volumen |
| `night-bow-flash-off` | Proa | 01:00 nublado | Linterna off | Control A/B |
| `night-bow-flash-on` | Proa | 01:00 nublado | Linterna on | Alcance y caída |
| `moonlit-bridge` | Puente | 22:00 despejado | Luna visible | Forma lunar |
| `storm-night-lightning` | Puente | 02:00 tormenta | Relámpago fijo | Respuesta HDR |
| `sun-glitter-low` | Proa | 17:40 despejado | Sol bajo | Columna solar |
| `sun-glitter-lateral` | Baranda | 14:30 despejado | Sol lateral | Glints locales |
| `overcast-deck` | Puente | 15:00 nublado | Sin directo fuerte | Volumen/IBL |

### 7.15 Criterios de aceptación PR6B

#### Funcionales

- [ ] Luz apagada produce contribución exactamente cero en su debug.
- [x] La luz de proa y linterna iluminan agua y espuma dentro de su cono.
- [x] La variación medida fuera del cono permanece bajo el umbral acordado.
- [ ] No hay recompilación visible al alternar luces.
- [x] Sol, luna y luces locales permanecen finitos sin NaN/Inf.

#### Visuales

- [x] La mediana de luminancia dentro del ROI del foco aumenta al menos dos stops
  entre off/on, sujeto a calibración final de exposición.
- [x] Fuera del cono, la variación de luminancia off/on es menor de `10%` salvo
  reflexión físicamente justificable.
- [x] Menos de `0.5%` de píxeles del ROI y la superficie visible quedan recortados.
- [x] La columna solar candidata no forma una masa blanca continua
  fuera de la dirección especular.
- [x] En noche, el agua mantiene silueta, gradiente de Fresnel y volumen sin llegar
  a negro absoluto ni parecer autoiluminada.
- [ ] La espuma desactivada mantiene su debug negro.
- [ ] Paneo lento reduce al menos `50%` la variación temporal de alta frecuencia
  frente a la línea base previa a PR4/PR6.

#### Rendimiento

- [ ] Frame High p95 menor o igual a `16.7 ms` a `2560x1440`.
- [ ] Simulación oceánica p95 menor o igual a `2.5 ms`.
- [ ] Render del agua A/B p95 menor o igual a `2.0 ms` o desviación aprobada con
  perfil y plan de optimización.
- [ ] Coste incremental de PR6B registrado por cada fuente activa.
- [ ] Sin crecimiento de memoria ni inestabilidad durante 30 minutos.

### 7.16 Definition of Done PR6B

- [x] Gate técnico aprobado y decisión documentada.
- [x] Código y contratos implementados.
- [x] Tests unitarios y typecheck aprobados.
- [ ] Matriz visual capturada en Chrome y Edge.
- [x] Debugs conectados a las contribuciones reales.
- [ ] Métricas de luminancia, clipping, shimmering y rendimiento adjuntas.
- [ ] Comparación antes/después aprobada en cubierta, proa y noche.
- [x] No se modificó el movimiento del océano.
- [x] No se introdujo diffuse azul ni ruido de glitter.
- [x] Documentación y checklist actualizados.

### 7.17 Estado de entrega PR6B

**Candidate anterior invalidado visualmente el 2026-07-18.** Las inspecciones en
amanecer y noche revelaron clipping solar/lunar y estructura rectangular. La
auditoría encontró una distribución GGX anisotrópica sin normalizar; la referencia
CPU repetía la misma expresión y producía un falso positivo. PR6B.6 corrige la
normalización, añade integración hemisférica independiente, elimina doble conteo
de slope variance, proyecta covarianza al cono PSD y suprime orientación
anisotrópica de baja confianza.

El harness acepta ahora `hour=<0..24>`, `anisotropy=0|1` y
`slopeMip=auto|0..12`. Estos controles son únicamente diagnósticos y no cambian
FFT, fases, desplazamiento, física ni generación de espuma.

Pendientes para declarar la PR cerrada:

- [ ] Revisión visual humana de los PNG candidatos dentro del juego.
- [ ] Matriz equivalente en Chrome con adaptador WebGPU de hardware; Chrome for
  Testing headless de esta máquina cayó correctamente a WebGL2 y no es válido.
- [ ] 600 frames tras warm-up, A/B del agua y registro de adapter/driver.
- [ ] Soak de 30 minutos y control de heap/recursos GPU.
- [ ] Medición temporal del paneo contra la baseline previa a PR4/PR6.
- [ ] Inspección humana de las horas reportadas `7.05`, `7.92`, `18.15` y
  `19.54`, con espuma on/off y comparativas anisotropía/mip.

## 8. PR6C — SSR, refracción, contacto y horizonte

- [ ] Capturar scene color y depth compatibles con WebGPU.
- [ ] SSR de agua a media resolución con confidence y rechazo de disoclusiones.
- [ ] Fallback continuo a environment map.
- [ ] Reflejo cercano y estable del barco.
- [ ] Refracción de escena con espesor/profundidad aproximados.
- [ ] Oscurecimiento de waterline y oclusión de contacto.
- [ ] Integración de niebla y atmósfera en horizonte.
- [ ] Menos contraste y saturación con distancia.
- [ ] Debug de SSR confidence, fallback, refraction y contact.
- [ ] Presupuesto separado de SSR/refraction.
- [ ] Aceptación: el barco tiene escala/contacto y el horizonte no forma una línea
  gráfica independiente del cielo.

## 9. PR4B — Microescala y LOD definitivo

- [ ] Añadir cascada High `32 m / 256` para normal, slope variance y espuma fina.
- [ ] Definir equivalente escalable para Medium/Low o transferencia estadística.
- [ ] No usar la cascada micro para geometría distante.
- [ ] Separar frecuencias dentro de cascadas anchas cuando sea necesario.
- [ ] Seleccionar mip por huella proyectada del texel/frecuencia.
- [ ] Transferir energía no resuelta a BRDF sin doble conteo.
- [ ] Recalibrar Cox–Munk con momentos espectrales medidos.
- [ ] Eliminar factores heurísticos no documentados.
- [ ] Aceptación: lectura cercana rica sin Perlin y horizonte estable.

## 10. PR5 — Estado de mar físico

- [ ] Introducir `PhysicalSeaState`.
- [ ] Separar wind sea y múltiples swells.
- [ ] Parametrizar Hs, Tp, dirección, spreading y fetch.
- [ ] Normalizar energía para alcanzar Hs objetivo.
- [ ] Weather como fuente de verdad con overrides explícitos.
- [ ] Interpolar parámetros sin respiración ni popping.
- [ ] Preparar doble espectro sólo si la transición simple no es estable.
- [ ] Telemetría de Hs/Tp medidos contra objetivo.
- [ ] Aceptación: presets reproducibles y físicamente distinguibles.

## 11. PR7 — Espuma y spray profesionales

- [ ] Mejorar fuente de breaking con Jacobiana, steepness, curvatura y velocidad.
- [ ] Advección coherente, decay y persistencia.
- [ ] Separar whitecaps, wind streaks, contacto, wake y prop wash.
- [ ] Material de espuma con color, roughness y espesor propios.
- [ ] Evitar blanco puro y emisivo uniforme.
- [ ] Spray sólo en High y condicionado por breaking real.
- [ ] Debug por capa y tasa de cobertura.
- [ ] Aceptación: las zonas blancas describen rompimiento, no iluminación accidental.

## 12. PR8 — Wake multiescala

- [ ] Conservar interacción local existente donde sea útil.
- [ ] Wake lejano persistente dependiente de velocidad/Froude.
- [ ] Mejorar presión y desplazamiento del casco.
- [ ] Añadir hélice, timón y cavitación.
- [ ] Continuidad entre wake local, far wake, espuma y reflejo.
- [ ] Decay temporal sin textura pegada al barco.
- [ ] Aceptación: estela legible desde cubierta y cámara aérea.

## 13. PR9 — Física de alta fidelidad

- [ ] Sampler local de casco de mayor resolución.
- [ ] Velocidad vertical y horizontal del agua.
- [ ] Buoyancy multipunto consistente con desplazamiento renderizado.
- [ ] Drag, slamming y fuerzas de ola.
- [ ] Telemetría de error render/física.
- [ ] Aceptación: ausencia de separación visible entre barco y superficie.

## 14. Validación final AAA

### Visual

- [ ] Cubierta, proa, puente y tres alturas aéreas.
- [ ] Mar bajo, medio y alto.
- [ ] Día claro, sol bajo, nublado, noche lunar y tormenta nocturna.
- [ ] Espuma on/off, luces on/off, SSR on/off y wake on/off.
- [ ] Horizonte sin shimmering significativo.
- [ ] Agua cercana sin aspecto gelatinoso, aceitoso o plástico.
- [ ] Reflejos del entorno y del barco coherentes.
- [ ] Volumen nocturno legible.

### Física y estabilidad

- [ ] Sin NaN/Inf.
- [ ] Sin popping al cambiar preset, FOV, DPR, resolución o tier.
- [ ] Pausa/reanudación preserva estado.
- [ ] Resize y cambio de calidad liberan recursos anteriores.
- [ ] Seed y harness reproducibles entre sesiones.

### Rendimiento

- [ ] High cumple frame p95 `<=16.7 ms` a `2560x1440`.
- [ ] Ocean compute p95 `<=2.5 ms`.
- [ ] Water render A/B p95 `<=2.0 ms`.
- [ ] Slope moments p95 `<=0.4 ms`.
- [ ] Medium y Low pasan smoke completo.
- [ ] Prueba de 30 minutos sin leak, drift o degradación temporal.

## 15. Registro de decisiones y progreso

Actualizar esta tabla al cerrar o replanificar una PR.

| Fecha | PR | Decisión/resultado | Evidencia | Responsable |
|---|---|---|---|---|
| 2026-07-18 | Roadmap | Priorizar PR6B antes de PR5 por bloqueo óptico y regresión de luces locales | Capturas, auditoría de shader y diseño técnico | Pendiente |

## 16. Checklist de cierre por PR

Copiar esta lista en la descripción de cada PR:

- [ ] Alcance y no-objetivos respetados.
- [ ] Typecheck sin errores ni warnings.
- [ ] Tests existentes y nuevos aprobados.
- [ ] Capturas before/after reproducibles.
- [ ] Modos debug verificados.
- [ ] High validado visualmente.
- [ ] Medium/Low smoke probado.
- [ ] GPU/CPU p50 y p95 registrados.
- [ ] Sin NaN/Inf, popping ni recompilación inesperada.
- [ ] Recursos liberados en dispose/resize/cambio de tier.
- [ ] Documentación y registro de decisiones actualizados.
- [ ] Working tree y commits limitados al alcance de la PR.
