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

/** The crater all walk zones lie in, as the zone list gives it (Mars Trek's own name record, R1). */
export interface CraterInfo {
  name: string;
  lon: number;
  lat: number;
  diameter_km: number;
}

/** Highest camera of the whole-crater view (m): below the height at which the zones merge into one crater marker. */
export const CRATER_VIEW_MAX_M = 108_000;
/**
 * A map narrower than this (px) has the zone names over and under their markers, not beside them.
 * (A name beside its marker needs 150 px of map; on a tall map under 560 px that room would push
 * the crater's rim out of the view.) The scale card also sits under the map title below this width.
 */
export const NARROW_MAP_W = 560;
/**
 * On the whole-planet screen a map that is narrower than NARROW_MAP_W and also shorter than this (px)
 * shows no scale card: under the map title the card would lie over a walk zone or its name in the
 * whole-crater view. The rule itself is in style.css (a container query on #map-area).
 */
export const SHORT_MAP_H = 600;
/** Room (px) between a zone marker and the map's edge for a name beside it, or for a name stacked on it (some px to spare). */
const NAME_BESIDE_PX = 160;
const NAME_STACKED_PX = 70;
const MARS_KM_PER_DEG = (3396.19 * Math.PI) / 180;

export interface CraterViewOptions {
  /** Highest camera (m above the reference sphere). */
  maxHeightM?: number;
  /** The wide photo map's box [west, south, east, north] in degrees. The view stays inside it when it can. */
  photoBox?: number[] | null;
  /** Height of the ground (m; negative below the reference sphere): the camera sees more ground when the ground is lower. */
  groundM?: number;
}

/**
 * The whole-crater view: the point the camera looks straight down on, and the camera's height.
 * In this order:
 * 1. Every walk zone has room for its marker and its name (the name is beside the marker, or on
 *    it when the map is narrow). The zones are what the crew clicks, so they win.
 * 2. The whole rim is in view. The camera goes higher on a narrow or low map, up to the limit.
 * 3. The view stays inside the wide photo map (outside it the coarse planet map shows). For that
 *    the free room around the rim may shrink from 20% to 5% of the half-view.
 * The view looks at the crater's centre and moves toward the zones only as far as rule 1 needs.
 * Returns null when the zone list has no usable crater (an older list).
 */
export function craterView(
  crater: unknown, zones: { lon: number; lat: number }[], w: number, h: number, fov: number, options: CraterViewOptions = {},
): { lon: number; lat: number; heightM: number } | null {
  const c = crater as Partial<CraterInfo> | null | undefined;
  if (!c || typeof c.lon !== "number" || typeof c.lat !== "number" || typeof c.diameter_km !== "number") return null;
  if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat) || !(c.diameter_km > 0) || Math.abs(c.lat) > 89 || Math.abs(c.lon) > 180) return null;
  const { lon, lat } = c;
  const radius = c.diameter_km / 2;
  const width = Math.max(w, 1);
  const height = Math.max(h, 1);
  const large = Math.max(width, height);
  const tanW = Math.tan(fov / 2) * (width / large); // from the middle of the view to its left or right edge
  const tanH = Math.tan(fov / 2) * (height / large); // ... to its top or bottom edge
  const kmPerDegLon = MARS_KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const east = zones.map((z) => (z.lon - lon) * kmPerDegLon); // km east of the crater's centre
  const north = zones.map((z) => (z.lat - lat) * MARS_KM_PER_DEG);
  // How far from the middle a zone marker may be, as a share of the half-view: its name needs room at the edge.
  const shareX = Math.max(0, Math.min(0.7, 1 - (width < NARROW_MAP_W ? NAME_STACKED_PX : NAME_BESIDE_PX) / (width / 2)));
  const shareY = Math.max(0, Math.min(0.7, 1 - 70 / (height / 2)));

  /** The smallest half-view (km) along one axis that holds the rim, with `free` of it left free, and gives every zone its room. */
  const need = (zoneKm: number[], share: number, free: number): number => {
    let half = radius / (1 - free);
    for (const z of zoneKm) half = Math.max(half, (radius + Math.abs(z)) / (1 - free + share));
    if (zoneKm.length > 1 && share > 0) half = Math.max(half, (Math.max(...zoneKm) - Math.min(...zoneKm)) / (2 * share));
    return half;
  };
  // The camera stands `heightKm` above the sphere and `rise` more above the ground it sees.
  const rise = -(options.groundM ?? 0) / 1000;
  const heightFor = (free: number) => Math.max(need(east, shareX, free) / tanW, need(north, shareY, free) / tanH) - rise;
  const comfortKm = heightFor(0.2);
  let heightKm = comfortKm;
  const box = options.photoBox;
  if (box && box.length === 4 && box.every((v) => Number.isFinite(v))) {
    // from the crater's centre to the nearest edge of the photo map, east-west and north-south
    const boxW = Math.min(lon - box[0], box[2] - lon) * kmPerDegLon;
    const boxH = Math.min(lat - box[1], box[3] - lat) * MARS_KM_PER_DEG;
    if (boxW > 0 && boxH > 0) heightKm = Math.max(heightFor(0.05), Math.min(comfortKm, boxW / tanW - rise, boxH / tanH - rise));
  }
  heightKm = Math.max(1, Math.min((options.maxHeightM ?? CRATER_VIEW_MAX_M) / 1000, heightKm));

  /** Where the middle of the view lies along one axis (km from the crater's centre). */
  const middle = (zoneKm: number[], share: number, half: number): number => {
    const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));
    const rimLow = radius - 0.95 * half; // the whole rim is in view between these two
    const rimHigh = 0.95 * half - radius;
    if (!zoneKm.length) return 0;
    const zoneLow = Math.max(...zoneKm) - share * half; // every zone has its room between these two
    const zoneHigh = Math.min(...zoneKm) + share * half;
    if (zoneLow > zoneHigh) return (Math.max(...zoneKm) + Math.min(...zoneKm)) / 2; // the zones are too far apart: their middle
    if (rimLow > rimHigh) return clamp(0, zoneLow, zoneHigh); // the crater does not fit: stay as near to its centre as the zones allow
    if (Math.max(zoneLow, rimLow) <= Math.min(zoneHigh, rimHigh)) return clamp(0, Math.max(zoneLow, rimLow), Math.min(zoneHigh, rimHigh));
    return rimLow > zoneHigh ? zoneHigh : zoneLow; // not both: the zones win, as near to the rim's range as they allow
  };
  const dx = middle(east, shareX, (heightKm + rise) * tanW);
  const dy = middle(north, shareY, (heightKm + rise) * tanH);
  return { lon: lon + dx / kmPerDegLon, lat: lat + dy / MARS_KM_PER_DEG, heightM: heightKm * 1000 };
}

/** Below this camera height the grey photo maps (CTX, HiRISE) are fully shown; above PHOTO_GONE_KM not at all. */
export const PHOTO_FULL_KM = 150;
export const PHOTO_GONE_KM = 400;

/**
 * How strongly the photo maps are drawn (0 to 1) for a camera height. From far away they are only
 * a small grey square on the coloured planet, so they fade in while the camera comes down to the
 * crater, and they are complete at every crater and zone view.
 */
export function photoAlpha(heightKm: number): number {
  if (!Number.isFinite(heightKm)) return 1;
  if (heightKm <= PHOTO_FULL_KM) return 1;
  if (heightKm >= PHOTO_GONE_KM) return 0;
  return (PHOTO_GONE_KM - heightKm) / (PHOTO_GONE_KM - PHOTO_FULL_KM);
}

/**
 * The same for one photo map of the stack (0 = the lowest and widest). Only the lowest one fades
 * in. The sharper maps on top of it join when it is complete: half-drawn maps lying on each
 * other would add up to squares of different strength.
 */
export function photoLayerAlpha(heightKm: number, index: number): number {
  const alpha = photoAlpha(heightKm);
  return index === 0 ? alpha : alpha >= 1 ? 1 : 0;
}

/** The official place names show while the camera is this high above the ground (metres). */
export const NAMES_LOW_M = 8_000;
export const NAMES_HIGH_M = 115_000;

/** ... and while the camera is nearer than this to the crater's marker (m): from here on the crater has one marker for all zones. */
export const NAMES_FAR_M = 120_000;

/**
 * Are the official place names shown? Only at crater scale. Lower down (a walk zone, the
 * walk-through, the helmet view) a name some 20 km away would float at the horizon; higher up,
 * or farther away (a tilted camera can be low and far), the crater has its own marker, which
 * already carries the name.
 */
export function namesVisible(heightAboveGroundM: number, distanceToCraterM = 0): boolean {
  return heightAboveGroundM >= NAMES_LOW_M && heightAboveGroundM <= NAMES_HIGH_M && distanceToCraterM < NAMES_FAR_M;
}
