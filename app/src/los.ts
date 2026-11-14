// Radio line of sight over the terrain, including the curve of Mars.

import { type HeightGrid, type LonLat, bilinear, metresBetween } from "./grid";

export const MARS_RADIUS_M = 3_396_190;

export interface Antenna extends LonLat {
  h: number; // antenna height above the areoid (ground + mast)
}

/** True when nothing on the ground blocks the straight line between two antennas. */
export function hasLineOfSight(g: HeightGrid, a: Antenna, b: Antenna, radius = MARS_RADIUS_M): boolean {
  const D = metresBetween(g.meta, a, b);
  if (D < 1) return true;
  const step = Math.min(g.meta.dxM, g.meta.dyM);
  const n = Math.ceil(D / step);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const ground = bilinear(g.meta, g.h, a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t);
    const d1 = t * D;
    const bulge = (d1 * (D - d1)) / (2 * radius); // the planet's curve raises the middle of the path
    const sight = a.h + (b.h - a.h) * t;
    if (ground + bulge > sight) return false;
  }
  return true;
}
