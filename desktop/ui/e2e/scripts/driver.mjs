// Lifecycle of the WebDriver helper processes for one review run.
//
// tauri-driver sits in front of msedgedriver and launches the app binary from
// the `tauri:options.application` capability. Everything the app needs to stay
// away from a real archive is passed through this process environment.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const E2E_DIR = path.resolve(import.meta.dirname, "..");
export const DESKTOP_DIR = path.resolve(E2E_DIR, "..", "..");
export const APP_EXE = path.join(
  DESKTOP_DIR,
  "target",
  "ux",
  "release",
  process.platform === "win32" ? "gentree-desktop.exe" : "gentree-desktop",
);

/** Bundle identifier of the isolated build; see `tauri.ux.conf.json`. */
export const UX_IDENTIFIER = "com.gentree.desktop.ux";

const CACHE_DIR = path.join(E2E_DIR, ".cache");
const WEBVIEW2_PROFILE = path.join(CACHE_DIR, "webview2");
const STORAGE_DIR = path.join(CACHE_DIR, "storage");
const DRIVER_CACHE = path.join(CACHE_DIR, "msedgedriver");
const PORT = Number(process.env.UX_DRIVER_PORT ?? 4444);
const IS_WINDOWS = process.platform === "win32";

let driverProcess = null;
let logBuffer = "";

export function driverLog() {
  return logBuffer;
}

function executable(name) {
  return IS_WINDOWS ? `${name}.exe` : name;
}

function tauriDriverBinary() {
  if (process.env.UX_TAURI_DRIVER) return process.env.UX_TAURI_DRIVER;
  const found = spawnSync(IS_WINDOWS ? "where" : "which", ["tauri-driver"], {
    encoding: "utf8",
  });
  if (found.status === 0) {
    const first = found.stdout.split(/\r?\n/).find((line) => line.trim() !== "");
    if (first) return first.trim();
  }
  const cargoBin = path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? "",
    ".cargo",
    "bin",
    executable("tauri-driver"),
  );
  if (fs.existsSync(cargoBin)) return cargoBin;
  throw new Error(
    "tauri-driver is not installed. Run: cargo install tauri-driver --locked",
  );
}

export function msedgedriverBinary() {
  const candidate = path.join(DRIVER_CACHE, executable("msedgedriver"));
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `msedgedriver is missing at ${candidate}. Run: npm run ux:setup`,
    );
  }
  return candidate;
}

/** Only the dedicated review identifier is ever removed. */
function appDataRoots() {
  return [
    process.env.APPDATA && path.join(process.env.APPDATA, UX_IDENTIFIER),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, UX_IDENTIFIER),
  ].filter(Boolean);
}

export function cleanAppData() {
  // A checklist run may seed the isolated home with copies of real projects;
  // UX_KEEP_APP_DATA=1 keeps them between runs.
  if (process.env.UX_KEEP_APP_DATA === "1") return;
  for (const dir of appDataRoots()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function appEnvironment() {
  return {
    ...process.env,
    // WebView2 keeps localStorage, cache and IndexedDB outside the app data
    // folder; without this the run would reuse the profile of the real app.
    WEBVIEW2_USER_DATA_FOLDER: WEBVIEW2_PROFILE,
    // Deterministic UI: Russian labels, light theme, no chat provider calls.
    GENTREE_APP_LANGUAGE: "ru",
    GENTREE_APP_THEME: "light",
    GENTREE_CHAT_ENABLED: "false",
    GENTREE_STORAGE_PROJECTS_DIR: path.join(STORAGE_DIR, "projects"),
    GENTREE_STORAGE_BACKUPS_DIR: path.join(STORAGE_DIR, "backups"),
    GENTREE_SEARCH_INDEX_DIR: path.join(STORAGE_DIR, "index"),
  };
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`tauri-driver did not listen on port ${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

/** Removes helpers left behind by a crashed run; never touches the real app. */
function stopStaleProcesses() {
  if (!IS_WINDOWS) return;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `Get-Process ${path.basename(APP_EXE, ".exe")} | Where-Object { $_.Path -eq '${APP_EXE}' } | Stop-Process -Force`,
    "Get-Process msedgedriver | Where-Object { $_.Path -like '*e2e*msedgedriver*' } | Stop-Process -Force",
    "Get-Process tauri-driver | Where-Object { $_.Path -like '*cargo*tauri-driver*' } | Stop-Process -Force",
    `foreach ($port in ${PORT}, 9515) { Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }`,
  ].join("; ");
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
  });
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 700"], {
    stdio: "ignore",
  });
}

export async function startDriver() {
  if (!IS_WINDOWS) {
    throw new Error(
      "The review harness currently supports Windows only (WebView2 + msedgedriver).",
    );
  }
  if (!fs.existsSync(APP_EXE)) {
    throw new Error(
      `Isolated app build not found at ${APP_EXE}. Run: npm run ux:build`,
    );
  }
  stopStaleProcesses();
  cleanAppData();
  fs.mkdirSync(WEBVIEW2_PROFILE, { recursive: true });
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  logBuffer = "";
  driverProcess = spawn(
    tauriDriverBinary(),
    [
      "--port",
      String(PORT),
      // Keep the native driver off 4445: it is tauri-driver's default and the
      // most common collision point with leftover helpers.
      "--native-port",
      "9515",
      "--native-driver",
      msedgedriverBinary(),
    ],
    { env: appEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (chunk) => {
    logBuffer += chunk.toString();
    if (process.env.UX_LOG_LEVEL === "debug") process.stderr.write(chunk);
  };
  driverProcess.stdout?.on("data", collect);
  driverProcess.stderr?.on("data", collect);
  driverProcess.on("exit", (code) => {
    logBuffer += `\ntauri-driver exited with ${code}\n`;
    driverProcess = null;
  });

  await waitForPort(PORT, 20000);
}

export async function stopDriver() {
  const child = driverProcess;
  driverProcess = null;
  if (!child || child.exitCode !== null) return;
  if (IS_WINDOWS) {
    // /T also stops msedgedriver; the app window is closed by afterSession.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}
