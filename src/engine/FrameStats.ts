export class FrameStats {
  private frames = 0;
  private elapsedMs = 0;
  private fpsValue = 0;
  private frameMsValue = 0;
  private cpuMsValue = 0;

  begin(): number {
    return performance.now();
  }

  end(startMs: number, deltaMs: number): void {
    const cpuMs = performance.now() - startMs;
    this.frames += 1;
    this.elapsedMs += deltaMs;
    this.frameMsValue = this.frameMsValue * 0.92 + deltaMs * 0.08;
    this.cpuMsValue = this.cpuMsValue * 0.92 + cpuMs * 0.08;

    if (this.elapsedMs >= 500) {
      this.fpsValue = (this.frames * 1000) / this.elapsedMs;
      this.frames = 0;
      this.elapsedMs = 0;
    }
  }

  get fps(): number {
    return this.fpsValue;
  }

  get frameMs(): number {
    return this.frameMsValue;
  }

  get cpuMs(): number {
    return this.cpuMsValue;
  }
}
