import * as THREE from "three/webgpu";
import type { BoatSystemsState } from "../gameplay/types";
import type { FlashlightCue } from "../player/PlayerFlashlight";
import { radioStations } from "../boat/radioConfig";

export class CabinAudio {
  private context: AudioContext | null = null;
  private engineOscillator: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private hornOscillator: OscillatorNode | null = null;
  private hornGain: GainNode | null = null;
  private pumpOscillator: OscillatorNode | null = null;
  private pumpGain: GainNode | null = null;
  private radioGain: GainNode | null = null;
  private radioElement: HTMLAudioElement | null = null;
  private radioMediaSource: MediaElementAudioSourceNode | null = null;
  private controlClickPanner: PannerNode | null = null;
  private controlClickBuffer: AudioBuffer | null = null;
  private readonly sourcePanners: PannerNode[] = [];
  private currentStation = 0;
  private stationLoadToken = 0;
  private disposed = false;
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempForward = new THREE.Vector3();
  private readonly tempUp = new THREE.Vector3();

  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) this.createGraph();
    if (this.context?.state === "suspended") await this.context.resume();
  }

  playFlashlightCue(cue: FlashlightCue): void {
    const context = this.context;
    if (!context || context.state !== "running") return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = cue === "charged" ? "sine" : "square";
    oscillator.frequency.setValueAtTime(cue === "charged" ? 620 : cue === "empty" ? 105 : 180, now);
    if (cue === "charged") oscillator.frequency.exponentialRampToValueAtTime(880, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(cue === "charged" ? 0.025 : 0.018, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (cue === "charged" ? 0.18 : 0.055));
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + (cue === "charged" ? 0.2 : 0.065));
  }

  playControlClick(): void {
    const context = this.context;
    if (!context || context.state !== "running" || !this.controlClickBuffer || !this.controlClickPanner) return;
    const source = context.createBufferSource();
    source.buffer = this.controlClickBuffer;
    source.connect(this.controlClickPanner);
    source.start();
  }

  update(state: BoatSystemsState, camera: THREE.Camera, boatRoot: THREE.Object3D): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    const smooth = (parameter: AudioParam | undefined, value: number, time = 0.08) => {
      if (!parameter) return;
      parameter.cancelScheduledValues(now);
      parameter.setTargetAtTime(value, now, time);
    };
    const rpm = state.instruments.rpm;
    smooth(this.engineOscillator?.frequency, 38 + rpm / 28, 0.06);
    smooth(this.engineGain?.gain, state.engine === "running" ? 0.018 + rpm / 90000 : 0, 0.12);
    smooth(this.hornGain?.gain, state.horn ? 0.1 : 0, 0.02);
    smooth(this.pumpGain?.gain, state.bilgePump ? 0.025 : 0, 0.08);
    smooth(this.radioGain?.gain, state.radio.powered ? state.radio.volume * 0.35 : 0, 0.05);
    if (state.radio.powered) {
      if (state.radio.station !== this.currentStation) {
        this.currentStation = state.radio.station;
        void this.loadStation(state.radio.station);
      } else if (this.radioElement?.paused && this.radioElement.src) {
        void this.radioElement.play().catch(() => {
          // Autoplay or transient stream errors stay silent until the next tune.
        });
      }
    } else {
      this.radioElement?.pause();
    }
    this.updateListener(camera);
    this.updatePanners(boatRoot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRadioStream();
    void this.context?.close();
    this.context = null;
    this.controlClickPanner = null;
    this.controlClickBuffer = null;
  }

  private createGraph(): void {
    const context = new AudioContext();
    this.context = context;
    const master = context.createGain();
    master.gain.value = 0.85;
    master.connect(context.destination);

    const enginePanner = this.createPanner(context, master);
    const hornPanner = this.createPanner(context, master);
    const pumpPanner = this.createPanner(context, master);
    const radioLeft = this.createPanner(context, master);
    const radioRight = this.createPanner(context, master);
    this.controlClickPanner = this.createPanner(context, master);
    this.controlClickBuffer = this.createControlClickBuffer(context);

    this.engineOscillator = context.createOscillator();
    this.engineOscillator.type = "sawtooth";
    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0;
    this.engineOscillator.connect(this.engineGain).connect(enginePanner);
    this.engineOscillator.start();

    this.hornOscillator = context.createOscillator();
    this.hornOscillator.type = "square";
    this.hornOscillator.frequency.value = 220;
    this.hornGain = context.createGain();
    this.hornGain.gain.value = 0;
    this.hornOscillator.connect(this.hornGain).connect(hornPanner);
    this.hornOscillator.start();

    this.pumpOscillator = context.createOscillator();
    this.pumpOscillator.type = "triangle";
    this.pumpOscillator.frequency.value = 74;
    this.pumpGain = context.createGain();
    this.pumpGain.gain.value = 0;
    this.pumpOscillator.connect(this.pumpGain).connect(pumpPanner);
    this.pumpOscillator.start();

    this.radioGain = context.createGain();
    this.radioGain.gain.value = 0;
    this.radioGain.connect(radioLeft);
    this.radioGain.connect(radioRight);
  }

  private createPanner(context: AudioContext, destination: AudioNode): PannerNode {
    const panner = context.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 1;
    panner.maxDistance = 45;
    panner.rolloffFactor = 1.2;
    panner.connect(destination);
    this.sourcePanners.push(panner);
    return panner;
  }

  private createControlClickBuffer(context: AudioContext): AudioBuffer {
    const durationS = 0.075;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * durationS), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) {
      const time = index / context.sampleRate;
      const firstImpact = Math.exp(-time * 95);
      const returnTime = Math.max(0, time - 0.032);
      const returnImpact = time >= 0.032 ? Math.exp(-returnTime * 125) : 0;
      const mechanicalTone = Math.sin(time * Math.PI * 2 * (460 - time * 2100));
      const returnTone = Math.sin(returnTime * Math.PI * 2 * 260);
      const noise = Math.random() * 2 - 1;
      data[index] =
        mechanicalTone * firstImpact * 0.085 +
        noise * firstImpact * 0.028 +
        returnTone * returnImpact * 0.035;
    }
    return buffer;
  }

  private ensureRadioElement(): HTMLAudioElement | null {
    const context = this.context;
    if (!context || !this.radioGain) return null;
    if (this.radioElement) return this.radioElement;

    const element = new Audio();
    element.crossOrigin = "anonymous";
    element.preload = "none";
    this.radioMediaSource = context.createMediaElementSource(element);
    this.radioMediaSource.connect(this.radioGain);
    this.radioElement = element;
    return element;
  }

  private async loadStation(station: number): Promise<void> {
    const stationConfig = radioStations[station - 1];
    const element = this.ensureRadioElement();
    if (!stationConfig || !element) return;

    const token = ++this.stationLoadToken;
    element.pause();
    element.src = stationConfig.url;
    element.load();

    try {
      await element.play();
      if (token !== this.stationLoadToken) {
        element.pause();
      }
    } catch {
      // Stream failures stay silent; tuning again retries the connection.
    }
  }

  private stopRadioStream(): void {
    this.stationLoadToken += 1;
    if (this.radioElement) {
      this.radioElement.pause();
      this.radioElement.removeAttribute("src");
      this.radioElement.load();
      this.radioElement = null;
    }
    this.radioMediaSource?.disconnect();
    this.radioMediaSource = null;
    this.currentStation = 0;
  }

  private updateListener(camera: THREE.Camera): void {
    const context = this.context;
    if (!context) return;
    camera.getWorldPosition(this.tempPosition);
    camera.getWorldDirection(this.tempForward);
    this.tempUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const listener = context.listener;
    listener.positionX.value = this.tempPosition.x;
    listener.positionY.value = this.tempPosition.y;
    listener.positionZ.value = this.tempPosition.z;
    listener.forwardX.value = this.tempForward.x;
    listener.forwardY.value = this.tempForward.y;
    listener.forwardZ.value = this.tempForward.z;
    listener.upX.value = this.tempUp.x;
    listener.upY.value = this.tempUp.y;
    listener.upZ.value = this.tempUp.z;
  }

  private updatePanners(boatRoot: THREE.Object3D): void {
    const localPositions = [
      [0, 0.8, 3.1], [0, 1.4, 2.4], [0, 0.7, 0], [-0.65, 1.9, 0], [0.65, 1.9, 0],
      [0, 1.25, 0.9]
    ];
    this.sourcePanners.forEach((panner, index) => {
      this.tempPosition.fromArray(localPositions[index] ?? [0, 1, 0]);
      boatRoot.localToWorld(this.tempPosition);
      panner.positionX.value = this.tempPosition.x;
      panner.positionY.value = this.tempPosition.y;
      panner.positionZ.value = this.tempPosition.z;
    });
  }
}
