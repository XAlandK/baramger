// Where each astronaut of the crew stands on the map: the figures of the walk, the walk-through
// and the replay, and the place the camera follows ("Follow A2"). Plain functions, no map engine.

import type { LonLat } from "./grid";

export interface PathPoint extends LonLat {
  h: number; // ground height (m above the Mars datum)
}

export interface CrewSpot extends PathPoint {
  name: string; // A1, A2 ... as in the Safety tab
  headingDeg: number; // where the astronaut faces: 0 = north, 90 = east
}

/** Single file on the walk: each astronaut walks this far behind the one in front (buddy rule: close together). */
export const CREW_GAP_M = 3;
/** At a stop the crew stands this far around the stop's middle, facing it. */
export const CREW_RING_M = 2;
/** When the path walked so far is too short (just out of the habitat), the ones still waiting stand this far apart, side by side. */
export const CREW_SIDE_M = 1.2;
export const CREW_MAX = 4;

const M_PER_DEG = (3_396_190 * Math.PI) / 180; // Mars 2000 sphere

export const crewNames = (n: number): string[] => Array.from({ length: Math.max(0, Math.min(CREW_MAX, n)) }, (_, i) => `A${i + 1}`);

/** Metres between two places (flat-ground approximation, fine over a few kilometres). */
export function metresApart(a: LonLat, b: LonLat): number {
  const kx = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * kx, b.lat - a.lat) * M_PER_DEG;
}

/** Compass direction from a to b, in degrees (0 = north, 90 = east). */
export function bearingTo(a: LonLat, b: LonLat): number {
  const kx = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const deg = (Math.atan2((b.lon - a.lon) * kx, b.lat - a.lat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** The place `metres` away from `p` in direction `deg` (flat-ground approximation). */
export function offset(p: LonLat, deg: number, metres: number): LonLat {
  const r = (deg * Math.PI) / 180;
  const kx = Math.cos((p.lat * Math.PI) / 180);
  return { lon: p.lon + (Math.sin(r) * metres) / (M_PER_DEG * kx), lat: p.lat + (Math.cos(r) * metres) / M_PER_DEG };
}

export interface CrewOptions {
  /** The crew is at this stop: they stand around it, facing it. */
  stopAt?: LonLat | null;
  /** Ground height under a place (the map's height grids); without it, heights come from the path. */
  heightAt?: (lon: number, lat: number) => number;
  /** Where the crew faces when the path gives no direction (standing still at the start). */
  headingDeg?: number;
}

/**
 * Where each of the `n` astronauts is. `trail` is the path walked so far, oldest first, with the
 * crew's present place last. Walking: A1 leads at the present place and the others follow in
 * single file, CREW_GAP_M apart along the path, each facing the way the path goes. Where the path
 * is still too short, the ones left stand side by side at its start. At a stop: everyone stands
 * CREW_RING_M around the stop, facing it, A1 on the side the crew came from.
 */
export function crewSpots(trail: PathPoint[], n: number, options: CrewOptions = {}): CrewSpot[] {
  const names = crewNames(n);
  if (!trail.length || !names.length) return [];
  const here = trail[trail.length - 1];
  const ground = (p: LonLat, fallback: number) => {
    const h = options.heightAt?.(p.lon, p.lat);
    return h !== undefined && Number.isFinite(h) ? h : fallback;
  };
  // the walking direction: the last stretch of the path that is long enough to have one
  let heading = options.headingDeg ?? 0;
  for (let i = trail.length - 2; i >= 0; i--) {
    if (metresApart(trail[i], here) > 0.5) {
      heading = bearingTo(trail[i], here);
      break;
    }
  }
  if (options.stopAt) {
    const stop = options.stopAt;
    return names.map((name, k) => {
      if (names.length === 1) return { ...stop, h: ground(stop, here.h), name, headingDeg: heading };
      const p = offset(stop, heading + 180 + (k * 360) / names.length, CREW_RING_M);
      return { ...p, h: ground(p, here.h), name, headingDeg: bearingTo(p, stop) };
    });
  }
  const out: CrewSpot[] = [{ lon: here.lon, lat: here.lat, h: ground(here, here.h), name: names[0], headingDeg: heading }];
  // walk back along the path; `seg` is the segment trail[seg] -> trail[seg + 1]
  let seg = trail.length - 2;
  let along = 0; // metres from the present place back to trail[seg + 1]
  for (let k = 1; k < names.length; k++) {
    const want = k * CREW_GAP_M;
    let spot: CrewSpot | null = null;
    while (seg >= 0) {
      const a = trail[seg];
      const b = trail[seg + 1];
      const len = metresApart(a, b);
      if (along + len >= want && len > 0) {
        const f = (want - along) / len; // from b back towards a
        const p = { lon: b.lon + (a.lon - b.lon) * f, lat: b.lat + (a.lat - b.lat) * f };
        spot = { ...p, h: ground(p, b.h + (a.h - b.h) * f), name: names[k], headingDeg: bearingTo(a, b) };
        break;
      }
      along += len;
      seg--;
    }
    if (!spot) {
      // the path is too short: wait side by side at its start, facing the same way as the crew
      const start = trail[0];
      const p = offset(start, heading - 90, CREW_SIDE_M * k);
      spot = { ...p, h: ground(p, start.h), name: names[k], headingDeg: heading };
    }
    out.push(spot);
  }
  return out;
}

// ------------------------------------------------------------------ the camera that follows one astronaut
/**
 * Where the follow camera stands, seen from the astronaut it follows. `aroundDeg`: the camera's
 * view direction compared with the astronaut's (0 = straight behind them, looking the way they
 * face; positive = the camera has turned to the right). `pitchDeg`: the camera's tilt (negative
 * looks down). `rangeM`: metres from the point it looks at.
 */
export interface ChaseOffset {
  aroundDeg: number;
  pitchDeg: number;
  rangeM: number;
}

/** About 20 m behind and above the astronaut: near enough to see the figure and its name tag. */
export const CHASE_DEFAULT: ChaseOffset = { aroundDeg: 0, pitchDeg: -22, rangeM: 20 };
export const CHASE_RANGE_M: [number, number] = [3, 2000];
export const CHASE_PITCH_DEG: [number, number] = [-89, -2];
/** The camera looks at this height above the astronaut's feet (the suit is about 1.9 m tall). */
export const CHASE_AIM_M = 1;
/** The camera never goes lower than this above the ground (the map's lowest camera height). */
export const CHASE_MIN_ABOVE_GROUND_M = 1.5;

/** A camera place and direction (degrees; heading 0 = north, pitch negative = looking down). */
export interface CameraPose extends PathPoint {
  headingDeg: number;
  pitchDeg: number;
}

const clampTo = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** The offset inside its limits, with the angle around written between -180 and 180. */
export function clampChase(o: ChaseOffset): ChaseOffset {
  const around = ((((o.aroundDeg + 180) % 360) + 360) % 360) - 180;
  return {
    aroundDeg: Number.isFinite(around) ? around : 0,
    pitchDeg: Number.isFinite(o.pitchDeg) ? clampTo(o.pitchDeg, CHASE_PITCH_DEG) : CHASE_DEFAULT.pitchDeg,
    rangeM: Number.isFinite(o.rangeM) ? clampTo(o.rangeM, CHASE_RANGE_M) : CHASE_DEFAULT.rangeM,
  };
}

/**
 * The follow camera for an astronaut standing at `p` (h = the ground at their feet) and facing
 * `headingDeg`: it looks at a point CHASE_AIM_M above their feet from the offset's direction and
 * distance. Where the ground there is higher than the camera would be (a slope behind them), the
 * camera goes up to CHASE_MIN_ABOVE_GROUND_M above it and still looks at the astronaut.
 */
export function chasePose(p: PathPoint, headingDeg: number, off: ChaseOffset, groundAt?: (lon: number, lat: number) => number): CameraPose {
  const o = clampChase(off);
  const aimH = p.h + CHASE_AIM_M;
  const view = (((headingDeg + o.aroundDeg) % 360) + 360) % 360;
  const flat = o.rangeM * Math.cos(toRad(o.pitchDeg));
  const at = offset(p, view + 180, flat);
  let h = aimH - o.rangeM * Math.sin(toRad(o.pitchDeg));
  let pitch = o.pitchDeg;
  const g = groundAt?.(at.lon, at.lat);
  if (g !== undefined && Number.isFinite(g) && h < g + CHASE_MIN_ABOVE_GROUND_M) {
    h = g + CHASE_MIN_ABOVE_GROUND_M;
    pitch = -toDeg(Math.atan2(h - aimH, flat));
  }
  return { ...at, h, headingDeg: view, pitchDeg: pitch };
}

/**
 * The offset that matches a camera at `cam` for an astronaut at `p` facing `headingDeg` (the
 * inverse of chasePose, without the ground rule). Used when the mouse moved the follow camera:
 * the follow then keeps that place around the astronaut.
 */
export function chaseOffsetFrom(cam: PathPoint, p: PathPoint, headingDeg: number): ChaseOffset {
  const aimH = p.h + CHASE_AIM_M;
  const flat = metresApart(p, cam);
  const up = cam.h - aimH;
  const view = flat > 0.01 ? bearingTo(cam, p) : headingDeg;
  return clampChase({ aroundDeg: view - headingDeg, pitchDeg: -toDeg(Math.atan2(up, Math.max(flat, 1e-6))), rangeM: Math.hypot(flat, up) });
}
