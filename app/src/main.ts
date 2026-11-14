import "./style.css";
import { type HeightGrid, type LonLat, type RouteGrid, bilinear, cellIndex, inside, loadBinary, loadGridMeta, metresBetween } from "./grid";
import { DEFAULT_COST, type CostModel, isPassable } from "./router";
import { type Conditions, type PlanInput, type PlanResult, type Sample, computePlan, fmtClock, routeLegs, suggestOrder } from "./plan";
import { MapView, type OverlayKey, type StopPin } from "./map";
import { type MissionPackage, type PovImage, assumption, cameraName, isCloseUp } from "./pkg";
import { type ProfilePoint, bindChartHover, profileChart, tempChart } from "./charts";
import {
  type FieldNote, type WalkState, type WalkStop, bearingDeg, compass, currentStop, headHomeNow, leaveStop, logEvent, lookAhead,
  minutesToRadio, nextTarget, plannedStopMin, projectedReturnMin, skipNext, startWalk, stayLonger, tick, trackAt as trackAtClock,
} from "./walk";
import { hudHtml, relativeBearing } from "./hud";
import { type WalkReport, buildReport, reportHtml, reportMapSvg } from "./report";
import { earthMarsLightTime } from "./lighttime";

window.CESIUM_BASE_URL = CESIUM_BASE_URL;

interface ZoneInfo {
  key: string;
  code: string;
  name: string;
  path: string;
  title: string;
  description: string;
  stops: number;
}

let PKG = "";
let zones: ZoneInfo[] = [];
let zone: ZoneInfo;

// ------------------------------------------------------------------ types and state
interface StopState extends LonLat {
  id: string;
  name: string;
  minutes: number;
  tasks: string[];
  unit?: string;
  notes?: string;
  crewNote: string;
  povIds: string[];
  custom: boolean;
  lastWalk?: "visited" | "skipped";
}

interface Unit {
  symbol: string;
  name: string;
  rings: number[][][];
}

interface Weather {
  sols: number[];
  date_range?: string;
  per_sol: { sol: number; air_c: [number, number] | null; ground_c: [number, number] | null; pressure_pa: [number, number, number] | null }[];
  hourly_median: { hour: number; air_c: number | null; ground_c: number | null }[];
  walk_hours_air_c: [number, number] | null;
  daylight: { days: { sol: number; sunrise_lmst: string; sunset_lmst: string }[]; check: { max_diff_min?: number } };
}

interface SpaceWeather {
  retrieved_utc: string;
  noaa: {
    flares_7d: { C: number; M: number; X: number };
    strong_flares_7d: { class: string; max_time: string }[];
    protons_10mev_latest_pfu: number | null;
    where_measured: string;
  };
  donki: { status: string };
}

type Mode = "plan" | "preview" | "walk" | "replay";

interface TrackPoint extends Sample {
  D: number; // metres from the start of the whole walk
  clock: number; // planned clock time here (minutes)
  leg: number;
}

const state = {
  mode: "plan" as Mode,
  stops: [] as StopState[],
  plan: null as PlanResult | null,
  planError: "",
  approvedAt: null as string | null,
  selected: null as string | null,
  addMode: false,
  busy: false,
  compare: false,
  split: 0.5,
  show: { slope: true, geology: false, themis: false, rover: true } as Record<OverlayKey | "rover", boolean>,
  startClock: "08:45",
  photo: null as string | null,
  nextId: 1,
  ideas: [] as FieldNote[],
};

const preview = {
  playing: false,
  speed: 1,
  D: 0,
  pauseLeft: 0,
  stopIdx: -1, // index of the stop being shown (into state.stops)
  track: [] as TrackPoint[],
  stopD: [] as number[],
};

const walkUi = {
  w: null as WalkState | null,
  playing: false,
  speed: 1, // simulated minutes per real second (x60)
  follow: true,
  noteDraft: "",
  tasks: {} as Record<string, string[]>,
  home: { clock: -1, minutes: 0 },
  message: "",
  hud: false,
  carried: false, // ideas and stop results already copied back to the plan
};

const replay = { playing: false, speed: 2, clock: 0 };
let lastReport: { report: WalkReport; html: string } | null = null;

let pkg: MissionPackage;
let grid: RouteGrid;
let map: MapView;
let model: CostModel;
let units: Unit[] = [];
let weather: Weather | null = null;
let space: SpaceWeather | null = null;
let evaMin = 360;
let reserve = 0.3;
let baseAntenna = 3;
let suitAntenna = 1.8;
let maxRadioGap = 15;
const photos = new Map<string, PovImage>();

// ------------------------------------------------------------------ helpers
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")} min` : `${Math.round(m)} min`);
const clockToMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const degC = (c: number) => `${c < 0 ? "−" : ""}${Math.abs(Math.round(c))}°C`;

function fmtAssumption(a: MissionPackage["assumptions"][number]): string {
  const v =
    a.unit === "fraction" && typeof a.value === "number" ? `${Math.round(a.value * 100)}%`
    : a.unit === "deg" ? `${a.value}°`
    : `${a.value ?? ""} ${a.unit ?? ""}`;
  return v.trim() ? `${esc(a.statement)}: ${esc(v.trim())}` : esc(a.statement);
}

function roverSols(): string {
  const sols = pkg.roverWaypoints.map((w) => w.sol);
  return sols.length ? `${Math.min(...sols)}–${Math.max(...sols)}` : "–";
}

const PICK_TASK = "Pick up the tube";
const isDepot = () => pkg.objectives.some((o) => o.id === "obj-depot");

function tubesPicked(): { picked: number; total: number } {
  const total = state.stops.filter((s) => s.tasks.includes(PICK_TASK)).length;
  const picked = Object.values(walkUi.tasks).filter((t) => t.includes(PICK_TASK)).length;
  return { picked, total };
}

function depotNote(): string {
  if (!isDepot()) return "";
  return `<p class="note">The depot stops are where Perseverance parked while dropping the tubes (sols 652–692). Each tube should lie within a few metres of its stop, but NASA publishes the exact spots only as a picture: check the <a href="https://www.jpl.nasa.gov/images/pia25682-perseverances-three-forks-sample-depot-map/" target="_blank" rel="noopener">depot map PIA25682</a> (assumption A14).</p>`;
}

function unitAt(p: LonLat): Unit | null {
  for (const u of units) {
    for (const ring of u.rings) {
      let inPoly = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inPoly = !inPoly;
      }
      if (inPoly) return u;
    }
  }
  return null;
}

function conditions(): Conditions | undefined {
  if (!weather || !space) return undefined;
  const d = weather.daylight.days[0];
  const x = space.noaa.strong_flares_7d.filter((f) => f.class.startsWith("X")).pop();
  const ret = Date.parse(space.retrieved_utc);
  return {
    sunriseMin: clockToMin(d.sunrise_lmst),
    sunsetMin: clockToMin(d.sunset_lmst),
    afterSunriseMin: assumption(pkg, "A10", 30),
    beforeSunsetMin: assumption(pkg, "A11", 60),
    protonPfu: space.noaa.protons_10mev_latest_pfu,
    protonLimitPfu: assumption(pkg, "A12", 10),
    xFlareHoursAgo: x ? (ret - Date.parse(x.max_time)) / 3.6e6 : null,
    xFlareCareHours: assumption(pkg, "A13", 24),
    dataDate: new Date(ret).toUTCString().slice(5, 16),
  };
}

function planInput(): PlanInput {
  const b = pkg.site.base.position;
  return {
    grid, model,
    base: { lon: b.lon, lat: b.lat, antennaM: baseAntenna },
    suitAntennaM: suitAntenna,
    stops: state.stops.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, minutes: s.minutes })),
    evaMin, reserveFraction: reserve, maxRadioGapMin: maxRadioGap, startMin: clockToMin(state.startClock),
    conditions: conditions(),
  };
}

function markStale(): void {
  state.plan = null;
  state.planError = "";
  state.approvedAt = null;
  map.clearRoute();
}

function pins(): StopPin[] {
  const b = pkg.site.base.position;
  return [
    { id: "base", label: "H", name: "Habitat", kind: "base", lon: b.lon, lat: b.lat },
    ...state.stops.map((s, i) => ({ id: s.id, label: String(i + 1), name: s.name, kind: s.custom ? ("new" as const) : ("stop" as const), lon: s.lon, lat: s.lat })),
  ];
}

function refreshMap(): void {
  map.setPins(pins(), state.selected);
}

// ------------------------------------------------------------------ whole-route track (profile, walk-through)
function buildTrack(p: PlanResult): { track: TrackPoint[]; stopD: number[] } {
  const track: TrackPoint[] = [];
  const stopD: number[] = [];
  let D = 0;
  let clock = clockToMin(state.startClock);
  p.legs.forEach((leg, li) => {
    for (const s of leg.samples) {
      if (track.length && s.d === 0) continue;
      track.push({ ...s, D: D + s.d, clock: clock + s.t, leg: li });
    }
    D += leg.distanceM;
    clock += leg.minutes;
    if (li < p.legs.length - 1) {
      stopD.push(D);
      clock += state.stops[li]?.minutes ?? 0;
    }
  });
  return { track, stopD };
}

function profilePoints(track: TrackPoint[]): ProfilePoint[] {
  return track.map((t) => ({ d: t.D, h: t.h, slope: t.slope }));
}

function trackAt(D: number): TrackPoint {
  const t = preview.track;
  let lo = 0;
  let hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid].D <= D) lo = mid;
    else hi = mid;
  }
  const a = t[lo];
  const b = t[hi];
  const f = b.D > a.D ? Math.min(1, Math.max(0, (D - a.D) / (b.D - a.D))) : 0;
  return { ...a, lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f, h: a.h + (b.h - a.h) * f, D, clock: a.clock + (b.clock - a.clock) * f };
}

// ------------------------------------------------------------------ panel: shared pieces
function tabs(): string {
  const canWalk = !!state.approvedAt;
  const walkOn = state.mode === "walk" || state.mode === "replay";
  return `
  <nav class="tabs" aria-label="Screens">
    <button type="button" data-mode="plan" class="${!walkOn ? "on" : ""}">Plan</button>
    <button type="button" data-mode="walk" class="${walkOn ? "on" : ""}" ${canWalk ? "" : "disabled"} title="${canWalk ? "Tablet view for the walk" : "Approve the plan first"}">Walk (tablet)</button>
  </nav>`;
}

/** Planned arrival clock time at each stop, in plan order. */
function plannedArrivals(p: PlanResult): number[] {
  const out: number[] = [];
  let clock = clockToMin(state.startClock);
  p.legs.forEach((leg, i) => {
    clock += leg.minutes;
    if (i < p.legs.length - 1) {
      out.push(clock);
      clock += state.stops[i]?.minutes ?? 0;
    }
  });
  return out;
}

function photoGrid(ids: string[]): string {
  const pics = ids.map((id) => photos.get(id)).filter(Boolean) as PovImage[];
  if (!pics.length) return "";
  return `
    <div class="photos">
      ${pics.map((p) => `
        <figure class="photo" data-photo="${esc(p.imageId)}" tabindex="0" role="button" aria-label="Open photo">
          <img src="${PKG}${esc(p.urls.packagePath)}" alt="${esc(cameraName(p.instrument))} photo, sol ${p.sol}" loading="lazy">
          <figcaption>${isCloseUp(p) ? "Close-up · " : ""}${esc(cameraName(p.instrument))} · sol ${p.sol}</figcaption>
        </figure>`).join("")}
    </div>
    <p class="muted small">Real photos taken by the Perseverance rover at this spot. ${esc(pics[0].credit)}.</p>`;
}

function layerRow(key: OverlayKey | "rover", title: string, legend: string, source: string): string {
  return `
    <label class="layer">
      <input type="checkbox" data-layer="${key}" ${state.show[key] ? "checked" : ""}>
      <span class="layer-text"><b>${esc(title)}</b><small>${legend}</small></span>
      <span class="src" title="Data source">${esc(source)}</span>
    </label>`;
}

function renderPanel(): void {
  const panel = $("#panel");
  const scroll = panel.scrollTop;
  let html: string;
  if (state.mode === "walk") html = tabs() + walkPanel();
  else if (state.mode === "replay") html = tabs() + replayPanel();
  else if (state.mode === "preview") html = tabs() + previewPanel();
  else if (state.selected && state.selected !== "base") html = tabs() + stopCard();
  else html = tabs() + mainPanel();
  panel.innerHTML = html;
  panel.scrollTop = state.selected && state.mode === "plan" ? 0 : scroll;
  if (state.mode === "walk") renderHud(); // keep the helmet in step with the tablet (stay longer, skip, notes)
}

// ------------------------------------------------------------------ plan mode
function conditionsSection(): string {
  if (!weather || !space) return "";
  const d = weather.daylight.days[0];
  const pres = weather.per_sol.map((s) => s.pressure_pa?.[1]).filter((v): v is number => typeof v === "number");
  const presMean = pres.length ? Math.round(pres.reduce((a, b) => a + b, 0) / pres.length) : null;
  const wa = weather.walk_hours_air_c;
  const start = clockToMin(state.startClock) / 60;
  const end = state.plan ? state.plan.totals.finishClockMin / 60 : start + 4;
  const c = conditions()!;
  const storm = c.protonPfu !== null && c.protonPfu >= c.protonLimitPfu;
  const f = space.noaa.flares_7d;
  return `
  <section>
    <h3>Conditions <small class="muted">at ${esc(zone.name)}</small></h3>
    <div class="summary cond">
      <div><span>Daylight</span><b>${esc(d.sunrise_lmst)}–${esc(d.sunset_lmst)}</b></div>
      <div><span>Air, walk hours</span><b>${wa ? `${degC(wa[0])} to ${degC(wa[1])}` : "–"}</b></div>
      <div><span>Air pressure</span><b>${presMean ?? "–"} Pa</b></div>
    </div>
    <p class="chart-legend"><i class="lg air"></i>Air <i class="lg ground"></i>Ground <span class="muted">· typical sol, local Mars time</span></p>
    ${tempChart(weather.hourly_median.map((h) => ({ hour: h.hour, air: h.air_c, ground: h.ground_c })), {
      sunriseH: clockToMin(d.sunrise_lmst) / 60, sunsetH: clockToMin(d.sunset_lmst) / 60, walkStartH: start, walkEndH: end,
    })}
    <p class="muted small">Measured by Perseverance here, sols ${weather.sols[0]}–${weather.sols[weather.sols.length - 1]} (${esc(weather.date_range ?? "")}): real reference values for this place and season, not today's weather. Sunrise and sunset are computed (Mars24 equations, within ${weather.daylight.check.max_diff_min ?? "?"} min of the rover's own times).</p>
    <div class="sunbox">
      <div class="sunhead"><b>Sun activity</b> <span class="pill ${storm ? "bad" : c.xFlareHoursAgo !== null && c.xFlareHoursAgo <= c.xFlareCareHours ? "care" : "ok"}">${storm ? "Storm" : "Quiet"}</span></div>
      <small>${f.M} medium (M) and ${f.X} strong (X) flares in the last 7 days. Particle level ${c.protonPfu ?? "unknown"} pfu (storm level ${c.protonLimitPfu}). ${esc(space.noaa.where_measured)} NOAA GOES, retrieved ${esc(c.dataDate)}.${space.donki.status !== "ok" ? " NASA DONKI could not be reached." : ""}</small>
    </div>
  </section>`;
}

function mainPanel(): string {
  const goal = pkg.objectives[0];
  const geo = pkg.layers.find((l) => l.id === "geology-sim3464");
  const geoLegend = geo?.display?.legend ?? [];
  const slopeCheck = pkg.layers.find((l) => l.id === "slope-2m")?.caveats?.[0] ?? "";
  const p = state.plan;
  return `
  <header class="p-head">
    <p class="eyebrow">Zone ${esc(zone.code)} · ${esc(pkg.site.region)}, Mars</p>
    <h1>${esc(zone.name)} walk</h1>
    <p class="muted">Plan tomorrow's walk. Everything on this screen works without internet.</p>
  </header>
  ${depotNote()}

  <section class="goal">
    <p class="eyebrow">Science goal</p>
    <h2>${esc(goal.title)}</h2>
    <p>${esc(goal.question)}</p>
    ${goal.whyHumans ? `<p class="muted"><b>Why people:</b> ${esc(goal.whyHumans)}</p>` : ""}
  </section>

  <section>
    <h3>Map layers</h3>
    <div class="layers">
      <div class="layer fixed">
        <span class="swatch photo"></span>
        <span class="layer-text"><b>Photo map</b><small>HiRISE 25 cm near the walk, CTX 6 m around it</small></span>
        <span class="src">R1</span>
      </div>
      ${layerRow("slope", "Steep ground", `<i class="sw" style="background:#ECB026"></i>15–25° take care <i class="sw" style="background:#D63027"></i>over 25° no-go`, "R1")}
      ${layerRow("geology", "Rock types", geoLegend.map((g) => `<span class="geo"><i class="sw" style="background:${esc(g.color)}"></i>${esc(g.label)}</span>`).join(""), "R2")}
      ${layerRow("themis", "Rocky or dusty ground", "Night-time heat: brighter = rockier (100 m detail)", "R1")}
      ${layerRow("rover", "Perseverance path", `Where the rover drove (sols ${roverSols()})`, "S1")}
    </div>
    <label class="compare"><input type="checkbox" id="compare" ${state.compare ? "checked" : ""}> Compare side by side <small>(photo on the left, layers on the right)</small></label>
    ${state.show.geology && geo?.caveats?.[0] ? `<p class="note">${esc(geo.caveats[0])}</p>` : ""}
  </section>

  <section>
    <h3>Stops <small class="muted">in walking order</small></h3>
    <ol class="stops">
      <li class="stop base"><span class="num base">H</span><div class="stop-text"><b>Habitat</b><small>Start and end · flat ground with a good radio view</small></div></li>
      ${state.stops.map((s, i) => `
        <li class="stop" data-open="${esc(s.id)}">
          <span class="num ${s.custom ? "new" : ""}">${i + 1}</span>
          <button class="stop-text link" data-open="${esc(s.id)}" type="button"><b>${esc(s.name)}</b><small>${s.unit ? esc(s.unit.split(": ")[1] ?? s.unit) + " · " : ""}${s.minutes} min${s.povIds.length ? ` · ${s.povIds.length} photos` : ""}${s.crewNote ? " · note" : ""}${s.lastWalk ? ` · <em class="${s.lastWalk}">${s.lastWalk} last walk</em>` : ""}</small></button>
          <span class="row-actions">
            <button type="button" data-move="${esc(s.id)}" data-dir="-1" title="Move earlier" ${i === 0 ? "disabled" : ""}>↑</button>
            <button type="button" data-move="${esc(s.id)}" data-dir="1" title="Move later" ${i === state.stops.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" data-remove="${esc(s.id)}" title="Remove stop">✕</button>
          </span>
        </li>`).join("")}
    </ol>
    <div class="row">
      <button type="button" id="add-stop" class="secondary">${state.addMode ? "Click the map…" : "+ Add stop"}</button>
      <button type="button" id="suggest-order" class="secondary" ${state.stops.length < 3 ? "disabled" : ""} title="Put the stops in a short walking order">Suggest order</button>
    </div>
    ${state.ideas.length ? `
      <div class="ideas">
        <p class="eyebrow">Ideas for next walk</p>
        ${state.ideas.map((n, i) => `<div class="idea"><span>${esc(n.text)} <small class="muted">(${fmtClock(n.clockMin)})</small></span><button type="button" class="secondary small-btn" data-idea="${i}">Add as stop</button></div>`).join("")}
      </div>` : ""}
  </section>

  <section>
    <button type="button" id="find-route" class="primary" ${state.busy || state.stops.length === 0 ? "disabled" : ""}>${state.busy ? "Finding the safest route…" : p ? "Find route again" : "Find safest route"}</button>
    ${state.planError ? `<p class="error">${esc(state.planError)}</p>` : ""}
    ${p ? planSummary(p) : `<p class="muted small">The route avoids ground steeper than ${model.maxSlopeDeg}° and picks the quickest safe way between stops.</p>`}
  </section>

  ${conditionsSection()}

  ${p ? safetySection(p) : ""}

  <footer class="credits">
    <p><b>Data:</b> HiRISE, CTX, THEMIS, MOLA via NASA Mars Trek (R1) · USGS SIM 3464 rock map (R2) · Perseverance photos (R5), rover positions (S1) and MEDA weather (S4), NASA/JPL-Caltech · sun activity from NOAA SWPC (S7). Route style after the Curiosity route map (R3); layer list after NASA Worldview (R4).</p>
    <p><b>Slope check:</b> ${esc(slopeCheck)}</p>
    <p><b>Starting values to confirm:</b> ${pkg.assumptions.filter((a) => a.status === "to_verify").map(fmtAssumption).join(" · ")}.</p>
  </footer>`;
}

function planSummary(p: PlanResult): string {
  const t = p.totals;
  const base = pkg.site.base.position;
  let far = 0;
  for (const l of p.legs) for (const s of l.samples) far = Math.max(far, metresBetween(grid.meta, base, s));
  const { track, stopD } = buildTrack(p);
  return `
    <div class="summary">
      <div><span>Distance</span><b>${km(t.distanceM)}</b></div>
      <div><span>Time with stops</span><b>${mins(t.totalMin)}</b></div>
      <div><span>Reserve</span><b class="${t.reserveFraction >= reserve ? "good" : "warn"}">${mins(Math.max(0, t.reserveMin))}</b></div>
      <div><span>Steepest</span><b class="${t.maxSlope > model.comfortSlopeDeg ? "warn" : "good"}">${Math.round(t.maxSlope)}°</b></div>
      <div><span>Climb / descent</span><b>${Math.round(t.ascentM)} / ${Math.round(t.descentM)} m</b></div>
      <div><span>Farthest from habitat</span><b>${km(far)}</b></div>
    </div>
    <p class="route-key"><i class="ln easy"></i>easy <i class="ln care"></i>take care (15–25°) <i class="ln dash"></i>no radio</p>
    <p class="chart-legend">Height along the route <span class="muted">· numbers are stops</span></p>
    ${profileChart(profilePoints(track), stopD.map((d, i) => ({ d, label: String(i + 1) })), model.comfortSlopeDeg)}
    <button type="button" id="walkthrough" class="secondary">▶ Walk-through</button>
    <ol class="legs">
      ${p.legs.map((l) => `
        <li><span class="leg-name">${esc(l.fromName)} → ${esc(l.toName)}</span>
        <span class="leg-stats">${km(l.distanceM)} · ${mins(l.minutes)} · up to ${Math.round(l.maxSlope)}°${l.noRadioMin >= 0.5 ? ` · <em>no radio ${Math.round(l.noRadioMin)} min</em>` : ""}</span></li>`).join("")}
    </ol>`;
}

function safetySection(p: PlanResult): string {
  const t = p.totals;
  const anyFail = p.checks.some((c) => c.status === "fail");
  return `
  <section>
    <h3>Safety check</h3>
    <label class="start">Walk starts at <input type="time" id="start" value="${esc(state.startClock)}"> <small class="muted">local Mars time</small></label>
    <ul class="checks">
      ${p.checks.map((c) => `<li class="check ${c.status}"><span class="dot"></span><div><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div></li>`).join("")}
      <li class="check ok"><span class="dot"></span><div><b>Turn-back times</b><small>Planned return ${fmtClock(t.finishClockMin)}. Latest return that keeps the reserve: ${fmtClock(t.latestFinishClockMin)}. If running late, leave the last stop by ${fmtClock(t.leaveLastStopByMin)}.</small></div></li>
    </ul>
    ${state.approvedAt
      ? `<div class="approved"><b>Plan approved</b> at ${esc(state.approvedAt)}. Copied to tablets and helmets when they dock.</div>
         <div class="row"><button type="button" id="go-walk" class="primary">Open the walk (tablet)</button><button type="button" id="save-plan" class="secondary">Save plan file</button></div>`
      : `<button type="button" id="approve" class="primary" ${anyFail ? "disabled" : ""}>Approve plan</button>
         ${anyFail ? `<p class="error">Fix the red items first.</p>` : ""}`}
  </section>`;
}

function stopCard(): string {
  const s = state.stops.find((x) => x.id === state.selected)!;
  const idx = state.stops.indexOf(s) + 1;
  const slope = grid.slope[cellIndex(grid.meta, s.lon, s.lat)];
  return `
  <button type="button" id="back" class="back">← All stops</button>
  <header class="p-head">
    <p class="eyebrow">Stop ${idx}${s.custom ? " · added by you" : ""}</p>
    <h1>${esc(s.name)}</h1>
    ${s.unit ? `<p class="muted">Rock type: ${esc(s.unit)}</p>` : ""}
    <p class="muted small">${s.lat.toFixed(5)}° N, ${s.lon.toFixed(5)}° E · ground slope ${slope === 255 ? "unknown" : slope + "°"}</p>
  </header>
  <section>
    <h3>What you will see</h3>
    ${photoGrid(s.povIds) || `<p class="muted">No rover photos here. This is a new place; the crew will be the first to see it up close.</p>`}
  </section>
  <section>
    <h3>Plan for this stop</h3>
    <label class="start">Time here <input type="number" id="stop-minutes" min="5" max="180" step="5" value="${s.minutes}"> min</label>
    ${s.tasks.length ? `<ul class="tasks">${s.tasks.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    <label class="field">Crew note <textarea id="stop-note" rows="2" placeholder="For example: bring the close-up camera">${esc(s.crewNote)}</textarea></label>
    ${s.notes ? `<p class="muted small">${esc(s.notes)}</p>` : ""}
  </section>
  <section class="row">
    <button type="button" class="secondary" id="fly-stop">Show on map</button>
    <button type="button" class="danger" data-remove="${esc(s.id)}">Remove stop</button>
  </section>`;
}

// ------------------------------------------------------------------ walk-through (preview)
function previewPanel(): string {
  const tp = trackAt(preview.D);
  const total = preview.track[preview.track.length - 1].D;
  const leg = state.plan!.legs[tp.leg];
  const stop = preview.stopIdx >= 0 ? state.stops[preview.stopIdx] : null;
  return `
  <header class="p-head">
    <p class="eyebrow">Walk-through</p>
    <h1>${esc(leg.fromName)} → ${esc(leg.toName)}</h1>
    <p class="muted">Planned time here <b>${fmtClock(tp.clock)}</b> · ${km(preview.D)} of ${km(total)} · slope ${tp.slope}°${tp.radio ? "" : " · no radio here"}</p>
  </header>
  <div class="controls">
    <button type="button" id="pv-play" class="primary">${preview.playing ? "Pause" : preview.D >= total ? "Play again" : "Play"}</button>
    <div class="seg" role="group" aria-label="Speed">${[1, 2, 4].map((s) => `<button type="button" data-pvspeed="${s}" class="${preview.speed === s ? "on" : ""}">${s}×</button>`).join("")}</div>
    <button type="button" id="pv-exit" class="secondary">Back to plan</button>
  </div>
  <p class="chart-legend">Height along the route</p>
  ${profileChart(profilePoints(preview.track), preview.stopD.map((d, i) => ({ d, label: String(i + 1) })), model.comfortSlopeDeg, preview.D)}
  ${stop ? `
    <section class="arrive">
      <p class="eyebrow">Stop ${preview.stopIdx + 1} · ${stop.minutes} min planned</p>
      <h2>${esc(stop.name)}</h2>
      ${stop.crewNote ? `<p class="crew-note">Note: ${esc(stop.crewNote)}</p>` : ""}
      ${photoGrid(stop.povIds) || `<p class="muted">No rover photos at this new stop.</p>`}
    </section>` : `<p class="muted small">The camera follows the planned route from behind. It pauses at each stop to show what the crew will see.</p>`}`;
}

function startPreview(): void {
  if (!state.plan) return;
  const { track, stopD } = buildTrack(state.plan);
  preview.track = track;
  preview.stopD = stopD;
  preview.D = 0;
  preview.pauseLeft = 0;
  preview.stopIdx = -1;
  preview.playing = true;
  state.mode = "preview";
  state.selected = null;
  map.resetDrone();
  renderPanel();
  ensureLoop();
}

function stepPreview(dt: number): void {
  if (!preview.playing || !preview.track.length) return;
  const total = preview.track[preview.track.length - 1].D;
  if (preview.pauseLeft > 0) {
    preview.pauseLeft -= dt;
    if (preview.pauseLeft <= 0) {
      preview.stopIdx = -1;
      panelDirty = true;
    }
    return;
  }
  const before = preview.D;
  preview.D = Math.min(total, preview.D + 45 * preview.speed * dt);
  const hit = preview.stopD.findIndex((d) => d > before && d <= preview.D);
  if (hit >= 0) {
    preview.D = preview.stopD[hit];
    preview.stopIdx = hit;
    preview.pauseLeft = 3.5 / Math.sqrt(preview.speed);
  }
  if (preview.D >= total) preview.playing = false;
  const p = trackAt(preview.D);
  const ahead = trackAt(Math.min(total, preview.D + 40));
  map.setWalker(p, "Crew (2)");
  map.droneView(p, metresBetween(grid.meta, p, ahead) > 1 ? bearingDeg(p, ahead) : 0);
  panelDirty = true;
}

// ------------------------------------------------------------------ walk (tablet)
function walkStops(): WalkStop[] {
  return state.stops.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, minutes: s.minutes, tasks: s.tasks, povIds: s.povIds, note: s.crewNote }));
}

function openWalk(): void {
  if (!state.plan || !state.approvedAt) return;
  if (!walkUi.w || walkUi.w.phase === "done") {
    walkUi.w = startWalk(state.plan.legs, walkStops(), clockToMin(state.startClock));
    walkUi.tasks = {};
    walkUi.home = { clock: -1, minutes: 0 };
    walkUi.message = "";
    walkUi.carried = false;
    map.setRoute(state.plan.legs, model.comfortSlopeDeg); // a skip or "head home" in an earlier walk may have changed it
  }
  if (walkUi.w.phase === "done") walkUi.hud = false;
  state.mode = "walk";
  state.selected = null;
  walkUi.playing = false;
  map.setWalker(walkUi.w.pos, "Crew (2)");
  map.setTrack(walkUi.w.track);
  map.setNotes(walkUi.w.notes);
  map.resetDrone();
  placeWalkCamera();
  renderHud();
  renderPanel();
  ensureLoop();
}

/** Where the crew is facing: their walking direction, or towards the next place when standing still. */
function crewHeading(w: WalkState): number {
  const t = w.track;
  if (w.phase === "walking" && t.length >= 2) {
    const a = t[Math.max(0, t.length - 4)];
    const b = t[t.length - 1];
    if (metresBetween(grid.meta, a, b) > 1) return bearingDeg(a, b);
  }
  const target = nextTarget(w) ?? { ...pkg.site.base.position };
  return bearingDeg(w.pos, target);
}

function placeWalkCamera(): void {
  const w = walkUi.w;
  if (!w) return;
  if (walkUi.hud) map.firstPerson(w.pos, crewHeading(w));
  else if (walkUi.follow) map.topView(w.pos);
}

function renderHud(): void {
  const el = $("#hud");
  const w = walkUi.w;
  if (!walkUi.hud || state.mode !== "walk" || !w || w.phase === "done") {
    el.hidden = true;
    return;
  }
  const stop = currentStop(w);
  const target = nextTarget(w);
  const tgt = target ?? { ...pkg.site.base.position, name: "Habitat" };
  const order = state.stops.findIndex((s) => s.id === (stop ?? target)?.id) + 1;
  const alerts = walkAlerts(w);
  const top = alerts.find((a) => a.level === "bad") ?? alerts.find((a) => a.level === "care") ?? alerts[0] ?? null;
  el.innerHTML = hudHtml({
    label: stop ? `AT STOP ${order}` : target ? `NEXT · STOP ${order}` : "NEXT",
    target: stop ? stop.name : tgt.name,
    distM: stop ? null : metresBetween(grid.meta, w.pos, tgt),
    relDeg: stop ? null : relativeBearing(bearingDeg(w.pos, tgt), crewHeading(w)),
    timeLeftMin: w.startMin + evaMin - w.clockMin,
    radio: w.pos.radio,
    stopTimer: stop ? { elapsed: w.stopElapsed, planned: plannedStopMin(w) } : null,
    warning: top ? { level: top.level, text: top.short } : null,
  });
  el.hidden = false;
}

/** Minutes to walk straight home from where the crew is now (re-routed every few simulated minutes). */
function timeHome(w: WalkState): number {
  if (walkUi.home.clock >= 0 && Math.abs(w.clockMin - walkUi.home.clock) < 3) return walkUi.home.minutes;
  const r = routeLegs(planInput(), { id: "here", name: "Here", lon: w.pos.lon, lat: w.pos.lat, minutes: 0 }, []);
  walkUi.home = { clock: w.clockMin, minutes: r.ok ? r.legs[0].minutes : 0 };
  return walkUi.home.minutes;
}

/** text = tablet wording; short = helmet wording (at most 60 characters). */
type Alert = { level: "info" | "care" | "bad"; text: string; short: string };

function walkAlerts(w: WalkState): Alert[] {
  const out: Alert[] = [];
  if (w.phase === "done") return out;
  const start = w.startMin;
  const latest = start + evaMin * (1 - reserve);
  const proj = projectedReturnMin(w);
  const turnBy = latest - timeHome(w);
  const stopsLeft = w.phase === "walking" ? w.queue.length : w.queue.length - 1;
  if (proj > start + evaMin) out.push({ level: "bad", text: `Back at ${fmtClock(proj)}: past the ${evaMin / 60} h walk limit. Skip a stop or head home now.`, short: "Past the walk limit · head home" });
  else if (proj > latest) out.push({ level: "care", text: `Running late: back at ${fmtClock(proj)}, but the reserve rule needs you back by ${fmtClock(latest)}.${stopsLeft > 0 ? " Skip the next stop or leave sooner." : ""}`, short: "Running late · reserve at risk" });
  if (stopsLeft > 0 && w.clockMin >= turnBy - 25) {
    const n = Math.round(turnBy - w.clockMin);
    out.push(n > 0
      ? { level: "care", text: `Turn back in ${n} min to keep your reserve.`, short: `Turn back in ${n} min to keep your reserve` }
      : { level: "bad", text: "Turn back now to keep your reserve.", short: "Turn back now" });
  }
  const c = conditions();
  if (c && w.clockMin > c.sunsetMin - c.beforeSunsetMin) out.push({ level: "bad", text: `Sunset at ${fmtClock(c.sunsetMin)}. Head home now.`, short: "Sunset soon · head home" });
  if (w.phase === "at_stop") {
    const name = currentStop(w)!.name;
    if (w.stopElapsed < 3) out.push({ level: "info", text: `You have arrived at ${name}.`, short: `Arrived · ${name}`.slice(0, 60) });
    return out;
  }
  if (!w.pos.radio) {
    const back = minutesToRadio(w);
    out.push({ level: "care", text: `No radio to the habitat now. Stay together.${back !== null ? ` Contact back in about ${Math.max(1, Math.round(back))} min.` : ""}`, short: "No radio · stay together" });
  } else {
    const ahead = lookAhead(w, 60);
    const lost = ahead.find((p) => !p.radio);
    if (lost) {
      const regain = w.legs[0].samples.find((p) => p.t > lost.t && p.radio);
      const len = Math.max(1, Math.round((regain ? regain.t : w.legs[0].minutes) - lost.t));
      out.push({ level: "info", text: `Radio drops ahead for about ${len} min.`, short: `Radio drops ahead · ${len} min` });
    }
  }
  const ahead = lookAhead(w, 60);
  const maxSlope = ahead.reduce((a, p) => Math.max(a, p.slope), 0);
  if (maxSlope > model.comfortSlopeDeg) out.push({ level: "care", text: `Steeper ground ahead (up to ${maxSlope}°). Slow down.`, short: `Steep ground ahead · ${maxSlope}°` });
  if (ahead.some((p, i) => i % 5 === 0 && unitAt(p)?.symbol === "Aeb")) out.push({ level: "care", text: "Sand ripples ahead (eolian bedform unit). Keep to firm ground.", short: "Sand ripples ahead · keep to firm ground" });
  if (ahead.some((p) => { const r = grid.rough[cellIndex(grid.meta, p.lon, p.lat)]; return r !== 255 && r >= 25; })) out.push({ level: "info", text: "Bumpy, rocky ground ahead.", short: "Rocky ground ahead" });
  return out;
}

function arrow(deg: number): string {
  return `<svg class="arrow" viewBox="0 0 40 40" aria-hidden="true"><g transform="rotate(${deg.toFixed(0)} 20 20)"><path d="M20 4 L31 30 L20 24 L9 30 Z" fill="currentColor"/></g></svg>`;
}

function walkPanel(): string {
  const w = walkUi.w!;
  const plan = state.plan!;
  if (w.phase === "done") return walkSummary(w, plan);
  const proj = projectedReturnMin(w);
  const latest = w.startMin + evaMin * (1 - reserve);
  const behind = proj - plan.totals.finishClockMin;
  const status = proj > latest ? { cls: "bad", text: "Reserve at risk" } : behind > 5 ? { cls: "care", text: `${Math.round(behind)} min behind plan` } : { cls: "ok", text: "On time" };
  const target = nextTarget(w);
  const tgt = target ?? { ...pkg.site.base.position, name: "Habitat" };
  const dist = metresBetween(grid.meta, w.pos, tgt);
  const brg = bearingDeg(w.pos, tgt);
  const stop = currentStop(w);
  const legMin = w.phase === "walking" ? w.legs[0].minutes - w.legT : 0;
  const alerts = walkAlerts(w);
  const done = new Set(w.log.map((l) => l.id));
  const skipped = new Set(w.skipped);
  const order = state.stops;
  const { track, stopD } = buildTrack(plan);
  const Dnow = w.walkedM;
  return `
  <header class="walk-head">
    <div><p class="eyebrow">Walk · ${esc(zone.name)}</p><b class="clock">${fmtClock(w.clockMin)}</b> <small class="muted">local Mars time</small></div>
    <div class="right"><span class="pill ${status.cls}">${status.text}</span><small class="muted">Back by ${fmtClock(proj)} · ${mins(Math.max(0, w.startMin + evaMin - w.clockMin))} of walk time left</small></div>
  </header>
  <div class="seg view-seg" role="group" aria-label="Map view">
    <button type="button" data-view="map" class="${walkUi.hud ? "" : "on"}">Tablet map</button>
    <button type="button" data-view="hud" class="${walkUi.hud ? "on" : ""}">Helmet view (HUD)</button>
  </div>

  <section class="navcard">
    ${arrow(brg)}
    <div>
      <p class="eyebrow">${stop ? `At stop ${order.findIndex((s) => s.id === stop.id) + 1}` : "Next"}</p>
      <h2>${esc(stop ? stop.name : target ? target.name : "Habitat")}</h2>
      <p class="muted">${stop
        ? `Time here ${Math.floor(w.stopElapsed)} of ${plannedStopMin(w)} min · then ${esc(target ? target.name : "Habitat")}, ${km(dist)} ${compass(brg)}`
        : `${km(dist)} · about ${mins(legMin)} · ${compass(brg)} (${Math.round(brg)}°)`}</p>
    </div>
  </section>

  ${alerts.length ? `<ul class="alerts">${alerts.map((a) => `<li class="alert ${a.level}">${esc(a.text)}</li>`).join("")}</ul>` : ""}
  ${walkUi.message ? `<p class="note">${esc(walkUi.message)}</p>` : ""}

  ${stop ? `
  <section class="arrive">
    <div class="timer"><span style="width:${Math.min(100, (w.stopElapsed / plannedStopMin(w)) * 100).toFixed(1)}%"></span></div>
    ${stop.note ? `<p class="crew-note">Crew note: ${esc(stop.note)}</p>` : ""}
    <h3>What you will see</h3>
    ${photoGrid(stop.povIds) || `<p class="muted">No rover photos here: a new place.</p>`}
    ${stop.tasks.length ? `<h3>Tasks</h3><ul class="checklist">${stop.tasks.map((t) => `<li><label><input type="checkbox" data-task="${esc(t)}" ${(walkUi.tasks[stop.id] ?? []).includes(t) ? "checked" : ""}> ${esc(t)}</label></li>`).join("")}</ul>` : ""}
    <div class="row three">
      <button type="button" id="w-stay" class="secondary">Stay 10 more min</button>
      <button type="button" id="w-leave" class="primary">Leave now</button>
      <button type="button" id="w-skip" class="secondary" ${w.queue.length < 2 ? "disabled" : ""}>Skip next stop</button>
    </div>
  </section>` : `
  <section class="row">
    <button type="button" id="w-skip" class="secondary" ${w.legs[0]?.toId === "base" ? "disabled" : ""}>Skip next stop</button>
    <button type="button" id="w-home" class="secondary" ${w.legs[0]?.toId === "base" ? "disabled" : ""}>Head home now</button>
  </section>`}

  <section>
    <label class="field">Field note <input type="text" id="w-note" value="${esc(walkUi.noteDraft)}" placeholder="Pinned to where you are now"></label>
    <div class="row"><button type="button" id="w-pin" class="secondary">Pin note</button><button type="button" id="w-idea" class="secondary">Mark for next walk</button></div>
  </section>

  <section>
    <h3>Progress <small class="muted">${km(w.walkedM)} walked of ${km(w.plannedM)} planned${isDepot() ? ` · tubes picked up ${tubesPicked().picked} of ${tubesPicked().total}` : ""}</small></h3>
    <ol class="progress">
      ${order.map((s, i) => {
        const st = skipped.has(s.id) ? "skipped" : done.has(s.id) && !(stop && stop.id === s.id) ? "done" : stop && stop.id === s.id ? "here" : target && target.id === s.id ? "next" : "later";
        const label = { skipped: "skipped", done: "done", here: "here now", next: "next", later: "" }[st];
        return `<li class="${st}"><span class="num">${i + 1}</span>${esc(s.name)} <small>${label}</small></li>`;
      }).join("")}
    </ol>
    ${profileChart(profilePoints(track), stopD.map((d, i) => ({ d, label: String(i + 1) })), model.comfortSlopeDeg, Math.min(Dnow, track[track.length - 1].D))}
  </section>

  <section class="demo">
    <p class="eyebrow">Demo controls</p>
    <p class="muted small">On Mars the suits' navigation gives the position. Here the crew walks the approved route in time-lapse.</p>
    <div class="controls">
      <button type="button" id="w-play" class="primary">${walkUi.playing ? "Pause" : "Play"}</button>
      <div class="seg" role="group" aria-label="Speed">${[[0.5, "×30"], [1, "×60"], [2, "×120"]].map(([v, l]) => `<button type="button" data-wspeed="${v}" class="${walkUi.speed === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <button type="button" id="w-jump" class="secondary">Jump to next event</button>
    </div>
    <label class="compare"><input type="checkbox" id="w-follow" ${walkUi.follow ? "checked" : ""}> Map follows the crew</label>
  </section>`;
}

function walkSummary(w: WalkState, plan: PlanResult): string {
  const visited = w.log.map((l) => l.name);
  const actual = w.clockMin - w.startMin;
  return `
  <header class="p-head">
    <p class="eyebrow">Walk complete</p>
    <h1>Back at the habitat</h1>
    <p class="muted">Arrived ${fmtClock(w.clockMin)} local Mars time.</p>
  </header>
  <div class="summary">
    <div><span>Walked</span><b>${km(w.walkedM)}</b></div>
    <div><span>Planned</span><b>${km(plan.totals.distanceM)}</b></div>
    <div><span>Time out</span><b>${mins(actual)}</b></div>
    <div><span>Planned time</span><b>${mins(plan.totals.totalMin)}</b></div>
    <div><span>Stops visited</span><b>${visited.length}</b></div>
    <div><span>Skipped</span><b class="${w.skipped.length ? "warn" : ""}">${w.skipped.length}</b></div>
    ${isDepot() ? `<div><span>Tubes picked up</span><b>${tubesPicked().picked} of ${tubesPicked().total}</b></div>` : ""}
  </div>
  <section>
    <h3>Visited</h3>
    <ul class="tasks">${w.log.map((l) => `<li>${esc(l.name)}: ${fmtClock(l.arrivedMin)}–${fmtClock(l.leftMin ?? l.arrivedMin)}, ${(walkUi.tasks[l.id] ?? []).length} tasks ticked</li>`).join("")}</ul>
    ${w.notes.length ? `<h3>Field notes</h3><ul class="tasks">${w.notes.map((n) => `<li>${fmtClock(n.clockMin)} · ${n.kind === "idea" ? "For next walk: " : ""}${esc(n.text)}</li>`).join("")}</ul>` : ""}
  </section>
  <p class="muted small">The walked line (white) and the plan (colours) stay on the map.</p>
  <div class="row three">
    <button type="button" id="replay" class="primary">Replay the walk</button>
    <button type="button" id="send-report" class="secondary">Send report to Earth</button>
    <button type="button" id="w-back" class="secondary">Back to plan</button>
  </div>`;
}

// ------------------------------------------------------------------ replay (after the walk)
function openReplay(): void {
  const w = walkUi.w;
  if (!w || w.phase !== "done" || !state.plan) return;
  state.mode = "replay";
  walkUi.hud = false;
  replay.clock = w.startMin;
  replay.playing = false;
  map.setRoute(state.plan.legs, model.comfortSlopeDeg);
  map.setTrack(w.track);
  map.setNotes(w.notes);
  map.setWalker(trackAtClock(w.track, replay.clock), "Crew (2)");
  map.flyToSite(pkg.site.center, 1.5);
  renderHud();
  renderPanel();
}

function replayPanel(): string {
  const w = walkUi.w!;
  const plan = state.plan!;
  const arrivals = plannedArrivals(plan);
  const visited = new Map(w.log.map((l) => [l.id, l]));
  const skipped = new Set(w.skipped);
  const done = w.track.filter((t) => t.clockMin <= replay.clock);
  let walked = 0;
  for (let i = 1; i < done.length; i++) walked += metresBetween(grid.meta, done[i - 1], done[i]);
  return `
  <header class="p-head">
    <p class="eyebrow">Walk replay</p>
    <h1>${esc(zone.name)} walk</h1>
    <p class="muted">The white line is where the crew walked; the colours are the plan.</p>
  </header>
  <div class="replay-clock"><b id="rp-clock">${fmtClock(replay.clock)}</b> <small class="muted">local Mars time · <span id="rp-dist">${km(walked)}</span> walked</small></div>
  <input type="range" id="rp-slider" min="${w.startMin}" max="${w.clockMin}" step="0.5" value="${replay.clock}" aria-label="Replay time">
  <div class="controls">
    <button type="button" id="rp-play" class="primary">${replay.playing ? "Pause" : replay.clock >= w.clockMin ? "Play again" : "Play"}</button>
    <div class="seg" role="group" aria-label="Speed">${[[1, "×60"], [2, "×120"], [4, "×240"]].map(([v, l]) => `<button type="button" data-rpspeed="${v}" class="${replay.speed === v ? "on" : ""}">${l}</button>`).join("")}</div>
  </div>
  <section>
    <h3>What happened</h3>
    <ol class="timeline">
      ${w.events.map((e) => `<li class="${e.clockMin <= replay.clock ? "past" : ""}"><button type="button" class="link" data-jump="${e.clockMin}"><b>${fmtClock(e.clockMin)}</b> ${esc(e.text)}</button></li>`).join("")}
    </ol>
  </section>
  <section>
    <h3>Plan and reality</h3>
    <table class="pvr">
      <thead><tr><th>Stop</th><th>Arrival</th><th>Time there</th></tr></thead>
      <tbody>
      ${state.stops.map((s, i) => {
        const v = visited.get(s.id);
        const late = v ? Math.round(v.arrivedMin - arrivals[i]) : 0;
        return `<tr><td>${i + 1}. ${esc(s.name)}</td>
          <td>${v ? `${fmtClock(v.arrivedMin)} <small class="${late > 5 ? "warn" : "muted"}">(${late >= 0 ? "+" : ""}${late} min)</small>` : `<small class="muted">${skipped.has(s.id) ? "skipped" : "not reached"}</small>`}</td>
          <td>${v && v.leftMin !== undefined ? `${Math.round(v.leftMin - v.arrivedMin)} of ${s.minutes} min` : "–"}</td></tr>`;
      }).join("")}
      </tbody>
    </table>
  </section>
  <div class="row">
    <button type="button" id="send-report" class="primary">Send report to Earth</button>
    <button type="button" id="w-back" class="secondary">Back to plan</button>
  </div>`;
}

function stepReplay(dt: number): void {
  const w = walkUi.w;
  if (!w || !replay.playing) return;
  replay.clock = Math.min(w.clockMin, replay.clock + replay.speed * dt);
  if (replay.clock >= w.clockMin) replay.playing = false;
  map.setWalker(trackAtClock(w.track, replay.clock), "Crew (2)");
  panelDirty = true;
}

// ------------------------------------------------------------------ report
function makeReport(): { report: WalkReport; html: string } | null {
  const w = walkUi.w;
  const plan = state.plan;
  if (!w || !plan) return null;
  const arrivals = plannedArrivals(plan);
  const c = conditions();
  const now = new Date();
  const report = buildReport({
    title: `${zone.name} walk`,
    site: pkg.site.name,
    region: pkg.site.region,
    generatedUtc: now.toISOString().slice(0, 16).replace("T", " "),
    plan,
    startMin: clockToMin(state.startClock),
    stops: state.stops.map((s, i) => ({ id: s.id, name: s.name, minutes: s.minutes, tasks: s.tasks, unit: s.unit, plannedArrivalMin: arrivals[i] })),
    walk: w,
    tasksDone: walkUi.tasks,
    base: pkg.site.base.position,
    conditions: weather && c
      ? { sunrise: fmtClock(c.sunriseMin), sunset: fmtClock(c.sunsetMin), airWalkC: weather.walk_hours_air_c, airDates: weather.date_range ?? "", sun: plan.checks.find((x) => x.id === "sun")?.detail ?? "" }
      : null,
    sources: pkg.sources.map((s) => ({ id: s.id, name: s.name, credit: s.credit })),
    assumptions: pkg.assumptions.filter((a) => a.status === "to_verify").map((a) => {
      const v = a.unit === "fraction" && typeof a.value === "number" ? `${Math.round(a.value * 100)}%` : a.unit === "deg" ? `${a.value}°` : `${a.value ?? ""} ${a.unit ?? ""}`.trim();
      return v ? `${a.id} ${a.statement}: ${v}` : `${a.id} ${a.statement}`;
    }),
    lightTime: earthMarsLightTime(now),
  });
  const svg = reportMapSvg(
    plan.legs.map((l) => l.points),
    w.track,
    state.stops.map((s, i) => ({ lon: s.lon, lat: s.lat, label: String(i + 1), status: report.stops[i].status })),
    pkg.site.base.position,
    w.notes,
  );
  return { report, html: reportHtml(report, svg) };
}

function download(name: string, text: string, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function openReportModal(): void {
  lastReport = makeReport();
  const m = $("#modal");
  if (!lastReport) return;
  const r = lastReport.report;
  const t = r.transmission;
  m.innerHTML = `
    <div class="lb-inner modal-inner" role="dialog" aria-label="Walk report">
      <p class="eyebrow">Walk report</p>
      <h2>Ready to send to Earth</h2>
      <p>${r.summary.stopsVisited} stops visited, ${r.summary.stopsSkipped} skipped, ${(r.summary.walkedM / 1000).toFixed(2)} km walked, ${r.notes.length} field notes.</p>
      <div class="summary cond">
        <div><span>Earth today</span><b>${t.distanceAu} AU</b></div>
        <div><span>Distance</span><b>${t.distanceMkm} M km</b></div>
        <div><span>Signal takes</span><b>${Math.round(t.oneWayMin)} min</b></div>
      </div>
      <p class="muted small">On today's distance the report would reach Earth about ${Math.round(t.oneWayMin)} minutes after it is sent, and a reply would take at least ${Math.round(t.oneWayMin * 2)} minutes. Distance from JPL's planet position elements. This demo does not transmit anything: save the report to share it.</p>
      <div class="row three">
        <button type="button" id="save-report" class="primary">Save report (HTML)</button>
        <button type="button" id="save-report-json" class="secondary">Save data (JSON)</button>
        <button type="button" id="modal-close" class="secondary">Close</button>
      </div>
    </div>`;
  m.hidden = false;
}

function stepWalk(dtReal: number): void {
  const w = walkUi.w;
  if (!w || !walkUi.playing || w.phase === "done") return;
  const events = tick(w, walkUi.speed * dtReal);
  for (const e of events) {
    if (e.type === "arrived" || e.type === "home") walkUi.playing = e.type === "home" ? false : walkUi.playing;
    if (e.type === "home") walkUi.message = "";
  }
  map.setWalker(w.pos, "Crew (2)");
  map.setTrack(w.track);
  if ((w.phase as string) === "done" && walkUi.hud) walkUi.hud = false; // tick() may have ended the walk
  placeWalkCamera();
  renderHud();
  panelDirty = true;
}

function jumpToNextEvent(): void {
  const w = walkUi.w;
  if (!w) return;
  for (let i = 0; i < 4000 && w.phase !== "done"; i++) {
    const ev = tick(w, 0.1);
    if (ev.length || walkAlerts(w).some((a) => a.level !== "info")) break;
  }
  if (w.phase === "done") walkUi.hud = false;
  map.setWalker(w.pos, "Crew (2)");
  map.setTrack(w.track);
  placeWalkCamera();
  renderHud();
  renderPanel();
}

function backToPlan(): void {
  const w = walkUi.w;
  if (w && w.phase === "done" && !walkUi.carried) {
    state.ideas = [...state.ideas, ...w.notes.filter((n) => n.kind === "idea")];
    const visited = new Set(w.log.map((l) => l.id));
    const skipped = new Set(w.skipped);
    for (const s of state.stops) s.lastWalk = visited.has(s.id) ? "visited" : skipped.has(s.id) ? "skipped" : undefined;
    walkUi.carried = true;
  }
  state.mode = "plan";
  walkUi.playing = false;
  walkUi.hud = false;
  replay.playing = false;
  preview.playing = false;
  renderHud();
  map.setWalker(null);
  if (!w || w.phase !== "done") map.setTrack([]);
  if (state.plan) map.setRoute(state.plan.legs, model.comfortSlopeDeg);
  refreshMap();
  renderPanel();
}

// ------------------------------------------------------------------ animation loop
let panelDirty = false;
let lastPanel = 0;
let looping = false;
let lastT = 0;

function step(dt: number): void {
  if (state.mode === "preview") stepPreview(dt);
  if (state.mode === "walk") stepWalk(dt);
  if (state.mode === "replay") stepReplay(dt);
}

function ensureLoop(): void {
  if (looping) return;
  looping = true;
  lastT = performance.now();
  const frame = (t: number) => {
    const dt = Math.min(0.25, (t - lastT) / 1000);
    lastT = t;
    step(dt);
    const typing = document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) && $("#panel").contains(document.activeElement);
    if (panelDirty && t - lastPanel > 250 && !typing) {
      renderPanel();
      panelDirty = false;
      lastPanel = t;
    }
    const active = (state.mode === "preview" && preview.playing) || (state.mode === "walk" && walkUi.playing) || (state.mode === "replay" && replay.playing);
    if (active || panelDirty) requestAnimationFrame(frame);
    else looping = false;
  };
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ plan actions
function renderLightbox(): void {
  const lb = $("#lightbox");
  const p = state.photo ? photos.get(state.photo) : null;
  if (!p) {
    lb.hidden = true;
    lb.innerHTML = "";
    return;
  }
  lb.hidden = false;
  lb.innerHTML = `
    <div class="lb-inner" role="dialog" aria-label="Rover photo">
      <img src="${PKG}${esc(p.urls.packagePath)}" alt="${esc(cameraName(p.instrument))} photo, sol ${p.sol}">
      <div class="lb-text">
        <b>${esc(cameraName(p.instrument))} · sol ${p.sol}${p.pointing?.mastAz_deg !== undefined ? ` · mast angle ${Math.round(((p.pointing.mastAz_deg % 360) + 360) % 360)}°` : ""}</b>
        <small>${esc(p.caption ?? "")} Credit: ${esc(p.credit)}.</small>
        ${p.urls.full ? `<a href="${esc(p.urls.full)}" target="_blank" rel="noopener">Full size at NASA (needs internet)</a>` : ""}
      </div>
      <button type="button" id="lb-close" class="secondary">Close</button>
    </div>`;
}

function select(id: string | null): void {
  state.selected = id;
  refreshMap();
  renderPanel();
}

function addStopAt(p: LonLat, name?: string): void {
  if (!inside(grid.meta, p.lon, p.lat)) {
    flash("That place is outside the walk area. Pick a spot inside the sharp photo map.");
    return;
  }
  if (!isPassable(grid, cellIndex(grid.meta, p.lon, p.lat), model)) {
    flash("That ground is too steep to stand on (over 25°). Pick another spot.");
    return;
  }
  const id = `stop-new-${state.nextId}`;
  const u = unitAt(p);
  state.stops.push({
    id, name: name ?? `New stop ${state.nextId}`, lon: p.lon, lat: p.lat, minutes: 20, tasks: ["Photos", "Notes"],
    unit: u ? `${u.symbol}: ${u.name}` : undefined, crewNote: "", povIds: [], custom: true,
  });
  state.nextId++;
  state.addMode = false;
  $("#add-hint").hidden = true;
  markStale();
  select(id);
}

function runPlan(): void {
  state.busy = true;
  renderPanel();
  setTimeout(() => {
    const res = computePlan(planInput());
    state.busy = false;
    state.approvedAt = null;
    walkUi.w = null;
    if (res.ok) {
      state.plan = res;
      state.planError = "";
      map.setRoute(res.legs, model.comfortSlopeDeg);
    } else {
      state.plan = null;
      state.planError = res.error ?? "No route found.";
      map.clearRoute();
    }
    renderPanel();
  }, 30);
}

function savePlan(): void {
  const p = state.plan!;
  const route = {
    id: `route-z2-${Date.now()}`,
    siteId: pkg.site.id,
    name: `${zone.name} walk`,
    status: "approved",
    constraints: {
      comfortSlope_deg: model.comfortSlopeDeg, maxSlope_deg: model.maxSlopeDeg, walkingSpeedFlat_kmh: +(model.flatSpeedMs * 3.6).toFixed(2),
      evaDuration_min: evaMin, reserveFraction: reserve, gravity_ms2: 3.71, crewSize: 2, buddyRule: true,
    },
    stopIds: ["base", ...state.stops.map((s) => s.id), "base"],
    legs: p.legs.map((l) => ({
      fromStopId: l.fromId, toStopId: l.toId,
      geometry: { type: "LineString", coordinates: l.points.map((q) => [+q.lon.toFixed(7), +q.lat.toFixed(7), +bilinear(grid.meta, grid.h, q.lon, q.lat).toFixed(2)]) },
      distance_m: Math.round(l.distanceM), ascent_m: Math.round(l.ascentM), descent_m: Math.round(l.descentM),
      maxSlope_deg: l.maxSlope, estMinutes: Math.round(l.minutes),
      lineOfSightToBase: l.noRadioMin < 0.5 ? "full" : l.noRadioMin >= l.minutes - 0.5 ? "none" : "partial",
    })),
    totals: {
      distance_m: Math.round(p.totals.distanceM), ascent_m: Math.round(p.totals.ascentM), descent_m: Math.round(p.totals.descentM),
      maxSlope_deg: p.totals.maxSlope, estMinutes: Math.round(p.totals.totalMin), reserveMinutes: Math.round(p.totals.reserveMin),
    },
    costModel: {
      version: "p1-1", algorithm: "A* (8 neighbours) on the 2 m routing grid; Tobler speed; no-go over the maximum slope",
      weights: { slope: model.careFactor, roughness: +(1 / model.roughScaleCm).toFixed(4) },
      inputLayerIds: ["routing-grid-2m", "slope-2m"],
    },
  };
  const file = {
    kind: "baroler-plan",
    route,
    startLmst: state.startClock,
    crewNotes: state.stops.filter((s) => s.crewNote).map((s) => ({ stopId: s.id, note: s.crewNote })),
    ideas: state.ideas,
  };
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `baroler-plan-${pkg.site.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

let flashTimer = 0;
function flash(msg: string): void {
  const r = $("#readout");
  r.textContent = msg;
  r.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    r.classList.remove("flash");
    if (r.textContent === msg) r.textContent = "";
  }, 3500);
}

// ------------------------------------------------------------------ events
function bindPanel(): void {
  const panel = $("#panel");
  panel.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const el = t.closest("[data-open],[data-move],[data-remove],[data-photo],[data-mode],[data-pvspeed],[data-wspeed],[data-rpspeed],[data-jump],[data-view],[data-idea],button") as HTMLElement | null;
    if (!el) return;
    const w = walkUi.w;
    if (el.dataset.view) {
      walkUi.hud = el.dataset.view === "hud";
      map.resetDrone();
      if (!walkUi.hud && w) map.topView(w.pos);
      placeWalkCamera();
      renderHud();
      renderPanel();
    } else if (el.dataset.rpspeed) {
      replay.speed = Number(el.dataset.rpspeed);
      renderPanel();
    } else if (el.dataset.jump && w) {
      replay.clock = Number(el.dataset.jump);
      replay.playing = false;
      map.setWalker(trackAtClock(w.track, replay.clock), "Crew (2)");
      renderPanel();
    } else if (el.dataset.mode) {
      if (el.dataset.mode === "walk") openWalk();
      else backToPlan();
    } else if (el.dataset.move) {
      ev.stopPropagation();
      const i = state.stops.findIndex((s) => s.id === el.dataset.move);
      const j = i + Number(el.dataset.dir);
      if (j < 0 || j >= state.stops.length) return;
      [state.stops[i], state.stops[j]] = [state.stops[j], state.stops[i]];
      markStale();
      refreshMap();
      renderPanel();
    } else if (el.dataset.remove) {
      ev.stopPropagation();
      state.stops = state.stops.filter((s) => s.id !== el.dataset.remove);
      markStale();
      select(null);
    } else if (el.dataset.photo) {
      state.photo = el.dataset.photo;
      renderLightbox();
    } else if (el.dataset.open) {
      const s = state.stops.find((x) => x.id === el.dataset.open);
      select(el.dataset.open);
      if (s) map.flyToPoint(s);
    } else if (el.dataset.pvspeed) {
      preview.speed = Number(el.dataset.pvspeed);
      renderPanel();
    } else if (el.dataset.wspeed) {
      walkUi.speed = Number(el.dataset.wspeed);
      renderPanel();
    } else if (el.dataset.idea) {
      const n = state.ideas.splice(Number(el.dataset.idea), 1)[0];
      if (n) addStopAt(n, n.text.length < 40 ? n.text : undefined);
    } else switch (el.id) {
      case "back": select(null); break;
      case "add-stop":
        state.addMode = !state.addMode;
        $("#add-hint").hidden = !state.addMode;
        renderPanel();
        break;
      case "find-route": runPlan(); break;
      case "suggest-order": {
        const b = pkg.site.base.position;
        const before = state.stops.map((s) => s.id).join();
        state.stops = suggestOrder({ lon: b.lon, lat: b.lat }, state.stops);
        if (state.stops.map((s) => s.id).join() !== before) {
          markStale();
          flash("Stops put in a short walking order. Press Find safest route.");
        } else flash("The stops are already in a short order.");
        refreshMap();
        renderPanel();
        break;
      }
      case "approve": {
        const d = new Date();
        state.approvedAt = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        renderPanel();
        break;
      }
      case "save-plan": savePlan(); break;
      case "go-walk": openWalk(); break;
      case "fly-stop": {
        const s = state.stops.find((x) => x.id === state.selected);
        if (s) map.flyToPoint(s);
        break;
      }
      case "walkthrough": startPreview(); break;
      case "pv-play": {
        const total = preview.track[preview.track.length - 1].D;
        if (preview.D >= total) { preview.D = 0; preview.stopIdx = -1; map.resetDrone(); }
        preview.playing = !preview.playing;
        renderPanel();
        ensureLoop();
        break;
      }
      case "pv-exit": backToPlan(); break;
      case "w-play":
        walkUi.playing = !walkUi.playing;
        renderPanel();
        ensureLoop();
        break;
      case "w-jump": jumpToNextEvent(); break;
      case "w-stay": if (w) { stayLonger(w, 10); renderPanel(); } break;
      case "w-leave": if (w) { leaveStop(w); renderPanel(); } break;
      case "w-skip":
        if (w) {
          const r = skipNext(w, planInput());
          walkUi.message = r.ok ? `Skipped ${r.skipped.name}. New route drawn from here.` : r.error;
          if (r.ok) map.setRoute(w.legs, model.comfortSlopeDeg);
          walkUi.home.clock = -1;
          renderPanel();
        }
        break;
      case "w-home":
        if (w && w.phase === "walking") {
          const r = headHomeNow(w, planInput());
          if (r.ok) {
            map.setRoute(w.legs, model.comfortSlopeDeg);
            walkUi.message = "Heading home on the safest route from here.";
          } else walkUi.message = r.error;
          renderHud();
          renderPanel();
        }
        break;
      case "replay": openReplay(); break;
      case "rp-play":
        if (w && replay.clock >= w.clockMin) replay.clock = w.startMin;
        replay.playing = !replay.playing;
        renderPanel();
        ensureLoop();
        break;
      case "send-report": openReportModal(); break;
      case "w-pin":
      case "w-idea":
        if (w) {
          const text = el.id === "w-idea" ? walkUi.noteDraft || "Look at next time" : walkUi.noteDraft;
          if (!text) { walkUi.message = "Type a note first."; renderPanel(); break; }
          w.notes.push({ lon: w.pos.lon, lat: w.pos.lat, clockMin: w.clockMin, text, kind: el.id === "w-idea" ? "idea" : "note" });
          logEvent(w, el.id === "w-idea" ? "idea" : "note", el.id === "w-idea" ? `Marked for next walk: ${text}` : `Note: ${text}`);
          walkUi.noteDraft = "";
          walkUi.message = el.id === "w-idea" ? "Marked for the next walk." : "Note pinned to the map.";
          map.setNotes(w.notes);
          renderPanel();
        }
        break;
      case "w-back": backToPlan(); break;
    }
  });
  panel.addEventListener("keydown", (ev) => {
    const el = (ev.target as HTMLElement).closest("[data-photo]") as HTMLElement | null;
    if (el && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      state.photo = el.dataset.photo!;
      renderLightbox();
    }
  });
  panel.addEventListener("input", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.id === "rp-slider" && walkUi.w) {
      // update the map and the clock only: re-rendering the panel would interrupt dragging
      const w = walkUi.w;
      replay.clock = Number(t.value);
      replay.playing = false;
      map.setWalker(trackAtClock(w.track, replay.clock), "Crew (2)");
      const done = w.track.filter((p) => p.clockMin <= replay.clock);
      let walked = 0;
      for (let i = 1; i < done.length; i++) walked += metresBetween(grid.meta, done[i - 1], done[i]);
      $("#rp-clock").textContent = fmtClock(replay.clock);
      $("#rp-dist").textContent = km(walked);
    }
    if (t.id === "w-note") walkUi.noteDraft = t.value;
    if (t.id === "stop-note") {
      const s = state.stops.find((x) => x.id === state.selected);
      if (s) s.crewNote = t.value;
    }
  });
  panel.addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.layer) {
      const k = t.dataset.layer as OverlayKey | "rover";
      state.show[k] = t.checked;
      if (k === "rover") drawRover();
      else map.setOverlay(k, t.checked);
      renderPanel();
    } else if (t.dataset.task && walkUi.w) {
      const st = currentStop(walkUi.w);
      if (!st) return;
      const list = new Set(walkUi.tasks[st.id] ?? []);
      if (t.checked) list.add(t.dataset.task);
      else list.delete(t.dataset.task);
      walkUi.tasks[st.id] = [...list];
      const log = walkUi.w.log.find((l) => l.id === st.id);
      if (log) log.tasksDone = [...list];
    } else if (t.id === "compare") {
      state.compare = t.checked;
      map.setCompare(state.compare, state.split);
      positionHandle();
    } else if (t.id === "w-follow") {
      walkUi.follow = t.checked;
    } else if (t.id === "start") {
      state.startClock = t.value || "08:45";
      if (state.plan) runPlan();
    } else if (t.id === "stop-minutes") {
      const s = state.stops.find((x) => x.id === state.selected);
      if (s) {
        s.minutes = Math.max(5, Math.min(180, Math.round(Number(t.value) || s.minutes)));
        markStale();
      }
    }
  });
  $("#modal").addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id === "save-report" && lastReport) download(`baroler-walk-report-${pkg.site.id}.html`, lastReport.html, "text/html");
    else if (t.id === "save-report-json" && lastReport) download(`baroler-walk-report-${pkg.site.id}.json`, JSON.stringify(lastReport.report, null, 1), "application/json");
    else if (t.id === "modal-close" || t.id === "modal") $("#modal").hidden = true;
  });
  $("#lightbox").addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id === "lb-close" || t.id === "lightbox") {
      state.photo = null;
      renderLightbox();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (!$("#modal").hidden) {
        $("#modal").hidden = true;
      } else if (state.photo) {
        state.photo = null;
        renderLightbox();
      } else if (state.addMode) {
        state.addMode = false;
        $("#add-hint").hidden = true;
        renderPanel();
      }
    }
  });
  $("#add-cancel").addEventListener("click", () => {
    state.addMode = false;
    $("#add-hint").hidden = true;
    renderPanel();
  });
  bindChartHover(panel, $("#chart-tip"));
}

function positionHandle(): void {
  const h = $("#compare-handle");
  h.hidden = !state.compare;
  h.style.left = `${$("#map").clientWidth * state.split}px`;
}

function bindCompareHandle(): void {
  const h = $("#compare-handle");
  let dragging = false;
  h.addEventListener("pointerdown", (e) => {
    dragging = true;
    h.setPointerCapture(e.pointerId);
  });
  h.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = $("#map").getBoundingClientRect();
    state.split = Math.min(0.95, Math.max(0.05, (e.clientX - rect.left) / rect.width));
    map.setSplit(state.split);
    positionHandle();
  });
  h.addEventListener("pointerup", () => (dragging = false));
  window.addEventListener("resize", positionHandle);
}

function drawRover(): void {
  const pts = [...pkg.roverWaypoints]
    .sort((a, b) => a.sol - b.sol || a.rmc.localeCompare(b.rmc, undefined, { numeric: true }))
    .map((w) => ({ lon: w.position.lon, lat: w.position.lat, h: w.position.elev_m ?? map.heightAt(w.position.lon, w.position.lat) }));
  map.setRoverPath(pts, state.show.rover);
}

function readout(p: LonLat | null): void {
  const r = $("#readout");
  if (r.classList.contains("flash")) return;
  if (!p) {
    r.textContent = "";
    return;
  }
  const lat = `${Math.abs(p.lat).toFixed(5)}° ${p.lat >= 0 ? "N" : "S"}`;
  const lon = `${p.lon.toFixed(5)}° E`;
  if (!inside(grid.meta, p.lon, p.lat)) {
    r.textContent = `${lat}, ${lon}`;
    return;
  }
  const s = grid.slope[cellIndex(grid.meta, p.lon, p.lat)];
  const u = unitAt(p);
  const h = map.heightAt(p.lon, p.lat);
  const cls = s > model.maxSlopeDeg ? "no-go" : s > model.comfortSlopeDeg ? "take care" : "easy";
  r.textContent = `${lat}, ${lon} · ${Math.round(-h)} m below Mars datum · slope ${s}° (${cls})${u ? ` · ${u.name}` : ""}`;
}

// ------------------------------------------------------------------ start
async function loadPackage(): Promise<void> {
  const text = $("#loading-text");
  const idx = await fetch("/package/index.json");
  if (!idx.ok) throw new Error("No mission packages yet. Run the pipeline first: cd pipeline && uv run baroler-build --zone z2");
  const index = (await idx.json()) as { zones: ZoneInfo[]; default: string };
  zones = index.zones;
  const want = location.hash.replace("#", "");
  zone = zones.find((z) => z.key === want) ?? zones.find((z) => z.key === index.default) ?? zones[0];
  PKG = `/package/${zone.path}`;
  text.textContent = `Loading the ${zone.name} mission package…`;
  const res = await fetch(`${PKG}mission-package.json`);
  if (!res.ok) throw new Error("The mission package is missing. Run the pipeline first: cd pipeline && uv run baroler-build");
  pkg = (await res.json()) as MissionPackage;
  for (const p of pkg.povImages) photos.set(p.imageId, p);
  model = {
    ...DEFAULT_COST,
    comfortSlopeDeg: assumption(pkg, "A1", 15),
    maxSlopeDeg: assumption(pkg, "A2", 25),
    flatSpeedMs: assumption(pkg, "A3", 2.5) / 3.6,
  };
  evaMin = assumption(pkg, "A4", 360);
  reserve = assumption(pkg, "A5", 0.3);
  baseAntenna = pkg.site.base.antennaHeight_m ?? assumption(pkg, "A7", 3);
  suitAntenna = assumption(pkg, "A8", 1.8);
  maxRadioGap = assumption(pkg, "A9", 15);

  text.textContent = "Loading the terrain…";
  const [m2, m1, mc] = await Promise.all([
    loadGridMeta(`${PKG}route/grid.json`),
    loadGridMeta(`${PKG}terrain/height_1m.json`),
    loadGridMeta(`${PKG}terrain/height_ctx_20m.json`),
  ]);
  const n2 = m2.width * m2.height;
  const [h2, s2, r2, h1, hc] = await Promise.all([
    loadBinary(`${PKG}route/height_2m.f32`, Float32Array, n2),
    loadBinary(`${PKG}route/slope_2m.u8`, Uint8Array, n2),
    loadBinary(`${PKG}route/rough_2m.u8`, Uint8Array, n2),
    loadBinary(`${PKG}terrain/height_1m.f32`, Float32Array, m1.width * m1.height),
    loadBinary(`${PKG}terrain/height_ctx_20m.f32`, Float32Array, mc.width * mc.height),
  ]);
  grid = { meta: m2, h: h2, slope: s2, rough: r2 };
  const walk: HeightGrid = { meta: m1, h: h1 };
  const ctx: HeightGrid = { meta: mc, h: hc };

  text.textContent = "Loading the rock map and conditions…";
  const gj = await (await fetch(`${PKG}geology/units.geojson`)).json();
  units = gj.features.map((f: { geometry: { type: string; coordinates: number[][][] | number[][][][] }; properties: { symbol: string; name: string } }) => ({
    symbol: f.properties.symbol,
    name: f.properties.name,
    rings: f.geometry.type === "Polygon" ? [(f.geometry.coordinates as number[][][])[0]] : (f.geometry.coordinates as number[][][][]).map((p) => p[0]),
  }));
  const wl = pkg.layers.find((l) => l.id === "weather-meda");
  const sl = pkg.layers.find((l) => l.id === "space-weather-noaa");
  if (wl?.access.packagePath) weather = (await (await fetch(`${PKG}${wl.access.packagePath}`)).json()) as Weather;
  if (sl?.access.packagePath) space = (await (await fetch(`${PKG}${sl.access.packagePath}`)).json()) as SpaceWeather;

  state.stops = pkg.stops.map((s) => ({
    id: s.id, name: s.name, lon: s.position.lon, lat: s.position.lat, minutes: s.plannedMinutes ?? 30,
    tasks: s.tasks ?? [], unit: s.geologicUnit, notes: s.notes, crewNote: "", povIds: s.povImageIds ?? [], custom: false,
  }));

  text.textContent = "Starting the 3D map…";
  map = new MapView($("#map"), walk, ctx);
  const tileLayers = pkg.layers.filter((l) => l.access.urlTemplate && l.id.startsWith("tiles-") && l.id !== "tiles-themis-night");
  for (const l of tileLayers) {
    const layer = map.addTiles(`${PKG}${l.access.urlTemplate}`, l.access.minLevel ?? 0, l.access.maxLevel ?? 0, l.coverage, l.attribution);
    if (l.id.startsWith("tiles-mola")) {
      // MOLA's height colours are only far-away context here: tone them down so they don't compete with the photos.
      layer.saturation = 0.3;
      layer.brightness = 0.85;
    }
  }
  const themis = pkg.layers.find((l) => l.id === "tiles-themis-night");
  if (themis?.access.urlTemplate) {
    const layer = map.addTiles(`${PKG}${themis.access.urlTemplate}`, themis.access.minLevel ?? 0, themis.access.maxLevel ?? 0, themis.coverage, themis.attribution, 0.75);
    layer.show = state.show.themis;
    map.overlays.themis = layer;
  }
  const slope = pkg.layers.find((l) => l.id === "slope-2m")!;
  const geology = pkg.layers.find((l) => l.id === "geology-sim3464")!;
  await Promise.all([
    map.addOverlay("slope", `${PKG}${slope.access.packagePath}`, slope.coverage!, slope.attribution, 0.85, state.show.slope),
    map.addOverlay("geology", `${PKG}${geology.access.packagePath}`, geology.coverage!, geology.attribution, 0.75, state.show.geology),
  ]);
  drawRover();
  refreshMap();
}

async function main(): Promise<void> {
  try {
    await loadPackage();
  } catch (e) {
    $("#loading-text").textContent = `Could not start: ${(e as Error).message}`;
    $("#loading").classList.add("failed");
    throw e;
  }
  $("#site-name").textContent = `${pkg.site.name} · ${pkg.site.region}`;
  const sel = $<HTMLSelectElement>("#zone-select");
  sel.innerHTML = zones.map((z) => `<option value="${esc(z.key)}" ${z.key === zone.key ? "selected" : ""}>Zone ${esc(z.code)} · ${esc(z.name)}</option>`).join("");
  sel.hidden = zones.length < 2;
  sel.addEventListener("change", () => {
    location.hash = sel.value;
    location.reload();
  });
  // Typing #z1 / #z2 in the address bar only changes the hash; reload so the other package loads.
  window.addEventListener("hashchange", () => {
    const key = location.hash.replace("#", "");
    if (key !== zone.key && zones.some((z) => z.key === key)) location.reload();
  });
  document.title = `Baroler · ${zone.name}`;
  bindPanel();
  bindCompareHandle();
  renderPanel();
  map.onClick((pos) => {
    if (state.mode !== "plan") return;
    if (state.addMode) {
      const p = map.pickLonLat(pos);
      if (p) addStopAt(p);
      return;
    }
    const id = map.pickPinId(pos);
    if (id && id !== "base") select(id);
  });
  map.onMove((pos) => readout(map.pickLonLat(pos)));
  map.showPlanet(pkg.site.center);
  if (import.meta.env.DEV) (window as unknown as { __baroler: unknown }).__baroler = { map, state, preview, walkUi, replay, step, renderPanel, makeReport };
  $("#loading").classList.add("done");
  setTimeout(() => ($("#loading").hidden = true), 700);
  setTimeout(() => map.flyToSite(pkg.site.center), 700);
}

main();
