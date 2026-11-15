// The assistant's tools: small, read-only look-ups in the same mission package files the app serves.
// Each tool returns the data for the model and a short list of facts (value + source ID) that the
// app shows under the answer. The facts come from this code, never from the model (rule C5).

import { type GridMeta, type RouteGrid, UNKNOWN, bilinear, cellIndex, inside } from "../src/grid";
import type { MissionPackage } from "../src/pkg";
import type { Fact, PlanContext } from "./api";

/** Reads one file of the built site (the Worker's ASSETS binding; a disk reader in tests). */
export type AssetFetch = (path: string) => Promise<Response>;

const R_MARS = 3_396_190; // Mars 2000 sphere (m), the package CRS
const DEG = Math.PI / 180;

interface ZoneEntry {
  key: string;
  code: string;
  name: string;
  path: string;
}

interface UnitFeature {
  properties: { symbol: string; name: string };
  geometry: { type: "Polygon"; coordinates: number[][][] };
}

export interface Weather {
  sols: number[];
  date_range?: string;
  source?: string;
  note?: string;
  per_sol: { sol: number; air_c: [number, number] | null; ground_c: [number, number] | null; pressure_pa: [number, number, number] | null }[];
  hourly_median: { hour: number; air_c: number | null; ground_c: number | null }[];
  walk_hours_air_c?: [number, number] | null;
  daylight: { method?: string; days: { sol: number; sunrise_lmst: string; sunset_lmst: string }[] };
}

export interface SpaceWeather {
  retrieved_utc: string;
  noaa: {
    flares_7d: { C: number; M: number; X: number };
    strong_flares_7d: { class: string; max_time: string }[];
    protons_10mev_latest_pfu: number | null;
    protons_10mev_latest_time?: string;
    protons_10mev_max_3d_pfu?: number | null;
    where_measured: string;
  };
  donki?: { status: string; sep_events_30d?: number; latest_sep?: unknown };
}

/** Lazy, cached reader of the mission packages. Files never change within one deploy. */
export class PackageStore {
  private cache = new Map<string, Promise<unknown>>();

  constructor(private readonly fetchAsset: AssetFetch) {}

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key)); // a failed read is tried again next time
    }
    return p;
  }

  private async file(path: string): Promise<Response> {
    const r = await this.fetchAsset(path);
    if (!r.ok) throw new Error(`could not read ${path} (${r.status})`);
    return r;
  }

  private json<T>(path: string): Promise<T> {
    return this.once(path, async () => (await this.file(path)).json() as Promise<T>);
  }

  zones(): Promise<ZoneEntry[]> {
    return this.json<{ zones: ZoneEntry[] }>("package/index.json").then((i) => i.zones);
  }

  async zone(key: string): Promise<ZoneEntry> {
    const z = (await this.zones()).find((x) => x.key === key);
    if (!z) throw new ToolError(`Unknown walk zone "${key}".`);
    return z;
  }

  async pkg(key: string): Promise<MissionPackage & { hazards: Hazard[] }> {
    return this.json(`package/${(await this.zone(key)).path}mission-package.json`);
  }

  async weather(key: string): Promise<Weather> {
    return this.json(`package/${(await this.zone(key)).path}conditions/weather.json`);
  }

  async space(key: string): Promise<SpaceWeather> {
    return this.json(`package/${(await this.zone(key)).path}conditions/space-weather.json`);
  }

  async units(key: string): Promise<UnitFeature[]> {
    const g = await this.json<{ features: UnitFeature[] }>(`package/${(await this.zone(key)).path}geology/units.geojson`);
    return g.features;
  }

  /** The 2 m routing grid: height, slope and roughness (the same files and readers as the app, src/grid.ts). */
  grid(key: string): Promise<RouteGrid> {
    return this.once(`grid:${key}`, async () => {
      const base = `package/${(await this.zone(key)).path}route/`;
      const meta = (await (await this.file(`${base}grid.json`)).json()) as GridMeta;
      const n = meta.width * meta.height;
      const [h, slope, rough] = await Promise.all([
        this.file(`${base}height_2m.f32`).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
        this.file(`${base}slope_2m.u8`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
        this.file(`${base}rough_2m.u8`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
      ]);
      if (h.length !== n || slope.length !== n || rough.length !== n) throw new Error(`route grid of zone ${key} has the wrong size`);
      return { meta, h, slope, rough };
    });
  }
}

export interface Hazard {
  id: string;
  type: string;
  severity: string;
  message?: string;
  geometry: { type: string; coordinates: number[][][] };
  evidence?: { value: number; unit: string }[];
}

/** A problem with the tool call itself (bad argument, unknown stop): the model gets the message and can try again. */
export class ToolError extends Error {}

export interface ToolContext {
  store: PackageStore;
  zone: string; // the zone the crew has open
  plan?: PlanContext;
}

export interface ToolResult {
  data: unknown;
  facts: Fact[];
}

interface ParamSpec {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  required: string[];
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ------------------------------------------------------------------ small helpers
const short = (sourceId: string) => sourceId.split("-")[0]; // "R1-mars-trek" → "R1"
const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const minus = (s: string) => s.replace(/^-/, "−");
const num = (x: number, d = 0) => minus(round(x, d).toLocaleString("en-US", { maximumFractionDigits: d }));
const degC = (c: number) => `${minus(String(Math.round(c)))} °C`;
const pos = (lon: number, lat: number) => `${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E`;

function str(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  return String(v).trim();
}

function numArg(args: Record<string, unknown>, name: string, required: boolean): number | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`"${name}" is needed.`);
    return undefined;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`"${name}" must be a number.`);
  return n;
}

/** The zone a tool call is about: its own "zone" argument, or the zone the crew has open. */
function zoneOf(args: Record<string, unknown>, ctx: ToolContext): string {
  return (str(args, "zone") ?? ctx.zone).toLowerCase();
}

/** Metres per degree on the Mars 2000 sphere at a latitude. */
function kxy(lat: number): { kx: number; ky: number } {
  return { kx: R_MARS * DEG * Math.cos(lat * DEG), ky: R_MARS * DEG };
}

function metres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const { kx, ky } = kxy((a.lat + b.lat) / 2);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky);
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
function direction(from: { lon: number; lat: number }, to: { lon: number; lat: number }): string {
  const { kx, ky } = kxy(from.lat);
  const b = (Math.atan2((to.lon - from.lon) * kx, (to.lat - from.lat) * ky) / DEG + 360) % 360;
  return COMPASS[Math.round(b / 45) % 8];
}

function inRing(ring: number[][], lon: number, lat: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function unitAt(units: UnitFeature[], lon: number, lat: number): string | null {
  for (const u of units) if (inRing(u.geometry.coordinates[0], lon, lat)) return `${u.properties.symbol}: ${u.properties.name}`;
  return null;
}

/** Distance (m) from a point to a polygon's outline; 0 when the point is inside. */
function distanceToPolygon(rings: number[][][], lon: number, lat: number): number {
  if (inRing(rings[0], lon, lat)) return 0;
  const { kx, ky } = kxy(lat);
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const ax = (ring[i][0] - lon) * kx, ay = (ring[i][1] - lat) * ky;
      const bx = (ring[i + 1][0] - lon) * kx, by = (ring[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const L = dx * dx + dy * dy;
      const t = L > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

function assumptionValue(pkg: MissionPackage, id: string, fallback: number): number {
  const a = pkg.assumptions.find((x) => x.id === id);
  return typeof a?.value === "number" ? a.value : fallback;
}

function slopeClass(slope: number, comfort: number, max: number): string {
  if (slope === UNKNOWN) return "unknown";
  return slope > max ? `no-go (steeper than ${max}°)` : slope > comfort ? `take care (${comfort}–${max}°)` : `comfortable (${comfort}° or less)`;
}

/** "14:00", "2 pm", "14", "1400" → minutes after local midnight. */
export function parseClock(s: string): number | null {
  const m = /^\s*(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return (h * 60 + min) % 1440;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;
const clockMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

function gridAt(g: RouteGrid, lon: number, lat: number) {
  const i = cellIndex(g.meta, lon, lat);
  return { height: bilinear(g.meta, g.h, lon, lat), slope: g.slope[i], rough: g.rough[i] };
}

function walkArea(m: GridMeta): string {
  return `${m.south.toFixed(4)}–${m.north.toFixed(4)}° N, ${m.west.toFixed(4)}–${m.east.toFixed(4)}° E`;
}

// ------------------------------------------------------------------ the tools
const ZONE_PARAM: ParamSpec = { type: "string", description: "Walk zone key, e.g. z2. Leave out for the zone the crew has open." };

const getSite: ToolDef = {
  name: "get_site",
  description: "The walk zone: name, place, habitat position, science goals, the starting values and limits used by the safety checks (A1–A22), and the list of data sources with their IDs.",
  params: { zone: ZONE_PARAM },
  required: [],
  async run(args, ctx) {
    const key = zoneOf(args, ctx);
    const [pkg, zones] = await Promise.all([ctx.store.pkg(key), ctx.store.zones()]);
    const b = pkg.site.base;
    const [w, s, e, n] = pkg.site.aoi;
    const sizeM = { eastWest: round(metres({ lon: w, lat: (s + n) / 2 }, { lon: e, lat: (s + n) / 2 })), northSouth: round(metres({ lon: w, lat: s }, { lon: w, lat: n })) };
    return {
      data: {
        zone: key,
        name: pkg.site.name,
        region: pkg.site.region,
        description: pkg.site.description,
        walkArea: { west: w, south: s, east: e, north: n, sizeM },
        habitat: { lon: b.position.lon, lat: b.position.lat, height_m: b.position.elev_m, antennaHeight_m: b.antennaHeight_m },
        objectives: pkg.objectives.map((o) => ({ id: o.id, title: o.title, question: o.question, whyHumans: o.whyHumans })),
        startingValues: pkg.assumptions.map((a) => ({ id: a.id, statement: a.statement, value: a.value, unit: a.unit, status: a.status })),
        sources: pkg.sources.map((x) => ({ id: short(x.id), name: x.name, role: x.role })),
        otherZones: zones.filter((z) => z.key !== key).map((z) => ({ key: z.key, name: z.name })),
        heights: "metres above the MOLA areoid (Mars 2000 sphere, planetocentric, east longitude)",
      },
      facts: [
        { label: "Habitat", value: `${pos(b.position.lon, b.position.lat)}, ${num(b.position.elev_m ?? 0)} m`, ref: "R1" },
        { label: "Walk area", value: `${num(sizeM.eastWest)} × ${num(sizeM.northSouth)} m`, ref: "R1" },
        ...pkg.objectives.slice(0, 2).map((o) => ({ label: "Science goal", value: o.title, ref: "PKG" })),
      ],
    };
  },
};

function stopSummary(pkg: MissionPackage, s: MissionPackage["stops"][number], plan?: PlanContext) {
  const photos = (s.povImageIds ?? []).map((id) => pkg.povImages.find((p) => p.imageId === id)).filter((p) => !!p);
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    lon: s.position.lon,
    lat: s.position.lat,
    height_m: s.position.elev_m,
    plannedMinutes: s.plannedMinutes,
    tasks: s.tasks ?? [],
    objectiveIds: s.objectiveIds ?? [],
    rockUnit: s.geologicUnit ?? null,
    roverPhotos: photos.length,
    closeUpPhotos: photos.filter((p) => p.instrument.startsWith("SHERLOC") || p.instrument.startsWith("SUPERCAM")).length,
    inCrewPlan: plan ? plan.stops.some((x) => x.id === s.id) : undefined,
    notes: s.notes,
  };
}

const getStops: ToolDef = {
  name: "get_stops",
  description: "All known places (stops) of the walk zone from the mission package: position, height, tasks, science goal, rock unit, number of rover photos, and whether each is in the crew's plan now.",
  params: { zone: ZONE_PARAM },
  required: [],
  async run(args, ctx) {
    const key = zoneOf(args, ctx);
    const pkg = await ctx.store.pkg(key);
    const stops = pkg.stops.map((s) => stopSummary(pkg, s, key === ctx.zone ? ctx.plan : undefined));
    const nPhotos = stops.reduce((a, s) => a + s.roverPhotos, 0);
    return {
      data: { zone: key, objectives: pkg.objectives.map((o) => ({ id: o.id, title: o.title })), stops },
      facts: [
        ...stops.slice(0, 6).map((s) => ({ label: s.name, value: s.rockUnit ?? "rock unit unknown", ref: "R2" })),
        { label: "Rover photos", value: `${nPhotos} at ${stops.filter((s) => s.roverPhotos > 0).length} places`, ref: "R5" },
      ],
    };
  },
};

/** A stop by package ID, plan ID, name or plan number ("2" = the second stop of the plan). */
function findStop(pkg: MissionPackage, plan: PlanContext | undefined, ref: string) {
  const want = ref.trim().toLowerCase();
  const inPkg = pkg.stops.find((s) => s.id.toLowerCase() === want) ?? pkg.stops.find((s) => s.name.toLowerCase() === want);
  if (inPkg) return { pkgStop: inPkg, planStop: plan?.stops.find((p) => p.id === inPkg.id) };
  const planStop =
    plan?.stops.find((p) => p.id.toLowerCase() === want || p.name.toLowerCase() === want)
    ?? (/^\d+$/.test(want) ? plan?.stops[Number(want) - 1] : undefined)
    ?? plan?.stops.find((p) => p.name.toLowerCase().includes(want))
    ?? undefined;
  if (planStop) return { pkgStop: pkg.stops.find((s) => s.id === planStop.id), planStop };
  const loose = pkg.stops.find((s) => s.name.toLowerCase().includes(want));
  if (loose) return { pkgStop: loose, planStop: plan?.stops.find((p) => p.id === loose.id) };
  return null;
}

const getStop: ToolDef = {
  name: "get_stop",
  description: "One stop in detail: tasks, science goal, rock unit, ground height, slope and roughness there, the nearest no-go area, the rover photos taken there, and its place in the crew's plan. stop_id can be an ID (stop-2, depot-3), a name, or a number in the plan's walking order.",
  params: { zone: ZONE_PARAM, stop_id: { type: "string", description: "Stop ID, name, or number in the plan (1 = first stop)." } },
  required: ["stop_id"],
  async run(args, ctx) {
    const key = zoneOf(args, ctx);
    const ref = str(args, "stop_id");
    if (!ref) throw new ToolError('"stop_id" is needed.');
    const plan = key === ctx.zone ? ctx.plan : undefined;
    const [pkg, g, units] = await Promise.all([ctx.store.pkg(key), ctx.store.grid(key), ctx.store.units(key)]);
    const hit = findStop(pkg, plan, ref);
    if (!hit) throw new ToolError(`No stop "${ref}" in zone ${key}. Known IDs: ${pkg.stops.map((s) => s.id).join(", ")}${plan?.stops.length ? `; plan stops: ${plan.stops.map((s) => s.id).join(", ")}` : ""}.`);
    const { pkgStop, planStop } = hit;
    const lon = pkgStop?.position.lon ?? planStop!.lon;
    const lat = pkgStop?.position.lat ?? planStop!.lat;
    const comfort = assumptionValue(pkg, "A1", 15);
    const max = assumptionValue(pkg, "A2", 25);
    const t = inside(g.meta, lon, lat) ? gridAt(g, lon, lat) : null;
    const near = nearestHazards(pkg.hazards, lon, lat, 500, 1)[0];
    const photos = (pkgStop?.povImageIds ?? []).map((id) => pkg.povImages.find((p) => p.imageId === id)).filter((p) => !!p);
    const order = plan ? plan.stops.findIndex((s) => s.id === (pkgStop?.id ?? planStop?.id)) : -1;
    const legIn = order >= 0 ? plan!.legs[order] : undefined;
    const unit = pkgStop?.geologicUnit ?? unitAt(units, lon, lat);
    const data = {
      zone: key,
      ...(pkgStop ? stopSummary(pkg, pkgStop, plan) : { id: planStop!.id, name: planStop!.name, lon, lat, addedByCrew: true, rockUnit: unit }),
      objectives: pkg.objectives.filter((o) => pkgStop?.objectiveIds?.includes(o.id)).map((o) => ({ id: o.id, title: o.title, question: o.question })),
      ground: t ? { height_m: round(t.height, 1), slope_deg: t.slope === UNKNOWN ? null : t.slope, slopeClass: slopeClass(t.slope, comfort, max), roughness_cm: t.rough === UNKNOWN ? null : t.rough } : "outside the 2 m terrain grid",
      nearestNoGo: near ? { id: near.id, distance_m: near.distance_m, direction: near.direction } : "none within 500 m",
      photos: photos.map((p) => ({ camera: p.instrument, sol: p.sol, takenUtc: p.takenUtc, closeUp: p.instrument.startsWith("SHERLOC") || p.instrument.startsWith("SUPERCAM"), caption: p.caption?.slice(0, 160), credit: p.credit })),
      inPlan: order >= 0 ? { number: order + 1, arriveClock: plan!.stops[order].arriveClock, minutes: plan!.stops[order].minutes, legIn } : "not in the crew's plan",
    };
    const facts: Fact[] = [];
    if (unit) facts.push({ label: "Rock unit", value: unit, ref: "R2" });
    if (t) {
      facts.push({ label: "Ground height", value: `${num(t.height)} m`, ref: "R1" });
      if (t.slope !== UNKNOWN) facts.push({ label: "Slope", value: `${t.slope}°`, ref: "R1" });
      if (t.rough !== UNKNOWN) facts.push({ label: "Roughness", value: `${t.rough} cm`, ref: "R1" });
    }
    if (photos.length) facts.push({ label: "Rover photos", value: `${photos.length} (sols ${[...new Set(photos.map((p) => p.sol))].join(", ")})`, ref: "R5" });
    if (near) facts.push({ label: "Nearest no-go area", value: `${num(near.distance_m)} m ${near.direction}`, ref: "R1" });
    if (pkgStop?.tasks?.length) facts.push({ label: "Tasks", value: pkgStop.tasks.join("; "), ref: "PKG" });
    return { data, facts };
  },
};

function nearestHazards(hazards: Hazard[], lon: number, lat: number, radius: number, limit: number) {
  return hazards
    .filter((h) => h.geometry.type === "Polygon")
    .map((h) => {
      const d = distanceToPolygon(h.geometry.coordinates, lon, lat);
      const ring = h.geometry.coordinates[0];
      const c = ring.reduce((a, p) => ({ lon: a.lon + p[0] / ring.length, lat: a.lat + p[1] / ring.length }), { lon: 0, lat: 0 });
      const area = h.evidence?.find((e) => e.unit === "m2")?.value;
      return { id: h.id, type: h.type, severity: h.severity, message: h.message, distance_m: round(d), direction: d === 0 ? "here" : direction({ lon, lat }, c), area_m2: area !== undefined ? round(area) : undefined };
    })
    .filter((h) => h.distance_m <= radius)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}

const getHazardsNear: ToolDef = {
  name: "get_hazards_near",
  description: "No-go areas (ground steeper than the maximum slope, from the 1 m terrain model) within a radius of a point: distance, direction and size of each, nearest first.",
  params: {
    zone: ZONE_PARAM,
    lon: { type: "number", description: "Longitude, degrees east." },
    lat: { type: "number", description: "Latitude, degrees north." },
    radius_m: { type: "number", description: "Search radius in metres (10 to 1000, default 150)." },
  },
  required: ["lon", "lat"],
  async run(args, ctx) {
    const key = zoneOf(args, ctx);
    const lon = numArg(args, "lon", true)!;
    const lat = numArg(args, "lat", true)!;
    const radius = Math.max(10, Math.min(1000, numArg(args, "radius_m", false) ?? 150));
    const pkg = await ctx.store.pkg(key);
    const all = nearestHazards(pkg.hazards, lon, lat, radius, 1000);
    const list = all.slice(0, 8);
    const max = assumptionValue(pkg, "A2", 25);
    return {
      data: { zone: key, point: { lon, lat }, radius_m: radius, rule: `No-go = steeper than ${max}° (A2) on the 2 m grid`, count: all.length, insideNoGo: list[0]?.distance_m === 0 ? list[0].id : null, nearest: list },
      facts: [
        { label: `No-go areas within ${num(radius)} m`, value: String(all.length), ref: "R1" },
        ...list.slice(0, 3).map((h) => ({ label: h.id, value: h.distance_m === 0 ? "the point is inside it" : `${num(h.distance_m)} m ${h.direction}${h.area_m2 ? `, ${num(h.area_m2)} m²` : ""}`, ref: "R1" })),
        { label: "No-go slope", value: `over ${max}°`, ref: "A2" },
      ],
    };
  },
};

/** The ground along a straight line, sampled every 2 m on the routing grid (the same grid the route search uses). */
function lineProfile(g: RouteGrid, units: UnitFeature[], a: { lon: number; lat: number }, b: { lon: number; lat: number }, comfort: number, max: number) {
  const L = metres(a, b);
  const n = Math.max(1, Math.ceil(L / 2));
  let asc = 0, desc = 0, maxSlope = 0, maxAt = 0, careM = 0, nogoM = 0, maxRough = 0, unknownM = 0;
  let prevH = bilinear(g.meta, g.h, a.lon, a.lat);
  const startH = prevH;
  const unitsCrossed: string[] = [];
  const step = L / n;
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    const p = { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f };
    const t = gridAt(g, p.lon, p.lat);
    if (k > 0) {
      const dh = t.height - prevH;
      if (dh > 0) asc += dh;
      else desc -= dh;
      if (t.slope === UNKNOWN) unknownM += step;
      else {
        if (t.slope > maxSlope) { maxSlope = t.slope; maxAt = f * L; }
        if (t.slope > max) nogoM += step;
        else if (t.slope > comfort) careM += step;
      }
    }
    if (t.rough !== UNKNOWN) maxRough = Math.max(maxRough, t.rough);
    if (units.length && (k % 10 === 0 || k === n)) {
      const u = unitAt(units, p.lon, p.lat);
      if (u && unitsCrossed[unitsCrossed.length - 1] !== u) unitsCrossed.push(u);
    }
    prevH = t.height;
  }
  return { L, asc, desc, maxSlope, maxAt, careM, nogoM, unknownM, maxRough, startH, endH: prevH, unitsCrossed };
}

const getTerrain: ToolDef = {
  name: "get_terrain_at",
  description: "Ground at a point from the 2 m terrain grid (HiRISE 1 m terrain model): height, slope, roughness, slope class and rock unit. Give to_lon and to_lat as well to get the straight line between two points: length, climb, steepest slope, and how many metres are too steep. Use the line to see why a route does not go straight.",
  params: {
    zone: ZONE_PARAM,
    lon: { type: "number", description: "Longitude, degrees east." },
    lat: { type: "number", description: "Latitude, degrees north." },
    to_lon: { type: "number", description: "Optional end of a straight line: longitude." },
    to_lat: { type: "number", description: "Optional end of a straight line: latitude." },
  },
  required: ["lon", "lat"],
  async run(args, ctx) {
    const key = zoneOf(args, ctx);
    const lon = numArg(args, "lon", true)!;
    const lat = numArg(args, "lat", true)!;
    const toLon = numArg(args, "to_lon", false);
    const toLat = numArg(args, "to_lat", false);
    const [pkg, g, units] = await Promise.all([ctx.store.pkg(key), ctx.store.grid(key), ctx.store.units(key)]);
    const comfort = assumptionValue(pkg, "A1", 15);
    const max = assumptionValue(pkg, "A2", 25);
    if (!inside(g.meta, lon, lat)) throw new ToolError(`That point is outside the walk area of zone ${key} (${walkArea(g.meta)}): no 2 m terrain data there.`);
    if (toLon === undefined || toLat === undefined) {
      const t = gridAt(g, lon, lat);
      const unit = unitAt(units, lon, lat);
      return {
        data: { zone: key, lon, lat, height_m: round(t.height, 1), slope_deg: t.slope === UNKNOWN ? null : t.slope, slopeClass: slopeClass(t.slope, comfort, max), roughness_cm: t.rough === UNKNOWN ? null : t.rough, rockUnit: unit, cell_m: 2 },
        facts: [
          { label: "Ground height", value: `${num(t.height)} m`, ref: "R1" },
          { label: "Slope", value: t.slope === UNKNOWN ? "unknown" : `${t.slope}° (${slopeClass(t.slope, comfort, max)})`, ref: "R1" },
          ...(t.rough === UNKNOWN ? [] : [{ label: "Roughness", value: `${t.rough} cm`, ref: "R1" }]),
          ...(unit ? [{ label: "Rock unit", value: unit, ref: "R2" }] : []),
        ],
      };
    }
    if (!inside(g.meta, toLon, toLat)) throw new ToolError(`The end point is outside the walk area of zone ${key} (${walkArea(g.meta)}).`);
    const a = { lon, lat };
    const b = { lon: toLon, lat: toLat };
    if (metres(a, b) > 3000) throw new ToolError("The line is longer than 3 km; use shorter pieces.");
    const { L, asc, desc, maxSlope, maxAt, careM, nogoM, unknownM, maxRough, startH, endH: prevH, unitsCrossed } = lineProfile(g, units, a, b, comfort, max);
    return {
      data: {
        zone: key, from: a, to: b, straightLine_m: round(L), startHeight_m: round(startH, 1), endHeight_m: round(prevH, 1), climb_m: round(asc, 1), descent_m: round(desc, 1),
        steepestSlope_deg: maxSlope, steepestAt_m: round(maxAt), metresTakeCare: round(careM), metresNoGo: round(nogoM), unknownMetres: round(unknownM), maxRoughness_cm: maxRough, rockUnits: unitsCrossed,
        rule: `take care ${comfort}–${max}° (A1), no-go over ${max}° (A2)`,
      },
      facts: [
        { label: "Straight line", value: `${num(L)} m`, ref: "R1" },
        { label: "Steepest on the line", value: `${maxSlope}° (${num(maxAt)} m along)`, ref: "R1" },
        { label: "Too steep to walk (no-go)", value: `${num(nogoM)} m`, ref: "R1" },
        { label: `Take care (${comfort}–${max}°)`, value: `${num(careM)} m`, ref: "R1" },
        { label: "Climb / descent", value: `${num(asc)} m / ${num(desc)} m`, ref: "R1" },
      ],
    };
  },
};

/** Air and ground temperature at a clock time, from the hourly medians (linear between hours). */
function temperatureAt(w: Weather, min: number): { air: number | null; ground: number | null } {
  const at = (h: number) => w.hourly_median.find((x) => x.hour === ((h % 24) + 24) % 24);
  const h0 = Math.floor(min / 60);
  const f = (min - h0 * 60) / 60;
  const a = at(h0);
  const b = at(h0 + 1);
  const mix = (x: number | null | undefined, y: number | null | undefined) =>
    x == null ? null : y == null || f === 0 ? x : x + (y - x) * f;
  return { air: mix(a?.air_c, b?.air_c), ground: mix(a?.ground_c, b?.ground_c) };
}

const getConditions: ToolDef = {
  name: "get_conditions",
  description: "Weather measured by Perseverance's MEDA station in this zone (air and ground temperature by hour, pressure), sunrise and sunset, the daylight rules, and sun activity (NOAA and NASA DONKI, measured near Earth). Give local_time (local Mars time, e.g. 14:00) for the temperature at that time.",
  params: { zone: ZONE_PARAM, local_time: { type: "string", description: "Optional local Mars time, 24 h clock, e.g. 14:00." } },
  required: [],
  async run(args, ctx) {
    const key = zoneOf(args, ctx);
    const [pkg, w, sp] = await Promise.all([ctx.store.pkg(key), ctx.store.weather(key), ctx.store.space(key)]);
    const timeArg = str(args, "local_time");
    const t = timeArg !== undefined ? parseClock(timeArg) : null;
    if (timeArg !== undefined && t === null) throw new ToolError(`"local_time" must be a clock time like 14:00 (got "${timeArg}").`);
    const sols = w.sols.length ? `${w.sols[0]}–${w.sols[w.sols.length - 1]}` : "";
    const temp = t !== null ? temperatureAt(w, t) : null;
    const d0 = w.daylight.days[0];
    const dN = w.daylight.days[w.daylight.days.length - 1];
    const after = assumptionValue(pkg, "A10", 30);
    const before = assumptionValue(pkg, "A11", 60);
    const air = w.per_sol.flatMap((s) => s.air_c ?? []);
    const ground = w.per_sol.flatMap((s) => s.ground_c ?? []);
    const press = w.per_sol.map((s) => s.pressure_pa?.[1]).filter((x): x is number => typeof x === "number");
    const x = sp.noaa.strong_flares_7d.filter((f) => f.class.startsWith("X"));
    const facts: Fact[] = [];
    if (temp && t !== null) {
      if (temp.air !== null) facts.push({ label: `Air at ${hhmm(t)} (median, sols ${sols})`, value: degC(temp.air), ref: "S4" });
      if (temp.ground !== null) facts.push({ label: `Ground at ${hhmm(t)} (median)`, value: degC(temp.ground), ref: "S4" });
    } else if (air.length) {
      facts.push({ label: `Air, sols ${sols}`, value: `${degC(Math.min(...air))} to ${degC(Math.max(...air))}`, ref: "S4" });
    }
    facts.push({ label: `Sunrise / sunset (sol ${d0.sol})`, value: `${d0.sunrise_lmst} / ${d0.sunset_lmst}`, ref: "PKG" });
    facts.push({ label: "Particle level (≥10 MeV, near Earth)", value: `${sp.noaa.protons_10mev_latest_pfu ?? "unknown"} pfu`, ref: "S7" });
    if (sp.donki?.status === "ok") facts.push({ label: "Solar particle events, 30 days", value: String(sp.donki.sep_events_30d ?? 0), ref: "S3" });
    return {
      data: {
        zone: key,
        weather: {
          measuredBy: w.source,
          sols,
          dates: w.date_range,
          note: w.note ?? "Real measurements from a past period; typical for the place and season, not a forecast.",
          atTime: temp && t !== null ? { localTime: hhmm(t), air_c: temp.air === null ? null : round(temp.air, 1), ground_c: temp.ground === null ? null : round(temp.ground, 1), how: "median of the measured sols, linear between whole hours" } : undefined,
          hourlyMedian: w.hourly_median,
          airRange_c: air.length ? [Math.min(...air), Math.max(...air)] : null,
          groundRange_c: ground.length ? [Math.min(...ground), Math.max(...ground)] : null,
          walkHoursAir_c: w.walk_hours_air_c ?? null,
          pressureDailyMean_pa: press.length ? [Math.min(...press), Math.max(...press)] : null,
        },
        daylight: {
          method: w.daylight.method,
          firstSol: d0,
          lastSol: dN,
          rule: `start at least ${after} min after sunrise (A10), be back ${before} min before sunset (A11)`,
          earliestStart: hhmm(clockMin(d0.sunrise_lmst) + after),
          latestReturn: hhmm(clockMin(d0.sunset_lmst) - before),
          times: "local mean solar time (LMST)",
        },
        sun: {
          retrievedUtc: sp.retrieved_utc,
          whereMeasured: sp.noaa.where_measured,
          flares7d: sp.noaa.flares_7d,
          xClassFlares7d: x,
          protons10MeV_pfu: sp.noaa.protons_10mev_latest_pfu,
          protonsTime: sp.noaa.protons_10mev_latest_time,
          protonsMax3d_pfu: sp.noaa.protons_10mev_max_3d_pfu,
          donki: sp.donki,
          rules: `postpone at ${assumptionValue(pkg, "A12", 10)} pfu or more (A12); take care for ${assumptionValue(pkg, "A13", 24)} h after an X-class flare (A13)`,
        },
      },
      facts,
    };
  },
};

const getPlan: ToolDef = {
  name: "get_plan",
  description: "The crew's current plan as computed by Baramger's own code: stops in walking order with arrival times, legs (distance, time, steepest slope, metres needing care, radio loss, and the direct straight line between the leg's two ends: its length and how much of it is too steep), totals and reserve, radio gaps with where and when they start, and the safety checks with their results. Use the legs' directLine to explain why a route bends or goes around ground. The checks decide what is safe; explain them, never change them.",
  params: { part: { type: "string", description: "Which part: all, stops, legs, radio or checks. Use all if unsure.", enum: ["all", "stops", "legs", "radio", "checks"] } },
  required: [],
  async run(args, ctx) {
    const p = ctx.plan;
    if (!p) throw new ToolError("The app sent no plan with this question.");
    const part = str(args, "part") ?? "all";
    // the direct line of each leg, measured on the 2 m grid by this code: why does the route bend?
    const [pkg, g] = await Promise.all([ctx.store.pkg(ctx.zone), ctx.store.grid(ctx.zone)]);
    const comfort = assumptionValue(pkg, "A1", 15);
    const max = assumptionValue(pkg, "A2", 25);
    const legs = p.legs.map((l) => {
      const a = { lon: l.fromLon, lat: l.fromLat };
      const b = { lon: l.toLon, lat: l.toLat };
      if (!inside(g.meta, a.lon, a.lat) || !inside(g.meta, b.lon, b.lat) || metres(a, b) > 3000) return l;
      const d = lineProfile(g, [], a, b, comfort, max);
      return { ...l, directLine: { length_m: round(d.L), steepest_deg: d.maxSlope, metresNoGo: round(d.nogoM), metresTakeCare: round(d.careM), climb_m: round(d.asc), rule: `no-go over ${max}° (A2), take care ${comfort}–${max}° (A1)` } };
    });
    const bendFacts = legs
      .filter((l): l is typeof l & { directLine: { length_m: number; steepest_deg: number; metresNoGo: number; metresTakeCare: number } } => "directLine" in l && (l.distanceM > l.straightM * 1.05 || l.directLine.metresNoGo > 0))
      .map((l) => ({ label: `${l.from} → ${l.to}, direct line`, value: `${num(l.directLine.metresNoGo)} m over ${max}°, ${num(l.directLine.metresTakeCare)} m at ${comfort}–${max}°, steepest ${l.directLine.steepest_deg}° (route ${num(l.distanceM)} m, direct ${num(l.directLine.length_m)} m)`, ref: "R1" }));
    const facts: Fact[] = [];
    const checkFact = (c: PlanContext["checks"][number]) => ({ label: c.label, value: `${c.status === "ok" ? "OK" : c.status === "care" ? "take care" : "FAIL"}: ${c.detail}`, ref: "PLAN" });
    const gapFacts = p.radioGaps.map((r) => ({ label: `No radio from ${r.startClock}`, value: `${num(r.minutes, 1)} min, ${r.leg}, ${num(r.afterM)} m into the leg`, ref: "PLAN" }));
    if (part === "radio") {
      facts.push(...gapFacts);
      const rc = p.checks.find((c) => c.id === "radio");
      if (rc) facts.push(checkFact(rc));
    } else if (part === "checks") {
      facts.push(...p.checks.map(checkFact));
    } else if (part === "legs") {
      facts.push(...bendFacts, ...p.legs.map((l) => ({ label: `${l.from} → ${l.to}`, value: `${num(l.distanceM)} m (straight ${num(l.straightM)} m), ${num(l.minutes)} min, steepest ${l.maxSlopeDeg}°`, ref: "PLAN" })));
    } else if (part === "stops") {
      facts.push(...p.stops.map((s, i) => ({ label: `Stop ${i + 1}: ${s.name}`, value: `${s.arriveClock ? `arrive ${s.arriveClock}, ` : ""}${s.minutes} min`, ref: "PLAN" })));
    } else {
      facts.push(...p.checks.filter((c) => c.status !== "ok").map(checkFact), ...gapFacts, ...bendFacts);
      if (p.totals) facts.push({ label: "Whole walk", value: `${num(p.totals.distanceM)} m, ${num(p.totals.totalMin)} min, back ${p.totals.finishClock}, reserve ${num(p.totals.reserveMin)} min`, ref: "PLAN" });
    }
    const all = { startClock: p.startClock, crewSize: p.crewSize, approved: p.approved, routeFound: p.routeFound, routeError: p.routeError, stops: p.stops, legs, totals: p.totals, radioGaps: p.radioGaps, checks: p.checks, selectedStopId: p.selectedStopId };
    const data =
      part === "stops" ? { stops: p.stops, startClock: p.startClock, selectedStopId: p.selectedStopId }
      : part === "legs" ? { legs, routeFound: p.routeFound }
      : part === "radio" ? { radioGaps: p.radioGaps, radioCheck: p.checks.find((c) => c.id === "radio"), legs: p.legs.map((l) => ({ from: l.from, to: l.to, noRadioMin: l.noRadioMin })) }
      : part === "checks" ? { checks: p.checks, approved: p.approved }
      : all;
    // how the route search chooses (router.ts, plan.ts): stated here so the model need not guess
    const routeRule = `The route search (A* on the 2 m grid) finds the quickest safe path between stops. It never crosses ground steeper than ${max}° (A2). Walking time grows with slope (Tobler's hiking function); ground steeper than ${comfort}° (A1) counts 1.5 times as slow, and ground rougher than 10 cm counts slower too. So a route bends when the detour is quicker or avoids no-go ground.`;
    return { data: { ...data, routeRule: part === "legs" || part === "all" ? routeRule : undefined, note: p.routeFound ? undefined : "No route has been found yet: legs, radio gaps and checks are empty until the crew presses Find safest route." }, facts };
  },
};

export const TOOLS: ToolDef[] = [getSite, getStops, getStop, getHazardsNear, getTerrain, getConditions, getPlan];

/** The tool the model must end with: its answer and what it relied on. Not a data tool. */
export const FINAL_ANSWER = "final_answer";

/** Tool definitions in the OpenAI chat-completions format (all five providers accept it). */
export function toolSpecs(zoneKeys: string[], withFinal = true): unknown[] {
  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  });
  const specs = TOOLS.map((t) => {
    const props: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(t.params)) props[k] = { ...p, ...(k === "zone" ? { enum: zoneKeys } : {}) };
    return fn(t.name, t.description, props, t.required);
  });
  if (!withFinal) return specs; // providers that answer in plain text
  specs.push(
    fn(
      FINAL_ANSWER,
      "Give the final answer to the crew. Call it exactly once, after looking up the data.",
      {
        answer: { type: "string", description: "The answer in simple English, at most 120 words." },
        sources: { type: "array", items: { type: "string" }, description: "IDs of the sources the answer relies on, as given in the tool results (e.g. R1, R2, S4, PLAN)." },
        cannot_tell: { type: "boolean", description: "true if the tool results do not answer the question." },
        off_topic: { type: "boolean", description: "true if the question is not about this walk, the walk zone or its data." },
      },
      ["answer", "sources", "cannot_tell", "off_topic"],
    ),
  );
  return specs;
}

/** Runs one data tool. Mistakes in the call come back as an error message the model can act on. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ ok: boolean; content: string; facts: Fact[] }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, content: JSON.stringify({ error: `Unknown tool "${name}".` }), facts: [] };
  try {
    const r = await tool.run(args, ctx);
    // tell the model which source IDs this result rests on, so it can name them
    const sources = [...new Set(r.facts.map((f) => f.ref))];
    return { ok: true, content: JSON.stringify({ ...(r.data as object), sources }), facts: r.facts };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, content: JSON.stringify({ error: e.message }), facts: [] };
    throw e; // a broken package file is our problem, not the model's
  }
}
