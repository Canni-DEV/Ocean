import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type ValidationPayload = {
  scenario: { id: string };
  metrics: { status: string; error: string | null };
  samples: { frameMs: number[]; gpuComputeMs: number[]; gpuRenderMs: number[] };
  summary: Record<string, number | null>;
};

type ImageMetrics = {
  medianLuminance: number;
  digitalBlackFraction: number;
  clippedFraction: number;
};

const SCENARIOS = [
  "pr6b-rail-night-off",
  "pr6b-rail-night-work",
  "pr6b-bow-night-off",
  "pr6b-bow-night-flashlight",
  "pr6b-cabin-night",
  "pr6b-navigation-night",
  "pr6b-anchor-night",
  "pr6b-bridge-moon",
  "pr6b-storm-fixed-lightning",
  "pr6b-low-sun-bow",
  "pr6b-sun-lateral",
  "pr6b-cloudy-deck"
] as const;

for (const scenario of SCENARIOS) {
  test(`${scenario} renders finite SDR output`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        if (!message.text().includes("status of 404")) errors.push(message.text());
        console.error(`[browser:${scenario}] ${message.text()}`);
      }
    });

    await openScenario(page, scenario);
    const canvas = page.locator("canvas").first();
    const pngBuffer = await canvas.screenshot();
    const metrics = measureWaterRoi(pngBuffer);
    const waterSurface = measureRoi(pngBuffer, { x0: 0.02, x1: 0.98, y0: 0.44, y1: 0.94 });
    const payload = await page.evaluate(() => (window as any).__oceanValidation as ValidationPayload);
    console.log(`[metrics:${scenario}] ${JSON.stringify(metrics)}`);

    await persistArtifact(testInfo.project.name, scenario, pngBuffer, metrics, payload, page);

    expect(payload.metrics.status, payload.metrics.error ?? "engine error").toBe("running");
    expect(errors).toEqual([]);
    expect(metrics.clippedFraction).toBeLessThan(0.005);
    expect(waterSurface.clippedFraction).toBeLessThan(0.005);
    expect(Number.isFinite(metrics.medianLuminance)).toBe(true);

    if (scenario === "pr6b-bridge-moon") {
      const moonWater = measureRoi(pngBuffer, { x0: 0.05, x1: 0.35, y0: 0.46, y1: 0.86 });
      expect(moonWater.digitalBlackFraction).toBeLessThan(0.05);
      expect(moonWater.medianLuminance).toBeGreaterThanOrEqual(0.015);
      expect(moonWater.medianLuminance).toBeLessThanOrEqual(0.08);
    }

  });
}

test("work light adds at least two stops inside its controlled ROI", async ({ page }) => {
  await openScenario(page, "pr6b-rail-night-off");
  const offPng = await page.locator("canvas").first().screenshot();
  const off = measureRoi(offPng, { x0: 0.3, x1: 0.55, y0: 0.46, y1: 0.63 });
  const offOutside = measureRoi(offPng, { x0: 0.72, x1: 0.96, y0: 0.43, y1: 0.86 });
  await openScenario(page, "pr6b-rail-night-work");
  const onPng = await page.locator("canvas").first().screenshot();
  const on = measureRoi(onPng, { x0: 0.3, x1: 0.55, y0: 0.46, y1: 0.63 });
  const onOutside = measureRoi(onPng, { x0: 0.72, x1: 0.96, y0: 0.43, y1: 0.86 });
  expect(on.medianLuminance).toBeGreaterThanOrEqual(off.medianLuminance * 4);
  expect(on.clippedFraction).toBeLessThan(0.005);
  expect(Math.abs(onOutside.medianLuminance - offOutside.medianLuminance) / Math.max(offOutside.medianLuminance, 1e-4))
    .toBeLessThan(0.1);
});

test("flashlight adds two stops without clipping its water footprint", async ({ page }) => {
  await openScenario(page, "pr6b-bow-night-off");
  const off = measureRoi(await page.locator("canvas").first().screenshot(), {
    x0: 0.38, x1: 0.62, y0: 0.48, y1: 0.78
  });
  await openScenario(page, "pr6b-bow-night-flashlight");
  const on = measureRoi(await page.locator("canvas").first().screenshot(), {
    x0: 0.38, x1: 0.62, y0: 0.48, y1: 0.78
  });
  expect(on.medianLuminance).toBeGreaterThanOrEqual(off.medianLuminance * 4);
  expect(on.clippedFraction).toBeLessThan(0.005);
});

for (const quality of ["medium", "low"] as const) {
  test(`${quality} compiles the PR6B lighting path`, async ({ page }) => {
    await page.goto(`/?oceanValidation=pr6b-bridge-moon&foam=0&quality=${quality}`);
    await page.waitForFunction(() => {
      const state = (window as any).__oceanValidation as ValidationPayload | undefined;
      return state?.metrics.status === "running" || state?.metrics.status === "error";
    }, null, { timeout: 90_000 });
    const payload = await page.evaluate(() => (window as any).__oceanValidation as ValidationPayload & { settings: { quality: string } });
    expect(payload.metrics.status, payload.metrics.error ?? "engine error").toBe("running");
    expect(payload.settings.quality).toBe(quality);
  });
}

test("PR6B debug contribution capture", async ({ page }, testInfo) => {
  test.skip(process.env.PR6B_DEBUG !== "1", "manual shader contribution diagnostic");
  for (const view of ["final", "ambientVolume", "moonGlitter", "localVolume"] as const) {
    await page.goto(`/?oceanValidation=pr6b-bridge-moon&foam=0&debugOcean=${view}`);
    await page.waitForFunction(() => (window as any).__oceanValidation?.metrics.status === "running");
    await page.waitForTimeout(1_000);
    await page.locator("canvas").first().screenshot({ path: testInfo.outputPath(`${view}.png`) });
  }
});

async function openScenario(page: Page, scenario: string): Promise<void> {
  await page.goto(`/?oceanValidation=${scenario}&foam=0`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const state = (window as any).__oceanValidation as ValidationPayload | undefined;
    return state?.metrics.status === "running" || state?.metrics.status === "error";
  }, null, { timeout: 90_000 });
  await page.waitForTimeout(1_500);
}

function measureWaterRoi(buffer: Buffer): ImageMetrics {
  return measureRoi(buffer, { x0: 0.48, x1: 0.98, y0: 0.25, y1: 0.88 });
}

function measureRoi(
  buffer: Buffer,
  roi: { x0: number; x1: number; y0: number; y1: number }
): ImageMetrics {
  const png = PNG.sync.read(buffer);
  const x0 = Math.floor(png.width * roi.x0);
  const x1 = Math.floor(png.width * roi.x1);
  const y0 = Math.floor(png.height * roi.y0);
  const y1 = Math.floor(png.height * roi.y1);
  const luminance: number[] = [];
  let black = 0;
  let clipped = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * png.width + x) * 4;
      const r = srgbToLinear(png.data[offset] / 255);
      const g = srgbToLinear(png.data[offset + 1] / 255);
      const b = srgbToLinear(png.data[offset + 2] / 255);
      const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luminance.push(value);
      if (png.data[offset] <= 1 && png.data[offset + 1] <= 1 && png.data[offset + 2] <= 1) black += 1;
      if (png.data[offset] >= 254 || png.data[offset + 1] >= 254 || png.data[offset + 2] >= 254) clipped += 1;
    }
  }
  luminance.sort((a, b) => a - b);
  const count = Math.max(1, luminance.length);
  return {
    medianLuminance: luminance[Math.floor(luminance.length * 0.5)] ?? 0,
    digitalBlackFraction: black / count,
    clippedFraction: clipped / count
  };
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

async function persistArtifact(
  projectName: string,
  scenario: string,
  png: Buffer,
  imageMetrics: ImageMetrics,
  payload: ValidationPayload,
  page: Page
): Promise<void> {
  const artifactSet = process.env.PR6B_ARTIFACT_SET;
  if (artifactSet !== "baseline" && artifactSet !== "candidate") return;
  const directory = path.resolve("docs", "validation", "pr6b", artifactSet);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${scenario}-${projectName}.png`), png);
  const browser = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    resolution: [window.innerWidth, window.innerHeight],
    devicePixelRatio: window.devicePixelRatio,
    webgpu: "gpu" in navigator
  }));
  await writeFile(
    path.join(directory, `${scenario}-${projectName}.json`),
    JSON.stringify({ browser, imageMetrics, validation: payload }, null, 2)
  );
}
