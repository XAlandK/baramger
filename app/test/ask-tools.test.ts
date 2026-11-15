// The assistant's tools read the right values from the real mission packages (data/package, in git).
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { bilinear, cellIndex } from "../src/grid";
import type { PlanContext } from "../worker/api";
import { TOOLS, parseClock, runTool, toolSpecs, type ToolContext } from "../worker/tools";
import { DATA, diskStore } from "./disk-store";

const store = diskStore();
const readJson = async (p: string) => JSON.parse(await readFile(DATA + p, "utf8"));

async function call(name: string, args: Record<string, unknown>, ctx: Partial<ToolContext> = {}) {
  const tool = TOOLS.find((t) => t.name === name)!;
  return tool.run(args, { store, zone: "z2", ...ctx });
}

const PLAN: PlanContext = {
  startClock: "08:45", crewSize: 2, approved: false, routeFound: true,
  stops: [
    { id: "stop-1", name: "Rover stop, sol 1159", lon: 77.3126464, lat: 18.4916153, minutes: 30, arriveClock: "09:20", fromPackage: true },
    { id: "stop-2", name: "Cheyava Falls rock", lon: 77.3, lat: 18.49, minutes: 45, arriveClock: "10:20", fromPackage: true },
    { id: "new-1", name: "New stop 1", lon: 77.305, lat: 18.495, minutes: 20, fromPackage: false },
  ],
  legs: [{ from: "Habitat", to: "Rover stop, sol 1159", distanceM: 2400, straightM: 2200, minutes: 35, maxSlopeDeg: 18, careM: 40, ascentM: 30, descentM: 12, noRadioMin: 4, fromLon: 77.29, fromLat: 18.49, toLon: 77.31, toLat: 18.49 }],
  radioGaps: [{ leg: "Habitat → Rover stop, sol 1159", startClock: "09:05", minutes: 4.2, afterM: 1200, startLon: 77.3, startLat: 18.49, endLon: 77.301, endLat: 18.49 }],
  checks: [
    { id: "time", label: "Time and reserve", status: "ok", detail: "222 min planned." },
    { id: "radio", label: "Radio contact with the habitat", status: "care", detail: "1 short stretch with no radio." },
    { id: "buddy", label: "Buddy rule", status: "ok", detail: "2 astronauts." },
  ],
  selectedStopId: "stop-2",
};

describe("tool definitions", () => {
  it("lists the data tools and final_answer in the OpenAI format, with the zones as an enum", () => {
    const specs = toolSpecs(["z1", "z2"]) as { type: string; function: { name: string; parameters: { properties: Record<string, { enum?: string[] }> } } }[];
    expect(specs.map((s) => s.function.name)).toEqual(["get_site", "get_stops", "get_stop", "get_hazards_near", "get_terrain_at", "get_conditions", "get_plan", "final_answer"]);
    expect(specs.every((s) => s.type === "function")).toBe(true);
    expect(specs[0].function.parameters.properties.zone.enum).toEqual(["z1", "z2"]);
  });

  it("reads clock times in several forms", () => {
    expect(parseClock("14:00")).toBe(840);
    expect(parseClock("2 pm")).toBe(840);
    expect(parseClock("2:30 p.m.")).toBe(870);
    expect(parseClock("1400")).toBe(840);
    expect(parseClock("12 am")).toBe(0);
    expect(parseClock("noonish")).toBeNull();
    expect(parseClock("25:00")).toBeNull();
  });
});

describe("get_site", () => {
  it("Z2: habitat, goals, starting values and the source IDs from the package", async () => {
    const pkg = await readJson("z2-bright-angel/mission-package.json");
    const r = await call("get_site", { zone: "z2" });
    const d = r.data as { habitat: { lon: number; lat: number; height_m: number }; objectives: { id: string }[]; sources: { id: string }[]; startingValues: { id: string; value: number }[] };
    expect(d.habitat.lon).toBe(pkg.site.base.position.lon);
    expect(d.habitat.height_m).toBe(pkg.site.base.position.elev_m);
    expect(d.objectives.map((o) => o.id)).toEqual(["obj-cheyava", "obj-context"]);
    expect(d.sources.map((s) => s.id)).toEqual(expect.arrayContaining(["R1", "R2", "R3", "R4", "R5", "S1", "S4"]));
    expect(d.startingValues.find((a) => a.id === "A2")?.value).toBe(25);
    expect(r.facts[0]).toMatchObject({ label: "Habitat", ref: "R1" });
  });

  it("Z1 is read from its own package", async () => {
    const r = await call("get_site", { zone: "z1" });
    expect((r.data as { objectives: { id: string }[] }).objectives.map((o) => o.id)).toContain("obj-depot");
  });
});

describe("get_stops / get_stop", () => {
  it("Z1: the ten depot spots with their rock unit (R2)", async () => {
    const r = await call("get_stops", { zone: "z1" });
    const stops = (r.data as { stops: { id: string; rockUnit: string; tasks: string[] }[] }).stops;
    expect(stops).toHaveLength(10);
    expect(stops[0]).toMatchObject({ id: "depot-1", rockUnit: "Njf: Jezero floor unit" });
    expect(stops[0].tasks).toContain("Pick up the tube");
    expect(r.facts.some((f) => f.ref === "R2" && f.value === "Njf: Jezero floor unit")).toBe(true);
    expect(r.facts.at(-1)?.ref).toBe("R5");
  });

  it("Z2 stop-2: Cheyava Falls with its tasks, photos, and slope and height from the 2 m grid", async () => {
    const pkg = await readJson("z2-bright-angel/mission-package.json");
    const meta = await readJson("z2-bright-angel/route/grid.json");
    const slope = new Uint8Array(await readFile(DATA + "z2-bright-angel/route/slope_2m.u8"));
    const hb = await readFile(DATA + "z2-bright-angel/route/height_2m.f32");
    const h = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.byteLength));
    const s = pkg.stops.find((x: { id: string }) => x.id === "stop-2");
    const r = await call("get_stop", { stop_id: "stop-2" });
    const d = r.data as { name: string; rockUnit: string; tasks: string[]; roverPhotos: number; ground: { slope_deg: number; height_m: number }; objectives: { id: string }[] };
    expect(d.name).toBe("Cheyava Falls rock");
    expect(d.rockUnit).toBe("Nue: Upper etched unit");
    expect(d.tasks).toContain("Take sample");
    expect(d.objectives.map((o) => o.id)).toEqual(["obj-cheyava"]);
    expect(d.roverPhotos).toBe(s.povImageIds.length);
    expect(d.ground.slope_deg).toBe(slope[cellIndex(meta, s.position.lon, s.position.lat)]);
    expect(d.ground.height_m).toBeCloseTo(bilinear(meta, h, s.position.lon, s.position.lat), 1);
    expect(r.facts.find((f) => f.label === "Rock unit")).toMatchObject({ ref: "R2", value: "Nue: Upper etched unit" });
    expect(r.facts.find((f) => f.label === "Rover photos")?.ref).toBe("R5");
  });

  it("finds a stop by name, by number in the plan, and a stop the crew added", async () => {
    const byName = await call("get_stop", { stop_id: "cheyava" });
    expect((byName.data as { id: string }).id).toBe("stop-2");
    const byNumber = await call("get_stop", { stop_id: "2" }, { plan: PLAN });
    expect((byNumber.data as { id: string; inPlan: { number: number } }).inPlan.number).toBe(2);
    const added = await call("get_stop", { stop_id: "new-1" }, { plan: PLAN });
    expect(added.data).toMatchObject({ id: "new-1", addedByCrew: true });
  });

  it("an unknown stop is an error the model can read", async () => {
    const r = await runTool("get_stop", { stop_id: "stop-99" }, { store, zone: "z2" });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toMatch(/No stop "stop-99"/);
  });
});

describe("get_hazards_near", () => {
  it("finds the no-go area a point lies in, with its size from the package", async () => {
    const pkg = await readJson("z2-bright-angel/mission-package.json");
    const hz = pkg.hazards[0];
    const ring = hz.geometry.coordinates[0];
    // the middle of the ring's first two corners is on its edge: distance 0 or very close
    const lon = (ring[0][0] + ring[1][0]) / 2;
    const lat = (ring[0][1] + ring[1][1]) / 2;
    const r = await call("get_hazards_near", { lon, lat, radius_m: 50 });
    const d = r.data as { count: number; nearest: { id: string; distance_m: number; area_m2: number }[] };
    expect(d.count).toBeGreaterThanOrEqual(1);
    expect(d.nearest[0].id).toBe(hz.id);
    expect(d.nearest[0].distance_m).toBeLessThanOrEqual(1);
    expect(d.nearest[0].area_m2).toBeCloseTo(hz.evidence[0].value, 0);
    expect(r.facts.at(-1)).toMatchObject({ ref: "A2", value: "over 25°" });
  });

  it("a small radius on flat ground finds nothing; the radius is capped at 1000 m", async () => {
    const pkg = await readJson("z2-bright-angel/mission-package.json");
    const b = pkg.site.base.position;
    const r = await call("get_hazards_near", { lon: b.lon, lat: b.lat, radius_m: 10 });
    expect((r.data as { count: number }).count).toBe(0);
    const wide = await call("get_hazards_near", { lon: b.lon, lat: b.lat, radius_m: 99999 });
    expect((wide.data as { radius_m: number }).radius_m).toBe(1000);
  });
});

describe("get_terrain_at", () => {
  it("a point: height, slope and roughness are the grid's own values, and the rock unit (R2)", async () => {
    const meta = await readJson("z2-bright-angel/route/grid.json");
    const rough = new Uint8Array(await readFile(DATA + "z2-bright-angel/route/rough_2m.u8"));
    const lon = 77.3051909, lat = 18.4974844;
    const r = await call("get_terrain_at", { lon, lat });
    const d = r.data as { roughness_cm: number; rockUnit: string | null; slopeClass: string };
    expect(d.roughness_cm).toBe(rough[cellIndex(meta, lon, lat)]);
    expect(d.slopeClass).toMatch(/comfortable|take care|no-go/);
    expect(r.facts.map((f) => f.ref)).toContain("R1");
  });

  it("a straight line: its length and how much of it is too steep", async () => {
    const pkg = await readJson("z2-bright-angel/mission-package.json");
    const a = pkg.site.base.position;
    const b = pkg.stops[1].position;
    const r = await call("get_terrain_at", { lon: a.lon, lat: a.lat, to_lon: b.lon, to_lat: b.lat });
    const d = r.data as { straightLine_m: number; metresNoGo: number; metresTakeCare: number; steepestSlope_deg: number };
    const kx = 3396190 * (Math.PI / 180) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    const ky = 3396190 * (Math.PI / 180);
    expect(d.straightLine_m).toBeCloseTo(Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky), -1);
    expect(d.metresNoGo).toBeGreaterThanOrEqual(0);
    expect(d.metresNoGo + d.metresTakeCare).toBeLessThanOrEqual(d.straightLine_m + 2);
    expect(r.facts[0]).toMatchObject({ label: "Straight line", ref: "R1" });
  });

  it("outside the walk area there is no terrain data", async () => {
    const r = await runTool("get_terrain_at", { lon: 77.0, lat: 18.0 }, { store, zone: "z2" });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toMatch(/outside the walk area/);
  });
});

describe("get_conditions", () => {
  it("Z2 at 14:00: air and ground temperature are the package's hourly medians (S4)", async () => {
    const w = await readJson("z2-bright-angel/conditions/weather.json");
    const at14 = w.hourly_median.find((x: { hour: number }) => x.hour === 14);
    const r = await call("get_conditions", { local_time: "14:00" });
    const d = r.data as { weather: { atTime: { air_c: number; ground_c: number } }; daylight: { firstSol: { sunrise_lmst: string } } };
    expect(d.weather.atTime.air_c).toBe(at14.air_c);
    expect(d.weather.atTime.ground_c).toBe(at14.ground_c);
    expect(d.daylight.firstSol.sunrise_lmst).toBe(w.daylight.days[0].sunrise_lmst);
    expect(r.facts[0]).toMatchObject({ ref: "S4", value: `${at14.air_c < 0 ? "−" : ""}${Math.abs(Math.round(at14.air_c))} °C` });
  });

  it("between whole hours the temperature is interpolated; '2:30 pm' works", async () => {
    const w = await readJson("z2-bright-angel/conditions/weather.json");
    const a = w.hourly_median[14].air_c, b = w.hourly_median[15].air_c;
    const r = await call("get_conditions", { local_time: "2:30 pm" });
    expect((r.data as { weather: { atTime: { air_c: number } } }).weather.atTime.air_c).toBeCloseTo((a + b) / 2, 1);
  });

  it("sun activity comes from the package's NOAA (S7) and DONKI (S3) file", async () => {
    const sp = await readJson("z1-three-forks/conditions/space-weather.json");
    const r = await call("get_conditions", { zone: "z1" });
    expect(r.facts.find((f) => f.ref === "S7")?.value).toBe(`${sp.noaa.protons_10mev_latest_pfu} pfu`);
    expect((r.data as { sun: { flares7d: unknown } }).sun.flares7d).toEqual(sp.noaa.flares_7d);
  });

  it("a time it cannot read is an error", async () => {
    const r = await runTool("get_conditions", { local_time: "teatime" }, { store, zone: "z2" });
    expect(r.ok).toBe(false);
  });
});

describe("get_plan", () => {
  it("radio part: the gaps and the radio check, all from the app's own plan (PLAN)", async () => {
    const r = await call("get_plan", { part: "radio" }, { plan: PLAN });
    expect(r.facts[0]).toMatchObject({ label: "No radio from 09:05", ref: "PLAN" });
    expect(r.facts[0].value).toContain("1,200 m into the leg");
    expect(r.facts[1]).toMatchObject({ label: "Radio contact with the habitat", ref: "PLAN" });
  });

  it("all: the checks that are not OK come first", async () => {
    const r = await call("get_plan", {}, { plan: PLAN });
    expect(r.facts[0].label).toBe("Radio contact with the habitat");
    expect((r.data as { checks: unknown[] }).checks).toHaveLength(3);
  });

  it("each leg gets its direct line, measured on the 2 m grid (R1): why the route bends", async () => {
    const r = await call("get_plan", { part: "legs" }, { plan: PLAN });
    const leg = (r.data as { legs: { directLine: { length_m: number; metresNoGo: number; metresTakeCare: number; steepest_deg: number } }[] }).legs[0];
    const kx = 3396190 * (Math.PI / 180) * Math.cos((18.49 * Math.PI) / 180);
    expect(leg.directLine.length_m).toBeCloseTo(0.02 * kx, -1);
    expect(leg.directLine.metresNoGo + leg.directLine.metresTakeCare).toBeLessThanOrEqual(leg.directLine.length_m + 2);
    expect(r.facts[0]).toMatchObject({ label: "Habitat → Rover stop, sol 1159, direct line", ref: "R1" });
  });

  it("without a plan from the app it says so", async () => {
    const r = await runTool("get_plan", {}, { store, zone: "z2" });
    expect(r.ok).toBe(false);
  });
});

describe("runTool", () => {
  it("adds the source IDs to the result the model reads", async () => {
    const r = await runTool("get_conditions", { local_time: "14:00" }, { store, zone: "z2" });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).sources).toEqual(expect.arrayContaining(["S4", "S7"]));
  });

  it("an unknown tool is refused", async () => {
    const r = await runTool("get_everything", {}, { store, zone: "z2" });
    expect(r.ok).toBe(false);
  });
});
