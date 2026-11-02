// DOM audits executed inside the WebView.
//
// Every function here is self-contained: WebdriverIO serialises the source and
// runs it in the page, so nothing may close over module scope.
//
// The audits are evidence collectors for a human review, not WCAG conformance
// tests. Contrast values, for example, are candidates to verify on the
// screenshot, because layered backgrounds and images are approximated.

export function auditPage() {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0.01
    );
  };

  const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (joined) return joined;
    }
    const text = textOf(el);
    if (text) return text.slice(0, 80);
    for (const attribute of ["title", "placeholder", "alt"]) {
      const value = el.getAttribute(attribute);
      if (value && value.trim()) return value.trim();
    }
    return "";
  };

  const roleOf = (el) =>
    el.getAttribute("role") ||
    {
      A: "link",
      BUTTON: "button",
      INPUT: "textbox",
      TEXTAREA: "textbox",
      SELECT: "combobox",
      SUMMARY: "button",
    }[el.tagName] ||
    el.tagName.toLowerCase();

  const interactiveSelector =
    'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="option"],[role="menuitem"],[role="textbox"],[tabindex]:not([tabindex="-1"])';

  const controls = [...document.querySelectorAll(interactiveSelector)]
    .filter(visible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        name: accessibleName(el),
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        fontSize: style.fontSize,
        cursor: style.cursor,
      };
    });

  const parseColor = (value) => {
    const match = value && value.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number.parseFloat(part));
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: parts.length > 3 ? parts[3] : 1,
    };
  };

  const effectiveBackground = (el) => {
    let node = el;
    let accumulated = null;
    while (node && node !== document.documentElement) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0) {
        accumulated = accumulated
          ? {
              r: color.r * color.a + accumulated.r * (1 - color.a),
              g: color.g * color.a + accumulated.g * (1 - color.a),
              b: color.b * color.a + accumulated.b * (1 - color.a),
              a: 1,
            }
          : color;
        if (accumulated.a >= 0.99) return accumulated;
      }
      node = node.parentElement;
    }
    return accumulated && accumulated.a >= 0.99
      ? accumulated
      : parseColor(getComputedStyle(document.body).backgroundColor) || {
          r: 255,
          g: 255,
          b: 255,
          a: 1,
        };
  };

  const luminance = (color) => {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928
        ? scaled / 12.92
        : Math.pow((scaled + 0.055) / 1.055, 2.4);
    };
    return (
      0.2126 * channel(color.r) +
      0.7152 * channel(color.g) +
      0.0722 * channel(color.b)
    );
  };

  const contrastRatio = (a, b) => {
    const first = luminance(a);
    const second = luminance(b);
    return (
      (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
    );
  };

  const contrastIssues = [];
  const seenColors = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const hasText = [...el.childNodes].some(
      (node) => node.nodeType === 3 && node.textContent.trim().length > 1,
    );
    if (!hasText) continue;
    const style = getComputedStyle(el);
    const foreground = parseColor(style.color);
    if (!foreground) continue;
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    const background = effectiveBackground(el);
    const flatForeground =
      foreground.a < 1
        ? {
            r: foreground.r * foreground.a + background.r * (1 - foreground.a),
            g: foreground.g * foreground.a + background.g * (1 - foreground.a),
            b: foreground.b * foreground.a + background.b * (1 - foreground.a),
          }
        : foreground;
    const ratio = contrastRatio(flatForeground, background);
    const key = `${style.color}|${style.backgroundColor}|${size}|${weight}`;
    if (ratio < required && !seenColors.has(key)) {
      seenColors.add(key);
      contrastIssues.push({
        text: textOf(el).slice(0, 60),
        ratio: Math.round(ratio * 100) / 100,
        required,
        color: style.color,
        fontSize: style.fontSize,
        weight,
        tag: el.tagName.toLowerCase(),
        className: String(el.className || "").slice(0, 80),
      });
    }
  }

  const overflow = [...document.querySelectorAll("body *")]
    .filter(visible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        className: String(el.className || "").slice(0, 60),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        text: textOf(el).slice(0, 40),
      };
    })
    .filter((item) => item.right > innerWidth + 2 || item.left < -2);

  const bodyText = document.body.innerText;
  const i18nLeaks = [
    ...new Set(
      bodyText.match(/\b[a-z][a-zA-Z0-9]*:[a-zA-Z][a-zA-Z0-9_.]{2,}\b/g) || [],
    ),
  ].slice(0, 30);

  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    scroll: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    },
    lang: document.documentElement.lang,
    theme: document.documentElement.getAttribute("data-theme"),
    bodyText: bodyText.slice(0, 2000),
    controls,
    unnamedControls: controls.filter((item) => !item.name && !item.disabled),
    smallTargets: controls.filter(
      (item) => !item.disabled && (item.rect.w < 24 || item.rect.h < 24),
    ),
    contrastIssues,
    overflow: overflow.slice(0, 40),
    i18nLeaks,
  };
}

/** Focused element with the styles a focus indicator would be drawn with. */
export function focusState() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;

  const describe = (node) => {
    const style = getComputedStyle(node);
    const after = getComputedStyle(node, "::after");
    const before = getComputedStyle(node, "::before");
    const hasOutline = (value) =>
      value.outlineStyle !== "none" && Number.parseFloat(value.outlineWidth) > 0;
    const hasShadow = (value) => value.boxShadow && value.boxShadow !== "none";
    return {
      tag: node.tagName.toLowerCase(),
      className: String(node.className || "").slice(0, 80),
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      boxShadow: String(style.boxShadow || "").slice(0, 80),
      border: `${style.borderBottomWidth} ${style.borderBottomStyle} ${style.borderBottomColor}`,
      indicator:
        hasOutline(style) ||
        hasShadow(style) ||
        hasOutline(after) ||
        hasShadow(after) ||
        hasOutline(before) ||
        hasShadow(before),
    };
  };

  const chain = [];
  let node = el;
  for (let depth = 0; depth < 3 && node; depth += 1) {
    chain.push(describe(node));
    node = node.parentElement;
  }

  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || "",
    name:
      el.getAttribute("aria-label") ||
      (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) ||
      el.getAttribute("placeholder") ||
      "",
    rect: (() => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    })(),
    indicator: chain.some((item) => item.indicator),
    chain,
  };
}
