// The mission assistant's request and answer, shared by the browser (src/ask.ts) and the Worker.
// Only types and limits live here, so the browser bundle gets no Worker code.

/** Limits agreed with the team (2026-11-15). */
export const LIMITS = {
  questionChars: 300, // longest question
  historyTurns: 2, // earlier questions and answers sent with a new question
  answerWords: 120, // longest answer the model is asked for (the panel never scrolls)
  answerChars: 900, // hard cut of the answer text, in case a model writes more
  perVisitorPerMinute: 5, // Cloudflare rate-limit binding ASK_LIMIT (wrangler.jsonc)
  bodyBytes: 32_000, // largest request body the Worker reads
} as const;

/** A stop of the crew's plan, in walking order (computed in the browser by plan.ts). */
export interface PlanStopInfo {
  id: string;
  name: string;
  lon: number;
  lat: number;
  minutes: number; // time planned at the stop
  arriveClock?: string; // planned arrival, local Mars time "HH:MM"
  fromPackage: boolean; // a known place of the mission package (false = added by the crew)
}

export interface PlanLegInfo {
  from: string; // stop name or "Habitat"
  to: string;
  distanceM: number;
  straightM: number; // straight-line distance between the two ends
  minutes: number;
  maxSlopeDeg: number;
  careM: number; // metres steeper than the comfortable slope (A1)
  ascentM: number;
  descentM: number;
  noRadioMin: number;
  fromLon: number;
  fromLat: number;
  toLon: number;
  toLat: number;
}

export interface RadioGapInfo {
  leg: string; // "Habitat → Cheyava Falls rock"
  startClock: string;
  minutes: number;
  afterM: number; // metres walked on that leg when the radio is lost
  startLon: number;
  startLat: number;
  endLon: number;
  endLat: number;
}

export interface CheckInfo {
  id: string;
  label: string;
  status: "ok" | "care" | "fail";
  detail: string;
}

/** What the browser sends about the crew's current plan. Everything here was computed by Baramger's own code. */
export interface PlanContext {
  startClock: string;
  crewSize: number;
  approved: boolean;
  routeFound: boolean;
  routeError?: string;
  stops: PlanStopInfo[];
  legs: PlanLegInfo[];
  totals?: { distanceM: number; walkMin: number; stopMin: number; totalMin: number; reserveMin: number; reserveFraction: number; finishClock: string; latestFinishClock: string };
  radioGaps: RadioGapInfo[];
  checks: CheckInfo[];
  selectedStopId?: string; // the stop the crew has open ("this stop")
  mapCenter?: { lon: number; lat: number }; // middle of the map view ("here", "this ridge")
}

export interface HistoryTurn {
  q: string;
  a: string;
}

export interface AskRequest {
  zone: string; // "z1" or "z2"
  question: string;
  history?: HistoryTurn[];
  context?: PlanContext;
}

/** One data value a tool read from the mission package or the plan. Shown under the answer. */
export interface Fact {
  label: string;
  value: string;
  ref: string; // a source ID (R1, R2, R5, S1, S4…), a starting value (A1…A22) or PLAN
}

export interface SourceRef {
  id: string; // short ID: R1, S4, PLAN
  name: string;
}

export interface Skip {
  provider: string;
  why: string; // "no key", "resting after a rate limit", "rate limit", "timeout", "server error", "answer failed our checks"…
}

export interface AskAnswer {
  ok: true;
  kind: "answer" | "cannot_tell" | "off_topic";
  text: string; // AI-written: always shown labelled as an AI explanation, never stored as data
  provider: string; // "Gemini (Google)"
  model: string;
  sources: SourceRef[];
  facts: Fact[];
  tools: string[]; // the tools the model called, in order
  skipped: Skip[]; // providers tried or passed over before this one answered
  ms: number;
}

export type AskErrorCode = "unavailable" | "rate_limited" | "bad_input" | "forbidden" | "offline";

export interface AskError {
  ok: false;
  error: AskErrorCode;
  message: string;
}

export type AskResponse = AskAnswer | AskError;

/** The texts the crew sees when there is no answer (agreed wording). */
export const MESSAGES = {
  offline: "The assistant needs an internet connection.",
  unavailable: "The assistant isn't available right now. Try again in a minute.",
  rateLimited: "You asked several questions in a short time. Wait a minute, then ask again.",
  cannotTell: "I can't tell from the mission data.",
  offTopic: "I can only help with this walk, this walk zone and its mission data.",
} as const;
