// Small SVG charts for the panel: temperature through the Mars day, and the route's height profile.
// Colours: air = blue #3987e5, ground = orange #d95926 (validated on the dark panel surface);
// profile segments use the same easy / take-care colours as the route on the map.

export interface TempPoint {
  hour: number;
  air: number | null;
  ground: number | null;
}

export interface ProfilePoint {
  d: number; // metres from the start of the walk
  h: number; // metres above the areoid
  slope: number;
}

const W = 360;
const COL = { air: "#3987e5", ground: "#d95926", easy: "#3DDC97", care: "#FFC145" };

const fmtDeg = (c: number) => `${c < 0 ? "−" : ""}${Math.abs(Math.round(c))}°`;

export function tempChart(points: TempPoint[], o: { sunriseH: number; sunsetH: number; walkStartH: number; walkEndH: number }): string {
  const H = 150;
  const m = { l: 34, r: 10, t: 14, b: 22 };
  const x = (h: number) => m.l + (h / 24) * (W - m.l - m.r);
  const lo = -90;
  const hi = 10;
  const y = (c: number) => m.t + ((hi - c) / (hi - lo)) * (H - m.t - m.b);
  const line = (key: "air" | "ground") =>
    points.filter((p) => p[key] !== null).map((p, i) => `${i ? "L" : "M"}${x(p.hour + 0.5).toFixed(1)},${y(p[key]!).toFixed(1)}`).join("");
  const ticksY = [-80, -40, 0];
  const ticksX = [0, 6, 12, 18, 24];
  const data = JSON.stringify(points.map((p) => [p.hour, p.air, p.ground]));
  return `
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Air and ground temperature through the day" data-kind="temp" data-points='${data}'
       data-m='${JSON.stringify(m)}'>
    <rect x="${x(o.sunriseH)}" y="${m.t}" width="${x(o.sunsetH) - x(o.sunriseH)}" height="${H - m.t - m.b}" class="c-day"/>
    <rect x="${x(o.walkStartH)}" y="${m.t}" width="${Math.max(2, x(Math.min(24, o.walkEndH)) - x(o.walkStartH))}" height="${H - m.t - m.b}" class="c-walk"/>
    <text x="${x(o.walkStartH) + 4}" y="${m.t + 11}" class="c-note">walk</text>
    <text x="${x(o.sunriseH) + 3}" y="${H - m.b - 4}" class="c-note">sunrise</text>
    <text x="${x(o.sunsetH) - 3}" y="${H - m.b - 4}" class="c-note" text-anchor="end">sunset</text>
    ${ticksY.map((c) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(c)}" y2="${y(c)}" class="c-grid"/><text x="${m.l - 6}" y="${y(c) + 4}" class="c-tick" text-anchor="end">${fmtDeg(c)}</text>`).join("")}
    ${ticksX.map((h) => `<text x="${x(h)}" y="${H - 6}" class="c-tick" text-anchor="middle">${String(h).padStart(2, "0")}${h === 24 ? " h" : ""}</text>`).join("")}
    <path d="${line("ground")}" fill="none" stroke="${COL.ground}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${line("air")}" fill="none" stroke="${COL.air}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <line class="c-xh" data-keep x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <rect class="c-hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>
  </svg>`;
}

export function profileChart(points: ProfilePoint[], stops: { d: number; label: string }[], comfortSlope: number, current?: number): string {
  const H = 140;
  const m = { l: 50, r: 10, t: 18, b: 22 };
  if (points.length < 2) return "";
  const total = points[points.length - 1].d;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p.h);
    hi = Math.max(hi, p.h);
  }
  const step = hi - lo > 120 ? 50 : 20;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  const x = (d: number) => m.l + (d / total) * (W - m.l - m.r);
  const y = (h: number) => m.t + ((hi - h) / (hi - lo)) * (H - m.t - m.b);
  // runs of the same slope class
  const runs: { care: boolean; pts: ProfilePoint[] }[] = [];
  for (const p of points) {
    const care = p.slope > comfortSlope;
    const last = runs[runs.length - 1];
    if (last && last.care === care) last.pts.push(p);
    else runs.push({ care, pts: last ? [last.pts[last.pts.length - 1], p] : [p] });
  }
  const kmStep = total > 2500 ? 1000 : 500;
  const ticksX: number[] = [];
  for (let d = 0; d <= total + 1; d += kmStep) ticksX.push(d);
  const ticksY = [lo, hi];
  const thin = points.filter((_, i) => i % 3 === 0 || i === points.length - 1);
  const data = JSON.stringify(thin.map((p) => [Math.round(p.d), Math.round(p.h * 10) / 10, p.slope]));
  return `
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Height along the route" data-kind="profile" data-points='${data}'
       data-m='${JSON.stringify(m)}' data-total="${total}">
    ${ticksY.map((h) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(h)}" y2="${y(h)}" class="c-grid"/><text x="${m.l - 6}" y="${y(h) + 4}" class="c-tick" text-anchor="end">${Math.round(h).toLocaleString("en-US").replace("-", "−")} m</text>`).join("")}
    ${ticksX.map((d) => `<text x="${x(d)}" y="${H - 6}" class="c-tick" text-anchor="middle">${d === 0 ? "0" : (d / 1000).toFixed(d % 1000 ? 1 : 0)}${d === ticksX[ticksX.length - 1] ? " km" : ""}</text>`).join("")}
    ${stops.map((s) => `<line x1="${x(s.d)}" x2="${x(s.d)}" y1="${m.t}" y2="${H - m.b}" class="c-stop"/><text x="${x(s.d)}" y="${m.t - 5}" class="c-tick strong" text-anchor="middle">${s.label}</text>`).join("")}
    ${runs.map((r) => `<path d="${r.pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)},${y(p.h).toFixed(1)}`).join("")}" fill="none" stroke="${r.care ? COL.care : COL.easy}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("")}
    ${current !== undefined ? `<line x1="${x(current)}" x2="${x(current)}" y1="${m.t}" y2="${H - m.b}" class="c-now"/>` : ""}
    <line class="c-xh" data-keep x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <rect class="c-hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>
  </svg>`;
}

/** One hover handler for every chart in a container: crosshair + tooltip with the nearest values. */
export function bindChartHover(container: HTMLElement, tip: HTMLElement): void {
  // The hover line is kept by redraws (data-keep), so it must be hidden here, together with the tooltip.
  const hide = () => {
    tip.hidden = true;
    container.querySelectorAll(".c-xh").forEach((l) => l.setAttribute("visibility", "hidden"));
  };
  container.addEventListener("pointermove", (ev) => {
    const svg = (ev.target as Element).closest?.("svg.chart") as SVGSVGElement | null;
    if (!svg) {
      hide();
      return;
    }
    const m = JSON.parse(svg.dataset.m!);
    const pts = JSON.parse(svg.dataset.points!) as number[][];
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    if (sx < m.l || sx > W - m.r) {
      hide();
      return;
    }
    const f = (sx - m.l) / (W - m.l - m.r);
    let text = "";
    let px = sx;
    if (svg.dataset.kind === "temp") {
      const hour = Math.min(23, Math.max(0, Math.floor(f * 24)));
      const p = pts.find((q) => q[0] === hour);
      if (!p) return;
      px = m.l + ((hour + 0.5) / 24) * (W - m.l - m.r);
      text = `${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00 · air ${p[1] === null ? "–" : fmtDeg(p[1]) + "C"} · ground ${p[2] === null ? "–" : fmtDeg(p[2]) + "C"}`;
    } else {
      const total = Number(svg.dataset.total);
      const d = f * total;
      let best = pts[0];
      for (const q of pts) if (Math.abs(q[0] - d) < Math.abs(best[0] - d)) best = q;
      px = m.l + (best[0] / total) * (W - m.l - m.r);
      text = `${(best[0] / 1000).toFixed(2)} km · ${Math.round(best[1]).toLocaleString("en-US").replace("-", "−")} m · slope ${best[2]}°`;
    }
    const xh = svg.querySelector(".c-xh") as SVGLineElement;
    xh.setAttribute("x1", String(px));
    xh.setAttribute("x2", String(px));
    xh.setAttribute("visibility", "visible");
    tip.textContent = text;
    tip.hidden = false;
    tip.style.left = `${Math.min(window.innerWidth - 250, Math.max(4, ev.clientX - 120))}px`;
    tip.style.top = `${Math.max(4, r.top - 30)}px`;
  });
  container.addEventListener("pointerleave", hide);
}
