// Walk simulation for the tablet view. On Mars the position would come from the suit's navigation;
// here the walkers move along the approved route at a chosen time-lapse speed.

import type { LonLat } from "./grid";
import { type Leg, type PlanInput, type PlanStop, type Sample, routeLegs } from "./plan";

export interface WalkStop extends PlanStop {
  tasks: string[];
  povIds: string[];
  note?: string;
}

export type Phase = "walking" | "at_stop" | "done";

export interface FieldNote extends LonLat {
  clockMin: number;
  text: string;
  kind: "note" | "idea";
}

export interface VisitLog {
  id: string;
  name: string;
  arrivedMin: number;
  leftMin?: number;
  tasksDone: string[];
}

export type LogKind = "start" | "arrived" | "left" | "skipped" | "home-now" | "note" | "idea" | "home";

/** Something that happened on the walk, for the replay and the report. */
export interface WalkLogEntry extends LonLat {
  clockMin: number;
  kind: LogKind;
  text: string;
}

export interface TrackPoint extends LonLat {
  h: number;
  clockMin: number;
}

export interface WalkState {
  phase: Phase;
  startMin: number;
  clockMin: number;
  legs: Leg[]; // walking: legs[0] is the current leg; at a stop: legs[0] is the leg that leaves it
  legT: number; // minutes into legs[0] while walking
  queue: WalkStop[]; // walking: next destination first; at a stop: the current stop first
  stopElapsed: number;
  extraStopMin: number;
  log: VisitLog[];
  skipped: string[];
  track: TrackPoint[];
  walkedM: number;
  plannedM: number;
  notes: FieldNote[];
  pos: Sample;
  events: WalkLogEntry[];
}

export function logEvent(s: WalkState, kind: LogKind, text: string): void {
  s.events.push({ clockMin: s.clockMin, kind, text, lon: s.pos.lon, lat: s.pos.lat });
}

export type WalkEvent = { type: "arrived"; stop: WalkStop } | { type: "left"; stop: WalkStop } | { type: "home" };

/** Position on a leg at `t` minutes after it starts (linear between samples). */
export function sampleAt(leg: Leg, t: number): Sample {
  const s = leg.samples;
  if (t <= 0 || s.length === 1) return s[0];
  if (t >= s[s.length - 1].t) return s[s.length - 1];
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return {
    lon: a.lon + (b.lon - a.lon) * f,
    lat: a.lat + (b.lat - a.lat) * f,
    h: a.h + (b.h - a.h) * f,
    d: a.d + (b.d - a.d) * f,
    t,
    slope: f < 0.5 ? a.slope : b.slope,
    radio: f < 0.5 ? a.radio : b.radio,
  };
}

export function startWalk(legs: Leg[], stops: WalkStop[], startMin: number): WalkState {
  const first = legs[0].samples[0];
  const s: WalkState = {
    phase: "walking",
    startMin,
    clockMin: startMin,
    legs: [...legs],
    legT: 0,
    queue: [...stops],
    stopElapsed: 0,
    extraStopMin: 0,
    log: [],
    skipped: [],
    track: [{ lon: first.lon, lat: first.lat, h: first.h, clockMin: startMin }],
    walkedM: 0,
    plannedM: legs.reduce((a, l) => a + l.distanceM, 0),
    notes: [],
    pos: first,
    events: [],
  };
  logEvent(s, "start", "Left the habitat");
  return s;
}

export function currentStop(s: WalkState): WalkStop | null {
  return s.phase === "at_stop" ? s.queue[0] : null;
}

/** The place the walkers head for next (null = the habitat). */
export function nextTarget(s: WalkState): WalkStop | null {
  if (s.phase === "walking") return s.legs[0]?.toId === "base" ? null : s.queue[0] ?? null;
  if (s.phase === "at_stop") return s.legs[0]?.toId === "base" ? null : s.queue[1] ?? null;
  return null;
}

export function plannedStopMin(s: WalkState): number {
  const st = currentStop(s);
  return st ? st.minutes + s.extraStopMin : 0;
}

/** Minutes still needed: rest of this leg or stop, the remaining legs and the stops not yet visited. */
export function remainingMin(s: WalkState): number {
  if (s.phase === "done") return 0;
  const legs = s.legs.reduce((a, l) => a + l.minutes, 0);
  if (s.phase === "walking") {
    const stops = s.queue.reduce((a, q) => a + q.minutes, 0);
    return legs - s.legT + stops;
  }
  const later = s.queue.slice(1).reduce((a, q) => a + q.minutes, 0);
  return Math.max(0, plannedStopMin(s) - s.stopElapsed) + legs + later;
}

export function projectedReturnMin(s: WalkState): number {
  return s.clockMin + remainingMin(s);
}

function moveTo(s: WalkState, p: Sample): void {
  const last = s.track[s.track.length - 1];
  const dLon = p.lon - last.lon;
  const dLat = p.lat - last.lat;
  const kx = 59274 * Math.cos((p.lat * Math.PI) / 180);
  const step = Math.hypot(dLon * kx, dLat * 59274);
  if (step >= 2) {
    s.track.push({ lon: p.lon, lat: p.lat, h: p.h, clockMin: s.clockMin });
    s.walkedM += step;
  }
  s.pos = p;
}

export function leaveStop(s: WalkState): WalkEvent | null {
  if (s.phase !== "at_stop") return null;
  const stop = s.queue.shift()!;
  const entry = s.log[s.log.length - 1];
  if (entry) entry.leftMin = s.clockMin;
  logEvent(s, "left", `Left ${stop.name}`);
  s.phase = "walking";
  s.legT = 0;
  s.stopElapsed = 0;
  s.extraStopMin = 0;
  return { type: "left", stop };
}

export function stayLonger(s: WalkState, minutes: number): void {
  if (s.phase === "at_stop") s.extraStopMin += minutes;
}

/** Advance the simulation by dt minutes. Stops end automatically after their planned time. */
export function tick(s: WalkState, dt: number): WalkEvent[] {
  const events: WalkEvent[] = [];
  let guard = 0;
  while (dt > 1e-9 && s.phase !== "done" && guard++ < 1000) {
    if (s.phase === "walking") {
      const leg = s.legs[0];
      const step = Math.min(dt, leg.minutes - s.legT);
      s.legT += step;
      s.clockMin += step;
      dt -= step;
      moveTo(s, sampleAt(leg, s.legT));
      if (s.legT >= leg.minutes - 1e-9) {
        s.legs.shift();
        if (leg.toId === "base") {
          s.phase = "done";
          s.track.push({ lon: s.pos.lon, lat: s.pos.lat, h: s.pos.h, clockMin: s.clockMin });
          logEvent(s, "home", "Back at the habitat");
          events.push({ type: "home" });
        } else {
          s.phase = "at_stop";
          s.stopElapsed = 0;
          s.extraStopMin = 0;
          const stop = s.queue[0];
          s.log.push({ id: stop.id, name: stop.name, arrivedMin: s.clockMin, tasksDone: [] });
          logEvent(s, "arrived", `Arrived at ${stop.name}`);
          events.push({ type: "arrived", stop });
        }
      }
    } else {
      const left = plannedStopMin(s) - s.stopElapsed;
      const step = Math.min(dt, Math.max(0, left));
      s.stopElapsed += step;
      s.clockMin += step;
      dt -= step;
      if (s.stopElapsed >= plannedStopMin(s) - 1e-9) {
        const e = leaveStop(s);
        if (e) events.push(e);
      }
    }
  }
  return events;
}

/** Drop the next stop and re-plan from here. */
export function skipNext(s: WalkState, input: PlanInput): { ok: true; skipped: WalkStop } | { ok: false; error: string } {
  if (s.phase === "done") return { ok: false, error: "The walk is over." };
  if (s.phase === "walking") {
    if (s.legs[0]?.toId === "base" || s.queue.length === 0) return { ok: false, error: "No stop left to skip." };
    const here: PlanStop = { id: "here", name: "Here", lon: s.pos.lon, lat: s.pos.lat, minutes: 0 };
    const dropped = s.queue[0];
    const rest = s.queue.slice(1);
    const r = routeLegs(input, here, rest);
    if (!r.ok) return { ok: false, error: r.error };
    s.queue = rest;
    s.legs = r.legs;
    s.legT = 0;
    s.skipped.push(dropped.id);
    logEvent(s, "skipped", `Skipped ${dropped.name}`);
    return { ok: true, skipped: dropped };
  }
  if (s.queue.length < 2) return { ok: false, error: "No stop left to skip." };
  const current = s.queue[0];
  const dropped = s.queue[1];
  const rest = s.queue.slice(2);
  const r = routeLegs(input, current, rest);
  if (!r.ok) return { ok: false, error: r.error };
  s.queue = [current, ...rest];
  s.legs = r.legs;
  s.skipped.push(dropped.id);
  logEvent(s, "skipped", `Skipped ${dropped.name}`);
  return { ok: true, skipped: dropped };
}

/** Leave the plan and walk straight home from here. */
export function headHomeNow(s: WalkState, input: PlanInput): { ok: true } | { ok: false; error: string } {
  if (s.phase !== "walking") return { ok: false, error: "Leave the stop first." };
  const here: PlanStop = { id: "here", name: "Here", lon: s.pos.lon, lat: s.pos.lat, minutes: 0 };
  const r = routeLegs(input, here, []);
  if (!r.ok) return { ok: false, error: r.error };
  for (const q of s.queue) {
    s.skipped.push(q.id);
    logEvent(s, "skipped", `Skipped ${q.name}`);
  }
  s.queue = [];
  s.legs = r.legs;
  s.legT = 0;
  logEvent(s, "home-now", "Headed home early");
  return { ok: true };
}

/** Where the crew was at a clock time (for the replay). */
export function trackAt(track: TrackPoint[], clockMin: number): TrackPoint {
  if (clockMin <= track[0].clockMin) return track[0];
  const last = track[track.length - 1];
  if (clockMin >= last.clockMin) return last;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].clockMin <= clockMin) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const f = b.clockMin > a.clockMin ? (clockMin - a.clockMin) / (b.clockMin - a.clockMin) : 0;
  return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f, h: a.h + (b.h - a.h) * f, clockMin };
}

/** Samples on the current leg within `metres` ahead of the walkers. */
export function lookAhead(s: WalkState, metres: number): Sample[] {
  if (s.phase !== "walking") return [];
  const leg = s.legs[0];
  const d0 = s.pos.d;
  return leg.samples.filter((p) => p.d > d0 && p.d <= d0 + metres);
}

/** Minutes until radio contact returns on this leg (null if it doesn't on this leg). */
export function minutesToRadio(s: WalkState): number | null {
  if (s.phase !== "walking") return null;
  const next = s.legs[0].samples.find((p) => p.t > s.legT && p.radio);
  return next ? next.t - s.legT : null;
}

/** Compass bearing in degrees from a to b (0 = north, 90 = east). */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const kx = Math.cos((a.lat * Math.PI) / 180);
  const deg = (Math.atan2((b.lon - a.lon) * kx, b.lat - a.lat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function compass(deg: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}
