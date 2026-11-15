// The AI providers and one small chat-completions client for all of them.
//
// PROVIDER_CHAIN is the fallback order. Change the order (or a model) here only; the chain logic
// in chain.ts reads this list and has no provider names in it. A provider whose key is not set
// is skipped. Every model is from a non-Chinese developer (rule C1); see docs/PLAN.md, "AI mission
// assistant", for the checks behind each choice.

export type KeyName = "GEMINI_API_KEY" | "GROQ_API_KEY" | "OPENROUTER_API_KEY" | "MISTRAL_API_KEY" | "CEREBRAS_API_KEY";

export interface ProviderConfig {
  id: string;
  label: string; // shown under each answer: "Written by <label> · <model>"
  keyName: KeyName;
  url: string; // the full chat-completions URL
  model: string;
  why: string; // why this model (recorded for the team)
  maxTokensField: "max_tokens" | "max_completion_tokens";
  maxTokens: number; // per call; includes hidden reasoning tokens on the gpt-oss models
  /** tool_choice value that makes the model call some tool. */
  requiredChoice: unknown;
  /** Whether tool_choice can name one tool ({type:"function",function:{name}}). */
  namedChoice: boolean;
  /** Whether tool results carry the tool's name (Groq and Mistral examples send it). */
  toolMessageName: boolean;
  /** Fixed extra request fields: reasoning settings, OpenRouter's host allow-list. */
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Visitor countries (ISO codes from Cloudflare) this provider must not serve; the chain skips it for them. */
  skipCountries?: string[];
  /**
   * How the model hands in its answer: "tool" = the final_answer tool call (default); "text" = plain text
   * ending with a "Sources:" line. gpt-oss on Groq loses a final_answer call (empty reply, tested 2026-11-15).
   */
  answerMode?: "tool" | "text";
}

export const PROVIDER_CHAIN: ProviderConfig[] = [
  {
    id: "gemini",
    label: "Gemini (Google)",
    keyName: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.5-flash-lite",
    why: "Google's advice for new projects (gemini-2.5-flash is redirected to it on 2026-12-01); fastest current model, function calling on the free tier; Google (US). Thinking set to low: Google warns that minimal thinking can end tool use too early.",
    maxTokensField: "max_tokens",
    maxTokens: 2048, // thinking and answer together
    requiredChoice: "required",
    namedChoice: false, // not documented for the Gemini compatibility layer
    toolMessageName: true,
    extra: { extra_body: { google: { thinking_config: { thinking_level: "low" } } } },
    // Free-tier terms: no API clients for users in the EEA, Switzerland or the UK, and only in Gemini's
    // available regions. The chain skips Gemini for visitors from these places (Cloudflare's country code).
    skipCountries: [
      // EEA (EU 27 + Iceland, Liechtenstein, Norway), Switzerland, United Kingdom
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
      "IS", "LI", "NO", "CH", "GB",
      // EU outermost regions with their own codes
      "GP", "MQ", "GF", "RE", "YT", "MF",
      // not in Gemini's list of available regions (read 2026-11-15); T1 = Tor (place unknown)
      "AF", "BY", "CN", "CU", "HK", "IR", "KP", "MM", "MO", "RU", "SY", "T1",
    ],
  },
  {
    id: "groq",
    label: "Groq",
    keyName: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-120b",
    why: "The only non-Chinese model with tool use left on Groq's free tier (Llama 3.3 70B retired 2026-08-16); OpenAI (US), Apache 2.0.",
    maxTokensField: "max_completion_tokens",
    maxTokens: 2048,
    requiredChoice: "required",
    namedChoice: true,
    toolMessageName: true,
    answerMode: "text", // tested 2026-11-15: after a tool result it answers "" instead of calling final_answer, even with tool_choice "required"
    extra: { reasoning_effort: "low", include_reasoning: false, parallel_tool_calls: false },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    keyName: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-oss-120b",
    why: "OpenAI (US), Apache 2.0. Pinned, with an allow-list of three US hosts (all zero-data-retention, all support tool_choice \"required\") and OpenRouter's own fallbacks off. No free endpoint: needs credits (about $0.0002 a question).",
    maxTokensField: "max_tokens",
    maxTokens: 2048,
    requiredChoice: "required",
    namedChoice: true,
    toolMessageName: false,
    extra: {
      // C1: only these hosts may serve the request; never SiliconFlow, decentralised networks or any other host.
      // Groq and Cerebras are left out on purpose: they are already direct providers in this chain.
      provider: { only: ["deepinfra", "coreweave", "together"], allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true },
      reasoning: { effort: "low", exclude: true }, // gpt-oss's reasoning is not for end users
    },
    // No HTTP-Referer / title headers: they would create a public app page on openrouter.ai.
  },
  {
    id: "mistral",
    label: "Mistral AI",
    keyName: "MISTRAL_API_KEY",
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "ministral-14b-2512",
    why: "Ministral 14B (Dec 2025), pinned to the dated ID: function calling, Apache 2.0; Mistral AI (France). Tested 2026-11-15: the team's free key allows 0 requests a minute for Mistral Small and 2 a minute for Ministral, so only about one simple question a minute. The same API also hosts GLM and DeepSeek models, which are never called.",
    maxTokensField: "max_tokens",
    maxTokens: 1024,
    requiredChoice: "any",
    namedChoice: true,
    toolMessageName: true,
    // no reasoning setting: Ministral refuses it, and Mistral rejects unknown request fields
    // free key (tested 2026-11-15): 2 requests and 40,000 tokens a minute for each Ministral model, 0 for Mistral Small
  },
  {
    id: "cerebras",
    label: "Cerebras",
    keyName: "CEREBRAS_API_KEY",
    url: "https://api.cerebras.ai/v1/chat/completions",
    model: "gpt-oss-120b",
    why: "The only non-Chinese model on Cerebras's shared endpoints; OpenAI (US), Apache 2.0.",
    maxTokensField: "max_completion_tokens",
    maxTokens: 1536, // counted against the token quota before the call runs: keep it modest
    requiredChoice: "required",
    namedChoice: true,
    toolMessageName: false,
    extra: { reasoning_effort: "low", reasoning_format: "hidden", parallel_tool_calls: false },
  },
];

// ------------------------------------------------------------------ the client
export interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
  [more: string]: unknown; // e.g. Gemini's extra_content (thought signatures): sent back unchanged
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

/** Why a call gave no usable reply. Everything but "bad_request" moves the chain to the next provider. */
export type FailKind =
  | "rate_limit" // 429
  | "quota" // 402: credits used up
  | "server" // 5xx, 498 (Groq: capacity full)
  | "timeout"
  | "network"
  | "auth" // 401/403: key refused
  | "not_found" // 404: model or route gone
  | "region" // the provider refuses callers from this place
  | "model_error" // the provider says the model wrote a broken tool call (Groq: tool_use_failed)
  | "bad_response" // 200 without a usable message
  | "bad_request"; // 400/422 caused by our own request: a bug to fix, not a reason to fall back

export type CallResult =
  | { ok: true; message: AssistantMessage }
  | { ok: false; kind: FailKind; status?: number; retryAfterS?: number; detail: string };

/** Seconds to wait from a 429: Retry-After (seconds or date), retry-after-ms, or Gemini's RetryInfo in the body. */
export function retryAfterSeconds(headers: Headers, body: string, nowMs: number): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms) / 1000;
  const ra = headers.get("retry-after");
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) return Number(ra);
    const t = Date.parse(ra);
    if (Number.isFinite(t)) return Math.max(0, (t - nowMs) / 1000);
  }
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body) ?? /retry in (\d+(?:\.\d+)?)\s*s/i.exec(body);
  return m ? Number(m[1]) : undefined;
}

function classify400(body: string): FailKind {
  if (/tool_use_failed|failed_generation|failed to call a function|failed to generate|tool call validation failed|output_parse_failed/i.test(body)) return "model_error";
  if (/location is not supported|not (?:available|supported) in your (?:country|region|location)|unsupported_country|region is not supported/i.test(body)) return "region";
  return "bad_request";
}

export interface CallOptions {
  fetch: typeof fetch;
  signal: AbortSignal;
  now: () => number;
}

export async function callChat(p: ProviderConfig, key: string, body: Record<string, unknown>, o: CallOptions): Promise<CallResult> {
  let res: Response;
  try {
    res = await o.fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...p.headers },
      body: JSON.stringify(body),
      signal: o.signal,
    });
  } catch (e) {
    if (o.signal.aborted) return { ok: false, kind: "timeout", detail: "no reply in time" };
    return { ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (o.signal.aborted) return { ok: false, kind: "timeout", detail: "no reply in time" };
    return { ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) };
  }
  const s = res.status;
  const detail = text.slice(0, 400);
  if (s === 429) {
    let wait = retryAfterSeconds(res.headers, text, o.now());
    // Gemini's daily quota can say "retry in 1s"; a per-day limit needs a long rest
    if (/PerDay/i.test(text)) wait = Math.max(wait ?? 0, 3600);
    return { ok: false, kind: "rate_limit", status: s, retryAfterS: wait, detail };
  }
  if (s === 402) return { ok: false, kind: "quota", status: s, detail };
  if (s >= 500 || s === 498) return { ok: false, kind: "server", status: s, detail };
  if (s === 401 || s === 403) return { ok: false, kind: /location|region|country/i.test(text) ? "region" : "auth", status: s, detail };
  if (s === 404) return { ok: false, kind: "not_found", status: s, detail };
  if (s === 400 || s === 422) return { ok: false, kind: classify400(text), status: s, detail };
  if (s < 200 || s >= 300) return { ok: false, kind: "server", status: s, detail };
  let json: { choices?: { message?: AssistantMessage }[]; error?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, kind: "bad_response", status: s, detail: "reply is not JSON" };
  }
  // OpenRouter can answer 200 with an error from the host it used
  if (json.error) return { ok: false, kind: classify400(JSON.stringify(json.error)) === "model_error" ? "model_error" : "server", status: s, detail: JSON.stringify(json.error).slice(0, 400) };
  const message = json.choices?.[0]?.message;
  if (!message || typeof message !== "object") return { ok: false, kind: "bad_response", status: s, detail: "reply has no message" };
  return { ok: true, message: { role: "assistant", content: textOf(message.content), tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined } };
}

/** Message text: a string, or (Mistral with reasoning) a list of chunks of which only "text" ones count. */
function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const t = content.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text").map((c) => String((c as { text?: unknown }).text ?? "")).join("");
    return t || null;
  }
  return null;
}

/** The request body for one call: the same OpenAI-style shape for every provider, plus its quirks. */
export function requestBody(p: ProviderConfig, messages: unknown[], tools: unknown[], toolChoice: unknown): Record<string, unknown> {
  return {
    model: p.model,
    messages,
    tools,
    tool_choice: toolChoice,
    temperature: 0.2,
    [p.maxTokensField]: p.maxTokens,
    ...p.extra,
  };
}
