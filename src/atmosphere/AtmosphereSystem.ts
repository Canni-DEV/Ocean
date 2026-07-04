import * as THREE from "three/webgpu";
import type { DebugSettings, EnvironmentState, WeatherState } from "../engine/types";

type AtmosphereUpdateOptions = {
  camera: THREE.Camera;
  deltaSeconds: number;
  weather: WeatherState;
  worldTimeHours: number;
};

const STAR_COUNT = 1200;
const RAIN_COUNT = 3400;

export class AtmosphereSystem {
  private readonly scene: THREE.Scene;
  private readonly sunLight = new THREE.DirectionalLight(0xfff2d0, 2.4);
  private readonly moonLight = new THREE.DirectionalLight(0x9fb8ff, 0.18);
  private readonly ambientLight = new THREE.HemisphereLight(0xb9dcff, 0x0d1520, 0.75);
  private readonly skySphere: THREE.Mesh;
  private readonly skyColors: Float32Array;
  private readonly skyMaterial: THREE.MeshBasicMaterial;
  private readonly sunDisc: THREE.Mesh;
  private readonly sunMaterial: THREE.MeshBasicMaterial;
  private readonly moonDisc: THREE.Mesh;
  private readonly moonMaterial: THREE.MeshBasicMaterial;
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly rain: THREE.Points;
  private readonly rainMaterial: THREE.PointsMaterial;
  private settings: DebugSettings | null = null;
  private showSky = true;
  private showRain = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    const skyGeometry = new THREE.SphereGeometry(9200, 48, 24);
    const skyPosition = skyGeometry.getAttribute("position") as THREE.BufferAttribute;
    this.skyColors = new Float32Array(skyPosition.count * 3);
    skyGeometry.setAttribute("color", new THREE.BufferAttribute(this.skyColors, 3));
    this.skyMaterial = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexColors: true
    });
    this.skySphere = new THREE.Mesh(skyGeometry, this.skyMaterial);
    this.skySphere.name = "Physically approximated sky gradient";
    this.skySphere.frustumCulled = false;

    this.sunMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff2c6,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      fog: false
    });
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(84, 48), this.sunMaterial);
    this.sunDisc.name = "Visible sun disc";
    this.sunDisc.frustumCulled = false;

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

    scene.add(this.skySphere, this.stars, this.sunDisc, this.moonDisc, this.rain);
    scene.add(this.sunLight, this.moonLight, this.ambientLight);
    scene.fog = new THREE.FogExp2(0x6f8795, 0.0009);
  }

  applySettings(settings: DebugSettings): void {
    this.settings = settings;
    this.showSky = settings.showSky;
    this.showRain = settings.showRain;
    this.skySphere.visible = settings.showSky;
    this.sunDisc.visible = settings.showSky;
    this.moonDisc.visible = settings.showSky;
    this.stars.visible = settings.showSky;
    this.rain.visible = settings.showRain;
  }

  update(options: AtmosphereUpdateOptions): EnvironmentState {
    const weather = options.weather;
    const environment = this.computeEnvironment(options);

    this.scene.background = new THREE.Color(environment.skyHorizonColor);
    this.skySphere.position.copy(options.camera.position);
    this.updateSkyGradient(environment, weather);

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

    this.sunLight.position.copy(sun).multiplyScalar(1200);
    this.sunLight.color.set(environment.sunColor);
    this.sunLight.intensity = environment.sunIntensity;
    this.moonLight.position.copy(moon).multiplyScalar(1200);
    this.moonLight.color.set(environment.moonColor);
    this.moonLight.intensity = environment.moonIntensity;
    this.ambientLight.color.set(environment.skyZenithColor);
    this.ambientLight.groundColor.set(environment.fogColor);
    this.ambientLight.intensity = environment.ambientIntensity;

    this.updateDisc(this.sunDisc, this.sunMaterial, options.camera, sun, environment.celestial.sunVisibility, 7800);
    this.updateDisc(this.moonDisc, this.moonMaterial, options.camera, moon, environment.celestial.moonVisibility, 7600);
    this.moonDisc.scale.x = THREE.MathUtils.lerp(0.35, 1, Math.sin(environment.celestial.moonPhase * Math.PI));

    this.stars.position.copy(options.camera.position);
    this.stars.rotation.y = (options.worldTimeHours / 24) * Math.PI * 2;
    this.starMaterial.opacity = this.showSky ? environment.celestial.starVisibility : 0;

    const fog = this.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      fog.color.set(environment.fogColor);
      fog.density = environment.fogDensity;
    }

    this.updateRain(options, environment);

    return environment;
  }

  dispose(): void {
    this.skySphere.geometry.dispose();
    this.skyMaterial.dispose();
    this.sunDisc.geometry.dispose();
    this.sunMaterial.dispose();
    this.moonDisc.geometry.dispose();
    this.moonMaterial.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.rain.geometry.dispose();
    this.rainMaterial.dispose();
    this.skySphere.removeFromParent();
    this.sunDisc.removeFromParent();
    this.moonDisc.removeFromParent();
    this.stars.removeFromParent();
    this.rain.removeFromParent();
    this.sunLight.removeFromParent();
    this.moonLight.removeFromParent();
    this.ambientLight.removeFromParent();
  }

  private computeEnvironment(options: AtmosphereUpdateOptions): EnvironmentState {
    const weather = options.weather;
    const sun = this.computeSun(options.worldTimeHours);
    const moon = sun.clone().negate().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.38).normalize();
    const daylight = THREE.MathUtils.smoothstep(sun.y, -0.08, 0.42);
    const twilight = Math.exp(-Math.abs(sun.y) * 8);
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
      .lerp(new THREE.Color("#f0a35e"), twilight * (1 - storm) * 0.55)
      .lerp(new THREE.Color("#5d666b"), cloudShadow * 0.55)
      .lerp(new THREE.Color("#22272b"), storm * 0.55);
    const fogColor = horizon.clone().lerp(new THREE.Color("#8b9292"), weather.humidity * 0.18 + storm * 0.22);
    const sunVisibility = daylight * (1 - cloudShadow * 0.86);
    const moonVisibility = night * (1 - cloudShadow * 0.7);
    const starVisibility = night * (1 - weather.cloudCoverage) * (1 - weather.humidity * 0.35);
    const ambientIntensity = THREE.MathUtils.lerp(0.08, 0.92, daylight) * (1 - cloudShadow * 0.55) + night * 0.07;

    return {
      skyZenithColor: `#${zenith.getHexString()}`,
      skyHorizonColor: `#${horizon.getHexString()}`,
      fogColor: `#${fogColor.getHexString()}`,
      fogDensity: THREE.MathUtils.lerp(0.00004, 0.0028, 1 - weather.visibilityKm / 40),
      ambientColor: `#${zenith.clone().lerp(horizon, 0.28).getHexString()}`,
      ambientIntensity,
      sunColor: `#${new THREE.Color("#fff5d0").lerp(new THREE.Color("#ff9f58"), twilight * 0.45).getHexString()}`,
      sunIntensity: THREE.MathUtils.lerp(0.1, 3.2, sunVisibility),
      moonColor: "#b8caff",
      moonIntensity: THREE.MathUtils.lerp(0.02, 0.36, moonVisibility),
      cloudShadow,
      reflectionColor: `#${horizon.clone().lerp(zenith, 0.35).getHexString()}`,
      waterAbsorptionColor: `#${new THREE.Color("#064c66").lerp(new THREE.Color("#11181d"), storm * 0.75).getHexString()}`,
      exposure: THREE.MathUtils.clamp(1 + exposureBias - cloudShadow * 0.18 + twilight * 0.08, 0.55, 1.35),
      celestial: {
        sunDirection: { x: sun.x, y: sun.y, z: sun.z },
        moonDirection: { x: moon.x, y: moon.y, z: moon.z },
        sunVisibility,
        moonVisibility,
        starVisibility,
        moonPhase: (options.worldTimeHours % 24) / 24
      }
    };
  }

  private updateSkyGradient(environment: EnvironmentState, weather: WeatherState): void {
    const geometry = this.skySphere.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    const zenith = new THREE.Color(environment.skyZenithColor);
    const horizon = new THREE.Color(environment.skyHorizonColor);
    const fog = new THREE.Color(environment.fogColor);

    for (let i = 0; i < position.count; i += 1) {
      const y = (position.getY(i) / 9200 + 1) * 0.5;
      const t = THREE.MathUtils.smoothstep(y, 0.36, 0.94);
      const c = horizon.clone().lerp(zenith, t).lerp(fog, weather.aerosolDensity * (1 - t) * 0.38);
      this.skyColors[i * 3] = c.r;
      this.skyColors[i * 3 + 1] = c.g;
      this.skyColors[i * 3 + 2] = c.b;
    }

    color.needsUpdate = true;
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
