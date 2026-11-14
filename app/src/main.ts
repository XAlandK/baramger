// Fonts are bundled with the app (SIL OFL), so nothing is fetched from the internet.
import "@fontsource/barlow-semi-condensed/600.css";
import "@fontsource/barlow-semi-condensed/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./style.css";
import { type HeightGrid, type LonLat, type RouteGrid, bilinear, cellIndex, inside, loadBinary, loadGridMeta, metresBetween } from "./grid";
import { DEFAULT_COST, type CostModel, isPassable } from "./router";
import { type Check, type Conditions, type PlanInput, type PlanResult, type Sample, computePlan, fmtClock, routeLegs, suggestOrder } from "./plan";
import { MapView, type OverlayKey, type PlacePin, type StopPin, type ZonePin } from "./map";
import { type MissionPackage, type PovImage, assumption, cameraName, isCloseUp } from "./pkg";
import { type ProfilePoint, bindChartHover, profileChart, tempChart } from "./charts";
import {
  type FieldNote, type WalkState, type WalkStop, advanceToNextEvent, bearingDeg, setWalkLoad, compass, currentStop, headHomeNow, leaveStop, logEvent, lookAhead,
  minutesToRadio, nextTarget, plannedStopMin, projectedReturnMin, renameStopInWalk, skipNext, startWalk, stayLonger, tick, trackAt as trackAtClock,
} from "./walk";
import { hudHtml, relativeBearing } from "./hud";
import { mins } from "./format";
import { PANEL_W, cleanStopName, craterView, uiLayout } from "./layout";
import { BASE_TEXT, DEFAULT_BASE, type BaseStyle, baseStyleOf, startBaseStyle } from "./basemap";
import { PERSON_HEIGHT_M, type ScaleCard, scaleCard, scaleHtml } from "./scale";
import { morph } from "./morph";
import { playIntro } from "./intro";
import { DEFAULT_LOAD, type LoadModel, addPickup, factorText, heaviest, kgText, timeFactor } from "./load";
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
let crater: unknown = null; // the crater the zones lie in (zone list; see craterView)

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
  defaultName?: string; // for a stop added by the crew: the name to fall back to if they clear it
  lastWalk?: "visited" | "skipped";
}

type PlanTab = "goal" | "layers" | "stops" | "route" | "conditions" | "safety";
type WalkTab = "now" | "progress" | "notes";
type DataTab = "sources" | "checks" | "values";
/** Details open as pop-ups, so the panel never has to scroll. */
type Popup = { kind: "stop" } | { kind: "place"; id: string } | { kind: "places"; ids: string[] } | { kind: "ideas" } | { kind: "legs" } | { kind: "alerts" } | { kind: "data"; tab: DataTab };

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
  donki: { status: string; sep_events_30d?: number };
}

type Mode = "plan" | "preview" | "walk" | "replay";

interface TrackPoint extends Sample {
  D: number; // metres from the start of the whole walk
  clock: number; // planned clock time here (minutes)
  leg: number;
}

const state = {
  view: "globe" as "globe" | "site", // the whole planet, or one walk zone
  tab: "goal" as PlanTab,
  popup: null as Popup | null,
  checkSel: null as string | null, // the safety check whose details are shown
  pages: {} as Record<string, number>, // page of each paged list
  showPlaces: true,
  baseStyle: DEFAULT_BASE as BaseStyle, // the look of the whole-planet map: height colours or natural colour
  photoSet: [] as string[], // photos the lightbox can step through
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
  crewSize: 2, // astronauts on the walk: 1 to 4 (buddy rule needs 2)
  startLoads: [] as number[], // kg each astronaut carries when leaving the habitat
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
  hudFull: false, // the helmet view took the panel away (narrow map); leaving it brings the panel back
  carried: false, // ideas and stop results already copied back to the plan
  startLoads: [] as number[], // kg per astronaut at the start of this walk
  tab: "now" as WalkTab,
};

const replay = { playing: false, speed: 2, clock: 0, tab: "events" as "events" | "table" };
let lastReport: { report: WalkReport; html: string } | null = null;

let pkg: MissionPackage;
let grid: RouteGrid;
let map: MapView;
let model: CostModel;
let loadModel: LoadModel = DEFAULT_LOAD; // A15-A17, A20, A21
let tubeKg = 0.08; // A18 one sample tube with its sample
let rockKg = 1; // A19 one rock sample
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
/** Session flags. A browser that blocks site storage throws on every access: then the flag is simply not kept. */
const session = {
  get(key: string): string | null {
    try { return sessionStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { sessionStorage.setItem(key, value); } catch { /* storage is blocked */ }
  },
  remove(key: string): void {
    try { sessionStorage.removeItem(key); } catch { /* storage is blocked */ }
  },
};
/** Choices that should survive a reload (the look of the map). Blocked storage only means the choice is not kept. */
const prefs = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* storage is blocked */ }
  },
};
/** "1 stop", "2 stops". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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
    crewSize: state.crewSize,
    load: { model: loadModel, startKg: crewLoads(), pickupKgPerStop: state.stops.map((s) => pickupKg(s.tasks)) },
  };
}

/** Label on the crew marker, e.g. "Crew (2)". */
function crewLabel(): string {
  return `Crew (${state.crewSize})`;
}

/** Sample pickups by task name: a Mars 2020 tube (A18) or a rock sample (A19). */
const PICKUP_TASKS: Record<string, "tube" | "rock"> = {
  "Pick up the tube": "tube",
  "Take sample": "rock",
  "Collect a sample if safe": "rock",
};

function pickupKg(tasks: string[]): number {
  return tasks.reduce((a, t) => a + (PICKUP_TASKS[t] === "tube" ? tubeKg : PICKUP_TASKS[t] === "rock" ? rockKg : 0), 0);
}

/** Load of each astronaut when leaving the habitat; a new crew member gets the standard kit (A17). */
function crewLoads(): number[] {
  while (state.startLoads.length < state.crewSize) state.startLoads.push(loadModel.kitKg);
  return state.startLoads.slice(0, state.crewSize);
}

/** Loads now: the start loads plus every pickup task ticked so far, in visiting order. */
function walkLoads(): number[] {
  const w = walkUi.w;
  let loads = [...walkUi.startLoads];
  if (!w) return loads;
  for (const v of w.log) for (const t of walkUi.tasks[v.id] ?? []) loads = addPickup(loads, pickupKg([t]));
  return loads;
}

/** Time estimates on the walk use the current load: re-time the legs still ahead. */
function applyWalkLoad(): void {
  const w = walkUi.w;
  if (!w || w.phase === "done") return;
  const kg = heaviest(walkLoads());
  setWalkLoad(w, timeFactor(loadModel, kg), kg);
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

/** The off-plan places as map markers (none when the "Place names" layer is off). */
function places(): PlacePin[] {
  if (!state.showPlaces) return [];
  return placesOffPlan().map((s) => ({ id: s.id, name: s.name, lon: s.position.lon, lat: s.position.lat }));
}

function refreshMap(): void {
  map.setPins(pins(), state.selected);
  map.setPlaces(places());
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
function modeTabs(): string {
  const canWalk = !!state.approvedAt && !state.busy;
  const walkOn = state.mode === "walk" || state.mode === "replay";
  return `
  <header class="p-top">
    <nav class="tabs" aria-label="Screens">
      <button type="button" data-mode="plan" class="${!walkOn ? "on" : ""}">Plan</button>
      <button type="button" data-mode="walk" class="${walkOn ? "on" : ""}" ${canWalk ? "" : "disabled"} title="${canWalk ? "Tablet view for the walk" : "Approve the plan first"}">Walk (tablet)</button>
    </nav>
    <button type="button" id="panel-hide" class="icon-btn" title="Hide this panel" aria-label="Hide this panel">›</button>
  </header>`;
}

const PLAN_TABS: [PlanTab, string][] = [["goal", "Goal"], ["layers", "Layers"], ["stops", "Stops"], ["route", "Route"], ["conditions", "Weather"], ["safety", "Safety"]];

function planTabs(): string {
  const p = state.plan;
  const worst = p ? (p.checks.some((c) => c.status === "fail") ? "fail" : p.checks.some((c) => c.status === "care") ? "care" : "ok") : "";
  return `
  <nav class="subtabs" aria-label="Plan sections">
    ${PLAN_TABS.map(([k, label]) => `<button type="button" data-tab="${k}" class="${state.tab === k ? "on" : ""}">${label}${k === "stops" ? ` <small>${state.stops.length}</small>` : ""}${k === "safety" ? ` <i class="tdot ${worst || "none"}"></i>` : ""}</button>`).join("")}
  </nav>`;
}

/** One page of a list, with "‹ 1 / 3 ›" controls when it does not fit on one page. The panel never scrolls. */
function paged<T>(key: string, items: T[], size: number): { slice: T[]; nav: string; start: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(pages - 1, Math.max(0, state.pages[key] ?? 0));
  state.pages[key] = page;
  const nav = pages > 1
    ? `<div class="pager"><button type="button" data-page="${esc(key)}" data-dir="-1" ${page === 0 ? "disabled" : ""} aria-label="Previous page">‹</button><span>${page + 1} / ${pages}</span><button type="button" data-page="${esc(key)}" data-dir="1" ${page === pages - 1 ? "disabled" : ""} aria-label="Next page">›</button></div>`
    : "";
  return { slice: items.slice(page * size, page * size + size), nav, start: page * size };
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

/** A row of small rover photos that open in the lightbox. Paged, so it never needs to scroll. */
function photoStrip(ids: string[], key: string, compact = false): string {
  const pics = ids.map((id) => photos.get(id)).filter(Boolean) as PovImage[];
  if (!pics.length) return "";
  const { slice, nav } = paged(`ph-${key}`, pics, 4);
  return `
    <div class="strip">
      ${slice.map((p) => `
        <figure class="photo" data-key="${esc(p.imageId)}" data-photo="${esc(p.imageId)}" data-set="${esc(ids.join(","))}" tabindex="0" role="button" aria-label="Open photo: ${esc(cameraName(p.instrument))}, sol ${p.sol}">
          <img src="${PKG}${esc(p.urls.packagePath)}" alt="${esc(cameraName(p.instrument))} photo, sol ${p.sol}" loading="lazy">
        </figure>`).join("")}
    </div>
    <div class="strip-foot">${nav}${compact
      ? `<p class="muted tiny one-line" title="Real photos taken by the Perseverance rover at this spot. ${esc(pics[0].credit)}. Click a photo to enlarge it.">Rover photos of this spot · ${esc(pics[0].credit)}</p>`
      : `<p class="muted tiny">Real photos taken by the Perseverance rover at this spot. ${esc(pics[0].credit)}. Click a photo to enlarge it.</p>`}</div>`;
}

/**
 * The switch between the two looks of the whole-planet map. Empty when the package has only one look.
 * It is on the whole-planet screen only: inside a walk zone the photo maps cover the whole view,
 * so the switch would change nothing there.
 */
function baseSwitch(): string {
  const looks = map.baseStyles();
  if (looks.length < 2) return "";
  return `
    <div class="base-style" title="${esc(BASE_TEXT[state.baseStyle].note)}">
      <span>Mars colours <small class="src">R1</small></span>
      <div class="seg" role="group" aria-label="Mars colours">${looks.map((s) => `<button type="button" data-base="${s}" class="${state.baseStyle === s ? "on" : ""}" aria-pressed="${state.baseStyle === s}">${BASE_TEXT[s].label}</button>`).join("")}</div>
    </div>`;
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
  let html: string;
  if (state.view === "globe") html = globePanel();
  else if (state.mode === "walk") html = modeTabs() + walkPanel();
  else if (state.mode === "replay") html = modeTabs() + replayPanel();
  else if (state.mode === "preview") html = modeTabs() + previewPanel();
  else html = modeTabs() + planTabs() + `<div class="p-body" id="p-body" data-key="plan-${state.tab}">${planBody()}</div>` + planFooter();
  morph($("#panel"), html);
  renderChip();
  renderPopup();
  if (state.mode === "walk") renderHud(); // keep the helmet in step with the tablet (stay longer, skip, notes)
}

/** The chip on the map: where we are, the zone menu and the way back to the whole planet. */
function renderChip(): void {
  const globe = state.view === "globe";
  document.body.dataset.screen = state.view; // not data-view: buttons in the panel use that name
  document.body.classList.toggle("adding", state.addMode);
  $("#chip-eyebrow").textContent = globe ? "Baramger · Mars" : state.mode === "walk" ? "Baramger · Walk" : state.mode === "replay" ? "Baramger · Replay" : "Baramger · Plan";
  $("#site-name").textContent = globe ? "Mars · the whole planet" : `${pkg.site.name} · ${pkg.site.region}`;
  $("#zone-select").hidden = globe || zones.length < 2;
  $("#to-globe").hidden = globe;
  $("#globe-hint").hidden = !globe;
}

// ------------------------------------------------------------------ whole-planet view
function globePanel(): string {
  return `
  <header class="p-top">
    <p class="eyebrow">Mars · the whole planet</p>
    <button type="button" id="panel-hide" class="icon-btn" title="Hide this panel" aria-label="Hide this panel">›</button>
  </header>
  <div class="p-body" id="p-body" data-key="globe">
    <header class="p-head">
      <h1>Choose a walk zone</h1>
      <p class="muted">Move freely: drag to turn Mars, scroll to zoom, right-drag (or Ctrl-drag) to tilt. The walk zones are marked in Jezero crater.</p>
    </header>
    <ul class="zones">
      ${zones.map((z) => `
        <li class="zone-card ${z.key === zone.key ? "here" : ""}" data-key="${esc(z.key)}">
          <span class="num">${esc(z.code)}</span>
          <div><b>${esc(z.name)}</b><small>${esc(z.description)} · ${count(z.stops, "stop")}</small></div>
          <button type="button" class="primary small-btn" data-zone="${esc(z.key)}">Open</button>
        </li>`).join("")}
    </ul>
    <div class="row">
      <button type="button" id="globe-jezero" class="secondary">Fly to Jezero crater</button>
      <button type="button" id="globe-home" class="secondary">Whole planet</button>
    </div>
    ${baseSwitch()}
    <p class="muted small">${esc(BASE_TEXT[state.baseStyle].note)} Inside Jezero crater the grey CTX photo map takes over, and the walk zones have sharp photos (about 30 cm per pixel).</p>
    <button type="button" class="linkish" id="intro-replay">Play the launch animation again</button>
  </div>`;
}

// ------------------------------------------------------------------ plan mode
function planBody(): string {
  switch (state.tab) {
    case "layers": return layersTab();
    case "stops": return stopsTab();
    case "route": return routeTab();
    case "conditions": return conditionsTab();
    case "safety": return safetyTab();
    default: return goalTab();
  }
}

function goalTab(): string {
  const goal = pkg.objectives[0];
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
  <p class="muted small">Go through the tabs from left to right: look at the layers, choose the stops, find the route, check the weather and the safety list, then approve the plan.</p>`;
}

function layersTab(): string {
  const geo = pkg.layers.find((l) => l.id === "geology-sim3464");
  const geoLegend = geo?.display?.legend ?? [];
  return `
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
    <label class="layer">
      <input type="checkbox" id="show-places" ${state.showPlaces ? "checked" : ""}>
      <span class="layer-text"><b>Place names</b><small>Known places keep their name on the map, also when they are not stops</small></span>
      <span class="src" title="Data source">S1</span>
    </label>
  </div>
  <label class="compare"><input type="checkbox" id="compare" ${state.compare ? "checked" : ""}> Compare side by side <small>(photo left, layers right)</small></label>
  <p class="note" id="geo-note" ${state.show.geology && geo?.caveats?.[0] ? "" : "hidden"}>${esc(geo?.caveats?.[0] ?? "")}</p>`;
}

/** Known places (the package's rover-verified spots) that are not stops in the plan right now. */
function placesOffPlan(): MissionPackage["stops"] {
  const inPlan = new Set(state.stops.map((s) => s.id));
  return pkg.stops.filter((s) => !inPlan.has(s.id));
}

function stopsTab(): string {
  // ten stops fit on one page; with more, there is a page control, so one row less
  const { slice, nav, start } = paged("stops", state.stops, state.stops.length > 10 ? 9 : 10);
  const away = placesOffPlan().length;
  const extra = [
    away ? `<button type="button" id="open-places" class="secondary">Known places off the plan (${away})</button>` : "",
    state.ideas.length ? `<button type="button" id="open-ideas" class="secondary">Ideas for next walk (${state.ideas.length})</button>` : "",
  ].filter(Boolean);
  return `
  <h3>Stops <small class="muted">in walking order · click a stop for details</small></h3>
  <ol class="stops">
    <li class="stop base"><span class="num base">H</span><div class="stop-text"><b>Habitat</b> <small>start and end</small></div></li>
    ${slice.map((s, k) => {
      const i = start + k;
      return `
      <li class="stop" data-key="${esc(s.id)}">
        <span class="num ${s.custom ? "new" : ""}">${i + 1}</span>
        <button class="stop-text link" data-open="${esc(s.id)}" type="button" title="${esc(s.name)}"><b>${esc(s.name)}</b> <small>${s.minutes} min${s.crewNote ? " · note" : ""}${s.lastWalk ? ` · <em class="${s.lastWalk}" title="On the last walk">${s.lastWalk}</em>` : ""}</small></button>
        <span class="row-actions">
          <button type="button" data-move="${esc(s.id)}" data-dir="-1" title="Move earlier" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-move="${esc(s.id)}" data-dir="1" title="Move later" ${i === state.stops.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-remove="${esc(s.id)}" title="Remove stop">✕</button>
        </span>
      </li>`;
    }).join("")}
  </ol>
  ${nav}
  <div class="row">
    <button type="button" id="add-stop" class="secondary">${state.addMode ? "Click the map…" : "+ Add stop"}</button>
    <button type="button" id="suggest-order" class="secondary" ${state.stops.length < 3 ? "disabled" : ""} title="Put the stops in a short walking order">Suggest order</button>
  </div>
  <div class="row ${extra.length === 1 ? "one" : ""}" id="stops-extra" ${extra.length ? "" : "hidden"}>${extra.join("")}</div>`;
}

function routeTab(): string {
  const p = state.plan;
  if (!p) {
    return `
    <h3>Route</h3>
    <p class="muted">${state.busy ? "Finding the safest route…" : "No route yet. Press <b>Find safest route</b> below."}</p>
    <p class="muted small">The route avoids ground steeper than ${model.maxSlopeDeg}° and picks the quickest safe way between stops. What the crew carries changes the walking time, not the path.</p>`;
  }
  const t = p.totals;
  const base = pkg.site.base.position;
  let far = 0;
  for (const l of p.legs) for (const s of l.samples) far = Math.max(far, metresBetween(grid.meta, base, s));
  const { track, stopD } = buildTrack(p);
  return `
    <h3>Route <small class="muted">${count(p.legs.length, "leg")} · habitat and back</small></h3>
    <div class="summary">
      <div><span>Distance</span><b>${km(t.distanceM)}</b></div>
      <div><span>Total time</span><b>${mins(t.totalMin)}</b></div>
      <div><span>Reserve</span><b class="${t.reserveFraction >= reserve ? "good" : "warn"}">${mins(Math.max(0, t.reserveMin))}</b></div>
      <div><span>Steepest</span><b class="${t.maxSlope > model.comfortSlopeDeg ? "warn" : "good"}">${Math.round(t.maxSlope)}°</b></div>
      <div><span>Climb / descent</span><b>${Math.round(t.ascentM)} / ${Math.round(t.descentM)} m</b></div>
      <div><span>Farthest away</span><b>${km(far)}</b></div>
    </div>
    <p class="route-key"><i class="ln easy"></i>easy <i class="ln care"></i>take care (15–25°) <i class="ln dash"></i>no radio</p>
    <p class="chart-legend">Height along the route <span class="muted">· numbers are stops</span></p>
    ${profileChart(profilePoints(track), stopD.map((d, i) => ({ d, label: String(i + 1) })), model.comfortSlopeDeg)}
    <div class="row">
      <button type="button" id="walkthrough" class="secondary">▶ Walk-through</button>
      <button type="button" id="open-legs" class="secondary">Legs and loads</button>
    </div>`;
}

function conditionsTab(): string {
  if (!weather || !space) return `<h3>Conditions</h3><p class="muted">This mission package has no weather data.</p>`;
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
    <p class="muted small">Measured by Perseverance here, sols ${weather.sols[0]}–${weather.sols[weather.sols.length - 1]} (${esc(weather.date_range ?? "")}): real reference values for this place and season, not today's weather.</p>
    <div class="sunbox">
      <div class="sunhead"><b>Sun activity</b> <span class="pill ${storm ? "bad" : c.xFlareHoursAgo !== null && c.xFlareHoursAgo <= c.xFlareCareHours ? "care" : "ok"}">${storm ? "Storm" : "Quiet"}</span></div>
      <small>${f.M} medium (M) and ${f.X} strong (X) flares in the last 7 days. Particle level ${c.protonPfu ?? "unknown"} pfu (storm level ${c.protonLimitPfu}). Measured near Earth by NOAA GOES, ${esc(c.dataDate)}: storms seen there may or may not reach Mars.</small>
    </div>
    <button type="button" class="linkish" data-dtab="checks">More about this data</button>`;
}

function safetyTab(): string {
  const p = state.plan;
  const settings = `
    <div class="settings">
      <label class="start">Walk starts at <input type="time" id="start" value="${esc(state.startClock)}"> <small class="muted">local Mars time</small></label>
      <label class="start">Crew <input type="number" id="crew" min="1" max="4" step="1" value="${state.crewSize}"> <small class="muted">astronauts on the walk</small></label>
      <div class="start loads"><span>Load at start</span>${crewLoads().map((kg, i) => `<label title="Astronaut ${i + 1}">A${i + 1} <input type="number" class="load-input" data-astro="${i}" min="0" max="60" step="0.5" value="${kg}" aria-label="Load of astronaut ${i + 1} in kg"></label>`).join("")}<small class="muted">kg · kit ${kgText(loadModel.kitKg)}</small></div>
    </div>`;
  if (!p) return `<h3>Safety check</h3>${settings}<p class="muted">The checks appear here after you find a route.</p>`;
  const t = p.totals;
  const checks: Check[] = [...p.checks, {
    id: "turnback", label: "Turn-back times", status: "ok",
    detail: `Planned return ${fmtClock(t.finishClockMin)}. Latest return that keeps the reserve: ${fmtClock(t.latestFinishClockMin)}. If running late, leave the last stop by ${fmtClock(t.leaveLastStopByMin)}.`,
  }];
  const sel = checks.find((c) => c.id === state.checkSel) ?? checks.find((c) => c.status === "fail") ?? checks.find((c) => c.status === "care") ?? null;
  return `
    <h3>Safety check <small class="muted">click a line to read it in full</small></h3>
    ${settings}
    <ul class="checks">
      ${checks.map((c) => `<li><button type="button" class="check ${c.status} ${sel?.id === c.id ? "on" : ""}" data-check="${esc(c.id)}"><span class="dot"></span><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></button></li>`).join("")}
    </ul>
    <div class="check-detail ${sel?.status ?? ""}" id="check-detail" aria-live="polite">${sel ? `<b>${esc(sel.label)}.</b> ${esc(sel.detail)}` : `<span class="muted">All checks pass. Click a line above to read its details.</span>`}</div>`;
}

/** Always visible at the bottom of the panel: the numbers that matter and the next step. */
function planFooter(): string {
  const p = state.plan;
  const anyFail = !!p && p.checks.some((c) => c.status === "fail");
  let line: string;
  let buttons: string;
  if (p && state.approvedAt) {
    line = `<div class="approved"><b>Plan approved</b> at ${esc(state.approvedAt)}. Copied to tablets and helmets when they dock.</div>`;
    const walkLabel = walkUi.w?.phase === "done" ? "Start a new walk" : walkUi.w ? "Back to the walk" : "Open the walk (tablet)";
    buttons = `<button type="button" id="go-walk" class="primary">${walkLabel}</button><button type="button" id="save-plan" class="secondary">Save plan file</button>`;
  } else if (p) {
    const t = p.totals;
    line = `<p class="foot-stats"><b>${km(t.distanceM)}</b> · <b>${mins(t.totalMin)}</b> with stops · reserve <b class="${t.reserveFraction >= reserve ? "good" : "warn"}">${mins(Math.max(0, t.reserveMin))}</b>${anyFail ? ` · <span class="error">fix the red items in Safety</span>` : ""}</p>`;
    buttons = `<button type="button" id="approve" class="primary" ${anyFail || state.busy ? "disabled" : ""}>Approve plan</button><button type="button" id="find-route" class="secondary" ${state.busy ? "disabled" : ""}>${state.busy ? "Finding…" : "Find route again"}</button>`;
  } else {
    line = state.planError
      ? `<p class="error">${esc(state.planError)}</p>`
      : `<p class="foot-stats">${state.stops.length} stop${state.stops.length === 1 ? "" : "s"} · no route yet</p>`;
    // the same two cells as with a route, so "Find" never changes into "Approve" under the pointer
    buttons = `<button type="button" id="approve" class="secondary" disabled title="Find a route first">Approve plan</button><button type="button" id="find-route" class="primary" ${state.busy || state.stops.length === 0 ? "disabled" : ""}>${state.busy ? "Finding…" : "Find safest route"}</button>`;
  }
  return `
  <footer class="p-foot">
    ${line}
    <div class="row">${buttons}</div>
    <button type="button" class="linkish" data-dtab="sources">Data, credits and starting values</button>
  </footer>`;
}

// ------------------------------------------------------------------ pop-ups
function popupHtml(): string {
  const pop = state.popup;
  if (!pop) return "";
  if (pop.kind === "stop") return stopPopup();
  if (pop.kind === "place") return placePopup(pop.id);
  if (pop.kind === "places") return placesPopup(pop.ids);
  if (pop.kind === "ideas") return ideasPopup();
  if (pop.kind === "legs") return legsPopup();
  if (pop.kind === "alerts") return alertsPopup();
  return dataPopup(pop.tab);
}

function renderPopup(): void {
  const el = $("#popup");
  const html = popupHtml();
  if (!html) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.className = state.popup && (state.popup.kind === "stop" || state.popup.kind === "place") ? "over-map" : "";
  morph(el, html);
  el.hidden = false;
}

function closePopup(): void {
  state.popup = null;
  renderPopup();
}

function stopPopup(): string {
  const s = state.stops.find((x) => x.id === state.selected);
  if (!s) return "";
  const idx = state.stops.indexOf(s) + 1;
  const slope = grid.slope[cellIndex(grid.meta, s.lon, s.lat)];
  return `
  <div class="pop-card" role="dialog" aria-label="Stop ${idx}" data-key="stop-${esc(s.id)}">
    <button type="button" id="pop-close" class="icon-btn pop-close" aria-label="Close">✕</button>
    <p class="eyebrow">Stop ${idx}${s.custom ? " · added by you" : ""}</p>
    ${s.custom
      ? `<label class="field name-field">Name <input type="text" id="stop-name" maxlength="40" value="${esc(s.name)}" placeholder="Name this stop" autocomplete="off"></label>`
      : `<h2>${esc(s.name)}</h2>`}
    <p class="muted small">${s.unit ? `Rock type: ${esc(s.unit)} · ` : ""}${s.lat.toFixed(5)}° N, ${s.lon.toFixed(5)}° E · ground slope ${slope === 255 ? "unknown" : slope + "°"}</p>
    <h3>What you will see</h3>
    ${photoStrip(s.povIds, s.id) || `<p class="muted small">No rover photos here. This is a new place; the crew will be the first to see it up close.</p>`}
    <h3>Plan for this stop</h3>
    <div class="pop-grid">
      <label class="start">Time here <input type="number" id="stop-minutes" min="5" max="180" step="5" value="${s.minutes}"> min</label>
      <ul class="tasks">${s.tasks.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>
    <label class="field">Crew note <textarea id="stop-note" rows="3" maxlength="140" placeholder="For example: bring the close-up camera">${esc(s.crewNote)}</textarea></label>
    ${s.notes ? `<p class="muted small">${esc(s.notes)}</p>` : ""}
    <div class="row">
      <button type="button" class="secondary" id="fly-stop">Show on map</button>
      <button type="button" class="danger" data-remove="${esc(s.id)}">Remove stop</button>
    </div>
  </div>`;
}

/** A known place that is not a stop right now: the crew can read about it and add it back. */
function placePopup(id: string): string {
  const s = pkg.stops.find((x) => x.id === id);
  if (!s) return "";
  const slope = grid.slope[cellIndex(grid.meta, s.position.lon, s.position.lat)];
  return `
  <div class="pop-card" role="dialog" aria-label="Place: ${esc(s.name)}" data-key="place-${esc(s.id)}">
    <button type="button" id="pop-close" class="icon-btn pop-close" aria-label="Close">✕</button>
    <p class="eyebrow">Known place · not in the plan</p>
    <h2>${esc(s.name)}</h2>
    <p class="muted small">${s.geologicUnit ? `Rock type: ${esc(s.geologicUnit)} · ` : ""}${s.position.lat.toFixed(5)}° N, ${s.position.lon.toFixed(5)}° E · ground slope ${slope === 255 ? "unknown" : slope + "°"}</p>
    <h3>What you will see</h3>
    ${photoStrip(s.povImageIds ?? [], `pl-${s.id}`) || `<p class="muted small">No rover photos here.</p>`}
    ${s.notes ? `<p class="muted small">${esc(s.notes)}</p>` : ""}
    <div class="row">
      <button type="button" class="primary" data-place-add="${esc(s.id)}">Add as stop</button>
      <button type="button" class="secondary" id="place-fly" data-place="${esc(s.id)}">Show on map</button>
    </div>
  </div>`;
}

/** Places that were taken off the plan: they stay named on the map, and can be added back here. */
function placesPopup(ids: string[]): string {
  const list = ids.map((id) => pkg.stops.find((s) => s.id === id)).filter((s): s is MissionPackage["stops"][number] => !!s);
  const inPlan = new Set(state.stops.map((s) => s.id));
  const { slice, nav } = paged("places", list, 8);
  return `
  <div class="pop-card" role="dialog" aria-label="Known places off the plan">
    <button type="button" id="pop-close" class="icon-btn pop-close" aria-label="Close">✕</button>
    <p class="eyebrow">Stops</p>
    <h2>Known places off the plan</h2>
    <p class="muted small">Places where Perseverance stood. ${state.showPlaces ? "They keep their name on the map, so you can also click one there." : "Turn on <b>Place names</b> in Layers to see them on the map."}</p>
    <ul class="stops">
      ${slice.map((s) => `
        <li class="stop" data-key="${esc(s.id)}">
          <span class="num base">○</span>
          <button class="stop-text link" ${inPlan.has(s.id) ? "data-open" : "data-place-open"}="${esc(s.id)}" type="button" title="${esc(s.name)}"><b>${esc(s.name)}</b> <small>${s.geologicUnit ? esc(s.geologicUnit.split(": ")[1] ?? s.geologicUnit) : ""}</small></button>
          ${inPlan.has(s.id) ? `<span class="in-plan">✓ in the plan</span>` : `<button type="button" class="secondary small-btn" data-place-add="${esc(s.id)}">Add as stop</button>`}
        </li>`).join("") || `<li class="muted small">Every known place is a stop in the plan.</li>`}
    </ul>
    ${nav}
  </div>`;
}

function ideasPopup(): string {
  const { slice, nav } = paged("ideas", state.ideas.map((n, i) => ({ n, i })), 6);
  return `
  <div class="pop-card" role="dialog" aria-label="Ideas for next walk">
    <button type="button" id="pop-close" class="icon-btn pop-close" aria-label="Close">✕</button>
    <p class="eyebrow">Stops</p>
    <h2>Ideas for next walk</h2>
    <p class="muted small">Marked by the crew on an earlier walk, with the place where they stood.</p>
    <div class="ideas">
      ${slice.map(({ n, i }) => `<div class="idea" data-key="idea-${i}"><span title="${esc(n.text)}">${esc(n.text)} <small class="muted">(${fmtClock(n.clockMin)})</small></span><button type="button" class="secondary small-btn" data-idea="${i}">Add as stop</button></div>`).join("") || `<p class="muted small">No ideas left.</p>`}
    </div>
    ${nav}
  </div>`;
}

function legsPopup(): string {
  const p = state.plan;
  if (!p) return "";
  const { slice, nav, start } = paged("legs", p.legs, 12);
  return `
  <div class="pop-card wide" role="dialog" aria-label="Legs and loads">
    <button type="button" id="pop-close" class="icon-btn pop-close" aria-label="Close">✕</button>
    <p class="eyebrow">Route</p>
    <h2>Legs and loads</h2>
    <table class="pvr legs">
      <thead><tr><th>#</th><th>Leg</th><th class="r">Distance</th><th class="r">Time</th><th class="r">Steepest</th><th class="r">Heaviest load</th><th>Radio</th></tr></thead>
      <tbody>
        ${slice.map((l, k) => `<tr><td>${start + k + 1}</td><td title="${esc(l.fromName)} → ${esc(l.toName)}"><bdi>${esc(l.fromName)}</bdi> → <bdi>${esc(l.toName)}</bdi></td><td class="r">${km(l.distanceM)}</td><td class="r">${mins(l.minutes)}</td><td class="r">${Math.round(l.maxSlope)}°</td>
          <td class="r">${kgText(l.loadKg ?? loadModel.kitKg)}${l.loadFactor && factorText(l.loadFactor) ? ` <small class="muted">(${factorText(l.loadFactor)})</small>` : ""}</td>
          <td>${l.noRadioMin >= 0.5 ? `<em>none for ${Math.round(l.noRadioMin)} min</em>` : "ok"}</td></tr>`).join("")}
      </tbody>
    </table>
    ${nav}
    <p class="muted small">Load is the most any astronaut carries on that leg. A leg after a sample pickup takes longer (assumptions A15–A21). Only the time changes, not the path.</p>
  </div>`;
}

function alertsPopup(): string {
  const w = walkUi.w;
  if (!w) return "";
  const alerts = sortedAlerts(walkAlerts(w));
  return `
  <div class="pop-card" role="dialog" aria-label="All warnings">
    <button type="button" id="pop-close" class="icon-btn pop-close" aria-label="Close">✕</button>
    <p class="eyebrow">Walk · ${fmtClock(w.clockMin)}</p>
    <h2>All warnings now</h2>
    <ul class="alerts">${alerts.map((a) => `<li class="alert ${a.level}">${esc(a.text)}</li>`).join("") || `<li class="alert info">No warnings right now.</li>`}</ul>
  </div>`;
}

function dataPopup(tab: DataTab): string {
  const slopeCheck = pkg.layers.find((l) => l.id === "slope-2m")?.caveats?.[0] ?? "";
  const geo = pkg.layers.find((l) => l.id === "geology-sim3464");
  let body: string;
  if (tab === "sources") {
    // on a narrow window the names and credits wrap to many lines: fewer rows on a page
    const { slice, nav } = paged("sources", pkg.sources, window.innerWidth < 620 ? 4 : 10);
    body = `
      <p class="small">Route style after the Curiosity route map (R3); layer list and compare view after NASA Worldview (R4). Neither is used as Mars map data.</p>
      <table class="pvr">
        <thead><tr><th>ID</th><th>Source</th><th>Credit</th></tr></thead>
        <tbody>${slice.map((x) => `<tr data-key="${esc(x.id)}"><td>${esc(x.id.split("-")[0])}</td><td>${esc(x.name)}</td><td>${esc(x.credit)}</td></tr>`).join("")}</tbody>
      </table>
      ${nav}`;
  } else if (tab === "checks") {
    const items: [string, string][] = [["slope", `<b>Slope check.</b> ${esc(slopeCheck)}`]];
    if (geo?.caveats?.[0]) items.push(["rock", `<b>Rock map.</b> ${esc(geo.caveats[0])}`]);
    if (weather) items.push(["weather", `<b>Weather.</b> Measured by Perseverance's MEDA station, sols ${weather.sols[0]}–${weather.sols[weather.sols.length - 1]} (${esc(weather.date_range ?? "")}): reference values, not a forecast. Sunrise and sunset are computed with the Mars24 equations, within ${weather.daylight.check.max_diff_min ?? "?"} min of the rover's own times.`]);
    if (space) {
      const events = space.donki.sep_events_30d;
      const donki = space.donki.status !== "ok" ? " NASA DONKI could not be reached."
        : events === undefined ? ""
        : ` NASA DONKI lists ${events === 0 ? "no solar particle event" : count(events, "solar particle event")} in the 30 days before.`;
      items.push(["sun", `<b>Sun activity.</b> ${esc(space.noaa.where_measured)} NOAA GOES, retrieved ${esc(conditions()?.dataDate ?? "")}.${donki}`]);
    }
    items.push(["load", `<b>Carried load.</b> A model, not a measurement: walking time grows with the mass each astronaut moves (body + suit + load).`]);
    if (pkg.placeNames?.length) items.push(["names", `<b>Place names.</b> ${pkg.placeNames.length} official names (Jezero, Belva, Neretva Vallis…) stand where the USGS map prints them: good from far away, not exact. Bright Angel, Cheyava Falls and Three Forks are the Perseverance team's own informal names.`]);
    items.push(["scale", `<b>Scale card.</b> Drawings at the map's scale in the middle of the view (a tilted view has no single scale). Real sizes from NASA: Perseverance rover 3 m, MRO orbiter 13.6 m, Space Shuttle orbiter 37 m, space station 109 m. The person (${Number(personHeightM.toFixed(1))} m) is a round value.`]);
    // the wide crater photo map is a preliminary mosaic: its limit is in the package, and the crew reads positions on it
    const wide = pkg.layers.find((l) => l.id === "tiles-ctx-wide")?.caveats?.find((c) => /preliminary/i.test(c));
    if (wide) items.push(["crater", `<b>Crater photo map.</b> ${esc(wide)}`]);
    items.push(["planet", `<b>Whole-planet map.</b> Two looks from Mars Trek: MOLA height colours and the Viking colour mosaic (a colourised mosaic, so its colours are approximate). Both are kept at about 330 m per pixel around Jezero and about 5 km per pixel for the rest of the planet: far-away context. The walk zones have photos at about 30 cm per pixel (from the 25 cm HiRISE mosaic).`]);
    // on a narrow window every line wraps to many lines: fewer lines on a page
    const { slice, nav } = paged("checks", items, window.innerWidth < 620 ? 4 : 10);
    body = `
      <ul class="plainlist">${slice.map(([key, html]) => `<li data-key="${key}">${html}</li>`).join("")}</ul>
      ${nav}`;
  } else {
    const list = pkg.assumptions.filter((a) => a.status === "to_verify");
    const { slice, nav } = paged("values", list, 7);
    body = `
      <p class="small muted">${list.length} starting values to confirm. They are planning values or first guesses, not measurements.</p>
      <ul class="plainlist">${slice.map((a) => `<li data-key="${esc(a.id)}"><b>${esc(a.id)}</b> ${fmtAssumption(a)}</li>`).join("")}</ul>
      ${nav}`;
  }
  const tabsDef: [DataTab, string][] = [["sources", "Sources and credits"], ["checks", "Checks and limits"], ["values", "Starting values"]];
  return `
  <div class="pop-card wide" role="dialog" aria-label="Data, credits and starting values">
    <button type="button" id="pop-close" class="icon-btn pop-close" aria-label="Close">✕</button>
    <p class="eyebrow">About the data</p>
    <nav class="subtabs" aria-label="Data sections">
      ${tabsDef.map(([k, l]) => `<button type="button" data-dtab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}
    </nav>
    <div class="pop-body" data-key="data-${tab}">${body}</div>
  </div>`;
}

// ------------------------------------------------------------------ walk-through (preview)
function previewPanel(): string {
  const tp = trackAt(preview.D);
  const total = preview.track[preview.track.length - 1].D;
  const leg = state.plan!.legs[tp.leg];
  const stop = preview.stopIdx >= 0 ? state.stops[preview.stopIdx] : null;
  return `
  <div class="p-body" id="p-body" data-key="preview">
    <header class="p-head">
      <p class="eyebrow">Walk-through</p>
      <h2 class="one-line" title="${esc(leg.fromName)} → ${esc(leg.toName)}">${esc(leg.fromName)} → ${esc(leg.toName)}</h2>
    </header>
    <div class="summary four">
      <div><span>Time</span><b>${fmtClock(tp.clock)}</b></div>
      <div><span>Of ${km(total)}</span><b>${km(preview.D)}</b></div>
      <div><span>Slope</span><b class="${tp.slope > model.comfortSlopeDeg ? "warn" : ""}">${tp.slope}°</b></div>
      <div><span>Radio</span><b class="${tp.radio ? "good" : "warn"}">${tp.radio ? "Yes" : "No"}</b></div>
    </div>
    <div class="controls">
      <button type="button" id="pv-play" class="primary">${preview.playing ? "Pause" : preview.D >= total ? "Play again" : "Play"}</button>
      <div class="seg" role="group" aria-label="Speed">${[1, 2, 4].map((v) => `<button type="button" data-pvspeed="${v}" class="${preview.speed === v ? "on" : ""}">${v}×</button>`).join("")}</div>
      <button type="button" id="pv-exit" class="secondary">Back to plan</button>
    </div>
    <p class="chart-legend">Height along the route</p>
    ${profileChart(profilePoints(preview.track), preview.stopD.map((d, i) => ({ d, label: String(i + 1) })), model.comfortSlopeDeg, preview.D)}
    <section class="arrive" id="pv-stop" data-key="pv-${preview.stopIdx}">
      ${stop ? `
      <p class="eyebrow">Stop ${preview.stopIdx + 1} · ${stop.minutes} min planned</p>
      <h2>${esc(stop.name)}</h2>
      ${stop.crewNote ? `<p class="crew-note">Note: ${esc(stop.crewNote)}</p>` : ""}
      ${photoStrip(stop.povIds, `pv-${stop.id}`) || `<p class="muted small">No rover photos at this new stop.</p>`}` : `<p class="muted small">The camera follows the planned route from behind. It pauses at each stop to show what the crew will see.</p>`}
    </section>
  </div>`;
}

function startPreview(): void {
  if (!state.plan || state.busy) return;
  leavePlanEditing();
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
  map.setWalker(p, crewLabel());
  map.droneView(p, metresBetween(grid.meta, p, ahead) > 1 ? bearingDeg(p, ahead) : 0);
  panelDirty = true;
}

// ------------------------------------------------------------------ walk (tablet)
function walkStops(): WalkStop[] {
  return state.stops.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat, minutes: s.minutes, tasks: s.tasks, povIds: s.povIds, note: s.crewNote }));
}

/** Leaving the plan screen: nothing of plan editing (pop-up, add-stop mode, selected pin) stays open over the next screen. */
function leavePlanEditing(): void {
  const hadSelection = state.selected !== null;
  state.popup = null;
  state.selected = null;
  state.addMode = false;
  $("#add-hint").hidden = true;
  if (hadSelection) refreshMap(); // the selected pin goes back to its normal look
}

/**
 * Show the walk. A walk in progress or a finished one (its summary) is kept;
 * a new walk starts when there is none, or when `fresh` asks for one after a finished walk.
 */
function openWalk(fresh = false): void {
  if (!state.plan || !state.approvedAt || state.busy) return;
  leavePlanEditing();
  const finished = walkUi.w?.phase === "done";
  if (walkUi.w && !finished && walkUi.w.skipped.length) {
    // back in a walk whose route was changed by "Skip next" or "Head home": draw that route, not the plan's
    map.setRoute(walkUi.w.legs, model.comfortSlopeDeg);
  }
  if (!walkUi.w || (finished && fresh)) {
    walkUi.w = startWalk(state.plan.legs, walkStops(), clockToMin(state.startClock));
    walkUi.tasks = {};
    walkUi.tab = "now";
    walkUi.startLoads = crewLoads();
    applyWalkLoad();
    walkUi.home = { clock: -1, minutes: 0 };
    walkUi.message = "";
    walkUi.carried = false;
    map.setRoute(state.plan.legs, model.comfortSlopeDeg); // a skip or "head home" in an earlier walk may have changed it
  }
  if (walkUi.w.phase === "done") setHud(false);
  state.mode = "walk";
  state.selected = null;
  walkUi.playing = false;
  map.setWalker(walkUi.w.pos, crewLabel());
  map.setTrack(walkUi.w.track);
  map.setNotes(walkUi.w.notes);
  map.resetDrone();
  placeWalkCamera();
  renderHud();
  renderPanel();
  ensureLoop();
}

/**
 * Turn the helmet view on or off. Beside the panel a narrow map leaves no room for the visor,
 * so there the helmet view takes the whole window: the panel slides away and "‹ Tablet" brings
 * it back.
 */
function setHud(on: boolean): void {
  walkUi.hud = on;
  const body = document.body.classList;
  if (on && body.contains("popup-full") && !body.contains("panel-closed")) {
    walkUi.hudFull = true;
    slide(() => body.add("panel-closed"));
  } else if (!on && walkUi.hudFull) {
    walkUi.hudFull = false;
    slide(() => body.remove("panel-closed"));
  }
  syncPanelShow();
}

/** The button that brings a hidden panel back. */
function syncPanelShow(): void {
  const b = $("#panel-show");
  b.hidden = !document.body.classList.contains("panel-closed");
  b.textContent = walkUi.hudFull ? "‹ Tablet" : "‹ Panel";
  b.setAttribute("aria-label", walkUi.hudFull ? "Leave the helmet view and show the tablet" : "Show the panel");
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
    document.body.classList.remove("hud-on");
    return;
  }
  document.body.classList.add("hud-on");
  const stop = currentStop(w);
  const target = nextTarget(w);
  const tgt = target ?? { ...pkg.site.base.position, name: "Habitat" };
  const order = state.stops.findIndex((s) => s.id === (stop ?? target)?.id) + 1;
  const alerts = walkAlerts(w);
  const top = alerts.find((a) => a.level === "bad") ?? alerts.find((a) => a.level === "care") ?? alerts[0] ?? null;
  morph(el, hudHtml({
    label: stop ? `AT STOP ${order}` : target ? `NEXT · STOP ${order}` : "NEXT",
    target: stop ? stop.name : tgt.name,
    distM: stop ? null : metresBetween(grid.meta, w.pos, tgt),
    relDeg: stop ? null : relativeBearing(bearingDeg(w.pos, tgt), crewHeading(w)),
    timeLeftMin: w.startMin + evaMin - w.clockMin,
    radio: w.pos.radio,
    stopTimer: stop ? { elapsed: w.stopElapsed, planned: plannedStopMin(w) } : null,
    warning: top ? { level: top.level, text: top.short } : null,
  }));
  el.hidden = false;
}

/** Minutes to walk straight home from where the crew is now (re-routed every few simulated minutes). */
function timeHome(w: WalkState): number {
  if (walkUi.home.clock >= 0 && Math.abs(w.clockMin - walkUi.home.clock) < 3) return walkUi.home.minutes;
  const r = routeLegs(planInput(), { id: "here", name: "Here", lon: w.pos.lon, lat: w.pos.lat, minutes: 0 }, []);
  // with the load the crew carries now (the route search itself uses the standard kit)
  walkUi.home = { clock: w.clockMin, minutes: r.ok ? r.legs[0].minutes * timeFactor(loadModel, heaviest(walkLoads())) : 0 };
  return walkUi.home.minutes;
}

/** text = tablet wording; short = helmet wording (at most 60 characters). */
/** key: a stable name for the warning (its text changes, e.g. "Contact back in about 3 min"). */
type Alert = { key: string; level: "info" | "care" | "bad"; text: string; short: string };

function walkAlerts(w: WalkState): Alert[] {
  const out: Alert[] = [];
  if (w.phase === "done") return out;
  const start = w.startMin;
  const latest = start + evaMin * (1 - reserve);
  const proj = projectedReturnMin(w);
  const turnBy = latest - timeHome(w);
  const stopsLeft = w.phase === "walking" ? w.queue.length : w.queue.length - 1;
  if (proj > start + evaMin) out.push({ key: "limit", level: "bad", text: `Back at ${fmtClock(proj)}: past the ${evaMin / 60} h walk limit. Skip a stop or head home now.`, short: "Past the walk limit · head home" });
  else if (proj > latest) out.push({ key: "late", level: "care", text: `Running late: back at ${fmtClock(proj)}, but the reserve rule needs you back by ${fmtClock(latest)}.${stopsLeft > 0 ? " Skip the next stop or leave sooner." : ""}`, short: "Running late · reserve at risk" });
  if (stopsLeft > 0 && w.clockMin >= turnBy - 25) {
    const n = Math.round(turnBy - w.clockMin);
    out.push(n > 0
      ? { key: "turnback", level: "care", text: `Turn back in ${n} min to keep your reserve.`, short: `Turn back in ${n} min to keep your reserve` }
      : { key: "turnback-now", level: "bad", text: "Turn back now to keep your reserve.", short: "Turn back now" });
  }
  const c = conditions();
  if (c && w.clockMin > c.sunsetMin - c.beforeSunsetMin) out.push({ key: "sunset", level: "bad", text: `Sunset at ${fmtClock(c.sunsetMin)}. Head home now.`, short: "Sunset soon · head home" });
  if (w.phase === "at_stop") {
    const name = currentStop(w)!.name;
    if (w.stopElapsed < 3) out.push({ key: "arrived", level: "info", text: `You have arrived at ${name}.`, short: `Arrived · ${name}`.slice(0, 60) });
    return out;
  }
  if (!w.pos.radio) {
    const back = minutesToRadio(w);
    out.push({ key: "radio-lost", level: "care", text: `No radio to the habitat now. Stay together.${back !== null ? ` Contact back in about ${Math.max(1, Math.round(back))} min.` : ""}`, short: "No radio · stay together" });
  } else {
    const ahead = lookAhead(w, 60);
    const lost = ahead.find((p) => !p.radio);
    if (lost) {
      const regain = w.legs[0].samples.find((p) => p.t > lost.t && p.radio);
      const len = Math.max(1, Math.round((regain ? regain.t : w.legs[0].minutes) - lost.t));
      out.push({ key: "radio-ahead", level: "info", text: `Radio drops ahead for about ${len} min.`, short: `Radio drops ahead · ${len} min` });
    }
  }
  const ahead = lookAhead(w, 60);
  const maxSlope = ahead.reduce((a, p) => Math.max(a, p.slope), 0);
  if (maxSlope > model.comfortSlopeDeg) out.push({ key: "steep", level: "care", text: `Steeper ground ahead (up to ${maxSlope}°). Slow down.`, short: `Steep ground ahead · ${maxSlope}°` });
  if (ahead.some((p, i) => i % 5 === 0 && unitAt(p)?.symbol === "Aeb")) out.push({ key: "sand", level: "care", text: "Sand ripples ahead (eolian bedform unit). Keep to firm ground.", short: "Sand ripples ahead · keep to firm ground" });
  if (ahead.some((p) => { const r = grid.rough[cellIndex(grid.meta, p.lon, p.lat)]; return r !== 255 && r >= 25; })) out.push({ key: "rough", level: "info", text: "Bumpy, rocky ground ahead.", short: "Rocky ground ahead" });
  return out;
}

function arrow(deg: number): string {
  return `<svg class="arrow" viewBox="0 0 40 40" aria-hidden="true"><g transform="rotate(${deg.toFixed(0)} 20 20)"><path d="M20 4 L31 30 L20 24 L9 30 Z" fill="currentColor"/></g></svg>`;
}

/** Most urgent first. */
function sortedAlerts(alerts: Alert[]): Alert[] {
  const rank = { bad: 0, care: 1, info: 2 } as const;
  return [...alerts].sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Up to `max` warnings; the rest open in a pop-up, so the panel keeps its size. */
function alertsHtml(alerts: Alert[], max: number): string {
  const sorted = sortedAlerts(alerts);
  const more = sorted.length - max;
  return `<ul class="alerts" id="wk-alerts">${sorted.slice(0, max).map((a) => `<li class="alert ${a.level}" data-key="${a.key}">${esc(a.text)}</li>`).join("")}${more > 0 ? `<li data-key="more"><button type="button" class="linkish" id="more-alerts">+${more} more warning${more > 1 ? "s" : ""}</button></li>` : ""}</ul>`;
}

function carryingText(): string {
  const loads = walkLoads();
  const f = factorText(timeFactor(loadModel, heaviest(loads)));
  return `Carrying ${loads.map((kg, i) => `astronaut ${i + 1}: ${kgText(kg)}`).join(" · ")}${f ? ` · walking ${f}` : ""}`;
}

function walkPanel(): string {
  const w = walkUi.w!;
  const plan = state.plan!;
  if (w.phase === "done") return `<div class="p-body" id="p-body" data-key="walk-done">${walkSummary(w, plan)}</div>`;
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
  const order = state.stops;
  const msg = `<p class="note" id="wk-msg" ${walkUi.message ? "" : "hidden"}>${esc(walkUi.message)}</p>`;
  // One row for both phases, with a fixed slot per button: a slot never changes its action, it
  // is only switched off. So a second or late click can never land on another action
  // (before, "Head home now" appeared where "Leave now" had been).
  const homeward = !stop && w.legs[0]?.toId === "base";
  const noSkip = stop ? w.queue.length < 2 : homeward;
  const actions = `
    <div class="row four" data-key="walk-actions">
      <button type="button" id="w-stay" class="secondary" title="Stay 10 minutes longer at this stop" ${stop ? "" : "disabled"}>Stay +10</button>
      <button type="button" id="w-leave" class="${stop ? "primary" : "secondary"}" title="Leave this stop now" ${stop ? "" : "disabled"}>Leave now</button>
      <button type="button" id="w-skip" class="secondary" title="Skip the next stop; the route is drawn again from here" ${noSkip ? "disabled" : ""}>Skip next</button>
      <button type="button" id="w-home" class="secondary" title="Skip every stop that is left and walk home on the safest route" ${homeward ? "disabled" : ""}>Head home</button>
    </div>`;

  let body: string;
  if (walkUi.tab === "progress") {
    const done = new Set(w.log.map((l) => l.id));
    const skipped = new Set(w.skipped);
    const { track, stopD } = buildTrack(plan);
    const { slice, nav, start } = paged("wk-stops", order, order.length > 10 ? 8 : 10); // with a page control: two rows less
    body = `
    <h3>Progress</h3>
    <p class="muted small one-line">${km(w.walkedM)} walked of ${km(w.plannedM)} planned${isDepot() ? ` · tubes picked up ${tubesPicked().picked} of ${tubesPicked().total}` : ""}</p>
    <p class="muted small carrying">${carryingText()}</p>
    <ol class="progress">
      ${slice.map((s, k) => {
        const i = start + k;
        const st = skipped.has(s.id) ? "skipped" : done.has(s.id) && !(stop && stop.id === s.id) ? "done" : stop && stop.id === s.id ? "here" : target && target.id === s.id ? "next" : "later";
        const label = { skipped: "skipped", done: "done", here: "here now", next: "next", later: "" }[st];
        return `<li class="${st}" data-key="${esc(s.id)}"><span class="num">${i + 1}</span><span class="name">${esc(s.name)}</span> <small>${label}</small></li>`;
      }).join("")}
    </ol>
    ${nav}
    ${profileChart(profilePoints(track), stopD.map((d, i) => ({ d, label: String(i + 1) })), model.comfortSlopeDeg, Math.min(w.walkedM, track[track.length - 1].D))}`;
  } else if (walkUi.tab === "notes") {
    const { slice, nav } = paged("wk-notes", [...w.notes].reverse(), 7);
    body = `
    <label class="field">Field note <input type="text" id="w-note" value="${esc(walkUi.noteDraft)}" placeholder="Pinned to where you are now" autocomplete="off"></label>
    <div class="row"><button type="button" id="w-pin" class="secondary">Pin note</button><button type="button" id="w-idea" class="secondary">Mark for next walk</button></div>
    ${msg}
    <h3>Notes on this walk <small class="muted">${w.notes.length}</small></h3>
    <ul class="notes-list">${slice.map((n) => `<li title="${esc(n.text)}"><b>${fmtClock(n.clockMin)}</b> · ${n.kind === "idea" ? "For next walk: " : ""}${esc(n.text)}</li>`).join("") || `<li class="muted">No notes yet. A note is pinned to the map where the crew stands.</li>`}</ul>
    ${nav}`;
  } else if (stop) {
    const n = order.findIndex((s) => s.id === stop.id) + 1;
    // The card and the buttons come first and have a fixed size, so no button moves while the
    // clock runs. Everything that can change (warnings, messages) comes last.
    body = `
    <section class="navcard" data-key="at-${esc(stop.id)}">
      <span class="num stop-num">${n}</span>
      <div>
        <p class="eyebrow">At stop ${n} of ${order.length}</p>
        <h2>${esc(stop.name)}</h2>
        <p class="muted">Time here ${Math.floor(w.stopElapsed)} of ${plannedStopMin(w)} min</p>
        <div class="timer"><span style="width:${Math.min(100, (w.stopElapsed / plannedStopMin(w)) * 100).toFixed(1)}%"></span></div>
      </div>
    </section>
    ${actions}
    ${walkUi.message
      ? `<p class="small one-line stop-msg" id="wk-msg" title="${esc(walkUi.message)}">${esc(walkUi.message)}</p>`
      : `<p class="muted small one-line">Then: <bdi>${esc(target ? target.name : "Habitat")}</bdi> · ${km(dist)} ${compass(brg)}</p>`}
    <p class="crew-note one-line" title="${esc(stop.note ?? "")}" ${stop.note ? "" : "hidden"}>Crew note: ${esc(stop.note ?? "")}</p>
    ${photoStrip(stop.povIds, `w-${stop.id}`, true) || `<p class="muted small">No rover photos here: a new place.</p>`}
    <ul class="checklist">${stop.tasks.map((t) => `<li><label><input type="checkbox" data-task="${esc(t)}" ${(walkUi.tasks[stop.id] ?? []).includes(t) ? "checked" : ""}> ${esc(t)}</label></li>`).join("")}</ul>
    ${alertsHtml(alerts.filter((a) => a.key !== "arrived"), 1)}`;
  } else {
    body = `
    <section class="navcard" data-key="nav">
      ${arrow(brg)}
      <div>
        <p class="eyebrow">Next</p>
        <h2>${esc(target ? target.name : "Habitat")}</h2>
        <p class="muted">${km(dist)} · about ${mins(legMin)} · ${compass(brg)} (${Math.round(brg)}°)</p>
      </div>
    </section>
    ${actions}
    <p class="muted small carrying">${carryingText()}</p>
    ${alertsHtml(alerts, 3)}
    ${msg}`;
  }

  const wtabs: [WalkTab, string][] = [
    ["now", stop ? `At stop${walkUi.tab === "now" ? "" : ` <i class="tdot care"></i>`}` : "Now"],
    ["progress", "Progress"],
    ["notes", `Notes${w.notes.length ? ` ${w.notes.length}` : ""}`],
  ];
  return `
  <header class="walk-head">
    <div><p class="eyebrow">Walk · ${esc(zone.name)}</p><p><b class="clock">${fmtClock(w.clockMin)}</b> <small class="muted">local Mars time</small></p></div>
    <div class="right"><span class="pill ${status.cls}">${status.text}</span><small class="muted">Back by ${fmtClock(proj)}</small><small class="muted">${mins(Math.max(0, w.startMin + evaMin - w.clockMin))} of walk time left</small></div>
  </header>
  <nav class="subtabs even" aria-label="Walk sections">
    ${wtabs.map(([k, l]) => `<button type="button" data-wtab="${k}" class="${walkUi.tab === k ? "on" : ""}">${l}</button>`).join("")}
    <button type="button" data-view="${walkUi.hud ? "map" : "hud"}" class="hud-toggle ${walkUi.hud ? "on" : ""}" aria-pressed="${walkUi.hud}" title="Switch between the tablet map and the helmet display">Helmet view</button>
  </nav>
  <div class="p-body" id="p-body" data-key="walk-${walkUi.tab}">${body}</div>
  <footer class="p-foot demo">
    <div class="controls">
      <button type="button" id="w-play" class="primary">${walkUi.playing ? "Pause" : "Play"}</button>
      <div class="seg" role="group" aria-label="Speed">${[[0.5, "×30"], [1, "×60"], [2, "×120"]].map(([v, l]) => `<button type="button" data-wspeed="${v}" class="${walkUi.speed === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <button type="button" id="w-jump" class="secondary">Jump to next event</button>
    </div>
    <label class="compare"><input type="checkbox" id="w-follow" ${walkUi.follow ? "checked" : ""}> Map follows the crew <small>· time-lapse demo of the approved route</small></label>
  </footer>`;
}

function walkSummary(w: WalkState, plan: PlanResult): string {
  const actual = w.clockMin - w.startMin;
  const visits = paged("sum-visits", w.log, isDepot() ? 7 : 9); // the depot zone has one more row of numbers
  const notes = paged("sum-notes", w.notes, 3);
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
    <div><span>Stops visited</span><b>${w.log.length}</b></div>
    <div><span>Skipped</span><b class="${w.skipped.length ? "warn" : ""}">${w.skipped.length}</b></div>
    ${isDepot() ? `<div><span>Tubes picked up</span><b>${tubesPicked().picked} of ${tubesPicked().total}</b></div>` : ""}
  </div>
  <h3>Visited</h3>
  <ul class="notes-list">${visits.slice.map((l) => {
    const rest = `${fmtClock(l.arrivedMin)}–${fmtClock(l.leftMin ?? l.arrivedMin)}, ${count((walkUi.tasks[l.id] ?? []).length, "task")} ticked`;
    return `<li title="${esc(l.name)}: ${rest}"><b>${esc(l.name)}</b>: ${rest}</li>`;
  }).join("")}</ul>
  ${visits.nav}
  <div id="sum-notes" ${w.notes.length ? "" : "hidden"}>
    <h3>Field notes <small class="muted">${w.notes.length}</small></h3>
    <ul class="notes-list">${notes.slice.map((n) => `<li title="${esc(n.text)}">${fmtClock(n.clockMin)} · ${n.kind === "idea" ? "For next walk: " : ""}${esc(n.text)}</li>`).join("")}</ul>
    ${notes.nav}
  </div>
  <p class="muted small">The walked line (white) and the plan (colours) stay on the map.</p>
  <div class="row three">
    <button type="button" id="replay" class="primary">Replay</button>
    <button type="button" id="send-report" class="secondary">Send report</button>
    <button type="button" id="w-back" class="secondary">Back to plan</button>
  </div>`;
}

// ------------------------------------------------------------------ replay (after the walk)
function openReplay(): void {
  const w = walkUi.w;
  if (!w || w.phase !== "done" || !state.plan) return;
  state.mode = "replay";
  state.popup = null;
  setHud(false);
  replay.clock = w.startMin;
  replay.playing = false;
  replay.tab = "events";
  map.setRoute(state.plan.legs, model.comfortSlopeDeg);
  map.setTrack(w.track);
  map.setNotes(w.notes);
  map.setWalker(trackAtClock(w.track, replay.clock), crewLabel());
  map.flyToSite(pkg.site.center, 1.5);
  renderHud();
  renderPanel();
}

function replayPanel(): string {
  const w = walkUi.w!;
  const plan = state.plan!;
  const done = w.track.filter((t) => t.clockMin <= replay.clock);
  let walked = 0;
  for (let i = 1; i < done.length; i++) walked += metresBetween(grid.meta, done[i - 1], done[i]);
  let body: string;
  if (replay.tab === "table") {
    const arrivals = plannedArrivals(plan);
    const visited = new Map(w.log.map((l) => [l.id, l]));
    const skipped = new Set(w.skipped);
    const { slice, nav, start } = paged("rp-table", state.stops, 10);
    body = `
    <table class="pvr">
      <thead><tr><th>Stop</th><th>Arrival</th><th>Time there</th></tr></thead>
      <tbody>
      ${slice.map((s, k) => {
        const i = start + k;
        const v = visited.get(s.id);
        const late = v ? Math.round(v.arrivedMin - arrivals[i]) : 0;
        return `<tr><td>${i + 1}. ${esc(s.name)}</td>
          <td>${v ? `${fmtClock(v.arrivedMin)} <small class="${late > 5 ? "warn" : "muted"}">(${late >= 0 ? "+" : ""}${late} min)</small>` : `<small class="muted">${skipped.has(s.id) ? "skipped" : "not reached"}</small>`}</td>
          <td>${v && v.leftMin !== undefined ? `${Math.round(v.leftMin - v.arrivedMin)} of ${s.minutes} min` : "–"}</td></tr>`;
      }).join("")}
      </tbody>
    </table>
    ${nav}`;
  } else {
    // while the replay plays, the list follows the clock; paging by hand works when it is paused
    if (replay.playing) state.pages["rp-events"] = replayPage(w);
    const { slice, nav } = paged("rp-events", w.events, RP_EVENTS);
    body = `
    <ol class="timeline">
      ${slice.map((e) => `<li class="${e.clockMin <= replay.clock ? "past" : ""}"><button type="button" class="link" data-jump="${e.clockMin}" title="${esc(e.text)}"><b>${fmtClock(e.clockMin)}</b> ${esc(e.text)}</button></li>`).join("")}
    </ol>
    ${nav}`;
  }
  return `
  <div class="p-body" id="p-body" data-key="replay">
    <header class="p-head">
      <p class="eyebrow">Walk replay</p>
      <h2>${esc(zone.name)} walk</h2>
      <p class="muted small">The white line is where the crew walked; the colours are the plan.</p>
    </header>
    <div class="replay-clock one-line"><b id="rp-clock">${fmtClock(replay.clock)}</b> <small class="muted">local Mars time · <span id="rp-dist">${km(walked)}</span> walked</small></div>
    <input type="range" id="rp-slider" min="${w.startMin}" max="${w.clockMin}" step="0.5" value="${replay.clock}" aria-label="Replay time">
    <div class="controls">
      <button type="button" id="rp-play" class="primary">${replay.playing ? "Pause" : replay.clock >= w.clockMin ? "Play again" : "Play"}</button>
      <div class="seg" role="group" aria-label="Speed">${[[1, "×60"], [2, "×120"], [4, "×240"]].map(([v, l]) => `<button type="button" data-rpspeed="${v}" class="${replay.speed === v ? "on" : ""}">${l}</button>`).join("")}</div>
    </div>
    <nav class="subtabs" aria-label="Replay sections">
      <button type="button" data-rtab="events" class="${replay.tab === "events" ? "on" : ""}">What happened</button>
      <button type="button" data-rtab="table" class="${replay.tab === "table" ? "on" : ""}">Plan and reality</button>
    </nav>
    <div class="pop-body" data-key="rp-${replay.tab}">${body}</div>
  </div>
  <footer class="p-foot">
    <div class="row">
      <button type="button" id="send-report" class="primary">Send report to Earth</button>
      <button type="button" id="w-back" class="secondary">Back to plan</button>
    </div>
  </footer>`;
}

const RP_EVENTS = 12; // events on one page of "What happened"

/** The page of "What happened" that holds the replay's clock time. */
function replayPage(w: WalkState): number {
  return Math.floor(Math.max(0, w.events.filter((e) => e.clockMin <= replay.clock).length - 1) / RP_EVENTS);
}

function stepReplay(dt: number): void {
  const w = walkUi.w;
  if (!w || !replay.playing) return;
  replay.clock = Math.min(w.clockMin, replay.clock + replay.speed * dt);
  if (replay.clock >= w.clockMin) replay.playing = false;
  map.setWalker(trackAtClock(w.track, replay.clock), crewLabel());
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
    crewSize: state.crewSize,
    load: {
      legs: plan.legs.map((l) => ({ from: l.fromName, to: l.toName, plannedKg: l.loadKg ?? loadModel.kitKg, factor: l.loadFactor ?? 1 })),
      startKg: walkUi.startLoads,
      endKg: walkLoads(),
      kitKg: loadModel.kitKg,
    },
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
      <p>${count(r.summary.stopsVisited, "stop")} visited, ${r.summary.stopsSkipped} skipped, ${(r.summary.walkedM / 1000).toFixed(2)} km walked, ${count(r.notes.length, "field note")}.</p>
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
    if (e.type === "home") {
      walkUi.playing = false;
      walkUi.message = "";
    }
    if (e.type === "arrived" || e.type === "left") walkUi.message = ""; // a message belongs to the moment before
    // The tab the crew chose stays open (Progress, Notes): arriving never changes the screen
    // under them. The first tab's label turns into "At stop" with a dot instead.
  }
  map.setWalker(w.pos, crewLabel());
  map.setTrack(w.track);
  if ((w.phase as string) === "done" && walkUi.hud) setHud(false); // tick() may have ended the walk
  placeWalkCamera();
  renderHud();
  panelDirty = true;
}

function jumpToNextEvent(): void {
  const w = walkUi.w;
  if (!w) return;
  // Stop on a walk event or on a warning that is new; warnings already showing don't count.
  const before = `${w.phase} ${w.queue.length}`;
  advanceToNextEvent(w, (s) => walkAlerts(s).filter((a) => a.level !== "info").map((a) => a.key));
  if (`${w.phase} ${w.queue.length}` !== before) walkUi.message = ""; // arrived or left: the old message is over
  if (w.phase === "done") setHud(false);
  map.setWalker(w.pos, crewLabel());
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
  setHud(false);
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
    let again = false;
    try {
      const dt = Math.min(0.25, (t - lastT) / 1000);
      lastT = t;
      step(dt);
      // renderPanel() only changes the text and attributes that differ (see morph.ts), so buttons
      // and photos are not re-created while the walk plays: no flicker, and no lost clicks.
      if (panelDirty && t - lastPanel > 200) {
        renderPanel();
        panelDirty = false;
        lastPanel = t;
      }
      again = panelDirty || (state.mode === "preview" && preview.playing) || (state.mode === "walk" && walkUi.playing) || (state.mode === "replay" && replay.playing);
    } finally {
      // also after an error: the loop must be able to start again
      if (again) requestAnimationFrame(frame);
      else looping = false;
    }
  };
  requestAnimationFrame(frame);
}

/**
 * The footer's buttons change when a route arrives and when the plan is approved. A second
 * click of a double-click must not land on the button that has just appeared in the same place.
 */
let footerChangedAt = 0;
const footerJustChanged = () => performance.now() - footerChangedAt < 450;

// ------------------------------------------------------------------ plan actions
function renderLightbox(): void {
  const lb = $("#lightbox");
  const p = state.photo ? photos.get(state.photo) : null;
  if (!p) {
    lb.hidden = true;
    lb.innerHTML = "";
    return;
  }
  const set = state.photoSet.includes(p.imageId) && state.photoSet.length > 1 ? state.photoSet : [];
  const i = set.indexOf(p.imageId);
  lb.hidden = false;
  lb.innerHTML = `
    <div class="lb-inner" role="dialog" aria-label="Rover photo">
      <img src="${PKG}${esc(p.urls.packagePath)}" alt="${esc(cameraName(p.instrument))} photo, sol ${p.sol}">
      <div class="lb-text">
        <b>${isCloseUp(p) ? "Close-up · " : ""}${esc(cameraName(p.instrument))} · sol ${p.sol}${p.pointing?.mastAz_deg !== undefined ? ` · mast angle ${Math.round(((p.pointing.mastAz_deg % 360) + 360) % 360)}°` : ""}</b>
        <small>${esc(p.caption ?? "")} Credit: ${esc(p.credit)}.</small>
        ${p.urls.full ? `<a href="${esc(p.urls.full)}" target="_blank" rel="noopener">Full size at NASA (needs internet)</a>` : ""}
      </div>
      <div class="lb-actions">
        ${set.length ? `<button type="button" id="lb-prev" class="secondary" ${i <= 0 ? "disabled" : ""}>‹ Previous</button><span class="muted small">${i + 1} of ${set.length}</span><button type="button" id="lb-next" class="secondary" ${i >= set.length - 1 ? "disabled" : ""}>Next ›</button>` : ""}
        <button type="button" id="lb-close" class="secondary">Close</button>
      </div>
    </div>`;
}

function stepPhoto(dir: number): void {
  const i = state.photoSet.indexOf(state.photo ?? "");
  const next = state.photoSet[i + dir];
  if (i < 0 || !next) return;
  state.photo = next;
  renderLightbox();
}

/** Select a stop: its pin is highlighted and its details open as a pop-up. */
function select(id: string | null): void {
  state.selected = id;
  if (id) state.popup = { kind: "stop" };
  else if (state.popup?.kind === "stop") state.popup = null;
  refreshMap();
  renderPanel();
}

function stopFromPackage(s: MissionPackage["stops"][number]): StopState {
  return {
    id: s.id, name: s.name, lon: s.position.lon, lat: s.position.lat, minutes: s.plannedMinutes ?? 30,
    tasks: s.tasks ?? [], unit: s.geologicUnit, notes: s.notes, crewNote: "", povIds: s.povImageIds ?? [], custom: false,
  };
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
  const fallback = `New stop ${state.nextId}`;
  const u = unitAt(p);
  state.stops.push({
    id, name: name ?? fallback, defaultName: fallback, lon: p.lon, lat: p.lat, minutes: 20, tasks: ["Photos", "Notes"],
    unit: u ? `${u.symbol}: ${u.name}` : undefined, crewNote: "", povIds: [], custom: true,
  });
  state.nextId++;
  state.addMode = false;
  $("#add-hint").hidden = true;
  state.tab = "stops";
  markStale();
  select(id);
  // the new stop opens with its name selected, so the crew can type their own name straight away
  const field = document.querySelector<HTMLInputElement>("#stop-name");
  field?.focus();
  field?.select();
}

/** Rename a stop the crew added. The new name shows on the map, in the route, on the walk and in the report. */
function renameStop(s: StopState, raw: string): void {
  s.name = cleanStopName(raw, s.defaultName || "New stop");
  for (const l of state.plan?.legs ?? []) {
    if (l.fromId === s.id) l.fromName = s.name;
    if (l.toId === s.id) l.toName = s.name;
  }
  if (walkUi.w) renameStopInWalk(walkUi.w, s.id, s.name); // legs, queue, visit log and the "what happened" list
  refreshMap();
  renderPanel();
}

function runPlan(): void {
  state.busy = true;
  state.approvedAt = null; // the old approval ends now, not when the new route arrives
  if (walkUi.w) {
    walkUi.w = null; // a walk belongs to the plan it was started on
    map.setTrack([]);
    map.setNotes([]);
  }
  renderPanel();
  setTimeout(() => {
    const res = computePlan(planInput());
    state.busy = false;
    state.approvedAt = null; // nothing approved in the meantime counts for the new route
    footerChangedAt = performance.now();
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
    id: `route-${zone.key}-${Date.now()}`,
    siteId: pkg.site.id,
    name: `${zone.name} walk`,
    status: "approved",
    constraints: {
      comfortSlope_deg: model.comfortSlopeDeg, maxSlope_deg: model.maxSlopeDeg, walkingSpeedFlat_kmh: +(model.flatSpeedMs * 3.6).toFixed(2),
      evaDuration_min: evaMin, reserveFraction: reserve, gravity_ms2: 3.71, crewSize: state.crewSize, buddyRule: state.crewSize >= 2,
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
    kind: "baramger-plan",
    route,
    startLmst: state.startClock,
    crewNotes: state.stops.filter((s) => s.crewNote).map((s) => ({ stopId: s.id, note: s.crewNote })),
    crew: { size: state.crewSize, startLoadsKg: crewLoads() },
    loadPerLeg: p.legs.map((l) => ({ fromStopId: l.fromId, toStopId: l.toId, heaviestLoadKg: +(l.loadKg ?? loadModel.kitKg).toFixed(2), timeFactor: +(l.loadFactor ?? 1).toFixed(4) })),
    ideas: state.ideas,
  };
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `baramger-plan-${pkg.site.id}.json`;
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
/** Clicks in the panel and in pop-ups. */
/** True when the last mouse or touch press started on the dimmed area around a pop-up (not inside its card). */
let pressOnBackdrop = false;

function onUiClick(ev: Event): void {
  const t = ev.target as HTMLElement;
  if (t.id === "popup") { // the dimmed area around a pop-up
    if (!pressOnBackdrop) return; // a text selection that ended outside the card is not a "close"
    if (state.popup?.kind === "stop") select(null);
    else closePopup();
    return;
  }
  const el = t.closest("[data-place-open],[data-place-add],[data-open],[data-move],[data-remove],[data-photo],[data-mode],[data-pvspeed],[data-wspeed],[data-rpspeed],[data-jump],[data-view],[data-idea],[data-tab],[data-wtab],[data-rtab],[data-dtab],[data-page],[data-check],[data-zone],[data-base],button") as HTMLElement | null;
  // closest() also looks above the panel (up to <body>): only elements inside the panel or pop-up count
  if (!el || !(ev.currentTarget as Element).contains(el)) return;
  const w = walkUi.w;
  if (el.dataset.placeOpen) {
    state.popup = { kind: "place", id: el.dataset.placeOpen };
    renderPopup();
  } else if (el.dataset.base) {
    state.baseStyle = el.dataset.base as BaseStyle;
    prefs.set("baramger.base", state.baseStyle); // remembered for the next visit
    map.setBaseStyle(state.baseStyle);
    renderPanel();
  } else if (el.dataset.placeAdd) {
    if (state.mode !== "plan") return; // stops change only on the plan screen
    const ps = pkg.stops.find((x) => x.id === el.dataset.placeAdd);
    if (ps && !state.stops.some((x) => x.id === ps.id)) {
      state.stops.push(stopFromPackage(ps));
      markStale();
      flash(`${ps.name} is a stop again. Press Find safest route.`);
    }
    if (state.popup?.kind === "place") state.popup = null; // the list stays open, with the place marked as added
    state.tab = "stops";
    refreshMap();
    renderPanel();
  } else if (el.dataset.tab) {
    state.tab = el.dataset.tab as PlanTab;
    renderPanel();
  } else if (el.dataset.wtab) {
    walkUi.tab = el.dataset.wtab as WalkTab;
    renderPanel();
  } else if (el.dataset.rtab) {
    replay.tab = el.dataset.rtab === "table" ? "table" : "events";
    renderPanel();
  } else if (el.dataset.dtab) {
    // opened from the panel, the pop-up starts on the first page of its lists
    if (state.popup?.kind !== "data") for (const key of ["sources", "checks", "values"]) state.pages[key] = 0;
    state.popup = { kind: "data", tab: el.dataset.dtab as DataTab };
    renderPopup();
  } else if (el.dataset.page) {
    state.pages[el.dataset.page] = (state.pages[el.dataset.page] ?? 0) + Number(el.dataset.dir);
    renderPanel();
  } else if (el.dataset.check) {
    state.checkSel = el.dataset.check;
    renderPanel();
  } else if (el.dataset.zone) {
    enterZone(el.dataset.zone);
  } else if (el.dataset.view) {
    setHud(el.dataset.view === "hud");
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
    map.setWalker(trackAtClock(w.track, replay.clock), crewLabel());
    renderPanel();
  } else if (el.dataset.mode) {
    if (el.dataset.mode !== "walk") backToPlan();
    // From the replay this goes back to the walk summary. On the walk itself the tab is already
    // open: do nothing (it used to start a new walk and throw the finished one away).
    else if (state.mode !== "walk") openWalk();
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
    state.photoSet = (el.dataset.set ?? "").split(",").filter(Boolean);
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
    case "pop-close":
      if (state.popup?.kind === "stop") select(null);
      else closePopup();
      break;
    case "panel-hide":
      slide(() => document.body.classList.add("panel-closed"));
      syncPanelShow();
      break;
    case "open-legs":
      state.popup = { kind: "legs" };
      renderPopup();
      break;
    case "open-places":
      // the list is fixed while the pop-up is open, so no row moves when a place is added
      state.popup = { kind: "places", ids: placesOffPlan().map((s) => s.id) };
      renderPopup();
      break;
    case "open-ideas":
      state.popup = { kind: "ideas" };
      renderPopup();
      break;
    case "more-alerts":
      state.popup = { kind: "alerts" };
      renderPopup();
      break;
    case "place-fly": {
      const ps = pkg.stops.find((x) => x.id === el.dataset.place);
      closePopup();
      if (ps) map.flyToPoint({ lon: ps.position.lon, lat: ps.position.lat });
      break;
    }
    case "globe-jezero": flyToCrater(); break;
    case "globe-home": map.flyToPlanet(zonesMiddle()); break;
    case "intro-replay":
      session.remove("baramger.intro");
      void runIntro(Promise.resolve());
      break;
    case "add-stop":
      state.addMode = !state.addMode;
      $("#add-hint").hidden = !state.addMode;
      if (state.addMode && state.popup) {
        // an open pop-up would catch the next map click: close it first
        state.popup = null;
        state.selected = null;
        refreshMap();
      }
      renderPanel();
      break;
    case "find-route":
      if (footerJustChanged()) break;
      if (state.tab === "goal" || state.tab === "layers" || state.tab === "stops") state.tab = "route";
      runPlan();
      break;
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
      if (state.busy || footerJustChanged()) break; // never approve a route that is still being found
      footerChangedAt = performance.now();
      const d = new Date();
      state.approvedAt = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      renderPanel();
      break;
    }
    case "save-plan": savePlan(); break;
    case "go-walk":
      if (!footerJustChanged()) openWalk(true); // after a finished walk this button starts a new one
      break;
    case "fly-stop": {
      const s = state.stops.find((x) => x.id === state.selected);
      closePopup(); // the pin stays highlighted
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
    case "w-leave":
      if (w) {
        leaveStop(w);
        walkUi.message = "";
        renderPanel();
      }
      break;
    case "w-skip":
      if (w) {
        const r = skipNext(w, planInput());
        walkUi.message = r.ok ? `Skipped ${r.skipped.name}. New route drawn.` : r.error;
        if (r.ok) applyWalkLoad();
        if (r.ok) map.setRoute(w.legs, model.comfortSlopeDeg);
        walkUi.home.clock = -1;
        renderPanel();
      }
      break;
    case "w-home":
      if (w && w.phase !== "done") { // from a stop too: the crew leaves it and walks home
        const r = headHomeNow(w, planInput());
        if (r.ok) {
          applyWalkLoad();
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
        const field = document.querySelector<HTMLInputElement>("#w-note");
        if (field) field.value = "";
        walkUi.message = el.id === "w-idea" ? "Marked for the next walk." : "Note pinned to the map.";
        map.setNotes(w.notes);
        renderPanel();
      }
      break;
    case "w-back": backToPlan(); break;
  }
}

function onUiInput(ev: Event): void {
  const t = ev.target as HTMLInputElement;
  if (t.id === "rp-slider" && walkUi.w) {
    // update the map and the clock only, so dragging stays smooth
    const w = walkUi.w;
    const wasPlaying = replay.playing;
    replay.clock = Number(t.value);
    replay.playing = false;
    map.setWalker(trackAtClock(w.track, replay.clock), crewLabel());
    const done = w.track.filter((p) => p.clockMin <= replay.clock);
    let walked = 0;
    for (let i = 1; i < done.length; i++) walked += metresBetween(grid.meta, done[i - 1], done[i]);
    $("#rp-clock").textContent = fmtClock(replay.clock);
    $("#rp-dist").textContent = km(walked);
    if (wasPlaying) renderPanel(); // the button must say "Play" again
  }
  if (t.id === "w-note") walkUi.noteDraft = t.value;
  const s = state.stops.find((x) => x.id === state.selected);
  if (t.id === "stop-note" && s) s.crewNote = t.value;
  if (t.id === "stop-name" && s) renameStop(s, t.value);
}

function onUiChange(ev: Event): void {
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
    if (PICKUP_TASKS[t.dataset.task]) {
      applyWalkLoad(); // a picked-up tube or sample makes the legs ahead slower
      walkUi.message = `${carryingText()}.`;
    }
    renderHud();
    renderPanel();
  } else if (t.id === "show-places") {
    state.showPlaces = t.checked;
    refreshMap();
    renderPanel();
  } else if (t.id === "compare") {
    state.compare = t.checked;
    map.setCompare(state.compare, state.split);
    positionHandle();
  } else if (t.id === "w-follow") {
    walkUi.follow = t.checked;
  } else if (t.classList.contains("load-input")) {
    const i = Number(t.dataset.astro);
    crewLoads();
    state.startLoads[i] = Math.max(0, Math.min(60, Number(t.value) || 0));
    t.value = String(state.startLoads[i]);
    if (state.plan) runPlan();
  } else if (t.id === "crew") {
    state.crewSize = Math.max(1, Math.min(4, Math.round(Number(t.value) || 2)));
    t.value = String(state.crewSize);
    if (state.plan) runPlan();
    else renderPanel();
  } else if (t.id === "start") {
    state.startClock = t.value || "08:45";
    if (state.plan) runPlan();
  } else if (t.id === "rp-slider" && walkUi.w) {
    // the slider was let go: the list shows the page for this time, and the button its right label
    state.pages["rp-events"] = replayPage(walkUi.w);
    renderPanel();
  } else if (t.id === "stop-minutes") {
    const s = state.stops.find((x) => x.id === state.selected);
    if (s) {
      s.minutes = Math.max(5, Math.min(180, Math.round(Number(t.value) || s.minutes)));
      t.value = String(s.minutes); // the field has the focus, so the redraw leaves it alone: show the cleaned value here
      markStale();
      renderPanel();
    }
  } else if (t.id === "stop-name") {
    renderPopup(); // an empty name falls back to "New stop N"
  }
}

function bindPanel(): void {
  const panel = $("#panel");
  const popup = $("#popup");
  for (const el of [panel, popup]) {
    el.addEventListener("click", onUiClick);
    el.addEventListener("input", onUiInput);
    el.addEventListener("change", onUiChange);
    el.addEventListener("keydown", (ev) => {
      const field = ev.target as HTMLElement;
      if (ev.key === "Enter" && field.id === "stop-name") {
        (field as HTMLInputElement).blur(); // the name is already saved while typing; Enter just ends it
        return;
      }
      const ph = (ev.target as HTMLElement).closest("[data-photo]") as HTMLElement | null;
      if (ph && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        ph.click();
      }
    });
  }
  $("#popup").addEventListener("pointerdown", (ev) => { pressOnBackdrop = ev.target === ev.currentTarget; });
  $("#to-globe").addEventListener("click", toGlobe);
  $("#panel-show").addEventListener("click", () => {
    if (walkUi.hudFull) {
      // the helmet view had taken the whole window: go back to the tablet and its map
      setHud(false);
      map.resetDrone();
      if (walkUi.w) map.topView(walkUi.w.pos);
      renderHud();
      renderPanel();
      return;
    }
    slide(() => document.body.classList.remove("panel-closed"));
    syncPanelShow();
  });
  $("#modal").addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id === "save-report" && lastReport) download(`baramger-walk-report-${pkg.site.id}.html`, lastReport.html, "text/html");
    else if (t.id === "save-report-json" && lastReport) download(`baramger-walk-report-${pkg.site.id}.json`, JSON.stringify(lastReport.report, null, 1), "application/json");
    else if (t.id === "modal-close" || t.id === "modal") $("#modal").hidden = true;
  });
  $("#lightbox").addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id === "lb-prev") stepPhoto(-1);
    else if (t.id === "lb-next") stepPhoto(1);
    else if (t.id === "lb-close" || t.id === "lightbox") {
      state.photo = null;
      renderLightbox();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (state.photo && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
      stepPhoto(ev.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (ev.key !== "Escape") return;
    if (intro) intro.skip();
    else if (!$("#modal").hidden) $("#modal").hidden = true;
    else if (state.photo) {
      state.photo = null;
      renderLightbox();
    } else if (state.popup) {
      if (state.popup.kind === "stop") select(null);
      else closePopup();
    } else if (state.addMode) {
      state.addMode = false;
      $("#add-hint").hidden = true;
      renderPanel();
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
  h.hidden = !state.compare || state.view !== "site"; // the whole-planet view has nothing to compare
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
  if (!idx.ok) throw new Error("No mission packages yet. Run the pipeline first: cd pipeline && uv run baramger-build --zone z2");
  const index = (await idx.json()) as { zones: ZoneInfo[]; default: string; crater?: unknown };
  zones = index.zones;
  crater = index.crater ?? null;
  const want = location.hash.replace("#", "");
  zone = zones.find((z) => z.key === want) ?? zones.find((z) => z.key === index.default) ?? zones[0];
  PKG = `/package/${zone.path}`;
  text.textContent = `Loading the ${zone.name} mission package…`;
  const res = await fetch(`${PKG}mission-package.json`);
  if (!res.ok) throw new Error("The mission package is missing. Run the pipeline first: cd pipeline && uv run baramger-build");
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
  personHeightM = assumption(pkg, "A22", PERSON_HEIGHT_M); // the person drawn in the scale card
  loadModel = {
    bodyKg: assumption(pkg, "A15", DEFAULT_LOAD.bodyKg),
    suitKg: assumption(pkg, "A16", DEFAULT_LOAD.suitKg),
    kitKg: assumption(pkg, "A17", DEFAULT_LOAD.kitKg),
    careKg: assumption(pkg, "A20", DEFAULT_LOAD.careKg),
    maxKg: assumption(pkg, "A21", DEFAULT_LOAD.maxKg),
  };
  tubeKg = assumption(pkg, "A18", tubeKg);
  rockKg = assumption(pkg, "A19", rockKg);
  state.startLoads = [];

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

  state.stops = pkg.stops.map(stopFromPackage);

  text.textContent = "Starting the 3D map…";
  map = new MapView($("#map"), walk, ctx);
  const tileLayers = pkg.layers.filter((l) => l.access.urlTemplate && l.id.startsWith("tiles-") && l.id !== "tiles-themis-night");
  for (const l of tileLayers) {
    const layer = map.addTiles(`${PKG}${l.access.urlTemplate}`, l.access.minLevel ?? 0, l.access.maxLevel ?? 0, l.coverage, l.attribution, 1, baseStyleOf(l.id) ?? "photo");
    if (l.id.startsWith("tiles-mola")) {
      // MOLA's height colours are only far-away context here: tone them down so they don't compete with the photos.
      layer.saturation = 0.3;
      layer.brightness = 0.85;
    }
    if (l.id === "tiles-ctx-wide") {
      // The preliminary wide mosaic is darker and harder than the controlled mosaic that lies on
      // it, which would show as a bright square in the crater. These values give both the same
      // mean and spread of grey (measured on the level 9-10 tiles where they overlap).
      layer.brightness = 1.34;
      layer.contrast = 0.62;
    }
  }
  // official place names printed on the USGS map (R2): lettering for the whole-crater view
  map.setNames((pkg.placeNames ?? []).map((n) => ({ name: n.name, lon: n.position.lon, lat: n.position.lat, major: n.rank === "major" })));
  // the whole-planet map has two looks; start with the one the crew chose last time
  state.baseStyle = startBaseStyle(prefs.get("baramger.base"), map.baseStyles());
  map.setBaseStyle(state.baseStyle);
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

// ------------------------------------------------------------------ whole planet <-> walk zone
let zonePins: ZonePin[] = [];
let intro: { skip(): void; step(dt: number): void; phase(): string } | null = null;

/** The middle of the walk zones: where the planet views look, and where the crater's marker sits. */
function zonesMiddle(): LonLat {
  if (!zonePins.length) return pkg.site.center;
  return { lon: zonePins.reduce((a, z) => a + z.lon, 0) / zonePins.length, lat: zonePins.reduce((a, z) => a + z.lat, 0) / zonePins.length };
}

/**
 * Fly to the whole-crater view: the whole crater when the map allows it, with every zone and its name in view.
 * The view is framed for the map's size, so the map frames it again (without a flight) when its size changes.
 */
function flyToCrater(duration = 3): void {
  const { w, h, fov } = map.viewSize();
  const view = craterView(crater, zonePins, w, h, fov, {
    photoBox: pkg.layers.find((l) => l.id === "tiles-ctx-wide")?.coverage, // stay inside the wide photo map when the crater still fits
    groundM: zonePins.length ? zonePins.reduce((a, z) => a + z.elevM, 0) / zonePins.length : 0,
  });
  if (view) map.flyToCrater({ lon: view.lon, lat: view.lat }, view.heightM, duration, () => flyToCrater(0));
  else map.flyToCrater(zonesMiddle(), undefined, duration); // an older zone list without the crater
}

/** Every zone is highlighted on the planet. The other zones' places come from their own mission packages. */
async function loadZonePins(): Promise<void> {
  const out: ZonePin[] = [];
  for (const z of zones) {
    try {
      const site = z.key === zone.key ? pkg.site : ((await (await fetch(`/package/${z.path}mission-package.json`)).json()) as MissionPackage).site;
      out.push({ key: z.key, label: `${z.code} · ${z.name}`, lon: site.center.lon, lat: site.center.lat, elevM: site.base.position.elev_m ?? -2500, aoi: site.aoi });
    } catch {
      // a zone whose package cannot be read is simply not marked
    }
  }
  zonePins = out;
  const c = zonesMiddle();
  map.setZones(out, out.length
    ? { ...c, label: `${pkg.site.region} · ${out.length} walk zone${out.length === 1 ? "" : "s"}`, elevM: out.reduce((a, z) => a + z.elevM, 0) / out.length }
    : null);
}

function enterZone(key: string): void {
  if (key !== zone.key) {
    // another zone has its own mission package: load it and go straight into that zone
    session.set("baramger.enter", "site");
    location.hash = key;
    location.reload();
    return;
  }
  state.view = "site";
  map.setCompare(state.compare, state.split);
  positionHandle();
  renderPanel();
  map.flyToSite(pkg.site.center, 3);
}

function toGlobe(): void {
  walkUi.playing = false;
  replay.playing = false;
  preview.playing = false;
  setHud(false);
  state.view = "globe";
  leavePlanEditing();
  map.setCompare(false, state.split);
  positionHandle();
  renderHud();
  renderPanel();
  map.flyToPlanet(zonesMiddle());
}

const INTRO_FAR_M = 220_000_000; // from here Mars is a small disc in the eyepiece

/** The launch animation has arrived at Mars: bring the panel and the map labels in. */
function showApp(): void {
  if (!document.body.classList.contains("intro-on")) return;
  slide(() => document.body.classList.remove("intro-on"));
}

/** Launch animation: a telescope on Earth finds Mars, then the view flies to the planet. */
function runIntro(ready: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    document.body.classList.add("intro-on");
    const lt = earthMarsLightTime(new Date());
    intro = playIntro($("#intro"), {
      ready,
      facts: { distanceMkm: lt.distanceMkm, lightMin: lt.oneWayMin },
      // 0 = Mars is a small disc far away, 1 = the whole planet fits the map ("in front of Mars")
      setZoom: (k) => map.showPlanet(zonesMiddle(), INTRO_FAR_M * Math.pow(map.planetAltitude() / INTRO_FAR_M, k)),
      setMapFilter: (css) => { $("#map").style.filter = css; },
      arrive: showApp,
      done: () => {
        session.set("baramger.intro", "seen");
        $("#map").style.filter = "";
        intro = null;
        map.showPlanet(zonesMiddle());
        showApp(); // after "Skip intro" the panel slides in now; the planet stays fitted (see slide)
        resolve();
      },
    });
  });
}

/** The panel and pop-ups never scroll: on a short window they are scaled down to fit. */
function fitUi(): void {
  const panelW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--panel-w")) || PANEL_W;
  const ui = uiLayout(window.innerWidth, window.innerHeight, panelW); // the rules are in layout.ts
  document.documentElement.style.setProperty("--ui-scale", ui.scale.toFixed(3));
  document.body.classList.toggle("narrow", ui.narrow); // the panel lies over the map
  document.body.classList.toggle("popup-full", ui.popupFull); // pop-ups (and the helmet view) use the whole window
  $("#size-hint").hidden = !ui.tooSmall; // never hide content silently: say that the window is too short
}

/** Change the layout (panel in or out) with a short slide instead of a jump. */
let slideTimer = 0;

function slide(change: () => void): void {
  document.body.classList.add("sliding");
  void document.body.offsetWidth; // the start state must be in place before the change
  change();
  refitFor(700);
  window.clearTimeout(slideTimer); // a second slide soon after the first must not be cut short by the first one's timer
  slideTimer = window.setTimeout(() => {
    document.body.classList.remove("sliding");
    positionHandle();
    map?.redraw();
  }, 700);
}

/** Keep the whole-planet view fitted to the map while the map area changes size (the panel slides). */
function refitFor(ms: number): void {
  const end = performance.now() + ms;
  const tick = () => {
    map?.refit();
    if (performance.now() < end) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.setTimeout(() => map?.refit(), ms + 60); // also when the browser has paused animation frames
}

// ------------------------------------------------------------------ scale card
let scaleShown = "";
let scaleCardShown: ScaleCard | null = null; // the card on screen: its bar and drawing stay while they fit
let scaleAt = 0;
let scaleTimer = 0;
let personHeightM = PERSON_HEIGHT_M; // A22 of the mission package

/** The scale card on the map: a bar and a drawing at the map's scale in the middle of the view. */
function updateScale(): void {
  scaleAt = performance.now();
  const el = $("#scale");
  const area = $("#map-area").getBoundingClientRect(); // the part of the map the panel does not cover
  const canvas = map.viewer.scene.canvas.getBoundingClientRect();
  const mpp = area.width > 0 && area.height > 0
    ? map.metersPerPixel(area.left - canvas.left + area.width / 2, area.top - canvas.top + area.height / 2)
    : null;
  const card = mpp ? scaleCard(mpp, { prev: scaleCardShown, personM: personHeightM }) : null;
  scaleCardShown = card;
  const html = card ? scaleHtml(card) : "";
  if (html === scaleShown) return; // nothing changed: touch nothing
  scaleShown = html;
  el.hidden = !card;
  if (!card) return;
  el.setAttribute("aria-label", `Map scale. ${card.about}`); // the card takes no pointer, so it has no tooltip
  morph(el, html);
}

/** Runs a few times a second at most, and once more after the last frame (the map draws only when it changes). */
function scheduleScale(): void {
  const wait = 150 - (performance.now() - scaleAt);
  if (wait <= 0) updateScale();
  else if (!scaleTimer) {
    scaleTimer = window.setTimeout(() => {
      scaleTimer = 0;
      updateScale();
    }, wait);
  }
}

/** Is this element on screen (not hidden, not faded out)? */
function shown(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.hidden) return false;
  const s = getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}

/** For tests: anything whose content does not fit its box (it would need scrolling). */
function overflowReport(): string[] {
  const out: string[] = [];
  const check = (el: Element | null, name: string) => {
    if (el && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) out.push(`${name}: content ${el.scrollWidth}x${el.scrollHeight} in a ${el.clientWidth}x${el.clientHeight} box`);
  };
  check(document.documentElement, "page");
  check($("#panel"), "panel");
  check(document.querySelector("#p-body"), "panel body");
  check(document.querySelector(".pop-card"), "pop-up");
  check(document.querySelector(".pop-body"), "pop-up body");
  check(document.querySelector(".lb-inner"), "photo viewer");
  // the scale card on the map: its rows must fit, it stays inside the map, and it covers no other chip
  const scale = $("#scale");
  if (shown(scale) && shown($("#map-area"))) {
    check(scale.querySelector(".sc-fig"), "scale card drawings");
    check(scale.querySelector(".sc-cap"), "scale card caption");
    // the bar's length and the drawings must stay inside the card's content box (a grid row grows with its content, so compare with the card)
    const box = scale.getBoundingClientRect();
    const style = getComputedStyle(scale);
    const right = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    const label = scale.querySelector(".sc-bar b");
    if (label && label.getBoundingClientRect().right > right + 0.5) out.push("scale card: the bar row is wider than the card");
    const fig = scale.querySelector(".sc-fig");
    for (const drawing of fig ? [...fig.children] : []) {
      const d = drawing.getBoundingClientRect();
      if (d.right > right + 0.5 || d.top < fig!.getBoundingClientRect().top - 0.5) out.push("scale card: a drawing sticks out of its row");
    }
    const r = scale.getBoundingClientRect();
    const area = $("#map-area").getBoundingClientRect();
    if (r.left < area.left - 0.5 || r.right > area.right + 0.5 || r.top < area.top - 0.5 || r.bottom > area.bottom + 0.5) out.push("scale card: not inside the map");
    for (const id of ["map-title", "readout", "globe-hint", "add-hint", "size-hint", "panel-show"]) {
      const other = document.getElementById(id);
      if (!shown(other)) continue;
      const q = other.getBoundingClientRect();
      if (q.width > 0 && q.height > 0 && r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom) out.push(`scale card: lies over #${id}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  fitUi();
  window.addEventListener("resize", () => {
    fitUi();
    positionHandle();
    if (walkUi.hud && !walkUi.hudFull) setHud(true);
    if (state.popup) renderPopup(); // page sizes of the pop-up lists depend on the window's width
  });
  // Coming from the zone menu or a zone marker: skip the planet view and go straight into the zone.
  const enterSite = session.get("baramger.enter") === "site";
  session.remove("baramger.enter");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wantIntro = !enterSite && !reducedMotion && !session.get("baramger.intro") && !new URLSearchParams(location.search).has("nointro");

  let mapReady!: () => void;
  const ready = new Promise<void>((r) => (mapReady = r));
  if (wantIntro) {
    $("#loading").hidden = true; // the animation's first scene plays while the package loads
    void runIntro(ready);
  }
  try {
    await loadPackage();
  } catch (e) {
    $("#intro").hidden = true;
    document.body.classList.remove("intro-on");
    $("#loading").hidden = false;
    $("#loading-text").textContent = `Could not start: ${(e as Error).message}`;
    $("#loading").classList.add("failed");
    throw e;
  }
  const sel = $<HTMLSelectElement>("#zone-select");
  sel.innerHTML = zones.map((z) => `<option value="${esc(z.key)}" ${z.key === zone.key ? "selected" : ""}>Zone ${esc(z.code)} · ${esc(z.name)}</option>`).join("");
  sel.addEventListener("change", () => enterZone(sel.value));
  // Typing #z1 / #z2 in the address bar only changes the hash; reload so the other package loads.
  window.addEventListener("hashchange", () => {
    const key = location.hash.replace("#", "");
    if (key !== zone.key && zones.some((z) => z.key === key)) {
      session.set("baramger.enter", "site"); // typing #z1 means "open zone Z1", not "show the planet"
      location.reload();
    }
  });
  document.title = `Baramger · ${zone.name}`;
  state.view = enterSite ? "site" : "globe";
  bindPanel();
  bindCompareHandle();
  await loadZonePins();
  renderPanel();
  map.onClick((pos) => {
    const planning = state.view === "site" && state.mode === "plan";
    if (planning && state.addMode) {
      const p = map.pickLonLat(pos);
      if (p) addStopAt(p);
      return;
    }
    if (planning) {
      // stops and places first: zoomed out, the zone's own ring sits on top of them
      const id = map.pickPinId(pos);
      if (id && id !== "base") {
        select(id);
        return;
      }
      const place = map.pickPlaceId(pos);
      if (place) {
        state.popup = { kind: "place", id: place };
        renderPopup();
        return;
      }
    }
    if (state.view === "site" && !planning) return; // during a walk or replay the map only shows; zone markers do nothing
    const zoneKey = map.pickZoneKey(pos);
    if (zoneKey === "crater") flyToCrater();
    else if (zoneKey) enterZone(zoneKey);
  });
  map.onMove((pos) => readout(map.pickLonLat(pos)));
  map.onRender(scheduleScale); // the scale card follows the camera
  map.showPlanet(zonesMiddle());
  if (import.meta.env.DEV) {
    (window as unknown as { __baramger: unknown }).__baramger = {
      map, state, preview, walkUi, replay, step, renderPanel, makeReport, enterZone, toGlobe, overflowReport, updateScale,
      get intro() { return intro; },
    };
  }
  // Show nothing before Mars is really drawn: the launch animation looks at it through the
  // telescope, and without it the loading screen would open on an empty, black map.
  await map.whenDrawn();
  mapReady();
  $("#loading").classList.add("done");
  setTimeout(() => ($("#loading").hidden = true), 700);
  if (enterSite) setTimeout(() => map.flyToSite(pkg.site.center), 500);
}

main();
