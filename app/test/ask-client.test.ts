// The browser side of the assistant: the plan it sends, and the agreed messages when there is no answer.
import { describe, expect, it } from "vitest";
import { MESSAGES, askAssistant, planContext } from "../src/ask";
import type { PlanResult } from "../src/plan";

const sample = (lon: number, lat: number, d: number, t: number, radio: boolean) => ({ lon, lat, h: -2350, slope: 3, d, t, radio });

/** A two-leg plan (habitat → stop A → habitat) with one radio gap on the first leg, from 4 to 6 minutes in. */
function plan(): PlanResult {
  const leg1 = {
    fromId: "base", toId: "a", fromName: "Habitat", toName: "Stop A",
    points: [{ lon: 77.29, lat: 18.49 }, { lon: 77.30, lat: 18.49 }],
    samples: [sample(77.29, 18.49, 0, 0, true), sample(77.292, 18.49, 200, 4, false), sample(77.294, 18.49, 300, 6, false), sample(77.296, 18.49, 400, 8, true), sample(77.30, 18.49, 1000, 20, true)],
    distanceM: 1000, ascentM: 5, descentM: 2, maxSlope: 12, careM: 0, minutes: 20, noRadioMin: 4,
  };
  const leg2 = { ...leg1, fromId: "a", toId: "base", fromName: "Stop A", toName: "Habitat", points: [...leg1.points].reverse(), samples: leg1.samples.map((s) => ({ ...s, radio: true })), noRadioMin: 0 };
  return {
    ok: true,
    legs: [leg1, leg2],
    totals: { distanceM: 2000, walkMin: 40, stopMin: 30, totalMin: 70, reserveMin: 290, reserveFraction: 0.806, maxSlope: 12, careM: 0, ascentM: 10, descentM: 4, finishClockMin: 9 * 60 + 55, latestFinishClockMin: 13 * 60 + 57, leaveLastStopByMin: 13 * 60 + 37 },
    radioGaps: [{ legIndex: 0, minutes: 4, startClockMin: 8 * 60 + 45 + 4 }],
    checks: [{ id: "radio", label: "Radio contact with the habitat", status: "care", detail: "1 short stretch with no radio." }],
  };
}

const input = () => ({
  plan: plan(), planError: "", startClock: "08:45", crewSize: 2, approved: false, selectedId: "a", mapCenter: { lon: 77.295, lat: 18.49 },
  stops: [{ id: "a", name: "Stop A", lon: 77.30, lat: 18.49, minutes: 30, custom: true }],
});

describe("planContext", () => {
  it("sends the stops with their planned arrival, the legs and the checks as Baramger computed them", () => {
    const c = planContext(input());
    expect(c.routeFound).toBe(true);
    expect(c.stops).toEqual([{ id: "a", name: "Stop A", lon: 77.30, lat: 18.49, minutes: 30, arriveClock: "09:05", fromPackage: false }]);
    expect(c.legs[0]).toMatchObject({ from: "Habitat", to: "Stop A", distanceM: 1000, maxSlopeDeg: 12, noRadioMin: 4 });
    // 0.01° of longitude at 18.49° N on the Mars 2000 sphere: 592.7 m × cos(18.49°) ≈ 562 m
    expect(c.legs[0].straightM).toBeGreaterThan(555);
    expect(c.legs[0].straightM).toBeLessThan(570);
    expect(c.checks[0]).toMatchObject({ id: "radio", status: "care" });
    expect(c.totals).toMatchObject({ finishClock: "09:55", reserveFraction: 0.81 });
    expect(c.selectedStopId).toBe("a");
  });

  it("says where each radio gap starts and ends, and how far into the leg", () => {
    const g = planContext(input()).radioGaps[0];
    expect(g).toMatchObject({ leg: "Habitat → Stop A", startClock: "08:49", minutes: 4, afterM: 200, startLon: 77.292, endLon: 77.294 });
  });

  it("without a route it sends the stops and the reason", () => {
    const c = planContext({ ...input(), plan: null, planError: "No safe way to Stop A" });
    expect(c.routeFound).toBe(false);
    expect(c.legs).toEqual([]);
    expect(c.routeError).toBe("No safe way to Stop A");
    expect(c.stops[0].arriveClock).toBeUndefined();
  });

  it("never sends crew notes (the stops carry no note field)", () => {
    expect(JSON.stringify(planContext(input()))).not.toMatch(/note/i);
  });
});

describe("askAssistant", () => {
  const req = { zone: "z2", question: "Where do we lose radio contact?" };

  it("offline: the agreed message, without trying the network", async () => {
    let called = false;
    const r = await askAssistant(req, { online: false, fetch: (async () => { called = true; return new Response(); }) as typeof fetch });
    expect(r).toEqual({ ok: false, error: "offline", message: MESSAGES.offline });
    expect(called).toBe(false);
  });

  it("a network error: the crew is told it needs an internet connection", async () => {
    const r = await askAssistant(req, { online: true, fetch: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch });
    expect(r).toMatchObject({ ok: false, message: MESSAGES.offline });
  });

  it("every provider failed (503 from the Worker): 'isn't available right now'", async () => {
    const r = await askAssistant(req, { online: true, fetch: (async () => new Response(JSON.stringify({ ok: false, error: "unavailable", message: MESSAGES.unavailable }), { status: 503 })) as typeof fetch });
    expect(r).toMatchObject({ ok: false, message: MESSAGES.unavailable });
  });

  it("a site without the Worker (an HTML 404 page): 'isn't available right now'", async () => {
    const r = await askAssistant(req, { online: true, fetch: (async () => new Response("<html>Not found</html>", { status: 404 })) as typeof fetch });
    expect(r).toMatchObject({ ok: false, message: MESSAGES.unavailable });
  });

  it("an answer is passed through, and the request carries the zone, question and plan", async () => {
    let sent: { zone: string; question: string } | undefined;
    const answer = { ok: true, kind: "answer", text: "Two short gaps.", provider: "Groq", model: "openai/gpt-oss-120b", sources: [], facts: [], tools: ["get_plan"], skipped: [], ms: 1200 };
    const r = await askAssistant(req, {
      online: true,
      url: "https://worker.example/api/chat",
      fetch: (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify(answer)); }) as typeof fetch,
    });
    expect(r).toEqual(answer);
    expect(sent).toMatchObject(req);
  });
});
