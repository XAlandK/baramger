import { describe, expect, it } from "vitest";
import type { GridMeta, RouteGrid } from "../src/grid";
import { toLonLat } from "../src/grid";
import { DEFAULT_COST } from "../src/router";
import { computePlan, suggestOrder, type PlanInput } from "../src/plan";
import { bearingDeg, compass, leaveStop, projectedReturnMin, remainingMin, skipNext, startWalk, stayLonger, tick, type WalkStop } from "../src/walk";

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
