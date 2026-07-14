import * as THREE from "three/webgpu";
import type {
  BoatSystemsState,
  CockpitControlId,
  InteractionTarget,
  StationId
} from "../gameplay/types";
import { RADIO_STATION_COUNT } from "./radioConfig";
import {
  gaugeValueToAngle,
  headingToCompassAngle,
  projectWorldTargetToHeadUpRadar,
  smoothWrappedAngle,
  type RadarProjection
} from "./CockpitInstrumentMath";

export type CockpitHit = { kind: "control"; target: InteractionTarget };

export type StationZoneDescriptor = {
  id: StationId;
  volume: THREE.Object3D;
  size: THREE.Vector3;
  facingTarget: THREE.Object3D;
};

type ControlVisual = {
  hitbox: THREE.Mesh;
  visual: THREE.Object3D;
  indicator?: THREE.Mesh;
  hoverRing?: THREE.Mesh;
  animateToggle: boolean;
  pressRemainingS: number;
  restPosition: THREE.Vector3;
};

/**
 * Calibrated against the original lower-left switch plate in fishing_boat.glb.
 * Keep the bank dimensions together so future asset revisions require changing
 * one measured layout instead of sixteen unrelated magic numbers.
 */
export const COCKPIT_SWITCH_BANK_LAYOUT = {
  switchX: -0.355,
  labelX: -0.292,
  labelSize: [0.09, 0.026] as const,
  labelYOffset: 0.005,
  surfaceZ: 0.120,
  rowY: [1.58028, 1.54186, 1.50388, 1.46788] as const,
  // Matches the visible brass push-button, not the complete switch row.
  hitboxSize: [0.026, 0.027, 0.04] as const,
  indicatorX: -0.23059,
  indicatorZ: 0.1245,
  indicatorRadius: 0.0085
} as const;

/** Calibrated against the five black push-buttons in the original GLB. */
export const COCKPIT_ACCESSORY_BANK_LAYOUT = {
  ids: ["navigationLights", "anchorLight", "instrumentLights", "wipers", "bilgePump"] as const,
  buttonPositions: [
    [-0.193097, 1.7089, 0.032272],
    [-0.098155, 1.7089, 0.032272],
    [0, 1.7089, 0.032272],
    [0.098155, 1.7089, 0.032272],
    [0.193097, 1.7089, 0.032272]
  ] as const,
  // The original cylinders use local Y as their axis. In fitted model space
  // their outward axis points mostly upward, with a slight aft tilt.
  surfaceNormal: [0, 0.930757, 0.365638] as const,
  surfaceOffset: 0.006,
  hitboxSize: [0.065, 0.065, 0.035] as const,
  indicatorRadius: 0.013,
  hoverInnerRadius: 0.024,
  hoverOuterRadius: 0.029,
  pressDepth: 0.006,
  pressDurationS: 0.13
} as const;

/** Calibrated against the two original knobs embedded in Cube.017 (radio). */
export const COCKPIT_RADIO_KNOB_LAYOUT = {
  ids: ["radioPowerVolume", "radioTuning"] as const,
  positions: [
    [-0.1395, 1.9125, -0.27],
    [0.1395, 1.9125, -0.27]
  ] as const,
  surfaceNormal: [0, 0, 1] as const,
  surfaceOffset: 0.006,
  hitboxSize: [0.072, 0.072, 0.04] as const,
  indicatorRadius: 0.011,
  hoverInnerRadius: 0.026,
  hoverOuterRadius: 0.031,
  pressDepth: 0.004,
  pressDurationS: 0.12
} as const;

/** Calibrated against the six small circles along the bottom of Cube.017. */
export const COCKPIT_RADIO_FREQUENCY_LAYOUT = {
  positions: [
    [-0.078425, 1.871087, -0.283],
    [-0.047413, 1.871087, -0.283],
    [-0.016761, 1.871087, -0.283],
    [0.016761, 1.871087, -0.283],
    [0.047413, 1.871087, -0.283],
    [0.078425, 1.871087, -0.283]
  ] as const,
  stationCount: RADIO_STATION_COUNT,
  indicatorRadius: 0.0052,
  activeColor: 0x36d982,
  activeIntensity: 2.2
} as const;

/** Measured from the six original circular recesses in Cylinder.022. */
export const COCKPIT_INSTRUMENT_LAYOUT = {
  surfaceNormal: [0, 0.93266, 0.360755] as const,
  surfaceOffset: 0.0008,
  layerSpacing: 0.0004,
  gaugeRadius: 0.0315,
  lowerRadius: 0.041,
  gauges: [
    { key: "rpm", label: "RPM", minimum: 0, maximum: 3000, scaleMinimum: "0", scaleMaximum: "3000", position: [-0.176157, 1.801142, -0.221605] },
    { key: "speedKnots", label: "KN", minimum: 0, maximum: 40, scaleMinimum: "0", scaleMaximum: "40", position: [-0.058104, 1.801142, -0.221605] },
    { key: "fuel", label: "FUEL", minimum: 0, maximum: 1, scaleMinimum: "0", scaleMaximum: "100", position: [0.058104, 1.801142, -0.221605] },
    { key: "engineTemperatureC", label: "°C", minimum: 20, maximum: 120, scaleMinimum: "20", scaleMaximum: "120", position: [0.176157, 1.801142, -0.221605] }
  ] as const,
  compassPosition: [-0.116368, 1.765495, -0.116792] as const,
  radarPosition: [0.116368, 1.765495, -0.116792] as const,
  radarRangeMeters: 500,
  radarSweepRpm: 24,
  radarPlotRadiusRatio: 0.76
} as const;

const ACCESSORY_SWITCH_IDS = new Set<CockpitControlId>(COCKPIT_ACCESSORY_BANK_LAYOUT.ids);
const ACCESSORY_SURFACE_NORMAL = new THREE.Vector3(
  ...COCKPIT_ACCESSORY_BANK_LAYOUT.surfaceNormal
).normalize();
const ACCESSORY_SURFACE_QUATERNION = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1),
  ACCESSORY_SURFACE_NORMAL
);
const RADIO_KNOB_IDS = new Set<CockpitControlId>(COCKPIT_RADIO_KNOB_LAYOUT.ids);
const RADIO_SURFACE_NORMAL = new THREE.Vector3(...COCKPIT_RADIO_KNOB_LAYOUT.surfaceNormal);
const RADIO_SURFACE_QUATERNION = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1),
  RADIO_SURFACE_NORMAL
);
const INSTRUMENT_SURFACE_QUATERNION = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(...COCKPIT_INSTRUMENT_LAYOUT.surfaceNormal).normalize()
);
const INSTRUMENT_SURFACE_NORMAL = new THREE.Vector3(
  ...COCKPIT_INSTRUMENT_LAYOUT.surfaceNormal
).normalize();

function accessorySwitchPosition(id: CockpitControlId): [number, number, number] {
  const index = COCKPIT_ACCESSORY_BANK_LAYOUT.ids.indexOf(
    id as (typeof COCKPIT_ACCESSORY_BANK_LAYOUT.ids)[number]
  );
  const position = COCKPIT_ACCESSORY_BANK_LAYOUT.buttonPositions[Math.max(0, index)];
  return [position[0], position[1], position[2]];
}

function radioKnobPosition(id: CockpitControlId): [number, number, number] {
  const index = COCKPIT_RADIO_KNOB_LAYOUT.ids.indexOf(
    id as (typeof COCKPIT_RADIO_KNOB_LAYOUT.ids)[number]
  );
  const position = COCKPIT_RADIO_KNOB_LAYOUT.positions[Math.max(0, index)];
  return [position[0], position[1], position[2]];
}

const LOWER_SWITCH_IDS = new Set<CockpitControlId>([
  "engine",
  "cabinLight",
  "workLight",
  "horn"
]);

function lowerSwitchPosition(row: number): [number, number, number] {
  return [
    COCKPIT_SWITCH_BANK_LAYOUT.switchX,
    COCKPIT_SWITCH_BANK_LAYOUT.rowY[row] ?? COCKPIT_SWITCH_BANK_LAYOUT.rowY[0],
    COCKPIT_SWITCH_BANK_LAYOUT.surfaceZ
  ];
}

type ControlDefinition = InteractionTarget & {
  position: [number, number, number];
  panelLabel?: string;
};

const CONTROL_DEFINITIONS: ControlDefinition[] = [
  { id: "engine", label: "Motor", panelLabel: "ENGINE", clickLabel: "Encender / apagar", position: lowerSwitchPosition(0) },
  { id: "cabinLight", label: "Luz de cabina", panelLabel: "CABIN", clickLabel: "Encender / apagar", position: lowerSwitchPosition(1) },
  { id: "workLight", label: "Foco de proa", panelLabel: "PROA", clickLabel: "Encender / apagar", position: lowerSwitchPosition(2) },
  { id: "horn", label: "Bocina", panelLabel: "HORN", clickLabel: "Mantener pulsado", position: lowerSwitchPosition(3) },
  { id: "navigationLights", label: "Luces de navegación", clickLabel: "Alternar", position: accessorySwitchPosition("navigationLights") },
  { id: "anchorLight", label: "Luz de fondeo", clickLabel: "Alternar", position: accessorySwitchPosition("anchorLight") },
  { id: "instrumentLights", label: "Iluminación de instrumentos", clickLabel: "Alternar", position: accessorySwitchPosition("instrumentLights") },
  { id: "wipers", label: "Limpiaparabrisas", clickLabel: "Alternar", position: accessorySwitchPosition("wipers") },
  { id: "bilgePump", label: "Bomba de achique", clickLabel: "Alternar", position: accessorySwitchPosition("bilgePump") },
  { id: "radioPowerVolume", label: "Radio / volumen", clickLabel: "Click: encender", wheelLabel: "Rueda: volumen", position: radioKnobPosition("radioPowerVolume") },
  { id: "radioTuning", label: "Sintonía", clickLabel: "", wheelLabel: "Rueda: emisora", position: radioKnobPosition("radioTuning") },
];

export class CockpitRig {
  private readonly model: THREE.Object3D;
  private readonly controlRaycastObjects: THREE.Object3D[] = [];
  private readonly controls = new Map<CockpitControlId, ControlVisual>();
  private readonly stationSockets = new Map<StationId, THREE.Object3D>();
  private readonly stationZones: StationZoneDescriptor[] = [];
  private readonly gaugeNeedles: THREE.Object3D[] = [];
  private readonly ownedTextures: THREE.Texture[] = [];
  private readonly amberFaceMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly compassCard = new THREE.Group();
  private readonly radarSweepPivot = new THREE.Group();
  private readonly radarProjection: RadarProjection = { x: 0, y: 0, distance: 0, visible: false };
  private readonly radarBlipMaterial = new THREE.MeshBasicMaterial({
    color: 0x44f2a1,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false
  });
  private readonly radarSweepMaterial = new THREE.MeshBasicMaterial({
    color: 0x45d890,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false
  });
  private readonly radarBlip = new THREE.Mesh(
    new THREE.CircleGeometry(0.0035, 16),
    this.radarBlipMaterial
  );
  private radarFaceMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly radioFrequencyIndicators: THREE.Mesh[] = [];
  private readonly instrumentNeedleMaterial = new THREE.MeshStandardMaterial({
    color: 0x9d3821,
    emissive: 0xff8a3d,
    emissiveIntensity: 0.08,
    roughness: 0.45
  });
  private readonly wiperPivot = new THREE.Group();
  private readonly wetGlass: THREE.Mesh;
  private readonly bilgeWater: THREE.Mesh;
  private readonly cabinLight = new THREE.PointLight(0xffe7ba, 0, 4.5, 1.8);
  private readonly navPort = new THREE.PointLight(0xff2038, 0, 5, 2);
  private readonly navStarboard = new THREE.PointLight(0x35ff89, 0, 5, 2);
  private readonly anchorLight = new THREE.PointLight(0xf5f7ff, 0, 7, 2);
  private highlighted: THREE.Object3D | null = null;
  private highlightedControl: CockpitControlId | null = null;
  private wiperPhase = 0;
  private instrumentLightLevel = 0;
  private compassRotationRad = 0;

  private constructor(model: THREE.Object3D) {
    this.model = model;
    this.wetGlass = this.createWetGlass();
    this.bilgeWater = this.createBilgeWater();
    this.createControls();
    this.createRadioFrequencyIndicators();
    this.createStations();
    this.createInstruments();
    this.createLightsAndEffects();
  }

  static bind(model: THREE.Object3D): CockpitRig {
    return new CockpitRig(model);
  }

  dispose(): void {
    this.ownedTextures.forEach((texture) => texture.dispose());
    this.ownedTextures.length = 0;
  }

  getControlRaycastObjects(): THREE.Object3D[] {
    return this.controlRaycastObjects;
  }

  getStationZones(): readonly StationZoneDescriptor[] {
    return this.stationZones;
  }

  resolveHit(object: THREE.Object3D): CockpitHit | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      const hit = current.userData.cockpitHit as CockpitHit | undefined;
      if (hit) return hit;
      current = current.parent;
    }
    return null;
  }

  getStationPosition(station: StationId, boatRoot: THREE.Object3D, target: THREE.Vector3): THREE.Vector3 | null {
    const socket = this.stationSockets.get(station);
    if (!socket) return null;
    socket.getWorldPosition(target);
    return boatRoot.worldToLocal(target);
  }

  getStationWorldPosition(station: StationId, target: THREE.Vector3): THREE.Vector3 | null {
    const socket = this.stationSockets.get(station);
    if (!socket) return null;
    return socket.getWorldPosition(target);
  }

  setHighlighted(object: THREE.Object3D | null): void {
    if (this.highlighted === object) return;
    this.highlighted = object;
    this.highlightedControl = object ? this.resolveHit(object)?.target.id ?? null : null;
  }

  triggerControlPress(id: CockpitControlId): void {
    const control = this.controls.get(id);
    if (!control) return;
    if (ACCESSORY_SWITCH_IDS.has(id)) {
      control.pressRemainingS = COCKPIT_ACCESSORY_BANK_LAYOUT.pressDurationS;
    } else if (RADIO_KNOB_IDS.has(id)) {
      control.pressRemainingS = COCKPIT_RADIO_KNOB_LAYOUT.pressDurationS;
    }
  }

  update(state: BoatSystemsState, precipitation: number, deltaSeconds: number): void {
    const active = (id: CockpitControlId): boolean => {
      switch (id) {
        case "engine": return state.engine !== "off";
        case "cabinLight": return state.cabinLight;
        case "workLight": return state.workLight;
        case "horn": return state.horn;
        case "navigationLights": return state.navigationLights;
        case "anchorLight": return state.anchorLight;
        case "instrumentLights": return state.instrumentLights;
        case "wipers": return state.wipers;
        case "bilgePump": return state.bilgePump;
        case "radioPowerVolume": return state.radio.powered;
        case "radioTuning": return state.radio.powered;
        default: return false;
      }
    };
    for (const [id, control] of this.controls) {
      const on = active(id);
      if (control.animateToggle) {
        control.visual.rotation.x += ((on ? -0.28 : 0) - control.visual.rotation.x) * (1 - Math.exp(-deltaSeconds * 14));
      }
      const material = control.indicator?.material as THREE.MeshStandardMaterial | undefined;
      if (material) {
        const usesIntegratedIndicator = ACCESSORY_SWITCH_IDS.has(id) || RADIO_KNOB_IDS.has(id);
        material.emissive.set(on ? (usesIntegratedIndicator ? 0x36d982 : 0x58ff9a) : 0x06120a);
        material.emissiveIntensity = on ? (usesIntegratedIndicator ? 2.2 : 4) : 0.15;
      }
      const hoverMaterial = control.hoverRing?.material as THREE.MeshBasicMaterial | undefined;
      if (hoverMaterial) {
        const targetOpacity = this.highlightedControl === id ? 0.56 : 0;
        hoverMaterial.opacity += (targetOpacity - hoverMaterial.opacity) * (1 - Math.exp(-deltaSeconds * 18));
      }
      const isAccessorySwitch = ACCESSORY_SWITCH_IDS.has(id);
      const isRadioKnob = RADIO_KNOB_IDS.has(id);
      if (isAccessorySwitch || isRadioKnob) {
        const durationS = isAccessorySwitch
          ? COCKPIT_ACCESSORY_BANK_LAYOUT.pressDurationS
          : COCKPIT_RADIO_KNOB_LAYOUT.pressDurationS;
        const depth = isAccessorySwitch
          ? COCKPIT_ACCESSORY_BANK_LAYOUT.pressDepth
          : COCKPIT_RADIO_KNOB_LAYOUT.pressDepth;
        const axis = isAccessorySwitch ? ACCESSORY_SURFACE_NORMAL : RADIO_SURFACE_NORMAL;
        control.pressRemainingS = Math.max(0, control.pressRemainingS - deltaSeconds);
        const elapsed = durationS - control.pressRemainingS;
        const progress = THREE.MathUtils.clamp(elapsed / durationS, 0, 1);
        const travel = control.pressRemainingS > 0
          ? Math.sin(progress * Math.PI) * depth
          : 0;
        control.visual.position
          .copy(control.restPosition)
          .addScaledVector(axis, -travel);
      }
    }

    this.radioFrequencyIndicators.forEach((indicator, index) => {
      const material = indicator.material as THREE.MeshStandardMaterial;
      const targetIntensity = state.radio.powered && state.radio.station === index + 1
        ? COCKPIT_RADIO_FREQUENCY_LAYOUT.activeIntensity
        : 0;
      material.emissiveIntensity +=
        (targetIntensity - material.emissiveIntensity) * (1 - Math.exp(-deltaSeconds * 14));
    });

    const instrumentTarget = state.instrumentLights ? 1 : 0;
    this.instrumentLightLevel +=
      (instrumentTarget - this.instrumentLightLevel) * (1 - Math.exp(-deltaSeconds * 8));
    this.amberFaceMaterials.forEach((material) => {
      material.emissiveIntensity = this.instrumentLightLevel * 2.1;
    });
    if (this.radarFaceMaterial) {
      this.radarFaceMaterial.emissiveIntensity = this.instrumentLightLevel * 2.25;
      this.radarFaceMaterial.color.setScalar(0.04 + this.instrumentLightLevel * 0.58);
    }
    this.instrumentNeedleMaterial.emissiveIntensity = 0.08 + this.instrumentLightLevel * 2.8;

    const readings = state.instruments;
    this.updateGaugeNeedle(0, readings.rpm, deltaSeconds);
    this.updateGaugeNeedle(1, readings.speedKnots, deltaSeconds);
    this.updateGaugeNeedle(2, readings.fuel, deltaSeconds);
    this.updateGaugeNeedle(3, readings.engineTemperatureC, deltaSeconds);

    const compassTarget = headingToCompassAngle(state.navigation.headingDeg);
    this.compassRotationRad = smoothWrappedAngle(
      this.compassRotationRad,
      compassTarget,
      1 - Math.exp(-deltaSeconds * 8)
    );
    this.compassCard.rotation.z = this.compassRotationRad;

    if (state.instrumentLights) {
      this.radarSweepPivot.rotation.z -= deltaSeconds * COCKPIT_INSTRUMENT_LAYOUT.radarSweepRpm
        * Math.PI * 2 / 60;
    }
    this.radarSweepMaterial.opacity = this.instrumentLightLevel * 0.55;
    this.radarBlipMaterial.opacity = this.instrumentLightLevel * 0.95;
    projectWorldTargetToHeadUpRadar(
      state.navigation.worldX,
      state.navigation.worldZ,
      state.navigation.headingDeg,
      0,
      0,
      COCKPIT_INSTRUMENT_LAYOUT.radarRangeMeters,
      this.radarProjection
    );
    const radarPlotRadius = COCKPIT_INSTRUMENT_LAYOUT.lowerRadius
      * COCKPIT_INSTRUMENT_LAYOUT.radarPlotRadiusRatio;
    this.radarBlip.position.set(
      this.radarProjection.x * radarPlotRadius,
      this.radarProjection.y * radarPlotRadius,
      COCKPIT_INSTRUMENT_LAYOUT.layerSpacing * 4
    );
    this.radarBlip.visible = this.instrumentLightLevel > 0.01 && this.radarProjection.visible;

    if (state.wipers) this.wiperPhase += deltaSeconds * 4.4;
    this.wiperPivot.rotation.z = state.wipers ? Math.sin(this.wiperPhase) * 0.72 : 0;
    const wetMaterial = this.wetGlass.material as THREE.MeshStandardMaterial;
    wetMaterial.opacity = THREE.MathUtils.clamp(precipitation * (state.wipers ? 0.14 : 0.42), 0, 0.42);
    this.wetGlass.visible = wetMaterial.opacity > 0.01;

    this.bilgeWater.position.y = 0.48 + state.bilgeLevel * 0.42;
    this.bilgeWater.visible = state.bilgeLevel > 0.01;
    this.cabinLight.intensity = state.cabinLight ? 2.8 : 0;
    this.navPort.intensity = state.navigationLights ? 3 : 0;
    this.navStarboard.intensity = state.navigationLights ? 3 : 0;
    this.anchorLight.intensity = state.anchorLight ? 3.5 : 0;
  }

  private createControls(): void {
    const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.001, depthWrite: false });
    for (const definition of CONTROL_DEFINITIONS) {
      const isRadioKnob = definition.id === "radioPowerVolume" || definition.id === "radioTuning";
      const isLowerSwitch = LOWER_SWITCH_IDS.has(definition.id);
      const isAccessorySwitch = ACCESSORY_SWITCH_IDS.has(definition.id);
      const isIntegratedControl = isAccessorySwitch || isRadioKnob;
      let visual: THREE.Object3D;
      if (isLowerSwitch) {
        visual = this.createPanelLabel(
          definition.panelLabel ?? definition.label,
          definition.position[1]
        );
      } else if (isIntegratedControl) {
        const surfaceNormal = isAccessorySwitch ? ACCESSORY_SURFACE_NORMAL : RADIO_SURFACE_NORMAL;
        const surfaceOffset = isAccessorySwitch
          ? COCKPIT_ACCESSORY_BANK_LAYOUT.surfaceOffset
          : COCKPIT_RADIO_KNOB_LAYOUT.surfaceOffset;
        visual = new THREE.Group();
        visual.position
          .set(...definition.position)
          .addScaledVector(surfaceNormal, surfaceOffset);
        visual.quaternion.copy(
          isAccessorySwitch ? ACCESSORY_SURFACE_QUATERNION : RADIO_SURFACE_QUATERNION
        );
      } else {
        const geometry = new THREE.BoxGeometry(0.085, 0.045, 0.045);
        const visualMaterial = new THREE.MeshStandardMaterial({
          color: 0xd8dfdf,
          metalness: 0.18,
          roughness: 0.35
        });
        const mesh = new THREE.Mesh(geometry, visualMaterial);
        mesh.position.set(...definition.position);
        visual = mesh;
      }
      visual.name = `Cabin control ${definition.id}`;
      visual.userData.excludeFromCollider = true;
      this.model.add(visual);

      const hitboxGeometry = isLowerSwitch
        ? new THREE.BoxGeometry(...COCKPIT_SWITCH_BANK_LAYOUT.hitboxSize)
        : isAccessorySwitch
          ? new THREE.BoxGeometry(...COCKPIT_ACCESSORY_BANK_LAYOUT.hitboxSize)
          : isRadioKnob
            ? new THREE.BoxGeometry(...COCKPIT_RADIO_KNOB_LAYOUT.hitboxSize)
            : new THREE.BoxGeometry(0.11, 0.09, 0.1);
      const hitbox = new THREE.Mesh(hitboxGeometry, hitMaterial);
      hitbox.position.set(...definition.position);
      if (isIntegratedControl) {
        hitbox.quaternion.copy(
          isAccessorySwitch ? ACCESSORY_SURFACE_QUATERNION : RADIO_SURFACE_QUATERNION
        );
      }
      hitbox.userData.cockpitHit = { kind: "control", target: definition } satisfies CockpitHit;
      hitbox.userData.excludeFromCollider = true;
      this.model.add(hitbox);
      this.controlRaycastObjects.push(hitbox);

      let indicator: THREE.Mesh | undefined;
      let hoverRing: THREE.Mesh | undefined;
      const indicatorGeometry = isIntegratedControl
        ? new THREE.SphereGeometry(
            isAccessorySwitch
              ? COCKPIT_ACCESSORY_BANK_LAYOUT.indicatorRadius
              : COCKPIT_RADIO_KNOB_LAYOUT.indicatorRadius,
            20,
            12
          )
        : isLowerSwitch
          ? new THREE.CircleGeometry(COCKPIT_SWITCH_BANK_LAYOUT.indicatorRadius, 18)
          : new THREE.SphereGeometry(0.012, 10, 8);
      indicator = new THREE.Mesh(
        indicatorGeometry,
        new THREE.MeshStandardMaterial({ color: 0x111713, emissive: 0x06120a, roughness: 0.5 })
      );
      if (isIntegratedControl) {
        visual.add(indicator);
        const hoverInnerRadius = isAccessorySwitch
          ? COCKPIT_ACCESSORY_BANK_LAYOUT.hoverInnerRadius
          : COCKPIT_RADIO_KNOB_LAYOUT.hoverInnerRadius;
        const hoverOuterRadius = isAccessorySwitch
          ? COCKPIT_ACCESSORY_BANK_LAYOUT.hoverOuterRadius
          : COCKPIT_RADIO_KNOB_LAYOUT.hoverOuterRadius;
        hoverRing = new THREE.Mesh(
          new THREE.TorusGeometry(
            (hoverInnerRadius + hoverOuterRadius) / 2,
            (hoverOuterRadius - hoverInnerRadius) / 2,
            8,
            28
          ),
          new THREE.MeshBasicMaterial({
            color: 0xa9c8bb,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false
          })
        );
        hoverRing.position.z = 0.008;
        hoverRing.userData.excludeFromCollider = true;
        visual.add(hoverRing);
      } else if (isLowerSwitch) {
        indicator.position.set(
          COCKPIT_SWITCH_BANK_LAYOUT.indicatorX,
          definition.position[1],
          COCKPIT_SWITCH_BANK_LAYOUT.indicatorZ
        );
      } else {
        indicator.position.copy(visual.position).add(new THREE.Vector3(0.065, 0, 0.025));
      }
      indicator.userData.excludeFromCollider = true;
      if (!isIntegratedControl) this.model.add(indicator);
      this.controls.set(definition.id, {
        hitbox,
        visual,
        indicator,
        hoverRing,
        animateToggle: !isLowerSwitch && !isIntegratedControl,
        pressRemainingS: 0,
        restPosition: visual.position.clone()
      });
    }
  }

  private createRadioFrequencyIndicators(): void {
    const geometry = new THREE.CircleGeometry(COCKPIT_RADIO_FREQUENCY_LAYOUT.indicatorRadius, 18);
    COCKPIT_RADIO_FREQUENCY_LAYOUT.positions
      .slice(0, COCKPIT_RADIO_FREQUENCY_LAYOUT.stationCount)
      .forEach((position, index) => {
        const indicator = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: 0x08110c,
            emissive: COCKPIT_RADIO_FREQUENCY_LAYOUT.activeColor,
            emissiveIntensity: 0,
            roughness: 0.45
          })
        );
        indicator.name = `Radio frequency indicator ${index + 1}`;
        indicator.position.set(position[0], position[1], position[2]);
        indicator.userData.excludeFromCollider = true;
        this.model.add(indicator);
        this.radioFrequencyIndicators.push(indicator);
      });
  }

  private createPanelLabel(text: string, y: number): THREE.Mesh {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#171611";
      context.font = "900 76px 'Arial Narrow', Arial, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text, canvas.width / 2, canvas.height / 2 - 5);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    this.ownedTextures.push(texture);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.04,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2
    });
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(...COCKPIT_SWITCH_BANK_LAYOUT.labelSize),
      material
    );
    label.position.set(
      COCKPIT_SWITCH_BANK_LAYOUT.labelX,
      y + COCKPIT_SWITCH_BANK_LAYOUT.labelYOffset,
      COCKPIT_SWITCH_BANK_LAYOUT.surfaceZ
    );
    label.userData.excludeFromCollider = true;
    return label;
  }

  private createStations(): void {
    // Move the camera ~17 cm closer in fitted boat space so every dashboard
    // control is comfortably reachable while preserving the safe walk pose.
    this.createStation("helm", [-0.02, 0.62, 0.72], [0.12, 1.55, 0.2], [1.2, 2.2, 1.1]);
    this.createStation("fishing", [0.28, 0.62, -3.2], [0.3, 1.65, -3.88], [1.2, 2.2, 1.1]);
  }

  private createStation(id: StationId, socketPosition: [number, number, number], hitPosition: [number, number, number], size: [number, number, number]): void {
    const socket = new THREE.Object3D();
    socket.name = `${id} station socket`;
    socket.position.set(...socketPosition);
    this.model.add(socket);
    this.stationSockets.set(id, socket);

    const volume = new THREE.Object3D();
    volume.name = `${id} station proximity zone`;
    // The detector evaluates the eye/camera position, while sockets store the
    // controller's feet position. Center the zone at the visible controls.
    volume.position.set(socketPosition[0], hitPosition[1], socketPosition[2]);
    const facingTarget = new THREE.Object3D();
    facingTarget.name = `${id} station facing target`;
    facingTarget.position.set(...hitPosition);
    this.model.add(volume, facingTarget);
    this.stationZones.push({ id, volume, size: new THREE.Vector3(...size), facingTarget });
  }

  private createInstruments(): void {
    for (const gauge of COCKPIT_INSTRUMENT_LAYOUT.gauges) {
      const root = this.createInstrumentRoot(gauge.position, `Cockpit gauge ${gauge.key}`);
      const texture = this.createGaugeTexture(
        gauge.label,
        gauge.scaleMinimum,
        gauge.scaleMaximum
      );
      const material = this.createInstrumentFaceMaterial(texture, 0xff9a45);
      this.amberFaceMaterials.push(material);
      root.add(new THREE.Mesh(
        new THREE.CircleGeometry(COCKPIT_INSTRUMENT_LAYOUT.gaugeRadius, 48),
        material
      ));

      const needle = this.createNeedle(COCKPIT_INSTRUMENT_LAYOUT.gaugeRadius);
      needle.rotation.z = gaugeValueToAngle(gauge.minimum, gauge.minimum, gauge.maximum);
      root.add(needle);
      this.gaugeNeedles.push(needle);
    }

    const compassRoot = this.createInstrumentRoot(
      COCKPIT_INSTRUMENT_LAYOUT.compassPosition,
      "Marine compass"
    );
    const compassTexture = this.createCompassTexture();
    const compassMaterial = this.createInstrumentFaceMaterial(compassTexture, 0xff9a45);
    this.amberFaceMaterials.push(compassMaterial);
    const compassFace = new THREE.Mesh(
      new THREE.CircleGeometry(COCKPIT_INSTRUMENT_LAYOUT.lowerRadius, 64),
      compassMaterial
    );
    this.compassCard.name = "Rotating true-north compass card";
    this.compassCard.add(compassFace);
    compassRoot.add(this.compassCard);

    const lubberLine = new THREE.Mesh(
      new THREE.BoxGeometry(0.0024, COCKPIT_INSTRUMENT_LAYOUT.lowerRadius * 0.2, 0.001),
      this.instrumentNeedleMaterial
    );
    lubberLine.name = "Compass fixed lubber line";
    lubberLine.position.set(
      0,
      COCKPIT_INSTRUMENT_LAYOUT.lowerRadius * 0.76,
      COCKPIT_INSTRUMENT_LAYOUT.layerSpacing * 3
    );
    compassRoot.add(lubberLine);

    const radarRoot = this.createInstrumentRoot(
      COCKPIT_INSTRUMENT_LAYOUT.radarPosition,
      "Head-up test radar"
    );
    const radarTexture = this.createRadarTexture();
    this.radarFaceMaterial = this.createInstrumentFaceMaterial(radarTexture, 0x35d889);
    const radarFace = new THREE.Mesh(
      new THREE.CircleGeometry(COCKPIT_INSTRUMENT_LAYOUT.lowerRadius, 64),
      this.radarFaceMaterial
    );
    radarRoot.add(radarFace);

    const sweepLength = COCKPIT_INSTRUMENT_LAYOUT.lowerRadius
      * COCKPIT_INSTRUMENT_LAYOUT.radarPlotRadiusRatio;
    const sweep = new THREE.Mesh(
      new THREE.BoxGeometry(0.0014, sweepLength, 0.0008),
      this.radarSweepMaterial
    );
    sweep.position.set(0, sweepLength * 0.5, COCKPIT_INSTRUMENT_LAYOUT.layerSpacing * 3);
    this.radarSweepPivot.name = "Radar 24 rpm sweep";
    this.radarSweepPivot.add(sweep);
    radarRoot.add(this.radarSweepPivot);

    this.radarBlip.name = "Radar world origin blip";
    this.radarBlip.position.z = COCKPIT_INSTRUMENT_LAYOUT.layerSpacing * 4;
    this.radarBlip.visible = false;
    radarRoot.add(this.radarBlip);
  }

  private createInstrumentRoot(
    position: readonly [number, number, number],
    name: string
  ): THREE.Group {
    const root = new THREE.Group();
    root.name = name;
    root.position
      .set(position[0], position[1], position[2])
      .addScaledVector(INSTRUMENT_SURFACE_NORMAL, COCKPIT_INSTRUMENT_LAYOUT.surfaceOffset);
    root.quaternion.copy(INSTRUMENT_SURFACE_QUATERNION);
    root.userData.excludeFromCollider = true;
    this.model.add(root);
    return root;
  }

  private createNeedle(radius: number): THREE.Group {
    const pivot = new THREE.Group();
    const length = radius * 0.68;
    const needle = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 0.075, length, 0.001),
      this.instrumentNeedleMaterial
    );
    needle.position.set(0, length * 0.5, COCKPIT_INSTRUMENT_LAYOUT.layerSpacing * 2);
    const hub = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.105, 18),
      this.instrumentNeedleMaterial
    );
    hub.position.z = COCKPIT_INSTRUMENT_LAYOUT.layerSpacing * 3;
    pivot.add(needle, hub);
    pivot.userData.excludeFromCollider = true;
    return pivot;
  }

  private createInstrumentFaceMaterial(
    texture: THREE.CanvasTexture,
    emissiveColor: number
  ): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: 0x8b8983,
      map: texture,
      emissive: emissiveColor,
      emissiveMap: texture,
      emissiveIntensity: 0,
      metalness: 0.08,
      roughness: 0.72,
      polygonOffset: true,
      polygonOffsetFactor: -1
    });
  }

  private createGaugeTexture(
    label: string,
    scaleMinimum: string,
    scaleMaximum: string
  ): THREE.CanvasTexture {
    return this.createInstrumentTexture((context, size) => {
      const center = size / 2;
      context.fillStyle = "#050807";
      context.beginPath();
      context.arc(center, center, center, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "#765536";
      context.lineCap = "round";
      for (let index = 0; index <= 20; index += 1) {
        const progress = index / 20;
        const angle = 3 * Math.PI / 4 - progress * 3 * Math.PI / 2;
        const major = index % 5 === 0;
        const outer = size * 0.43;
        const inner = size * (major ? 0.31 : 0.35);
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        context.lineWidth = major ? size * 0.018 : size * 0.009;
        context.beginPath();
        context.moveTo(center - sin * inner, center - cos * inner);
        context.lineTo(center - sin * outer, center - cos * outer);
        context.stroke();
      }
      context.fillStyle = "#9a6c42";
      context.font = `700 ${Math.round(size * (label.length > 3 ? 0.105 : 0.125))}px Arial`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, center, size * 0.62);
      context.font = `700 ${Math.round(size * 0.065)}px Arial`;
      context.fillText(scaleMinimum, size * 0.26, size * 0.76);
      context.fillText(scaleMaximum, size * 0.74, size * 0.76);
    });
  }

  private createCompassTexture(): THREE.CanvasTexture {
    return this.createInstrumentTexture((context, size) => {
      const center = size / 2;
      context.fillStyle = "#050807";
      context.beginPath();
      context.arc(center, center, center, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "#765536";
      context.fillStyle = "#a87343";
      context.lineCap = "round";
      for (let index = 0; index < 36; index += 1) {
        const angle = index * Math.PI * 2 / 36;
        const major = index % 9 === 0;
        const outer = size * 0.44;
        const inner = size * (major ? 0.32 : 0.38);
        context.lineWidth = major ? size * 0.014 : size * 0.007;
        context.beginPath();
        context.moveTo(center + Math.sin(angle) * inner, center - Math.cos(angle) * inner);
        context.lineTo(center + Math.sin(angle) * outer, center - Math.cos(angle) * outer);
        context.stroke();
      }
      context.font = `800 ${Math.round(size * 0.13)}px Arial`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      const labelRadius = size * 0.265;
      context.fillText("N", center, center - labelRadius);
      context.fillText("E", center + labelRadius, center);
      context.fillText("S", center, center + labelRadius);
      context.fillText("O", center - labelRadius, center);
      context.beginPath();
      context.arc(center, center, size * 0.035, 0, Math.PI * 2);
      context.fill();
    });
  }

  private createRadarTexture(): THREE.CanvasTexture {
    return this.createInstrumentTexture((context, size) => {
      const center = size / 2;
      const plotRadius = size * 0.5 * COCKPIT_INSTRUMENT_LAYOUT.radarPlotRadiusRatio;
      context.fillStyle = "#020807";
      context.beginPath();
      context.arc(center, center, center, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "#267955";
      context.fillStyle = "#3d9f70";
      context.lineWidth = size * 0.008;
      for (const ratio of [0.5, 1]) {
        context.beginPath();
        context.arc(center, center, plotRadius * ratio, 0, Math.PI * 2);
        context.stroke();
      }
      context.beginPath();
      context.moveTo(center - plotRadius, center);
      context.lineTo(center + plotRadius, center);
      context.moveTo(center, center - plotRadius);
      context.lineTo(center, center + plotRadius);
      context.stroke();
      context.font = `700 ${Math.round(size * 0.07)}px Arial`;
      context.textAlign = "left";
      context.textBaseline = "bottom";
      context.fillText("500m", center + size * 0.04, center - plotRadius + size * 0.08);
      context.font = `700 ${Math.round(size * 0.055)}px Arial`;
      context.fillText("250", center + size * 0.025, center - plotRadius * 0.5 + size * 0.06);
      context.beginPath();
      context.moveTo(center, center - plotRadius - size * 0.035);
      context.lineTo(center - size * 0.025, center - plotRadius + size * 0.02);
      context.lineTo(center + size * 0.025, center - plotRadius + size * 0.02);
      context.closePath();
      context.fill();
    });
  }

  private createInstrumentTexture(
    draw: (context: CanvasRenderingContext2D, size: number) => void
  ): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (context) draw(context, canvas.width);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    this.ownedTextures.push(texture);
    return texture;
  }

  private updateGaugeNeedle(
    index: number,
    value: number,
    deltaSeconds: number
  ): void {
    const needle = this.gaugeNeedles[index];
    const gauge = COCKPIT_INSTRUMENT_LAYOUT.gauges[index];
    if (!needle || !gauge) return;
    const target = gaugeValueToAngle(value, gauge.minimum, gauge.maximum);
    needle.rotation.z += (target - needle.rotation.z) * (1 - Math.exp(-deltaSeconds * 8));
  }

  private createLightsAndEffects(): void {
    this.cabinLight.position.set(0, 2.35, 0.45);
    this.navPort.position.set(-1.65, 1.55, -1.6);
    this.navStarboard.position.set(1.65, 1.55, -1.6);
    this.anchorLight.position.set(0, 5.6, -3.7);
    this.model.add(this.cabinLight, this.navPort, this.navStarboard, this.anchorLight);

    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.52, 0.025), new THREE.MeshStandardMaterial({ color: 0x101419, metalness: 0.6 }));
    blade.userData.excludeFromCollider = true;
    blade.position.y = 0.25;
    this.wiperPivot.position.set(0, 2.02, -0.25);
    this.wiperPivot.add(blade);
    this.model.add(this.wiperPivot, this.wetGlass, this.bilgeWater);
  }

  private createWetGlass(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.45, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x70a9c8, transparent: true, opacity: 0, roughness: 0.12, depthWrite: false })
    );
    mesh.position.set(0, 2.24, -0.255);
    mesh.userData.excludeFromCollider = true;
    return mesh;
  }

  private createBilgeWater(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 5.2),
      new THREE.MeshStandardMaterial({ color: 0x174e69, transparent: true, opacity: 0.48, roughness: 0.15 })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, 0.48, -0.5);
    mesh.visible = false;
    mesh.userData.excludeFromCollider = true;
    return mesh;
  }
}
