// Fluent 2 theme for the desktop app.
//
// The brand ramp is the product's blue accent; everything else comes from
// Fluent's web themes so light/dark/high-contrast stay consistent with the
// component library. Stops run from 10 (lightest) to 160 (darkest).

import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

export const brand: BrandVariants = {
  10: "#f1f5fc",
  20: "#dfe8f8",
  30: "#c2d3f0",
  40: "#9db8e6",
  50: "#7597d8",
  60: "#537bc9",
  70: "#3c66bb",
  80: "#2f58ad",
  90: "#284b94",
  100: "#223f7b",
  110: "#1c3464",
  120: "#172a50",
  130: "#13213d",
  140: "#0f192e",
  150: "#0a1120",
  160: "#060a14",
};

/**
 * Typography comes from the self-hosted Medeo family (src/fonts.css). The CSS
 * variables keep one stack for the stylesheets, Tailwind utilities and Fluent
 * components; Fluent's own defaults are Segoe UI / Consolas / Bahnschrift.
 */
const medeoType = {
  fontFamilyBase: "var(--font-medeo-sans)",
  fontFamilyMonospace: "var(--font-medeo-mono)",
  // Medeo Sans carries tabular figures, so numeric cells stay aligned.
  fontFamilyNumeric: "var(--font-medeo-sans)",
} satisfies Pick<
  Theme,
  "fontFamilyBase" | "fontFamilyMonospace" | "fontFamilyNumeric"
>;

export const lightTheme: Theme = {
  ...createLightTheme(brand),
  ...medeoType,
  // Keep white-on-brand readable at every state; hover and pressed darken
  // instead of jumping to the light end of the ramp.
  colorBrandBackgroundHover: brand[90],
  colorBrandBackgroundPressed: brand[100],
  colorBrandBackgroundSelected: brand[90],
  colorBrandForeground1: brand[80],
  colorBrandForeground2: brand[70],
  colorBrandForeground2Hover: brand[80],
  colorBrandForeground2Pressed: brand[90],
  colorBrandForegroundLink: brand[70],
  colorBrandForegroundLinkHover: brand[80],
  colorBrandForegroundLinkPressed: brand[90],
  colorBrandForegroundLinkSelected: brand[70],
  colorBrandStroke1: brand[80],
  colorCompoundBrandForeground1: brand[70],
  colorCompoundBrandForeground1Hover: brand[80],
  colorCompoundBrandForeground1Pressed: brand[90],
  colorCompoundBrandStroke: brand[80],
  colorCompoundBrandStrokeHover: brand[90],
  colorCompoundBrandStrokePressed: brand[100],
};

const baseDarkTheme: Theme = createDarkTheme(brand);

/**
 * The dark theme keeps Fluent's neutral ramp but adds a faint blue cast to
 * surfaces and strokes, matching the older desktop palette without turning the
 * whole UI navy. The brand foregrounds become a light blue so links and icons
 * stay readable on the dark surfaces.
 */
export const darkTheme: Theme = {
  ...baseDarkTheme,
  ...medeoType,
  colorNeutralBackground1: "#171b23",
  colorNeutralBackground1Hover: "#1c212b",
  colorNeutralBackground1Pressed: "#202633",
  colorNeutralBackground1Selected: "#232a38",
  colorNeutralBackground2: "#11141b",
  colorNeutralBackground2Hover: "#161a22",
  colorNeutralBackground2Pressed: "#1a2029",
  colorNeutralBackground2Selected: "#1f2633",
  colorNeutralBackground3: "#1b2029",
  colorNeutralBackground3Hover: "#202632",
  colorNeutralBackground3Pressed: "#252c39",
  colorNeutralBackground4: "#202631",
  colorNeutralBackground5: "#252c39",
  colorNeutralBackground6: "#2a3240",
  colorNeutralStroke1: "#343b49",
  colorNeutralStroke2: "#2a303c",
  colorNeutralStroke3: "#222833",
  colorNeutralStrokeAccessible: "#5b6578",
  colorBrandForeground1: brand[40],
  colorBrandForeground2: brand[30],
  colorBrandForeground2Hover: brand[20],
  colorBrandForeground2Pressed: brand[10],
  colorBrandForegroundLink: brand[40],
  colorBrandForegroundLinkHover: brand[30],
  colorBrandForegroundLinkPressed: brand[20],
  colorBrandForegroundLinkSelected: brand[40],
  colorBrandStroke1: brand[40],
  colorCompoundBrandForeground1: brand[40],
  colorCompoundBrandForeground1Hover: brand[30],
  colorCompoundBrandForeground1Pressed: brand[20],
  colorCompoundBrandStroke: brand[40],
  colorCompoundBrandStrokeHover: brand[30],
  colorCompoundBrandStrokePressed: brand[20],
};

// ---------------------------------------------------------------------------
// Swiss Archive (design-system/gentree): the second `data-style`, opt-in.
//
// Same Medeo family and the same design tokens, but a paper/ink neutral ramp,
// one accent reserved for state, square geometry and hairline separations.
// Values are the measured tokens from design-system/gentree/MASTER.md; every
// text and UI-boundary pair passes WCAG AA (see contrast-report.md). The Swiss
// palette overrides the classic blue brand on purpose: it is a separate
// measured design language, not a recolour of the default theme.
//
// `borderRadius*` and `shadow*` are part of the Fluent theme, so overriding
// them here is what makes Button / Input / Tag / Dialog / Switch / Table
// follow the language without any component changes.
// ---------------------------------------------------------------------------

const swissRadii = {
  borderRadiusNone: "0",
  borderRadiusSmall: "0",
  borderRadiusMedium: "2px",
  borderRadiusLarge: "0",
  borderRadiusXLarge: "0",
  borderRadius2XLarge: "0",
  borderRadius3XLarge: "0",
  borderRadius4XLarge: "0",
  borderRadius5XLarge: "0",
  borderRadius6XLarge: "0",
  borderRadiusCircular: "2px",
} satisfies Pick<
  Theme,
  | "borderRadiusNone"
  | "borderRadiusSmall"
  | "borderRadiusMedium"
  | "borderRadiusLarge"
  | "borderRadiusXLarge"
  | "borderRadius2XLarge"
  | "borderRadius3XLarge"
  | "borderRadius4XLarge"
  | "borderRadius5XLarge"
  | "borderRadius6XLarge"
  | "borderRadiusCircular"
>;

/**
 * No soft elevation: a 1px ring keeps menus and dialogs separated from the
 * surface while staying flat. The ring uses the decorative hairline; the
 * dialog itself is additionally isolated by the scrim.
 */
function flatShadows(ring: string) {
  const shadow = `0 0 0 1px ${ring}`;
  return {
    shadow2: shadow,
    shadow4: shadow,
    shadow8: shadow,
    shadow16: shadow,
    shadow28: shadow,
    shadow64: shadow,
    shadow2Brand: shadow,
    shadow4Brand: shadow,
    shadow8Brand: shadow,
    shadow16Brand: shadow,
    shadow28Brand: shadow,
    shadow64Brand: shadow,
  } satisfies Pick<
    Theme,
    | "shadow2"
    | "shadow4"
    | "shadow8"
    | "shadow16"
    | "shadow28"
    | "shadow64"
    | "shadow2Brand"
    | "shadow4Brand"
    | "shadow8Brand"
    | "shadow16Brand"
    | "shadow28Brand"
    | "shadow64Brand"
  >;
}

/** Print-like paper in light mode. */
export const swissLightTheme: Theme = {
  ...createLightTheme(brand),
  ...medeoType,
  ...swissRadii,
  ...flatShadows("#d3d7cf"),

  colorBackgroundOverlay: "rgba(18, 22, 26, 0.55)",

  colorNeutralBackground1: "#fbfbf8",
  colorNeutralBackground1Hover: "#f4f5f1",
  colorNeutralBackground1Pressed: "#eceee8",
  colorNeutralBackground1Selected: "#e7e9e4",
  colorNeutralBackground2: "#f2f3ef",
  colorNeutralBackground2Hover: "#eceee8",
  colorNeutralBackground2Pressed: "#e4e6e0",
  colorNeutralBackground2Selected: "#e7e9e4",
  colorNeutralBackground3: "#e7e9e4",
  colorNeutralBackground3Hover: "#e1e3dd",
  colorNeutralBackground3Pressed: "#d9dbd5",
  colorNeutralBackground3Selected: "#dce8e6",
  colorNeutralBackground4: "#e2e4de",
  colorNeutralBackground5: "#dcded8",
  colorNeutralBackground6: "#d3d7cf",
  colorNeutralBackgroundDisabled: "#e7e9e4",
  colorNeutralBackgroundDisabled2: "#f2f3ef",
  colorNeutralCardBackground: "#fbfbf8",
  colorNeutralCardBackgroundHover: "#f4f5f1",

  colorNeutralForeground1: "#12161a",
  colorNeutralForeground1Hover: "#0b0f12",
  colorNeutralForeground1Pressed: "#05080a",
  colorNeutralForeground1Selected: "#12161a",
  colorNeutralForeground2: "#3a4247",
  colorNeutralForeground2Hover: "#12161a",
  colorNeutralForeground2Pressed: "#05080a",
  colorNeutralForeground2Selected: "#12161a",
  colorNeutralForeground3: "#5b6469",
  colorNeutralForeground3Hover: "#3a4247",
  colorNeutralForeground3Pressed: "#12161a",
  colorNeutralForeground3Selected: "#3a4247",
  // Fluent uses foreground4 for input placeholders: keep them at 4.5:1.
  colorNeutralForeground4: "#5b6469",
  colorNeutralForegroundDisabled: "#868e89",
  colorNeutralForegroundOnBrand: "#ffffff",

  // 3:1 control boundary (WCAG 1.4.11). The decorative hairline is stroke2.
  colorNeutralStroke1: "#767f7a",
  colorNeutralStroke1Hover: "#5b6469",
  colorNeutralStroke1Pressed: "#3a4247",
  colorNeutralStroke1Selected: "#0b6577",
  colorNeutralStroke2: "#d3d7cf",
  colorNeutralStroke3: "#e7e9e4",
  colorNeutralStroke4: "#767f7a",
  colorNeutralStrokeAccessible: "#5b6469",
  colorNeutralStrokeAccessibleHover: "#3a4247",
  colorNeutralStrokeAccessiblePressed: "#12161a",
  colorNeutralStrokeAccessibleSelected: "#0b6577",
  colorNeutralStrokeDisabled: "#d3d7cf",
  colorNeutralStrokeOnBrand: "#ffffff",
  colorStrokeFocus1: "#fbfbf8",
  colorStrokeFocus2: "#0b6577",

  colorBrandBackground: "#0b6577",
  colorBrandBackgroundHover: "#0a5867",
  colorBrandBackgroundPressed: "#094c59",
  colorBrandBackgroundSelected: "#0a5867",
  colorBrandBackgroundStatic: "#0b6577",
  colorBrandBackground2: "#dce8e6",
  colorBrandBackground2Hover: "#d2e2df",
  colorBrandBackground2Pressed: "#c8dbd7",
  colorBrandBackgroundInverted: "#fbfbf8",
  colorBrandForeground1: "#0b6577",
  colorBrandForeground2: "#0b6577",
  colorBrandForeground2Hover: "#0a5867",
  colorBrandForeground2Pressed: "#094c59",
  colorBrandForegroundLink: "#0b6577",
  colorBrandForegroundLinkHover: "#0a5867",
  colorBrandForegroundLinkPressed: "#094c59",
  colorBrandForegroundLinkSelected: "#0b6577",
  colorBrandForegroundOnLight: "#0b6577",
  colorBrandForegroundOnLightHover: "#0a5867",
  colorBrandForegroundOnLightPressed: "#094c59",
  colorBrandForegroundOnLightSelected: "#0a5867",
  colorBrandForegroundInverted: "#fbfbf8",
  colorBrandForegroundInvertedHover: "#f2f3ef",
  colorBrandForegroundInvertedPressed: "#e7e9e4",
  colorBrandStroke1: "#0b6577",
  colorBrandStroke2: "#b9cfcb",
  colorBrandStroke2Contrast: "#7f9f9a",
  colorBrandStroke2Hover: "#9bb8b3",
  colorBrandStroke2Pressed: "#7f9f9a",
  colorBrandBackground3Static: "#0a5867",
  colorBrandBackground4Static: "#094c59",
  colorBrandBackgroundInvertedHover: "#f2f3ef",
  colorBrandBackgroundInvertedPressed: "#e7e9e4",
  colorBrandBackgroundInvertedSelected: "#eceee8",

  colorCompoundBrandBackground: "#0b6577",
  colorCompoundBrandBackgroundHover: "#0a5867",
  colorCompoundBrandBackgroundPressed: "#094c59",
  colorCompoundBrandForeground1: "#0b6577",
  colorCompoundBrandForeground1Hover: "#0a5867",
  colorCompoundBrandForeground1Pressed: "#094c59",
  colorCompoundBrandStroke: "#0b6577",
  colorCompoundBrandStrokeHover: "#0a5867",
  colorCompoundBrandStrokePressed: "#094c59",

  colorStatusDangerBackground1: "#f9ecea",
  colorStatusDangerBackground2: "#f2d9d5",
  colorStatusDangerBackground3: "#a3231a",
  colorStatusDangerBackground3Hover: "#8f1e16",
  colorStatusDangerBackground3Pressed: "#7c1a13",
  colorStatusDangerForeground1: "#a3231a",
  colorStatusDangerForeground2: "#8f1e16",
  colorStatusDangerForeground3: "#7c1a13",
  colorStatusDangerForegroundInverted: "#ffffff",
  colorStatusDangerBorder1: "#e3c0ba",
  colorStatusDangerBorder2: "#d3a49c",
  colorStatusDangerBorderActive: "#a3231a",

  colorStatusSuccessBackground1: "#ecf4ee",
  colorStatusSuccessBackground2: "#d8e9dd",
  colorStatusSuccessBackground3: "#1f6b3a",
  colorStatusSuccessForeground1: "#1f6b3a",
  colorStatusSuccessForeground2: "#1a5a31",
  colorStatusSuccessForeground3: "#154a28",
  colorStatusSuccessForegroundInverted: "#ffffff",
  colorStatusSuccessBorder1: "#c3d9c9",
  colorStatusSuccessBorder2: "#9fc0a9",
  colorStatusSuccessBorderActive: "#1f6b3a",

  colorStatusWarningBackground1: "#fbf3e0",
  colorStatusWarningBackground2: "#f5e5c2",
  colorStatusWarningBackground3: "#7a4f00",
  colorStatusWarningForeground1: "#7a4f00",
  colorStatusWarningForeground2: "#674200",
  colorStatusWarningForeground3: "#553600",
  colorStatusWarningForegroundInverted: "#ffffff",
  colorStatusWarningBorder1: "#e3cfa5",
  colorStatusWarningBorder2: "#cdb37e",
  colorStatusWarningBorderActive: "#7a4f00",
};

/** Neutral ink in dark mode; the accent is a light line colour, not a fill. */
export const swissDarkTheme: Theme = {
  ...createDarkTheme(brand),
  ...medeoType,
  ...swissRadii,
  ...flatShadows("#2b3132"),

  colorBackgroundOverlay: "rgba(5, 8, 9, 0.72)",

  colorNeutralBackground1: "#181c1d",
  colorNeutralBackground1Hover: "#1e2324",
  colorNeutralBackground1Pressed: "#242a2b",
  colorNeutralBackground1Selected: "#203032",
  colorNeutralBackground2: "#111415",
  colorNeutralBackground2Hover: "#171b1c",
  colorNeutralBackground2Pressed: "#1c2122",
  colorNeutralBackground2Selected: "#1d2b2d",
  colorNeutralBackground3: "#212627",
  colorNeutralBackground3Hover: "#272d2e",
  colorNeutralBackground3Pressed: "#2d3435",
  colorNeutralBackground3Selected: "#223032",
  colorNeutralBackground4: "#252b2c",
  colorNeutralBackground5: "#2a3031",
  colorNeutralBackground6: "#2f3536",
  colorNeutralBackgroundDisabled: "#212627",
  colorNeutralBackgroundDisabled2: "#181c1d",
  colorNeutralCardBackground: "#181c1d",
  colorNeutralCardBackgroundHover: "#1e2324",

  colorNeutralForeground1: "#e9ebe8",
  colorNeutralForeground1Hover: "#ffffff",
  colorNeutralForeground1Pressed: "#ffffff",
  colorNeutralForeground1Selected: "#e9ebe8",
  colorNeutralForeground2: "#b4bab7",
  colorNeutralForeground2Hover: "#e9ebe8",
  colorNeutralForeground2Pressed: "#ffffff",
  colorNeutralForeground2Selected: "#e9ebe8",
  colorNeutralForeground3: "#8f9795",
  colorNeutralForeground3Hover: "#b4bab7",
  colorNeutralForeground3Pressed: "#e9ebe8",
  colorNeutralForeground3Selected: "#b4bab7",
  colorNeutralForeground4: "#8f9795",
  colorNeutralForegroundDisabled: "#727a77",
  colorNeutralForegroundOnBrand: "#ffffff",

  colorNeutralStroke1: "#68716e",
  colorNeutralStroke1Hover: "#8f9795",
  colorNeutralStroke1Pressed: "#b4bab7",
  colorNeutralStroke1Selected: "#5fd6ec",
  colorNeutralStroke2: "#2b3132",
  colorNeutralStroke3: "#232829",
  colorNeutralStroke4: "#68716e",
  colorNeutralStrokeAccessible: "#8f9795",
  colorNeutralStrokeAccessibleHover: "#b4bab7",
  colorNeutralStrokeAccessiblePressed: "#e9ebe8",
  colorNeutralStrokeAccessibleSelected: "#5fd6ec",
  colorNeutralStrokeDisabled: "#3a4142",
  colorNeutralStrokeOnBrand: "#ffffff",
  colorStrokeFocus1: "#111415",
  colorStrokeFocus2: "#8ce6f7",

  colorBrandBackground: "#127a90",
  colorBrandBackgroundHover: "#0e6b7e",
  colorBrandBackgroundPressed: "#0b5f70",
  colorBrandBackgroundSelected: "#127a90",
  colorBrandBackgroundStatic: "#127a90",
  colorBrandBackground2: "#1d2b2d",
  colorBrandBackground2Hover: "#223436",
  colorBrandBackground2Pressed: "#274043",
  colorBrandBackgroundInverted: "#111415",
  colorBrandForeground1: "#5fd6ec",
  colorBrandForeground2: "#5fd6ec",
  colorBrandForeground2Hover: "#8ce6f7",
  colorBrandForeground2Pressed: "#b7f1fb",
  colorBrandForegroundLink: "#5fd6ec",
  colorBrandForegroundLinkHover: "#8ce6f7",
  colorBrandForegroundLinkPressed: "#b7f1fb",
  colorBrandForegroundLinkSelected: "#5fd6ec",
  colorBrandForegroundOnLight: "#0b6577",
  colorBrandForegroundOnLightHover: "#0a5867",
  colorBrandForegroundOnLightPressed: "#094c59",
  colorBrandForegroundOnLightSelected: "#0a5867",
  colorBrandForegroundInverted: "#111415",
  colorBrandForegroundInvertedHover: "#1c2122",
  colorBrandForegroundInvertedPressed: "#242a2b",
  colorBrandStroke1: "#5fd6ec",
  colorBrandStroke2: "#2e5c63",
  colorBrandStroke2Contrast: "#4a7f86",
  colorBrandStroke2Hover: "#3b737b",
  colorBrandStroke2Pressed: "#2e5c63",
  colorBrandBackground3Static: "#0e6b7e",
  colorBrandBackground4Static: "#0b5f70",
  colorBrandBackgroundInvertedHover: "#1e2324",
  colorBrandBackgroundInvertedPressed: "#242a2b",
  colorBrandBackgroundInvertedSelected: "#203032",

  colorCompoundBrandBackground: "#127a90",
  colorCompoundBrandBackgroundHover: "#0e6b7e",
  colorCompoundBrandBackgroundPressed: "#0b5f70",
  colorCompoundBrandForeground1: "#5fd6ec",
  colorCompoundBrandForeground1Hover: "#8ce6f7",
  colorCompoundBrandForeground1Pressed: "#b7f1fb",
  colorCompoundBrandStroke: "#5fd6ec",
  colorCompoundBrandStrokeHover: "#8ce6f7",
  colorCompoundBrandStrokePressed: "#b7f1fb",

  colorStatusDangerBackground1: "#2a1a18",
  colorStatusDangerBackground2: "#3a2320",
  colorStatusDangerBackground3: "#b3352b",
  colorStatusDangerBackground3Hover: "#c0392f",
  colorStatusDangerBackground3Pressed: "#8f2a22",
  colorStatusDangerForeground1: "#ff8f85",
  colorStatusDangerForeground2: "#ff8f85",
  colorStatusDangerForeground3: "#ffb3ac",
  colorStatusDangerForegroundInverted: "#111415",
  colorStatusDangerBorder1: "#5a2d29",
  colorStatusDangerBorder2: "#7a3a34",
  colorStatusDangerBorderActive: "#ff8f85",

  colorStatusSuccessBackground1: "#16241b",
  colorStatusSuccessBackground2: "#1e3326",
  colorStatusSuccessBackground3: "#2f7a4c",
  colorStatusSuccessForeground1: "#7fd3a0",
  colorStatusSuccessForeground2: "#7fd3a0",
  colorStatusSuccessForeground3: "#a3e3bd",
  colorStatusSuccessForegroundInverted: "#111415",
  colorStatusSuccessBorder1: "#2f4a38",
  colorStatusSuccessBorder2: "#3f5f4a",
  colorStatusSuccessBorderActive: "#7fd3a0",

  colorStatusWarningBackground1: "#2b2314",
  colorStatusWarningBackground2: "#3a2f1a",
  colorStatusWarningBackground3: "#91631a",
  colorStatusWarningForeground1: "#e8c46a",
  colorStatusWarningForeground2: "#e8c46a",
  colorStatusWarningForeground3: "#f0d79a",
  colorStatusWarningForegroundInverted: "#111415",
  colorStatusWarningBorder1: "#4a3d22",
  colorStatusWarningBorder2: "#67542f",
  colorStatusWarningBorderActive: "#e8c46a",
};
