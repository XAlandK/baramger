// The whole-planet map has two looks, and the crew can switch between them:
//   "heights" = NASA MOLA height colours (blue is low ground, not water)
//   "colour"  = natural colour: the Viking orbiters' colour mosaic, the app's first look since
//               2026-11-15 (the user's choice). Its producer (USGS) calls it a colourised mosaic,
//               so the app says "natural colour, approximate" and never "true colour".
// Both come from JPL Mars Trek (R1) and are cached in the mission package. The sharp photo maps
// (CTX, HiRISE) are drawn on top of either look.

export type BaseStyle = "heights" | "colour";

export const BASE_STYLES: BaseStyle[] = ["heights", "colour"];

/** The look the app starts with until the crew picks one: Mars in (approximately) its own colours. */
export const DEFAULT_BASE: BaseStyle = "colour";

/** Which look a mission-package layer belongs to (null = not a whole-planet base map). */
export function baseStyleOf(layerId: string): BaseStyle | null {
  if (layerId === "tiles-mola" || layerId.startsWith("tiles-mola-")) return "heights";
  if (layerId === "tiles-viking" || layerId.startsWith("tiles-viking-")) return "colour";
  return null;
}

/**
 * The look to start with: the crew's saved choice if this package has that look, else the
 * default, else whatever the package has (an older package has height colours only).
 */
export function startBaseStyle(saved: string | null, available: BaseStyle[]): BaseStyle {
  if (saved && (available as string[]).includes(saved)) return saved as BaseStyle;
  if (available.includes(DEFAULT_BASE)) return DEFAULT_BASE;
  return available[0] ?? DEFAULT_BASE;
}

/** Button label and one-line explanation of each look, in simple English. */
export const BASE_TEXT: Record<BaseStyle, { label: string; note: string }> = {
  heights: { label: "Height colours", note: "Colours show height (NASA MOLA): blue is low ground, not water." },
  colour: {
    label: "Natural colour",
    note: "Close to Mars's own colours, but approximate: a colourised mosaic of NASA Viking orbiter photos (about 330 m detail near Jezero).",
  },
};
