// Screen-fitting rules as plain functions, so they can be tested without a browser:
// how the side panel is scaled, when a window counts as narrow, how far the camera must be
// for a view to fit a narrow map, and how a stop name typed by the crew is cleaned.

/** Design size of the side panel in px. The width is --panel-w in style.css. */
export const PANEL_W = 392;
export const PANEL_H = 740;
/** Design width of a pop-up card in px (.pop-card in style.css). */
export const POPUP_W = 440;
/** The panel is never drawn smaller than this (text would be unreadable). */
export const MIN_SCALE = 0.55;
/** Below this window height the panel cannot be shown whole, even at the smallest scale. */
export const MIN_HEIGHT = 420;

export interface UiLayout {
  /** The panel and pop-ups are drawn at this scale, so that nothing ever needs to scroll. */
  scale: number;
  /** Too little room beside the panel: the panel lies over the map instead of beside it. */
  narrow: boolean;
  /** No room for a pop-up beside the panel: pop-ups use the whole window. */
  popupFull: boolean;
  /** The window is too short to show the whole panel: the app says so instead of hiding content silently. */
  tooSmall: boolean;
}

/** The layout for a window of this size. */
export function uiLayout(width: number, height: number, panelW = PANEL_W): UiLayout {
  const scale = Math.max(MIN_SCALE, Math.min(1, height / PANEL_H));
  const strip = width - panelW * scale; // what is left for the map beside the panel
  return { scale, narrow: strip < 200, popupFull: strip < POPUP_W * scale + 40, tooSmall: height < MIN_HEIGHT };
}

/** The camera's angle (radians) from side to side of a w x h map. `fov` is the angle across the larger side, as in CesiumJS. */
export function fovAcross(w: number, h: number, fov: number): number {
  return w >= h ? fov : 2 * Math.atan(Math.tan(fov / 2) * (w / h));
}

/** The camera's angle (radians) from top to bottom of a w x h map. */
export function fovUpDown(w: number, h: number, fov: number): number {
  return w >= h ? 2 * Math.atan(Math.tan(fov / 2) * (h / w)) : fov;
}

/**
 * The camera views are framed for a normal wide map. The camera sees a smaller angle from side
 * to side on a narrow map, and a smaller angle from top to bottom on a very wide, low map.
 * In both cases it must move back by this factor (1 = no change) so the same ground still fits.
 */
export function widenFactor(w: number, h: number, fov: number, sideHalfDeg = 22, upDownHalfDeg = 17): number {
  const rad = Math.PI / 180;
  return Math.max(
    1,
    Math.tan(sideHalfDeg * rad) / Math.tan(fovAcross(w, h, fov) / 2),
    Math.tan(upDownHalfDeg * rad) / Math.tan(fovUpDown(w, h, fov) / 2),
  );
}

/** Camera height (m) above a sphere of this radius from which the whole disc takes about `fill` of the map's smaller side. */
export function planetFitAltitude(w: number, h: number, fov: number, radius: number, fill = 0.7): number {
  const small = 2 * Math.atan(Math.tan(fov / 2) * (Math.min(w, h) / Math.max(w, h)));
  return radius / Math.sin((small / 2) * fill) - radius;
}

/** How large the planet's disc is on screen: its radius in px, seen from `altitude` m above the sphere. */
export function discRadiusPx(w: number, h: number, fov: number, radius: number, altitude: number): number {
  const focal = Math.max(w, h) / 2 / Math.tan(fov / 2);
  return focal * Math.tan(Math.asin(radius / (radius + altitude)));
}

/**
 * CesiumJS draws map label text one letter at a time, from left to right. That is fine for
 * Latin, Greek and Cyrillic, but it breaks scripts whose letters join or run from right to left
 * (Kurdish, Arabic, Persian, Hebrew, Hindi ...). Such a name must be drawn by the browser.
 */
const PLAIN_SCRIPT = /^[\u0000-\u052F\u1E00-\u1FFF\u2000-\u206F\u20A0-\u20CF\u2190-\u21FF]*$/;
export const needsShaping = (text: string): boolean => !PLAIN_SCRIPT.test(text);

/** The longest stop name the crew can give. */
export const STOP_NAME_MAX = 40;

/** A stop name as the crew typed it: single spaces, no spaces at the ends, at most 40 characters. An empty name gives the fallback. */
export function cleanStopName(raw: string, fallback: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, STOP_NAME_MAX).trim() || fallback;
}
