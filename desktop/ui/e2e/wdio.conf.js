// WebdriverIO configuration for the Gentree desktop app.
//
// Drives the real Tauri window through tauri-driver + msedgedriver (WebView2).
// The app under test is built from `e2e/tauri.ux.conf.json`, which changes the
// bundle identifier only, so a run never reads a real user archive.
//
// This is a review harness, not a gate: specs collect evidence (screenshots,
// DOM audits) and fail only on a broken session or a crashed screen.
import { APP_EXE, startDriver, stopDriver } from "./scripts/driver.mjs";
import { artifactsDir } from "./lib/report.js";
import fs from "node:fs";

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: Number(process.env.UX_DRIVER_PORT ?? 4444),
  path: "/",
  // tauri-driver speaks plain WebDriver; there is no browser vendor magic here.
  automationProtocol: "webdriver",
  specs: ["./specs/**/*.js"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      browserName: "wry",
      "tauri:options": { application: APP_EXE },
    },
  ],
  logLevel: process.env.UX_LOG_LEVEL ?? "warn",
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180000,
  },
  waitforTimeout: 20000,

  onPrepare: async () => {
    process.env.UX_RUN_DIR = artifactsDir();
    // Specs may call saveScreenshot before the first save(); the run folder
    // must exist up front.
    fs.mkdirSync(process.env.UX_RUN_DIR, { recursive: true });
    await startDriver();
    // eslint-disable-next-line no-console
    console.log(`ux artifacts: ${process.env.UX_RUN_DIR}`);
  },

  // Closing the window exits the app; tauri-driver keeps running until
  // onComplete. Without this the helper process outlives the session.
  afterSession: async () => {
    try {
      await browser.closeWindow();
    } catch {
      // The app may already be gone when a spec closed the window itself.
    }
    await browser.pause(500);
  },

  onComplete: async () => {
    await stopDriver();
  },
};
