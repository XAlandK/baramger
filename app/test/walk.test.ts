import { describe, expect, it } from "vitest";
import type { GridMeta, RouteGrid } from "../src/grid";
import { toLonLat } from "../src/grid";
import { DEFAULT_COST } from "../src/router";
import { computePlan, suggestOrder, type PlanInput } from "../src/plan";
import {
  advanceToNextEvent, bearingDeg, compass, headHomeNow, leaveStop, lookAhead, projectedReturnMin, remainingMin, renameStopInWalk, setWalkLoad, skipNext, startWalk,
  stayLonger, tick, type WalkStop,
} from "../src/walk";
import { DEFAULT_LOAD, timeFactor } from "../src/load";

const W = 200;
const H = 120;

function input(): PlanInput {
  const cellLat = 2 / ((3396190 * Math.PI) / 180);
  const cellLon = cellLat / Math.cos((18.5 * Math.PI) / 180);
  const meta: GridMeta = {
    width: W, height: H, west: 77.3, north: 18.5, east: 77.3 + W * cellLon, south: 18.5 - H * cellLat,
    cellLonDeg: cellLon, cellLatDeg: cellLat, dxM: 2, dyM: 2,
  };
  const grid: RouteGrid = { meta, h: new Float32Array(W * H), slope: new Uint8Array(W * H), rough: new Uint8Array(W * H) };
  return {
    grid, model: DEFAULT_COST, base: { ...toLonLat(meta, 60, 10), antennaM: 3 }, suitAntennaM: 1.8,
    stops: [], evaMin: 360, reserveFraction: 0.3, maxRadioGapMin: 15, startMin: 525,
  };
}

function stops(inp: PlanInput): WalkStop[] {
  const m = inp.grid.meta;
  return [
    { ...toLonLat(m, 60, 100), id: "s1", name: "Stop 1", minutes: 20, tasks: [], povIds: [] },
    { ...toLonLat(m, 60, 190), id: "s2", name: "Stop 2", minutes: 30, tasks: [], povIds: [] },
  ];
}

describe("suggestOrder", () => {
  it("turns a zig-zag visiting order into a short loop", () => {
    const base = { lon: 0, lat: 0 };
    // points on a line at x = 1..6, given in a scrambled order
    const pts = [3, 1, 5, 2, 6, 4].map((x) => ({ lon: x * 0.001, lat: 0.0005, id: String(x) }));
    const order = suggestOrder(base, pts).map((p) => p.id);
    expect(order).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("keeps every stop exactly once", () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ lon: Math.sin(i * 7) * 0.002, lat: Math.cos(i * 3) * 0.002, id: String(i) }));
    const order = suggestOrder({ lon: 0, lat: 0 }, pts);
    expect(order.length).toBe(10);
    expect(new Set(order.map((p) => p.id)).size).toBe(10);
  });
});

describe("walk simulation", () => {
  it("walks to each stop, waits the planned time and comes home on schedule", () => {
    const inp = input();
    const st = stops(inp);
    const plan = computePlan({ ...inp, stops: st });
    expect(plan.ok).toBe(true);
    const s = startWalk(plan.legs, st, inp.startMin);
    expect(projectedReturnMin(s)).toBeCloseTo(plan.totals.finishClockMin, 6);
    const events = [];
    for (let i = 0; i < 4000 && s.phase !== "done"; i++) events.push(...tick(s, 0.1));
    expect(events.map((e) => e.type)).toEqual(["arrived", "left", "arrived", "left", "home"]);
    expect(s.clockMin).toBeCloseTo(plan.totals.finishClockMin, 4);
    expect(s.log.map((l) => l.id)).toEqual(["s1", "s2"]);
    expect(remainingMin(s)).toBe(0);
  });

  it("staying longer moves the projected return later; leaving early moves it earlier", () => {
    const inp = input();
    const st = stops(inp);
    const plan = computePlan({ ...inp, stops: st });
    const s = startWalk(plan.legs, st, inp.startMin);
    while (s.phase === "walking") tick(s, 0.05);
    const planned = projectedReturnMin(s);
    stayLonger(s, 10);
    expect(projectedReturnMin(s)).toBeCloseTo(planned + 10, 6);
    tick(s, 5);
    leaveStop(s);
    expect(s.phase).toBe("walking");
    // the arrival tick can carry a few seconds into the stop, so allow 0.05 min
    expect(projectedReturnMin(s)).toBeCloseTo(planned - 15, 1);
  });

  it("skipping the next stop re-plans from the current position", () => {
    const inp = input();
    const st = stops(inp);
    const plan = computePlan({ ...inp, stops: st });
    const s = startWalk(plan.legs, st, inp.startMin);
    while (s.phase === "walking") tick(s, 0.05); // at stop 1
    const before = projectedReturnMin(s);
    const r = skipNext(s, inp);
    expect(r.ok).toBe(true);
    expect(s.skipped).toEqual(["s2"]);
    expect(s.legs.length).toBe(1);
    expect(s.legs[0].toId).toBe("base");
    expect(projectedReturnMin(s)).toBeLessThan(before - 30);
  });

  it("gives compass bearings", () => {
    expect(compass(bearingDeg({ lon: 0, lat: 0 }, { lon: 0, lat: 1 }))).toBe("N");
    expect(compass(bearingDeg({ lon: 0, lat: 0 }, { lon: 1, lat: 0 }))).toBe("E");
    expect(compass(bearingDeg({ lon: 0, lat: 0 }, { lon: -1, lat: -1 }))).toBe("SW");
  });
});

describe("jump to next event", () => {
  function walk() {
    const inp = input();
    const st = stops(inp);
    const plan = computePlan({ ...inp, stops: st });
    return { s: startWalk(plan.legs, st, inp.startMin), firstArrival: inp.startMin + plan.legs[0].minutes, start: inp.startMin };
  }

  it("does not stop for a warning that is already showing", () => {
    const { s, firstArrival } = walk();
    const events = advanceToNextEvent(s, () => ["sand"]);
    expect(events.map((e) => e.type)).toEqual(["arrived"]);
    // it ran all the way to the first stop (the old version stopped after one 0.1 min step)
    expect(s.log[0].arrivedMin).toBeCloseTo(firstArrival, 6);
    expect(s.clockMin - firstArrival).toBeLessThan(0.1 + 1e-9);
  });

  it("stops when a new warning appears", () => {
    const { s, start } = walk();
    const events = advanceToNextEvent(s, (w) => (w.clockMin >= start + 2 ? ["steep"] : []));
    expect(events).toEqual([]);
    expect(s.phase).toBe("walking");
    expect(s.clockMin).toBeGreaterThanOrEqual(start + 2);
    expect(s.clockMin).toBeLessThan(start + 2.11);
  });

  it("treats a warning that went away and came back as new", () => {
    const { s, start } = walk();
    const keys = (w: { clockMin: number }) => (w.clockMin < start + 1 || w.clockMin >= start + 3 ? ["sand"] : []);
    advanceToNextEvent(s, keys);
    expect(s.clockMin).toBeGreaterThanOrEqual(start + 3);
    expect(s.clockMin).toBeLessThan(start + 3.11);
  });
});

describe("buddy rule from crew size", () => {
  const buddy = (crewSize?: number) => {
    const inp = input();
    const plan = computePlan({ ...inp, stops: stops(inp), crewSize });
    return plan.checks.find((c) => c.id === "buddy")!;
  };

  it("passes for the default crew of 2", () => {
    expect(buddy().status).toBe("ok");
    expect(buddy().detail).toContain("2 astronauts");
  });

  it("passes for a bigger crew and names the number", () => {
    expect(buddy(3).status).toBe("ok");
    expect(buddy(3).detail).toContain("3 astronauts");
  });

  it("fails for a single astronaut, which blocks approval", () => {
    expect(buddy(1).status).toBe("fail");
  });
});

describe("gear load", () => {
  const load = (pickups: number[], start = [15, 15]) => ({ model: DEFAULT_LOAD, startKg: start, pickupKgPerStop: pickups });

  it("makes the leg after a pickup take longer, and only that part", () => {
    const inp = input();
    const st = stops(inp);
    const base = computePlan({ ...inp, stops: st, load: load([0, 0]) });
    const picked = computePlan({ ...inp, stops: st, load: load([2, 0]) }); // 2 kg picked up at stop 1
    expect(picked.legs[0].minutes).toBeCloseTo(base.legs[0].minutes, 9); // before the pickup: same
    expect(picked.legs[1].minutes).toBeGreaterThan(base.legs[1].minutes); // after it: slower
    expect(picked.legs[1].minutes / base.legs[1].minutes).toBeCloseTo(timeFactor(DEFAULT_LOAD, 17), 9);
    expect(picked.legs[1].loadKg).toBe(17);
    expect(picked.totals.totalMin).toBeGreaterThan(base.totals.totalMin);
    expect(picked.legs.map((l) => l.points)).toEqual(base.legs.map((l) => l.points)); // same route path
  });

  it("adds a Carried load check that turns amber and red with weight", () => {
    const inp = input();
    const st = stops(inp);
    const check = (start: number[]) => computePlan({ ...inp, stops: st, load: load([0, 0], start) }).checks.find((c) => c.id === "load")!;
    expect(check([15, 15]).status).toBe("ok");
    expect(check([25, 15]).status).toBe("care");
    expect(check([31, 15]).status).toBe("fail");
  });

  it("re-times the legs ahead during the walk, not the leg being walked", () => {
    const inp = input();
    const st = stops(inp);
    const plan = computePlan({ ...inp, stops: st, load: load([0, 0]) });
    const s = startWalk(plan.legs, st, inp.startMin);
    tick(s, 1); // one minute into the first leg
    const current = s.legs[0].minutes;
    const ahead = s.legs[1].minutes;
    const before = projectedReturnMin(s);
    setWalkLoad(s, 1.1, 20);
    expect(s.legs[0].minutes).toBe(current);
    expect(s.legs[1].minutes).toBeCloseTo(ahead * 1.1, 9);
    expect(projectedReturnMin(s)).toBeGreaterThan(before);
  });
});

describe("review fixes: new legs, heading home from a stop, renamed stops", () => {
  function atFirstStop() {
    const inp = input();
    const st = stops(inp);
    const plan = computePlan({ ...inp, stops: st });
    const s = startWalk(plan.legs, st, inp.startMin);
    while (s.phase === "walking") tick(s, 0.05);
    return { inp, st, plan, s };
  }

  it("looks ahead from the start of the new leg right after leaving a stop", () => {
    const { s } = atFirstStop();
    expect(s.pos.d).toBeGreaterThan(100); // the crew stands at the end of the first leg (180 m)
    leaveStop(s);
    const ahead = lookAhead(s, 60);
    expect(ahead.length).toBeGreaterThan(0);
    // the first 60 m of the new leg, not metres 180-240 of it
    expect(Math.min(...ahead.map((p) => p.d))).toBeLessThan(10);
    expect(Math.max(...ahead.map((p) => p.d))).toBeLessThanOrEqual(60);
  });

  it("heads home from a stop: the crew leaves it, the other stops are skipped", () => {
    const { inp, s } = atFirstStop();
    const r = headHomeNow(s, { ...inp, stops: [] });
    expect(r.ok).toBe(true);
    expect(s.phase).toBe("walking");
    expect(s.queue).toEqual([]);
    expect(s.legs.length).toBe(1);
    expect(s.legs[0].toId).toBe("base");
    expect(s.skipped).toEqual(["s2"]);
    expect(s.events.map((e) => e.kind)).toEqual(["start", "arrived", "left", "skipped", "home-now"]);
    expect(s.log[0].leftMin).toBeCloseTo(s.clockMin, 6);
    for (let i = 0; i < 4000 && s.phase !== "done"; i++) tick(s, 0.1);
    expect(s.phase).toBe("done");
  });

  it("refuses to head home when the walk is over", () => {
    const { inp, s } = atFirstStop();
    for (let i = 0; i < 6000 && s.phase !== "done"; i++) tick(s, 0.1);
    expect(headHomeNow(s, { ...inp, stops: [] }).ok).toBe(false);
  });

  it("gives every stop event its stop, and a renamed stop its new name everywhere", () => {
    const { s } = atFirstStop();
    leaveStop(s);
    while (s.phase === "walking") tick(s, 0.05); // now at Stop 2
    expect(s.events.filter((e) => e.stopId).map((e) => [e.kind, e.stopId])).toEqual([["arrived", "s1"], ["left", "s1"], ["arrived", "s2"]]);
    renameStopInWalk(s, "s1", "Red rock");
    expect(s.events.map((e) => e.text)).toEqual(["Left the habitat", "Arrived at Red rock", "Left Red rock", "Arrived at Stop 2"]);
    expect(s.log.map((l) => l.name)).toEqual(["Red rock", "Stop 2"]);
    renameStopInWalk(s, "s2", "Far end");
    expect(s.queue[0].name).toBe("Far end");
    expect(s.legs[0].fromName).toBe("Far end"); // the leg that leaves the stop
    expect(s.events[3].text).toBe("Arrived at Far end");
  });
});
