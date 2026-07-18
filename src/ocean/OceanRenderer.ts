import * as THREE from "three/webgpu";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import {
  Fn,
  atan,
  cameraPosition,
  color,
  cos,
  exp,
  float,
  log2,
  mix,
  mx_noise_float,
  output,
  positionGeometry,
  positionWorld,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
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
import { microSlopeVarianceForWind } from "./simulation/OceanMath";
import { beaufortToWindSpeed } from "../state/seaState";

type NodeRef = any;

type OceanRendererOptions = {
  scene: THREE.Scene;
  simulation: OceanSimulation;
  boatInteraction: BoatWaterInteraction | null;
  cloudShadows: unknown;
};

type AnyUniform<T> = any & { value: T };

type OceanUniformNodes = {
  worldOffset: AnyUniform<THREE.Vector2>;
  displacementToggle: AnyUniform<number>;
  foamIntensity: AnyUniform<number>;
  precipitation: AnyUniform<number>;
  turbidity: AnyUniform<number>;
  time: AnyUniform<number>;
  projectionScale: AnyUniform<number>;
  windDirectionXZ: AnyUniform<THREE.Vector2>;
  windCrossXZ: AnyUniform<THREE.Vector2>;
  microSlopeVariance: AnyUniform<number>;
  ambientColor: AnyUniform<THREE.Color>;
  ambientIntensity: AnyUniform<number>;
  boatInteractionOrigin: AnyUniform<THREE.Vector2>;
  boatInteractionSize: AnyUniform<number>;
  boatInteractionUvTexel: AnyUniform<number>;
  boatInteractionCellMeters: AnyUniform<number>;
  boatInteractionEnabled: AnyUniform<number>;
  sunDirection: AnyUniform<THREE.Vector3>;
  sunColor: AnyUniform<THREE.Color>;
  sunVisibility: AnyUniform<number>;
  sunDirectMask: AnyUniform<number>;
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
  debugReflectionGlitter: AnyUniform<number>;
};

const MAX_RADIUS_METERS = 30000;

function u<T>(value: T): AnyUniform<T> {
  return uniform(value as never) as unknown as AnyUniform<T>;
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
  private readonly material: MeshPhysicalNodeMaterial;
  private readonly depthMaterial: THREE.NodeMaterial;
  private readonly uniforms: OceanUniformNodes;
  private readonly foamNodes: NodeRef[];
  private readonly slopeVarianceNodes: AnyUniform<number>[];
  private readonly boatInteraction: BoatWaterInteraction | null;
  private readonly boatDynamicsNode: NodeRef | null;
  private readonly boatFoamNode: NodeRef | null;
  private visible = true;

  constructor(options: OceanRendererOptions) {
    this.simulation = options.simulation;
    this.boatInteraction = options.boatInteraction;

    const quality = this.simulation.quality;
    this.geometry = buildRadialGrid(quality.meshRings, quality.meshSectors, quality.meshInnerRadius);

    const shader = createWaterMaterial(this.simulation, options.boatInteraction);
    this.material = shader.material;
    this.depthMaterial = shader.depthMaterial;
    this.uniforms = shader.uniforms;
    this.foamNodes = shader.foamNodes;
    this.slopeVarianceNodes = shader.slopeVarianceNodes;
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
    originOffset: { x: number; z: number },
    timeSeconds: number,
    renderHeightPixels: number
  ): void {
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    this.mesh.visible = this.visible;

    // Foam alone is ping-ponged; raw derivative maps keep stable identities.
    this.simulation.cascades.forEach((cascade, index) => {
      this.foamNodes[index].value = cascade.currentFoamTexture;
      this.slopeVarianceNodes[index].value = this.simulation.metrics[index]?.slopeVariance
        ?? cascade.config.slopeVariance;
    });

    this.uniforms.worldOffset.value.set(camera.position.x + originOffset.x, camera.position.z + originOffset.z);
    this.uniforms.displacementToggle.value = settings.oceanDisplacement ? 1 : 0;
    this.uniforms.foamIntensity.value = settings.showFoam ? settings.foamIntensity : 0;
    this.uniforms.precipitation.value = weather.precipitation;
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
    this.uniforms.sunColor.value.set(environment.sunColor);
    this.uniforms.sunVisibility.value = environment.celestial.sunVisibility;
    this.uniforms.sunDirectMask.value = environment.celestial.sunDirectMask;
    this.uniforms.sunDirection.value.set(
      environment.celestial.sunDirection.x,
      environment.celestial.sunDirection.y,
      environment.celestial.sunDirection.z
    );

    const daylight = THREE.MathUtils.smoothstep(environment.celestial.sunDirection.y, -0.08, 0.42);
    const iblMask = Math.max(daylight, environment.celestial.twilightFactor);
    this.material.envMapIntensity =
      THREE.MathUtils.lerp(0.12, 1.0, iblMask) * (1 - weather.cloudCoverage * 0.5);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
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
    this.uniforms.debugReflectionGlitter.value = mode === "reflectionGlitter" ? 1 : 0;
  }
}

function createWaterMaterial(
  simulation: OceanSimulation,
  boatInteraction: BoatWaterInteraction | null
): {
  material: MeshPhysicalNodeMaterial;
  depthMaterial: THREE.NodeMaterial;
  uniforms: OceanUniformNodes;
  foamNodes: NodeRef[];
  slopeVarianceNodes: AnyUniform<number>[];
  boatDynamicsNode: NodeRef | null;
  boatFoamNode: NodeRef | null;
} {
  const uniforms: OceanUniformNodes = {
    worldOffset: u(new THREE.Vector2()),
    displacementToggle: u(1),
    foamIntensity: u(1),
    precipitation: u(0),
    turbidity: u(0.25),
    time: u(0),
    projectionScale: u(720),
    windDirectionXZ: u(new THREE.Vector2(1, 0)),
    windCrossXZ: u(new THREE.Vector2(0, 1)),
    microSlopeVariance: u(0.012),
    ambientColor: u(new THREE.Color("#89a8b8")),
    ambientIntensity: u(1),
    boatInteractionOrigin: u(new THREE.Vector2()),
    boatInteractionSize: u(1),
    boatInteractionUvTexel: u(1 / 128),
    boatInteractionCellMeters: u(1),
    boatInteractionEnabled: u(0),
    sunDirection: u(new THREE.Vector3(0, 1, 0)),
    sunColor: u(new THREE.Color("#fff1c2")),
    sunVisibility: u(1),
    sunDirectMask: u(1),
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
    debugReflectionGlitter: u(0)
  };

  const cascades = simulation.cascades;
  const displacementNodes = cascades.map((cascade) => texture(cascade.displacementTexture));
  const slopeMoment0Nodes = cascades.map((cascade) => texture(cascade.slopeMomentTexture0));
  const slopeMoment1Nodes = cascades.map((cascade) => texture(cascade.slopeMomentTexture1));
  const foamNodes = cascades.map((cascade) => texture(cascade.foamTextures[0]));
  const slopeVarianceNodes = cascades.map((cascade) => u(cascade.config.slopeVariance));
  const boatDynamicsNode = boatInteraction ? texture(boatInteraction.currentDynamicsTexture) : null;
  const boatFoamNode = boatInteraction ? texture(boatInteraction.currentFoamTexture) : null;

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
    return (boatDynamicsNode as any).sample(sample.uv).level(float(0)).mul(sample.mask);
  };

  const sampleBoatFoam = (worldXZ: NodeRef): NodeRef => {
    if (!boatFoamNode) return vec4(0, 0, 0, 0);

    const sample = boatInteractionUvAndMask(worldXZ);
    return (boatFoamNode as any).sample(sample.uv).level(float(0)).mul(sample.mask);
  };

  const material = new MeshPhysicalNodeMaterial();
  material.metalness = 0;
  material.ior = 1.333;
  material.envMapIntensity = 1;

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

  const displacedPosition = positionGeometry.add(displacement);
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
  const vDistance: NodeRef = vertexStage(cameraDistance);
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
  let covarianceXZ: NodeRef = float(0);
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
    const unresolved = float(1).sub(normalWeight);
    const footprintX = uv.dFdx().mul(cascade.config.resolution).length();
    const footprintY = uv.dFdy().mul(cascade.config.resolution).length();
    const momentMip = log2(footprintX.max(footprintY).max(1))
      .clamp(0, cascade.slopeMomentMipCount - 1);
    const moments0 = (slopeMoment0Nodes[index] as any).sample(uv).level(momentMip);
    const moments1 = (slopeMoment1Nodes[index] as any).sample(uv).level(momentMip);
    const meanSlope = moments0.xy;
    const localVarianceX = moments0.z.sub(moments0.x.mul(moments0.x)).max(0);
    const localVarianceZ = moments0.w.sub(moments0.y.mul(moments0.y)).max(0);
    const localCovariance = moments1.x.sub(moments0.x.mul(moments0.y));
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
    varianceX = varianceX.add(localVarianceX).add(unresolved.mul(slopeVarianceNodes[index]).mul(0.5));
    varianceZ = varianceZ.add(localVarianceZ).add(unresolved.mul(slopeVarianceNodes[index]).mul(0.5));
    covarianceXZ = covarianceXZ.add(localCovariance);
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
  covarianceXZ = covarianceXZ
    .add(uniforms.windDirectionXZ.x.mul(uniforms.windDirectionXZ.y).mul(coxWindVariance))
    .add(uniforms.windCrossXZ.x.mul(uniforms.windCrossXZ.y).mul(coxCrossVariance));

  // Rain ripples: fast animated high-frequency normal perturbation
  const rippleStrength = uniforms.precipitation.mul(0.16);
  const rippleA = mx_noise_float(vSampleXZ.mul(1.35).add(vec2(uniforms.time.mul(9.3), uniforms.time.mul(-7.1))));
  const rippleB = mx_noise_float(vSampleXZ.mul(1.62).sub(vec2(uniforms.time.mul(6.4), uniforms.time.mul(8.8))));
  const rippleFade = float(1).sub(smoothstep(float(30), float(140), vDistance));
  slope = slope.add(vec2(rippleA, rippleB).mul(rippleStrength).mul(rippleFade));

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
  const foamGrainFine = mx_noise_float(vSampleXZ.mul(3.7).add(uniforms.time.mul(0.06))).mul(0.5).add(0.5);
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

  const foamColor = color("#dbe7e7");

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
  const rainVariance = uniforms.precipitation.mul(0.015);
  const totalVariance = varianceX.add(varianceZ).mul(0.5)
    .add(screenVariance)
    .add(rainVariance)
    .max(0);
  const alphaSquared = float(Math.pow(0.08 * 0.08, 2)).add(totalVariance.mul(0.22));
  const waterRoughness = alphaSquared.pow(0.25).clamp(0.08, 0.48);
  material.roughnessNode = mix(waterRoughness, float(0.72), foamBlend);

  const covarianceTrace = varianceX.add(varianceZ);
  const covarianceDelta = varianceX.sub(varianceZ);
  const covarianceDiscriminant = sqrt(
    covarianceDelta.mul(covarianceDelta).add(covarianceXZ.mul(covarianceXZ).mul(4)).max(0)
  );
  const lambdaMax = covarianceTrace.add(covarianceDiscriminant).mul(0.5).max(0);
  const lambdaMin = covarianceTrace.sub(covarianceDiscriminant).mul(0.5).max(0);
  const anisotropyStrength = float(1)
    .sub(sqrt(lambdaMin.add(0.0001).div(lambdaMax.add(0.0001))))
    .clamp(0, 0.65)
    .mul(float(1).sub(foamBlend));
  const anisotropyAngle = atan(covarianceXZ.mul(2), covarianceDelta).mul(0.5);
  const anisotropyDirection = vec2(cos(anisotropyAngle), sin(anisotropyAngle));
  material.anisotropyNode = anisotropyDirection.mul(anisotropyStrength);
  material.specularIntensityNode = mix(float(1), float(0.35), foamBlend);

  // ATLANTIC_DEEP: Snell refraction, Beer-Lambert extinction and single-scatter
  // upwelling. Fresnel reflection itself remains in MeshPhysicalNodeMaterial.
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const cosIncident = worldNormal.dot(viewDir).max(0.001).clamp(0, 1);
  const f0 = float(0.02037);
  const fresnel = f0.add(float(1).sub(f0).mul(float(1).sub(cosIncident).pow(5))).clamp(0, 1);
  const eta = float(1 / 1.333);
  const sinTransmittedSquared = float(1).sub(cosIncident.mul(cosIncident)).mul(eta.mul(eta));
  const cosTransmitted = sqrt(float(1).sub(sinTransmittedSquared).max(0.0001));
  const absorption = mix(
    vec3(0.32, 0.075, 0.028),
    vec3(0.42, 0.14, 0.065),
    uniforms.turbidity
  );
  const scattering = mix(
    vec3(0.006, 0.018, 0.032),
    vec3(0.028, 0.065, 0.052),
    uniforms.turbidity
  );
  const effectiveDepth = mix(float(10), float(4), uniforms.turbidity);
  const opticalPath = effectiveDepth.div(cosTransmitted.max(0.15));
  const extinction = absorption.add(scattering);
  const transmittance = exp(extinction.mul(opticalPath).negate());
  const scatteringAlbedo = scattering.div(extinction.max(0.0001));
  const ambientRadiance = uniforms.ambientColor.mul(uniforms.ambientIntensity);
  const waterVolume = ambientRadiance
    .mul(scatteringAlbedo)
    .mul(vec3(1, 1, 1).sub(transmittance))
    .mul(0.55);
  const volumeContribution = waterVolume
    .mul(float(1).sub(fresnel))
    .mul(float(1).sub(foamBlend));
  material.emissiveNode = volumeContribution;

  const sunHalf = viewDir.add(uniforms.sunDirection).normalize();
  const glitterExponent = mix(float(18), float(300), float(1).sub(waterRoughness));
  const reflectionGlitter = worldNormal.dot(sunHalf).max(0).pow(glitterExponent)
    .mul(fresnel)
    .mul(uniforms.sunVisibility)
    .mul(uniforms.sunDirectMask);

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
    const unresolvedVis = sqrt(totalVariance).mul(3).clamp(0, 1);
    result = result.add(vec3(unresolvedVis, unresolvedVis.mul(0.45), 0).mul(uniforms.debugUnresolvedEnergy));
    result = result.add(cascadeDebug.mul(2).clamp(0, 1).mul(uniforms.debugCascades));
    result = result.add(vec3(fresnelDebug, fresnelDebug, fresnelDebug).mul(uniforms.debugFresnel));
    const opticalDepthVis = opticalPath.div(24).clamp(0, 1);
    result = result.add(vec3(opticalDepthVis, opticalDepthVis.mul(0.55), float(1).sub(opticalDepthVis))
      .mul(uniforms.debugOpticalDepth));
    result = result.add(waterVolume.mul(5).clamp(0, 1).mul(uniforms.debugWaterVolume));
    result = result.add(vec3(reflectionGlitter).mul(uniforms.debugReflectionGlitter));
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
    .add(uniforms.debugReflectionGlitter)
    .clamp(0, 1);
  material.outputNode = mix(output, vec4(debugColor, 1), debugBlend);

  return {
    material,
    depthMaterial,
    uniforms,
    foamNodes,
    slopeVarianceNodes,
    boatDynamicsNode,
    boatFoamNode
  };
}
