// The browser side of the mission assistant: what the app sends with a question, and how it asks.
// The answer is written by an AI model through the Worker (worker/). It is shown labelled as an
// "AI explanation" and kept only in memory: never saved into a mission package (rule C5).

import { type AskRequest, type AskResponse, type PlanContext, LIMITS, MESSAGES } from "../worker/api";
import type { PlanResult } from "./plan";
import { fmtClock } from "./plan";

export { LIMITS, MESSAGES };
export type { AskAnswer, AskResponse, Fact, SourceRef } from "../worker/api";

/**
 * Where the assistant lives. Same site on Cloudflare: "/api/chat". The site on Vercel is built with
 * VITE_ASK_API set to the Cloudflare Worker's address (the Worker allows that origin).
 */
export const ASK_URL: string = (import.meta.env.VITE_ASK_API as string | undefined) || "/api/chat";

export interface ContextStop {
  id: string;
  name: string;
  lon: number;
  lat: number;
  minutes: number;
  custom: boolean;
}

export interface ContextInput {
  plan: PlanResult | null;
  planError: string;
  stops: ContextStop[]; // in walking order
  startClock: string; // "08:45"
  crewSize: number;
  approved: boolean;
  selectedId: string | null;
  mapCenter: { lon: number; lat: number } | null;
}

const R_MARS = 3_396_190;
function straightM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const k = (Math.PI / 180) * R_MARS;
  return Math.hypot((b.lon - a.lon) * k * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180), (b.lat - a.lat) * k);
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const clockMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * The crew's plan as the assistant sees it: only values Baramger's own code computed (plan.ts).
 * Crew notes are left out on purpose: free text may hold personal details, and free AI tiers may keep prompts.
 */
export function planContext(x: ContextInput): PlanContext {
  const p = x.plan;
  const arrive: string[] = [];
  if (p) {
    let clock = clockMin(x.startClock);
    p.legs.forEach((leg, i) => {
      clock += leg.minutes;
      if (i < p.legs.length - 1) {
        arrive.push(fmtClock(clock));
        clock += x.stops[i]?.minutes ?? 0;
      }
    });
  }
  const legs = (p?.legs ?? []).map((l) => {
    const a = l.points[0] ?? l.samples[0];
    const b = l.points[l.points.length - 1] ?? l.samples[l.samples.length - 1];
    return {
      from: l.fromName, to: l.toName, distanceM: Math.round(l.distanceM), straightM: a && b ? Math.round(straightM(a, b)) : 0,
      minutes: r1(l.minutes), maxSlopeDeg: l.maxSlope, careM: Math.round(l.careM), ascentM: Math.round(l.ascentM), descentM: Math.round(l.descentM),
      noRadioMin: r1(l.noRadioMin), fromLon: a?.lon ?? 0, fromLat: a?.lat ?? 0, toLon: b?.lon ?? 0, toLat: b?.lat ?? 0,
    };
  });
  // where each radio gap starts and ends: the same samples plan.ts used to find it
  const legStart: number[] = [];
  if (p) {
    let clock = clockMin(x.startClock);
    p.legs.forEach((leg, i) => {
      legStart.push(clock);
      clock += leg.minutes + (x.stops[i]?.minutes ?? 0);
    });
  }
  const radioGaps = (p?.radioGaps ?? []).map((g) => {
    const leg = p!.legs[g.legIndex];
    const s = leg.samples;
    const tIn = g.startClockMin - legStart[g.legIndex];
    let i = s.findIndex((q) => !q.radio && q.t >= tIn - 0.01);
    if (i < 0) i = Math.max(0, s.findIndex((q) => !q.radio));
    let j = i;
    while (j + 1 < s.length && !s[j + 1].radio) j++;
    const a = s[i];
    const b = s[j];
    return { leg: `${leg.fromName} → ${leg.toName}`, startClock: fmtClock(g.startClockMin), minutes: r1(g.minutes), afterM: Math.round(a?.d ?? 0), startLon: a?.lon ?? 0, startLat: a?.lat ?? 0, endLon: b?.lon ?? 0, endLat: b?.lat ?? 0 };
  });
  const t = p?.totals;
  return {
    startClock: x.startClock,
    crewSize: x.crewSize,
    approved: x.approved,
    routeFound: !!p,
    routeError: x.planError || undefined,
    stops: x.stops.map((s, i) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, minutes: s.minutes, arriveClock: arrive[i], fromPackage: !s.custom })),
    legs,
    totals: t ? { distanceM: Math.round(t.distanceM), walkMin: r1(t.walkMin), stopMin: t.stopMin, totalMin: r1(t.totalMin), reserveMin: r1(t.reserveMin), reserveFraction: Math.round(t.reserveFraction * 100) / 100, finishClock: fmtClock(t.finishClockMin), latestFinishClock: fmtClock(t.latestFinishClockMin) } : undefined,
    radioGaps,
    checks: (p?.checks ?? []).map((c) => ({ id: c.id, label: c.label, status: c.status, detail: c.detail })),
    selectedStopId: x.selectedId ?? undefined,
    mapCenter: x.mapCenter ?? undefined,
  };
}

export interface AskOptions {
  fetch?: typeof fetch;
  online?: boolean; // navigator.onLine
  url?: string;
  timeoutMs?: number;
}

/** Sends one question. Never throws: every failure becomes one of the agreed messages. */
export async function askAssistant(req: AskRequest, o: AskOptions = {}): Promise<AskResponse> {
  const online = o.online ?? (typeof navigator === "undefined" ? true : navigator.onLine);
  if (!online) return { ok: false, error: "offline", message: MESSAGES.offline };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 55_000); // the Worker gives up after about 45 s
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(o.url ?? ASK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req), signal: ac.signal });
  } catch {
    clearTimeout(timer);
    // no connection (or the network dropped): the crew's fix is the same
    return ac.signal.aborted ? { ok: false, error: "unavailable", message: MESSAGES.unavailable } : { ok: false, error: "offline", message: MESSAGES.offline };
  }
  try {
    const body = (await res.json()) as AskResponse;
    if (body && typeof body === "object" && "ok" in body) {
      if (body.ok && typeof body.text === "string") return body;
      if (!body.ok && typeof body.message === "string") return body;
    }
  } catch {
    /* not JSON: the site has no assistant here (e.g. a plain static host) */
  } finally {
    clearTimeout(timer);
  }
  return { ok: false, error: "unavailable", message: MESSAGES.unavailable };
}

/** Example questions shown before the first one (the five from the brief). */
export const EXAMPLES = [
  "Which stop is best for sampling, and why?",
  "Where do we lose radio contact?",
  "What's the temperature at 14:00?",
  "Why does the route go around the steep ground?",
  "Why did a safety check fail or need care?",
];
