// The Worker's HTTP side: route, CORS allow-list, per-visitor limit, input checks. Providers are never called.
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, MESSAGES } from "../worker/api";
import { resetRests } from "../worker/chain";
import worker, { type Env, handleChat, parseAsk } from "../worker/index";
import { diskAsset } from "./disk-store";

const VERCEL = "https://baramger.vercel.app";
const SELF = "https://baramger.example.workers.dev";

function env(over: Partial<Env> = {}): Env {
  return { ASSETS: { fetch: async (r) => diskAsset(new URL(typeof r === "string" ? r : r.url).pathname.slice(1)) }, ALLOWED_ORIGINS: VERCEL, ...over };
}

const deps = (calls: string[] = []) => ({
  fetch: (async (url: string) => {
    calls.push(String(url));
    return new Response("{}", { status: 503 });
  }) as typeof fetch,
  now: () => Date.now(),
  log: () => {},
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${SELF}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => resetRests());

describe("CORS", () => {
  it("the Vercel site may call the API (preflight and answer carry its origin)", async () => {
    const pre = await handleChat(new Request(`${SELF}/api/chat`, { method: "OPTIONS", headers: { Origin: VERCEL } }), env(), deps());
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(VERCEL);
    const res = await handleChat(post({ zone: "z2", question: "Hi?" }, { Origin: VERCEL }), env(), deps());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(VERCEL);
  });

  it("other sites are refused before any provider is called", async () => {
    const calls: string[] = [];
    const res = await handleChat(post({ zone: "z2", question: "Hi?" }, { Origin: "https://other.example" }), env({ GEMINI_API_KEY: "g" }), deps(calls));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    const pre = await handleChat(new Request(`${SELF}/api/chat`, { method: "OPTIONS", headers: { Origin: "https://other.example" } }), env(), deps());
    expect(pre.status).toBe(403);
  });

  it("the same site (Cloudflare copy) needs no CORS", async () => {
    const res = await handleChat(post({ zone: "z2", question: "Hi?" }, { Origin: SELF }), env(), deps());
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("limits and input", () => {
  it("the per-visitor limit answers 429 with the agreed message", async () => {
    const res = await handleChat(post({ zone: "z2", question: "Hi?" }, { "CF-Connecting-IP": "1.2.3.4" }), env({ ASK_LIMIT: { limit: async () => ({ success: false }) } }), deps());
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited", message: MESSAGES.rateLimited });
  });

  it("refuses broken JSON, an empty or too long question, and an unknown zone", async () => {
    expect((await handleChat(post("{nope"), env(), deps())).status).toBe(400);
    expect((await handleChat(post({ zone: "z2", question: " " }), env(), deps())).status).toBe(400);
    expect((await handleChat(post({ zone: "z2", question: "x".repeat(LIMITS.questionChars + 1) }), env(), deps())).status).toBe(400);
    expect((await handleChat(post({ zone: "mars", question: "Hi?" }), env(), deps())).status).toBe(400);
    expect((await handleChat(new Request(`${SELF}/api/chat`), env(), deps())).status).toBe(405);
  });

  it("keeps only the last 2 turns of history and cleans the plan", () => {
    const r = parseAsk({
      zone: "Z2",
      question: "  Where do we lose radio?  ",
      history: [1, 2, 3].map((i) => ({ q: `q${i}`, a: `a${i}` })),
      context: { crewSize: 9, stops: [{ id: "stop-1", name: "<b>x</b>", lon: "77", lat: 18.5 }], checks: [{ id: "radio", status: "weird" }], mapCenter: { lon: 1 } },
    });
    if (typeof r === "string") throw new Error(r);
    expect(r.zone).toBe("z2");
    expect(r.question).toBe("Where do we lose radio?");
    expect(r.history?.map((h) => h.q)).toEqual(["q2", "q3"]);
    expect(r.context?.crewSize).toBe(4);
    expect(r.context?.stops[0].lon).toBe(0); // a string is not a number
    expect(r.context?.checks[0].status).toBe("care");
    expect(r.context?.mapCenter).toBeUndefined();
  });

  it("with no keys set the crew gets 'isn't available right now'", async () => {
    const res = await handleChat(post({ zone: "z2", question: "What's the temperature at 14:00?" }), env(), deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "unavailable", message: MESSAGES.unavailable });
  });
});

describe("routing", () => {
  it("other paths are static files from the assets binding", async () => {
    const res = await worker.fetch(new Request(`${SELF}/package/index.json`), env());
    expect(res.status).toBe(200);
    expect((await res.json()).default).toBe("z2");
    expect((await worker.fetch(new Request(`${SELF}/api/other`), env())).status).toBe(404);
  });
});
