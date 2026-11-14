import { describe, expect, it } from "vitest";
import type { GridMeta, RouteGrid } from "../src/grid";
import { toLonLat } from "../src/grid";
import { DEFAULT_COST } from "../src/router";
import { computePlan, type PlanInput } from "../src/plan";
import { headHomeNow, logEvent, startWalk, tick, trackAt, type WalkStop } from "../src/walk";
import { buildReport, reportHtml, reportMapSvg } from "../src/report";

const W = 200;
const H = 120;

function setup() {
  const cellLat = 2 / ((3396190 * Math.PI) / 180);
  const cellLon = cellLat / Math.cos((18.5 * Math.PI) / 180);
  const meta: GridMeta = {
    width: W, height: H, west: 77.3, north: 18.5, east: 77.3 + W * cellLon, south: 18.5 - H * cellLat,
    cellLonDeg: cellLon, cellLatDeg: cellLat, dxM: 2, dyM: 2,
  };
  const grid: RouteGrid = { meta, h: new Float32Array(W * H), slope: new Uint8Array(W * H), rough: new Uint8Array(W * H) };
  const input: PlanInput = {
    grid, model: DEFAULT_COST, base: { ...toLonLat(meta, 60, 10), antennaM: 3 }, suitAntennaM: 1.8,
    stops: [], evaMin: 360, reserveFraction: 0.3, maxRadioGapMin: 15, startMin: 525,
  };
  const stops: WalkStop[] = [
    { ...toLonLat(meta, 60, 100), id: "s1", name: "Stop <1>", minutes: 20, tasks: ["Photos", "Sample"], povIds: [] },
    { ...toLonLat(meta, 60, 190), id: "s2", name: "Stop 2", minutes: 30, tasks: ["Photos"], povIds: [] },
  ];
  const plan = computePlan({ ...input, stops });
  return { input, stops, plan };
}

describe("walk report", () => {
  it("records visited and skipped stops, the timeline and the light time", () => {
    const { input, stops, plan } = setup();
    const w = startWalk(plan.legs, stops, input.startMin);
    while (w.phase !== "at_stop") tick(w, 0.1); // arrive at stop 1
    w.notes.push({ lon: w.pos.lon, lat: w.pos.lat, clockMin: w.clockMin, text: "Odd <layer>", kind: "idea" });
    logEvent(w, "idea", "Marked a place for the next walk");
    tick(w, 20.01); // leave after the planned time
    expect(headHomeNow(w, input).ok).toBe(true);
    const phase = () => w.phase as string; // tick() changes the phase
    while (phase() !== "done") tick(w, 0.2);

    const r = buildReport({
      title: "Test walk", site: "Bright Angel", region: "Jezero crater", generatedUtc: "2026-11-14 12:00",
      plan, startMin: input.startMin,
      stops: stops.map((s, i) => ({ id: s.id, name: s.name, minutes: s.minutes, tasks: s.tasks, plannedArrivalMin: input.startMin + 10 + i * 60 })),
      walk: w, tasksDone: { s1: ["Photos"] }, base: input.base, conditions: null,
      sources: [{ id: "R1-mars-trek", name: "Mars Trek", credit: "NASA" }], assumptions: ["A1 15 deg"],
      lightTime: { distanceAu: 1.3244, distanceMkm: 198.1, oneWayMin: 11.01 },
    });
    expect(r.summary.stopsVisited).toBe(1);
    expect(r.summary.stopsSkipped).toBe(1);
    expect(r.stops.map((s) => s.status)).toEqual(["visited", "skipped"]);
    expect(r.stops[0].actualMin).toBe(20);
    expect(r.stops[0].tasksDone).toEqual(["Photos"]);
    expect(r.events.map((e) => e.text)).toContain("Back at the habitat");
    expect(r.transmission.oneWayMin).toBeCloseTo(11.0, 1);

    const html = reportHtml(r, reportMapSvg([plan.legs[0].points], w.track, [], input.base, w.notes));
    expect(html).toContain("Stop &lt;1&gt;");
    expect(html).not.toContain("Stop <1>");
    expect(html).toContain("Odd &lt;layer&gt;");
    expect(html).toContain("<svg");

    const mid = trackAt(w.track, (w.startMin + w.clockMin) / 2);
    expect(mid.clockMin).toBeCloseTo((w.startMin + w.clockMin) / 2, 6);
  });
});
