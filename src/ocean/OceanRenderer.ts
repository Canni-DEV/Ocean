import * as THREE from "three/webgpu";
import {
  Fn,
  cameraPosition,
  cameraProjectionMatrixInverse,
  color,
  depth,
  exp,
  float,
  log2,
  mix,
  mx_noise_float,
  output,
  getViewPosition,
  ivec2,
  positionGeometry,
  positionWorld,
  positionView,
  screenUV,
  smoothstep,
  sqrt,
  step,
  storageTexture,
  texture,
  textureLoad,
  textureSize,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import type { DebugRenderMode, DebugSettings, EnvironmentState, WeatherState } from "../engine/types";
import type { BoatWaterInteraction } from "./BoatWaterInteraction";
import type { OceanSimulation } from "./simulation/OceanSimulation";
import { microSlopeVarianceForWind, precipitationSlopeVariance } from "./simulation/OceanMath";
import { beaufortToWindSpeed } from "../state/seaState";
import { ATLANTIC_DEEP } from "./OceanOpticsProfile";
import { EARTH_RADIUS_M } from "./OceanScreenSpaceMath";
import {
  OceanPhysicalNodeMaterial,
  oceanFoamLighting,
  oceanLightRoles,
  oceanLocalSpecular,
  oceanLocalVolume,
  oceanMoonGlitter,
  oceanSunGlitter
} from "./OceanPhysicalNodeMaterial";

type NodeRef = any;

type OceanRendererOptions = {
  scene: THREE.Scene;
  simulation: OceanSimulation;
  boatInteraction: BoatWaterInteraction | null;
};

export type OceanScreenSpaceInputs = {
  sceneColor: THREE.Texture;
  sceneDepth: THREE.DepthTexture;
  sceneVelocity: THREE.Texture | null;
  sceneNormalRoughness: THREE.Texture | null;
  ssrColor: THREE.Texture | null;
  ssrConfidence: THREE.Texture | null;
  oceanSurfaceDepth: THREE.Texture | null;
  oceanSurfaceNormalRoughness: THREE.Texture | null;
};

type AnyUniform<T> = any & { value: T };
type MutableTextureNode = any & { value: THREE.Texture };

type OceanScreenTextureNodes = {
  sceneColor: MutableTextureNode;
  sceneDepth: MutableTextureNode;
  ssrColor: MutableTextureNode;
};

type OceanUniformNodes = {
  worldOffset: AnyUniform<THREE.Vector2>;
  displacementToggle: AnyUniform<number>;
  foamIntensity: AnyUniform<number>;
  precipitationSlopeVariance: AnyUniform<number>;
  turbidity: AnyUniform<number>;
  time: AnyUniform<number>;
  projectionScale: AnyUniform<number>;
  windDirectionXZ: AnyUniform<THREE.Vector2>;
  windCrossXZ: AnyUniform<THREE.Vector2>;
  microSlopeVariance: AnyUniform<number>;
  ambientColor: AnyUniform<THREE.Color>;
  ambientIntensity: AnyUniform<number>;
  moonAmbientColor: AnyUniform<THREE.Color>;
  moonAmbientIntensity: AnyUniform<number>;
  nightFactor: AnyUniform<number>;
  localScatterGain: AnyUniform<number>;
  phaseG: AnyUniform<number>;
  nightUpwellingGain: AnyUniform<number>;
  sunGlitterGain: AnyUniform<number>;
  moonGlitterGain: AnyUniform<number>;
  localOpticalPathM: AnyUniform<number>;
  iblGain: AnyUniform<number>;
  anisotropyEnabled: AnyUniform<number>;
  slopeMipOverride: AnyUniform<number>;
  ssrEnabled: AnyUniform<number>;
  refractionEnabled: AnyUniform<number>;
  contactEnabled: AnyUniform<number>;
  curvedHorizonEnabled: AnyUniform<number>;
  fogColor: AnyUniform<THREE.Color>;
  skyHorizonColor: AnyUniform<THREE.Color>;
  skyHorizonRadianceScale: AnyUniform<number>;
  fogDensity: AnyUniform<number>;
  boatInteractionOrigin: AnyUniform<THREE.Vector2>;
  boatInteractionSize: AnyUniform<number>;
  boatInteractionUvTexel: AnyUniform<number>;
  boatInteractionCellMeters: AnyUniform<number>;
  boatInteractionEnabled: AnyUniform<number>;
  debugHeight: AnyUniform<number>;
  debugNormal: AnyUniform<number>;
  debugFoam: AnyUniform<number>;
  debugBoatInteraction: AnyUniform<number>;
  debugJacobian: AnyUniform<number>;
  debugSlope: AnyUniform<number>;
  debugRawSlope: AnyUniform<number>;
  debugFilteredSlope: AnyUniform<number>;
  debugSlopeMip: AnyUniform<number>;
  debugSlopeVariance: AnyUniform<number>;
  debugAnisotropy: AnyUniform<number>;
  debugRoughness: AnyUniform<number>;
  debugJacobianTerms: AnyUniform<number>;
  debugGeometryLodWeight: AnyUniform<number>;
  debugNormalLodWeight: AnyUniform<number>;
  debugUnresolvedEnergy: AnyUniform<number>;
  debugCascades: AnyUniform<number>;
  debugFresnel: AnyUniform<number>;
  debugOpticalDepth: AnyUniform<number>;
  debugWaterVolume: AnyUniform<number>;
  debugLocalSpecular: AnyUniform<number>;
  debugLocalVolume: AnyUniform<number>;
  debugLocalLightRoles: AnyUniform<number>;
  debugSunGlitter: AnyUniform<number>;
  debugMoonGlitter: AnyUniform<number>;
  debugAmbientVolume: AnyUniform<number>;
  debugFoamLighting: AnyUniform<number>;
  debugLuminanceHeatmap: AnyUniform<number>;
  debugClippingMask: AnyUniform<number>;
  debugSceneCapture: AnyUniform<number>;
  debugSceneDepth: AnyUniform<number>;
  debugSceneVelocity: AnyUniform<number>;
  debugOceanSurfaceDepth: AnyUniform<number>;
  debugSsrRaw: AnyUniform<number>;
  debugSsrConfidence: AnyUniform<number>;
  debugSsrHistoryWeight: AnyUniform<number>;
  debugReflectionFallback: AnyUniform<number>;
  debugRefraction: AnyUniform<number>;
  debugRefractionValidity: AnyUniform<number>;
  debugContact: AnyUniform<number>;
  debugHorizonBlend: AnyUniform<number>;
};

const MAX_RADIUS_METERS = 80000;

function u<T>(value: T): AnyUniform<T> {
  return uniform(value as never) as unknown as AnyUniform<T>;
}

function createPlaceholderTexture(): THREE.DataTexture {
  const result = new THREE.DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  result.name = "ocean-screen-space-placeholder";
  result.needsUpdate = true;
  return result;
}

/**
 * Builds a camera-centered radial grid: exponentially growing rings so vertex
 * density is high near the camera and low at the horizon.
 */
function buildRadialGrid(rings: number, sectors: number, innerRadius: number): THREE.BufferGeometry {
  const vertexCount = 1 + rings * sectors;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const tangents = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    normals[vertex * 3 + 1] = 1;
    tangents[vertex * 4] = 1;
    tangents[vertex * 4 + 3] = 1;
  }
  const growth = Math.pow(MAX_RADIUS_METERS / innerRadius, 1 / (rings - 1));

  let offset = 3; // vertex 0 is the center
  for (let ring = 0; ring < rings; ring += 1) {
    const radius = innerRadius * Math.pow(growth, ring);
    for (let sector = 0; sector < sectors; sector += 1) {
      const angle = (sector / sectors) * Math.PI * 2;
      positions[offset] = Math.cos(angle) * radius;
      positions[offset + 1] = 0;
      positions[offset + 2] = Math.sin(angle) * radius;
      offset += 3;
    }
  }

  const triangleCount = sectors + (rings - 1) * sectors * 2;
  const indices = new Uint32Array(triangleCount * 3);
  let cursor = 0;

  const ringVertex = (ring: number, sector: number): number => 1 + ring * sectors + (sector % sectors);

  // Winding is counter-clockwise seen from above (+Y) so faces point up.
  for (let sector = 0; sector < sectors; sector += 1) {
    indices[cursor] = 0;
    indices[cursor + 1] = ringVertex(0, sector + 1);
    indices[cursor + 2] = ringVertex(0, sector);
    cursor += 3;
  }

  for (let ring = 0; ring < rings - 1; ring += 1) {
    for (let sector = 0; sector < sectors; sector += 1) {
      const a = ringVertex(ring, sector);
      const b = ringVertex(ring, sector + 1);
      const c = ringVertex(ring + 1, sector);
      const d = ringVertex(ring + 1, sector + 1);
      indices[cursor] = a;
      indices[cursor + 1] = b;
      indices[cursor + 2] = c;
      indices[cursor + 3] = b;
      indices[cursor + 4] = d;
      indices[cursor + 5] = c;
      cursor += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("tangent", new THREE.BufferAttribute(tangents, 4));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * FFT-driven ocean surface with physically based shading: displacement and
 * derivative maps come from the spectral simulation, lighting uses the scene
 * environment (dynamic sky cubemap), filtered GGX facets and deep-water
 * radiance governed by Beer-Lambert extinction.
 */
export class OceanRenderer {
  private readonly simulation: OceanSimulation;
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: OceanPhysicalNodeMaterial;
  private readonly depthMaterial: THREE.NodeMaterial;
  private readonly surfaceDataMaterial: THREE.NodeMaterial;
  private readonly surfaceDataMesh: THREE.Mesh;
  private readonly surfaceDataScene = new THREE.Scene();
  private readonly uniforms: OceanUniformNodes;
  private readonly screenTextures: OceanScreenTextureNodes;
  private readonly placeholderTexture: THREE.DataTexture;
  private readonly foamNodes: NodeRef[];
  private readonly boatInteraction: BoatWaterInteraction | null;
  private readonly boatDynamicsNode: NodeRef | null;
  private readonly boatFoamNode: NodeRef | null;
  private visible = true;

  constructor(options: OceanRendererOptions) {
    this.simulation = options.simulation;
    this.boatInteraction = options.boatInteraction;

    const quality = this.simulation.quality;
    this.geometry = buildRadialGrid(quality.meshRings, quality.meshSectors, quality.meshInnerRadius);

    this.placeholderTexture = createPlaceholderTexture();
    const shader = createWaterMaterial(this.simulation, options.boatInteraction, this.placeholderTexture);
    this.material = shader.material;
    // Bind the same dynamic environment explicitly so the ocean can calibrate
    // nocturnal IBL without changing Scene.environmentIntensity for the boat.
    this.material.envMap = options.scene.environment;
    this.depthMaterial = shader.depthMaterial;
    this.surfaceDataMaterial = shader.surfaceDataMaterial;
    this.uniforms = shader.uniforms;
    this.screenTextures = shader.screenTextures;
    this.foamNodes = shader.foamNodes;
    this.boatDynamicsNode = shader.boatDynamicsNode;
    this.boatFoamNode = shader.boatFoamNode;

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "FFT spectral ocean surface";
    this.mesh.frustumCulled = false;
    // SceneDepthPass uses this lightweight material so cloud composition sees
    // the exact FFT-displaced surface without evaluating the water PBR shader.
    this.mesh.customDepthMaterial = this.depthMaterial;
    // Receives the sun light's custom cloud-shadow node (projected cloud map)
    this.mesh.receiveShadow = true;
    this.mesh.userData.oceanCapture = "exclude";
    options.scene.add(this.mesh);

    this.surfaceDataMesh = new THREE.Mesh(this.geometry, this.surfaceDataMaterial);
    this.surfaceDataMesh.frustumCulled = false;
    this.surfaceDataScene.add(this.surfaceDataMesh);
  }

  renderSurfaceData(renderer: THREE.WebGPURenderer, camera: THREE.Camera, target: THREE.RenderTarget): void {
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    this.surfaceDataMesh.position.copy(this.mesh.position);
    this.surfaceDataMesh.visible = this.mesh.visible;
    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(target);
      renderer.render(this.surfaceDataScene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
  }

  setScreenSpaceInputs(inputs: OceanScreenSpaceInputs): void {
    this.screenTextures.sceneColor.value = inputs.sceneColor;
    // Packed color attachment: RGB view normal, A hardware depth. Sampling a
    // non-MSAA color texture avoids binding a multisampled depth attachment.
    this.screenTextures.sceneDepth.value = inputs.sceneNormalRoughness ?? this.placeholderTexture;
    this.screenTextures.ssrColor.value = inputs.ssrColor ?? this.placeholderTexture;
  }

  applySettings(settings: DebugSettings): void {
    this.visible = settings.showOcean;
    this.mesh.visible = this.visible;
    this.material.wireframe = settings.wireframe || settings.renderMode === "wireframe";
    this.uniforms.anisotropyEnabled.value = settings.oceanAnisotropyEnabled ? 1 : 0;
    this.uniforms.slopeMipOverride.value = settings.oceanSlopeMipOverride;
    this.uniforms.ssrEnabled.value = settings.oceanSsrEnabled ? 1 : 0;
    this.uniforms.refractionEnabled.value = settings.oceanRefractionEnabled ? 1 : 0;
    this.uniforms.contactEnabled.value = settings.oceanContactEnabled ? 1 : 0;
    this.uniforms.curvedHorizonEnabled.value = settings.oceanCurvedHorizonEnabled ? 1 : 0;
    this.setDebugMode(settings.renderMode);
  }

  update(
    camera: THREE.Camera,
    weather: WeatherState,
    environment: EnvironmentState,
    settings: DebugSettings,
    originOffset: { x: number; z: number },
    timeSeconds: number,
    renderHeightPixels: number
  ): void {
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    this.mesh.visible = this.visible;

    // Foam alone is ping-ponged; raw derivative maps keep stable identities.
    this.simulation.cascades.forEach((cascade, index) => {
      this.foamNodes[index].value = cascade.currentFoamTexture;
    });

    this.uniforms.worldOffset.value.set(camera.position.x + originOffset.x, camera.position.z + originOffset.z);
    this.uniforms.displacementToggle.value = settings.oceanDisplacement ? 1 : 0;
    this.uniforms.foamIntensity.value = settings.showFoam ? settings.foamIntensity : 0;
    this.uniforms.precipitationSlopeVariance.value = settings.showRain && settings.oceanSurfacePrecipitationEnabled
      ? precipitationSlopeVariance(weather.precipitation)
      : 0;
    this.uniforms.turbidity.value = settings.waterTurbidity;
    this.uniforms.time.value = timeSeconds;
    const fovRad = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? 60);
    this.uniforms.projectionScale.value = renderHeightPixels / (2 * Math.tan(fovRad * 0.5));
    const windX = Math.cos(weather.windDirectionRad);
    const windZ = Math.sin(weather.windDirectionRad);
    this.uniforms.windDirectionXZ.value.set(windX, windZ);
    this.uniforms.windCrossXZ.value.set(-windZ, windX);
    const effectiveWindSpeed = settings.seaStateControlMode === "manual-overrides"
      ? beaufortToWindSpeed(settings.beaufort)
      : weather.windSpeedMs;
    this.uniforms.microSlopeVariance.value = microSlopeVarianceForWind(effectiveWindSpeed);
    this.uniforms.ambientColor.value.set(environment.ambientColor);
    this.uniforms.ambientIntensity.value = environment.ambientIntensity;
    this.uniforms.moonAmbientColor.value.set(environment.moonColor);
    this.uniforms.moonAmbientIntensity.value = environment.moonIntensity;
    const daylight = THREE.MathUtils.smoothstep(environment.celestial.sunDirection.y, -0.08, 0.42);
    this.uniforms.nightFactor.value = 1 - daylight;
    this.uniforms.localScatterGain.value = settings.oceanLocalScatterGain;
    this.uniforms.phaseG.value = settings.oceanPhaseG;
    this.uniforms.nightUpwellingGain.value = settings.oceanNightUpwellingGain;
    this.uniforms.sunGlitterGain.value = settings.oceanSunGlitterGain;
    this.uniforms.moonGlitterGain.value = settings.oceanMoonGlitterGain;
    this.uniforms.localOpticalPathM.value = settings.oceanLocalOpticalPathM;
    this.uniforms.fogColor.value.set(environment.fogColor);
    this.uniforms.skyHorizonColor.value.set(environment.skyHorizonColor);
    // Match the HDR scale used by AtmosphereSystem's lower sky/cloud ambient.
    // Environment colors are display-like anchors, not scene-linear radiance.
    this.uniforms.skyHorizonRadianceScale.value = THREE.MathUtils.lerp(0.72, 3.4, daylight);
    this.uniforms.fogDensity.value = environment.fogDensity;
    if (this.boatInteraction && this.boatDynamicsNode && this.boatFoamNode) {
      const interaction = this.boatInteraction.sampleState;
      this.boatDynamicsNode.value = interaction.dynamicsTexture;
      this.boatFoamNode.value = interaction.foamTexture;
      this.uniforms.boatInteractionOrigin.value.copy(interaction.origin);
      this.uniforms.boatInteractionSize.value = interaction.sizeMeters;
      this.uniforms.boatInteractionUvTexel.value = 1 / interaction.resolution;
      this.uniforms.boatInteractionCellMeters.value = interaction.sizeMeters / interaction.resolution;
      this.uniforms.boatInteractionEnabled.value =
        settings.boatWaterInteraction && interaction.enabled ? 1 : 0;
    } else {
      this.uniforms.boatInteractionEnabled.value = 0;
    }
    const iblMask = Math.max(daylight, environment.celestial.twilightFactor);
    this.uniforms.iblGain.value =
      THREE.MathUtils.lerp(ATLANTIC_DEEP.nightIblIntensity, ATLANTIC_DEEP.dayIblIntensity, iblMask)
      * (1 - weather.cloudCoverage * 0.5);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.surfaceDataMaterial.dispose();
    this.placeholderTexture.dispose();
    this.mesh.removeFromParent();
  }

  private setDebugMode(mode: DebugRenderMode): void {
    this.uniforms.debugHeight.value = mode === "height" ? 1 : 0;
    this.uniforms.debugNormal.value = mode === "normal" ? 1 : 0;
    this.uniforms.debugFoam.value = mode === "foam" ? 1 : 0;
    this.uniforms.debugBoatInteraction.value = mode === "boatInteraction" ? 1 : 0;
    this.uniforms.debugJacobian.value = mode === "jacobian" ? 1 : 0;
    this.uniforms.debugSlope.value = mode === "slope" ? 1 : 0;
    this.uniforms.debugRawSlope.value = mode === "rawSlope" ? 1 : 0;
    this.uniforms.debugFilteredSlope.value = mode === "filteredSlope" ? 1 : 0;
    this.uniforms.debugSlopeMip.value = mode === "slopeMip" ? 1 : 0;
    this.uniforms.debugSlopeVariance.value = mode === "slopeVariance" ? 1 : 0;
    this.uniforms.debugAnisotropy.value = mode === "anisotropy" ? 1 : 0;
    this.uniforms.debugRoughness.value = mode === "roughness" ? 1 : 0;
    this.uniforms.debugJacobianTerms.value = mode === "jacobianTerms" ? 1 : 0;
    this.uniforms.debugGeometryLodWeight.value = mode === "geometryLodWeight" ? 1 : 0;
    this.uniforms.debugNormalLodWeight.value = mode === "normalLodWeight" ? 1 : 0;
    this.uniforms.debugUnresolvedEnergy.value = mode === "unresolvedEnergy" ? 1 : 0;
    this.uniforms.debugCascades.value = mode === "cascades" ? 1 : 0;
    this.uniforms.debugFresnel.value = mode === "fresnel" ? 1 : 0;
    this.uniforms.debugOpticalDepth.value = mode === "opticalDepth" ? 1 : 0;
    this.uniforms.debugWaterVolume.value = mode === "waterVolume" ? 1 : 0;
    this.uniforms.debugLocalSpecular.value = mode === "localSpecular" ? 1 : 0;
    this.uniforms.debugLocalVolume.value = mode === "localVolume" ? 1 : 0;
    this.uniforms.debugLocalLightRoles.value = mode === "localLightRoles" ? 1 : 0;
    this.uniforms.debugSunGlitter.value = mode === "sunGlitter" ? 1 : 0;
    this.uniforms.debugMoonGlitter.value = mode === "moonGlitter" ? 1 : 0;
    this.uniforms.debugAmbientVolume.value = mode === "ambientVolume" ? 1 : 0;
    this.uniforms.debugFoamLighting.value = mode === "foamLighting" ? 1 : 0;
    this.uniforms.debugLuminanceHeatmap.value = mode === "luminanceHeatmap" ? 1 : 0;
    this.uniforms.debugClippingMask.value = mode === "clippingMask" ? 1 : 0;
    this.uniforms.debugSceneCapture.value = mode === "sceneCapture" ? 1 : 0;
    this.uniforms.debugSceneDepth.value = mode === "sceneDepth" ? 1 : 0;
    this.uniforms.debugSceneVelocity.value = mode === "sceneVelocity" ? 1 : 0;
    this.uniforms.debugOceanSurfaceDepth.value = mode === "oceanSurfaceDepth" ? 1 : 0;
    this.uniforms.debugSsrRaw.value = mode === "ssrRaw" ? 1 : 0;
    this.uniforms.debugSsrConfidence.value = mode === "ssrConfidence" ? 1 : 0;
    this.uniforms.debugSsrHistoryWeight.value = mode === "ssrHistoryWeight" ? 1 : 0;
    this.uniforms.debugReflectionFallback.value = mode === "reflectionFallback" ? 1 : 0;
    this.uniforms.debugRefraction.value = mode === "refraction" ? 1 : 0;
    this.uniforms.debugRefractionValidity.value = mode === "refractionValidity" ? 1 : 0;
    this.uniforms.debugContact.value = mode === "contact" ? 1 : 0;
    this.uniforms.debugHorizonBlend.value = mode === "horizonBlend" ? 1 : 0;
  }
}

function createWaterMaterial(
  simulation: OceanSimulation,
  boatInteraction: BoatWaterInteraction | null,
  placeholderTexture: THREE.Texture
): {
  material: OceanPhysicalNodeMaterial;
  depthMaterial: THREE.NodeMaterial;
  surfaceDataMaterial: THREE.NodeMaterial;
  uniforms: OceanUniformNodes;
  screenTextures: OceanScreenTextureNodes;
  foamNodes: NodeRef[];
  boatDynamicsNode: NodeRef | null;
  boatFoamNode: NodeRef | null;
} {
  const screenTextures: OceanScreenTextureNodes = {
    sceneColor: texture(placeholderTexture) as MutableTextureNode,
    sceneDepth: texture(placeholderTexture) as MutableTextureNode,
    ssrColor: texture(placeholderTexture).setSampler(false) as MutableTextureNode
  };
  const uniforms: OceanUniformNodes = {
    worldOffset: u(new THREE.Vector2()),
    displacementToggle: u(1),
    foamIntensity: u(1),
    precipitationSlopeVariance: u(0),
    turbidity: u(0.25),
    time: u(0),
    projectionScale: u(720),
    windDirectionXZ: u(new THREE.Vector2(1, 0)),
    windCrossXZ: u(new THREE.Vector2(0, 1)),
    microSlopeVariance: u(0.012),
    ambientColor: u(new THREE.Color("#89a8b8")),
    ambientIntensity: u(1),
    moonAmbientColor: u(new THREE.Color("#b8caff")),
    moonAmbientIntensity: u(0),
    nightFactor: u(0),
    localScatterGain: u(ATLANTIC_DEEP.localScatterGain),
    phaseG: u(ATLANTIC_DEEP.localPhaseG),
    nightUpwellingGain: u(ATLANTIC_DEEP.upwellingNight),
    sunGlitterGain: u(1),
    moonGlitterGain: u(1),
    localOpticalPathM: u(ATLANTIC_DEEP.localOpticalPathM),
    iblGain: u(1),
    anisotropyEnabled: u(1),
    slopeMipOverride: u(-1),
    ssrEnabled: u(1),
    refractionEnabled: u(1),
    contactEnabled: u(1),
    curvedHorizonEnabled: u(1),
    fogColor: u(new THREE.Color("#7f929d")),
    skyHorizonColor: u(new THREE.Color("#9cc7df")),
    skyHorizonRadianceScale: u(3.4),
    fogDensity: u(0.00004),
    boatInteractionOrigin: u(new THREE.Vector2()),
    boatInteractionSize: u(1),
    boatInteractionUvTexel: u(1 / 128),
    boatInteractionCellMeters: u(1),
    boatInteractionEnabled: u(0),
    debugHeight: u(0),
    debugNormal: u(0),
    debugFoam: u(0),
    debugBoatInteraction: u(0),
    debugJacobian: u(0),
    debugSlope: u(0),
    debugRawSlope: u(0),
    debugFilteredSlope: u(0),
    debugSlopeMip: u(0),
    debugSlopeVariance: u(0),
    debugAnisotropy: u(0),
    debugRoughness: u(0),
    debugJacobianTerms: u(0),
    debugGeometryLodWeight: u(0),
    debugNormalLodWeight: u(0),
    debugUnresolvedEnergy: u(0),
    debugCascades: u(0),
    debugFresnel: u(0),
    debugOpticalDepth: u(0),
    debugWaterVolume: u(0),
    debugLocalSpecular: u(0),
    debugLocalVolume: u(0),
    debugLocalLightRoles: u(0),
    debugSunGlitter: u(0),
    debugMoonGlitter: u(0),
    debugAmbientVolume: u(0),
    debugFoamLighting: u(0),
    debugLuminanceHeatmap: u(0),
    debugClippingMask: u(0),
    debugSceneCapture: u(0),
    debugSceneDepth: u(0),
    debugSceneVelocity: u(0),
    debugOceanSurfaceDepth: u(0),
    debugSsrRaw: u(0),
    debugSsrConfidence: u(0),
    debugSsrHistoryWeight: u(0),
    debugReflectionFallback: u(0),
    debugRefraction: u(0),
    debugRefractionValidity: u(0),
    debugContact: u(0),
    debugHorizonBlend: u(0)
  };

  const cascades = simulation.cascades;
  const displacementNodes = cascades.map((cascade) => texture(cascade.displacementTexture));
  const slopeMoment0Nodes = cascades.map((cascade) => texture(cascade.slopeMomentTexture0));
  const slopeMoment1Nodes = cascades.map((cascade) => texture(cascade.slopeMomentTexture1));
  const foamNodes = cascades.map((cascade) => texture(cascade.foamTextures[0]));
  // Boat interaction fields are native StorageTexture instances. Reading them
  // as storage bindings releases two fragment samplers without changing their
  // compute ownership or wake/foam contents.
  const boatDynamicsNode = boatInteraction
    ? storageTexture(boatInteraction.currentDynamicsTexture).toReadOnly()
    : null;
  const boatFoamNode = boatInteraction
    ? storageTexture(boatInteraction.currentFoamTexture).toReadOnly()
    : null;
  const loadScreenTexture = (node: MutableTextureNode, uvNode: NodeRef): NodeRef => {
    const size = textureSize(textureLoad(node));
    const texel = (ivec2 as any)(uvNode.mul(size)).clamp((ivec2 as any)(0), (ivec2 as any)(size).sub(1));
    return textureLoad(node, texel);
  };
  const loadScreenTextureBilinear = (node: MutableTextureNode, uvNode: NodeRef): NodeRef => {
    const size = textureSize(textureLoad(node));
    const pixel = uvNode.mul(size).sub(0.5);
    const base = pixel.floor();
    const fraction = pixel.fract();
    const maxTexel = (ivec2 as any)(size).sub(1);
    const load = (offset: NodeRef): NodeRef => {
      const texel = (ivec2 as any)(base.add(offset)).clamp((ivec2 as any)(0), maxTexel);
      return textureLoad(node, texel);
    };
    const row0 = mix(load(vec2(0, 0)), load(vec2(1, 0)), fraction.x);
    const row1 = mix(load(vec2(0, 1)), load(vec2(1, 1)), fraction.x);
    return mix(row0, row1, fraction.y);
  };
  const loadBoatInteraction = (node: NodeRef, uvNode: NodeRef): NodeRef => {
    const resolution = boatInteraction?.resolution ?? 1;
    const texel = (ivec2 as any)(uvNode.mul(resolution)).clamp((ivec2 as any)(0), (ivec2 as any)(resolution - 1));
    return node.load(texel).toReadOnly();
  };

  const boatInteractionUvAndMask = (worldXZ: NodeRef, uvOffset: NodeRef = vec2(0, 0)): { uv: NodeRef; mask: NodeRef } => {
    const uv = worldXZ.sub(uniforms.boatInteractionOrigin).div(uniforms.boatInteractionSize).add(uvOffset);
    const mask = step(float(0), uv.x)
      .mul(step(uv.x, float(1)))
      .mul(step(float(0), uv.y))
      .mul(step(uv.y, float(1)))
      .mul(uniforms.boatInteractionEnabled);
    return { uv, mask };
  };

  const sampleBoatDynamics = (worldXZ: NodeRef, uvOffset: NodeRef = vec2(0, 0)): NodeRef => {
    if (!boatDynamicsNode) return vec4(0, 0, 0, 0);

    const sample = boatInteractionUvAndMask(worldXZ, uvOffset);
    return loadBoatInteraction(boatDynamicsNode, sample.uv).mul(sample.mask);
  };

  const sampleBoatFoam = (worldXZ: NodeRef): NodeRef => {
    if (!boatFoamNode) return vec4(0, 0, 0, 0);

    const sample = boatInteractionUvAndMask(worldXZ);
    return loadBoatInteraction(boatFoamNode, sample.uv).mul(sample.mask);
  };

  const material = new OceanPhysicalNodeMaterial();
  material.metalness = 0;
  material.ior = 1.333;
  material.envMapIntensity = 1;
  material.fog = false;

  // Direct sun specular from scene lights is gated by sunDirectMask on the CPU;
  // SSS and IBL are masked here so no ghost column appears below the horizon.

  // ------------------------------------------------------------------ vertex
  const sampleXZ = positionGeometry.xz.add(uniforms.worldOffset);
  // The mesh follows camera XZ, so positionGeometry.xz is the horizontal
  // separation. Altitude must still participate or aerial views retain all
  // high-frequency geometry as if the camera were on the water surface.
  const cameraDistance = sqrt(
    positionGeometry.x.mul(positionGeometry.x)
      .add(positionGeometry.z.mul(positionGeometry.z))
      .add(cameraPosition.y.mul(cameraPosition.y))
  );

  let displacement: NodeRef = vec3(0, 0, 0);
  cascades.forEach((cascade, index) => {
    const uv = sampleXZ.div(cascade.config.patchSize);
    const projectedPixels = float(cascade.config.representativeWavelength)
      .mul(uniforms.projectionScale)
      .div(cameraDistance.max(0.01));
    const geometryWeight = smoothstep(float(2), float(4), projectedPixels);
    const sampleNode = (displacementNodes[index] as any).sample(uv).level(float(0));
    displacement = displacement.add(sampleNode.xyz.mul(geometryWeight));
  });
  displacement = displacement.mul(uniforms.displacementToggle);
  const boatInteractionVertex = sampleBoatDynamics(sampleXZ);
  const boatInteractionMask = boatInteractionUvAndMask(sampleXZ).mask;
  displacement = displacement.add(
    vec3(0, boatInteractionVertex.r, 0).mul(uniforms.displacementToggle)
  );

  const horizontalDistance = positionGeometry.xz.length();
  const curvatureBlend = smoothstep(float(2000), float(5000), horizontalDistance)
    .mul(uniforms.curvedHorizonEnabled);
  const curvatureDrop = horizontalDistance.mul(horizontalDistance)
    .div(2 * EARTH_RADIUS_M)
    .mul(curvatureBlend);
  const displacedPosition = positionGeometry.add(displacement).sub((vec3 as any)(0, curvatureDrop, 0));
  material.positionNode = displacedPosition;

  const depthMaterial = new THREE.NodeMaterial();
  depthMaterial.name = "FFT spectral ocean depth";
  depthMaterial.colorWrite = false;
  depthMaterial.depthTest = true;
  depthMaterial.depthWrite = true;
  depthMaterial.positionNode = displacedPosition;
  depthMaterial.fragmentNode = vec4(0, 0, 0, 1);

  const vHeight: NodeRef = vertexStage(displacement.y);
  const vSampleXZ: NodeRef = vertexStage(sampleXZ);
  // Fog integrates along the horizontal water path. Keeping camera altitude in
  // the LOD distance is correct, but using it for the fragment varying caused
  // the horizon path to collapse to zero on the camera-centred radial mesh.
  const vDistance: NodeRef = vertexStage(horizontalDistance);
  const vHorizonBlend: NodeRef = vertexStage(curvatureBlend);
  const vBoatInteraction: NodeRef = vertexStage(boatInteractionVertex);
  const vBoatInteractionMask: NodeRef = vertexStage(boatInteractionMask);

  // ---------------------------------------------------------------- fragment
  let rawSlope: NodeRef = vec2(0, 0);
  let filteredSlope: NodeRef = vec2(0, 0);
  let dXdX: NodeRef = float(0);
  let dXdZ: NodeRef = float(0);
  let dZdX: NodeRef = float(0);
  let dZdZ: NodeRef = float(0);
  let foamRaw: NodeRef = float(0);
  let varianceX: NodeRef = float(0);
  let varianceZ: NodeRef = float(0);
  let unresolvedSlopeVariance: NodeRef = float(0);
  let selectedMip: NodeRef = float(0);
  let geometryLodWeight: NodeRef = float(0);
  let normalLodWeight: NodeRef = float(0);
  let jacobianTermsDebug: NodeRef = vec3(0, 0, 0);
  let cascadeDebug: NodeRef = vec3(0, 0, 0);

  cascades.forEach((cascade, index) => {
    const uv = vSampleXZ.div(cascade.config.patchSize);
    const momentBase0 = (slopeMoment0Nodes[index] as any).sample(uv).level(float(0));
    const momentBase1 = (slopeMoment1Nodes[index] as any).sample(uv).level(float(0));
    const foam = (foamNodes[index] as any).sample(uv).level(float(0));
    const projectedPixels = float(cascade.config.representativeWavelength)
      .mul(uniforms.projectionScale)
      .div(vDistance.max(0.01));
    const geometryWeight = smoothstep(float(2), float(4), projectedPixels);
    const normalWeight = smoothstep(float(0.75), float(2), projectedPixels);
    const footprintX = uv.dFdx().mul(cascade.config.resolution).length();
    const footprintY = uv.dFdy().mul(cascade.config.resolution).length();
    const automaticMomentMip = log2(footprintX.max(footprintY).max(1))
      .clamp(0, cascade.slopeMomentMipCount - 1);
    const overrideEnabled = step(float(0), uniforms.slopeMipOverride);
    const momentMip = mix(
      automaticMomentMip,
      uniforms.slopeMipOverride.clamp(0, cascade.slopeMomentMipCount - 1),
      overrideEnabled
    );
    const moments0 = (slopeMoment0Nodes[index] as any).sample(uv).level(momentMip);
    const meanSlope = moments0.xy;
    const localVarianceX = moments0.z.sub(moments0.x.mul(moments0.x)).max(0);
    const localVarianceZ = moments0.w.sub(moments0.y.mul(moments0.y)).max(0);
    const lambda = simulation.uniforms.choppiness
      .mul(cascade.config.choppinessScale)
      .clamp(0, cascade.config.choppinessLimit);

    rawSlope = rawSlope.add(momentBase0.xy.mul(normalWeight));
    filteredSlope = filteredSlope.add(meanSlope.mul(normalWeight));
    // Horizontal Jacobian terms must follow the displaced geometry. Keeping
    // choppy derivatives after geometry has faded creates an oily folded normal.
    dXdX = dXdX.add(momentBase1.y.mul(lambda).mul(geometryWeight));
    dZdZ = dZdZ.add(momentBase1.z.mul(lambda).mul(geometryWeight));
    dXdZ = dXdZ.add(momentBase1.w.mul(lambda).mul(geometryWeight));
    dZdX = dZdX.add(momentBase1.w.mul(lambda).mul(geometryWeight));
    foamRaw = foamRaw.max(foam.x.mul(normalWeight.mul(0.4).add(0.6)));
    // The selected moment mip already stores both the mean slope and the
    // second moment over its complete texel footprint. Adding the cascade's
    // global slope variance here counted the same filtered energy twice.
    varianceX = varianceX.add(localVarianceX);
    varianceZ = varianceZ.add(localVarianceZ);
    unresolvedSlopeVariance = unresolvedSlopeVariance.add(localVarianceX.add(localVarianceZ).mul(0.5));
    selectedMip = selectedMip.add(momentMip.div(Math.max(cascade.slopeMomentMipCount - 1, 1)).div(cascades.length));
    geometryLodWeight = geometryLodWeight.add(geometryWeight.div(cascades.length));
    normalLodWeight = normalLodWeight.add(normalWeight.div(cascades.length));
    jacobianTermsDebug = jacobianTermsDebug.add(
      vec3(momentBase1.y.abs(), momentBase1.w.abs(), momentBase1.z.abs()).mul(geometryWeight.div(cascades.length))
    );

    const channel = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)][index] as NodeRef;
    cascadeDebug = cascadeDebug.add(channel.mul(momentBase0.xy.length().mul(normalWeight)));
  });

  let slope: NodeRef = filteredSlope;

  // Cox-Munk energy is a statistical facet distribution. It belongs entirely
  // in the covariance/BRDF and must never become a coherent normal-map stripe.
  const coxWindVariance = uniforms.microSlopeVariance.mul(0.65);
  const coxCrossVariance = uniforms.microSlopeVariance.mul(0.35);
  varianceX = varianceX
    .add(uniforms.windDirectionXZ.x.mul(uniforms.windDirectionXZ.x).mul(coxWindVariance))
    .add(uniforms.windCrossXZ.x.mul(uniforms.windCrossXZ.x).mul(coxCrossVariance));
  varianceZ = varianceZ
    .add(uniforms.windDirectionXZ.y.mul(uniforms.windDirectionXZ.y).mul(coxWindVariance))
    .add(uniforms.windCrossXZ.y.mul(uniforms.windCrossXZ.y).mul(coxCrossVariance));
  // Moment variance remains spatially filtered for roughness, but its local
  // eigenvector must not drive material anisotropy: bilinear interpolation of
  // E[sx], E[sz] and second moments produces texel-sized orientation changes
  // that appear as rectangular reflection patches. Keep the variances
  // non-negative and use the statistically stable wind frame below.
  varianceX = varianceX.max(0);
  varianceZ = varianceZ.max(0);

  const interactionTexel = uniforms.boatInteractionUvTexel;
  const interactionCell = uniforms.boatInteractionCellMeters.mul(2);
  const interactionLeft = sampleBoatDynamics(vSampleXZ, vec2(interactionTexel.negate(), 0));
  const interactionRight = sampleBoatDynamics(vSampleXZ, vec2(interactionTexel, 0));
  const interactionDown = sampleBoatDynamics(vSampleXZ, vec2(0, interactionTexel.negate()));
  const interactionUp = sampleBoatDynamics(vSampleXZ, vec2(0, interactionTexel));
  const interactionSlope = vec2(
    interactionRight.r.sub(interactionLeft.r).div(interactionCell),
    interactionUp.r.sub(interactionDown.r).div(interactionCell)
  );
  slope = slope.add(interactionSlope.mul(uniforms.displacementToggle));

  const tangentX = vec3(float(1).add(dXdX), slope.x, dZdX);
  const tangentZ = vec3(dXdZ, slope.y, float(1).add(dZdZ));
  const worldNormal = tangentZ.cross(tangentX).normalize();
  const jacobianTotal = float(1).add(dXdX).mul(float(1).add(dZdZ)).sub(dXdZ.mul(dZdX));

  // Foam: temporal accumulation from the simulation plus separate boat sources.
  const boatFoam = sampleBoatFoam(vSampleXZ);
  const boatFoamWeighted = boatFoam.r.mul(0.9).max(boatFoam.g).max(boatFoam.b.mul(0.9));
  const foamGrain = mx_noise_float(vSampleXZ.mul(0.9)).mul(0.5).add(0.5);
  // Static world-space breakup only. An independently animated grain slid
  // across the FFT and read as a second, non-physical surface flow.
  const foamGrainFine = mx_noise_float(vSampleXZ.mul(3.7).add(vec2(17.3, -8.1))).mul(0.5).add(0.5);
  const oceanFoamAmount = foamRaw
    .mul(uniforms.foamIntensity)
    .mul(foamGrain.mul(0.45).add(0.62))
    .mul(foamGrainFine.mul(0.35).add(0.72))
    .clamp(0, 1);
  const boatFoamAmount = boatFoamWeighted
    .mul(uniforms.foamIntensity)
    .mul(foamGrain.mul(0.3).add(0.78))
    .mul(foamGrainFine.mul(0.24).add(0.82))
    .clamp(0, 1);
  const foamAmount = oceanFoamAmount.max(boatFoamAmount);
  const foamBlend = smoothstep(float(0.12), float(0.62), oceanFoamAmount)
    .max(smoothstep(float(0.055), float(0.46), boatFoamAmount));

  const foamColor = color(ATLANTIC_DEEP.foamColor);

  // The water body has no diffuse blue paint. Its visible energy is the GGX
  // environment/sun reflection plus the deep-water volume below.
  material.colorNode = foamColor.mul(foamBlend);
  material.normalNode = transformNormalToView(worldNormal);

  const normalDx = worldNormal.dFdx();
  const normalDy = worldNormal.dFdy();
  const screenVariance = normalDx.dot(normalDx)
    .add(normalDy.dot(normalDy))
    .mul(0.25)
    .clamp(0, 0.08);
  const totalVariance = varianceX.add(varianceZ).mul(0.5)
    .add(screenVariance)
    .add(uniforms.precipitationSlopeVariance)
    .max(0);
  const alphaSquared = float(Math.pow(ATLANTIC_DEEP.waterRoughnessMin ** 2, 2)).add(totalVariance.mul(0.22));
  const waterRoughness = alphaSquared.pow(0.25)
    .clamp(ATLANTIC_DEEP.waterRoughnessMin, ATLANTIC_DEEP.waterRoughnessMax);
  material.roughnessNode = mix(waterRoughness, float(ATLANTIC_DEEP.foamRoughness), foamBlend);

  // Cox-Munk directionality is a stable, world-space statistical property.
  // A subtle wind-aligned lobe keeps highlights polished without imprinting
  // the stochastic FFT/mip texel grid into the reflection.
  const coxDirectionality = coxWindVariance.sub(coxCrossVariance).abs()
    .div(coxWindVariance.add(coxCrossVariance).max(0.0001));
  const windAnisotropyConfidence = smoothstep(float(0.006), float(0.04), uniforms.microSlopeVariance);
  const anisotropyStrength: NodeRef = coxDirectionality
    .mul(windAnisotropyConfidence)
    .mul(0.12)
    .clamp(0, 0.04)
    .mul(uniforms.anisotropyEnabled)
    .mul(float(1).sub(foamBlend));
  const anisotropyDirection = uniforms.windDirectionXZ.normalize();
  material.anisotropyNode = anisotropyDirection.mul(anisotropyStrength);
  material.specularIntensityNode = mix(float(1), float(0.35), foamBlend);

  // ATLANTIC_DEEP: Snell refraction, Beer-Lambert extinction and single-scatter
  // upwelling. Fresnel reflection itself remains in MeshPhysicalNodeMaterial.
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const cosIncident = worldNormal.dot(viewDir).max(0.001).clamp(0, 1);
  const f0Value = ((ATLANTIC_DEEP.ior - 1) / (ATLANTIC_DEEP.ior + 1)) ** 2;
  const f0 = float(f0Value);
  const fresnel = f0.add(float(1).sub(f0).mul(float(1).sub(cosIncident).pow(5))).clamp(0, 1);
  const eta = float(1 / 1.333);
  const sinTransmittedSquared = float(1).sub(cosIncident.mul(cosIncident)).mul(eta.mul(eta));
  const cosTransmitted = sqrt(float(1).sub(sinTransmittedSquared).max(0.0001));
  const absorption = mix(
    vec3(...ATLANTIC_DEEP.absorptionBase),
    vec3(...ATLANTIC_DEEP.absorptionTurbid),
    uniforms.turbidity
  );
  const scattering = mix(
    vec3(...ATLANTIC_DEEP.scatteringBase),
    vec3(...ATLANTIC_DEEP.scatteringTurbid),
    uniforms.turbidity
  );
  const effectiveDepth = mix(
    float(ATLANTIC_DEEP.effectiveDepthBaseM),
    float(ATLANTIC_DEEP.effectiveDepthTurbidM),
    uniforms.turbidity
  );
  const opticalPath = effectiveDepth.div(cosTransmitted.max(0.15));
  const extinction = absorption.add(scattering);
  const transmittance = exp(extinction.mul(opticalPath).negate());
  const scatteringAlbedo = scattering.div(extinction.max(0.0001));
  const lunarSkyRadiance = uniforms.moonAmbientColor
    .mul(uniforms.moonAmbientIntensity)
    .mul(float(ATLANTIC_DEEP.lunarSkyIrradianceFactor));
  const ambientRadiance = uniforms.ambientColor
    .mul(uniforms.ambientIntensity)
    .add(lunarSkyRadiance);
  const upwellingGain = mix(
    float(ATLANTIC_DEEP.upwellingDay),
    uniforms.nightUpwellingGain,
    uniforms.nightFactor
  );
  const waterVolume = ambientRadiance
    .mul(scatteringAlbedo)
    .mul(vec3(1, 1, 1).sub(transmittance))
    .mul(upwellingGain);

  // Scene refraction is valid only where an opaque capture lies behind the
  // water fragment. Open ocean therefore keeps the calibrated deep-water
  // upwelling instead of refracting the sky or inventing a seabed.
  const viewNormal = transformNormalToView(worldNormal).normalize();
  const directSceneDepth = loadScreenTexture(screenTextures.sceneDepth, screenUV).a;
  const directSceneView = getViewPosition(screenUV, directSceneDepth, cameraProjectionMatrixInverse);
  const directThickness = positionView.z.sub(directSceneView.z).max(0);
  const distortionScale = directThickness.div(positionView.z.abs().max(1)).mul(0.035).clamp(0, 0.025);
  const refractedUv = screenUV.add(viewNormal.xy.mul(distortionScale));
  const sceneSample = loadScreenTexture(screenTextures.sceneColor, refractedUv);
  const refractedDepth = loadScreenTexture(screenTextures.sceneDepth, refractedUv).a;
  const refractedView = getViewPosition(refractedUv, refractedDepth, cameraProjectionMatrixInverse);
  const sceneThickness = positionView.z.sub(refractedView.z);
  const uvValid = step(float(0.002), refractedUv.x)
    .mul(step(refractedUv.x, float(0.998)))
    .mul(step(float(0.002), refractedUv.y))
    .mul(step(refractedUv.y, float(0.998)));
  const thicknessValid = smoothstep(float(0.002), float(0.05), sceneThickness)
    .mul(float(1).sub(smoothstep(float(6.8), float(8), sceneThickness)));
  const refractionValidity = sceneSample.a
    .mul(uvValid)
    .mul(thicknessValid)
    .mul(uniforms.refractionEnabled)
    .mul(float(1).sub(foamBlend));
  const sceneOpticalPath = sceneThickness.max(0).min(8).div(cosTransmitted.max(0.15));
  const sceneTransmittance = exp(extinction.mul(sceneOpticalPath).negate());
  const refractedVolume = sceneSample.rgb.mul(sceneTransmittance)
    .add(ambientRadiance.mul(scatteringAlbedo).mul(vec3(1).sub(sceneTransmittance)).mul(upwellingGain));
  const contactAmount = float(1).sub(smoothstep(float(0), float(0.35), sceneThickness.max(0)))
    .mul(float(1).sub(smoothstep(float(20), float(45), vDistance)))
    .mul(0.25)
    .mul(sceneSample.a)
    .mul(uniforms.contactEnabled);
  const resolvedWaterVolume = mix(waterVolume, refractedVolume, refractionValidity)
    .mul(float(1).sub(contactAmount));
  const ambientVolume = resolvedWaterVolume
    .mul(float(1).sub(fresnel))
    .mul(float(1).sub(foamBlend));
  material.emissiveNode = ambientVolume;

  const surfaceDataMaterial = new THREE.NodeMaterial();
  surfaceDataMaterial.name = "FFT ocean surface data";
  surfaceDataMaterial.positionNode = displacedPosition;
  surfaceDataMaterial.depthTest = true;
  surfaceDataMaterial.depthWrite = true;
  // Pack normal XY + roughness + hardware depth into a sampleable color
  // attachment; the target depth texture remains render-only.
  surfaceDataMaterial.fragmentNode = (vec4 as any)(
    viewNormal.x.mul(0.5).add(0.5),
    viewNormal.y.mul(0.5).add(0.5),
    waterRoughness,
    depth
  );

  // The SSR target is unfilterable Float32 so it does not allocate a seventeenth
  // sampler. Four explicit loads restore bilinear reconstruction at half/quarter
  // resolution and remove the block grid visible with nearest reads.
  const ssrSample = loadScreenTextureBilinear(screenTextures.ssrColor, screenUV);
  const ssrConfidenceSample = ssrSample.a
    .mul(uniforms.ssrEnabled)
    .mul(float(1).sub(foamBlend))
    // Retain some environment response even for nominally perfect hits. This
    // prevents very dark hull texels from becoming black punched-out patches.
    .mul(0.72);
  material.setOceanLightingContext({
    foamBlend,
    foamColor,
    extinction,
    scatteringAlbedo,
    fresnel,
    localOpticalPath: opticalPath.min(uniforms.localOpticalPathM),
    localScatterGain: uniforms.localScatterGain,
    phaseG: uniforms.phaseG,
    sunGlitterGain: uniforms.sunGlitterGain,
    moonGlitterGain: uniforms.moonGlitterGain,
    iblGain: uniforms.iblGain,
    ssrRadiance: ssrSample.rgb,
    ssrConfidence: ssrConfidenceSample,
    celestialAngularRadiusRad: THREE.MathUtils.degToRad(ATLANTIC_DEEP.celestialAngularRadiusDeg),
    f0: f0Value
  });

  // ------------------------------------------------------------- debug views
  const fresnelDebug = fresnel;
  const debugColor = Fn(() => {
    let result: NodeRef = vec3(0, 0, 0);
    const heightVis = vHeight.mul(0.14).add(0.5).clamp(0, 1);
    result = result.add(vec3(heightVis.mul(0.2), heightVis.mul(0.65), heightVis).mul(uniforms.debugHeight));
    result = result.add(worldNormal.mul(0.5).add(0.5).mul(uniforms.debugNormal));
    result = result.add(vec3(foamAmount, foamAmount, foamAmount).mul(uniforms.debugFoam));
    const positiveBoatHeight = vBoatInteraction.r.max(0).mul(4).clamp(0, 1);
    const negativeBoatHeight = vBoatInteraction.r.negate().max(0).mul(4).clamp(0, 1);
    const boatInteractionDebug = vec3(positiveBoatHeight, interactionSlope.length().mul(2).clamp(0, 1), negativeBoatHeight)
      .mul(vBoatInteractionMask)
      .add(vec3(boatFoam.r, boatFoam.g, boatFoam.b).mul(0.7));
    result = result.add(boatInteractionDebug.mul(uniforms.debugBoatInteraction));
    const jacobianVis = jacobianTotal.mul(0.5).clamp(0, 1);
    result = result.add(vec3(float(1).sub(jacobianVis), jacobianVis, jacobianVis.mul(0.4)).mul(uniforms.debugJacobian));
    const slopeVis = slope.length().mul(1.4).clamp(0, 1);
    result = result.add(vec3(slopeVis, slopeVis.mul(0.6), slopeVis.mul(0.2)).mul(uniforms.debugSlope));
    const rawSlopeVis = rawSlope.length().mul(1.4).clamp(0, 1);
    result = result.add(vec3(rawSlopeVis, rawSlopeVis.mul(0.6), rawSlopeVis.mul(0.2)).mul(uniforms.debugRawSlope));
    const filteredSlopeVis = filteredSlope.length().mul(1.4).clamp(0, 1);
    result = result.add(vec3(filteredSlopeVis.mul(0.2), filteredSlopeVis.mul(0.75), filteredSlopeVis)
      .mul(uniforms.debugFilteredSlope));
    result = result.add(vec3(selectedMip, selectedMip.mul(0.25), float(1).sub(selectedMip))
      .mul(uniforms.debugSlopeMip));
    const varianceVis = sqrt(totalVariance).mul(3).clamp(0, 1);
    result = result.add(vec3(varianceVis, varianceVis.mul(0.45), float(1).sub(varianceVis))
      .mul(uniforms.debugSlopeVariance));
    const anisotropyVis = vec3(
      anisotropyDirection.x.mul(0.5).add(0.5),
      anisotropyStrength,
      anisotropyDirection.y.mul(0.5).add(0.5)
    );
    result = result.add(anisotropyVis.mul(uniforms.debugAnisotropy));
    result = result.add(vec3(waterRoughness).mul(uniforms.debugRoughness));
    result = result.add(jacobianTermsDebug.mul(2).clamp(0, 1).mul(uniforms.debugJacobianTerms));
    result = result.add(vec3(geometryLodWeight).mul(uniforms.debugGeometryLodWeight));
    result = result.add(vec3(normalLodWeight).mul(uniforms.debugNormalLodWeight));
    const unresolvedVis = sqrt(unresolvedSlopeVariance).mul(3).clamp(0, 1);
    result = result.add(vec3(unresolvedVis, unresolvedVis.mul(0.45), 0).mul(uniforms.debugUnresolvedEnergy));
    result = result.add(cascadeDebug.mul(2).clamp(0, 1).mul(uniforms.debugCascades));
    result = result.add(vec3(fresnelDebug, fresnelDebug, fresnelDebug).mul(uniforms.debugFresnel));
    const opticalDepthVis = opticalPath.div(24).clamp(0, 1);
    result = result.add(vec3(opticalDepthVis, opticalDepthVis.mul(0.55), float(1).sub(opticalDepthVis))
      .mul(uniforms.debugOpticalDepth));
    result = result.add(ambientVolume.add(oceanLocalVolume).mul(5).clamp(0, 1).mul(uniforms.debugWaterVolume));
    result = result.add(oceanLocalSpecular.mul(2).clamp(0, 1).mul(uniforms.debugLocalSpecular));
    result = result.add(oceanLocalVolume.mul(5).clamp(0, 1).mul(uniforms.debugLocalVolume));
    result = result.add(oceanLightRoles.clamp(0, 1).mul(uniforms.debugLocalLightRoles));
    result = result.add(oceanSunGlitter.mul(2).clamp(0, 1).mul(uniforms.debugSunGlitter));
    result = result.add(oceanMoonGlitter.mul(8).clamp(0, 1).mul(uniforms.debugMoonGlitter));
    result = result.add(ambientVolume.mul(5).clamp(0, 1).mul(uniforms.debugAmbientVolume));
    result = result.add(oceanFoamLighting.mul(2).clamp(0, 1).mul(uniforms.debugFoamLighting));
    const outputLuminance = output.rgb.dot(vec3(0.2126, 0.7152, 0.0722));
    const heat = vec3(
      smoothstep(float(0), float(0.18), outputLuminance),
      smoothstep(float(0.08), float(0.65), outputLuminance),
      smoothstep(float(0.45), float(1), outputLuminance)
    );
    result = result.add(heat.mul(uniforms.debugLuminanceHeatmap));
    const clipped = step(float(1), output.r.max(output.g).max(output.b));
    result = result.add(vec3(clipped, 0, 0).mul(uniforms.debugClippingMask));
    const captureDebug = loadScreenTexture(screenTextures.sceneColor, screenUV);
    const sceneDepthDebug = loadScreenTexture(screenTextures.sceneDepth, screenUV).a;
    const sceneVelocityDebug = vec2(0);
    const surfaceDepthDebug = float(0);
    result = result.add(captureDebug.rgb.mul(uniforms.debugSceneCapture));
    result = result.add(vec3(sceneDepthDebug).mul(uniforms.debugSceneDepth));
    result = result.add(vec3(sceneVelocityDebug.mul(8).add(0.5), 0).mul(uniforms.debugSceneVelocity));
    result = result.add(vec3(surfaceDepthDebug).mul(uniforms.debugOceanSurfaceDepth));
    result = result.add(ssrSample.rgb.mul(uniforms.debugSsrRaw));
    result = result.add(vec3(ssrConfidenceSample).mul(uniforms.debugSsrConfidence));
    result = result.add(vec3(ssrSample.a)
      .mul(uniforms.debugSsrHistoryWeight));
    result = result.add(vec3(float(1).sub(ssrConfidenceSample), 0, ssrConfidenceSample)
      .mul(uniforms.debugReflectionFallback));
    result = result.add(refractedVolume.mul(uniforms.debugRefraction));
    result = result.add(vec3(refractionValidity).mul(uniforms.debugRefractionValidity));
    result = result.add((vec3 as any)(contactAmount, contactAmount.mul(0.45), 0).mul(uniforms.debugContact));
    return result;
  })();

  const debugBlend = uniforms.debugHeight
    .add(uniforms.debugNormal)
    .add(uniforms.debugFoam)
    .add(uniforms.debugBoatInteraction)
    .add(uniforms.debugJacobian)
    .add(uniforms.debugSlope)
    .add(uniforms.debugRawSlope)
    .add(uniforms.debugFilteredSlope)
    .add(uniforms.debugSlopeMip)
    .add(uniforms.debugSlopeVariance)
    .add(uniforms.debugAnisotropy)
    .add(uniforms.debugRoughness)
    .add(uniforms.debugJacobianTerms)
    .add(uniforms.debugGeometryLodWeight)
    .add(uniforms.debugNormalLodWeight)
    .add(uniforms.debugUnresolvedEnergy)
    .add(uniforms.debugCascades)
    .add(uniforms.debugFresnel)
    .add(uniforms.debugOpticalDepth)
    .add(uniforms.debugWaterVolume)
    .add(uniforms.debugLocalSpecular)
    .add(uniforms.debugLocalVolume)
    .add(uniforms.debugLocalLightRoles)
    .add(uniforms.debugSunGlitter)
    .add(uniforms.debugMoonGlitter)
    .add(uniforms.debugAmbientVolume)
    .add(uniforms.debugFoamLighting)
    .add(uniforms.debugLuminanceHeatmap)
    .add(uniforms.debugClippingMask)
    .add(uniforms.debugSceneCapture)
    .add(uniforms.debugSceneDepth)
    .add(uniforms.debugSceneVelocity)
    .add(uniforms.debugOceanSurfaceDepth)
    .add(uniforms.debugSsrRaw)
    .add(uniforms.debugSsrConfidence)
    .add(uniforms.debugSsrHistoryWeight)
    .add(uniforms.debugReflectionFallback)
    .add(uniforms.debugRefraction)
    .add(uniforms.debugRefractionValidity)
    .add(uniforms.debugContact)
    .add(uniforms.debugHorizonBlend)
    .clamp(0, 1);
  const fogOpticalDepth = uniforms.fogDensity.mul(vDistance);
  const physicalFog = float(1).sub(exp(fogOpticalDepth.mul(fogOpticalDepth).negate()));
  // Converge only at grazing angles. A distance-only blend washed out large
  // top-down areas and produced an independent grey strip at deck height.
  const geometricHorizonDistance = sqrt(
    cameraPosition.y.max(1).mul(2 * EARTH_RADIUS_M)
  );
  const distanceToHorizon = smoothstep(
    geometricHorizonDistance.mul(0.2),
    geometricHorizonDistance.mul(0.65),
    vDistance
  );
  // Vertex distance is deliberately coarse on the radial far rings. The
  // per-fragment view elevation closes the remaining sub-ring at the tangent
  // without affecting top-down water.
  const grazingHorizon = float(1).sub(
    smoothstep(float(0.01), float(0.1), viewDir.y.abs())
  );
  // Distance to the geometric tangent is the authoritative convergence term.
  // vHorizonBlend only describes where render curvature is fully active; using
  // it as a multiplier left the pre-tangent fog texels stranded at fogColor.
  const horizonConvergence = distanceToHorizon
    .max(grazingHorizon)
    .max(vHorizonBlend.mul(smoothstep(float(0.05), float(0.4), fresnel)))
    .clamp(0, 1);
  const horizonBlend = physicalFog.max(horizonConvergence).clamp(0, 1);
  const outputLuma = output.rgb.dot(vec3(0.2126, 0.7152, 0.0722));
  const desaturated = (mix as any)(output.rgb, (vec3 as any)(outputLuma), physicalFog.mul(0.22));
  const grazingFogTarget = (mix as any)(
    uniforms.fogColor,
    uniforms.skyHorizonColor.mul(uniforms.skyHorizonRadianceScale),
    distanceToHorizon.max(smoothstep(float(0.08), float(0.62), fresnel))
  );
  const fogIntegrated = (mix as any)(desaturated, grazingFogTarget, physicalFog);
  // The procedural sky is HDR while EnvironmentState colors are display-like.
  // Use the same day/night radiance scale as the atmosphere so the tangent
  // water texel converges continuously instead of forming a grey strip.
  const horizonIntegrated = (mix as any)(
    fogIntegrated,
    uniforms.skyHorizonColor.mul(uniforms.skyHorizonRadianceScale),
    horizonConvergence
  );
  const finalOutput = vec4(horizonIntegrated, output.a);
  const horizonDebug = vec4(vec3(horizonBlend), 1);
  const withDebug = mix(finalOutput, vec4(debugColor, 1), debugBlend);
  material.outputNode = mix(withDebug, horizonDebug, uniforms.debugHorizonBlend);

  return {
    material,
    depthMaterial,
    surfaceDataMaterial,
    uniforms,
    screenTextures,
    foamNodes,
    boatDynamicsNode,
    boatFoamNode
  };
}
