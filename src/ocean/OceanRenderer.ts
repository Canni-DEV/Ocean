import * as THREE from "three/webgpu";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import {
  Fn,
  cameraPosition,
  color,
  float,
  mix,
  mx_noise_float,
  output,
  positionGeometry,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import type { DebugRenderMode, DebugSettings, EnvironmentState, WeatherState } from "../engine/types";
import type { OceanSimulation } from "./simulation/OceanSimulation";

type NodeRef = any;

type OceanRendererOptions = {
  scene: THREE.Scene;
  simulation: OceanSimulation;
};

type AnyUniform<T> = any & { value: T };

type OceanUniformNodes = {
  worldOffset: AnyUniform<THREE.Vector2>;
  displacementToggle: AnyUniform<number>;
  foamIntensity: AnyUniform<number>;
  precipitation: AnyUniform<number>;
  turbidity: AnyUniform<number>;
  time: AnyUniform<number>;
  absorptionColor: AnyUniform<THREE.Color>;
  scatterColor: AnyUniform<THREE.Color>;
  sunDirection: AnyUniform<THREE.Vector3>;
  sunColor: AnyUniform<THREE.Color>;
  sunVisibility: AnyUniform<number>;
  debugHeight: AnyUniform<number>;
  debugNormal: AnyUniform<number>;
  debugFoam: AnyUniform<number>;
  debugJacobian: AnyUniform<number>;
  debugSlope: AnyUniform<number>;
  debugCascades: AnyUniform<number>;
  debugFresnel: AnyUniform<number>;
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
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * FFT-driven ocean surface with physically based shading: displacement and
 * derivative maps come from the spectral simulation, lighting uses the scene
 * environment (dynamic sky cubemap) plus GGX sun specular and approximate
 * subsurface scattering on wave crests.
 */
export class OceanRenderer {
  private readonly simulation: OceanSimulation;
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: MeshPhysicalNodeMaterial;
  private readonly uniforms: OceanUniformNodes;
  private readonly derivativeNodes: NodeRef[];
  private visible = true;

  constructor(options: OceanRendererOptions) {
    this.simulation = options.simulation;

    const quality = this.simulation.quality;
    this.geometry = buildRadialGrid(quality.meshRings, quality.meshSectors, quality.meshInnerRadius);

    const shader = createWaterMaterial(this.simulation);
    this.material = shader.material;
    this.uniforms = shader.uniforms;
    this.derivativeNodes = shader.derivativeNodes;

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "FFT spectral ocean surface";
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
    originOffset: { x: number; z: number },
    timeSeconds: number
  ): void {
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    this.mesh.visible = this.visible;

    // Ping-pong: point the material at the derivative maps written this frame.
    this.simulation.cascades.forEach((cascade, index) => {
      this.derivativeNodes[index].value = cascade.currentDerivativeTexture;
    });

    this.uniforms.worldOffset.value.set(camera.position.x + originOffset.x, camera.position.z + originOffset.z);
    this.uniforms.displacementToggle.value = settings.oceanDisplacement ? 1 : 0;
    this.uniforms.foamIntensity.value = settings.showFoam ? settings.foamIntensity : 0;
    this.uniforms.precipitation.value = weather.precipitation;
    this.uniforms.turbidity.value = settings.waterTurbidity;
    this.uniforms.time.value = timeSeconds;
    this.uniforms.absorptionColor.value.set(environment.waterAbsorptionColor);
    this.uniforms.scatterColor.value.set(environment.waterScatterColor);
    this.uniforms.sunColor.value.set(environment.sunColor);
    this.uniforms.sunVisibility.value = environment.celestial.sunVisibility;
    this.uniforms.sunDirection.value.set(
      environment.celestial.sunDirection.x,
      environment.celestial.sunDirection.y,
      environment.celestial.sunDirection.z
    );
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }

  private setDebugMode(mode: DebugRenderMode): void {
    this.uniforms.debugHeight.value = mode === "height" ? 1 : 0;
    this.uniforms.debugNormal.value = mode === "normal" ? 1 : 0;
    this.uniforms.debugFoam.value = mode === "foam" ? 1 : 0;
    this.uniforms.debugJacobian.value = mode === "jacobian" ? 1 : 0;
    this.uniforms.debugSlope.value = mode === "slope" ? 1 : 0;
    this.uniforms.debugCascades.value = mode === "cascades" ? 1 : 0;
    this.uniforms.debugFresnel.value = mode === "fresnel" ? 1 : 0;
  }
}

/** Per-cascade fade distances, proportional to patch size. */
function cascadeFades(patchSize: number): { dispEnd: number; normalEnd: number } {
  return {
    dispEnd: patchSize * 9,
    normalEnd: patchSize * 42
  };
}

function createWaterMaterial(simulation: OceanSimulation): {
  material: MeshPhysicalNodeMaterial;
  uniforms: OceanUniformNodes;
  derivativeNodes: NodeRef[];
} {
  const uniforms: OceanUniformNodes = {
    worldOffset: u(new THREE.Vector2()),
    displacementToggle: u(1),
    foamIntensity: u(1),
    precipitation: u(0),
    turbidity: u(0.25),
    time: u(0),
    absorptionColor: u(new THREE.Color("#03181f")),
    scatterColor: u(new THREE.Color("#0e5e52")),
    sunDirection: u(new THREE.Vector3(0, 1, 0)),
    sunColor: u(new THREE.Color("#fff1c2")),
    sunVisibility: u(1),
    debugHeight: u(0),
    debugNormal: u(0),
    debugFoam: u(0),
    debugJacobian: u(0),
    debugSlope: u(0),
    debugCascades: u(0),
    debugFresnel: u(0)
  };

  const cascades = simulation.cascades;
  const displacementNodes = cascades.map((cascade) => texture(cascade.displacementTexture));
  const derivativeNodes = cascades.map((cascade) => texture(cascade.derivativeTextures[0]));

  const material = new MeshPhysicalNodeMaterial();
  material.metalness = 0;
  material.ior = 1.333;
  material.envMapIntensity = 1;

  // ------------------------------------------------------------------ vertex
  const sampleXZ = positionGeometry.xz.add(uniforms.worldOffset);
  const cameraDistance = positionGeometry.xz.length();

  let displacement: NodeRef = vec3(0, 0, 0);
  cascades.forEach((cascade, index) => {
    const fades = cascadeFades(cascade.config.patchSize);
    const uv = sampleXZ.div(cascade.config.patchSize);
    const fade = float(1).sub(smoothstep(float(fades.dispEnd * 0.55), float(fades.dispEnd), cameraDistance));
    const sampleNode = (displacementNodes[index] as any).sample(uv).level(float(0));
    displacement = displacement.add(sampleNode.xyz.mul(fade));
  });
  displacement = displacement.mul(uniforms.displacementToggle);

  material.positionNode = positionGeometry.add(displacement);

  const vHeight: NodeRef = vertexStage(displacement.y);
  const vSampleXZ: NodeRef = vertexStage(sampleXZ);
  const vDistance: NodeRef = vertexStage(cameraDistance);

  // ---------------------------------------------------------------- fragment
  let slope: NodeRef = vec2(0, 0);
  let foamRaw: NodeRef = float(0);
  let jacobianMin: NodeRef = float(1);
  let roughnessBoost: NodeRef = float(0);
  let cascadeDebug: NodeRef = vec3(0, 0, 0);

  cascades.forEach((cascade, index) => {
    const fades = cascadeFades(cascade.config.patchSize);
    const uv = vSampleXZ.div(cascade.config.patchSize);
    const derivatives = (derivativeNodes[index] as any).sample(uv);
    const fade = float(1).sub(smoothstep(float(fades.normalEnd * 0.4), float(fades.normalEnd), vDistance));

    slope = slope.add(derivatives.xy.mul(fade));
    foamRaw = foamRaw.max(derivatives.w.mul(fade.mul(0.4).add(0.6)));
    jacobianMin = jacobianMin.min(derivatives.z.mul(fade).add(float(1).sub(fade)));
    // Detail lost at distance becomes micro-roughness (specular anti-aliasing)
    roughnessBoost = roughnessBoost.add(float(1).sub(fade).mul(index === 0 ? 0.02 : index === 1 ? 0.05 : 0.08));

    const channel = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)][index] as NodeRef;
    cascadeDebug = cascadeDebug.add(channel.mul(derivatives.xy.length().mul(fade)));
  });

  // Rain ripples: fast animated high-frequency normal perturbation
  const rippleStrength = uniforms.precipitation.mul(0.16);
  const rippleA = mx_noise_float(vSampleXZ.mul(1.35).add(vec2(uniforms.time.mul(9.3), uniforms.time.mul(-7.1))));
  const rippleB = mx_noise_float(vSampleXZ.mul(1.62).sub(vec2(uniforms.time.mul(6.4), uniforms.time.mul(8.8))));
  const rippleFade = float(1).sub(smoothstep(float(30), float(140), vDistance));
  slope = slope.add(vec2(rippleA, rippleB).mul(rippleStrength).mul(rippleFade));

  const worldNormal = vec3(slope.x.negate(), 1, slope.y.negate()).normalize();

  // Foam: temporal accumulation from the simulation + procedural grain
  const foamGrain = mx_noise_float(vSampleXZ.mul(0.9)).mul(0.5).add(0.5);
  const foamGrainFine = mx_noise_float(vSampleXZ.mul(3.7).add(uniforms.time.mul(0.06))).mul(0.5).add(0.5);
  const foamAmount = foamRaw
    .mul(uniforms.foamIntensity)
    .mul(foamGrain.mul(0.45).add(0.62))
    .mul(foamGrainFine.mul(0.35).add(0.72))
    .clamp(0, 1);
  const foamBlend = smoothstep(float(0.12), float(0.62), foamAmount);

  // Water body color: dark absorption base, brighter scatter on crests/turbidity
  const crestLift = vHeight.mul(0.5).add(0.5).clamp(0, 1);
  const scatterAmount = crestLift.mul(0.36).add(uniforms.turbidity.mul(0.3)).clamp(0, 1);
  const waterAlbedo = mix(uniforms.absorptionColor, uniforms.scatterColor, scatterAmount);
  const foamColor = color("#e8f4f6");

  material.colorNode = mix(waterAlbedo, foamColor, foamBlend);
  material.normalNode = transformNormalToView(worldNormal);

  const baseRoughness = float(0.045)
    .add(roughnessBoost)
    .add(uniforms.precipitation.mul(0.06))
    .add(foamBlend.mul(0.5));
  material.roughnessNode = baseRoughness.clamp(0.02, 0.95);

  // Approximate subsurface scattering: sunlight transmitted through wave crests
  // when looking toward the sun, strongest for tall thin waves.
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const towardSun = viewDir.negate().dot(uniforms.sunDirection).max(0);
  const crest = vHeight.mul(0.32).add(0.08).max(0);
  const sss = towardSun.pow(3).mul(crest).mul(uniforms.sunVisibility);
  const sssAmbient = crest.mul(0.06).mul(uniforms.sunVisibility);
  material.emissiveNode = uniforms.scatterColor
    .mul(uniforms.sunColor)
    .mul(sss.mul(1.35).add(sssAmbient))
    .mul(float(1).sub(foamBlend));

  // ------------------------------------------------------------- debug views
  const fresnelDebug = float(1).sub(worldNormal.dot(viewDir).max(0)).pow(5).clamp(0, 1);
  const debugColor = Fn(() => {
    let result: NodeRef = vec3(0, 0, 0);
    const heightVis = vHeight.mul(0.14).add(0.5).clamp(0, 1);
    result = result.add(vec3(heightVis.mul(0.2), heightVis.mul(0.65), heightVis).mul(uniforms.debugHeight));
    result = result.add(worldNormal.mul(0.5).add(0.5).mul(uniforms.debugNormal));
    result = result.add(vec3(foamAmount, foamAmount, foamAmount).mul(uniforms.debugFoam));
    const jacobianVis = jacobianMin.mul(0.5).clamp(0, 1);
    result = result.add(vec3(float(1).sub(jacobianVis), jacobianVis, jacobianVis.mul(0.4)).mul(uniforms.debugJacobian));
    const slopeVis = slope.length().mul(1.4).clamp(0, 1);
    result = result.add(vec3(slopeVis, slopeVis.mul(0.6), slopeVis.mul(0.2)).mul(uniforms.debugSlope));
    result = result.add(cascadeDebug.mul(2).clamp(0, 1).mul(uniforms.debugCascades));
    result = result.add(vec3(fresnelDebug, fresnelDebug, fresnelDebug).mul(uniforms.debugFresnel));
    return result;
  })();

  const debugBlend = uniforms.debugHeight
    .add(uniforms.debugNormal)
    .add(uniforms.debugFoam)
    .add(uniforms.debugJacobian)
    .add(uniforms.debugSlope)
    .add(uniforms.debugCascades)
    .add(uniforms.debugFresnel)
    .clamp(0, 1);
  material.outputNode = mix(output, vec4(debugColor, 1), debugBlend);

  return { material, uniforms, derivativeNodes };
}
