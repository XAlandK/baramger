// Walk report: structured data (JSON) plus a stand-alone printable HTML page.

import type { LonLat } from "./grid";
import type { Check, PlanResult } from "./plan";
import type { LightTime } from "./lighttime";
import type { WalkState } from "./walk";
import { factorText, kgText } from "./load";

export interface ReportStop {
  id: string;
  name: string;
  minutes: number;
  tasks: string[];
  unit?: string;
  plannedArrivalMin: number;
}

export interface ReportInput {
  title: string;
  site: string;
  region: string;
  generatedUtc: string;
  plan: PlanResult;
  startMin: number;
  stops: ReportStop[];
  walk: WalkState;
  tasksDone: Record<string, string[]>;
  base: LonLat;
  conditions: { sunrise: string; sunset: string; airWalkC: [number, number] | null; airDates?: string; sun: string } | null;
  sources: { id: string; name: string; credit: string }[];
  assumptions: string[];
  lightTime: LightTime;
  crewSize?: number;
  load?: ReportLoad;
}

/** Gear load: planned heaviest load per leg, and what the crew carried. */
export interface ReportLoad {
  legs: { from: string; to: string; plannedKg: number; factor: number }[];
  startKg: number[];
  endKg: number[];
  kitKg: number;
}

export interface WalkReport {
  kind: "baramger-walk-report";
  version: 1;
  title: string;
  site: string;
  region: string;
  generatedUtc: string;
  summary: {
    startLmst: string;
    endLmst: string;
    plannedEndLmst: string;
    walkedM: number;
    plannedM: number;
    minutesOut: number;
    plannedMinutes: number;
    stopsVisited: number;
    stopsSkipped: number;
    crewSize: number;
  };
  stops: {
    id: string;
    name: string;
    status: "visited" | "skipped" | "not reached";
    plannedArrival: string;
    actualArrival: string | null;
    delayMin: number | null;
    plannedMin: number;
    actualMin: number | null;
    tasksDone: string[];
    tasksTotal: number;
    rockUnit?: string;
  }[];
  notes: { time: string; kind: "note" | "idea"; text: string; lon: number; lat: number }[];
  events: { time: string; text: string }[];
  safetyAtApproval: Check[];
  conditions: ReportInput["conditions"];
  transmission: { distanceAu: number; distanceMkm: number; oneWayMin: number };
  sources: ReportInput["sources"];
  assumptions: string[];
  load: ReportLoad | null;
}

export function clock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function buildReport(r: ReportInput): WalkReport {
  const w = r.walk;
  const visited = new Map(w.log.map((l) => [l.id, l]));
  const skipped = new Set(w.skipped);
  return {
    kind: "baramger-walk-report",
    version: 1,
    title: r.title,
    site: r.site,
    region: r.region,
    generatedUtc: r.generatedUtc,
    summary: {
      startLmst: clock(w.startMin),
      endLmst: clock(w.clockMin),
      plannedEndLmst: clock(r.plan.totals.finishClockMin),
      walkedM: Math.round(w.walkedM),
      plannedM: Math.round(r.plan.totals.distanceM),
      minutesOut: Math.round(w.clockMin - w.startMin),
      plannedMinutes: Math.round(r.plan.totals.totalMin),
      stopsVisited: w.log.length,
      stopsSkipped: w.skipped.length,
      crewSize: r.crewSize ?? 2,
    },
    stops: r.stops.map((s) => {
      const v = visited.get(s.id);
      return {
        id: s.id,
        name: s.name,
        status: v ? "visited" : skipped.has(s.id) ? "skipped" : "not reached",
        plannedArrival: clock(s.plannedArrivalMin),
        actualArrival: v ? clock(v.arrivedMin) : null,
        delayMin: v ? Math.round(v.arrivedMin - s.plannedArrivalMin) : null,
        plannedMin: s.minutes,
        actualMin: v && v.leftMin !== undefined ? Math.round(v.leftMin - v.arrivedMin) : null,
        tasksDone: r.tasksDone[s.id] ?? [],
        tasksTotal: s.tasks.length,
        rockUnit: s.unit,
      };
    }),
    notes: w.notes.map((n) => ({ time: clock(n.clockMin), kind: n.kind, text: n.text, lon: +n.lon.toFixed(6), lat: +n.lat.toFixed(6) })),
    events: w.events.map((e) => ({ time: clock(e.clockMin), text: e.text })),
    safetyAtApproval: r.plan.checks,
    conditions: r.conditions,
    transmission: {
      distanceAu: +r.lightTime.distanceAu.toFixed(3),
      distanceMkm: Math.round(r.lightTime.distanceMkm),
      oneWayMin: +r.lightTime.oneWayMin.toFixed(1),
    },
    sources: r.sources,
    assumptions: r.assumptions,
    load: r.load ?? null,
  };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const degC = (c: number) => `${c < 0 ? "−" : ""}${Math.abs(Math.round(c))} °C`;

/** Simple vector map: planned route (grey dashes), walked track (teal), stops, notes, scale bar. */
export function reportMapSvg(
  planned: LonLat[][],
  walked: LonLat[],
  stops: (LonLat & { label: string; status: string })[],
  base: LonLat,
  notes: (LonLat & { kind: string })[],
): string {
  const W = 640;
  const H = 420;
  const pad = 30;
  const all = [...planned.flat(), ...walked, ...stops, base];
  const lat0 = all.reduce((a, p) => a + p.lat, 0) / all.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = all.map((p) => p.lon * kx);
  const ys = all.map((p) => p.lat);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min((W - 2 * pad) / Math.max(1e-9, x1 - x0), (H - 2 * pad) / Math.max(1e-9, y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2;
  const oy = (H - (y1 - y0) * s) / 2;
  const X = (p: LonLat) => ox + (p.lon * kx - x0) * s;
  const Y = (p: LonLat) => H - (oy + (p.lat - y0) * s);
  const path = (pts: LonLat[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join("");
  // scale bar: metres per pixel = (1 deg lat = 59,274 m on the Mars 2000 sphere) / s
  const mPerPx = 59274 / s;
  const nice = [50, 100, 200, 250, 500, 1000].find((v) => v / mPerPx >= 70) ?? 1000;
  const barPx = nice / mPerPx;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Map of the planned route and the walked track">
  <rect width="${W}" height="${H}" fill="#f4f1ec"/>
  ${planned.map((pts) => `<path d="${path(pts)}" fill="none" stroke="#8c979e" stroke-width="2" stroke-dasharray="6 5"/>`).join("")}
  ${walked.length > 1 ? `<path d="${path(walked)}" fill="none" stroke="#0c6a70" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
  ${notes.map((n) => `<rect x="${(X(n) - 5).toFixed(1)}" y="${(Y(n) - 5).toFixed(1)}" width="10" height="10" transform="rotate(45 ${X(n).toFixed(1)} ${Y(n).toFixed(1)})" fill="${n.kind === "idea" ? "#7a5cc4" : "#c98500"}"/>`).join("")}
  <rect x="${(X(base) - 9).toFixed(1)}" y="${(Y(base) - 9).toFixed(1)}" width="18" height="18" rx="3" fill="#13202a"/>
  <text x="${X(base).toFixed(1)}" y="${(Y(base) + 4).toFixed(1)}" font-family="sans-serif" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">H</text>
  ${stops.map((p) => `<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="10" fill="${p.status === "visited" ? "#0c6a70" : "#ffffff"}" stroke="${p.status === "visited" ? "#ffffff" : "#8c979e"}" stroke-width="2"/>
  <text x="${X(p).toFixed(1)}" y="${(Y(p) + 4).toFixed(1)}" font-family="sans-serif" font-size="11" font-weight="700" fill="${p.status === "visited" ? "#fff" : "#566672"}" text-anchor="middle">${esc(p.label)}</text>`).join("")}
  <g font-family="sans-serif" font-size="11" fill="#13202a">
    <line x1="${pad}" x2="${(pad + barPx).toFixed(1)}" y1="${H - 16}" y2="${H - 16}" stroke="#13202a" stroke-width="2"/>
    <text x="${pad}" y="${H - 22}">${nice} m</text>
    <text x="${W - pad}" y="${pad}" text-anchor="end" font-weight="700">N ↑</text>
  </g>
</svg>`;
}

export function reportHtml(r: WalkReport, mapSvg: string): string {
  const s = r.summary;
  const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`);
  const statusText = { visited: "Visited", skipped: "Skipped", "not reached": "Not reached" } as const;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)} · walk report</title>
<style>
  body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #13202a; background: #fff; margin: 0; }
  main { max-width: 820px; margin: 0 auto; padding: 32px 20px 48px; }
  h1 { font-size: 30px; margin: 4px 0 6px; } h2 { font-size: 19px; margin: 28px 0 8px; }
  .eyebrow { text-transform: uppercase; letter-spacing: .1em; font-size: 12px; color: #b0462a; font-weight: 600; margin: 0; }
  .muted { color: #566672; } .small { font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: #d6dfe4; border: 1px solid #d6dfe4; border-radius: 10px; overflow: hidden; }
  .grid div { background: #fff; padding: 10px 12px; } .grid span { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #566672; } .grid b { font-size: 18px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; } th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #e3e8eb; vertical-align: top; } th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #566672; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tag { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: #e0f2e6; color: #1d7539; } .tag.skipped { background: #fbefd7; color: #8f5600; } .tag.not { background: #eef1f3; color: #566672; }
  .map { border: 1px solid #d6dfe4; border-radius: 10px; overflow: hidden; } .map svg { display: block; width: 100%; height: auto; }
  .legend { font-size: 12px; color: #566672; display: flex; gap: 14px; flex-wrap: wrap; margin-top: 6px; }
  ul { padding-left: 20px; } li { margin: 3px 0; }
  .box { background: #f4f6f7; border-radius: 10px; padding: 12px 14px; }
  footer { margin-top: 32px; border-top: 1px solid #d6dfe4; padding-top: 12px; font-size: 12px; color: #566672; }
  @media (max-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } }
</style></head>
<body><main>
  <p class="eyebrow">Baramger · walk report</p>
  <h1>${esc(r.title)}</h1>
  <p class="muted">${esc(r.site)}, ${esc(r.region)}, Mars · crew of ${s.crewSize} · walk ${esc(s.startLmst)}–${esc(s.endLmst)} local Mars time · report made ${esc(r.generatedUtc)} UTC</p>

  <div class="grid">
    <div><span>Walked</span><b>${km(s.walkedM)}</b></div>
    <div><span>Planned</span><b>${km(s.plannedM)}</b></div>
    <div><span>Time out</span><b>${s.minutesOut} min</b></div>
    <div><span>Planned time</span><b>${s.plannedMinutes} min</b></div>
    <div><span>Back at</span><b>${esc(s.endLmst)}</b></div>
    <div><span>Planned return</span><b>${esc(s.plannedEndLmst)}</b></div>
    <div><span>Stops visited</span><b>${s.stopsVisited}</b></div>
    <div><span>Stops skipped</span><b>${s.stopsSkipped}</b></div>
  </div>

  <h2>Map</h2>
  <div class="map">${mapSvg}</div>
  <p class="legend"><span>— — planned route</span><span style="color:#0c6a70">━ walked track</span><span>● visited stop · ○ not visited</span><span style="color:#c98500">◆ note</span><span style="color:#7a5cc4">◆ idea for next walk</span></p>

  <h2>Stops</h2>
  <table><thead><tr><th>Stop</th><th>Status</th><th>Arrival (plan → real)</th><th>Time there (plan → real)</th><th>Tasks</th></tr></thead><tbody>
  ${r.stops.map((t) => `<tr><td><b>${esc(t.name)}</b>${t.rockUnit ? `<br><span class="muted small">${esc(t.rockUnit)}</span>` : ""}</td>
    <td><span class="tag ${t.status === "visited" ? "" : t.status === "skipped" ? "skipped" : "not"}">${statusText[t.status]}</span></td>
    <td class="num">${esc(t.plannedArrival)} → ${t.actualArrival ? `${esc(t.actualArrival)} (${t.delayMin! >= 0 ? "+" : ""}${t.delayMin} min)` : "–"}</td>
    <td class="num">${t.plannedMin} → ${t.actualMin ?? "–"} min</td>
    <td>${t.tasksTotal ? `${t.tasksDone.length} of ${t.tasksTotal}${t.tasksDone.length ? `<br><span class="muted small">${esc(t.tasksDone.join(", "))}</span>` : ""}` : "–"}</td></tr>`).join("")}
  </tbody></table>

  ${r.load ? `<h2>Carried load</h2>
  <p class="small">Walking time grows with the mass each astronaut moves: body, suit and load (assumptions A15–A21). The crew walks at the pace of the astronaut carrying the most, and picked-up samples go to the astronaut carrying less.</p>
  <table><thead><tr><th>Leg</th><th>Heaviest load (plan)</th><th>Walking time</th></tr></thead><tbody>
  ${r.load.legs.map((l) => `<tr><td>${esc(l.from)} → ${esc(l.to)}</td><td class="num">${kgText(l.plannedKg)}</td><td class="num">${factorText(l.factor) || "as with the standard kit"}</td></tr>`).join("")}
  </tbody></table>
  <p class="small">Load at the start: ${r.load.startKg.map((kg, i) => `astronaut ${i + 1} ${kgText(kg)}`).join(", ")}. Brought home: ${r.load.endKg.map((kg, i) => `astronaut ${i + 1} ${kgText(kg)}`).join(", ")}. Standard kit: ${kgText(r.load.kitKg)}.</p>` : ""}

  <h2>Field notes</h2>
  ${r.notes.length ? `<ul>${r.notes.map((n) => `<li><b>${esc(n.time)}</b> · ${n.kind === "idea" ? "For next walk: " : ""}${esc(n.text)} <span class="muted small">(${n.lat.toFixed(5)}° N, ${n.lon.toFixed(5)}° E)</span></li>`).join("")}</ul>` : `<p class="muted">No notes.</p>`}

  <h2>Timeline</h2>
  <ul>${r.events.map((e) => `<li><b>${esc(e.time)}</b> · ${esc(e.text)}</li>`).join("")}</ul>

  <h2>Conditions and safety</h2>
  <div class="box">
    ${r.conditions ? `<p>Daylight ${esc(r.conditions.sunrise)}–${esc(r.conditions.sunset)} local Mars time.${r.conditions.airWalkC ? ` Reference air temperature in walk hours ${degC(r.conditions.airWalkC[0])} to ${degC(r.conditions.airWalkC[1])} (Perseverance MEDA${r.conditions.airDates ? `, ${esc(r.conditions.airDates)}` : ""}).` : ""}</p><p class="small muted">${esc(r.conditions.sun)}</p>` : ""}
    <p class="small"><b>Safety check when the plan was approved:</b></p>
    <ul class="small">${r.safetyAtApproval.map((c) => `<li>${c.status === "ok" ? "✔" : c.status === "care" ? "⚠" : "✖"} ${esc(c.label)}: ${esc(c.detail)}</li>`).join("")}</ul>
  </div>

  <h2>Sending this report</h2>
  <p>Earth is ${r.transmission.distanceAu} AU (${r.transmission.distanceMkm} million km) from Mars on the report date, so the message takes about <b>${r.transmission.oneWayMin} minutes</b> to arrive, and a reply at least twice that.</p>

  <footer>
    <p><b>Data:</b> ${r.sources.map((x) => `${esc(x.name)} (${esc(x.id.split("-")[0])}): ${esc(x.credit)}`).join(" · ")}.</p>
    <p><b>Starting values still to confirm:</b> ${r.assumptions.map(esc).join(" · ")}.</p>
    <p>Made with Baramger, a hackathon prototype. The walk in this report was a time-lapse demo along the approved route, not a real crewed walk.</p>
  </footer>
</main></body></html>`;
}
