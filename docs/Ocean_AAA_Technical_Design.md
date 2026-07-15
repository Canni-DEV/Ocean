# Ocean: arquitectura técnica de océano AAA para WebGPU

**Proyecto:** `Canni-DEV/Ocean`  
**Rama revisada:** `dev`  
**Fecha de revisión:** 15 de julio de 2026  
**Estado del documento:** especificación técnica de destino e implementación incremental  
**Stack de referencia:** TypeScript, Svelte, Three.js WebGPU, TSL, compute shaders WebGPU

---

## 0. Propósito y alcance

Este documento define una arquitectura profesional, de calidad visual comparable con producciones AAA, para generar, animar, renderizar y consultar físicamente un océano en tiempo real dentro de un juego web basado en WebGPU. La propuesta parte de la implementación actual del repositorio `Ocean` y conserva sus decisiones correctas: simulación espectral FFT, cascadas, desplazamiento horizontal, malla radial centrada en cámara, integración con la atmósfera, muestreo físico del agua y campo local de interacción con el barco.

La meta no es reemplazar el sistema por un conjunto de ondas Gerstner ni agregar más ruido visual. La meta es convertir el sistema actual en una cadena coherente, medible y estable:

1. **Estado de mar físico y reproducible.**
2. **Espectro multiescala sin correlaciones artificiales.**
3. **FFT y derivadas matemáticamente consistentes.**
4. **LOD espectral y geométrico sin aliasing ni shimmering.**
5. **Shading del agua basado en reflexión, transmisión y estadística de pendientes.**
6. **Espuma, rompientes e interacción local desacopladas del espectro lineal.**
7. **Física del barco que consulta exactamente la misma superficie visible.**
8. **Presupuesto de GPU explícito, telemetría y pruebas automatizadas.**

El término “AAA” se usa como objetivo de calidad de producción: estabilidad temporal, coherencia física, controles artísticos previsibles, depuración, escalabilidad y ausencia de artefactos visibles. En un navegador no se debe copiar ciegamente el presupuesto de una consola o de un motor nativo; se deben aplicar los mismos principios con perfiles de calidad adaptados a WebGPU.

---

## 1. Línea base revisada

### 1.1 Archivos centrales

| Área | Archivo | Snapshot revisado |
|---|---|---|
| Orquestación | `src/engine/EngineApp.ts` | `44c87455b979a0f30c4a73d893236f21ba0541a2` |
| Configuración de simulación | `src/ocean/simulation/OceanSimulation.ts` | `8710df91dcfa404239f92c15fc910efe8072afc2` |
| FFT y ensamblado | `src/ocean/simulation/OceanFFT.ts` | `21f46c01100b58500d8ef9e6ee165effad63caf1` |
| Espectro | `src/ocean/simulation/OceanSpectrum.ts` | `55083ed5c6cfda258a433d420090d1072da10e49` |
| Render del agua | `src/ocean/OceanRenderer.ts` | `fa83b3d07bebd8c25ac7f73cfbcb8cfddfc4740d` |
| Estado de mar | `src/state/seaState.ts` | `05a7c0a0d64355abd48da56f6871e8a08a4e28fa` |
| Defaults de depuración | `src/state/debugStore.ts` | `507151e9ff0691656f7725b3ed1f151c491a656d` |
| Física consultable | `src/ocean/OceanPhysicsSampler.ts` | `1403a3f0720e7e48ecacbea947ae7af346790dbb` |
| Interacción del barco | `src/ocean/BoatWaterInteraction.ts` | `de021364d96435e5f6df9fde955613167f704254` |

### 1.2 Fortalezas actuales que deben conservarse

La base existente ya contiene decisiones propias de un sistema avanzado:

- FFT inversa ejecutada por compute.
- Espectro JONSWAP direccional.
- Evolución temporal con relación de dispersión de aguas profundas.
- Dos o tres cascadas según calidad.
- Desplazamiento horizontal para crestas más agudas.
- Jacobiano y espuma acumulada.
- Malla radial de densidad decreciente hacia el horizonte.
- Entorno dinámico, sol, cielo y sombras de nubes.
- Muestreo GPU/CPU de altura para física.
- Campo local de wake con historia temporal.
- Floating origin.
- Modos de depuración de altura, normal, espuma, Jacobiano, pendiente y cascadas.

Por lo tanto, la recomendación central es **refactorizar y completar**, no sustituir.

### 1.3 Problemas observados en las capturas y su correlación con el código

El aspecto “aceitoso”, “gelatinoso” o “barnizado” se explica por la suma de varios factores:

- Las cascadas comparten una secuencia aleatoria equivalente porque la semilla depende de la coordenada del texel, pero no de la cascada.
- Las bandas espectrales se cortan de forma dura mediante `kMin <= k < kMax`.
- La cascada pequeña participa en geometría y normales a distancias donde la malla ya no la puede representar.
- Las texturas de derivadas no poseen mipmaps ni un filtrado de varianza de pendientes.
- La corrección de pendiente con choppiness divide X y Z por separado y no invierte la Jacobiana completa.
- Las pendientes se corrigen por cascada antes de sumarse, aunque la superficie final es la suma de todas las cascadas.
- Un único choppiness global se aplica a todas las escalas.
- El albedo se mezcla directamente a partir de la altura de la ola.
- La roughness base es muy baja para un mar con viento moderado.
- El swell tiene período fijo y energía controlada por un multiplicador no normalizado.
- Los presets meteorológicos y el estado de mar no forman una única fuente de verdad.

La consecuencia visual es una superficie con demasiada curvatura aparente, reflejos adheridos a bultos redondeados y microdetalle que se mantiene hasta el horizonte.

---

## 2. Arquitectura de destino

La solución debe dividirse en subsistemas con contratos explícitos.

```text
Weather / Sea Authoring
        |
        v
PhysicalSeaState ------------------------------------+
        |                                             |
        v                                             v
Spectrum Builder                               Wave Statistics
        |                                             |
        v                                             |
Initial Spectrum h0 per cascade                       |
        |                                             |
        v                                             |
Temporal Evolution h(k,t)                             |
        |                                             |
        v                                             |
Inverse FFT -> displacement / raw derivatives         |
        |                                             |
        +-----------> Spectral LOD / Mips <------------+
        |                         |
        v                         v
Geometry Displacement        Shading Normal + Roughness
        |                         |
        +------------+------------+
                     v
             Ocean Surface Material
                     |
        +------------+-------------+
        |                          |
        v                          v
Foam / Breaking / Spray       Reflection / Transmission
        |
        v
Boat Interaction / Wakes / Local Solver
        |
        v
Physics Sampling / Buoyancy / Gameplay
```

### 2.1 Principio de separación de escalas

No todas las longitudes de onda deben representarse de la misma manera:

| Escala | Ejemplo | Representación principal |
|---|---|---|
| Muy larga | swell de 100-500 m | geometría y física |
| Larga | olas de 10-100 m | geometría, normal y física |
| Media | chop de 1-10 m | geometría cerca, normal a media distancia |
| Corta | 5 cm-1 m | normal, varianza y roughness |
| Capilar | milímetros-centímetros | BRDF estadística; no geometría explícita |

La transición debe depender del tamaño proyectado en pantalla, no de un simple multiplicador visual.

### 2.2 Principio de energía conservada

Cuando una frecuencia deja de representarse como geometría o normal explícita, su energía no debe desaparecer. Debe transformarse en varianza de pendientes y ensanchar el lóbulo especular. Esto evita que el océano se vuelva artificialmente liso al alejarse y, al mismo tiempo, evita aliasing y destellos inestables.

---

## 3. Estado de mar físico

### 3.1 Fuente única de verdad

El tipo actual `SeaStateParams` debe evolucionar hacia un modelo que distinga mar de viento y swell.

```ts
export type WindSeaState = {
  windSpeed10mMs: number;
  directionRad: number;
  fetchMeters: number;
  peakEnhancementGamma: number;
  directionalSpread: number;
};

export type SwellComponent = {
  significantHeightM: number;
  peakPeriodS: number;
  directionRad: number;
  directionalSpread: number;
  phaseSeed: number;
};

export type PhysicalSeaState = {
  windSea: WindSeaState;
  swells: readonly SwellComponent[];
  currentVelocityMs: { x: number; z: number };
  waterDepthM: number | "deep";
  temperatureC?: number;
  salinityPsu?: number;
  breakingThreshold: number;
  seed: number;
};
```

### 3.2 Parámetros artísticos versus parámetros físicos

El panel de desarrollo puede exponer controles artísticos, pero internamente deben mapearse a parámetros con significado:

- `Beaufort`: macrocontrol que deriva viento y una configuración inicial de mar.
- `windSpeed10mMs`: velocidad del viento a 10 metros.
- `fetchMeters`: distancia efectiva sobre la cual sopla el viento.
- `Hs`: altura significativa.
- `Tp`: período pico.
- `gamma`: realce del pico JONSWAP.
- `directionalSpread`: concentración angular.
- `choppiness`: control visual limitado por steepness, no energía primaria.

No se debe usar simultáneamente un `weather.windSpeedMs` y un `debug.beaufort` sin una regla de precedencia visible. Se recomienda:

```ts
export type SeaStateSource =
  | { mode: "weather" }
  | { mode: "manual"; value: PhysicalSeaState }
  | { mode: "weather-with-overrides"; overrides: Partial<PhysicalSeaState> };
```

### 3.3 Presets recomendados

Los presets deben describir una condición concreta, no sólo “más intensidad”. Ejemplos:

| Preset | Viento | Fetch | Swell | Lectura visual |
|---|---:|---:|---|---|
| Calm offshore | 2-3 m/s | 30 km | Hs 0.3 m, Tp 9 s | swell suave, poca microonda |
| Clear breeze | 6-8 m/s | 150-300 km | Hs 0.5 m, Tp 10-12 s | mar organizado, destellos direccionales |
| Overcast developed sea | 11-14 m/s | 400+ km | Hs 1-2 m, Tp 11-13 s | olas de viento con crestas agudas |
| Storm | 20+ m/s | 500+ km | múltiples swells | rompientes, espuma, spray y visibilidad reducida |

Los valores son rangos de autoría. Deben validarse mediante métricas de altura significativa y período dominante calculadas desde el espectro final.

### 3.4 Transiciones entre estados

No se debe reescribir abruptamente `h0` mientras una superficie está visible. Se recomienda mantener dos realizaciones espectrales:

```text
Current spectrum A -> evolve at t
Target spectrum B  -> evolve at t
Output = sqrt(1 - blend) * A + sqrt(blend) * B
```

La ponderación por raíz ayuda a conservar varianza durante la transición. Cambios pequeños de amplitud pueden interpolar parámetros; cambios fuertes de dirección, semilla o swell deben usar doble espectro durante 20-90 segundos según el fenómeno.

---

## 4. Generación espectral

### 4.1 Relación de dispersión

Para aguas profundas:

$$
\omega(k) = \sqrt{g k}
$$

Para profundidad finita:

$$
\omega(k) = \sqrt{g k \tanh(kh)}
$$

La versión de profundidad finita es necesaria cuando el juego incorpore costas, bancos o ciudades asentadas sobre zonas someras. En océano abierto se puede mantener la variante de aguas profundas.

Si existe corriente superficial uniforme $\mathbf{U}$, la fase puede incorporar Doppler:

$$
\omega'(\mathbf{k}) = \omega(k) + \mathbf{k}\cdot\mathbf{U}
$$

### 4.2 Espectro base

La implementación actual usa JONSWAP, decisión correcta para un mar limitado por fetch. El espectro debe producir una densidad de energía coherente y luego mapearse de frecuencia a número de onda con el Jacobiano correspondiente.

La amplitud discreta de cada celda debe considerar:

- densidad espectral,
- ancho de celda $\Delta k_x\Delta k_z$,
- simetría Hermitiana,
- conversión entre espectro de frecuencia y espectro espacial,
- factor de energía para evitar doble conteo.

La comprobación fundamental no es “se ve bien”, sino que la varianza de altura medida coincide con la energía integrada esperada.

### 4.3 Direccionalidad

El spreading debe distinguir entre:

- mar de viento, relativamente ancho alrededor de la dirección del viento;
- swell, más angosto y coherente;
- componentes cruzadas, cuando existen swells de otras tormentas.

Se recomienda que cada `SwellComponent` tenga su propio pico, dirección y ancho. Un único ridge de swell fijo no alcanza para producir estados convincentes.

### 4.4 Semillas independientes por cascada

Cada cascada debe tener:

```ts
export type CascadeSeed = {
  oceanSeed: number;
  cascadeIndex: number;
  realizationSeed: number;
};
```

La semilla final debe mezclar las tres partes con un hash entero estable. Nunca debe depender únicamente de `x + y * resolution`.

```ts
const seed = hash32(
  oceanSeed ^
  Math.imul(cascadeIndex + 1, 0x9e3779b1) ^
  Math.imul(texelIndex + 1, 0x85ebca6b)
);
```

Requisitos:

- determinismo entre sesiones;
- independencia estadística entre cascadas;
- simetría consistente entre $\mathbf{k}$ y $-\mathbf{k}$;
- posibilidad de regenerar un mundo mediante seed.

### 4.5 Bandas con solapamiento

No usar un corte binario en `kMin/kMax`. Cada cascada debe tener una región de transición.

```text
band 0: [k0, k2], plena en [k0, k1]
band 1: [k1, k4], plena en [k2, k3]
```

En la zona compartida:

$$
w_A = \cos\left(\frac{\pi}{2}t\right),\quad
w_B = \sin\left(\frac{\pi}{2}t\right)
$$

De esta forma:

$$
w_A^2 + w_B^2 = 1
$$

La energía no se duplica ni desaparece. El peso debe aplicarse a la amplitud, no directamente a la energía sin ajustar.

### 4.6 Longitudes y resoluciones recomendadas

Una configuración inicial para `high`:

| Cascada | Patch | Resolución | Uso |
|---|---:|---:|---|
| Swell | 2048 m | 256 | geometría, física, normal |
| Wind sea | 512 m | 512 | geometría, física, normal |
| Chop | 128 m | 512 | geometría cercana, normal |
| Micro | 32 m | 256 | normal, slope variance, espuma fina |

Configuración `medium`:

| Cascada | Patch | Resolución | Uso |
|---|---:|---:|---|
| Swell | 1536 m | 192 o 256 | geometría y física |
| Wind sea | 384 m | 256 | geometría y normal |
| Chop | 96 m | 256 | geometría cercana y normal |

Configuración `low`:

- 2 cascadas;
- FFT 128 o 192;
- microondas sustituidas por BRDF procedimental;
- menor frecuencia de actualización para cascada grande si fuera necesario.

Las cifras son punto de partida. El criterio final es el rango de $k$ cubierto y el coste medido.

### 4.7 Normalización por altura significativa

Debe existir una etapa de calibración que calcule la varianza teórica o medida y escale el espectro a la altura significativa objetivo:

$$
H_s \approx 4\sqrt{m_0}
$$

con $m_0$ como momento espectral de orden cero. La normalización evita que `swellAmount`, `alpha`, `gamma` y el tamaño del patch se combinen de forma impredecible.

---

## 5. Evolución temporal y FFT

### 5.1 Simetría Hermitiana

Para obtener una superficie real, se debe cumplir:

$$
\tilde{h}(-\mathbf{k},t) = \tilde{h}(\mathbf{k},t)^*
$$

La construcción de `h0(k)` y `h0(-k)` debe ser verificable mediante una prueba que mida el error imaginario residual después de la IFFT.

### 5.2 Evolución

La forma habitual:

$$
\tilde{h}(\mathbf{k},t) =
\tilde{h}_0(\mathbf{k})e^{i\omega t} +
\tilde{h}_0^*(-\mathbf{k})e^{-i\omega t}
$$

Se deben producir en frecuencia:

- altura $D_y$;
- desplazamiento horizontal $D_x,D_z$;
- pendiente cruda $\partial y/\partial x$, $\partial y/\partial z$;
- derivadas de desplazamiento horizontal para Jacobiana;
- opcionalmente velocidad vertical y horizontal para física avanzada.

### 5.3 Precisión numérica

Recomendación:

- espectro y ping-pong FFT: `RGBA32F` cuando la plataforma lo tolere;
- salida final: `RGBA16F` si el error medido es aceptable;
- estadísticas y acumulación de espuma: formato separado, normalmente `R16F` o `RG16F`;
- evitar almacenar señales con rangos incompatibles en un mismo canal si ello obliga a perder precisión.

Se debe medir:

- RMS de altura;
- RMS de pendiente;
- error de reconstrucción;
- drift temporal;
- máximos por cascada;
- NaN/Inf.

### 5.4 Packing recomendado

Una disposición clara:

```text
Displacement texture RGBA16F
R: Dx
G: Dy
B: Dz
A: reserved / velocityY / curvature

Derivative texture 0 RGBA16F
R: dY/dx
G: dY/dz
B: dDx/dx
A: dDz/dz

Derivative texture 1 RG16F or RGBA16F
R: dDx/dz
G: dDz/dx
B/A: optional curvature / breaking metric

Foam texture R16F
R: persistent foam history
```

Si por simetría matemática `dDx/dz` y `dDz/dx` son equivalentes dentro del modelo, se puede almacenar uno; aun así, la interfaz debe documentar esa suposición.

### 5.5 Normal de la superficie desplazada

La superficie paramétrica es:

$$
\mathbf{P}(x,z) =
\begin{bmatrix}
x + \lambda D_x(x,z)\\
D_y(x,z)\\
z + \lambda D_z(x,z)
\end{bmatrix}
$$

Sus tangentes son:

$$
\mathbf{T}_x =
\begin{bmatrix}
1 + \lambda D_{x,x}\\
D_{y,x}\\
\lambda D_{z,x}
\end{bmatrix},\qquad
\mathbf{T}_z =
\begin{bmatrix}
\lambda D_{x,z}\\
D_{y,z}\\
1 + \lambda D_{z,z}
\end{bmatrix}
$$

La normal geométrica correcta es:

$$
\mathbf{N} = \operatorname{normalize}(\mathbf{T}_z \times \mathbf{T}_x)
$$

Esta formulación es más segura que dividir pendientes por cada stretch de forma independiente. Puede implementarse directamente o mediante la inversa de la Jacobiana horizontal.

### 5.6 La Jacobiana debe construirse después de sumar cascadas

La superficie visible es la suma de cascadas. Por lo tanto:

1. muestrear derivadas crudas de cada cascada;
2. aplicar pesos de LOD;
3. sumar todas las derivadas;
4. aplicar choppiness por banda;
5. construir tangentes/Jacobiana total;
6. obtener normal y determinante.

No se deben “corregir” pendientes dentro de cada FFT y luego sumarlas, porque la transformación no es lineal.

### 5.7 Choppiness controlado por steepness

El desplazamiento horizontal es una herramienta visual no lineal. Debe limitarse por banda.

Para cada banda se estima:

$$
\epsilon \sim k a
$$

Cuando la steepness supera el umbral de autoría:

- limitar $\lambda$;
- aumentar breaking probability;
- emitir espuma;
- no permitir que la superficie se pliegue de manera masiva.

Configuración orientativa:

```ts
export type CascadeChoppiness = {
  lambda: number;
  maxSteepness: number;
  breakingStart: number;
  breakingFull: number;
};
```

El swell puede tener crestas largas y poco ruidosas; la microcascada no debe recibir el mismo choppiness que las olas principales.

---

## 6. LOD espectral y geométrico

### 6.1 Problema a resolver

Una FFT puede contener ondas de centímetros, pero la malla del horizonte posee triángulos de decenas o cientos de metros. Si esas frecuencias desplazan vértices o producen normales sin filtrado:

- aparece aliasing;
- el relieve cambia con la cámara;
- el brillo parpadea;
- se forman líneas blancas y moiré;
- la superficie se percibe como aceite o metal líquido.

### 6.2 Tamaño proyectado

Para una longitud de onda $\lambda_w$ y una distancia $d$, se estima su tamaño en píxeles. Una frecuencia sólo debe representarse explícitamente cuando cubre un mínimo razonable de píxeles.

Política sugerida:

| Tamaño proyectado | Tratamiento |
|---:|---|
| > 4 px | geometría y normal explícitas |
| 1-4 px | normal filtrada; geometría atenuada |
| 0.25-1 px | varianza de pendientes / roughness |
| < 0.25 px | estadística integrada, sin señal explícita |

La transición debe ser suave y con energía conservada.

### 6.3 Mip chain espectral

Generar por compute una pirámide para cada cascada con:

- pendiente media $E[s_x],E[s_z]$;
- segundo momento $E[s_x^2],E[s_z^2],E[s_xs_z]$;
- espuma promedio/máxima según necesidad;
- opcionalmente desplazamiento filtrado.

A partir de los momentos:

$$
\operatorname{Var}(s_x) = E[s_x^2] - E[s_x]^2
$$

$$
\operatorname{Var}(s_z) = E[s_z^2] - E[s_z]^2
$$

La varianza no resuelta alimenta una distribución anisotrópica de microfacetas o, como primera implementación, una roughness equivalente.

### 6.4 Roughness derivada de energía no resuelta

No usar una roughness fija como fuente principal. Una aproximación inicial:

```ts
const alphaX2 = baseAlphaX * baseAlphaX + unresolvedSlopeVarianceX;
const alphaZ2 = baseAlphaZ * baseAlphaZ + unresolvedSlopeVarianceZ;
const alphaX = sqrt(alphaX2);
const alphaZ = sqrt(alphaZ2);
```

Esto permite que el lóbulo especular:

- sea estrecho en calma;
- se ensanche con viento;
- se vuelva anisotrópico según la dirección;
- permanezca estable a distancia.

### 6.5 Malla oceánica

La malla radial actual es una base válida. Mejoras recomendadas:

- anillos alineados con cámara y horizonte;
- snap del centro a una cuadrícula para reducir swimming del patrón;
- morph entre densidades para evitar popping;
- límite de desplazamiento por ring según Nyquist geométrico;
- culling contra horizonte y frustum en compute o CPU;
- curvatura terrestre opcional si la distancia visible lo requiere;
- skirt o transición con horizonte atmosférico.

Alternativa futura: projected grid o clipmap cartesiano. No es obligatorio cambiar mientras la malla radial se mantenga estable y el LOD espectral sea correcto.

### 6.6 Reglas inmediatas para la implementación actual

Antes de implementar mips completos:

- cascada de 13 m: geometría sólo cerca de 15-25 m;
- normal de cascada pequeña: fade fuerte entre 40 y 120 m;
- cascada media: geometría hasta que su longitud mínima conserve varios vértices por onda;
- cascada grande: no desvanecer antes de que la atmósfera o el horizonte la oculten;
- energía atenuada: convertir provisionalmente en roughness.

Estas reglas son temporales, pero reducen de inmediato la apariencia aceitosa.

---

## 7. Shading físico del agua

### 7.1 Descomposición de radiancia

El color visible debe ser combinación de:

1. reflexión del cielo y nubes;
2. reflexión directa de sol/luna;
3. transmisión/refracción hacia el volumen de agua;
4. radiancia ascendente del volumen por scattering;
5. espuma y burbujas;
6. sombras y oclusión del entorno.

En forma conceptual:

$$
L_o = F L_{reflection} + (1-F)L_{waterVolume} + L_{foam}
$$

### 7.2 Fresnel

Usar IOR del agua cercano a 1.333 y Fresnel físicamente consistente. Schlick es suficiente en tiempo real:

$$
F(\theta)=F_0+(1-F_0)(1-\cos\theta)^5
$$

con:

$$
F_0=\left(\frac{n_1-n_2}{n_1+n_2}\right)^2
$$

No pintar el agua de azul para compensar una reflexión pobre. A ángulos rasantes debe dominar el cielo; mirando hacia abajo debe participar más el volumen.

### 7.3 Reflexión del entorno

Pipeline recomendado:

- cubemap o representación atmosférica actualizada con baja frecuencia;
- reflexión directa de sol/luna analítica de alta intensidad;
- SSR para objetos cercanos, con rechazo de artefactos;
- fallback a environment map cuando SSR falla;
- planar reflection selectiva sólo si el coste lo permite y la escena lo justifica;
- ray tracing futuro únicamente como tier experimental.

El barco debe aparecer en el agua cercana. La ausencia total de reflexión local rompe escala y contacto.

### 7.4 Sun glitter

El brillo solar no debe ser una franja blanca generada por normales sin filtrar. Debe surgir de la distribución de pendientes. La energía de microondas no resuelta determina cuántas microfacetas orientan el reflejo hacia la cámara.

El shader debe usar:

- normal geométrica filtrada;
- distribución anisotrópica de slopes;
- Fresnel;
- masking-shadowing;
- radiancia HDR del sol;
- sombra de nubes;
- exposición y bloom controlados.

La columna de glitter debe concentrarse alrededor de la dirección especular y fragmentarse según roughness y viento.

### 7.5 Color del volumen

No mezclar el albedo directamente con la altura. La altura por sí sola no vuelve verde una cresta. El volumen debe depender de:

- absorción espectral aproximada;
- scattering;
- profundidad visible;
- turbidez;
- ángulo refractado;
- iluminación bajo superficie;
- espuma/burbujas.

Modelo práctico:

```text
transmittance = exp(-absorption * opticalPathLength)
inscatter = scatterColor * (1 - transmittance)
waterVolume = backgroundRefracted * transmittance + inscatter
```

En océano profundo sin fondo visible se usa una profundidad efectiva y radiancia ascendente calibrada, no negro absoluto.

### 7.6 Crestas y transmisión

El glow de cresta puede existir, pero debe estar ligado a:

- espesor aparente;
- orientación respecto del sol;
- curvatura/steepness;
- visibilidad del sol;
- densidad de burbujas.

No debe ser emisivo ambiental permanente. El término actual basado principalmente en altura debe reemplazarse por una aproximación de espesor y backlighting.

### 7.7 Roughness y anti-aliasing especular

La roughness mínima sólo es válida en agua extremadamente calma y cercana. Para mar con viento, el detalle subpixel ensancha el reflejo. Recomendación:

- `roughness` base mínima pequeña;
- sumar varianza espectral no resuelta;
- sumar varianza por lluvia;
- sumar roughness alta en espuma;
- aplicar specular anti-aliasing por variación normal de pantalla.

### 7.8 Atmósfera y horizonte

El agua y el cielo deben compartir:

- exposición;
- sol;
- cubemap;
- niebla;
- aerosol;
- sombras de nube;
- transición crepuscular.

A distancia:

- baja contraste de onda;
- aumenta participación del cielo;
- se reduce saturación;
- la niebla integra agua y horizonte;
- el microdetalle se convierte en BRDF.

---

## 8. Espuma, rompientes y spray

### 8.1 Limitación del espectro lineal

Una FFT espectral representa bien la superficie continua de aguas profundas, pero no cambia topología. No produce por sí sola:

- ola rompiendo físicamente;
- láminas de agua;
- spray volumétrico;
- plunging breakers;
- salpicaduras contra casco.

Estas capas deben ser sistemas complementarios.

### 8.2 Métrica de breaking

Fuentes recomendadas:

- determinante de Jacobiana bajo;
- steepness local alta;
- curvatura de cresta;
- velocidad vertical;
- persistencia temporal;
- viento relativo.

La espuma no debe aparecer por altura absoluta. Debe nacer en zonas de compresión o rompiente.

### 8.3 Espuma oceánica temporal

Campo de espuma:

```text
foam(t+dt) = advect(foam(t), surfaceVelocity)
             * exp(-decay * dt)
             + breakingSource * dt
```

Características:

- advección aproximada con velocidad superficial;
- difusión limitada;
- decaimiento dependiente de tipo de espuma;
- ruido sólo para romper uniformidad, no como fuente primaria;
- múltiples escalas visuales;
- conservación aproximada de cobertura.

Separar:

- whitecaps de mar abierto;
- streaks arrastrados por viento;
- espuma de wake;
- churn de hélice;
- contacto casco-agua.

### 8.4 Material de espuma

La espuma posee:

- alta reflectancia difusa;
- roughness alta;
- menor transmisión;
- sombreado por espesor/cobertura;
- color no completamente blanco;
- borde semitransparente en cobertura baja.

No basta mezclar linealmente un blanco uniforme sobre el agua.

### 8.5 Spray

Tier alto:

- emisión desde métricas de breaking;
- partículas GPU;
- velocidad heredada de la ola y viento;
- lifetime corto;
- tamaño y opacidad variables;
- iluminación atmosférica;
- profundidad y soft particles;
- límite por presupuesto.

El spray es esencial en tormenta, pero no debe usarse para ocultar un campo de olas incorrecto.

---

## 9. Interacción barco-agua y wakes

### 9.1 Estado actual

El repositorio ya posee un campo local 2D con texturas de dinámica y espuma, resoluciones por tier y una región móvil alrededor del barco. Es una base correcta para interacción local.

### 9.2 Separar wake lejano y wake cercano

Un sistema profesional usa dos capas:

1. **Wake analítico/espectral lejano**: patrón Kelvin persistente y barato.
2. **Campo local dinámico**: presión, contacto, hélice, timón, slip y pequeñas reflexiones cerca del casco.

El campo local de 96-128 m no debe ser la única memoria del wake si el barco puede recorrer grandes distancias y el jugador puede mirar atrás.

### 9.3 Wake dependiente de Froude

La forma y apertura visual deben depender de:

$$
Fr = \frac{V}{\sqrt{gL}}
$$

con $V$ velocidad y $L$ eslora característica. La amplitud, longitud de onda dominante y separación de brazos no deben depender sólo de multiplicadores lineales de velocidad.

### 9.4 Presión de casco

Modelo incremental:

- máscara de waterline derivada del casco;
- distribución de presión proa/popa;
- fuentes/sumideros de velocidad superficial;
- emisión barrida entre frame anterior y actual;
- respuesta a pitch, roll y heave;
- energía escalada por velocidad relativa al agua.

### 9.5 Hélice, timón y cavitación

Separar señales:

- churn corto y denso cerca de hélice;
- espuma persistente de wake;
- desviación por timón;
- spray lateral por slip;
- cavitación visual a throttle alto, sin asumir una simulación de burbujas completa.

### 9.6 Persistencia y reproyección

Al mover la región local:

- reproyectar historia en world space;
- resetear sólo ante teletransporte o desplazamiento excesivo;
- usar borde absorbente para evitar reflexión en límites;
- medir pérdida de masa/energía por reproyección;
- mantener dt estable.

### 9.7 Reflejo y contacto

Cerca del casco deben existir:

- reflexión del barco;
- oscurecimiento/oclusiones en waterline;
- espuma de contacto;
- perturbación de normal;
- salpicadura en impactos;
- wetness dinámica en casco como fase posterior.

---

## 10. Física y sincronización con render

### 10.1 Misma superficie, misma fase

La física debe consultar exactamente:

- mismos espectros;
- mismo tiempo;
- mismas semillas;
- mismo choppiness;
- misma interacción local.

No mantener una aproximación Gerstner separada para flotación si la superficie visible es FFT, salvo como fallback documentado.

### 10.2 Muestreo actual y mejoras

El sampler actual lee una grilla 64x64 sobre 256 m y corrige desplazamiento horizontal iterativamente. Es una estrategia válida, pero para el barco conviene un sampler dedicado:

- región menor y mayor resolución alrededor del casco;
- lectura de altura, normal y velocidad;
- triple buffering de readback;
- predicción de uno o dos frames para compensar latencia;
- frecuencia configurable.

### 10.3 Buoyancy por puntos o volumen

MVP profesional:

- 8-24 puntos de flotación distribuidos por casco;
- altura y normal de agua por punto;
- fuerza de flotación amortiguada;
- drag longitudinal y lateral;
- slamming al entrar en agua;
- torque por distribución de fuerzas.

Fase avanzada:

- intersección aproximada de volumen sumergido;
- pressure integration sobre triángulos de casco;
- added mass;
- planing para embarcaciones rápidas.

### 10.4 Velocidad de superficie

Además de altura y normal, conviene exportar velocidad orbital o derivada temporal. Esto mejora:

- drag relativo;
- interacción de cuerda/objetos;
- espuma advectada;
- wake;
- sensación de masa del barco.

### 10.5 Determinismo

El sistema visual puede usar precisión GPU no bit-exacta, pero gameplay debe evitar depender de diferencias mínimas entre dispositivos. Para estados críticos:

- usar sampling suavizado;
- limitar fuerzas máximas;
- mantener integración de barco en CPU;
- registrar seed y estado de mar;
- no requerir determinismo multijugador perfecto de la FFT visual.

---

## 11. Diseño de clases recomendado

```ts
export interface IOceanSpectrumModel {
  buildInitialSpectrum(
    cascade: OceanCascadeDescriptor,
    state: PhysicalSeaState,
    seed: CascadeSeed
  ): GPUTexture;
}

export interface IOceanCascade {
  descriptor: OceanCascadeDescriptor;
  update(timeS: number, dtS: number): void;
  outputs: OceanCascadeOutputs;
  statistics: OceanCascadeStatistics;
}

export interface IOceanLodPolicy {
  evaluate(input: OceanLodInput): OceanLodWeights;
}

export interface IOceanSurfaceSampler {
  sampleHeight(worldX: number, worldZ: number): number | null;
  sampleNormal(worldX: number, worldZ: number): Vec3 | null;
  sampleVelocity(worldX: number, worldZ: number): Vec3 | null;
}

export interface IOceanInteractionLayer {
  update(input: OceanInteractionInput): void;
  getDisplacementTexture(): GPUTexture;
  getFoamTexture(): GPUTexture;
}
```

### 11.1 Descriptor de cascada

```ts
export type OceanCascadeDescriptor = {
  name: "swell" | "windSea" | "chop" | "micro";
  resolution: 128 | 192 | 256 | 512;
  patchSizeM: number;
  band: {
    kMinOuter: number;
    kMinInner: number;
    kMaxInner: number;
    kMaxOuter: number;
  };
  displacementContribution: number;
  normalContribution: number;
  maxChoppiness: number;
  seedOffset: number;
  updateIntervalFrames: number;
};
```

### 11.2 Outputs

```ts
export type OceanCascadeOutputs = {
  displacement: THREE.StorageTexture;
  derivatives0: THREE.StorageTexture;
  derivatives1: THREE.StorageTexture;
  foam: THREE.StorageTexture;
  slopeMomentsMipChain: readonly THREE.Texture[];
};
```

### 11.3 No usar `any` como contrato permanente

TSL obliga a trabajar con nodos dinámicos, pero se recomienda encapsular `NodeRef` en helpers tipados y validar los packings. Los comentarios deben documentar unidad, rango y espacio de cada canal.

---

## 12. Pipeline por frame

Orden recomendado:

1. actualizar tiempo y clima;
2. resolver `PhysicalSeaState` objetivo;
3. avanzar transición espectral;
4. ejecutar espectro inicial sólo cuando sea necesario;
5. evolucionar cada cascada;
6. IFFT horizontal y vertical;
7. ensamblar displacement y derivadas crudas;
8. actualizar mips/momentos según frecuencia del tier;
9. actualizar interacción local del barco;
10. actualizar sampler de física;
11. actualizar atmósfera/environment map según intervalo;
12. render de profundidad;
13. render de nubes;
14. render principal del océano;
15. postprocesado, exposición y bloom;
16. métricas y validaciones.

### 12.1 Frecuencias diferentes

No todo requiere actualización por frame:

| Recurso | Frecuencia sugerida |
|---|---|
| FFT visible | cada frame |
| Cascada de swell muy larga | cada frame o cada 2 frames con interpolación |
| Mips de slope | cada frame o parcial rotativo |
| Cubemap atmosférico | 5-15 Hz según clima |
| Readback de física | 20-60 Hz según barco |
| Estadísticas globales | 1-5 Hz |
| Validaciones costosas | sólo debug |

---

## 13. Presupuestos de calidad y rendimiento

Los siguientes son objetivos de ingeniería, no garantías universales.

### 13.1 Tier high, escritorio WebGPU

Objetivo a 1440p:

- simulación espectral total: 1.0-2.5 ms GPU;
- mips/momentos: 0.2-0.8 ms;
- interacción barco: 0.1-0.5 ms;
- shading del océano: 0.8-2.0 ms según fill rate;
- reflexión adicional: presupuesto separado;
- memoria oceánica: 100-250 MB según formatos y cascadas.

### 13.2 Tier medium

- 3 cascadas de 256;
- entorno 128;
- interaction 192;
- sin spray volumétrico pesado;
- SSR reducido;
- objetivo océano completo: 2-4 ms en GPU media.

### 13.3 Tier low

- 2 cascadas;
- 128/192;
- microdetalle BRDF procedural;
- wake local 128;
- menor resolución de depth/clouds;
- foam simplificada;
- objetivo: estabilidad antes que cantidad de detalle.

### 13.4 Adaptación dinámica

El sistema puede degradar en este orden:

1. frecuencia de environment map;
2. spray;
3. SSR;
4. resolución de interaction field;
5. cascada micro explícita;
6. resolución FFT;
7. densidad de malla.

No reducir primero la cascada de swell principal, porque destruiría silueta y física.

---

## 14. Telemetría y modos de depuración

### 14.1 Métricas obligatorias

- FPS, CPU ms, GPU ms.
- ms por cascada.
- ms FFT horizontal/vertical.
- ms de ensamblado y mips.
- ms de interacción.
- memoria estimada por textura.
- RMS height por cascada.
- RMS slope X/Z.
- altura significativa estimada.
- período pico estimado.
- energía por banda.
- correlación entre cascadas.
- porcentaje con det(J) < 0.5, 0.2 y 0.
- porcentaje de breaking.
- cobertura de espuma.
- LOD/mip seleccionado por distancia.
- readback latency de física.

### 14.2 Modos de visualización

Conservar los actuales y agregar:

- `rawSlope` por cascada;
- `jacobianTerms`;
- `geometryLodWeight`;
- `normalLodWeight`;
- `slopeVariance`;
- `selectedMip`;
- `unresolvedEnergy`;
- `breakingSource`;
- `foamAge`;
- `reflectionSource` (SSR/env/direct sun);
- `waterOpticalDepth`;
- `physicsSampleGrid`.

### 14.3 Capturas de referencia

Escenas fijas:

1. cámara a 1.7 m junto a baranda;
2. cámara a 12 m mirando oblicuo;
3. cámara a 100 m;
4. mediodía con cielo claro;
5. sol bajo frontal;
6. sol bajo lateral;
7. nublado sin sol directo;
8. noche con luna;
9. Beaufort bajo, medio y alto;
10. barco quieto, avance, giro y reversa.

Cada cambio de shader debe compararse con estas capturas.

---

## 15. Pruebas automatizadas

### 15.1 Espectro

- la energía integrada coincide con objetivo dentro de tolerancia;
- `Hs` medido converge al objetivo;
- semillas iguales producen mismo campo;
- semillas de cascadas distintas producen correlación cercana a cero;
- ventanas adyacentes conservan energía;
- no hay discontinuidad en bordes de banda;
- el espectro es finito para `k -> 0` y altas frecuencias.

### 15.2 FFT

- IFFT de señales conocidas;
- impulso y seno de frecuencia única;
- error máximo contra FFT CPU pequeña;
- resultado imaginario residual cercano a cero;
- paridad ping-pong correcta;
- no aparecen NaN tras horas simuladas.

### 15.3 Derivadas

- con choppiness cero, normal analítica coincide con diferencias finitas;
- con choppiness positivo, tangentes cruzadas coinciden con geometría desplazada;
- Jacobiana total coincide con suma numérica;
- no corregir cada cascada produce el resultado esperado de referencia.

### 15.4 LOD

- misma escena a distintas resoluciones mantiene energía visual;
- no hay popping al cruzar anillos;
- shimmering medido disminuye con mips;
- la roughness crece al eliminar frecuencia explícita;
- el horizonte no conserva microondas subpixel.

### 15.5 Física

- sampler coincide con vertex displacement en puntos controlados;
- error de altura menor a tolerancia;
- normal coincide con diferencias finitas;
- latencia de readback registrada;
- barco no recibe impulsos extremos al cambiar de región.

### 15.6 Wakes

- emisión independiente de FPS;
- reproyección conserva historia;
- teletransporte resetea sin residuos;
- wake varía con velocidad y eslora;
- espuma decae de manera reproducible.

---

## 16. Plan de implementación por PR

### PR 1 - Derivadas y normal exacta

**Objetivo:** eliminar la mayor causa del aspecto gelatinoso.

- sacar pendientes corregidas de `OceanFFT`;
- exportar derivadas crudas;
- almacenar términos completos de Jacobiana;
- sumar cascadas antes de reconstruir normal;
- usar tangentes cruzadas o inversa completa;
- agregar prueba contra diferencias finitas;
- limitar choppiness por banda.

**Aceptación:** normal debug estable, sin highlights que se deslizan de forma incoherente; error angular medio contra normal numérica bajo un umbral definido.

### PR 2 - Independencia y overlap de cascadas

- seed global y seed por cascada;
- ventanas de solapamiento;
- perfiles de cascada con resolución independiente;
- cascada grande de 1.5-2 km;
- métrica de correlación y energía.

**Aceptación:** correlación cruzada baja y ausencia de costuras espectrales.

### PR 3 - LOD espectral provisional

- separar contribución de geometría y normal;
- reducir alcance geométrico de cascada pequeña;
- fades basados en tamaño proyectado aproximado;
- energía atenuada convertida en roughness.

**Aceptación:** desaparición del patrón de rayas del horizonte y reducción visible de shimmering.

### PR 4 - Mips de slope moments

- compute reduction;
- media y segundo momento;
- selección de mip;
- roughness anisotrópica;
- debug de varianza y mip.

**Aceptación:** reflejo estable al mover cámara y cambiar resolución.

### PR 5 - Estado de mar físico

- nuevo `PhysicalSeaState`;
- wind sea y swells múltiples;
- normalización por Hs;
- presets coherentes;
- weather como fuente de verdad;
- overrides explícitos.

**Aceptación:** métricas Hs/Tp corresponden al preset y las transiciones no respiran.

### PR 6 - Shading óptico

- eliminar altura -> albedo;
- volumen con absorción/scattering;
- Fresnel consistente;
- sun glitter desde slope variance;
- SSR/fallback de entorno;
- roughness física;
- exposición HDR revisada.

**Aceptación:** agua clara, nublada y nocturna mantienen lectura de agua, no de plástico o petróleo.

### PR 7 - Espuma profesional

- breaking source mejorado;
- textura separada;
- advección y decay;
- whitecaps/streaks;
- material de espuma;
- spray tier alto.

### PR 8 - Wake multiescala

- wake lejano persistente;
- Froude;
- mejora de presión del casco;
- hélice/timón/cavitación;
- reflexión/contacto.

### PR 9 - Física de alta fidelidad

- sampler local de casco;
- velocity sampling;
- buoyancy multipunto;
- drag y slamming;
- telemetría de error.

---

## 17. Cambios concretos por archivo actual

### `src/ocean/simulation/OceanSpectrum.ts`

- agregar seed de cascada;
- reemplazar banda binaria por ventana suave;
- aceptar varios swells;
- aceptar `peakPeriodS` y `significantHeightM`;
- normalizar energía;
- generar estadísticas teóricas;
- documentar unidades de todos los términos.

### `src/ocean/simulation/OceanFFT.ts`

- no producir `correctedSlopeX/Z`;
- exportar derivadas crudas;
- empaquetar Jacobiana completa;
- separar espuma;
- agregar validaciones de NaN;
- preparar salida de velocidad si se requiere.

### `src/ocean/simulation/OceanSimulation.ts`

- descriptor por cascada;
- resolución independiente;
- perfiles low/medium/high;
- doble espectro para transición;
- mips de momentos;
- tiempos por pass;
- pool de texturas.

### `src/ocean/OceanRenderer.ts`

- sumar derivadas crudas;
- reconstruir normal total;
- LOD de geometría y normal separados;
- roughness desde varianza;
- water volume basado en absorción;
- sun glitter coherente;
- reflection fallback;
- eliminar color por altura.

### `src/state/seaState.ts`

- reemplazar `swellAmount` por componentes físicas;
- usar realmente viento y swell del weather;
- definir source/override;
- transiciones por estado.

### `src/ocean/OceanPhysicsSampler.ts`

- exportar normal y velocidad en el mismo readback;
- sampler específico del barco;
- buffers rotativos;
- métricas de latencia y error;
- footprint menor con más resolución.

### `src/ocean/BoatWaterInteraction.ts`

- condiciones de borde absorbentes;
- parametrización por Froude;
- wake lejano separado;
- pressure mask ligada a waterline;
- velocidad relativa al agua;
- advección de espuma;
- persistencia independiente del campo local.

### `src/engine/types.ts` y panel debug

- nuevos modos de render;
- métricas espectrales;
- presets físicos;
- selección de seed;
- control de fuente weather/manual;
- visualización de presupuesto GPU.

---

## 18. Configuración inicial recomendada para corregir el aspecto actual

Mientras se implementan las PR estructurales:

```ts
const temporaryVisualTuning = {
  choppiness: 0.70,
  swellAmountLegacy: 0.10,
  baseRoughness: 0.08,
  smallCascadeGeometryEndM: 22,
  smallCascadeNormalFadeStartM: 40,
  smallCascadeNormalFadeEndM: 120,
  directHeightToAlbedo: 0,
  crestEmissiveMultiplier: 0.25
};
```

Además:

- reducir exposición si el cielo se quema, pero no usar exposición para esconder aliasing;
- comprobar el agua con espuma desactivada;
- comprobar sólo una cascada por vez;
- revisar normal debug antes de material final;
- congelar tiempo para comparar geometría y normal;
- probar sol lateral y nublado, porque exponen errores diferentes.

Estos valores son diagnóstico, no destino final.

---

## 19. Criterios de “terminado” para el océano base

El océano base puede considerarse listo para producción cuando:

- la superficie posee una jerarquía legible de swell, wind sea y microondas;
- no hay repetición evidente en navegación normal;
- no hay correlación visible entre cascadas;
- no hay costuras de banda;
- no hay shimmering significativo en horizonte;
- la normal coincide con la geometría choppy;
- los reflejos responden a cielo, sol y roughness, no a un patrón pintado;
- el color no depende directamente de altura;
- estados de mar tienen Hs/Tp medibles;
- transiciones meteorológicas son suaves;
- el barco consulta la misma superficie;
- wake y espuma reaccionan a movimiento;
- los tiers mantienen la misma dirección artística;
- el coste está instrumentado y dentro del presupuesto;
- las escenas de referencia no presentan regresiones.

---

## 20. Riesgos técnicos

### 20.1 Coste de cuatro cascadas

Mitigación:

- resoluciones distintas;
- cascada grande a menor resolución;
- update interval configurable;
- packing y formatos medidos;
- no ejecutar pasos no usados por tier.

### 20.2 Limitaciones TSL/WebGPU

Mitigación:

- wrappers de nodos;
- tests de shader compilation;
- fallback de formatos;
- evitar dependencia de una sola extensión;
- capturar device lost;
- pipeline warm-up.

### 20.3 Readback físico

Mitigación:

- buffers rotativos;
- regiones pequeñas;
- predicción;
- física robusta a datos antiguos;
- no bloquear GPU.

### 20.4 Cambios visuales difíciles de calibrar

Mitigación:

- métricas físicas;
- escenas fijas;
- seed fijo;
- comparación A/B;
- controles artísticos de alto nivel;
- no exponer constantes internas sin significado.

### 20.5 Océano abierto versus costa

La FFT de aguas profundas no resuelve shoaling, refracción por batimetría ni breaking de playa. Cuando el proyecto incorpore costas realistas, se necesita un sistema híbrido:

- FFT offshore;
- transformación espectral hacia costa;
- shallow-water solver local o ondas guiadas;
- foam/spray específico;
- blending espacial.

No intentar forzar la FFT global para resolver todos los regímenes.

---

## 21. Referencias técnicas

**[R1]** Jerry Tessendorf, *Simulating Ocean Water*, course notes, 1999-2004. Base clásica para síntesis espectral, evolución temporal, choppy waves y óptica del océano.  
https://people.computing.clemson.edu/~jtessen/reports/papers_files/coursenotes2004.pdf

**[R2]** Randima Fernando (editor), Mark Finch, *Effective Water Simulation from Physical Models*, GPU Gems, Chapter 1, NVIDIA, 2004. Útil para separación entre geometría y detalle de normal, suma de ondas y controles de producción.  
https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models

**[R3]** K. Hasselmann et al., *Measurements of Wind-Wave Growth and Swell Decay During the Joint North Sea Wave Project (JONSWAP)*, 1973. Referencia oceanográfica del espectro JONSWAP.

**[R4]** Charles Cox y Walter Munk, *Measurement of the Roughness of the Sea Surface from Photographs of the Sun's Glitter*, Journal of the Optical Society of America, 1954. Referencia para estadística de pendientes y glitter solar.

**[R5]** Bruce Walter, Stephen Marschner, Hongsong Li y Kenneth Torrance, *Microfacet Models for Refraction through Rough Surfaces*, EGSR 2007. Fundamento para reflexión/transmisión microfacet de superficies dieléctricas rugosas.

**[R6]** Three.js WebGPU y TSL, documentación oficial y código de la versión utilizada por el proyecto. Las APIs deben validarse contra la versión fijada en `package.json` antes de implementar cambios de nodos y storage textures.

---

## Apéndice A. Checklist de revisión de una captura

### Geometría

- ¿Se distingue swell de chop?
- ¿Las crestas poseen dirección dominante?
- ¿Hay montículos redondos sin estructura?
- ¿La escala coincide con el barco?
- ¿La silueta de las olas cambia de manera física?

### Reflejos

- ¿El brillo tiene una fuente identificable?
- ¿El sol forma una región de glitter y no ruido global?
- ¿El cielo se refleja de forma coherente?
- ¿El barco aparece cerca?
- ¿Hay parpadeo al mover cámara?

### Color

- ¿Las sombras conservan información?
- ¿El agua parece negra pintada?
- ¿El volumen cambia con ángulo y profundidad?
- ¿Las crestas se colorean sólo por altura?

### Distancia

- ¿El microdetalle desaparece gradualmente?
- ¿La energía pasa a roughness?
- ¿El horizonte se integra con atmósfera?
- ¿Hay moiré o líneas repetidas?

### Interacción

- ¿Existe waterline?
- ¿Hay perturbación local?
- ¿La espuma nace donde corresponde?
- ¿El wake tiene escala y persistencia?

---

## Apéndice B. Definition of Done por PR

Cada PR oceánica debe incluir:

- descripción del cambio físico/visual;
- capturas antes/después con seed y cámara fijos;
- coste GPU/CPU antes/después;
- pruebas unitarias o de compute correspondientes;
- actualización de métricas debug;
- actualización de este documento si cambia el contrato;
- verificación low/medium/high;
- prueba con pausa, cambio de weather, resize y device pixel ratio;
- prueba de 30 minutos sin NaN, drift o crecimiento de memoria.

---

## Apéndice C. Decisiones que no se recomiendan

- Reemplazar FFT por Gerstner como solución general del océano abierto.
- Agregar normal maps de ruido para “tapar” cascadas incorrectas.
- Subir choppiness para obtener dramatismo.
- Mantener microondas geométricas hasta el horizonte.
- Pintar crestas por altura.
- Usar roughness fija para todos los estados de mar.
- Hacer espuma sólo con noise procedural.
- Acoplar el mar a controles debug contradictorios.
- Usar una simulación visual y otra física sin sincronización.
- Optimizar eliminando telemetría antes de estabilizar calidad.

---

**Conclusión:** el repositorio ya posee el núcleo correcto para un océano avanzado. El salto de calidad no depende de agregar más complejidad aleatoria, sino de corregir las derivadas choppy, independizar las cascadas, conservar energía entre geometría y BRDF, unificar el estado de mar y reconstruir el shading desde óptica y estadística de pendientes. La prioridad inmediata es PR 1, PR 2 y PR 3; recién después conviene juzgar el material final.
