import * as THREE from "three/webgpu";
import type { BoatPhysicsMetrics } from "./BoatPhysics";
import type { BoatSystemsState, CockpitControlId } from "../gameplay/types";
import { RADIO_STATION_COUNT } from "./radioConfig";

const START_DURATION_S = 0.75;
const FULL_LOAD_FUEL_SECONDS = 4 * 60 * 60;

export class BoatSystems {
  readonly state: BoatSystemsState = {
    engine: "off",
    engineStartRemainingS: 0,
    fuel: 1,
    cabinLight: false,
    workLight: false,
    navigationLights: false,
    anchorLight: false,
    instrumentLights: false,
    horn: false,
    wipers: false,
    bilgePump: false,
    bilgeLevel: 0,
    radio: { powered: false, volume: 0.5, station: 1 },
    instruments: {
      rpm: 0,
      speedKnots: 0,
      fuel: 1,
      engineTemperatureC: 20,
      voltage: 12.4,
      headingDeg: 0
    }
  };

  update(deltaSeconds: number, throttle: number, metrics: BoatPhysicsMetrics, precipitation: number): void {
    if (this.state.engine === "starting") {
      this.state.engineStartRemainingS = Math.max(0, this.state.engineStartRemainingS - deltaSeconds);
      if (this.state.engineStartRemainingS === 0) this.state.engine = "running";
    }
    if (this.state.fuel <= 0 && this.state.engine !== "off") this.stopEngine();

    const running = this.state.engine === "running";
    const load = running ? Math.abs(throttle) : 0;
    if (running) this.state.fuel = Math.max(0, this.state.fuel - deltaSeconds * (0.22 + load * 0.78) / FULL_LOAD_FUEL_SECONDS);

    const rpmTarget = running ? 750 + load * 2050 : 0;
    const rpmBlend = 1 - Math.exp(-deltaSeconds * 4.5);
    this.state.instruments.rpm += (rpmTarget - this.state.instruments.rpm) * rpmBlend;
    const temperatureTarget = running ? 72 + load * 23 : 20;
    this.state.instruments.engineTemperatureC +=
      (temperatureTarget - this.state.instruments.engineTemperatureC) * (1 - Math.exp(-deltaSeconds * 0.08));
    this.state.instruments.speedKnots = metrics.speedMs * 1.94384;
    this.state.instruments.fuel = this.state.fuel;
    this.state.instruments.voltage = running ? 14.2 : 12.4;
    this.state.instruments.headingDeg = (metrics.headingDeg + 360) % 360;

    const rainIngress = THREE.MathUtils.clamp(precipitation, 0, 1) * 0.00045;
    const capsizeIngress = metrics.capsized ? 0.08 : 0;
    const pumpDrain = this.state.bilgePump ? 0.03 : 0;
    this.state.bilgeLevel = THREE.MathUtils.clamp(
      this.state.bilgeLevel + (rainIngress + capsizeIngress - pumpDrain) * deltaSeconds,
      0,
      1
    );
  }

  activate(id: CockpitControlId): boolean {
    switch (id) {
      case "engine":
        if (this.state.engine === "off" && this.state.fuel > 0) {
          this.state.engine = "starting";
          this.state.engineStartRemainingS = START_DURATION_S;
        } else {
          this.stopEngine();
        }
        return true;
      case "cabinLight": this.state.cabinLight = !this.state.cabinLight; return true;
      case "workLight": this.state.workLight = !this.state.workLight; return true;
      case "navigationLights": this.state.navigationLights = !this.state.navigationLights; return true;
      case "anchorLight": this.state.anchorLight = !this.state.anchorLight; return true;
      case "instrumentLights": this.state.instrumentLights = !this.state.instrumentLights; return true;
      case "wipers": this.state.wipers = !this.state.wipers; return true;
      case "bilgePump": this.state.bilgePump = !this.state.bilgePump; return true;
      case "radioPowerVolume": this.state.radio.powered = !this.state.radio.powered; return true;
      default: return false;
    }
  }

  adjust(id: CockpitControlId, wheelSteps: number): boolean {
    if (wheelSteps === 0) return false;
    if (id === "radioPowerVolume") {
      this.state.radio.volume = THREE.MathUtils.clamp(this.state.radio.volume - wheelSteps * 0.05, 0, 1);
      return true;
    }
    if (id === "radioTuning") {
      const direction = wheelSteps > 0 ? 1 : -1;
      this.state.radio.station = (
        (this.state.radio.station - 1 + direction + RADIO_STATION_COUNT) % RADIO_STATION_COUNT
      ) + 1;
      return true;
    }
    return false;
  }

  setHorn(active: boolean): void {
    this.state.horn = active;
  }

  stopEngine(): void {
    this.state.engine = "off";
    this.state.engineStartRemainingS = 0;
  }

  refuel(): void {
    this.state.fuel = 1;
  }
}
