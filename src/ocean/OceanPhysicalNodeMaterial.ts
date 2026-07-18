import { MeshPhysicalNodeMaterial, PhysicalLightingModel } from "three/webgpu";
import {
  alphaT,
  anisotropyB,
  anisotropyT,
  float,
  normalView,
  positionViewDirection,
  property,
  roughness,
  vec3
} from "three/tsl";
import { getOceanLightRole, isOceanCelestialRole } from "./OceanLightRoles";

type NodeRef = any;

export type OceanLightingContext = {
  foamBlend: NodeRef;
  foamColor: NodeRef;
  extinction: NodeRef;
  scatteringAlbedo: NodeRef;
  fresnel: NodeRef;
  localOpticalPath: NodeRef;
  localScatterGain: NodeRef;
  phaseG: NodeRef;
  sunGlitterGain: NodeRef;
  moonGlitterGain: NodeRef;
  iblGain: NodeRef;
  celestialAngularRadiusRad: number;
  f0: number;
};

export const oceanLocalSpecular = property("vec3", "OceanLocalSpecular");
export const oceanLocalVolume = property("vec3", "OceanLocalVolume");
export const oceanSunGlitter = property("vec3", "OceanSunGlitter");
export const oceanMoonGlitter = property("vec3", "OceanMoonGlitter");
export const oceanFoamLighting = property("vec3", "OceanFoamLighting");
export const oceanLightRoles = property("vec3", "OceanLightRoles");

const ROLE_DEBUG_COLORS: Record<string, readonly [number, number, number]> = {
  "boat-work": [1, 0.7, 0.15],
  "flashlight-spot": [0.3, 0.75, 1],
  "flashlight-spill": [0.15, 0.45, 1],
  cabin: [1, 0.35, 0.08],
  "nav-port": [1, 0, 0.08],
  "nav-starboard": [0.08, 1, 0.3],
  anchor: [0.85, 0.9, 1],
  lightning: [0.55, 0.7, 1],
  generic: [0.7, 0.2, 0.8]
};

function oceanGgx(
  lightDirection: NodeRef,
  effectiveRoughness: NodeRef,
  f0: NodeRef,
  angularRadiusRad: number
): NodeRef {
  const viewDirection = positionViewDirection;
  const halfDirection = lightDirection.add(viewDirection).normalize();
  const dotNL = normalView.dot(lightDirection).clamp(0, 1);
  const dotNV = normalView.dot(viewDirection).clamp(0, 1);
  const dotNH = normalView.dot(halfDirection).clamp(0, 1);
  const dotVH = viewDirection.dot(halfDirection).clamp(0, 1);
  const dotTL = anisotropyT.dot(lightDirection);
  const dotTV = anisotropyT.dot(viewDirection);
  const dotTH = anisotropyT.dot(halfDirection);
  const dotBL = anisotropyB.dot(lightDirection);
  const dotBV = anisotropyB.dot(viewDirection);
  const dotBH = anisotropyB.dot(halfDirection);

  const alphaBBase = effectiveRoughness.pow(2).max(0.001);
  const sourceAlpha = float(Math.tan(angularRadiusRad));
  const alphaB = alphaBBase.pow(2).add(sourceAlpha.pow(2)).sqrt().max(0.001);
  const alphaTValue = alphaT.pow(2).add(sourceAlpha.pow(2)).sqrt().max(0.001);
  const alphaProduct = alphaTValue.mul(alphaB);
  const distributionVector: NodeRef = (vec3 as any)(
    alphaB.mul(dotTH),
    alphaTValue.mul(dotBH),
    alphaProduct.mul(dotNH)
  );
  // Filament's normalized anisotropic GGX distribution. The numerator is
  // (alphaT * alphaB)^3, not merely alphaT * alphaB. Omitting the other two
  // factors makes narrow lobes gain orders of magnitude of energy and was the
  // source of the fully white solar/lunar ocean reported after PR6B.
  const distributionLengthSquared = distributionVector.dot(distributionVector).max(1e-12);
  const distributionRatio = alphaProduct.div(distributionLengthSquared);
  const distribution = alphaProduct.mul(distributionRatio.pow(2)).mul(1 / Math.PI);
  const visibilityV = dotNL.mul((vec3 as any)(alphaTValue.mul(dotTV), alphaB.mul(dotBV), dotNV).length());
  const visibilityL = dotNV.mul((vec3 as any)(alphaTValue.mul(dotTL), alphaB.mul(dotBL), dotNL).length());
  const visibility = float(0.5).div(visibilityV.add(visibilityL).max(1e-6));
  const fresnel = f0.add(vec3(1).sub(f0).mul(float(1).sub(dotVH).pow(5)));
  return fresnel.mul(visibility).mul(distribution);
}

function henyeyGreensteinNode(cosTheta: NodeRef, g: NodeRef): NodeRef {
  const g2 = g.mul(g);
  const denominator = float(1).add(g2).sub(g.mul(cosTheta).mul(2)).max(1e-5).pow(1.5);
  return float(1).sub(g2).div(denominator.mul(4 * Math.PI));
}

class OceanLightingModel extends PhysicalLightingModel {
  constructor(private readonly ocean: OceanLightingContext) {
    super(false, false, false, true, false, false);
  }

  start(builder: any): void {
    super.start(builder);
    oceanLocalSpecular.assign(vec3(0));
    oceanLocalVolume.assign(vec3(0));
    oceanSunGlitter.assign(vec3(0));
    oceanMoonGlitter.assign(vec3(0));
    oceanFoamLighting.assign(vec3(0));
    oceanLightRoles.assign(vec3(0));
  }

  direct(input: any): void {
    const { lightDirection, lightColor, lightNode, reflectedLight } = input;
    const role = getOceanLightRole(lightNode.light);
    const celestial = isOceanCelestialRole(role);
    const dotNL = normalView.dot(lightDirection).clamp(0, 1);
    const irradiance = lightColor.mul(dotNL);
    const angularRadius = celestial ? this.ocean.celestialAngularRadiusRad : 0;
    const foamSpecularScale = float(1).sub(this.ocean.foamBlend.mul(0.65));
    const f0 = vec3(this.ocean.f0).mul(foamSpecularScale);
    const glitterGain = role === "sun"
      ? this.ocean.sunGlitterGain
      : role === "moon"
        ? this.ocean.moonGlitterGain
        : float(1);
    const specular = irradiance
      .mul(oceanGgx(lightDirection, roughness, f0, angularRadius))
      .mul(glitterGain);

    const foamDiffuse = irradiance
      .mul(this.ocean.foamColor)
      .mul(this.ocean.foamBlend)
      .mul(1 / Math.PI);
    const phase = henyeyGreensteinNode(
      lightDirection.dot(positionViewDirection).clamp(-1, 1),
      this.ocean.phaseG
    );
    const transmittance = this.ocean.extinction
      .mul(this.ocean.localOpticalPath)
      .negate()
      .exp();
    const volume = irradiance
      .mul(this.ocean.scatteringAlbedo)
      .mul(vec3(1).sub(transmittance))
      .mul(phase)
      .mul(this.ocean.localScatterGain)
      .mul(float(1).sub(this.ocean.fresnel))
      .mul(float(1).sub(this.ocean.foamBlend));

    reflectedLight.directSpecular.addAssign(specular);
    reflectedLight.directDiffuse.addAssign(foamDiffuse.add(volume));
    oceanFoamLighting.addAssign(foamDiffuse);

    if (role === "sun") {
      oceanSunGlitter.addAssign(specular);
    } else if (role === "moon") {
      oceanMoonGlitter.addAssign(specular);
    } else {
      oceanLocalSpecular.addAssign(specular);
      oceanLocalVolume.addAssign(volume);
      const debugColor = ROLE_DEBUG_COLORS[role] ?? ROLE_DEBUG_COLORS.generic;
      oceanLightRoles.addAssign(irradiance.mul(vec3(...debugColor)).mul(0.04));
    }
  }

  indirectSpecular(builder: any): void {
    const context = builder.context;
    const radiance = context.radiance;
    const iblIrradiance = context.iblIrradiance;
    context.radiance = radiance.mul(this.ocean.iblGain);
    context.iblIrradiance = iblIrradiance.mul(this.ocean.iblGain);
    super.indirectSpecular(builder);
    context.radiance = radiance;
    context.iblIrradiance = iblIrradiance;
  }
}

export class OceanPhysicalNodeMaterial extends MeshPhysicalNodeMaterial {
  private oceanLightingContext: OceanLightingContext | null = null;

  setOceanLightingContext(context: OceanLightingContext): void {
    this.oceanLightingContext = context;
    this.needsUpdate = true;
  }

  setupLightingModel(): PhysicalLightingModel {
    if (!this.oceanLightingContext) return super.setupLightingModel();
    return new OceanLightingModel(this.oceanLightingContext);
  }
}
