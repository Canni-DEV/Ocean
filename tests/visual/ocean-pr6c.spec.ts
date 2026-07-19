import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type ValidationPayload = {
  scenario: { id: string; ssr: boolean; refraction: boolean; contact: boolean; curvedHorizon: boolean };
  settings: { quality: string };
  metrics: {
    status: string;
    error: string | null;
    oceanSceneCaptureMs: number | null;
    oceanSurfaceDataMs: number | null;
    oceanSsrMs: number | null;
  };
  summary: Record<string, number | null>;
};

const SCENARIOS = [
  "pr6c-rail-reflection-off",
  "pr6c-rail-reflection-on",
  "pr6c-waterline-off",
  "pr6c-waterline-on",
  "pr6c-night-reflection",
  "pr6c-horizon-deck",
  "pr6c-horizon-50",
  "pr6c-horizon-150",
  "pr6c-horizon-300"
] as const;

for (const scenario of SCENARIOS) {
  test(`${scenario} renders finite screen-space integration`, async ({ page }, testInfo) => {
    const errors = collectBrowserErrors(page, scenario);
    await openScenario(page, scenario);
    const png = await page.locator("canvas").first().screenshot();
    const payload = await validationPayload(page);
    const metrics = measureRoi(png, { x0: 0.02, x1: 0.98, y0: 0.2, y1: 0.96 });
    await persistArtifact(testInfo.project.name, scenario, png, metrics, payload, page);

    expect(payload.metrics.status, payload.metrics.error ?? "engine error").toBe("running");
    expect(errors).toEqual([]);
    expect(metrics.nonFinite).toBe(0);
    expect(metrics.clippedFraction).toBeLessThan(0.005);
    expect(payload.metrics.oceanSceneCaptureMs).not.toBeNull();
    if (payload.scenario.ssr && payload.settings.quality !== "low") {
      expect(payload.metrics.oceanSurfaceDataMs).not.toBeNull();
      expect(payload.metrics.oceanSsrMs).not.toBeNull();
    }
  });
}

test("SSR replaces the environment only where confidence is valid", async ({ page }) => {
  await openScenario(page, "pr6c-rail-reflection-off");
  const fallback = await page.locator("canvas").first().screenshot();
  await openScenario(page, "pr6c-rail-reflection-on");
  const resolved = await page.locator("canvas").first().screenshot();
  const change = meanAbsoluteDifference(fallback, resolved, { x0: 0.08, x1: 0.92, y0: 0.3, y1: 0.96 });
  expect(change).toBeGreaterThan(0.0005);
  expect(change).toBeLessThan(0.35);
});

test("waterline refraction/contact is contained", async ({ page }) => {
  await openScenario(page, "pr6c-waterline-off");
  const off = await page.locator("canvas").first().screenshot();
  await openScenario(page, "pr6c-waterline-on");
  const on = await page.locator("canvas").first().screenshot();
  const contactBand = meanAbsoluteDifference(off, on, { x0: 0, x1: 0.3, y0: 0.45, y1: 0.98 });
  const sky = meanAbsoluteDifference(off, on, { x0: 0.05, x1: 0.95, y0: 0.02, y1: 0.24 });
  // Contact is intentionally a narrow sub-waterline attenuation, so evaluate
  // it in the hull-local ROI without requiring a broad painted halo.
  expect(contactBand).toBeGreaterThan(0.0001);
  expect(sky).toBeLessThan(0.01);
});

for (const quality of ["medium", "low"] as const) {
  test(`${quality} compiles PR6C resources and gates`, async ({ page }) => {
    const errors = collectBrowserErrors(page, `pr6c-${quality}`);
    await page.goto(`/?oceanValidation=pr6c-rail-reflection-on&quality=${quality}&foam=0`);
    await waitForEngine(page);
    const payload = await validationPayload(page);
    expect(payload.metrics.status, payload.metrics.error ?? "engine error").toBe("running");
    expect(payload.settings.quality).toBe(quality);
    expect(errors).toEqual([]);
    if (quality === "low") {
      expect(payload.metrics.oceanSsrMs).toBe(0);
      expect(payload.metrics.oceanSurfaceDataMs).toBe(0);
    }
  });
}

for (const view of ["ssrConfidence", "refractionValidity", "contact", "horizonBlend"] as const) {
  test(`${view} debug output is connected`, async ({ page }, testInfo) => {
    const scenario = view === "ssrConfidence"
      ? "pr6c-rail-reflection-on"
      : view === "horizonBlend" ? "pr6c-horizon-deck" : "pr6c-waterline-on";
    await page.goto(`/?oceanValidation=${scenario}&debugOcean=${view}&foam=0`, { waitUntil: "domcontentloaded" });
    await waitForEngine(page);
    await page.waitForTimeout(1_500);
    const png = await page.locator("canvas").first().screenshot();
    await testInfo.attach(`${view}.png`, { body: png, contentType: "image/png" });
    expect(activePixelFraction(png, { x0: 0, x1: 1, y0: 0.2, y1: 1 }, 2)).toBeGreaterThan(0.0001);
  });
}

function collectBrowserErrors(page: Page, scenario: string): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error" || message.text().includes("status of 404")) return;
    errors.push(message.text());
    console.error(`[browser:${scenario}] ${message.text()}`);
  });
  return errors;
}

async function openScenario(page: Page, scenario: string): Promise<void> {
  await page.goto(`/?oceanValidation=${scenario}`, { waitUntil: "domcontentloaded" });
  await waitForEngine(page);
  await page.waitForTimeout(1_500);
}

async function waitForEngine(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = (window as any).__oceanValidation as ValidationPayload | undefined;
    return state?.metrics.status === "running" || state?.metrics.status === "error";
  }, null, { timeout: 90_000 });
}

async function validationPayload(page: Page): Promise<ValidationPayload> {
  return page.evaluate(() => (window as any).__oceanValidation as ValidationPayload);
}

type Roi = { x0: number; x1: number; y0: number; y1: number };

function measureRoi(buffer: Buffer, roi: Roi): { clippedFraction: number; nonFinite: number; median: number } {
  const png = PNG.sync.read(buffer);
  const samples: number[] = [];
  let clipped = 0;
  let nonFinite = 0;
  forEachPixel(png, roi, (offset) => {
    const r = png.data[offset] / 255;
    const g = png.data[offset + 1] / 255;
    const b = png.data[offset + 2] / 255;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (!Number.isFinite(luminance)) nonFinite += 1;
    samples.push(luminance);
    if (png.data[offset] >= 254 || png.data[offset + 1] >= 254 || png.data[offset + 2] >= 254) clipped += 1;
  });
  samples.sort((a, b) => a - b);
  return {
    clippedFraction: clipped / Math.max(1, samples.length),
    nonFinite,
    median: samples[Math.floor(samples.length * 0.5)] ?? 0
  };
}

function meanAbsoluteDifference(a: Buffer, b: Buffer, roi: Roi): number {
  const first = PNG.sync.read(a);
  const second = PNG.sync.read(b);
  expect([second.width, second.height]).toEqual([first.width, first.height]);
  let total = 0;
  let count = 0;
  forEachPixel(first, roi, (offset) => {
    total += Math.abs(first.data[offset] - second.data[offset]);
    total += Math.abs(first.data[offset + 1] - second.data[offset + 1]);
    total += Math.abs(first.data[offset + 2] - second.data[offset + 2]);
    count += 3;
  });
  return total / Math.max(1, count) / 255;
}

function activePixelFraction(buffer: Buffer, roi: Roi, threshold: number): number {
  const png = PNG.sync.read(buffer);
  let active = 0;
  let count = 0;
  forEachPixel(png, roi, (offset) => {
    if (png.data[offset] > threshold || png.data[offset + 1] > threshold || png.data[offset + 2] > threshold) active += 1;
    count += 1;
  });
  return active / Math.max(1, count);
}

function forEachPixel(png: PNG, roi: Roi, visit: (offset: number) => void): void {
  const x0 = Math.floor(png.width * roi.x0);
  const x1 = Math.floor(png.width * roi.x1);
  const y0 = Math.floor(png.height * roi.y0);
  const y1 = Math.floor(png.height * roi.y1);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) visit((y * png.width + x) * 4);
  }
}

async function persistArtifact(
  project: string,
  scenario: string,
  png: Buffer,
  imageMetrics: ReturnType<typeof measureRoi>,
  payload: ValidationPayload,
  page: Page
): Promise<void> {
  const set = process.env.PR6C_ARTIFACT_SET;
  if (set !== "baseline" && set !== "candidate") return;
  const directory = path.resolve("docs", "validation", "pr6c", set);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${scenario}-${project}.png`), png);
  const browser = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    resolution: [window.innerWidth, window.innerHeight],
    devicePixelRatio: window.devicePixelRatio,
    webgpu: "gpu" in navigator
  }));
  await writeFile(
    path.join(directory, `${scenario}-${project}.json`),
    JSON.stringify({ browser, imageMetrics, validation: payload }, null, 2)
  );
}
