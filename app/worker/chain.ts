// The fallback chain: each question goes to the first provider in PROVIDER_CHAIN that has a key,
// is not resting and may serve this visitor. If it fails, the WHOLE question starts again on the next
// provider (never with the first provider's half-finished tool-call history: formats and IDs differ).

import { LIMITS, MESSAGES, type AskRequest, type AskResponse, type Fact, type Skip, type SourceRef } from "./api";
import { type AssistantMessage, type FailKind, type KeyName, PROVIDER_CHAIN, type ProviderConfig, type UrlVar, callChat, providerUrl, requestBody } from "./providers";
import { FINAL_ANSWER, type PackageStore, TOOLS, runTool, toolSpecs } from "./tools";

export interface ChainDeps {
  fetch: typeof fetch;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  chain?: ProviderConfig[]; // tests pass their own list
  perProviderMs?: number;
  totalMs?: number;
}

export interface ChainInput {
  req: AskRequest;
  keys: Partial<Record<KeyName | UrlVar, string | undefined>>; // keys, and settings that go into a URL
  store: PackageStore;
  country?: string; // the visitor's country (Cloudflare), for providers that may not serve some places
}

const PER_PROVIDER_MS = 15_000;
const TOTAL_MS = 45_000;
const MAX_ROUNDS = 5; // model calls per question on one provider
const MAX_DATA_CALLS = 8;

// ------------------------------------------------------------------ rests after errors
// Kept in the Worker's memory: one Cloudflare instance remembers it; another may try once more.
const rests = new Map<string, { until: number; why: string }>();

export function resetRests(): void {
  rests.clear();
}

/** Seconds a provider rests after a failure; 0 = try it again with the next question. */
function restSeconds(kind: FailKind | "invalid", retryAfterS?: number): number {
  if (kind === "rate_limit") return Math.min(3600, Math.max(5, retryAfterS ?? 60));
  if (kind === "quota") return 3600;
  if (kind === "auth" || kind === "not_found") return 600; // a wrong key or a retired model: logged, rests 10 min
  return 0;
}

const WHY: Record<FailKind | "invalid", string> = {
  rate_limit: "busy (rate limit)",
  quota: "out of credits",
  server: "server error",
  timeout: "too slow (timeout)",
  network: "could not be reached",
  auth: "key refused",
  not_found: "model not found",
  region: "not available from this place",
  model_error: "wrote a broken tool call",
  bad_response: "gave an unusable reply",
  bad_request: "rejected our request",
  invalid: "answer failed our checks",
};

// ------------------------------------------------------------------ the prompt
function systemPrompt(req: AskRequest, zone: { code: string; name: string; key: string }, others: string, mode: "tool" | "text"): string {
  const p = req.context;
  const plan = !p
    ? "The app sent no plan."
    : `The crew's plan has ${p.stops.length} stop${p.stops.length === 1 ? "" : "s"}; ${p.routeFound ? `a route was found${p.approved ? " and the plan is approved" : " (not approved yet)"}` : "no route has been found yet"}; walk starts ${p.startClock}; crew of ${p.crewSize}.`;
  const sel = p?.selectedStopId ? p.stops.find((s) => s.id === p.selectedStopId) : undefined;
  const focus = [
    sel ? `The crew has stop "${sel.name}" (${sel.id}) open: "this stop" means it.` : "",
    p?.mapCenter ? `The map is centred on ${p.mapCenter.lat.toFixed(5)}° N, ${p.mapCenter.lon.toFixed(5)}° E: "here" or "this ridge" means near there.` : "",
  ].filter(Boolean).join(" ");
  return `You are the habitat assistant of Baramger, a planner for astronauts' walks on Mars ("Marswalks").
The crew is planning a walk in zone ${zone.code} "${zone.name}" (key ${zone.key}), Jezero crater, Mars.${others ? ` Other zone: ${others}.` : ""}
Answer the crew's questions about this walk, this walk zone and its mission data by looking the data up with the tools.

Rules:
1. Use only what the tools return. Never answer from general knowledge about Mars, this place, its weather or the route: look it up first.
2. If the tool results do not answer the question, ${mode === "tool" ? "set cannot_tell to true and " : ""}start with "I can't tell from the mission data." Then say in one sentence what the data does have. Never guess. If the question assumes something the data does not show (for example steep ground where there is none), say what the data shows instead.
3. You never decide what is safe. Baramger's own safety checks (in get_plan) decide. Explain their results; never call a plan, stop or route safe or unsafe yourself, and never change a check's result.
4. If the question is not about this walk, this zone or its data, ${mode === "tool" ? "set off_topic to true" : "answer only: OFF TOPIC"}.
5. To explain why a route bends or goes around ground, use the legs' directLine in get_plan (how much of the straight line is too steep); never use the route's own slope values for the straight line.
6. Plain text in simple English, at most ${LIMITS.answerWords} words, no markdown. Give numbers with their units as the tools give them. Times are local Mars time (24-hour clock). Name places by their stop names where you can.
7. Weather values are medians measured by the Perseverance rover on past days at this place, not a forecast. Sun activity is measured near Earth. Say so when you use them.
${mode === "tool"
  ? `8. In final_answer.sources, list the source IDs given in the tool results you used (for example R1, R2, S4, PLAN).
9. Finish by calling final_answer once.`
  : `8. When you have the data, answer in plain text. End with one line "Sources: " and the source IDs given in the tool results you used (for example "Sources: R1, S4, PLAN").`}

Now: ${plan}${focus ? ` ${focus}` : ""}`;
}

// ------------------------------------------------------------------ one provider
type TryResult =
  | { ok: true; kind: "answer" | "cannot_tell" | "off_topic"; text: string; facts: Fact[]; declared: string[]; tools: string[]; rounds: number }
  | { ok: false; kind: FailKind | "invalid"; status?: number; retryAfterS?: number; detail: string };

function clean(text: string): string {
  let t = text.replace(/\*\*|__|`|^#+\s*/gm, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const words = t.split(/\s+/);
  if (t.length > LIMITS.answerChars || words.length > LIMITS.answerWords + 20) {
    t = words.slice(0, LIMITS.answerWords + 20).join(" ").slice(0, LIMITS.answerChars);
    const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf(".\n"));
    t = (end > t.length / 2 ? t.slice(0, end + 1) : t) + " …";
  }
  return t;
}

const asBool = (v: unknown) => v === true || v === "true";

/** The final answer, checked. A bad one moves the question to the next provider. */
function checkFinal(args: Record<string, unknown>, dataCalls: number): { ok: true; kind: "answer" | "cannot_tell" | "off_topic"; text: string; declared: string[] } | { ok: false; detail: string } {
  const answer = typeof args.answer === "string" ? args.answer.trim() : "";
  const declared = Array.isArray(args.sources) ? args.sources.map((x) => String(x).trim().toUpperCase().split("-")[0]) : [];
  if (asBool(args.off_topic)) return { ok: true, kind: "off_topic", text: MESSAGES.offTopic, declared: [] };
  if (dataCalls === 0) return { ok: false, detail: "answered without looking up any data" };
  if (asBool(args.cannot_tell)) {
    const rest = answer.replace(/^[^.]*\b(can'?t|cannot|can not|unable to)\b[^.]*\.\s*/i, "").trim();
    return { ok: true, kind: "cannot_tell", text: clean(rest ? `${MESSAGES.cannotTell} ${rest}` : MESSAGES.cannotTell), declared };
  }
  if (!answer) return { ok: false, detail: "empty answer" };
  return { ok: true, kind: "answer", text: clean(answer), declared };
}

/**
 * final_answer's arguments written as the reply text instead of a tool call (gpt-oss on Cloudflare Workers AI did
 * this, 2026-11-16): a JSON object with a string "answer", maybe inside a ``` fence. Null for anything else.
 */
function answerJson(content: string): Record<string, unknown> | null {
  const t = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { answer?: unknown }).answer === "string") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON after all: read as plain text
  }
  return null;
}

/** A plain-text answer (answerMode "text", or a model that skipped final_answer), checked like a final_answer. */
function checkText(content: string, dataCalls: number): { ok: true; kind: "answer" | "cannot_tell" | "off_topic"; text: string; declared: string[] } | { ok: false; detail: string } {
  const json = answerJson(content);
  if (json) return checkFinal(json, dataCalls); // never show the crew raw JSON
  let t = content.trim();
  if (/^\W*OFF[\s_-]*TOPIC\b/i.test(t)) return { ok: true, kind: "off_topic", text: MESSAGES.offTopic, declared: [] };
  let declared: string[] = [];
  // "Sources: R1, S4" at the very end, on its own line or after the last sentence
  const src = /\**\bsources?\**\s*:\s*([A-Za-z0-9 ,;]+?)\.?\s*$/i.exec(t);
  if (src) {
    declared = src[1].split(/[\s,;]+/).map((x) => x.replace(/[^A-Za-z0-9]/g, "").toUpperCase()).filter(Boolean);
    t = t.slice(0, src.index).trim();
  }
  return checkFinal({ answer: t, sources: declared, cannot_tell: /^\W*I\s+(can'?t|can’t|cannot|can not)\s+tell\b/i.test(t), off_topic: false }, dataCalls);
}

async function tryProvider(p: ProviderConfig, key: string, input: ChainInput, zoneKeys: string[], system: string, deadline: number, deps: ChainDeps): Promise<TryResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(0, deadline - deps.now()));
  try {
    const textMode = p.answerMode === "text";
    const tools = toolSpecs(zoneKeys, !textMode);
    const finalOnly = toolSpecs(zoneKeys).filter((t) => (t as { function: { name: string } }).function.name === FINAL_ANSWER);
    const messages: unknown[] = [{ role: "system", content: system }];
    for (const h of input.req.history ?? []) messages.push({ role: "user", content: h.q }, { role: "assistant", content: h.a });
    messages.push({ role: "user", content: input.req.question });
    const facts: Fact[] = [];
    const used: string[] = [];
    let dataCalls = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS - 1 || dataCalls >= MAX_DATA_CALLS;
      const choice = textMode
        ? round === 0 ? p.requiredChoice : last ? "none" : "auto" // look something up first; answer in text at the end
        : last && p.namedChoice ? { type: "function", function: { name: FINAL_ANSWER } } : p.requiredChoice;
      // the last round of a provider that cannot name a tool: final_answer is the only tool offered
      const offered = last && !textMode && !p.namedChoice ? finalOnly : tools;
      const res = await callChat(p, key, requestBody(p, messages, offered, choice), { fetch: deps.fetch, signal: ac.signal, now: deps.now });
      if (!res.ok) return res;
      const msg: AssistantMessage = res.message;
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        // Plain text instead of final_answer: checked the same way (a look-up first, the agreed openings).
        if (!msg.content?.trim()) return { ok: false, kind: "invalid", detail: textMode ? "empty answer" : "no tool call" };
        const f = checkText(msg.content, dataCalls);
        if (!f.ok) return { ok: false, kind: "invalid", detail: f.detail };
        return { ok: true, kind: f.kind, text: f.text, facts, declared: f.declared, tools: used, rounds: round + 1 };
      }
      // Every call needs an ID to answer to (9 letters and digits suit Mistral's old rule too).
      calls.forEach((c, k) => {
        if (!c.id) c.id = `call${round}x${k}abcdefgh`.slice(0, 9);
      });
      // Sent back unchanged (Gemini needs its thought signatures); content empty, as some providers ask.
      messages.push({ role: "assistant", content: "", tool_calls: calls });
      const final = calls.find((c) => c.function?.name === FINAL_ANSWER);
      if (final) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(final.function.arguments || "{}");
        } catch {
          return { ok: false, kind: "invalid", detail: "broken final_answer JSON" };
        }
        const f = checkFinal(args, dataCalls);
        if (!f.ok) return { ok: false, kind: "invalid", detail: f.detail };
        return { ok: true, kind: f.kind, text: f.text, facts, declared: f.declared, tools: used, rounds: round + 1 };
      }
      for (const c of calls) {
        const name = c.function?.name;
        if (!name || !TOOLS.some((t) => t.name === name)) return { ok: false, kind: "invalid", detail: `called an unknown tool "${String(name).slice(0, 40)}"` };
        let args: Record<string, unknown>;
        try {
          const raw: unknown = c.function.arguments;
          args = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : JSON.parse(String(raw || "{}"));
          if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("not an object");
        } catch {
          return { ok: false, kind: "invalid", detail: "broken tool-call JSON" };
        }
        const r = await runTool(name, args, { store: input.store, zone: input.req.zone, plan: input.req.context });
        used.push(name);
        if (r.ok) {
          dataCalls++;
          facts.push(...r.facts);
        }
        messages.push({ role: "tool", tool_call_id: c.id, ...(p.toolMessageName ? { name } : {}), content: r.content });
      }
    }
    return { ok: false, kind: "invalid", detail: "no final answer" };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ the chain
const SPECIAL: Record<string, string> = {
  PLAN: "Your plan, computed by Baramger's safety checks",
  PKG: "Baramger mission package (the team's plan and pipeline)",
};

function sourceList(facts: Fact[], declared: string[], names: Map<string, string>): SourceRef[] {
  const seen = [...new Set(facts.map((f) => f.ref).filter((r) => !/^A\d+$/.test(r)))];
  const pick = declared.filter((d) => seen.includes(d));
  return (pick.length ? [...new Set(pick)] : seen).map((id) => ({ id, name: SPECIAL[id] ?? names.get(id) ?? id }));
}

function uniqueFacts(facts: Fact[]): Fact[] {
  const out: Fact[] = [];
  const keys = new Set<string>();
  for (const f of facts) {
    const k = `${f.label}|${f.value}`;
    if (!keys.has(k)) {
      keys.add(k);
      out.push(f);
    }
  }
  return out.slice(0, 20);
}

export async function answerQuestion(input: ChainInput, deps: ChainDeps): Promise<AskResponse> {
  const t0 = deps.now();
  const chain = deps.chain ?? PROVIDER_CHAIN;
  const perProvider = deps.perProviderMs ?? PER_PROVIDER_MS;
  const end = t0 + (deps.totalMs ?? TOTAL_MS);
  const skipped: Skip[] = [];
  const tries: Record<string, unknown>[] = [];
  const logBase = { event: "ask", zone: input.req.zone, qChars: input.req.question.length, turns: input.req.history?.length ?? 0, country: input.country };
  try {
    const zones = await input.store.zones();
    const zone = zones.find((z) => z.key === input.req.zone);
    if (!zone) return { ok: false, error: "bad_input", message: "Unknown walk zone." };
    const others = zones.filter((z) => z.key !== zone.key).map((z) => `${z.code} "${z.name}" (key ${z.key})`).join(", ");
    const prompts = { tool: systemPrompt(input.req, zone, others, "tool"), text: systemPrompt(input.req, zone, others, "text") };
    const pkg = await input.store.pkg(zone.key);
    const names = new Map(pkg.sources.map((s) => [s.id.split("-")[0], s.name]));
    for (const listed of chain) {
      // A provider whose URL needs a setting (Cloudflare's account id) counts as unset without it.
      const url = providerUrl(listed, input.keys);
      const p: ProviderConfig = { ...listed, url: url ?? listed.url };
      const key = url === undefined ? undefined : input.keys[p.keyName];
      if (!key) {
        skipped.push({ provider: p.label, why: "no key set" });
        tries.push({ p: p.id, outcome: "no_key" });
        continue;
      }
      if (input.country && p.skipCountries?.includes(input.country)) {
        skipped.push({ provider: p.label, why: "not offered to visitors from this country" });
        tries.push({ p: p.id, outcome: "country" });
        continue;
      }
      const r = rests.get(p.id);
      if (r && r.until > deps.now()) {
        skipped.push({ provider: p.label, why: `resting after a ${r.why}` });
        tries.push({ p: p.id, outcome: "resting", s: Math.round((r.until - deps.now()) / 1000) });
        continue;
      }
      const left = end - deps.now();
      if (left < 1000) {
        tries.push({ p: p.id, outcome: "out_of_time" });
        break;
      }
      const started = deps.now();
      const out = await tryProvider(p, key, input, zones.map((z) => z.key), prompts[p.answerMode ?? "tool"], started + Math.min(perProvider, left), deps);
      const ms = deps.now() - started;
      if (out.ok) {
        tries.push({ p: p.id, outcome: "answered", ms, rounds: out.rounds });
        const facts = uniqueFacts(out.facts);
        deps.log({ ...logBase, ok: true, answeredBy: p.id, model: p.model, kind: out.kind, tools: out.tools, ms: deps.now() - t0, tries });
        return {
          ok: true,
          kind: out.kind,
          text: out.text,
          provider: p.label,
          model: p.model,
          sources: out.kind === "off_topic" ? [] : sourceList(facts, out.declared, names),
          facts: out.kind === "off_topic" ? [] : facts,
          tools: out.tools,
          skipped,
          ms: deps.now() - t0,
        };
      }
      tries.push({ p: p.id, outcome: out.kind, status: out.status, ms, detail: out.kind === "invalid" ? out.detail : undefined });
      skipped.push({ provider: p.label, why: WHY[out.kind] });
      const restS = restSeconds(out.kind, out.retryAfterS);
      if (restS > 0) rests.set(p.id, { until: deps.now() + restS * 1000, why: out.kind === "rate_limit" ? "rate limit" : WHY[out.kind] });
      if (out.kind === "auth" || out.kind === "not_found" || out.kind === "bad_request") {
        // our own mistake (wrong key, retired model, bad request): log what the provider said, never the question
        deps.log({ event: "ask_config_error", provider: p.id, model: p.model, kind: out.kind, status: out.status, detail: out.detail });
      }
      if (out.kind === "bad_request") break; // a bug to fix: falling back would hide it
    }
  } catch (e) {
    deps.log({ ...logBase, event: "ask_error", error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "unavailable", message: MESSAGES.unavailable };
  }
  deps.log({ ...logBase, ok: false, ms: deps.now() - t0, tries });
  return { ok: false, error: "unavailable", message: MESSAGES.unavailable };
}
