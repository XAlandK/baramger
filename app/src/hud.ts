// Helmet display (HUD) mock-up: only what the walker needs right now.

export interface HudState {
  label: string; // e.g. "NEXT · STOP 2" or "AT STOP 2"
  target: string;
  distM: number | null;
  relDeg: number | null; // direction to the target relative to where the crew faces (0 = straight ahead)
  timeLeftMin: number;
  radio: boolean;
  stopTimer: { elapsed: number; planned: number } | null;
  warning: { level: "info" | "care" | "bad"; text: string } | null;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Direction relative to the walker's heading, in -180..180 (positive = to the right). */
export function relativeBearing(targetDeg: number, headingDeg: number): number {
  return ((targetDeg - headingDeg + 540) % 360) - 180;
}

export function hudHtml(s: HudState): string {
  const h = Math.floor(Math.max(0, s.timeLeftMin) / 60);
  const m = Math.floor(Math.max(0, s.timeLeftMin) % 60);
  const dist = s.distM === null ? "" : s.distM >= 1000 ? `${(s.distM / 1000).toFixed(1)} km` : `${Math.round(s.distM / 10) * 10} m`;
  return `
  <div class="visor">
    <div class="hud-tl"><span class="hud-label">${esc(s.label)}</span><b>${esc(s.target.toUpperCase())}</b></div>
    <div class="hud-tr"><span class="hud-label">TIME LEFT</span><b>${h}:${String(m).padStart(2, "0")}</b>
      <span class="hud-radio ${s.radio ? "ok" : "off"}">${s.radio ? "● RADIO" : "○ NO RADIO"}</span></div>
    ${s.stopTimer
      ? `<div class="hud-mid"><b>${Math.floor(s.stopTimer.elapsed)} / ${s.stopTimer.planned} MIN</b><span class="hud-label">AT THIS STOP</span></div>`
      : s.relDeg !== null
        ? `<div class="hud-mid"><svg viewBox="0 0 40 40" class="hud-arrow" aria-hidden="true"><g transform="rotate(${s.relDeg.toFixed(0)} 20 20)"><path d="M20 3 L32 31 L20 24 L8 31 Z"/></g></svg><b>${esc(dist)}</b></div>`
        : ""}
    ${s.warning ? `<div class="hud-warn ${s.warning.level}">${esc(s.warning.text)}</div>` : ""}
  </div>`;
}
