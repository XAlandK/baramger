// Turns a list of stops into a walk plan: legs, totals, radio gaps and safety checks.

import { type LonLat, type RouteGrid, bilinear, cellIndex, metresBetween } from "./grid";
import { type CostModel, cellPenalty, findRoute, tobler } from "./router";
import { hasLineOfSight } from "./los";

export interface PlanStop extends LonLat {
  id: string;
  name: string;
  minutes: number;
}

export interface Conditions {
  sunriseMin: number; // local mean solar time, minutes after midnight
  sunsetMin: number;
  afterSunriseMin: number; // A10
  beforeSunsetMin: number; // A11
  protonPfu: number | null; // latest >=10 MeV proton level (measured near Earth)
  protonLimitPfu: number; // A12
  xFlareHoursAgo: number | null; // hours since the latest X-class flare, at data time
  xFlareCareHours: number; // A13
  dataDate: string; // when the sun data was retrieved
}

export interface PlanInput {
  grid: RouteGrid;
  model: CostModel;
  base: LonLat & { antennaM: number };
  suitAntennaM: number;
  stops: PlanStop[];
  evaMin: number; // A4
  reserveFraction: number; // A5
  maxRadioGapMin: number; // A9
  startMin: number; // walk start, minutes after local midnight
  conditions?: Conditions;
}

export interface Sample extends LonLat {
  h: number;
  slope: number;
  d: number; // metres from the start of the leg
  t: number; // minutes from the start of the leg
  radio: boolean;
}

export interface Leg {
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  points: LonLat[];
  samples: Sample[];
  distanceM: number;
  ascentM: number;
  descentM: number;
  maxSlope: number;
  careM: number;
  minutes: number;
  noRadioMin: number;
}

export type CheckStatus = "ok" | "care" | "fail";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface RadioGap {
  legIndex: number;
  minutes: number;
  startClockMin: number;
}

export interface PlanResult {
  ok: boolean;
  error?: string;
  legs: Leg[];
  totals: {
    distanceM: number;
    walkMin: number;
    stopMin: number;
    totalMin: number;
    reserveMin: number;
    reserveFraction: number;
    maxSlope: number;
    careM: number;
    ascentM: number;
    descentM: number;
    finishClockMin: number;
    latestFinishClockMin: number;
    leaveLastStopByMin: number;
  };
  radioGaps: RadioGap[];
  checks: Check[];
}

const SAMPLE_M = 2;

function sampleLeg(input: PlanInput, pts: LonLat[]): Sample[] {
  const { grid: g, model: m } = input;
  const base = { lon: input.base.lon, lat: input.base.lat, h: bilinear(g.meta, g.h, input.base.lon, input.base.lat) + input.base.antennaM };
  const out: Sample[] = [];
  let d = 0;
  let t = 0;
  let prev: Sample | null = null;
  for (let k = 0; k + 1 < pts.length || (k === 0 && pts.length === 1); k++) {
    const a = pts[k];
    const b = pts[Math.min(k + 1, pts.length - 1)];
    const L = metresBetween(g.meta, a, b);
    const n = Math.max(1, Math.ceil(L / SAMPLE_M));
    for (let s = k === 0 ? 0 : 1; s <= n; s++) {
      const f = s / n;
      const lon = a.lon + (b.lon - a.lon) * f;
      const lat = a.lat + (b.lat - a.lat) * f;
      const h = bilinear(g.meta, g.h, lon, lat);
      const i = cellIndex(g.meta, lon, lat);
      if (prev) {
        const step = metresBetween(g.meta, prev, { lon, lat });
        if (step > 0) {
          const grade = (h - prev.h) / step;
          t += (step / (m.flatSpeedMs * tobler(grade))) * cellPenalty(g, i, m) / 60;
          d += step;
        }
      }
      const radio = hasLineOfSight(g, base, { lon, lat, h: h + input.suitAntennaM });
      const smp: Sample = { lon, lat, h, slope: g.slope[i], d, t, radio };
      out.push(smp);
      prev = smp;
    }
    if (pts.length === 1) break;
  }
  return out;
}

function summarise(input: PlanInput, from: PlanStop | null, to: PlanStop | null, pts: LonLat[]): Leg {
  const samples = sampleLeg(input, pts);
  let asc = 0;
  let desc = 0;
  let maxSlope = 0;
  let careM = 0;
  let noRadio = 0;
  for (let i = 1; i < samples.length; i++) {
    const dh = samples[i].h - samples[i - 1].h;
    if (dh > 0) asc += dh;
    else desc -= dh;
    const s = samples[i].slope;
    maxSlope = Math.max(maxSlope, s);
    if (s > input.model.comfortSlopeDeg) careM += samples[i].d - samples[i - 1].d;
    if (!samples[i].radio) noRadio += samples[i].t - samples[i - 1].t;
  }
  const last = samples[samples.length - 1];
  return {
    fromId: from?.id ?? "base",
    toId: to?.id ?? "base",
    fromName: from?.name ?? "Habitat",
    toName: to?.name ?? "Habitat",
    points: pts,
    samples,
    distanceM: last?.d ?? 0,
    ascentM: asc,
    descentM: desc,
    maxSlope,
    careM,
    minutes: last?.t ?? 0,
    noRadioMin: noRadio,
  };
}

export function fmtClock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * A short walking order for the stops, starting and ending at the habitat:
 * nearest-neighbour first, then 2-opt improvement on straight-line distance.
 * It only suggests an order; the safe route is still found afterwards.
 */
export function suggestOrder<T extends LonLat>(base: LonLat, stops: T[]): T[] {
  if (stops.length < 3) return [...stops];
  const kx = Math.cos((base.lat * Math.PI) / 180);
  const dist = (a: LonLat, b: LonLat) => Math.hypot((a.lon - b.lon) * kx, a.lat - b.lat);
  const left = [...stops];
  const order: T[] = [];
  let here: LonLat = base;
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (dist(here, left[i]) < dist(here, left[bi])) bi = i;
    here = left[bi];
    order.push(left.splice(bi, 1)[0]);
  }
  const tour = [base, ...order, base];
  let improved = true;
  for (let guard = 0; improved && guard < 200; guard++) {
    improved = false;
    for (let i = 1; i < tour.length - 2; i++) {
      for (let j = i + 1; j < tour.length - 1; j++) {
        const before = dist(tour[i - 1], tour[i]) + dist(tour[j], tour[j + 1]);
        const after = dist(tour[i - 1], tour[j]) + dist(tour[i], tour[j + 1]);
        if (after < before - 1e-12) {
          tour.splice(i, j - i + 1, ...tour.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return tour.slice(1, -1) as T[];
}

/** Legs from a starting place (null = habitat) through the stops and back to the habitat. */
export function routeLegs(input: PlanInput, from: PlanStop | null, stops: PlanStop[]): { ok: true; legs: Leg[] } | { ok: false; error: string } {
  const seq: (PlanStop | null)[] = [from, ...stops, null]; // null = habitat
  const legs: Leg[] = [];
  for (let k = 0; k + 1 < seq.length; k++) {
    const a = seq[k] ?? input.base;
    const b = seq[k + 1] ?? input.base;
    const r = findRoute(input.grid, input.model, a, b);
    if (!r.ok) {
      const name = (seq[k + 1] ?? { name: "the habitat" }).name;
      return { ok: false, error: `${r.reason} (on the way to ${name})` };
    }
    legs.push(summarise(input, seq[k], seq[k + 1], r.points));
  }
  return { ok: true, legs };
}

function conditionChecks(input: PlanInput, finishMin: number): Check[] {
  const c = input.conditions;
  if (!c) return [];
  const start = input.startMin;
  const earliest = c.sunriseMin + c.afterSunriseMin;
  const latest = c.sunsetMin - c.beforeSunsetMin;
  const daylight: Check = {
    id: "daylight",
    label: "Daylight",
    status: start >= earliest && finishMin <= latest ? "ok" : start >= c.sunriseMin && finishMin <= c.sunsetMin ? "care" : "fail",
    detail:
      start < c.sunriseMin ? `The walk starts before sunrise (${fmtClock(c.sunriseMin)}).`
      : finishMin > c.sunsetMin ? `You would come back after sunset (${fmtClock(c.sunsetMin)}). Start earlier or shorten the walk.`
      : start < earliest || finishMin > latest
        ? `Sunrise ${fmtClock(c.sunriseMin)}, sunset ${fmtClock(c.sunsetMin)}. The rule is to start ${c.afterSunriseMin} min after sunrise and be back ${c.beforeSunsetMin} min before sunset.`
        : `Sunrise ${fmtClock(c.sunriseMin)}, sunset ${fmtClock(c.sunsetMin)}. The whole walk is in good daylight.`,
  };
  const storm = c.protonPfu !== null && c.protonPfu >= c.protonLimitPfu;
  const xRecent = c.xFlareHoursAgo !== null && c.xFlareHoursAgo <= c.xFlareCareHours;
  const sun: Check = {
    id: "sun",
    label: "Sun activity",
    status: storm ? "fail" : xRecent ? "care" : "ok",
    detail: storm
      ? `Solar particle storm: ${c.protonPfu} pfu (limit ${c.protonLimitPfu}). Postpone the walk.`
      : xRecent
        ? `A strong (X-class) solar flare ${Math.round(c.xFlareHoursAgo!)} h ago. Watch for a particle storm.`
        : `Quiet: particle level ${c.protonPfu ?? "unknown"} pfu, under the storm level of ${c.protonLimitPfu}. Measured near Earth, ${c.dataDate}.`,
  };
  return [daylight, sun];
}

export function computePlan(input: PlanInput): PlanResult {
  const empty: PlanResult["totals"] = {
    distanceM: 0, walkMin: 0, stopMin: 0, totalMin: 0, reserveMin: 0, reserveFraction: 0, maxSlope: 0, careM: 0,
    ascentM: 0, descentM: 0, finishClockMin: input.startMin, latestFinishClockMin: input.startMin, leaveLastStopByMin: input.startMin,
  };
  if (input.stops.length === 0) {
    return { ok: false, error: "Add at least one stop.", legs: [], totals: empty, radioGaps: [], checks: [] };
  }
  const routed = routeLegs(input, null, input.stops);
  if (!routed.ok) return { ok: false, error: routed.error, legs: [], totals: empty, radioGaps: [], checks: [] };
  const legs = routed.legs;

  const walkMin = legs.reduce((s, l) => s + l.minutes, 0);
  const stopMin = input.stops.reduce((s, x) => s + x.minutes, 0);
  const totalMin = walkMin + stopMin;
  const usable = input.evaMin * (1 - input.reserveFraction);
  const reserveMin = input.evaMin - totalMin;
  const lastLeg = legs[legs.length - 1];
  const totals = {
    distanceM: legs.reduce((s, l) => s + l.distanceM, 0),
    walkMin,
    stopMin,
    totalMin,
    reserveMin,
    reserveFraction: reserveMin / input.evaMin,
    maxSlope: Math.max(...legs.map((l) => l.maxSlope)),
    careM: legs.reduce((s, l) => s + l.careM, 0),
    ascentM: legs.reduce((s, l) => s + l.ascentM, 0),
    descentM: legs.reduce((s, l) => s + l.descentM, 0),
    finishClockMin: input.startMin + totalMin,
    latestFinishClockMin: input.startMin + usable,
    leaveLastStopByMin: input.startMin + usable - lastLeg.minutes,
  };

  // radio gaps: runs of samples with no line of sight to the habitat
  const radioGaps: RadioGap[] = [];
  let clock = input.startMin;
  legs.forEach((leg, li) => {
    let gapStart = -1;
    for (let i = 0; i < leg.samples.length; i++) {
      const s = leg.samples[i];
      if (!s.radio && gapStart < 0) gapStart = i;
      const closes = gapStart >= 0 && (s.radio || i === leg.samples.length - 1);
      if (closes) {
        const minutes = s.t - leg.samples[gapStart].t;
        if (minutes >= 0.5) radioGaps.push({ legIndex: li, minutes, startClockMin: clock + leg.samples[gapStart].t });
        gapStart = -1;
      }
    }
    clock += leg.minutes + (input.stops[li]?.minutes ?? 0);
  });

  const m = input.model;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const longestGap = radioGaps.reduce((a, g) => Math.max(a, g.minutes), 0);
  const checks: Check[] = [
    {
      id: "time",
      label: "Time and reserve",
      status: totalMin <= usable ? "ok" : totalMin <= input.evaMin ? "care" : "fail",
      detail: totalMin <= input.evaMin
        ? `${Math.round(totalMin)} min planned. ${Math.round(reserveMin)} min (${pct(totals.reserveFraction)}) left in reserve; the rule is at least ${pct(input.reserveFraction)}.`
        : `${Math.round(totalMin)} min planned, which is longer than the ${input.evaMin} min walk limit. Remove a stop or shorten stops.`,
    },
    {
      id: "slope",
      label: "Steepest ground",
      status: totals.maxSlope <= m.comfortSlopeDeg ? "ok" : totals.maxSlope <= m.maxSlopeDeg ? "care" : "fail",
      detail: totals.maxSlope <= m.comfortSlopeDeg
        ? `Never steeper than ${Math.round(totals.maxSlope)} deg.`
        : `Up to ${Math.round(totals.maxSlope)} deg. About ${Math.round(totals.careM)} m of the route is between ${m.comfortSlopeDeg} and ${m.maxSlopeDeg} deg: take care there.`,
    },
    {
      id: "radio",
      label: "Radio contact with the habitat",
      status: radioGaps.length === 0 ? "ok" : longestGap <= input.maxRadioGapMin ? "care" : "fail",
      detail: radioGaps.length === 0
        ? "Line of sight to the habitat antenna for the whole walk."
        : longestGap <= input.maxRadioGapMin
          ? `${radioGaps.length} short stretch${radioGaps.length > 1 ? "es" : ""} with no radio, the longest about ${Math.round(longestGap)} min (limit ${input.maxRadioGapMin} min). Stay together there.`
          : `No radio for about ${Math.round(longestGap)} min in one stretch, more than the ${input.maxRadioGapMin} min limit. Move a stop or plan a radio relay.`,
    },
    ...conditionChecks(input, totals.finishClockMin),
    {
      id: "buddy",
      label: "Buddy rule",
      status: "ok",
      detail: "Two astronauts walk together the whole time.",
    },
  ];
  return { ok: true, legs, totals, radioGaps, checks };
}
