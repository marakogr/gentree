// Artifacts for one review run: screenshots plus JSON audits.
//
// `UX_RUN_DIR` is set by the WDIO config in onPrepare so every spec of a run
// writes into the same timestamped directory.
import fs from "node:fs";
import path from "node:path";

const E2E_DIR = path.resolve(import.meta.dirname, "..");

export function artifactsDir() {
  if (process.env.UX_RUN_DIR) return process.env.UX_RUN_DIR;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(E2E_DIR, "artifacts", stamp);
}

export function save(name, data) {
  const dir = artifactsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  return file;
}

export function shot(name) {
  const dir = artifactsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  browser.saveScreenshot(file);
  return file;
}
