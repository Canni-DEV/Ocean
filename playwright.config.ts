import { defineConfig, devices } from "@playwright/test";

const captureFullResolution = process.env.PR6B_CAPTURE_FULL === "1";
const validationViewport = captureFullResolution ? { width: 2560, height: 1440 } : { width: 1280, height: 720 };

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: process.env.PR6B_HEADFUL !== "1",
    headless: true,
    viewport: validationViewport,
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    timeout: 120_000,
    reuseExistingServer: true
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: validationViewport,
        deviceScaleFactor: 1,
        launchOptions: { args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] }
      }
    },
    {
      name: "edge",
      use: {
        ...devices["Desktop Edge"],
        viewport: validationViewport,
        deviceScaleFactor: 1,
        channel: "msedge",
        launchOptions: { args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] }
      }
    }
  ]
});
