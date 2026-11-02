// Pure chat presentation helpers: human-readable tool durations and the
// local/external provider check for the privacy notice.
//
// Units are translated by the caller (`chat:durationMs` / `chat:durationSec`),
// so this module stays free of locale strings.

export type DurationUnit = "ms" | "s";

export type DurationValue = {
  unit: DurationUnit;
  /** Already formatted for the locale (decimal comma in Russian). */
  value: string;
};

const MS_IN_SECOND = 1000;

/**
 * `850` -> `850 ms`, `1250` -> `1.2 s`. Sub-second timings stay in
 * milliseconds because tool calls are usually fast and exact numbers help.
 */
export function durationParts(
  milliseconds: number,
  locale: string,
): DurationValue {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return { unit: "ms", value: "0" };
  }
  if (milliseconds < MS_IN_SECOND) {
    return { unit: "ms", value: String(Math.round(milliseconds)) };
  }
  const seconds = milliseconds / MS_IN_SECOND;
  const rounded =
    seconds >= 10
      ? String(Math.round(seconds))
      : seconds.toFixed(1).replace(/\.0$/, "");
  return {
    unit: "s",
    value: locale === "en" ? rounded : rounded.replace(".", ","),
  };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_HOST = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True only for loopback endpoints. Anything else (including an empty value,
 * another machine in the LAN or a public API) is treated as an external
 * service, so the UI never understates where the data goes.
 */
export function isLocalProviderUrl(baseUrl: string): boolean {
  const value = baseUrl.trim();
  if (value === "") return false;

  let host: string;
  try {
    const url = new URL(SCHEME.test(value) ? value : `http://${value}`);
    host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return LOCAL_HOST.test(host);
}
