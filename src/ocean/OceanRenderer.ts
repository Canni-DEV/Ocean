import * as THREE from "three/webgpu";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  cameraPosition,
  color,
  float,
  mix,
  mx_noise_float,
  positionLocal,
  positionWorld,
  smoothstep,
  uniform,
  vec3
} from "three/tsl";
import type { DebugRenderMode, DebugSettings, EnvironmentState, WeatherState } from "../engine/types";
import { WaveField, type WaveComponent } from "./WaveField";

type OceanRendererOptions = {
  scene: THREE.Scene;
  waveField: WaveField;
};

type AnyUniform<T> = any & { value: T };

type OceanUniformNodes = {
  origin: AnyUniform<THREE.Vector2>;
  time: AnyUniform<number>;
  windDirection: AnyUniform<number>;
  swellDirection: AnyUniform<number>;
  windSpeed: AnyUniform<number>;
  swellStrength: AnyUniform<number>;
  storm: AnyUniform<number>;
  waveScale: AnyUniform<number>;
  roughnessBias: AnyUniform<number>;
  foamIntensity: AnyUniform<number>;
  exposure: AnyUniform<number>;
  cloudShadow: AnyUniform<number>;
  waterAbsorption: AnyUniform<THREE.Color>;
  reflectionColor: AnyUniform<THREE.Color>;
  sunColor: AnyUniform<THREE.Color>;
  moonColor: AnyUniform<THREE.Color>;
  sunDirection: AnyUniform<THREE.Vector3>;
  moonDirection: AnyUniform<THREE.Vector3>;
  sunVisibility: AnyUniform<number>;
  moonVisibility: AnyUniform<number>;
  debugHeight: AnyUniform<number>;
  debugNormal: AnyUniform<number>;
  debugFoam: AnyUniform<number>;
  debugBreaking: AnyUniform<number>;
  debugCurvature: AnyUniform<number>;
  debugDetailNormal: AnyUniform<number>;
  debugRoughness: AnyUniform<number>;
  debugFresnel: AnyUniform<number>;
  debugSlope: AnyUniform<number>;
};

const GRAVITY_MS2 = 9.81;

function u<T>(value: T): AnyUniform<T> {
  return uniform(value as never) as unknown as AnyUniform<T>;
}

export class OceanRenderer {
  private readonly waveField: WaveField;
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: MeshStandardNodeMaterial;
  private readonly uniforms: OceanUniformNodes;
  private visible = true;
  private readonly sizeMeters = 3600;
  private readonly snapMeters = 8;

  constructor(options: OceanRendererOptions) {
    this.waveField = options.waveField;
    this.geometry = new THREE.PlaneGeometry(this.sizeMeters, this.sizeMeters, 420, 420);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.computeBoundingSphere();

    const shader = createWaterMaterial(this.waveField.getComponents());
    this.material = shader.material;
    this.uniforms = shader.uniforms;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "GPU displaced physical ocean";
    this.mesh.frustumCulled = false;
    options.scene.add(this.mesh);
  }

  applySettings(settings: DebugSettings): void {
    this.visible = settings.showOcean;
    this.mesh.visible = this.visible;
    this.material.wireframe = settings.wireframe || settings.renderMode === "wireframe";
    this.setDebugMode(settings.renderMode);
  }

  update(
    camera: THREE.Camera,
    weather: WeatherState,
    environment: EnvironmentState,
    settings: DebugSettings,
    timeSeconds: number
  ): number {
    const start = performance.now();
    const x = Math.round(camera.position.x / this.snapMeters) * this.snapMeters;
    const z = Math.round(camera.position.z / this.snapMeters) * this.snapMeters;
    this.mesh.position.set(x, 0, z);
    this.mesh.visible = this.visible;
    this.waveField.update(weather, settings);
    this.waveField.setOrigin(x, z);
    this.updateUniforms(weather, environment, settings, timeSeconds, x, z);
    return performance.now() - start;
  }

  sample(x: number, z: number, timeSeconds: number) {
    return this.waveField.sample(x, z, timeSeconds);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }

  private updateUniforms(
    weather: WeatherState,
    environment: EnvironmentState,
    settings: DebugSettings,
    timeSeconds: number,
    originX: number,
    originZ: number
  ): void {
    const roughness = THREE.MathUtils.clamp(
      0.18 + weather.precipitation * 0.38 + weather.stormIntensity * 0.3 + settings.waterRoughnessBias,
      0.08,
      0.92
    );

    this.uniforms.origin.value.set(originX, originZ);
    this.uniforms.time.value = timeSeconds;
    this.uniforms.windDirection.value = weather.windDirectionRad;
    this.uniforms.swellDirection.value = weather.swellDirectionRad;
    this.uniforms.windSpeed.value = weather.windSpeedMs;
    this.uniforms.swellStrength.value = weather.swellStrength;
    this.uniforms.storm.value = weather.stormIntensity;
    this.uniforms.waveScale.value = settings.oceanDisplacement ? settings.waveScale : 0;
    this.uniforms.roughnessBias.value = roughness;
    this.uniforms.foamIntensity.value = settings.showFoam ? settings.foamIntensity : 0;
    this.uniforms.exposure.value = environment.exposure;
    this.uniforms.cloudShadow.value = environment.cloudShadow;
    this.uniforms.waterAbsorption.value.set(environment.waterAbsorptionColor);
    this.uniforms.reflectionColor.value.set(environment.reflectionColor);
    this.uniforms.sunColor.value.set(environment.sunColor);
    this.uniforms.moonColor.value.set(environment.moonColor);
    this.uniforms.sunDirection.value.set(
      environment.celestial.sunDirection.x,
      environment.celestial.sunDirection.y,
      environment.celestial.sunDirection.z
    );
    this.uniforms.moonDirection.value.set(
      environment.celestial.moonDirection.x,
      environment.celestial.moonDirection.y,
      environment.celestial.moonDirection.z
    );
    this.uniforms.sunVisibility.value = environment.celestial.sunVisibility;
    this.uniforms.moonVisibility.value = environment.celestial.moonVisibility;
    this.setDebugMode(settings.renderMode);
  }

  private setDebugMode(mode: DebugRenderMode): void {
    this.uniforms.debugHeight.value = mode === "ocean-height" ? 1 : 0;
    this.uniforms.debugNormal.value = mode === "ocean-normal" ? 1 : 0;
    this.uniforms.debugFoam.value = mode === "foam" ? 1 : 0;
    this.uniforms.debugBreaking.value = mode === "breaking" ? 1 : 0;
    this.uniforms.debugCurvature.value = mode === "curvature" ? 1 : 0;
    this.uniforms.debugDetailNormal.value = mode === "detail-normal" ? 1 : 0;
    this.uniforms.debugRoughness.value = mode === "roughness" ? 1 : 0;
    this.uniforms.debugFresnel.value = mode === "fresnel" ? 1 : 0;
    this.uniforms.debugSlope.value = mode === "wave-slope" || mode === "weather" ? 1 : 0;
  }
}

function createWaterMaterial(waves: readonly WaveComponent[]): {
  material: MeshStandardNodeMaterial;
  uniforms: OceanUniformNodes;
} {
  const uniforms: OceanUniformNodes = {
    origin: u(new THREE.Vector2()),
    time: u(0),
    windDirection: u(0),
    swellDirection: u(0),
    windSpeed: u(0),
    swellStrength: u(0),
    storm: u(0),
    waveScale: u(1),
    roughnessBias: u(0.4),
    foamIntensity: u(1),
    exposure: u(1),
    cloudShadow: u(0),
    waterAbsorption: u(new THREE.Color("#07516a")),
    reflectionColor: u(new THREE.Color("#8abbd8")),
    sunColor: u(new THREE.Color("#fff1c2")),
    moonColor: u(new THREE.Color("#b8caff")),
    sunDirection: u(new THREE.Vector3(0, 1, 0)),
    moonDirection: u(new THREE.Vector3(0, 1, 0)),
    sunVisibility: u(1),
    moonVisibility: u(0),
    debugHeight: u(0),
    debugNormal: u(0),
    debugFoam: u(0),
    debugBreaking: u(0),
    debugCurvature: u(0),
    debugDetailNormal: u(0),
    debugRoughness: u(0),
    debugFresnel: u(0),
    debugSlope: u(0)
  };

  const material = new MeshStandardNodeMaterial();
  material.metalness = 0;

  const water = waterNodes(waves, uniforms);
  material.positionNode = positionLocal.add(vec3(water.chopX, water.height, water.chopZ));
  material.normalNode = water.surfaceNormal;
  material.colorNode = water.color;
  material.roughnessNode = water.roughness;

  return { material, uniforms };
}

function waterNodes(waves: readonly WaveComponent[], uniforms: OceanUniformNodes) {
  const origin = uniforms.origin as any;
  const worldX = positionLocal.x.add(origin.x);
  const worldZ = positionLocal.z.add(origin.y);
  let height: any = float(0);
  let slopeX: any = float(0);
  let slopeZ: any = float(0);
  let chopX: any = float(0);
  let chopZ: any = float(0);
  let curvature: any = float(0);
  let crestCompression: any = float(0);

  waves.forEach((wave, index) => {
    const baseDirection = float(wave.directionRad);
    const direction =
      index < 2
        ? uniforms.swellDirection.add(baseDirection)
        : mix(uniforms.windDirection, uniforms.swellDirection, float(0.35)).add(baseDirection);
    const dirX = direction.cos();
    const dirZ = direction.sin();
    const k = float((Math.PI * 2) / wave.wavelengthMeters);
    const omega = float(Math.sqrt(GRAVITY_MS2 * ((Math.PI * 2) / wave.wavelengthMeters)));
    const windSpeedFactor = mix(float(0.9), float(1.18), uniforms.windSpeed.mul(0.036).clamp());
    const phase = worldX.mul(dirX).add(worldZ.mul(dirZ)).mul(k).sub(uniforms.time.mul(omega).mul(windSpeedFactor));
    const s = phase.sin();
    const c = phase.cos();
    const windAmp = mix(float(0.86), float(1.42), uniforms.windSpeed.mul(0.035).clamp());
    const weatherAmp = uniforms.waveScale
      .mul(mix(float(0.72), float(2.18), uniforms.swellStrength))
      .mul(mix(float(0.78), float(1.82), uniforms.storm))
      .mul(windAmp);
    const amplitude = float(wave.amplitudeMeters).mul(weatherAmp);
    const h = s.mul(amplitude);

    height = height.add(h);
    slopeX = slopeX.add(c.mul(amplitude).mul(k).mul(dirX));
    slopeZ = slopeZ.add(c.mul(amplitude).mul(k).mul(dirZ));
    chopX = chopX.add(c.mul(amplitude).mul(float(wave.steepness * 0.34)).mul(dirX));
    chopZ = chopZ.add(c.mul(amplitude).mul(float(wave.steepness * 0.34)).mul(dirZ));

    const crestGate = smoothstep(float(0.72), float(0.97), s);
    const localCurvature = s.max(0).mul(amplitude).mul(k).mul(k).mul(42).clamp();
    const localCompression = amplitude.mul(k).mul(float(wave.steepness)).mul(crestGate).mul(3.4).clamp();
    curvature = curvature.max(localCurvature);
    crestCompression = crestCompression.max(localCompression);
  });

  const detailUv = positionWorld.xz.add(uniforms.time.mul(1.6));
  const windNoise = mx_noise_float(detailUv.mul(0.018));
  const crossNoise = mx_noise_float(positionWorld.xz.sub(uniforms.time.mul(0.9)).mul(0.052));
  const crestDetail = smoothstep(float(0.22), float(0.86), crestCompression.add(curvature.mul(0.6)));
  const weatherDetail = mix(float(0.045), float(0.28), uniforms.storm).mul(uniforms.waveScale);
  height = height.add(windNoise.mul(weatherDetail).mul(crestDetail.mul(0.7).add(0.3))).add(crossNoise.mul(weatherDetail.mul(0.38)));
  const slope = slopeX.mul(slopeX).add(slopeZ.mul(slopeZ)).sqrt().mul(3.4).clamp();
  const rippleA: any = mx_noise_float(detailUv.mul(0.11)).mul(0.5).add(0.5);
  const rippleB: any = mx_noise_float(positionWorld.zx.add(uniforms.time.mul(2.35)).mul(0.31)).mul(0.5).add(0.5);
  const detailStrength = mix(float(0.07), float(0.18), uniforms.storm).mul(uniforms.waveScale.sqrt()).mul(crestDetail.mul(0.75).add(0.55));
  const fineNormalX: any = rippleA.sub(0.5).mul(detailStrength);
  const fineNormalZ: any = rippleB.sub(0.5).mul(detailStrength);
  const detailNormal = vec3(fineNormalX.negate().mul(3.2), float(1), fineNormalZ.negate().mul(3.2)).normalize();
  const surfaceNormal = vec3(slopeX.add(fineNormalX).negate().mul(0.72), float(1), slopeZ.add(fineNormalZ).negate().mul(0.72)).normalize();
  const roughness = uniforms.roughnessBias.add(crestDetail.mul(0.08)).clamp(0.08, 0.95);
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const fresnel = float(1).sub(surfaceNormal.dot(viewDir).max(0)).pow(5).clamp();
  const sunGlint = surfaceNormal.dot(uniforms.sunDirection).max(0).pow(96).mul(uniforms.sunVisibility);
  const moonGlint = surfaceNormal.dot(uniforms.moonDirection).max(0).pow(84).mul(uniforms.moonVisibility);
  const breaking = slope
    .smoothstep(float(0.2), float(0.82))
    .mul(0.42)
    .add(crestCompression.mul(0.48))
    .add(curvature.mul(0.34))
    .add(uniforms.storm.mul(0.18))
    .clamp();
  const foamNoise = mx_noise_float(detailUv.mul(0.19).add(uniforms.time.mul(0.18))).mul(0.5).add(0.5).clamp();
  const foamGrain = smoothstep(float(0.28), float(0.82), foamNoise);
  const foamMask = breaking.mul(uniforms.foamIntensity).mul(foamGrain.mul(0.42).add(0.72)).clamp();

  const deep = color("#063b4d");
  const storm = color("#071016");
  const foamColor = color("#d7eef2");
  const baseWater = mix(uniforms.waterAbsorption, deep, height.mul(0.06).add(0.48).clamp());
  const reflected = uniforms.reflectionColor.mul(float(0.28).add(fresnel.mul(0.82))).mul(float(1).sub(uniforms.cloudShadow.mul(0.35)));
  let finalColor = mix(baseWater, reflected, float(0.1).add(fresnel.mul(0.48)).sub(roughness.mul(0.12)).clamp(0, 0.62));
  finalColor = mix(finalColor, storm, uniforms.storm.mul(0.38));
  finalColor = mix(finalColor, foamColor, foamMask.mul(0.62));
  finalColor = finalColor
    .add(uniforms.sunColor.mul(sunGlint).mul(0.8))
    .add(uniforms.moonColor.mul(moonGlint).mul(0.28))
    .mul(uniforms.exposure);

  const heightDebug = vec3(height.mul(0.08).add(0.5).clamp().mul(0.25), height.mul(0.08).add(0.5).clamp().mul(0.8), float(1));
  const normalDebug = vec3(surfaceNormal.x.mul(0.5).add(0.5), surfaceNormal.y.clamp(), surfaceNormal.z.mul(0.5).add(0.5));
  const detailNormalDebug = vec3(detailNormal.x.mul(0.5).add(0.5), detailNormal.y.clamp(), detailNormal.z.mul(0.5).add(0.5));
  const scalarFoam = vec3(foamMask, foamMask, foamMask);
  const scalarBreaking = vec3(breaking, breaking.mul(0.55), breaking.mul(0.18));
  const scalarCurvature = vec3(curvature, crestCompression, crestDetail);
  const scalarRoughness = vec3(roughness, roughness, roughness);
  const scalarFresnel = vec3(fresnel, fresnel, fresnel);
  const scalarSlope = vec3(slope, uniforms.storm, uniforms.swellStrength);

  finalColor = mix(finalColor, heightDebug, uniforms.debugHeight);
  finalColor = mix(finalColor, normalDebug, uniforms.debugNormal);
  finalColor = mix(finalColor, scalarFoam, uniforms.debugFoam);
  finalColor = mix(finalColor, scalarBreaking, uniforms.debugBreaking);
  finalColor = mix(finalColor, scalarCurvature, uniforms.debugCurvature);
  finalColor = mix(finalColor, detailNormalDebug, uniforms.debugDetailNormal);
  finalColor = mix(finalColor, scalarRoughness, uniforms.debugRoughness);
  finalColor = mix(finalColor, scalarFresnel, uniforms.debugFresnel);
  finalColor = mix(finalColor, scalarSlope, uniforms.debugSlope);

  return { height, chopX, chopZ, roughness, color: finalColor, surfaceNormal };
}
