// Baramger's Cloudflare Worker. One route, POST /api/chat (the mission assistant); everything else is
// the static site, served as before from the assets binding (wrangler.jsonc: run_worker_first only for /api/*).
// The five AI provider keys are Worker secrets: they never reach the browser.

import { type AskRequest, type AskResponse, type CheckInfo, type HistoryTurn, LIMITS, MESSAGES, type PlanContext } from "./api";
import { answerQuestion } from "./chain";
import type { KeyName } from "./providers";
import { PackageStore } from "./tools";

export interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  ASK_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  ALLOWED_ORIGINS?: string; // other sites that may call /api/chat (comma-separated), e.g. the Vercel site
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
}

const KEY_NAMES: KeyName[] = ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "CEREBRAS_API_KEY"];

let store: PackageStore | null = null; // one per Worker instance: package files are read once

// ------------------------------------------------------------------ checking the request
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const text = (x: unknown, max: number) => (typeof x === "string" ? x.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const n = (x: unknown) => (isNum(x) ? x : 0);
const arr = (x: unknown, max: number): unknown[] => (Array.isArray(x) ? x.slice(0, max) : []);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** Copies only known fields, cut to size: the plan is the browser's word, so it is treated as untrusted data. */
function cleanContext(raw: unknown): PlanContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = obj(raw);
  const status = (s: unknown): CheckInfo["status"] => (s === "ok" || s === "care" || s === "fail" ? s : "care");
  const t = obj(c.totals);
  const centre = obj(c.mapCenter);
  return {
    startClock: text(c.startClock, 5),
    crewSize: Math.max(1, Math.min(4, Math.round(n(c.crewSize)) || 2)),
    approved: c.approved === true,
    routeFound: c.routeFound === true,
    routeError: text(c.routeError, 200) || undefined,
    stops: arr(c.stops, 30).map(obj).map((s) => ({ id: text(s.id, 40), name: text(s.name, 60), lon: n(s.lon), lat: n(s.lat), minutes: n(s.minutes), arriveClock: text(s.arriveClock, 5) || undefined, fromPackage: s.fromPackage === true })),
    legs: arr(c.legs, 31).map(obj).map((l) => ({
      from: text(l.from, 60), to: text(l.to, 60), distanceM: n(l.distanceM), straightM: n(l.straightM), minutes: n(l.minutes), maxSlopeDeg: n(l.maxSlopeDeg), careM: n(l.careM),
      ascentM: n(l.ascentM), descentM: n(l.descentM), noRadioMin: n(l.noRadioMin), fromLon: n(l.fromLon), fromLat: n(l.fromLat), toLon: n(l.toLon), toLat: n(l.toLat),
    })),
    totals: c.totals ? { distanceM: n(t.distanceM), walkMin: n(t.walkMin), stopMin: n(t.stopMin), totalMin: n(t.totalMin), reserveMin: n(t.reserveMin), reserveFraction: n(t.reserveFraction), finishClock: text(t.finishClock, 5), latestFinishClock: text(t.latestFinishClock, 5) } : undefined,
    radioGaps: arr(c.radioGaps, 30).map(obj).map((g) => ({ leg: text(g.leg, 130), startClock: text(g.startClock, 5), minutes: n(g.minutes), afterM: n(g.afterM), startLon: n(g.startLon), startLat: n(g.startLat), endLon: n(g.endLon), endLat: n(g.endLat) })),
    checks: arr(c.checks, 12).map(obj).map((k) => ({ id: text(k.id, 20), label: text(k.label, 60), status: status(k.status), detail: text(k.detail, 300) })),
    selectedStopId: text(c.selectedStopId, 40) || undefined,
    mapCenter: isNum(centre.lon) && isNum(centre.lat) ? { lon: centre.lon, lat: centre.lat } : undefined,
  };
}

/** The request, checked and cut to the agreed limits; a string is the reason it was refused. */
export function parseAsk(raw: unknown): AskRequest | string {
  const b = obj(raw);
  const zone = text(b.zone, 10).toLowerCase();
  if (!/^z\d{1,2}$/.test(zone)) return "Unknown walk zone.";
  const question = text(b.question, 10_000);
  if (!question) return "The question is empty.";
  if (question.length > LIMITS.questionChars) return `Questions can be at most ${LIMITS.questionChars} characters.`;
  const history: HistoryTurn[] = arr(b.history, 10).map(obj)
    .map((h) => ({ q: text(h.q, LIMITS.questionChars), a: text(h.a, LIMITS.answerChars + 20) }))
    .filter((h) => h.q && h.a)
    .slice(-LIMITS.historyTurns);
  return { zone, question, history, context: cleanContext(b.context) };
}

// ------------------------------------------------------------------ HTTP
function allowedOrigin(request: Request, env: Env): { ok: boolean; cors?: string } {
  const origin = request.headers.get("Origin");
  if (!origin || origin === new URL(request.url).origin) return { ok: true };
  const list = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? { ok: true, cors: origin } : { ok: false };
}

function reply(body: AskResponse | { ok: false; error: string; message: string }, status: number, cors?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (cors) Object.assign(headers, { "Access-Control-Allow-Origin": cors, Vary: "Origin" });
  return new Response(JSON.stringify(body), { status, headers });
}

export interface HandlerDeps {
  fetch: typeof fetch;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

export async function handleChat(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const origin = allowedOrigin(request, env);
  if (request.method === "OPTIONS") {
    if (!origin.ok || !origin.cors) return new Response(null, { status: origin.ok ? 204 : 403 });
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": origin.cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" },
    });
  }
  if (request.method !== "POST") return reply({ ok: false, error: "bad_input", message: "Use POST." }, 405);
  if (!origin.ok) return reply({ ok: false, error: "forbidden", message: "This site may not use the assistant." }, 403);
  const cors = origin.cors;

  if (env.ASK_LIMIT) {
    const who = request.headers.get("CF-Connecting-IP") ?? "unknown"; // used only as the rate limiter's key, never stored
    const { success } = await env.ASK_LIMIT.limit({ key: who });
    if (!success) return reply({ ok: false, error: "rate_limited", message: MESSAGES.rateLimited }, 429, cors);
  }

  const size = Number(request.headers.get("Content-Length") ?? 0);
  if (size > LIMITS.bodyBytes) return reply({ ok: false, error: "bad_input", message: "The request is too large." }, 413, cors);
  let raw: unknown;
  try {
    const body = await request.text();
    if (body.length > LIMITS.bodyBytes) return reply({ ok: false, error: "bad_input", message: "The request is too large." }, 413, cors);
    raw = JSON.parse(body);
  } catch {
    return reply({ ok: false, error: "bad_input", message: "The request is not valid JSON." }, 400, cors);
  }
  const req = parseAsk(raw);
  if (typeof req === "string") return reply({ ok: false, error: "bad_input", message: req }, 400, cors);

  store ??= new PackageStore((path) => env.ASSETS.fetch(new Request(`https://assets.local/${path}`)));
  const keys = Object.fromEntries(KEY_NAMES.map((k) => [k, env[k]?.trim() || undefined]));
  const country = (request as Request & { cf?: { country?: string } }).cf?.country;
  const res = await answerQuestion({ req, keys, store, country }, deps);
  return reply(res, res.ok ? 200 : res.error === "bad_input" ? 400 : 503, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") {
      return handleChat(request, env, { fetch: (...a) => fetch(...a), now: () => Date.now(), log: (e) => console.log(JSON.stringify(e)) });
    }
    if (url.pathname.startsWith("/api/")) return reply({ ok: false, error: "bad_input", message: "Unknown API route." }, 404);
    return env.ASSETS.fetch(request);
  },
};
