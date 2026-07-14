import * as THREE from "three/webgpu";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { Fn, float, fract, positionWorld, smoothstep, texture, uniform, vec4 } from "three/tsl";
import type { DebugSettings, EnvironmentState, QualityTier, WeatherState } from "../engine/types";
import { CloudNoiseTextures } from "./clouds/CloudNoiseTextures";
import { WeatherMap, WEATHER_DOMAIN_METERS } from "./clouds/WeatherMap";
import { CloudShadowMap } from "./clouds/CloudShadowMap";
import { VolumetricCloudPass, CLOUD_QUALITY, type SceneDepthInput } from "./clouds/VolumetricCloudPass";
import { LightningSystem } from "./LightningSystem";
import { directLightMask, twilightFactor } from "./celestialMask";

type NodeRef = any;
type AnyUniform<T> = any & { value: T };

type AtmosphereUpdateOptions = {
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  deltaSeconds: number;
  weather: WeatherState;
  worldTimeHours: number;
  originOffsetMeters: { x: number; z: number };
  timeSeconds: number;
};

const STAR_COUNT = 1200;
const RAIN_COUNT = 3400;

const ZERO_CLOUD_WEATHER: Partial<WeatherState> = {
  cloudCoverage: 0,
  cloudDensity: 0,
  convectivity: 0,
  precipitation: 0,
  stormIntensity: 0
};

/**
 * Physically based sky (Preetham single-scattering via SkyMesh) plus the
 * volumetric cloud stack: 3D noise fields, wind-advected weather map,
 * half-resolution raymarched clouds with temporal accumulation, projected
 * cloud shadows on the ocean, storm lightning, sun/moon lights, stars,
 * exponential fog, rain particles and a dynamic environment cubemap.
 */
export class AtmosphereSystem {
  private readonly scene: THREE.Scene;
  private readonly sky: SkyMesh;
  // Intensity 0 until first update; always visible so WebGPU light pipelines stay sticky across dusk/dawn.
  private readonly sunLight = new THREE.DirectionalLight(0xfff2d0, 0);
  private readonly moonLight = new THREE.DirectionalLight(0x9fb8ff, 0);
  private readonly ambientLight = new THREE.HemisphereLight(0xb9dcff, 0x0d1520, 0.28);
  private readonly moonDisc: THREE.Mesh;
  private readonly moonMaterial: THREE.MeshBasicMaterial;
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly rain: THREE.Points;
  private readonly rainMaterial: THREE.PointsMaterial;
  private readonly envScene = new THREE.Scene();

  // Volumetric cloud stack
  private readonly cloudNoise = new CloudNoiseTextures();
  private readonly weatherMap = new WeatherMap();
  readonly cloudShadows: CloudShadowMap;
  private cloudPass: VolumetricCloudPass;
  private cloudTier: QualityTier = "medium";
  private readonly lightning: LightningSystem;
  private readonly envCloudDome: THREE.Mesh;
  private readonly uEnvCloudCamAbs: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;
  private readonly uEnvCloudBase: AnyUniform<number> = uniform(1200) as any;
  private readonly uEnvCloudColor: AnyUniform<THREE.Color> = uniform(new THREE.Color()) as any;
  private readonly uEnvCloudDensity: AnyUniform<number> = uniform(0.5) as any;
  private readonly uEnvWindOffset: AnyUniform<THREE.Vector2> = uniform(new THREE.Vector2()) as any;

  private cubeRenderTarget: THREE.CubeRenderTarget | null = null;
  private cubeCamera: THREE.CubeCamera | null = null;
  private envMapIntervalMs = 250;
  private lastEnvCaptureMs = -Infinity;
  private settings: DebugSettings | null = null;
  private showSky = true;
  private showRain = true;
  private showClouds = true;
  private cloudsReadyForRender = false;
  private lastCloudMs = 0;
  private canvasWidth = 2;
  private canvasHeight = 2;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.sky = new SkyMesh();
    this.sky.scale.setScalar(30000);
    this.sky.name = "Physically based scattering sky";
    this.sky.frustumCulled = false;
    this.sky.userData.depthPass = "exclude";
    (this.sky.material as any).fog = false;

    this.moonMaterial = new THREE.MeshBasicMaterial({
      color: 0xc7d7ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false
    });
    this.moonDisc = new THREE.Mesh(new THREE.CircleGeometry(58, 48), this.moonMaterial);
    this.moonDisc.name = "Visible moon disc";
    this.moonDisc.frustumCulled = false;
    this.moonDisc.userData.depthPass = "exclude";

    this.starMaterial = new THREE.PointsMaterial({
      color: 0xe7efff,
      size: 8,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false
    });
    this.stars = new THREE.Points(this.createStars(), this.starMaterial);
    this.stars.name = "Deterministic bright star field";
    this.stars.frustumCulled = false;
    this.stars.userData.depthPass = "exclude";

    this.rainMaterial = new THREE.PointsMaterial({
      color: 0xaed7ff,
      size: 0.3,
      transparent: true,
      opacity: 0,
      depthWrite: false
    });
    this.rain = new THREE.Points(this.createRain(), this.rainMaterial);
    this.rain.name = "Camera-centered rain particles";
    this.rain.frustumCulled = false;
    this.rain.userData.depthPass = "exclude";
    // Rain falls below the cloud deck: draw it after the cloud composite so
    // heavy overcast does not attenuate nearby drops.
    this.rain.renderOrder = 10001;

    this.cloudShadows = new CloudShadowMap(this.cloudNoise, this.weatherMap);
    this.cloudPass = new VolumetricCloudPass(this.cloudNoise, this.weatherMap, CLOUD_QUALITY[this.cloudTier]);
    this.lightning = new LightningSystem(scene);
    this.envCloudDome = this.createEnvCloudDome();
    this.envScene.add(this.envCloudDome);

    scene.add(this.sky, this.stars, this.moonDisc, this.rain, this.cloudPass.compositeMesh);
    scene.add(this.sunLight, this.moonLight, this.ambientLight);
    scene.fog = new THREE.FogExp2(0x6f8795, 0.0009);

    // Volumetric clouds replace SkyMesh's built-in 2D cloud layer entirely
    this.sky.cloudCoverage.value = 0;
    this.sky.cloudDensity.value = 0;

    // Persistent celestial lights (intensity 0 when idle) avoid pipeline rebuilds at dusk/dawn.
    this.sunLight.visible = true;
    this.moonLight.visible = true;
    // Per-pixel cloud shadow on everything lit by the sun (the ocean)
    this.sunLight.castShadow = true;
    (this.sunLight.shadow as any).shadowNode = this.createSunShadowNode();
  }

  /** Keep sun/moon in the WebGPU light set; contribution is intensity-only. */
  warmUpCelestialLights(): void {
    this.sunLight.visible = true;
    this.moonLight.visible = true;
  }

  get cloudComputeMs(): number {
    return this.lastCloudMs;
  }

  setEnvironmentQuality(size: number, intervalMs: number): void {
    if (this.cubeRenderTarget && this.cubeRenderTarget.width === size) {
      this.envMapIntervalMs = intervalMs;
      return;
    }

    this.cubeRenderTarget?.dispose();
    this.cubeRenderTarget = new THREE.CubeRenderTarget(size);
    this.cubeRenderTarget.texture.type = THREE.HalfFloatType;
    this.cubeCamera = new THREE.CubeCamera(0.5, 60000, this.cubeRenderTarget);
    this.cubeCamera.position.set(0, 8, 0);
    this.envMapIntervalMs = intervalMs;
    this.lastEnvCaptureMs = -Infinity;
    this.scene.environment = this.cubeRenderTarget.texture;
  }

  setCloudQuality(tier: QualityTier): void {
    if (tier === this.cloudTier) return;
    this.cloudTier = tier;
    this.cloudPass.dispose();
    this.cloudPass = new VolumetricCloudPass(this.cloudNoise, this.weatherMap, CLOUD_QUALITY[tier]);
    this.cloudPass.setSize(this.canvasWidth, this.canvasHeight);
    this.cloudPass.setVisible(this.showSky && this.showClouds);
    this.cloudPass.setDebugMode(this.settings?.atmosphereDebugMode ?? "off");
    this.scene.add(this.cloudPass.compositeMesh);
  }

  resize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.cloudPass.setSize(width, height);
  }

  applySettings(settings: DebugSettings): void {
    this.settings = settings;
    this.showSky = settings.showSky;
    this.showRain = settings.showRain;
    this.showClouds = settings.showClouds;
    this.sky.visible = settings.showSky;
    this.moonDisc.visible = settings.showSky;
    this.stars.visible = settings.showSky;
    this.rain.visible = settings.showRain;
    this.cloudPass.setVisible(settings.showSky && settings.showClouds);
    this.cloudPass.setDebugMode(settings.atmosphereDebugMode);
  }

  update(options: AtmosphereUpdateOptions): EnvironmentState {
    const weather = options.weather;
    const environment = this.computeEnvironment(options);
    const cloudStart = performance.now();

    const sun = new THREE.Vector3(
      environment.celestial.sunDirection.x,
      environment.celestial.sunDirection.y,
      environment.celestial.sunDirection.z
    );
    const moon = new THREE.Vector3(
      environment.celestial.moonDirection.x,
      environment.celestial.moonDirection.y,
      environment.celestial.moonDirection.z
    );

    // Sky shading uniforms
    this.sky.position.copy(options.camera.position);
    this.sky.sunPosition.value.copy(sun);
    const storm = weather.stormIntensity;
    this.sky.turbidity.value = THREE.MathUtils.clamp(
      1.8 + weather.humidity * 3.5 + weather.aerosolDensity * 9 + storm * 6,
      1.5,
      20
    );
    this.sky.rayleigh.value = 1.6 + Math.exp(-Math.abs(sun.y) * 6) * 1.3;
    this.sky.mieCoefficient.value = 0.0045 + weather.aerosolDensity * 0.012 + weather.precipitation * 0.008;
    this.sky.mieDirectionalG.value = 0.8;
    this.sky.cloudCoverage.value = 0;
    this.sky.cloudDensity.value = 0;

    // ------------------------------------------------------ volumetric clouds
    const cloudsEnabled = this.showSky && this.showClouds;
    const cloudWeather = cloudsEnabled ? weather : { ...weather, ...ZERO_CLOUD_WEATHER };
    const cameraAbsX = options.camera.position.x + options.originOffsetMeters.x;
    const cameraAbsZ = options.camera.position.z + options.originOffsetMeters.z;

    this.cloudNoise.ensureGenerated(options.renderer);
    this.weatherMap.update(
      options.renderer,
      cloudWeather,
      options.deltaSeconds,
      options.timeSeconds
    );
    this.cloudShadows.update(
      options.renderer,
      cloudWeather,
      sun.y > -0.05 ? sun : moon,
      this.weatherMap,
      cameraAbsX,
      cameraAbsZ,
      options.originOffsetMeters
    );

    this.lightning.update(options.deltaSeconds, weather, options.camera, cloudsEnabled);
    const flash = this.lightning.flashIntensity;

    if (cloudsEnabled) {
      const daylight = THREE.MathUtils.smoothstep(sun.y, -0.08, 0.42);
      const nightFactor = 1 - daylight;
      const keyIsSun = daylight > 0.04;
      const keyDir = keyIsSun ? sun : moon;
      const keyColor = new THREE.Color(keyIsSun ? environment.sunColor : environment.moonColor);
      const keyIntensity = (keyIsSun
        ? THREE.MathUtils.lerp(0.25, 3.4, daylight)
        : THREE.MathUtils.lerp(0.28, 0.8, environment.celestial.moonVisibility)) *
        (keyIsSun ? environment.celestial.sunDirectMask : environment.celestial.moonDirectMask);

      // Preserve the HDR daytime response, but at night lower the broad sky
      // fill and fog radiance so moonlight — not ambient grey — defines shape.
      const ambientTopScale = THREE.MathUtils.lerp(0.72, 5.2, daylight);
      const ambientBottomScale = THREE.MathUtils.lerp(0.48, 3.4, daylight);
      const fogRadianceScale = THREE.MathUtils.lerp(0.5, 2.2, daylight);
      const ambientTop = new THREE.Color(environment.skyZenithColor)
        .multiplyScalar(ambientTopScale)
        .lerp(new THREE.Color("#07152d"), nightFactor * 0.28);
      const ambientBottom = new THREE.Color(environment.skyHorizonColor)
        .multiplyScalar(ambientBottomScale)
        .lerp(new THREE.Color("#030814"), nightFactor * 0.42);
      const cloudFogColor = new THREE.Color(environment.fogColor)
        .multiplyScalar(fogRadianceScale)
        .lerp(new THREE.Color("#040b19"), nightFactor * 0.38);

      this.cloudPass.updateWeather({
        cloudBaseMeters: weather.cloudBaseMeters,
        cloudThicknessMeters: weather.cloudThicknessMeters,
        cloudDensity: weather.cloudDensity,
        cloudDarkening: weather.cloudDarkening,
        cloudCoverage: weather.cloudCoverage,
        cirrusAmount: weather.cirrusAmount,
        windDirectionRad: weather.windDirectionRad
      });
      // Ambient scaled up to match the Preetham sky's HDR radiance range
      this.cloudPass.updateLighting({
        keyLightDir: keyDir,
        keyLightColor: keyColor,
        keyLightIntensity: keyIntensity,
        nightFactor,
        ambientTop,
        ambientBottom,
        fogColor: cloudFogColor,
        fogDensity: environment.fogDensity
      });
      this.cloudPass.updateLightning(this.lightning.getCloudLights());
    }
    this.cloudsReadyForRender = cloudsEnabled;

    // Lights — contribution fades below the horizon via elevation masks (intensity only; never .visible).
    this.sunLight.position.copy(sun).multiplyScalar(1200);
    this.sunLight.color.set(environment.sunColor);
    this.sunLight.intensity = environment.sunIntensity;
    this.moonLight.position.copy(moon).multiplyScalar(1200);
    this.moonLight.color.set(environment.moonColor);
    this.moonLight.intensity = environment.moonIntensity;
    this.ambientLight.color.set(environment.skyZenithColor);
    this.ambientLight.groundColor.set(environment.fogColor);
    this.ambientLight.intensity = environment.ambientIntensity * 0.35 + flash * 0.5;

    this.sky.showSunDisc.value = environment.celestial.sunDirectMask;

    const moonDiscVis = environment.celestial.moonVisibility * environment.celestial.moonDirectMask;
    this.updateDisc(this.moonDisc, this.moonMaterial, options.camera, moon, moonDiscVis, 7600);
    this.moonDisc.scale.x = THREE.MathUtils.lerp(0.35, 1, Math.sin(environment.celestial.moonPhase * Math.PI));

    this.stars.position.copy(options.camera.position);
    this.stars.rotation.y = (options.worldTimeHours / 24) * Math.PI * 2;
    this.starMaterial.opacity = this.showSky ? environment.celestial.starVisibility : 0;

    const fog = this.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      fog.color.set(environment.fogColor);
      fog.density = environment.fogDensity;
    }

    // Environment cubemap cloud dome (cheap clouds for water reflections)
    this.envCloudDome.visible = cloudsEnabled && weather.cloudCoverage > 0.02;
    this.uEnvWindOffset.value.copy(this.weatherMap.windOffsetMeters);
    this.uEnvCloudCamAbs.value.set(cameraAbsX, cameraAbsZ);
    this.uEnvCloudBase.value = weather.cloudBaseMeters;
    this.uEnvCloudDensity.value = weather.cloudDensity * (0.5 + weather.cloudDarkening * 0.5);
    this.uEnvCloudColor.value
      .set(environment.skyHorizonColor)
      .lerp(new THREE.Color(environment.skyZenithColor), 0.4)
      .multiplyScalar(THREE.MathUtils.lerp(1.05, 0.4, weather.cloudDarkening));

    this.updateRain(options, environment);
    this.updateEnvironmentMap(options.renderer);

    this.lastCloudMs = performance.now() - cloudStart;

    // Lightning flash also lifts the exposure briefly
    return { ...environment, exposure: environment.exposure + flash * 0.14 };
  }

  renderClouds(
    renderer: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    originOffsetMeters: { x: number; z: number },
    sceneDepth: SceneDepthInput | null
  ): void {
    const start = performance.now();
    if (this.cloudsReadyForRender) {
      this.cloudPass.render(renderer, camera, originOffsetMeters, this.weatherMap, sceneDepth);
    }
    this.lastCloudMs += performance.now() - start;
  }

  dispose(): void {
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.moonDisc.geometry.dispose();
    this.moonMaterial.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.rain.geometry.dispose();
    this.rainMaterial.dispose();
    this.cubeRenderTarget?.dispose();
    this.cloudPass.dispose();
    this.cloudShadows.dispose();
    this.weatherMap.dispose();
    this.cloudNoise.dispose();
    this.lightning.dispose();
    this.envCloudDome.geometry.dispose();
    (this.envCloudDome.material as THREE.Material).dispose();
    this.sky.removeFromParent();
    this.moonDisc.removeFromParent();
    this.stars.removeFromParent();
    this.rain.removeFromParent();
    this.sunLight.removeFromParent();
    this.moonLight.removeFromParent();
    this.ambientLight.removeFromParent();
    this.scene.environment = null;
  }

  /**
   * Per-pixel cloud shadow factor multiplied into the sun light's contribution
   * (custom shadow node, no shadow map render pass involved).
   */
  private createSunShadowNode(): NodeRef {
    const cloudShadows = this.cloudShadows;
    return Fn(() => {
      return cloudShadows.sampleShadow(positionWorld.xz);
    })();
  }

  /**
   * Cheap analytic cloud layer for the environment cubemap: projects the
   * weather map coverage onto a dome so water reflections show the actual
   * cloud pattern without raymarching all six cube faces.
   */
  private createEnvCloudDome(): THREE.Mesh {
    const material = new THREE.NodeMaterial();
    material.name = "env-cloud-dome";
    material.side = THREE.BackSide;
    material.transparent = true;
    material.depthWrite = false;
    (material as any).fog = false;

    const weatherTex = texture(this.weatherMap.texture);
    const uCamAbs = this.uEnvCloudCamAbs;
    const uBase = this.uEnvCloudBase;
    const uColor = this.uEnvCloudColor;
    const uDensity = this.uEnvCloudDensity;
    const uWindOffset = this.uEnvWindOffset;

    material.fragmentNode = Fn(() => {
      const dir: NodeRef = positionWorld.normalize().toVar();
      const up = dir.y.max(0.02);
      const dist = uBase.div(up);
      const posAbs = dir.xz.mul(dist).add(uCamAbs);
      const wuv = fract(posAbs.sub(uWindOffset).div(WEATHER_DOMAIN_METERS));
      const weather: NodeRef = weatherTex.sample(wuv);
      const coverage = weather.x;
      const horizonFade = smoothstep(float(0.015), float(0.12), dir.y);
      const alpha: NodeRef = smoothstep(float(0.08), float(0.6), coverage)
        .mul(uDensity.mul(0.75).add(0.25))
        .mul(horizonFade)
        .clamp(0, 0.96);
      return vec4(uColor, alpha);
    })();

    const dome = new THREE.Mesh(new THREE.SphereGeometry(24000, 32, 16), material);
    dome.name = "Environment cloud dome";
    dome.frustumCulled = false;
    return dome;
  }

  /**
   * Captures the sky into the environment cubemap (throttled). The sun disc is
   * hidden during the capture to avoid a hard bright texel in the PMREM chain;
   * the sun contribution comes from the directional light instead.
   */
  private updateEnvironmentMap(renderer: THREE.WebGPURenderer): void {
    if (!this.cubeCamera || !this.cubeRenderTarget) return;

    const now = performance.now();
    if (now - this.lastEnvCaptureMs < this.envMapIntervalMs) return;
    this.lastEnvCaptureMs = now;

    const skyPosition = this.sky.position.clone();
    this.sky.position.set(0, 0, 0);
    this.sky.showSunDisc.value = 0;
    this.envScene.add(this.sky);

    this.cubeCamera.update(renderer as unknown as THREE.Renderer, this.envScene);

    this.sky.showSunDisc.value = 1;
    this.sky.position.copy(skyPosition);
    this.scene.add(this.sky);
    this.cubeRenderTarget.texture.needsPMREMUpdate = true;
  }

  private computeEnvironment(options: AtmosphereUpdateOptions): EnvironmentState {
    const weather = options.weather;
    const sun = this.computeSun(options.worldTimeHours);
    const moon = sun.clone().negate().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.38).normalize();
    const daylight = THREE.MathUtils.smoothstep(sun.y, -0.08, 0.42);
    const twilightGlow = Math.exp(-Math.abs(sun.y) * 8);
    const night = 1 - daylight;
    const cloudShadow = THREE.MathUtils.clamp(
      weather.cloudCoverage * 0.62 + weather.cloudDensity * 0.25 + weather.precipitation * 0.35,
      0,
      0.94
    );
    const storm = THREE.MathUtils.clamp(weather.stormIntensity, 0, 1);
    const exposureBias = this.settings?.exposureBias ?? 0;
    const zenith = new THREE.Color("#061020")
      .lerp(new THREE.Color("#4f95ce"), daylight)
      .lerp(new THREE.Color("#18212b"), cloudShadow * 0.75)
      .lerp(new THREE.Color("#0b0d10"), storm * 0.35);
    const horizon = new THREE.Color("#101b2b")
      .lerp(new THREE.Color("#9cc7df"), daylight)
      .lerp(new THREE.Color("#f0a35e"), twilightGlow * (1 - storm) * 0.55)
      .lerp(new THREE.Color("#5d666b"), cloudShadow * 0.55)
      .lerp(new THREE.Color("#22272b"), storm * 0.55);
    const fogColor = horizon.clone().lerp(new THREE.Color("#8b9292"), weather.humidity * 0.18 + storm * 0.22);
    // The projected cloud shadow map now darkens the sun per-pixel, so the
    // analytic global attenuation is softer than it used to be.
    const sunVisibility = daylight * (1 - cloudShadow * 0.55);
    const moonVisibility = night * (1 - cloudShadow * 0.7);
    const sunDirectMask = directLightMask(sun.y);
    const moonDirectMask = directLightMask(moon.y);
    const twilightResidual = twilightFactor(sun.y);
    const starVisibility = night * (1 - weather.cloudCoverage) * (1 - weather.humidity * 0.35);
    const ambientIntensity = THREE.MathUtils.lerp(0.08, 0.92, daylight) * (1 - cloudShadow * 0.55) + night * 0.07;

    const turbidityMix = THREE.MathUtils.clamp(storm * 0.7 + weather.precipitation * 0.4, 0, 1);
    const absorption = new THREE.Color("#04222e")
      .lerp(new THREE.Color("#0b1519"), turbidityMix)
      .lerp(new THREE.Color("#010b12"), night * 0.8);
    const scatter = new THREE.Color("#0d6a58")
      .lerp(new THREE.Color("#2d4a44"), turbidityMix)
      .lerp(new THREE.Color("#04191f"), night * 0.85);

    return {
      skyZenithColor: `#${zenith.getHexString()}`,
      skyHorizonColor: `#${horizon.getHexString()}`,
      fogColor: `#${fogColor.getHexString()}`,
      fogDensity: THREE.MathUtils.lerp(0.00004, 0.0028, 1 - weather.visibilityKm / 40),
      ambientColor: `#${zenith.clone().lerp(horizon, 0.28).getHexString()}`,
      ambientIntensity,
      sunColor: `#${new THREE.Color("#fff5d0").lerp(new THREE.Color("#ff9f58"), twilightGlow * 0.45).getHexString()}`,
      sunIntensity: THREE.MathUtils.lerp(0, 3.6, sunVisibility * sunDirectMask),
      moonColor: "#b8caff",
      moonIntensity: THREE.MathUtils.lerp(0, 0.36, moonVisibility * moonDirectMask),
      cloudShadow,
      waterAbsorptionColor: `#${absorption.getHexString()}`,
      waterScatterColor: `#${scatter.getHexString()}`,
      exposure: THREE.MathUtils.clamp(1 + exposureBias - cloudShadow * 0.18 + twilightGlow * 0.08, 0.45, 1.6),
      celestial: {
        sunDirection: { x: sun.x, y: sun.y, z: sun.z },
        moonDirection: { x: moon.x, y: moon.y, z: moon.z },
        sunVisibility,
        moonVisibility,
        starVisibility,
        moonPhase: (options.worldTimeHours % 24) / 24,
        sunDirectMask,
        moonDirectMask,
        twilightFactor: twilightResidual
      }
    };
  }

  private updateDisc(
    mesh: THREE.Mesh,
    material: THREE.MeshBasicMaterial,
    camera: THREE.Camera,
    direction: THREE.Vector3,
    visibility: number,
    distance: number
  ): void {
    mesh.position.copy(camera.position).add(direction.clone().multiplyScalar(distance));
    mesh.quaternion.copy(camera.quaternion);
    material.opacity = this.showSky ? THREE.MathUtils.clamp(visibility, 0, 1) : 0;
    mesh.visible = material.opacity > 0.01;
  }

  private createStars(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(STAR_COUNT * 3);
    const rng = mulberry32(0x57a25);

    for (let i = 0; i < STAR_COUNT; i += 1) {
      const theta = rng() * Math.PI * 2;
      const y = rng() * 0.95 + 0.02;
      const radius = Math.sqrt(1 - y * y);
      const index = i * 3;
      const distance = 8300 + rng() * 500;
      positions[index] = Math.cos(theta) * radius * distance;
      positions[index + 1] = y * distance;
      positions[index + 2] = Math.sin(theta) * radius * distance;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geometry;
  }

  private createRain(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(RAIN_COUNT * 3);
    const rng = mulberry32(0x91a1c);

    for (let i = 0; i < RAIN_COUNT; i += 1) {
      const index = i * 3;
      positions[index] = (rng() - 0.5) * 220;
      positions[index + 1] = rng() * 110;
      positions[index + 2] = (rng() - 0.5) * 220;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geometry;
  }

  private computeSun(worldTimeHours: number): THREE.Vector3 {
    const dayAngle = ((worldTimeHours - 6) / 24) * Math.PI * 2;
    const altitude = Math.sin(dayAngle);
    const azimuth = dayAngle + Math.PI * 0.18;
    const horizontal = Math.sqrt(Math.max(0.001, 1 - altitude * altitude));
    return new THREE.Vector3(Math.cos(azimuth) * horizontal, altitude, Math.sin(azimuth) * horizontal).normalize();
  }

  private updateRain(options: AtmosphereUpdateOptions, environment: EnvironmentState): void {
    const precipitation = this.showRain ? options.weather.precipitation : 0;
    this.rain.visible = precipitation > 0.03;
    this.rainMaterial.opacity = precipitation * 0.68;
    this.rainMaterial.color.set(environment.fogColor);
    this.rain.position.copy(options.camera.position);

    if (precipitation <= 0.03) return;

    const fallSpeed = THREE.MathUtils.lerp(36, 82, precipitation);
    const windX = Math.cos(options.weather.windDirectionRad) * options.weather.windSpeedMs * 0.3;
    const windZ = Math.sin(options.weather.windDirectionRad) * options.weather.windSpeedMs * 0.3;
    const positions = this.rain.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = positions.array as Float32Array;

    for (let i = 0; i < RAIN_COUNT; i += 1) {
      const index = i * 3;
      array[index] += windX * options.deltaSeconds;
      array[index + 1] -= fallSpeed * options.deltaSeconds;
      array[index + 2] += windZ * options.deltaSeconds;

      if (array[index + 1] < -12) array[index + 1] += 124;
      if (array[index] > 110) array[index] -= 220;
      if (array[index] < -110) array[index] += 220;
      if (array[index + 2] > 110) array[index + 2] -= 220;
      if (array[index + 2] < -110) array[index + 2] += 220;
    }

    positions.needsUpdate = true;
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
