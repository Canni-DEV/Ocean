import * as THREE from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  float,
  getScreenPosition,
  getViewPosition,
  ivec2,
  int,
  mix,
  reflect,
  smoothstep,
  texture,
  textureLoad,
  textureSize,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import type { OceanScreenSpaceQuality } from "./simulation/OceanSimulation";

type MutableTextureNode = any & { value: THREE.Texture };
type MatrixUniform = any & { value: THREE.Matrix4 };

/** Ocean-only half/quarter-resolution ray marcher with bounded temporal resolve. */
export class OceanScreenSpaceReflectionPass {
  private readonly targets: [THREE.RenderTarget, THREE.RenderTarget];
  private readonly material: THREE.NodeMaterial;
  private readonly quad: THREE.QuadMesh;
  private readonly historyNode: MutableTextureNode;
  private readonly projection: MatrixUniform;
  private readonly inverseProjection: MatrixUniform;
  private readonly maxHistoryWeight: any;
  private readIndex = 0;
  private width = 1;
  private height = 1;
  private historyValid = false;
  private enabled = true;
  private temporalEnabled = true;
  private lastRenderMs = 0;

  constructor(
    private readonly quality: OceanScreenSpaceQuality,
    sceneColor: THREE.Texture,
    sceneNormalRoughness: THREE.Texture,
    sceneVelocity: THREE.Texture,
    surfaceDepth: THREE.Texture,
    surfaceNormalRoughness: THREE.Texture
  ) {
    this.targets = [createTarget("a"), createTarget("b")];
    this.historyNode = texture(this.targets[1].texture).setSampler(false) as MutableTextureNode;
    this.projection = uniform(new THREE.Matrix4()) as MatrixUniform;
    this.inverseProjection = uniform(new THREE.Matrix4()) as MatrixUniform;
    this.maxHistoryWeight = uniform(quality.maxHistoryWeight);

    const colorNode = texture(sceneColor).setSampler(false);
    const normalRoughnessNode = texture(sceneNormalRoughness).setSampler(false);
    const velocityDepthNode = texture(sceneVelocity).setSampler(false);
    const waterDepthNode = texture(surfaceDepth);
    const waterDataNode = texture(surfaceNormalRoughness);
    const maxSteps = Math.max(1, quality.maxSteps);
    const binarySteps = Math.max(0, quality.binarySteps);
    const maxDistance = Math.max(1, quality.maxDistanceM);
    const loadScreen = (node: MutableTextureNode, coordinates: any): any => {
      const size = textureSize(textureLoad(node));
      const texel = (ivec2 as any)(coordinates.mul(size)).clamp((ivec2 as any)(0), (ivec2 as any)(size).sub(1));
      return textureLoad(node, texel);
    };

    this.material = new THREE.NodeMaterial();
    this.material.name = "Ocean temporal SSR";
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.fragmentNode = Fn(() => {
      const screen = uv();
      const waterDepth = (waterDepthNode as any).sample(screen).a;
      const surface = (waterDataNode as any).sample(screen);
      const normalXy = surface.xy.mul(2).sub(1);
      const normal = (vec3 as any)(normalXy, float(1).sub(normalXy.dot(normalXy)).max(0).sqrt()).normalize();
      const roughness = surface.b;
      const viewPosition = getViewPosition(screen, waterDepth, this.inverseProjection);
      const incident = viewPosition.normalize();
      const reflected = reflect(incident, normal).normalize();
      const rayEnd = viewPosition.add(reflected.mul(maxDistance));
      const endUv = getScreenPosition(rayEnd, this.projection);
      const uvDelta = endUv.sub(screen);
      const hitUv = vec2(0).toVar();
      const hitError = float(1e6).toVar();
      const hitDistance = float(maxDistance).toVar();
      const found = float(0).toVar();
      const hitLow = float(0).toVar();
      const hitHigh = float(0).toVar();
      const reciprocalStartZ = float(1).div(viewPosition.z);
      const reciprocalEndZ = float(1).div(rayEnd.z);

      Loop({ start: int(1), end: int(maxSteps + 1), type: "int", condition: "<" }, ({ i }) => {
        const s = float(i).div(maxSteps);
        const sampleUv = screen.add(uvDelta.mul(s));
        const edge = sampleUv.x.min(sampleUv.y).min(float(1).sub(sampleUv.x)).min(float(1).sub(sampleUv.y));
        If(edge.lessThanEqual(0), () => Break());
        const sceneDepthSample = loadScreen(velocityDepthNode as MutableTextureNode, sampleUv).b;
        const sceneColorSample = loadScreen(colorNode as MutableTextureNode, sampleUv);
        const sceneView = getViewPosition(sampleUv, sceneDepthSample, this.inverseProjection);
        const rayZ = float(1).div(mix(reciprocalStartZ, reciprocalEndZ, s));
        const error = rayZ.sub(sceneView.z);
        const thickness = float(0.08).add(s.mul(maxDistance * 0.012));
        If(
          rayZ.lessThanEqual(sceneView.z)
            .and(error.abs().lessThan(thickness))
            .and(sceneColorSample.a.greaterThan(0.01))
            .and(sceneDepthSample.lessThan(0.99999)),
          () => {
            hitUv.assign(sampleUv);
            hitError.assign(error.abs());
            hitDistance.assign(float(maxDistance).mul(s));
            hitLow.assign(s.sub(float(1).div(maxSteps)).max(0));
            hitHigh.assign(s);
            found.assign(1);
            Break();
          }
        );
      });

      // Refine only the bracket found by the coarse march. Keeping refinement
      // outside the march avoids nested-loop compiler issues on some drivers.
      if (binarySteps > 0) {
        If(found.greaterThan(0.5), () => {
          Loop({ start: int(0), end: int(binarySteps), type: "int", condition: "<" }, () => {
            const mid = hitLow.add(hitHigh).mul(0.5);
            const midUv = screen.add(uvDelta.mul(mid));
            const midDepth = loadScreen(velocityDepthNode as MutableTextureNode, midUv).b;
            const midSceneView = getViewPosition(midUv, midDepth, this.inverseProjection);
            const midRayZ = float(1).div(mix(reciprocalStartZ, reciprocalEndZ, mid));
            If(midRayZ.lessThanEqual(midSceneView.z), () => {
              hitHigh.assign(mid);
            }).Else(() => {
              hitLow.assign(mid);
            });
          });
          const refinedUv = screen.add(uvDelta.mul(hitHigh));
          const refinedDepth = loadScreen(velocityDepthNode as MutableTextureNode, refinedUv).b;
          const refinedScene = getViewPosition(refinedUv, refinedDepth, this.inverseProjection);
          const refinedRayZ = float(1).div(mix(reciprocalStartZ, reciprocalEndZ, hitHigh));
          hitUv.assign(refinedUv);
          hitError.assign(refinedRayZ.sub(refinedScene.z).abs());
          hitDistance.assign(float(maxDistance).mul(hitHigh));
        });
      }

      const edgeDistance = hitUv.x.min(hitUv.y).min(float(1).sub(hitUv.x)).min(float(1).sub(hitUv.y));
      const edgeConfidence = smoothstep(float(0.01), float(0.08), edgeDistance);
      const roughConfidence = float(1).sub(smoothstep(float(0.3), float(0.48), roughness));
      const distanceConfidence = float(1).sub(smoothstep(float(maxDistance * 0.7), float(maxDistance), hitDistance));
      const errorConfidence = float(1).sub(smoothstep(float(0.04), float(0.35), hitError));
      const hitSurface = loadScreen(normalRoughnessNode as MutableTextureNode, hitUv);
      const hitNormal = hitSurface.rgb.mul(2).sub(1).normalize();
      // A reflected ray can only hit the front side of captured geometry.
      // Grazing ambiguity fades continuously instead of producing hard holes.
      const normalConfidence = float(1).sub(smoothstep(float(-0.02), float(0.18), reflected.dot(hitNormal)));
      const hitRoughnessConfidence = float(1).sub(smoothstep(float(0.72), float(0.98), hitSurface.a));
      const waterValid = float(1).sub(smoothstep(float(0.999), float(1), waterDepth));
      const confidence = found.mul(edgeConfidence).mul(roughConfidence)
        .mul(distanceConfidence).mul(errorConfidence).mul(normalConfidence)
        .mul(hitRoughnessConfidence).mul(waterValid).clamp(0, 1);
      const hitVelocity = loadScreen(velocityDepthNode as MutableTextureNode, hitUv).xy;
      const historyUv = screen.sub(hitVelocity);
      const history = loadScreen(this.historyNode, historyUv);
      const motionReject = float(1).sub(smoothstep(float(0.015), float(0.08), hitVelocity.length()));
      const historyWeight = this.maxHistoryWeight.mul(confidence).mul(history.a).mul(motionReject);
      const radianceLod = roughness.mul(5)
        .add(hitDistance.div(maxDistance).mul(2))
        .clamp(0, 7);
      const filteredHit = (colorNode as any).sample(hitUv).level(radianceLod).rgb;
      const historyClamped = history.rgb.clamp(filteredHit.mul(0.45), filteredHit.mul(1.55).add(0.03));
      const resolved = mix(filteredHit, historyClamped, historyWeight);
      return (vec4 as any)(resolved, confidence);
    })();
    this.quad = new THREE.QuadMesh(this.material);
  }

  get texture(): THREE.Texture {
    return this.targets[this.readIndex].texture;
  }

  get confidenceTexture(): THREE.Texture {
    return this.texture;
  }

  get renderMs(): number {
    return this.lastRenderMs;
  }

  setEnabled(enabled: boolean, temporalEnabled: boolean): void {
    if (this.enabled !== enabled || this.temporalEnabled !== temporalEnabled) this.resetHistory();
    this.enabled = enabled && this.quality.ssrEnabled;
    this.temporalEnabled = temporalEnabled && this.quality.temporalEnabled;
    this.maxHistoryWeight.value = this.temporalEnabled ? this.quality.maxHistoryWeight : 0;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.quality.captureScale));
    const h = Math.max(1, Math.round(height * this.quality.captureScale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.targets.forEach((target) => target.setSize(w, h));
    this.resetHistory();
  }

  resetHistory(): void {
    this.historyValid = false;
  }

  render(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera): void {
    if (!this.enabled) {
      this.lastRenderMs = 0;
      return;
    }
    const start = performance.now();
    this.projection.value.copy(camera.projectionMatrix);
    this.inverseProjection.value.copy(camera.projectionMatrixInverse);
    const writeIndex = 1 - this.readIndex;
    this.historyNode.value = this.targets[this.readIndex].texture;
    this.maxHistoryWeight.value = this.historyValid && this.temporalEnabled ? this.quality.maxHistoryWeight : 0;
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousToneMapping = renderer.toneMapping;
    try {
      renderer.autoClear = true;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(this.targets[writeIndex]);
      this.quad.render(renderer);
      this.readIndex = writeIndex;
      this.historyValid = true;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      renderer.toneMapping = previousToneMapping;
      this.lastRenderMs = performance.now() - start;
    }
  }

  dispose(): void {
    this.targets.forEach((target) => target.dispose());
    this.material.dispose();
  }
}

function createTarget(suffix: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    // Float32 is read with textureLoad() by the final water material. On the
    // target WebGPU adapters this remains samplerless and avoids exceeding the
    // 16-sampler stage limit.
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    samples: 0,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false
  });
  target.texture.name = `ocean-ssr-${suffix}`;
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}
