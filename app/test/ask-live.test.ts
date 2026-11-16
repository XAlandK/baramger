// LIVE check of the providers with real keys: the five example questions, in both zones,
// one provider at a time, through the Worker's own chain and tools (only the HTTP layer is left out).
// Skipped unless ASK_LIVE=1. Keys are read from app/.dev.vars (git-ignored). Never run in CI.
//
//   cd app && ASK_LIVE=1 npx vitest run test/ask-live.test.ts
//   ASK_LIVE=1 ASK_ONLY=groq npx vitest run test/ask-live.test.ts   (one provider)
//   ASK_OUT=<file>  also writes every answer in full to that file (vitest hides the output of passing tests)
//   ASK_DEBUG=1     also writes each raw provider reply (cut to 1,500 characters; replies never hold the key)
//   ASK_Q=3,4       only these questions (1 = the first)
//   ASK_PATCH='{"requiredChoice":"auto"}'   try other provider settings (merged into the provider's config)
//   ASK_KEYS_FILE=<file>  read the keys from that file instead of app/.dev.vars
//
// It prints one line per question: provider, zone, kind, tools, time, and the start of the answer.
import { appendFile, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { GridMeta, RouteGrid } from "../src/grid";
import { DEFAULT_COST } from "../src/router";
import { computePlan } from "../src/plan";
import { assumption, type MissionPackage } from "../src/pkg";
import { planContext } from "../src/ask";
import type { AskResponse } from "../worker/api";
import { answerQuestion, resetRests } from "../worker/chain";
import { PROVIDER_CHAIN } from "../worker/providers";
import { DATA, diskStore } from "./disk-store";

const env = ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {});
const LIVE = env.ASK_LIVE === "1";
const out = async (line: string) => {
  console.log(line);
  if (env.ASK_OUT) await appendFile(env.ASK_OUT, `${line}\n`);
};

async function keys(): Promise<Record<string, string>> {
  // ASK_KEYS_FILE reads the keys from another file in the same KEY=value form (e.g. a short-lived token).
  const text = await readFile(env.ASK_KEYS_FILE ?? new URL("../.dev.vars", import.meta.url).pathname, "utf8").catch(() => "");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*"?([^"\r]*)"?\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].trim();
  }
  return out;
}

/** The zone's plan with its package stops, computed exactly as the app does (no weather checks). */
async function context(dir: string) {
  const pkg = JSON.parse(await readFile(`${DATA}${dir}/mission-package.json`, "utf8")) as MissionPackage;
  const meta = JSON.parse(await readFile(`${DATA}${dir}/route/grid.json`, "utf8")) as GridMeta;
  const buf = async (f: string) => {
    const b = await readFile(`${DATA}${dir}/route/${f}`);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const grid: RouteGrid = { meta, h: new Float32Array(await buf("height_2m.f32")), slope: new Uint8Array(await buf("slope_2m.u8")), rough: new Uint8Array(await buf("rough_2m.u8")) };
  const b = pkg.site.base.position;
  const stops = pkg.stops.map((s) => ({ id: s.id, name: s.name, lon: s.position.lon, lat: s.position.lat, minutes: s.plannedMinutes ?? 20, custom: false }));
  const plan = computePlan({
    grid,
    model: { ...DEFAULT_COST, comfortSlopeDeg: assumption(pkg, "A1", 15), maxSlopeDeg: assumption(pkg, "A2", 25), flatSpeedMs: assumption(pkg, "A3", 2.5) / 3.6 },
    base: { lon: b.lon, lat: b.lat, antennaM: pkg.site.base.antennaHeight_m ?? 3 },
    suitAntennaM: assumption(pkg, "A8", 1.8),
    stops,
    evaMin: assumption(pkg, "A4", 360),
    reserveFraction: assumption(pkg, "A5", 0.3),
    maxRadioGapMin: assumption(pkg, "A9", 15),
    startMin: 8 * 60 + 45,
    crewSize: 2,
  });
  return planContext({ plan, planError: plan.error ?? "", stops, startClock: "08:45", crewSize: 2, approved: false, selectedId: stops[1]?.id ?? null, mapCenter: null });
}

const QUESTIONS = [
  "Why does the route go around the steep ground between the habitat and stop 2?",
  "Which stop is best for sampling, and why?",
  "Why did a safety check fail or need care?",
  "What's the temperature at 14:00?",
  "Where do we lose radio contact?",
  "What radiation dose will we get at stop 1?", // the data cannot tell
];

describe.skipIf(!LIVE)("live providers", () => {
  const only = env.ASK_ONLY;
  const patch = env.ASK_PATCH ? (JSON.parse(env.ASK_PATCH) as Partial<(typeof PROVIDER_CHAIN)[number]>) : {};
  for (const p of PROVIDER_CHAIN.filter((x) => !only || x.id === only).map((x) => ({ ...x, ...patch }))) {
    for (const [zone, dir] of [["z2", "z2-bright-angel"], ["z1", "z1-three-forks"]] as const) {
      it(`${p.id} answers the example questions in ${zone}`, async () => {
        const k = await keys();
        if (!k[p.keyName]) {
          console.log(`${p.id}: no ${p.keyName} in .dev.vars, skipped`);
          return;
        }
        const ctx = await context(dir);
        const store = diskStore();
        const results: AskResponse[] = [];
        const pick = env.ASK_Q ? env.ASK_Q.split(",").map((n) => QUESTIONS[Number(n) - 1]).filter(Boolean) : QUESTIONS;
        const debugFetch: typeof fetch = async (url, init) => {
          const r = await fetch(url, init);
          const text = await r.clone().text();
          await out(`  raw ${p.id} ${r.status}: ${text.slice(0, 1500).replace(/\s+/g, " ")}`);
          return r;
        };
        for (const question of pick) {
          resetRests();
          const logs: Record<string, unknown>[] = [];
          const r = await answerQuestion(
            { req: { zone, question, context: ctx }, keys: { [p.keyName]: k[p.keyName], ...(p.urlVar ? { [p.urlVar]: k[p.urlVar] } : {}) }, store },
            { fetch: env.ASK_DEBUG ? debugFetch : fetch, now: () => Date.now(), log: (e) => logs.push(e), chain: [p], perProviderMs: 30_000, totalMs: 40_000 },
          );
          results.push(r);
          const why = logs.map((l) => JSON.stringify(l.tries ?? l.detail ?? "")).join(" ");
          await out(r.ok
            ? `${p.id} ${zone} ✓ ${r.kind} [${r.tools.join(",")}] ${r.ms} ms · ${r.sources.map((s) => s.id).join(" ")} · Q: ${question} · A: ${env.ASK_OUT ? r.text.replace(/\s+/g, " ") : r.text.slice(0, 160).replace(/\s+/g, " ")}${env.ASK_OUT ? ` · facts: ${r.facts.slice(0, 4).map((f) => `${f.label}=${f.value}`).join(" | ")}` : ""}`
            : `${p.id} ${zone} ✗ ${r.error} · Q: ${question} · ${why.slice(0, 400)}`);
          await new Promise((res) => setTimeout(res, Number(env.ASK_PAUSE_MS ?? 4000))); // free tiers: a few requests a minute
        }
        expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(pick.length - 1);
        const last = results[results.length - 1];
        if (last.ok && pick[pick.length - 1] === QUESTIONS[QUESTIONS.length - 1]) expect(last.kind).toBe("cannot_tell");
      }, 600_000);
    }
  }
});
