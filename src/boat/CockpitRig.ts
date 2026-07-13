import * as THREE from "three/webgpu";
import type {
  BoatSystemsState,
  CockpitControlId,
  InteractionTarget,
  StationId
} from "../gameplay/types";

export type CockpitHit =
  | { kind: "control"; target: InteractionTarget }
  | { kind: "station"; station: StationId };

type ControlVisual = {
  hitbox: THREE.Mesh;
  visual: THREE.Object3D;
  indicator?: THREE.Mesh;
  animateToggle: boolean;
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
  { id: "navigationLights", label: "Luces de navegación", clickLabel: "Alternar", position: [-0.33, 1.7, -0.02] },
  { id: "anchorLight", label: "Luz de fondeo", clickLabel: "Alternar", position: [-0.18, 1.7, -0.02] },
  { id: "instrumentLights", label: "Iluminación de instrumentos", clickLabel: "Alternar", position: [-0.03, 1.7, -0.02] },
  { id: "wipers", label: "Limpiaparabrisas", clickLabel: "Alternar", position: [0.12, 1.7, -0.02] },
  { id: "bilgePump", label: "Bomba de achique", clickLabel: "Alternar", position: [0.27, 1.7, -0.02] },
  { id: "radioPowerVolume", label: "Radio / volumen", clickLabel: "Click: encender", wheelLabel: "Rueda: volumen", position: [-0.28, 1.9, -0.23] },
  { id: "radioTuning", label: "Sintonía", clickLabel: "", wheelLabel: "Rueda: emisora", position: [0.28, 1.9, -0.23] },
  { id: "radioPreset1", label: "Memoria 1", clickLabel: "Seleccionar", position: [-0.12, 1.82, -0.18] },
  { id: "radioPreset2", label: "Memoria 2", clickLabel: "Seleccionar", position: [-0.06, 1.82, -0.18] },
  { id: "radioPreset3", label: "Memoria 3", clickLabel: "Seleccionar", position: [0, 1.82, -0.18] },
  { id: "radioPreset4", label: "Memoria 4", clickLabel: "Seleccionar", position: [0.06, 1.82, -0.18] },
  { id: "radioPreset5", label: "Memoria 5", clickLabel: "Seleccionar", position: [0.12, 1.82, -0.18] }
];

export class CockpitRig {
  private readonly model: THREE.Object3D;
  private readonly interactionObjects: THREE.Object3D[] = [];
  private readonly controls = new Map<CockpitControlId, ControlVisual>();
  private readonly stationSockets = new Map<StationId, THREE.Object3D>();
  private readonly needles: THREE.Object3D[] = [];
  private readonly wiperPivot = new THREE.Group();
  private readonly wetGlass: THREE.Mesh;
  private readonly bilgeWater: THREE.Mesh;
  private readonly cabinLight = new THREE.PointLight(0xffe7ba, 0, 4.5, 1.8);
  private readonly navPort = new THREE.PointLight(0xff2038, 0, 5, 2);
  private readonly navStarboard = new THREE.PointLight(0x35ff89, 0, 5, 2);
  private readonly anchorLight = new THREE.PointLight(0xf5f7ff, 0, 7, 2);
  private highlighted: THREE.Object3D | null = null;
  private wiperPhase = 0;

  private constructor(model: THREE.Object3D) {
    this.model = model;
    this.wetGlass = this.createWetGlass();
    this.bilgeWater = this.createBilgeWater();
    this.createControls();
    this.createStations();
    this.createInstruments();
    this.createLightsAndEffects();
  }

  static bind(model: THREE.Object3D): CockpitRig {
    return new CockpitRig(model);
  }

  getRaycastObjects(): THREE.Object3D[] {
    return this.interactionObjects;
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

  setHighlighted(object: THREE.Object3D | null): void {
    if (this.highlighted === object) return;
    if (this.highlighted) this.highlighted.scale.setScalar(1);
    this.highlighted = object;
    if (object) object.scale.setScalar(1.08);
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
        case "radioPreset1": return state.radio.station === 1;
        case "radioPreset2": return state.radio.station === 2;
        case "radioPreset3": return state.radio.station === 3;
        case "radioPreset4": return state.radio.station === 4;
        case "radioPreset5": return state.radio.station === 5;
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
        material.emissive.set(on ? 0x58ff9a : 0x06120a);
        material.emissiveIntensity = on ? 4 : 0.15;
      }
    }

    const readings = state.instruments;
    const values = [
      readings.rpm / 2800,
      readings.speedKnots / 35,
      readings.fuel,
      (readings.engineTemperatureC - 20) / 90,
      (readings.voltage - 10) / 6,
      readings.headingDeg / 360
    ];
    this.needles.forEach((needle, index) => {
      const target = THREE.MathUtils.lerp(-2.25, 2.25, THREE.MathUtils.clamp(values[index] ?? 0, 0, 1));
      needle.rotation.z += (target - needle.rotation.z) * (1 - Math.exp(-deltaSeconds * 8));
    });

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
      const isPreset = definition.id.startsWith("radioPreset");
      const isLowerSwitch = LOWER_SWITCH_IDS.has(definition.id);
      let visual: THREE.Object3D;
      if (isLowerSwitch) {
        visual = this.createPanelLabel(
          definition.panelLabel ?? definition.label,
          definition.position[1]
        );
      } else {
        const geometry = isRadioKnob
          ? new THREE.CylinderGeometry(0.055, 0.055, 0.04, 18)
          : new THREE.BoxGeometry(isPreset ? 0.045 : 0.085, isPreset ? 0.025 : 0.045, 0.045);
        const visualMaterial = new THREE.MeshStandardMaterial({
          color: isRadioKnob ? 0x1d2938 : 0xd8dfdf,
          metalness: isRadioKnob ? 0.7 : 0.18,
          roughness: 0.35
        });
        const mesh = new THREE.Mesh(geometry, visualMaterial);
        mesh.position.set(...definition.position);
        if (isRadioKnob) mesh.rotation.x = Math.PI / 2;
        visual = mesh;
      }
      visual.name = `Cabin control ${definition.id}`;
      visual.userData.excludeFromCollider = true;
      this.model.add(visual);

      const hitboxGeometry = isLowerSwitch
        ? new THREE.BoxGeometry(...COCKPIT_SWITCH_BANK_LAYOUT.hitboxSize)
        : new THREE.BoxGeometry(isPreset ? 0.06 : 0.11, isPreset ? 0.06 : 0.09, 0.1);
      const hitbox = new THREE.Mesh(hitboxGeometry, hitMaterial);
      hitbox.position.set(...definition.position);
      hitbox.userData.cockpitHit = { kind: "control", target: definition } satisfies CockpitHit;
      hitbox.userData.excludeFromCollider = true;
      this.model.add(hitbox);
      this.interactionObjects.push(hitbox);

      let indicator: THREE.Mesh | undefined;
      if (!isRadioKnob && !isPreset) {
        const indicatorGeometry = isLowerSwitch
          ? new THREE.CircleGeometry(COCKPIT_SWITCH_BANK_LAYOUT.indicatorRadius, 18)
          : new THREE.SphereGeometry(0.012, 10, 8);
        indicator = new THREE.Mesh(
          indicatorGeometry,
          new THREE.MeshStandardMaterial({ color: 0x111713, emissive: 0x06120a, roughness: 0.5 })
        );
        if (isLowerSwitch) {
          indicator.position.set(
            COCKPIT_SWITCH_BANK_LAYOUT.indicatorX,
            definition.position[1],
            COCKPIT_SWITCH_BANK_LAYOUT.indicatorZ
          );
        } else {
          indicator.position.copy(visual.position).add(new THREE.Vector3(0.065, 0, 0.025));
        }
        indicator.userData.excludeFromCollider = true;
        this.model.add(indicator);
      }
      this.controls.set(definition.id, { hitbox, visual, indicator, animateToggle: !isLowerSwitch });
    }
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
    this.createStation("helm", [-0.02, 0.62, 0.72], [0.12, 1.55, 0.2], [0.78, 0.8, 0.45]);
    this.createStation("fishing", [0.28, 0.62, -3.2], [0.3, 1.65, -3.88], [0.7, 0.8, 0.45]);
  }

  private createStation(id: StationId, socketPosition: [number, number, number], hitPosition: [number, number, number], size: [number, number, number]): void {
    const socket = new THREE.Object3D();
    socket.name = `${id} station socket`;
    socket.position.set(...socketPosition);
    this.model.add(socket);
    this.stationSockets.set(id, socket);

    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(...size),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.001, depthWrite: false })
    );
    hitbox.position.set(...hitPosition);
    hitbox.userData.cockpitHit = { kind: "station", station: id } satisfies CockpitHit;
    hitbox.userData.excludeFromCollider = true;
    this.model.add(hitbox);
    this.interactionObjects.push(hitbox);
  }

  private createInstruments(): void {
    const positions: Array<[number, number, number]> = [
      [-0.32, 1.76, -0.09], [-0.16, 1.78, -0.11], [0, 1.79, -0.12],
      [0.16, 1.78, -0.11], [-0.24, 1.65, -0.02], [0.2, 1.65, -0.02]
    ];
    for (const position of positions) {
      const dial = new THREE.Mesh(
        new THREE.CircleGeometry(0.07, 24),
        new THREE.MeshStandardMaterial({ color: 0x101b25, metalness: 0.35, roughness: 0.3 })
      );
      dial.position.set(...position);
      dial.rotation.x = -0.16;
      dial.userData.excludeFromCollider = true;
      this.model.add(dial);
      const needle = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.052, 0.006), new THREE.MeshBasicMaterial({ color: 0xff6b3d }));
      needle.position.copy(dial.position).add(new THREE.Vector3(0, 0.025, 0.006));
      needle.rotation.x = dial.rotation.x;
      needle.userData.excludeFromCollider = true;
      this.model.add(needle);
      this.needles.push(needle);
    }
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
