// The provider fallback chain, with every provider mocked: no real keys, no network.
import { beforeEach, describe, expect, it } from "vitest";
import { MESSAGES, type AskAnswer, type AskRequest, type AskResponse } from "../worker/api";
import { answerQuestion, resetRests, type ChainDeps } from "../worker/chain";
import { PROVIDER_CHAIN, retryAfterSeconds } from "../worker/providers";
import { diskStore } from "./disk-store";

const store = diskStore();
const ALL_KEYS = { GEMINI_API_KEY: "g", GROQ_API_KEY: "q", OPENROUTER_API_KEY: "o", MISTRAL_API_KEY: "m", CEREBRAS_API_KEY: "c" };
const HOST: Record<string, string> = { "generativelanguage.googleapis.com": "gemini", "api.groq.com": "groq", "openrouter.ai": "openrouter", "api.mistral.ai": "mistral", "api.cerebras.ai": "cerebras" };

type Body = { model: string; messages: { role: string; content?: string; tool_calls?: unknown[]; name?: string; tool_call_id?: string }[]; tool_choice: unknown; [k: string]: unknown };
type Handler = (body: Body, signal: AbortSignal) => Promise<Response> | Response;

const json = (x: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json", ...headers } });
let n = 0;
const call = (name: string, args: unknown, extra: Record<string, unknown> = {}) => ({ id: `call${++n}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) }, ...extra });
const toolReply = (...calls: unknown[]) => json({ choices: [{ message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }] });
const textReply = (content: string) => json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });

/** A model that looks up the 14:00 temperature, then answers. */
function goodModel(answer = "At 14:00 the air is about −49 °C (median of past sols, not a forecast).", sources = ["S4"]): Handler {
  return (body) => {
    const looked = body.messages.some((m) => m.role === "tool");
    return looked
      ? toolReply(call("final_answer", { answer, sources, cannot_tell: false, off_topic: false }))
      : toolReply(call("get_conditions", { zone: "z2", local_time: "14:00" }));
  };
}

const hang: Handler = (_b, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function setup(handlers: Partial<Record<string, Handler>>, clock = { t: 1_000_000 }) {
  const calls: { provider: string; body: Body }[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: ChainDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const provider = HOST[new URL(url).host];
      const body = JSON.parse(String(init.body)) as Body;
      calls.push({ provider, body });
      const h = handlers[provider];
      if (!h) return json({ error: { message: "server down" } }, 503);
      return h(body, init.signal!);
    }) as typeof fetch,
    now: () => clock.t,
    log: (e) => logs.push(e),
    perProviderMs: 200,
    totalMs: 2000,
  };
  return { deps, calls, logs, clock, providersCalled: () => [...new Set(calls.map((c) => c.provider))] };
}

const Q: AskRequest = { zone: "z2", question: "What's the temperature at 14:00?" };
const ask = (deps: ChainDeps, req: AskRequest = Q, keys: Record<string, string | undefined> = ALL_KEYS, country?: string) => answerQuestion({ req, keys, store, country }, deps);
const answered = (r: AskResponse) => {
  if (!r.ok) throw new Error(`expected an answer, got ${r.error}`);
  return r as AskAnswer;
};

beforeEach(() => resetRests());

describe("the chain config", () => {
  it("keeps the agreed order and only non-Chinese models", () => {
    expect(PROVIDER_CHAIN.map((p) => p.id)).toEqual(["gemini", "groq", "openrouter", "mistral", "cerebras"]);
    for (const p of PROVIDER_CHAIN) expect(p.model).not.toMatch(/qwen|deepseek|kimi|moonshot|glm|zai|minimax|yi-|ernie|hunyuan|doubao/i);
  });

  it("OpenRouter is pinned to an allow-list of hosts with its own fallbacks off", () => {
    const or = PROVIDER_CHAIN.find((p) => p.id === "openrouter")!;
    expect(or.extra?.provider).toMatchObject({ only: ["deepinfra", "coreweave", "together"], allow_fallbacks: false });
  });
});

describe("one provider answers", () => {
  it("Gemini answers with the tool's sources and values, labelled with provider and model", async () => {
    const t = setup({ gemini: goodModel() });
    const r = answered(await ask(t.deps));
    expect(r.provider).toBe("Gemini (Google)");
    expect(r.model).toBe(PROVIDER_CHAIN[0].model);
    expect(r.kind).toBe("answer");
    expect(r.tools).toEqual(["get_conditions"]);
    expect(r.sources.map((s) => s.id)).toEqual(["S4"]);
    expect(r.sources[0].name).toMatch(/MEDA/);
    expect(r.facts[0]).toMatchObject({ ref: "S4", value: "−49 °C" });
    expect(t.providersCalled()).toEqual(["gemini"]);
    expect(t.logs.at(-1)).toMatchObject({ event: "ask", ok: true, answeredBy: "gemini" });
    expect(JSON.stringify(t.logs)).not.toContain("temperature at 14:00"); // the question is never logged
  });

  it("sends Gemini's tool calls back unchanged (thought signatures) and the tool result with its id", async () => {
    let second: Body | undefined;
    const t = setup({
      gemini: (body) => {
        if (body.messages.some((m) => m.role === "tool")) {
          second = body;
          return toolReply(call("final_answer", { answer: "−49 °C.", sources: ["S4"], cannot_tell: false, off_topic: false }));
        }
        return toolReply(call("get_conditions", { local_time: "14:00" }, { extra_content: { google: { thought_signature: "sig123" } } }));
      },
    });
    answered(await ask(t.deps));
    const asst = second!.messages.find((m) => m.role === "assistant")!;
    expect(JSON.stringify(asst.tool_calls)).toContain("sig123");
    const tool = second!.messages.find((m) => m.role === "tool")!;
    expect(tool.tool_call_id).toBe((asst.tool_calls![0] as { id: string }).id);
  });

  it("sends each provider its own quirks", async () => {
    const t = setup({});
    await ask(t.deps);
    const first = (id: string) => t.calls.find((c) => c.provider === id)!.body;
    expect(first("openrouter").provider).toMatchObject({ only: ["deepinfra", "coreweave", "together"], allow_fallbacks: false });
    expect(first("mistral").tool_choice).toBe("any");
    expect(first("groq").tool_choice).toBe("required");
    expect(first("groq").max_completion_tokens).toBeGreaterThan(0);
    expect(first("mistral").max_tokens).toBeGreaterThan(0);
  });

  it("the history comes before the new question", async () => {
    const t = setup({ gemini: goodModel() });
    await ask(t.deps, { ...Q, history: [{ q: "Where is the habitat?", a: "At 18.49° N." }] });
    expect(t.calls[0].body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("fallback", () => {
  it("a 429 moves to the next provider, and the first one rests for its Retry-After time", async () => {
    const t = setup({ gemini: () => json({ error: "busy" }, 429, { "retry-after": "30" }), groq: goodModel() });
    const r = answered(await ask(t.deps));
    expect(r.provider).toBe("Groq");
    expect(r.skipped).toEqual([{ provider: "Gemini (Google)", why: "busy (rate limit)" }]);

    // the next question within the rest skips Gemini without calling it
    t.calls.length = 0;
    t.clock.t += 20_000;
    const r2 = answered(await ask(t.deps));
    expect(r2.provider).toBe("Groq");
    expect(r2.skipped[0].why).toBe("resting after a rate limit");
    expect(t.providersCalled()).toEqual(["groq"]);

    // after the rest Gemini is asked again
    t.calls.length = 0;
    t.clock.t += 11_000;
    await ask(t.deps);
    expect(t.providersCalled()[0]).toBe("gemini");
  });

  it("a 429 without Retry-After rests the provider about 60 s; Gemini's retryDelay is read from the body", async () => {
    expect(retryAfterSeconds(new Headers(), '[{"error":{"details":[{"retryDelay":"34s"}]}}]', 0)).toBe(34);
    const t = setup({ gemini: () => json({ error: "busy" }, 429), groq: goodModel() });
    await ask(t.deps);
    t.calls.length = 0;
    t.clock.t += 59_000;
    await ask(t.deps);
    expect(t.providersCalled()).toEqual(["groq"]);
    t.calls.length = 0;
    t.clock.t += 2_000;
    await ask(t.deps);
    expect(t.providersCalled()[0]).toBe("gemini");
  });

  it("a timeout moves on", async () => {
    const t = setup({ gemini: hang, groq: goodModel() });
    const r = answered(await ask(t.deps));
    expect(r.provider).toBe("Groq");
    expect(r.skipped).toEqual([{ provider: "Gemini (Google)", why: "too slow (timeout)" }]);
  });

  it("a provider without a key is skipped, with any subset of keys", async () => {
    const t = setup({ mistral: goodModel() });
    const r = answered(await ask(t.deps, Q, { MISTRAL_API_KEY: "m" }));
    expect(r.provider).toBe("Mistral AI");
    expect(r.skipped.map((s) => s.why)).toEqual(["no key set", "no key set", "no key set"]);
    expect(t.providersCalled()).toEqual(["mistral"]);
  });

  it("server errors, network errors and broken replies move on", async () => {
    const t = setup({
      gemini: () => json({ error: "oops" }, 500),
      groq: () => { throw new TypeError("network down"); },
      openrouter: () => new Response("<html>", { status: 200 }),
      mistral: goodModel(),
    });
    const r = answered(await ask(t.deps));
    expect(r.provider).toBe("Mistral AI");
    expect(r.skipped.map((s) => s.why)).toEqual(["server error", "could not be reached", "gave an unusable reply"]);
  });

  it("when every provider fails the crew gets the agreed message", async () => {
    const t = setup({});
    const r = await ask(t.deps);
    expect(r).toEqual({ ok: false, error: "unavailable", message: MESSAGES.unavailable });
    expect(t.providersCalled()).toEqual(["gemini", "groq", "openrouter", "mistral", "cerebras"]);
    expect(t.logs.at(-1)).toMatchObject({ ok: false });
  });

  it("with no keys at all nothing is called", async () => {
    const t = setup({});
    const r = await ask(t.deps, Q, {});
    expect(r.ok).toBe(false);
    expect(t.calls).toHaveLength(0);
  });

  it("a 400 caused by our own request stops the chain and is logged (no fallback)", async () => {
    const t = setup({ gemini: () => json([{ error: { code: 400, message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT" } }], 400), groq: goodModel() });
    const r = await ask(t.deps);
    expect(r.ok).toBe(false);
    expect(t.providersCalled()).toEqual(["gemini"]);
    expect(t.logs.find((l) => l.event === "ask_config_error")).toMatchObject({ provider: "gemini", kind: "bad_request", status: 400 });
  });

  it("but a 400 that says the model wrote a broken tool call (Groq) or a refused location (Gemini) moves on", async () => {
    const t = setup({
      gemini: () => json([{ error: { code: 400, message: "User location is not supported for the API use.", status: "FAILED_PRECONDITION" } }], 400),
      groq: () => json({ error: { message: "Failed to call a function. Please adjust your prompt.", type: "invalid_request_error", code: "tool_use_failed" } }, 400),
      openrouter: goodModel(),
    });
    const r = answered(await ask(t.deps));
    expect(r.provider).toBe("OpenRouter");
    expect(r.skipped.map((s) => s.why)).toEqual(["not available from this place", "wrote a broken tool call"]);
  });

  it("a refused key moves on and rests the provider", async () => {
    const t = setup({ gemini: () => json({ error: "bad key" }, 401), groq: goodModel() });
    answered(await ask(t.deps));
    t.calls.length = 0;
    await ask(t.deps);
    expect(t.providersCalled()).toEqual(["groq"]);
  });

  it("Gemini is skipped for visitors from the EEA, the UK and Switzerland (free-tier terms)", async () => {
    const t = setup({ gemini: goodModel(), groq: goodModel() });
    const r = answered(await ask(t.deps, Q, ALL_KEYS, "DE"));
    expect(r.provider).toBe("Groq");
    expect(r.skipped[0].why).toBe("not offered to visitors from this country");
    const r2 = answered(await ask(t.deps, Q, ALL_KEYS, "IQ"));
    expect(r2.provider).toBe("Gemini (Google)");
  });
});

describe("answers that fail our checks move on", () => {
  it("broken tool-call JSON", async () => {
    const t = setup({ gemini: () => toolReply(call("get_conditions", "{local_time: 14")), groq: goodModel() });
    const r = answered(await ask(t.deps));
    expect(r.provider).toBe("Groq");
    expect(r.skipped[0].why).toBe("answer failed our checks");
  });

  it("an answer with no tool call at all", async () => {
    const t = setup({ gemini: () => textReply("It is about −50 °C, as usual on Mars."), groq: goodModel() });
    expect(answered(await ask(t.deps)).provider).toBe("Groq");
  });

  it("a final answer without looking anything up", async () => {
    const t = setup({ gemini: () => toolReply(call("final_answer", { answer: "−50 °C.", sources: ["S4"], cannot_tell: false, off_topic: false })), groq: goodModel() });
    expect(answered(await ask(t.deps)).provider).toBe("Groq");
  });

  it("a call to a tool that does not exist", async () => {
    const t = setup({ gemini: () => toolReply(call("web_search", { q: "mars weather" })), groq: goodModel() });
    expect(answered(await ask(t.deps)).provider).toBe("Groq");
  });

  it("a model that never finishes is cut after five rounds", async () => {
    const t = setup({ gemini: () => toolReply(call("get_site", {})), groq: goodModel() });
    const r = answered(await ask(t.deps));
    expect(r.provider).toBe("Groq");
    expect(t.calls.filter((c) => c.provider === "gemini")).toHaveLength(5);
  });
});

describe("plain-text answers (answerMode \"text\", used for Groq)", () => {
  const groqOnly = { GROQ_API_KEY: "q" };
  it("Groq gets no final_answer tool, must look something up first, then answers in text with a Sources line", async () => {
    const t = setup({
      groq: (body) => body.messages.some((m) => m.role === "tool")
        ? textReply("At 14:00 the air is about −49 °C. Sources: S4, PKG.")
        : toolReply(call("get_conditions", { local_time: "14:00" })),
    });
    const r = answered(await ask(t.deps, Q, groqOnly));
    expect(r.provider).toBe("Groq");
    expect(r.text).toBe("At 14:00 the air is about −49 °C.");
    expect(r.sources.map((s) => s.id)).toEqual(["S4", "PKG"]);
    const [first, second] = t.calls.map((c) => c.body);
    expect((first.tools as { function: { name: string } }[]).map((x) => x.function.name)).not.toContain("final_answer");
    expect(first.tool_choice).toBe("required");
    expect(second.tool_choice).toBe("auto");
  });

  it("a Sources line of its own, and 'I can't tell' and 'OFF TOPIC' in text", async () => {
    let reply = "I can't tell from the mission data. The package has no radiation dose.\nSources: S4";
    const t = setup({ groq: (body) => body.messages.some((m) => m.role === "tool") ? textReply(reply) : toolReply(call("get_conditions", {})) });
    const r = answered(await ask(t.deps, Q, groqOnly));
    expect(r.kind).toBe("cannot_tell");
    expect(r.text).toBe(`${MESSAGES.cannotTell} The package has no radiation dose.`);
    reply = "OFF TOPIC";
    const r2 = answered(await ask(t.deps, Q, groqOnly));
    expect(r2.kind).toBe("off_topic");
    expect(r2.text).toBe(MESSAGES.offTopic);
  });

  it("an empty text reply (what Groq did with final_answer) moves on", async () => {
    const t = setup({ groq: (body) => body.messages.some((m) => m.role === "tool") ? textReply("") : toolReply(call("get_conditions", {})), openrouter: goodModel() });
    const r = answered(await ask(t.deps, Q, { GROQ_API_KEY: "q", OPENROUTER_API_KEY: "o" }));
    expect(r.provider).toBe("OpenRouter");
    expect(r.skipped).toEqual([{ provider: "Gemini (Google)", why: "no key set" }, { provider: "Groq", why: "answer failed our checks" }]);
  });

  it("the last round turns tools off, so the model must answer", async () => {
    const t = setup({ groq: (body) => body.tool_choice === "none" ? textReply("The air is −49 °C. Sources: S4") : toolReply(call("get_site", {})) });
    const r = answered(await ask(t.deps, Q, groqOnly));
    expect(r.text).toBe("The air is −49 °C.");
    expect(t.calls).toHaveLength(5);
  });
});

describe("kinds of answers", () => {
  it("cannot tell: always starts with the agreed sentence", async () => {
    const t = setup({
      gemini: (body) => body.messages.some((m) => m.role === "tool")
        ? toolReply(call("final_answer", { answer: "I cannot tell the radiation dose. The package has weather and sun activity only.", sources: ["S4"], cannot_tell: true, off_topic: false }))
        : toolReply(call("get_conditions", {})),
    });
    const r = answered(await ask(t.deps, { ...Q, question: "What radiation dose will we get at stop 2?" }));
    expect(r.kind).toBe("cannot_tell");
    expect(r.text).toBe(`${MESSAGES.cannotTell} The package has weather and sun activity only.`);
  });

  it("off topic: the fixed polite decline, no data needed", async () => {
    const t = setup({ gemini: () => toolReply(call("final_answer", { answer: "Paris is the capital of France.", sources: [], cannot_tell: false, off_topic: true })) });
    const r = answered(await ask(t.deps, { ...Q, question: "What is the capital of France?" }));
    expect(r.kind).toBe("off_topic");
    expect(r.text).toBe(MESSAGES.offTopic);
    expect(r.facts).toEqual([]);
  });

  it("sources the model names but never read are dropped", async () => {
    const t = setup({ gemini: goodModel("−49 °C.", ["S4", "R5", "S99"]) });
    const r = answered(await ask(t.deps));
    expect(r.sources.map((s) => s.id)).toEqual(["S4"]);
  });

  it("a long answer is cut to fit the panel; markdown is removed", async () => {
    const long = `**Air** ${"The air is cold here. ".repeat(80)}`;
    const t = setup({ gemini: goodModel(long) });
    const r = answered(await ask(t.deps));
    expect(r.text.length).toBeLessThanOrEqual(905);
    expect(r.text).not.toContain("**");
  });
});
