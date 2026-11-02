/*
 * Gentree Launcher UI.
 *
 * Plain ES2020, no build step. All user-facing text comes from
 * `locales/*.json`; this file contains no localized strings.
 * Feed notes are untrusted remote text and are only ever inserted with
 * `textContent`.
 */

"use strict";

const LOCALES = ["en", "uk", "ru"];
const FALLBACK_LOCALE = "en";
const LOCALE_TAGS = { en: "en-US", uk: "uk-UA", ru: "ru-RU" };
const LOCALE_KEY = "gentree.launcher.locale";
const RECHECK_INTERVAL_MS = 30 * 60 * 1000;

const state = {
  locale: FALLBACK_LOCALE,
  strings: {},
  info: null,
  feed: null,
  showPrerelease: false,
  busy: false,
  checking: false,
  progress: null,
  notice: null,
  lastCheck: 0,
};

const el = {
  autoCheck: document.getElementById("auto-check"),
  locale: document.getElementById("locale"),
  installed: document.getElementById("installed-version"),
  latest: document.getElementById("latest-version"),
  updateBadge: document.getElementById("update-badge"),
  headline: document.getElementById("headline"),
  headlineDetail: document.getElementById("headline-detail"),
  installLatest: document.getElementById("install-latest"),
  openApp: document.getElementById("open-app"),
  refresh: document.getElementById("refresh"),
  showPrerelease: document.getElementById("show-prerelease"),
  list: document.getElementById("version-list"),
  empty: document.getElementById("empty"),
  progress: document.getElementById("progress"),
  progressPhase: document.getElementById("progress-phase"),
  progressValue: document.getElementById("progress-value"),
  progressTrack: document.getElementById("progress-track"),
  progressBar: document.getElementById("progress-bar"),
  message: document.getElementById("message"),
  platform: document.getElementById("platform"),
  feedHost: document.getElementById("feed-host"),
};

function tauriApi() {
  const api = window.__TAURI__;
  if (!api || !api.core || !api.event) {
    return null;
  }
  return api;
}

function invoke(command, args) {
  const api = tauriApi();
  if (!api) {
    return Promise.reject({ code: "internal" });
  }
  return api.core.invoke(command, args);
}

function t(key, params) {
  const template = Object.prototype.hasOwnProperty.call(state.strings, key)
    ? state.strings[key]
    : key;
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

function hasString(key) {
  return Object.prototype.hasOwnProperty.call(state.strings, key);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) {
    return `${megabytes.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(LOCALE_TAGS[state.locale] || "en-US", {
      dateStyle: "medium",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/* Localization ------------------------------------------------------------ */

function detectLocale() {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored && LOCALES.includes(stored)) {
      return stored;
    }
  } catch {
    /* storage can be unavailable; fall through to the OS language */
  }
  const candidates = navigator.languages || [navigator.language || ""];
  for (const candidate of candidates) {
    const base = String(candidate).toLowerCase().split("-")[0];
    if (LOCALES.includes(base)) {
      return base;
    }
  }
  return FALLBACK_LOCALE;
}

async function loadDictionary(locale) {
  try {
    const response = await fetch(`locales/${locale}.json`, { cache: "no-store" });
    if (!response.ok) {
      return {};
    }
    const parsed = await response.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function applyLocale(locale, persist) {
  const chosen = LOCALES.includes(locale) ? locale : FALLBACK_LOCALE;
  const base = await loadDictionary(FALLBACK_LOCALE);
  const selected = chosen === FALLBACK_LOCALE ? base : await loadDictionary(chosen);
  state.strings = Object.assign({}, base, selected);
  state.locale = chosen;
  document.documentElement.lang = chosen;
  if (persist) {
    try {
      localStorage.setItem(LOCALE_KEY, chosen);
    } catch {
      /* non-fatal */
    }
  }
  if (el.locale) {
    el.locale.value = chosen;
  }
  for (const option of el.locale ? Array.from(el.locale.options) : []) {
    option.textContent = t(`lang.${option.value}`);
  }
  applyStaticText();
  renderAll();
  renderNotice();
}

function applyStaticText() {
  document.title = t("app.title");
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-aria]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAria));
  }
}

/* Notices ----------------------------------------------------------------- */

function showError(error) {
  const code =
    error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : "generic";
  state.notice = { kind: "error", code };
  renderNotice();
}

function showNotice(kind, key, params) {
  state.notice = { kind, key, params };
  renderNotice();
}

function clearNotice() {
  state.notice = null;
  renderNotice();
}

function renderNotice() {
  if (!state.notice) {
    el.message.classList.add("hidden");
    el.message.replaceChildren();
    return;
  }
  const { kind, code, key, params } = state.notice;
  let text;
  if (code) {
    const key2 = `error.${code}`;
    text = hasString(key2) ? t(key2) : t("error.generic");
  } else {
    text = t(key, params || {});
  }
  el.message.className = `message ${kind}`;
  el.message.replaceChildren(document.createTextNode(text));
  if (code) {
    el.message.append(make("code", "", code));
  }
}

/* Rendering --------------------------------------------------------------- */

function renderAll() {
  renderCards();
  renderHeadline();
  renderVersions();
  renderProgress();
}

function renderCards() {
  const info = state.info;
  const feed = state.feed;
  el.autoCheck.checked = Boolean(info && info.autoCheck);
  el.autoCheck.disabled = !info || state.busy;

  el.installed.textContent = info && info.installedVersion
    ? `v${info.installedVersion}`
    : t("label.notInstalled");

  el.latest.textContent = feed && feed.latest ? `v${feed.latest}` : "\u2014";

  const updateState = feed ? feed.updateState : "unknown";
  el.updateBadge.className = "badge";
  if (updateState === "updateAvailable") {
    el.updateBadge.textContent = t("status.updateAvailable");
    el.updateBadge.classList.add("warning");
  } else if (updateState === "upToDate") {
    el.updateBadge.textContent = t("status.upToDate");
    el.updateBadge.classList.add("success");
  } else if (updateState === "installedNewer") {
    el.updateBadge.textContent = t("status.installedNewer");
    el.updateBadge.classList.add("accent");
  } else {
    el.updateBadge.textContent = "";
    el.updateBadge.classList.add("hidden");
  }

  el.platform.textContent = info && info.platform
    ? info.platform.os
      ? `${info.platform.os} \u00b7 ${info.platform.arch || "?"}`
      : t("footer.unsupported")
    : "";
  el.feedHost.textContent = feedHost();
}

function feedHost() {
  if (!state.feed || !state.feed.feedUrl) {
    return "";
  }
  try {
    return new URL(state.feed.feedUrl).host;
  } catch {
    return "";
  }
}

function renderHeadline() {
  const feed = state.feed;
  const info = state.info;
  const installed = feed ? feed.installedVersion : info && info.installedVersion;
  const latest = feed && feed.latest;
  const latestRow = feed && latest ? findVersion(feed, latest) : null;

  let headline;
  let detail;

  if (!feed) {
    headline = t("headline.install");
    detail = info && info.autoCheck === false ? t("detail.disabled") : t("state.loading");
  } else if (!latest) {
    headline = t("headline.unknown");
    detail = t("state.empty");
  } else if (!installed) {
    headline = t("headline.install");
    detail = t("detail.install");
  } else if (feed.updateState === "updateAvailable") {
    headline = t("headline.update", { version: latest });
    detail = t("detail.update", { installed, latest });
  } else if (feed.updateState === "installedNewer") {
    headline = t("headline.installedNewer");
    detail = t("detail.installedNewer");
  } else {
    headline = t("headline.upToDate");
    detail = t("detail.upToDate", { version: installed || latest });
  }

  el.headline.textContent = headline;
  el.headlineDetail.textContent = detail;

  const canInstall =
    Boolean(latestRow && latestRow.available) &&
    Boolean(feed && feed.platformSupported) &&
    !state.busy;
  el.installLatest.disabled = !canInstall;
  el.installLatest.textContent = latest
    ? t("action.installLatestWith", { version: latest })
    : t("action.installLatest");
  el.openApp.disabled = state.busy;
  el.refresh.disabled = state.busy || state.checking;
}

function findVersion(feed, version) {
  if (!feed || !Array.isArray(feed.versions)) {
    return null;
  }
  return feed.versions.find((entry) => entry.version === version) || null;
}

function renderVersions() {
  const feed = state.feed;
  el.list.replaceChildren();

  if (!feed) {
    el.empty.textContent =
      state.checking
        ? t("state.loading")
        : state.info && state.info.autoCheck === false
          ? t("state.disabled")
          : t("state.empty");
    el.empty.classList.remove("hidden");
    return;
  }

  const visible = feed.versions.filter(
    (entry) => state.showPrerelease || !entry.prerelease,
  );
  if (visible.length === 0) {
    el.empty.textContent = t("state.noVersions");
    el.empty.classList.remove("hidden");
    return;
  }
  el.empty.classList.add("hidden");
  for (const entry of visible) {
    el.list.append(buildVersionRow(entry));
  }
}

function buildVersionRow(entry) {
  const row = make("li", "version");
  const main = make("div", "version-main");
  const title = make("div", "version-title");
  title.append(make("span", "version-number", `v${entry.version}`));
  if (entry.latest) {
    title.append(make("span", "badge accent", t("badge.latest")));
  }
  if (entry.installed) {
    title.append(make("span", "badge success", t("badge.installed")));
  }
  if (entry.prerelease) {
    title.append(make("span", "badge", t("badge.prerelease")));
  }
  main.append(title);

  const meta = make("div", "version-meta");
  const released = formatDate(entry.released);
  if (released) {
    meta.append(make("span", "", released));
  }
  if (entry.kind) {
    meta.append(make("span", "", String(entry.kind).toUpperCase()));
  }
  if (entry.arch) {
    meta.append(make("span", "", entry.arch));
  }
  const size = formatBytes(entry.size);
  if (size) {
    meta.append(make("span", "", size));
  }
  if (!entry.available) {
    meta.append(make("span", "", t("badge.unavailable")));
  }
  main.append(meta);

  if (entry.notes) {
    main.append(make("p", "version-notes", entry.notes));
  }

  const button = make(
    "button",
    "row-button",
    entry.installed ? t("action.reinstall") : t("action.install"),
  );
  button.type = "button";
  button.disabled = state.busy || !entry.available;
  button.addEventListener("click", () => {
    installVersion(entry.version);
  });

  row.append(main, button);
  return row;
}

function renderProgress() {
  if (!state.progress) {
    el.progress.classList.add("hidden");
    return;
  }
  el.progress.classList.remove("hidden");
  const { phase, received, total } = state.progress;
  const labelKey = `progress.${phase}`;
  el.progressPhase.textContent = hasString(labelKey) ? t(labelKey) : phase;
  const percent =
    Number.isFinite(total) && total > 0
      ? Math.min(100, Math.floor((received / total) * 100))
      : null;
  el.progressValue.textContent =
    percent === null ? formatBytes(received) : `${percent}%`;
  if (percent === null) {
    el.progressBar.classList.add("indeterminate");
    el.progressBar.style.width = "";
    el.progressTrack.removeAttribute("aria-valuenow");
  } else {
    el.progressBar.classList.remove("indeterminate");
    el.progressBar.style.width = `${percent}%`;
    el.progressTrack.setAttribute("aria-valuenow", String(percent));
  }
}

/* Actions ----------------------------------------------------------------- */

async function refreshInfo() {
  try {
    state.info = await invoke("launcher_info");
  } catch (error) {
    showError(error);
  }
  renderAll();
}

async function refreshFeed(options) {
  const manual = Boolean(options && options.manual);
  if (state.busy || state.checking) {
    return;
  }
  state.checking = true;
  renderAll();
  try {
    const feed = await invoke("feed_load", {
      refresh: manual || state.feed !== null,
    });
    state.feed = feed;
    state.lastCheck = Date.now();
    if (feed.versions.length > 0 && feed.versions.every((entry) => entry.prerelease)) {
      state.showPrerelease = true;
      el.showPrerelease.checked = true;
    }
    if (manual) {
      if (feed.updateState === "updateAvailable") {
        showNotice("info", "status.updateAvailable");
      } else if (feed.updateState === "upToDate") {
        showNotice("success", "status.upToDate");
      }
    } else if (feed.updateState === "updateAvailable" && !state.notice) {
      showNotice("info", "status.updateAvailable");
    }
  } catch (error) {
    showError(error);
  } finally {
    state.checking = false;
    renderAll();
  }
}

async function installVersion(version) {
  if (state.busy || !version) {
    return;
  }
  state.busy = true;
  clearNotice();
  state.progress = { phase: "download", received: 0, total: null };
  renderAll();
  try {
    const outcome = await invoke("install_version", { version });
    state.progress = null;
    if (outcome && outcome.manualStep) {
      showNotice("info", "status.manualDmg");
    } else {
      showNotice("success", "status.installed", {
        version: outcome && outcome.version ? outcome.version : version,
      });
    }
  } catch (error) {
    state.progress = null;
    showError(error);
  } finally {
    state.busy = false;
  }

  await refreshInfo();
  try {
    // Keep the success notice if only the follow-up feed refresh fails.
    state.feed = await invoke("feed_load", { refresh: true });
  } catch {
    /* the installed version is already reported above */
  }
  renderAll();
}

async function openInstalled() {
  try {
    await invoke("open_app");
    clearNotice();
  } catch (error) {
    showError(error);
  }
}

async function updateAutoCheck(enabled) {
  try {
    const settings = await invoke("settings_update", { autoCheck: enabled });
    if (state.info) {
      state.info.autoCheck = Boolean(settings && settings.autoCheck);
    }
    clearNotice();
    if (enabled && !state.feed) {
      await refreshFeed();
    }
  } catch (error) {
    el.autoCheck.checked = !enabled;
    showError(error);
  }
}

function updateProgress(payload) {
  if (!payload || !state.busy) {
    return;
  }
  state.progress = {
    phase: payload.phase || "download",
    received: Number(payload.received) || 0,
    total:
      payload.total === null || payload.total === undefined
        ? null
        : Number(payload.total),
  };
  renderProgress();
}

/* Boot -------------------------------------------------------------------- */

function bindEvents() {
  el.locale.addEventListener("change", () => {
    applyLocale(el.locale.value, true);
  });
  el.autoCheck.addEventListener("change", () => {
    updateAutoCheck(el.autoCheck.checked);
  });
  el.showPrerelease.addEventListener("change", () => {
    state.showPrerelease = el.showPrerelease.checked;
    renderVersions();
  });
  el.refresh.addEventListener("click", () => {
    refreshFeed({ manual: true });
  });
  el.installLatest.addEventListener("click", () => {
    if (state.feed && state.feed.latest) {
      installVersion(state.feed.latest);
    }
  });
  el.openApp.addEventListener("click", () => {
    openInstalled();
  });
  window.addEventListener("focus", () => {
    if (!state.info || !state.info.autoCheck || state.busy || state.checking) {
      return;
    }
    if (Date.now() - state.lastCheck < RECHECK_INTERVAL_MS) {
      return;
    }
    refreshFeed();
  });
}

async function boot() {
  bindEvents();
  await applyLocale(detectLocale(), false);

  const api = tauriApi();
  if (api) {
    try {
      await api.event.listen("launcher-progress", (event) => {
        updateProgress(event.payload);
      });
    } catch {
      /* progress is optional; the install still reports its outcome */
    }
  } else {
    showError({ code: "internal" });
  }

  await refreshInfo();
  if (state.info && state.info.autoCheck) {
    await refreshFeed();
  } else {
    renderAll();
  }
}

boot();
