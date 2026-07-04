import type { DebugRenderMode, WeatherState } from "../engine/types";

type OceanComputeOptions = {
  resolution: 256;
  patchSizeMeters: number;
};

type OceanUpdateOptions = {
  timeSeconds: number;
  weather: WeatherState;
  debugMode: DebugRenderMode;
};

export type OceanComputeResult = {
  samples: Float32Array;
  computeMs: number;
};

const WORKGROUP_SIZE = 8;
const GRAVITY = 9.81;

export class OceanCompute {
  readonly resolution: 256;
  readonly patchSizeMeters: number;
  busy = false;

  private device: GPUDevice | null = null;
  private spectrumBuffer: GPUBuffer | null = null;
  private pingBuffer: GPUBuffer | null = null;
  private pongBuffer: GPUBuffer | null = null;
  private sampleBuffer: GPUBuffer | null = null;
  private readbackBuffer: GPUBuffer | null = null;
  private initPipeline: GPUComputePipeline | null = null;
  private bitReversePipeline: GPUComputePipeline | null = null;
  private fftPipeline: GPUComputePipeline | null = null;
  private normalizePipeline: GPUComputePipeline | null = null;
  private latestSamples: Float32Array;

  constructor(options: OceanComputeOptions) {
    this.resolution = options.resolution;
    this.patchSizeMeters = options.patchSizeMeters;
    this.latestSamples = new Float32Array(this.resolution * this.resolution * 4);
  }

  async init(): Promise<void> {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance"
    });

    if (!adapter) {
      throw new Error("WebGPU adapter was not available.");
    }

    this.device = await adapter.requestDevice();
    this.device.addEventListener("uncapturederror", (event) => {
      console.error("Uncaptured WebGPU error", event.error);
    });

    const complexByteLength = this.resolution * this.resolution * 2 * Float32Array.BYTES_PER_ELEMENT;
    const sampleByteLength = this.resolution * this.resolution * 4 * Float32Array.BYTES_PER_ELEMENT;

    this.spectrumBuffer = this.createBufferWithData(
      this.createInitialSpectrum(),
      GPUBufferUsage.STORAGE
    );
    this.pingBuffer = this.device.createBuffer({
      size: complexByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    this.pongBuffer = this.device.createBuffer({
      size: complexByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    this.sampleBuffer = this.device.createBuffer({
      size: sampleByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    this.readbackBuffer = this.device.createBuffer({
      size: sampleByteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    this.initPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: this.initSpectrumShader() }),
        entryPoint: "main"
      }
    });
    this.bitReversePipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: this.bitReverseShader() }),
        entryPoint: "main"
      }
    });
    this.fftPipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: this.fftStageShader() }),
        entryPoint: "main"
      }
    });
    this.normalizePipeline = this.device.createComputePipeline({
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: this.normalizeShader() }),
        entryPoint: "main"
      }
    });
  }

  async update(options: OceanUpdateOptions): Promise<OceanComputeResult> {
    if (this.busy) {
      return { samples: this.latestSamples, computeMs: 0 };
    }

    if (
      !this.device ||
      !this.spectrumBuffer ||
      !this.pingBuffer ||
      !this.pongBuffer ||
      !this.sampleBuffer ||
      !this.readbackBuffer ||
      !this.initPipeline ||
      !this.bitReversePipeline ||
      !this.fftPipeline ||
      !this.normalizePipeline
    ) {
      throw new Error("Ocean compute was used before initialization.");
    }

    this.busy = true;
    const startMs = performance.now();
    const transientBuffers: GPUBuffer[] = [];
    const commandEncoder = this.device.createCommandEncoder({
      label: "Ocean FFT command encoder"
    });

    const uniforms = this.createUniformData(options, 0, 0);

    try {
      this.dispatchInit(commandEncoder, uniforms, transientBuffers);

      let readBuffer = this.pingBuffer;
      let writeBuffer = this.pongBuffer;
      this.dispatchBitReverse(commandEncoder, readBuffer, writeBuffer, uniforms, 0, transientBuffers);
      [readBuffer, writeBuffer] = [writeBuffer, readBuffer];

      for (let stage = 0; stage < 8; stage += 1) {
        this.dispatchFftStage(commandEncoder, readBuffer, writeBuffer, uniforms, stage, 0, transientBuffers);
        [readBuffer, writeBuffer] = [writeBuffer, readBuffer];
      }

      this.dispatchBitReverse(commandEncoder, readBuffer, writeBuffer, uniforms, 1, transientBuffers);
      [readBuffer, writeBuffer] = [writeBuffer, readBuffer];

      for (let stage = 0; stage < 8; stage += 1) {
        this.dispatchFftStage(commandEncoder, readBuffer, writeBuffer, uniforms, stage, 1, transientBuffers);
        [readBuffer, writeBuffer] = [writeBuffer, readBuffer];
      }

      this.dispatchNormalize(commandEncoder, readBuffer, uniforms, transientBuffers);
      commandEncoder.copyBufferToBuffer(
        this.sampleBuffer,
        0,
        this.readbackBuffer,
        0,
        this.latestSamples.byteLength
      );

      this.device.queue.submit([commandEncoder.finish()]);

      await this.readbackBuffer.mapAsync(GPUMapMode.READ);
      this.latestSamples = new Float32Array(this.readbackBuffer.getMappedRange().slice(0));
      this.readbackBuffer.unmap();

      return {
        samples: this.latestSamples,
        computeMs: performance.now() - startMs
      };
    } finally {
      for (const buffer of transientBuffers) {
        buffer.destroy();
      }
      this.busy = false;
    }
  }

  dispose(): void {
    this.spectrumBuffer?.destroy();
    this.pingBuffer?.destroy();
    this.pongBuffer?.destroy();
    this.sampleBuffer?.destroy();
    this.readbackBuffer?.destroy();
    this.device?.destroy();
  }

  private dispatchInit(
    commandEncoder: GPUCommandEncoder,
    uniforms: Float32Array,
    transientBuffers: GPUBuffer[]
  ): void {
    const device = this.assertDevice();
    const uniformBuffer = this.createBufferWithData(
      uniforms,
      GPUBufferUsage.UNIFORM,
      transientBuffers
    );
    const pass = commandEncoder.beginComputePass({ label: "Ocean spectrum evolution" });
    pass.setPipeline(this.assertPipeline(this.initPipeline));
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.assertPipeline(this.initPipeline).getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.assertBuffer(this.spectrumBuffer) } },
          { binding: 1, resource: { buffer: this.assertBuffer(this.pingBuffer) } },
          { binding: 2, resource: { buffer: uniformBuffer } }
        ]
      })
    );
    pass.dispatchWorkgroups(this.groups(this.resolution), this.groups(this.resolution));
    pass.end();
  }

  private dispatchBitReverse(
    commandEncoder: GPUCommandEncoder,
    input: GPUBuffer,
    output: GPUBuffer,
    baseUniforms: Float32Array,
    direction: number,
    transientBuffers: GPUBuffer[]
  ): void {
    const device = this.assertDevice();
    const uniforms = new Float32Array(baseUniforms);
    uniforms[7] = direction;
    const uniformBuffer = this.createBufferWithData(
      uniforms,
      GPUBufferUsage.UNIFORM,
      transientBuffers
    );
    const pipeline = this.assertPipeline(this.bitReversePipeline);
    const pass = commandEncoder.beginComputePass({ label: "Ocean FFT bit reverse" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: uniformBuffer } }
        ]
      })
    );
    pass.dispatchWorkgroups(this.groups(this.resolution), this.groups(this.resolution));
    pass.end();
  }

  private dispatchFftStage(
    commandEncoder: GPUCommandEncoder,
    input: GPUBuffer,
    output: GPUBuffer,
    baseUniforms: Float32Array,
    stage: number,
    direction: number,
    transientBuffers: GPUBuffer[]
  ): void {
    const device = this.assertDevice();
    const uniforms = new Float32Array(baseUniforms);
    uniforms[6] = stage;
    uniforms[7] = direction;
    const uniformBuffer = this.createBufferWithData(
      uniforms,
      GPUBufferUsage.UNIFORM,
      transientBuffers
    );
    const pipeline = this.assertPipeline(this.fftPipeline);
    const pass = commandEncoder.beginComputePass({ label: "Ocean FFT stage" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
          { binding: 2, resource: { buffer: uniformBuffer } }
        ]
      })
    );

    if (direction === 0) {
      pass.dispatchWorkgroups(this.groups(this.resolution / 2), this.groups(this.resolution));
    } else {
      pass.dispatchWorkgroups(this.groups(this.resolution), this.groups(this.resolution / 2));
    }

    pass.end();
  }

  private dispatchNormalize(
    commandEncoder: GPUCommandEncoder,
    input: GPUBuffer,
    baseUniforms: Float32Array,
    transientBuffers: GPUBuffer[]
  ): void {
    const device = this.assertDevice();
    const uniformBuffer = this.createBufferWithData(
      baseUniforms,
      GPUBufferUsage.UNIFORM,
      transientBuffers
    );
    const pipeline = this.assertPipeline(this.normalizePipeline);
    const pass = commandEncoder.beginComputePass({ label: "Ocean normals and foam" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: this.assertBuffer(this.sampleBuffer) } },
          { binding: 2, resource: { buffer: uniformBuffer } }
        ]
      })
    );
    pass.dispatchWorkgroups(this.groups(this.resolution), this.groups(this.resolution));
    pass.end();
  }

  private createUniformData(options: OceanUpdateOptions, stage: number, direction: number): Float32Array {
    const { weather } = options;
    const debugBias =
      options.debugMode === "ocean-height" || options.debugMode === "ocean-normal" ? 1 : 0;
    return new Float32Array([
      options.timeSeconds,
      weather.windDirectionRad,
      weather.windSpeedMs,
      weather.swellStrength,
      this.patchSizeMeters,
      1.15 + weather.swellStrength * 1.4,
      stage,
      direction,
      0.006 + weather.windSpeedMs * 0.0008 + weather.swellStrength * 0.014,
      weather.precipitation,
      debugBias,
      0
    ]);
  }

  private createBufferWithData(
    data: Float32Array,
    usage: GPUBufferUsageFlags,
    transientBuffers?: GPUBuffer[]
  ): GPUBuffer {
    const device = this.assertDevice();
    const buffer = device.createBuffer({
      size: Math.ceil(data.byteLength / 4) * 4,
      usage: usage | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    transientBuffers?.push(buffer);
    return buffer;
  }

  private createInitialSpectrum(): Float32Array {
    const n = this.resolution;
    const complex = new Float32Array(n * n * 2);
    const result = new Float32Array(n * n * 4);
    const rng = mulberry32(0x0ceacd);
    const windDirection = { x: Math.cos(Math.PI * 0.22), y: Math.sin(Math.PI * 0.22) };
    const windSpeed = 14;
    const largestWave = (windSpeed * windSpeed) / GRAVITY;

    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const index = y * n + x;
        const kxIndex = x <= n / 2 ? x : x - n;
        const kyIndex = y <= n / 2 ? y : y - n;
        const kx = (2 * Math.PI * kxIndex) / this.patchSizeMeters;
        const ky = (2 * Math.PI * kyIndex) / this.patchSizeMeters;
        const kLength = Math.hypot(kx, ky);

        if (kLength < 0.0001) {
          complex[index * 2] = 0;
          complex[index * 2 + 1] = 0;
          continue;
        }

        const kDotWind = Math.max(0, (kx / kLength) * windDirection.x + (ky / kLength) * windDirection.y);
        const damping = 0.001;
        const phillips =
          0.000055 *
          Math.exp(-1 / (kLength * largestWave * kLength * largestWave)) *
          (kDotWind * kDotWind) *
          Math.exp(-kLength * kLength * damping * damping) /
          Math.pow(kLength, 4);
        const amplitude = Math.sqrt(Math.max(0, phillips) * 0.5);
        const gaussianA = gaussian(rng);
        const gaussianB = gaussian(rng);

        complex[index * 2] = gaussianA * amplitude;
        complex[index * 2 + 1] = gaussianB * amplitude;
      }
    }

    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const index = y * n + x;
        const negX = (n - x) % n;
        const negY = (n - y) % n;
        const negIndex = negY * n + negX;
        result[index * 4] = complex[index * 2];
        result[index * 4 + 1] = complex[index * 2 + 1];
        result[index * 4 + 2] = complex[negIndex * 2];
        result[index * 4 + 3] = -complex[negIndex * 2 + 1];
      }
    }

    return result;
  }

  private groups(size: number): number {
    return Math.ceil(size / WORKGROUP_SIZE);
  }

  private assertDevice(): GPUDevice {
    if (!this.device) throw new Error("WebGPU device is not initialized.");
    return this.device;
  }

  private assertBuffer(buffer: GPUBuffer | null): GPUBuffer {
    if (!buffer) throw new Error("Ocean GPU buffer is not initialized.");
    return buffer;
  }

  private assertPipeline(pipeline: GPUComputePipeline | null): GPUComputePipeline {
    if (!pipeline) throw new Error("Ocean compute pipeline is not initialized.");
    return pipeline;
  }

  private commonShaderHeader(): string {
    return `
const N: u32 = ${this.resolution}u;
const PI: f32 = 3.141592653589793;
const WORKGROUP: u32 = ${WORKGROUP_SIZE}u;

struct Params {
  a: vec4<f32>,
  b: vec4<f32>,
  c: vec4<f32>
};

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn index2(x: u32, y: u32) -> u32 {
  return y * N + x;
}
`;
  }

  private initSpectrumShader(): string {
    return `
${this.commonShaderHeader()}
@group(0) @binding(0) var<storage, read> spectrum: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> field: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= N || gid.y >= N) {
    return;
  }

  let index = index2(gid.x, gid.y);
  let sx = select(f32(gid.x), f32(gid.x) - f32(N), gid.x > N / 2u);
  let sy = select(f32(gid.y), f32(gid.y) - f32(N), gid.y > N / 2u);
  let k = vec2<f32>(2.0 * PI * sx / params.b.x, 2.0 * PI * sy / params.b.x);
  let k_len = max(length(k), 0.0001);
  let wind = vec2<f32>(cos(params.a.y), sin(params.a.y));
  let alignment = pow(max(dot(normalize(k), wind), 0.0), 2.0);
  let omega = sqrt(9.81 * k_len);
  let phase = omega * params.a.x;
  let rot_a = vec2<f32>(cos(phase), sin(phase));
  let rot_b = vec2<f32>(cos(-phase), sin(-phase));
  let h0 = spectrum[index].xy;
  let h0_neg_conj = spectrum[index].zw;
  let wind_energy = 0.45 + params.a.z * 0.035 + params.a.w * 0.9;
  let directional_energy = mix(0.35, 1.35, alignment);

  field[index] = (cmul(h0, rot_a) + cmul(h0_neg_conj, rot_b)) * wind_energy * directional_energy;
}
`;
  }

  private bitReverseShader(): string {
    return `
${this.commonShaderHeader()}
@group(0) @binding(0) var<storage, read> input_field: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> output_field: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn reverse8(value: u32) -> u32 {
  var x = value;
  x = ((x & 0x55u) << 1u) | ((x & 0xAAu) >> 1u);
  x = ((x & 0x33u) << 2u) | ((x & 0xCCu) >> 2u);
  x = ((x & 0x0Fu) << 4u) | ((x & 0xF0u) >> 4u);
  return x;
}

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= N || gid.y >= N) {
    return;
  }

  let direction = u32(params.b.w);

  if (direction == 0u) {
    output_field[index2(reverse8(gid.x), gid.y)] = input_field[index2(gid.x, gid.y)];
  } else {
    output_field[index2(gid.x, reverse8(gid.y))] = input_field[index2(gid.x, gid.y)];
  }
}
`;
  }

  private fftStageShader(): string {
    return `
${this.commonShaderHeader()}
@group(0) @binding(0) var<storage, read> input_field: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> output_field: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let stage = u32(params.b.z);
  let direction = u32(params.b.w);
  let half_size = 1u << stage;
  let full_size = half_size << 1u;

  if (direction == 0u) {
    if (gid.x >= N / 2u || gid.y >= N) {
      return;
    }

    let pair = gid.x;
    let block = pair / half_size;
    let j = pair % half_size;
    let x0 = block * full_size + j;
    let x1 = x0 + half_size;
    let angle = 2.0 * PI * f32(j) / f32(full_size);
    let twiddle = vec2<f32>(cos(angle), sin(angle));
    let u = input_field[index2(x0, gid.y)];
    let v = cmul(input_field[index2(x1, gid.y)], twiddle);
    output_field[index2(x0, gid.y)] = u + v;
    output_field[index2(x1, gid.y)] = u - v;
  } else {
    if (gid.x >= N || gid.y >= N / 2u) {
      return;
    }

    let pair = gid.y;
    let block = pair / half_size;
    let j = pair % half_size;
    let y0 = block * full_size + j;
    let y1 = y0 + half_size;
    let angle = 2.0 * PI * f32(j) / f32(full_size);
    let twiddle = vec2<f32>(cos(angle), sin(angle));
    let u = input_field[index2(gid.x, y0)];
    let v = cmul(input_field[index2(gid.x, y1)], twiddle);
    output_field[index2(gid.x, y0)] = u + v;
    output_field[index2(gid.x, y1)] = u - v;
  }
}
`;
  }

  private normalizeShader(): string {
    return `
${this.commonShaderHeader()}
@group(0) @binding(0) var<storage, read> height_field: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> samples: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn wrapped_height(x: i32, y: i32) -> f32 {
  let wx = u32((x + i32(N)) % i32(N));
  let wy = u32((y + i32(N)) % i32(N));
  let checker = select(-1.0, 1.0, ((wx + wy) & 1u) == 0u);
  return height_field[index2(wx, wy)].x * params.c.x * checker;
}

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= N || gid.y >= N) {
    return;
  }

  let x = i32(gid.x);
  let y = i32(gid.y);
  let cell = params.b.x / f32(N);
  let height = wrapped_height(x, y);
  let dx = (wrapped_height(x + 1, y) - wrapped_height(x - 1, y)) / (2.0 * cell);
  let dz = (wrapped_height(x, y + 1) - wrapped_height(x, y - 1)) / (2.0 * cell);
  let normal = normalize(vec3<f32>(-dx, 1.0, -dz));
  let compression = abs(dx) + abs(dz) + params.c.y * 0.7;
  let foam = smoothstep(0.08, 0.36, compression);
  samples[index2(gid.x, gid.y)] = vec4<f32>(height, normal.x, normal.z, foam);
}
`;
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(1e-6, random());
  const v = Math.max(1e-6, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
