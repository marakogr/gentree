// Captures the Romanov demo screenshots from the real app.
//
//   node scripts/capture-romanov-screenshots.mjs [output-dir]
//
// Prerequisites: the isolated UX build (`npm --prefix desktop/ui run ux:build`),
// `make ux-setup`, and the generated demo project
// (`node scripts/make-demo-project-romanov.mjs demo/romanov ru`).
//
// The script starts on an empty isolated library, copies the project in, opens
// it and walks the eight screens used in the docs. It never touches the normal
// app data, and it does not open the Settings screen.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join(ROOT, "desktop", "target", "ux", "release", "gentree-desktop.exe");
const EDGE = path.join(ROOT, "desktop/ui/e2e/.cache/msedgedriver/msedgedriver.exe");
const DEMO = path.resolve(
  ROOT,
  process.env.CAPTURE_DEMO ?? "demo/romanov/d3e00000-0000-4000-8000-000000000011",
);
const PORT = 4455;
const NATIVE_PORT = 9516;
const SESSION_PATH = `http://127.0.0.1:${PORT}`;
const WIDTH = 1600;
const HEIGHT = 1000;
const OUT = path.resolve(
  process.argv[2] ??
    path.join(
      ROOT,
      "desktop/ui/e2e/artifacts",
      `romanov-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ),
);

const COPY = {
  projectName: "Демо: семья Романовых",
  open: "Открыть",
  people: "Люди",
  tree: "Дерево",
  ancestors: "Прямые предки",
  relatives: "Кровные родственники",
  both: "Предки и потомки",
  relation: "Родство",
  relationHeading: "Связь",
  findRelation: "Найти связь",
  events: "События",
  map: "Карта",
  timeline: "Хронология",
  chat: "Чат",
  edit: "Изменить",
  fromQuery: "Александр II",
  fromName: "Романов Александр II Николаевич",
  toQuery: "Алексей",
  toName: "Романов Алексей Николаевич",
  chatQuestion: "Как Ксения приходится Николаю II?",
  chatEdit:
    "Поменяй Николаю II заметку на «Последний император Всероссийский; расстрелян с семьёй в Екатеринбурге».",
};

function fail(message) {
  console.error(`romanov: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(APP)) fail(`isolated app not found at ${APP}; run ux:build`);
if (!fs.existsSync(EDGE)) fail(`msedgedriver not found at ${EDGE}; run ux:setup`);
if (!fs.existsSync(DEMO)) fail(`demo project not found at ${DEMO}; run the generator`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stopStale() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `Get-Process gentree-desktop | Where-Object { $_.Path -eq '${APP}' } | Stop-Process -Force`,
    "Get-Process tauri-driver | Stop-Process -Force",
    "Get-Process msedgedriver | Where-Object { $_.Path -like '*e2e*msedgedriver*' } | Stop-Process -Force",
    `foreach ($port in ${PORT}, ${NATIVE_PORT}) { Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }`,
  ].join("; ");
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
  });
  spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 700"],
    { stdio: "ignore" },
  );
}

async function waitForPort() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${SESSION_PATH}/status`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  fail(`tauri-driver did not listen on ${PORT}`);
}

async function request(method, route, body) {
  const response = await fetch(`${SESSION_PATH}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || (payload.value && payload.value.error)) {
    throw new Error(
      `${method} ${route}: ${payload.value?.error ?? payload.value?.message ?? response.status}`,
    );
  }
  return payload.value;
}

function driverBinary() {
  const found = spawnSync("where", ["tauri-driver"], { encoding: "utf8" });
  if (found.status === 0) {
    const line = found.stdout.split(/\r?\n/).find((item) => item.trim() !== "");
    if (line) return line.trim();
  }
  const fallback = path.join(process.env.USERPROFILE ?? "", ".cargo", "bin", "tauri-driver.exe");
  if (fs.existsSync(fallback)) return fallback;
  fail("tauri-driver is not installed; run cargo install tauri-driver --locked");
}

const projectsDir = path.join(process.env.APPDATA ?? "", "com.gentree.desktop.ux", "projects");

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  stopStale();

  // Scene 1 needs an empty library; the project is copied in afterwards.
  fs.rmSync(projectsDir, { recursive: true, force: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  const profile = path.join(ROOT, "desktop/ui/e2e/.cache/webview2-romanov");
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const driver = spawn(
    driverBinary(),
    ["--port", String(PORT), "--native-port", String(NATIVE_PORT), "--native-driver", EDGE],
    {
      env: {
        ...process.env,
        WEBVIEW2_USER_DATA_FOLDER: profile,
        GENTREE_APP_LANGUAGE: "ru",
        GENTREE_APP_THEME: "light",
        GENTREE_CHAT_ENABLED: "true",
        GENTREE_CHAT_SHOW_TOOLS: "false",
        GENTREE_CHAT_ALLOW_PERSON_EDITS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let driverLog = "";
  driver.stdout.on("data", (chunk) => (driverLog += chunk));
  driver.stderr.on("data", (chunk) => (driverLog += chunk));

  let sessionId = null;
  try {
    await waitForPort();
    const session = await request("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: APP } } },
    });
    sessionId = session.sessionId;
    const applyWindowRect = () =>
      request("POST", `/session/${sessionId}/window/rect`, {
        x: 20,
        y: 20,
        width: WIDTH,
        height: HEIGHT,
      });
    const frameSize = (buffer) => ({
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    });
    const ensureFrameSize = async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const probe = Buffer.from(
          await request("GET", `/session/${sessionId}/screenshot`),
          "base64",
        );
        const size = frameSize(probe);
        if (size.width === WIDTH && size.height === HEIGHT) return;
        if (attempt === 11) {
          throw new Error(`window is ${size.width}x${size.height}, expected ${WIDTH}x${HEIGHT}`);
        }
        await applyWindowRect();
        await sleep(600);
      }
    };
    await applyWindowRect();
    await sleep(900);
    await ensureFrameSize();

    const exec = (script, args = []) =>
      request("POST", `/session/${sessionId}/execute/sync`, { script, args });

    const waitFor = async (script, label, timeout = 30000, args = []) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          if (await exec(script, args)) return;
        } catch {
          // The page may be navigating.
        }
        await sleep(250);
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    const waitForSoft = async (script, timeout, args = []) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          if (await exec(script, args)) return true;
        } catch {
          // The page may be navigating.
        }
        await sleep(250);
      }
      return false;
    };

    const shot = async (name) => {
      await sleep(400);
      const data = await request("GET", `/session/${sessionId}/screenshot`);
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`shot ${file}`);
    };

    const clickText = async (label, selector = "button") => {
      const clicked = await exec(
        `const label=arguments[0], selector=arguments[1];
         const node=[...document.querySelectorAll(selector)].find(
           (element) => element.textContent.replace(/\\s+/g," ").trim() === label,
         );
         if (!node) return false;
         node.click();
         return true;`,
        [label, selector],
      );
      if (!clicked) throw new Error(`button "${label}" not found`);
    };

    const waitHeading = (label) =>
      waitFor(
        `const heading=document.querySelector("h1, [role='heading']");
         return Boolean(heading && heading.textContent.trim() === arguments[0]);`,
        `heading "${label}"`,
        30000,
        [label],
      );

    const choosePerson = async (selector, query, fullName) => {
      const typed = await exec(
        `const input=document.querySelector(arguments[0]);
         if (!input) return false;
         input.focus();
         input.click();
         const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
         setter.call(input, arguments[1]);
         input.dispatchEvent(new Event("input", { bubbles: true }));
         return true;`,
        [selector, query],
      );
      if (!typed) throw new Error(`person input ${selector} not found`);
      const deadline = Date.now() + 15000;
      let picked = false;
      while (Date.now() < deadline && !picked) {
        picked = await exec(
          `const name=arguments[0];
           const option=[...document.querySelectorAll('[role="option"]')].find(
             (item) => item.textContent.replace(/\\s+/g," ").includes(name),
           );
           if (!option) return false;
           option.click();
           return true;`,
          [fullName],
        );
        if (!picked) await sleep(200);
      }
      if (!picked) throw new Error(`person option "${fullName}" not found`);
      await sleep(400);
    };

    await waitFor(`return document.title === "Gentree";`, "the Gentree window");
    await waitFor(
      `return Boolean(document.querySelector(".projects-empty"));`,
      "the empty projects screen",
    );
    await sleep(1200);
    await shot("01-projects-before-import");

    // Copy the project in and let the Projects page reload.
    const seeded = path.join(projectsDir, path.basename(DEMO));
    fs.cpSync(DEMO, seeded, { recursive: true });
    await clickText("Справка", "nav button");
    await waitFor(`return document.body.innerText.includes("Справка");`, "the help screen");
    await sleep(500);
    await clickText("Проекты", "nav button");
    await waitFor(
      `return document.body.innerText.includes(arguments[0]);`,
      "the project row",
      25000,
      [COPY.projectName],
    );
    await sleep(900);
    await shot("02-projects-after-import");

    const opened = await exec(
      `const name=arguments[0], label=arguments[1];
       const row=[...document.querySelectorAll("tr")].find(
         (item) => item.innerText.includes(name),
       );
       if (!row) return false;
       const button=[...row.querySelectorAll("button")].find(
         (item) => item.textContent.trim() === label,
       );
       if (!button) return false;
       button.click();
       return true;`,
      [COPY.projectName, COPY.open],
    );
    if (!opened) throw new Error("could not open the project");
    await waitHeading(COPY.people);
    await sleep(1200);
    await shot("03-people");

    await clickText(COPY.tree, "nav button");
    await waitHeading(COPY.tree);
    await waitFor(`return document.querySelectorAll(".graph-node").length > 1;`, "the graph");
    // Ancestors and descendants at once: the whole imperial family around the
    // root, with photos and the kinship labels on the cards.
    await clickText(COPY.both);
    await sleep(2600);
    await shot("04-tree-ancestors");

    await clickText(COPY.relation, "nav button");
    await waitHeading(COPY.relationHeading);
    await waitFor(`return Boolean(document.querySelector("#path-from"));`, "the relation form");
    await sleep(400);
    await choosePerson("#path-from", COPY.fromQuery, COPY.fromName);
    await choosePerson("#path-to", COPY.toQuery, COPY.toName);
    await clickText(COPY.findRelation);
    await waitFor(
      `return document.querySelectorAll(".path-chain-link").length > 0;`,
      "the kinship path",
    );
    await sleep(1500);
    await shot("05-kinship");

    await clickText(COPY.events, "nav button");
    await waitHeading(COPY.events);
    await waitFor(
      `return Boolean(document.querySelector('[id^="event-row-"]'));`,
      "the event rows",
    );
    // The education event carries custom fields and an approximate year.
    const openedEvent = await exec(
      `const rows=[...document.querySelectorAll('[id^="event-row-"]')];
       const row=rows.find((item) => item.innerText.includes(arguments[0]));
       if (!row) return false;
       row.click();
       return true;`,
      ["Образование"],
    );
    if (!openedEvent) throw new Error("no education event row");
    await waitFor(`return Boolean(document.querySelector(".events-card-title"));`, "the event card");
    await sleep(800);
    await clickText(COPY.edit);
    await waitFor(`return Boolean(document.querySelector("#event-form"));`, "the event form");
    await sleep(800);
    await shot("06-event-card");

    await clickText('Отмена');
    await sleep(600);

    // Focus the map on European Russia: drag the view east and zoom in twice so
    // the place clusters separate instead of piling up on a world map.
    const dragMap = (fromX, fromY, toX, toY) =>
      request("POST", `/session/${sessionId}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", origin: "viewport", x: fromX, y: fromY, duration: 0 },
              { type: "pointerDown", button: 0 },
              { type: "pointerMove", origin: "viewport", x: toX, y: toY, duration: 500 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });

    await clickText(COPY.map, "nav button");
    await waitHeading(COPY.map);
    await waitFor(
      `return document.querySelectorAll(".map-marker").length > 0;`,
      "the map points",
      40000,
    );
    await clickText("Показать все точки");
    await sleep(1500);
    await dragMap(900, 520, 560, 520);
    await sleep(900);
    for (let step = 0; step < 2; step += 1) {
      const zoomed = await exec(
        `const node=[...document.querySelectorAll("button[aria-label]")].find(
           (item) => item.getAttribute("aria-label") === arguments[0] && !item.disabled,
         );
         if (!node) return false;
         node.click();
         return true;`,
        ["Приблизить"],
      );
      if (!zoomed) break;
      await sleep(1200);
    }
    const tiles = await waitForSoft(
      `return document.querySelectorAll(".leaflet-tile-loaded").length > 6;`,
      12000,
    );
    console.log(`  map tiles: ${tiles ? "osm" : "offline outline"}`);
    await sleep(1500);
    await shot("07-map");

    await clickText(COPY.timeline, "nav button");
    await waitFor(
      `return Boolean(document.querySelector('[data-testid="timeline-line-page"]'));`,
      "the timeline",
      30000,
    );
    await waitFor(
      `const count=document.querySelector('[data-testid="line-count"]');
       return Boolean(count && count.textContent.trim() !== "");`,
      "the timeline events",
      30000,
    );
    await sleep(2500);
    // Zoom into the imperial era so single events separate from the clusters.
    for (let step = 0; step < 2; step += 1) {
      const zoomed = await exec(
        `const node=document.querySelector('[data-testid="line-zoom-in"]');
         if (!node) return false;
         node.click();
         return true;`,
      );
      if (!zoomed) break;
      await sleep(1200);
    }
    await sleep(1500);
    await shot("09-timeline");

    await clickText(COPY.chat, "nav button");
    await waitFor(
      `return Boolean(document.querySelector(".chat-compose-textarea textarea"));`,
      "the chat composer",
    );
    await sleep(800);

    const fillChat = (value) =>
      exec(
        `const input=document.querySelector(".chat-compose-textarea textarea");
         if (!input) return false;
         input.focus();
         const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
         setter.call(input, arguments[0]);
         input.dispatchEvent(new Event("input", { bubbles: true }));
         return true;`,
        [value],
      );

    await fillChat(COPY.chatQuestion);
    await sleep(300);
    await clickText("Отправить");
    await waitFor(
      `return document.querySelectorAll(".chat-answer-actions").length > 0;`,
      "the chat answer",
      240000,
    );
    await sleep(800);

    await fillChat(COPY.chatEdit);
    await sleep(300);
    await clickText("Отправить");
    const proposed = await waitForSoft(
      `return Boolean(document.querySelector(".chat-confirm"));`,
      180000,
    );
    if (!proposed) throw new Error("the assistant did not propose the change");
    await sleep(1200);
    await shot("08-chat-assistant");

    console.log(`screenshots: ${OUT}`);
  } catch (error) {
    console.error(`romanov failed: ${error.message}`);
    if (sessionId) {
      try {
        const text = await request("POST", `/session/${sessionId}/execute/sync`, {
          script: "return document.body.innerText.slice(0, 2000);",
          args: [],
        });
        console.error(`page text:\n${text}`);
        const data = await request("GET", `/session/${sessionId}/screenshot`);
        fs.writeFileSync(path.join(OUT, "00-failure.png"), Buffer.from(data, "base64"));
      } catch {
        // The session may already be gone.
      }
    }
    if (driverLog.trim() !== "") console.error(driverLog.slice(-3000));
    process.exitCode = 1;
  } finally {
    if (sessionId) await request("DELETE", `/session/${sessionId}`).catch(() => undefined);
    driver.kill();
    stopStale();
  }
}

main();
