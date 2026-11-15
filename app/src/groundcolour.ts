// The helmet view's "approximate colour": the colour of the ground, measured in Perseverance's
// own colour photos of the walk zone (R5, the photos in the mission package). The photos are raw
// (not colour-calibrated), so the result is approximate; the app never calls it "true colour".
// Plain functions on pixel data; main.ts loads the photos and draws them on a canvas.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The ground is the lower part of a rover photo: rows from this share of the height down. */
export const GROUND_FROM = 0.55;
/** Pixels darker or brighter than these (0–1) are left out: deep shadows, glare, sky. */
export const PIXEL_DARK = 0.06;
export const PIXEL_BRIGHT = 0.94;
/** A photo whose mean colour has less saturation than this is a black-and-white photo. */
export const COLOUR_MIN_SAT = 0.05;

/** HSL saturation of a colour (0–1). */
export function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  if (max === min) return 0;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

/**
 * Mean colour of the ground in one photo, from RGBA pixel data (`width` × `height`), rows from
 * `fromRow` (a share of the height) to the bottom, without too dark or too bright pixels. Null
 * when no pixel is left.
 */
export function groundMean(data: ArrayLike<number>, width: number, height: number, fromRow = GROUND_FROM): Rgb | null {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(height * fromRow); y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      if (lum < PIXEL_DARK || lum > PIXEL_BRIGHT) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : null;
}

/** Mastcam-Z colour photos (filter 0: red, green and blue) have names starting ZL0_ or ZR0_. */
export const isMastcamColour = (imageId: string): boolean => /^Z[LR]0_/.test(imageId);
export const isNavcam = (instrument: string): boolean => instrument.startsWith("NAVCAM");

export interface PhotoSample {
  imageId: string;
  instrument: string;
  /** groundMean() of the photo, or null if it could not be read. */
  mean: Rgb | null;
}

export interface GroundColour {
  rgb: Rgb;
  hex: string;
  /** "Mastcam-Z" when a Mastcam-Z colour photo was there, else "Navcam". */
  camera: "Mastcam-Z" | "Navcam";
  /** The photos it was measured in. */
  from: string[];
}

export const toHex = ({ r, g, b }: Rgb): string => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/**
 * The zone's ground colour: the mean of its Mastcam-Z colour photos when it has any (Mastcam-Z's
 * colours are the most natural of the rover's cameras), else the mean of its colour Navcam
 * photos. Black-and-white photos (and the other cameras: close-ups, SuperCam) are left out.
 * Null when the zone has no colour photo of the ground.
 */
export function pickGroundColour(samples: PhotoSample[]): GroundColour | null {
  const colour = samples.filter((s) => s.mean && saturation(s.mean) >= COLOUR_MIN_SAT);
  const mastcam = colour.filter((s) => isMastcamColour(s.imageId));
  const navcam = colour.filter((s) => isNavcam(s.instrument));
  const use = mastcam.length ? mastcam : navcam;
  if (!use.length) return null;
  const rgb = {
    r: use.reduce((a, s) => a + s.mean!.r, 0) / use.length,
    g: use.reduce((a, s) => a + s.mean!.g, 0) / use.length,
    b: use.reduce((a, s) => a + s.mean!.b, 0) / use.length,
  };
  return { rgb, hex: toHex(rgb), camera: mastcam.length ? "Mastcam-Z" : "Navcam", from: use.map((s) => s.imageId) };
}

/**
 * The sky of the helmet view's colour mode: a dusty butterscotch, lighter at the horizon. It is
 * a drawing, not a measurement (the package's rover photos look down at the ground), and the
 * screen says so.
 */
export const SKY_TOP = "#a97f58";
export const SKY_HORIZON = "#d2b089";
