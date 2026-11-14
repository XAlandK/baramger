import { describe, expect, it } from "vitest";
import type { GridMeta, RouteGrid } from "../src/grid";
import { metresBetween, toLonLat } from "../src/grid";
import { DEFAULT_COST, findRoute, tobler } from "../src/router";
import { hasLineOfSight } from "../src/los";
import { type Conditions, computePlan } from "../src/plan";

const W = 120;
const H = 80;

function meta(): GridMeta {
  // ~2 m cells near 18.5 N on the Mars 2000 sphere
  const cellLat = 2 / (3396190 * Math.PI / 180);
  const cellLon = cellLat / Math.cos((18.5 * Math.PI) / 180);
  return {
    width: W, height: H, west: 77.3, north: 18.5, east: 77.3 + W * cellLon, south: 18.5 - H * cellLat,
    cellLonDeg: cellLon, cellLatDeg: cellLat, dxM: 2, dyM: 2,
  };
}

function flatGrid(): RouteGrid {
  return { meta: meta(), h: new Float32Array(W * H), slope: new Uint8Array(W * H), rough: new Uint8Array(W * H) };
}

describe("tobler speed", () => {
  it("is 1 on flat ground and slower uphill than gentle downhill", () => {
    expect(tobler(0)).toBeCloseTo(1, 6);
    expect(tobler(0.2)).toBeLessThan(tobler(-0.05));
    expect(tobler(-0.05)).toBeCloseTo(Math.exp(3.5 * 0.05), 6);
  });
});

describe("findRoute", () => {
  it("goes nearly straight on flat ground", () => {
    const g = flatGrid();
    const a = toLonLat(g.meta, 40, 10);
    const b = toLonLat(g.meta, 40, 110);
    const r = findRoute(g, DEFAULT_COST, a, b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let len = 0;
    for (let i = 1; i < r.points.length; i++) len += metresBetween(g.meta, r.points[i - 1], r.points[i]);
    expect(len).toBeCloseTo(200, 0);
  });

  it("goes through the gap in a wall of no-go ground", () => {
    const g = flatGrid();
    for (let r = 0; r < H; r++) if (r < 60 || r > 64) g.slope[r * W + 60] = 30; // wall with a gap at rows 60-64
    const a = toLonLat(g.meta, 10, 20);
    const b = toLonLat(g.meta, 10, 100);
    const res = findRoute(g, DEFAULT_COST, a, b);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const crossing = res.points.some((p) => {
      const r = (g.meta.north - p.lat) / g.meta.cellLatDeg - 0.5;
      return r >= 59 && r <= 65;
    });
    expect(crossing).toBe(true);
  });

  it("reports a blocked route", () => {
    const g = flatGrid();
    for (let r = 0; r < H; r++) g.slope[r * W + 60] = 40;
    const res = findRoute(g, DEFAULT_COST, toLonLat(g.meta, 40, 10), toLonLat(g.meta, 40, 110));
    expect(res.ok).toBe(false);
  });
});

describe("line of sight", () => {
  it("is blocked by a ridge and clear without it", () => {
    const g = flatGrid();
    const a = { ...toLonLat(g.meta, 40, 5), h: 3 };
    const b = { ...toLonLat(g.meta, 40, 115), h: 1.8 };
    expect(hasLineOfSight(g, a, b)).toBe(true);
    for (let r = 0; r < H; r++) g.h[r * W + 60] = 10;
    expect(hasLineOfSight(g, a, b)).toBe(false);
  });
});

describe("daylight and sun checks", () => {
  const cond: Conditions = {
    sunriseMin: 7 * 60 + 10, sunsetMin: 18 * 60 + 3, afterSunriseMin: 30, beforeSunsetMin: 60,
    protonPfu: 0.25, protonLimitPfu: 10, xFlareHoursAgo: null, xFlareCareHours: 24, dataDate: "14 Nov 2026",
  };
  function plan(startMin: number, c = cond) {
    const g = flatGrid();
    const base = { ...toLonLat(g.meta, 40, 5), antennaM: 3 };
    const stop = { ...toLonLat(g.meta, 40, 115), id: "s1", name: "Stop 1", minutes: 30 };
    return computePlan({ grid: g, model: DEFAULT_COST, base, suitAntennaM: 1.8, stops: [stop], evaMin: 360, reserveFraction: 0.3, maxRadioGapMin: 15, startMin, conditions: c });
  }
  const status = (p: ReturnType<typeof plan>, id: string) => p.checks.find((c) => c.id === id)?.status;

  it("passes a walk in good daylight", () => expect(status(plan(8 * 60 + 45), "daylight")).toBe("ok"));
  it("warns when starting too soon after sunrise", () => expect(status(plan(7 * 60 + 20), "daylight")).toBe("care"));
  it("fails a walk that starts before sunrise", () => expect(status(plan(6 * 60 + 30), "daylight")).toBe("fail"));
  it("fails a walk that ends after sunset", () => expect(status(plan(17 * 60 + 50), "daylight")).toBe("fail"));
  it("fails during a particle storm and warns after an X flare", () => {
    expect(status(plan(540, { ...cond, protonPfu: 12 }), "sun")).toBe("fail");
    expect(status(plan(540, { ...cond, xFlareHoursAgo: 5 }), "sun")).toBe("care");
    expect(status(plan(540), "sun")).toBe("ok");
  });
});

describe("computePlan", () => {
  it("adds walking and stop time and keeps the reserve rule", () => {
    const g = flatGrid();
    const base = { ...toLonLat(g.meta, 40, 5), antennaM: 3 };
    const stop = { ...toLonLat(g.meta, 40, 115), id: "s1", name: "Stop 1", minutes: 30 };
    const p = computePlan({ grid: g, model: DEFAULT_COST, base, suitAntennaM: 1.8, stops: [stop], evaMin: 360, reserveFraction: 0.3, maxRadioGapMin: 15, startMin: 525 });
    expect(p.ok).toBe(true);
    // 2 x 220 m at 2.5 km/h (0.694 m/s) = ~10.6 min of walking
    expect(p.totals.distanceM).toBeCloseTo(440, 0);
    expect(p.totals.walkMin).toBeCloseTo(440 / (2.5 / 3.6) / 60, 1);
    expect(p.totals.totalMin).toBeCloseTo(p.totals.walkMin + 30, 6);
    expect(p.checks.find((c) => c.id === "time")?.status).toBe("ok");
    expect(p.radioGaps.length).toBe(0);
  });
});
