// Safest-route finder: A* on the 2 m routing grid, minimising walking time.
// Speed follows Tobler's hiking function scaled to a suited astronaut's flat speed (A3).
// Ground steeper than maxSlopeDeg (A2) or of unknown height is never entered.

import { type LonLat, type RouteGrid, UNKNOWN, toLonLat, toRC, metresBetween } from "./grid";

export interface CostModel {
  maxSlopeDeg: number; // A2
  comfortSlopeDeg: number; // A1
  flatSpeedMs: number; // A3
  careFactor: number; // extra time on 15-25 deg ground
  roughStartCm: number; // bumps below this cost nothing extra
  roughScaleCm: number; // +100 % time per this many cm above the start
}

export const DEFAULT_COST: CostModel = {
  maxSlopeDeg: 25,
  comfortSlopeDeg: 15,
  flatSpeedMs: 2.5 / 3.6,
  careFactor: 1.5,
  roughStartCm: 10,
  roughScaleCm: 40,
};

const TOBLER_FLAT = Math.exp(-3.5 * 0.05);

/** Speed multiplier for a grade (rise / run). 1.0 on flat ground, 1.19 at the best gentle downhill. */
export function tobler(grade: number): number {
  return Math.exp(-3.5 * Math.abs(grade + 0.05)) / TOBLER_FLAT;
}

export function isPassable(g: RouteGrid, i: number, m: CostModel): boolean {
  const s = g.slope[i];
  return s !== UNKNOWN && s <= m.maxSlopeDeg;
}

/** Time multiplier for walking across a cell (care slope, bumpy ground). */
export function cellPenalty(g: RouteGrid, i: number, m: CostModel): number {
  const care = g.slope[i] > m.comfortSlopeDeg ? m.careFactor : 1;
  const rough = g.rough[i] === UNKNOWN ? 0 : g.rough[i];
  return care * (1 + Math.max(0, rough - m.roughStartCm) / m.roughScaleCm);
}

class MinHeap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;

  push(k: number, v: number): void {
    if (this.size === this.keys.length) {
      const k2 = new Float64Array(this.size * 2);
      k2.set(this.keys);
      this.keys = k2;
      const v2 = new Int32Array(this.size * 2);
      v2.set(this.vals);
      this.vals = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = k;
    this.vals[i] = v;
  }

  pop(): number {
    const top = this.vals[0];
    const k = this.keys[--this.size];
    const v = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = k;
    this.vals[i] = v;
    return top;
  }
}

/** Nearest passable cell to (r, c) within maxR cells, or -1. */
export function snapToPassable(g: RouteGrid, m: CostModel, r: number, c: number, maxR = 60): number {
  const W = g.meta.width;
  const H = g.meta.height;
  r = Math.min(H - 1, Math.max(0, Math.round(r)));
  c = Math.min(W - 1, Math.max(0, Math.round(c)));
  if (isPassable(g, r * W + c, m)) return r * W + c;
  for (let d = 1; d <= maxR; d++) {
    let best = -1;
    let bestD = Infinity;
    for (let dr = -d; dr <= d; dr++) {
      for (let dc = -d; dc <= d; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const i = rr * W + cc;
        const dd = Math.hypot(dr * g.meta.dyM, dc * g.meta.dxM);
        if (dd < bestD && isPassable(g, i, m)) {
          best = i;
          bestD = dd;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** A* over 8 neighbours. Returns the cell indices from start to goal, or null if blocked. */
export function astar(g: RouteGrid, m: CostModel, start: number, goal: number): Int32Array | null {
  const W = g.meta.width;
  const N = W * g.meta.height;
  const dx = g.meta.dxM;
  const dy = g.meta.dyM;
  const cost = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap();
  const vmax = m.flatSpeedMs * tobler(-0.05);
  const gr = Math.floor(goal / W);
  const gc = goal % W;
  const h = (i: number) => Math.hypot(((i % W) - gc) * dx, (Math.floor(i / W) - gr) * dy) / vmax;
  const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
  const DC = [-1, 0, 1, -1, 1, -1, 0, 1];
  const DIST = DR.map((r, k) => Math.hypot(r * dy, DC[k] * dx));
  cost[start] = 0;
  heap.push(h(start), start);
  while (heap.size > 0) {
    const i = heap.pop();
    if (closed[i]) continue;
    if (i === goal) break;
    closed[i] = 1;
    const r = Math.floor(i / W);
    const c = i % W;
    const pi = cellPenalty(g, i, m);
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      const cc = c + DC[k];
      if (rr < 0 || cc < 0 || rr >= g.meta.height || cc >= W) continue;
      const j = rr * W + cc;
      if (closed[j] || !isPassable(g, j, m)) continue;
      // no corner cutting past no-go cells
      if (DR[k] !== 0 && DC[k] !== 0 && (!isPassable(g, r * W + cc, m) || !isPassable(g, rr * W + c, m))) continue;
      const d = DIST[k];
      const grade = (g.h[j] - g.h[i]) / d;
      const t = (d / (m.flatSpeedMs * tobler(grade))) * 0.5 * (pi + cellPenalty(g, j, m));
      const nc = cost[i] + t;
      if (nc < cost[j]) {
        cost[j] = nc;
        from[j] = i;
        heap.push(nc + h(j), j);
      }
    }
  }
  if (start !== goal && from[goal] < 0) return null;
  const path: number[] = [];
  for (let i = goal; i !== -1; i = from[i]) {
    path.push(i);
    if (i === start) break;
  }
  return Int32Array.from(path.reverse());
}

/** True if the straight line a-b crosses only passable cells. */
export function segmentClear(g: RouteGrid, m: CostModel, a: LonLat, b: LonLat): boolean {
  const d = metresBetween(g.meta, a, b);
  const steps = Math.max(1, Math.ceil(d / (0.5 * Math.min(g.meta.dxM, g.meta.dyM))));
  const W = g.meta.width;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const { r, c } = toRC(g.meta, a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t);
    const rr = Math.round(r);
    const cc = Math.round(c);
    if (rr < 0 || cc < 0 || rr >= g.meta.height || cc >= W) return false;
    if (!isPassable(g, rr * W + cc, m)) return false;
  }
  return true;
}

/** Douglas-Peucker simplification that never cuts across no-go ground. */
export function simplify(g: RouteGrid, m: CostModel, pts: LonLat[], tolM = 1.5): LonLat[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const { dxM, dyM, cellLonDeg, cellLatDeg } = g.meta;
  const kx = dxM / cellLonDeg;
  const ky = dyM / cellLatDeg;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (j <= i + 1) continue;
    const ax = pts[i].lon * kx;
    const ay = pts[i].lat * ky;
    const bx = pts[j].lon * kx;
    const by = pts[j].lat * ky;
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    let worst = -1;
    let worstD = -1;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k].lon * kx;
      const py = pts[k].lat * ky;
      const dist = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L;
      if (dist > worstD) {
        worstD = dist;
        worst = k;
      }
    }
    if (worstD > tolM || !segmentClear(g, m, pts[i], pts[j])) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

export type RouteResult = { ok: true; points: LonLat[] } | { ok: false; reason: string };

/** Safest route between two places, as a simplified line of lon/lat points. */
export function findRoute(g: RouteGrid, m: CostModel, a: LonLat, b: LonLat): RouteResult {
  const ra = toRC(g.meta, a.lon, a.lat);
  const rb = toRC(g.meta, b.lon, b.lat);
  const s = snapToPassable(g, m, ra.r, ra.c);
  const t = snapToPassable(g, m, rb.r, rb.c);
  if (s < 0 || t < 0) return { ok: false, reason: "A stop is on ground that is too steep to reach." };
  const path = astar(g, m, s, t);
  if (!path) return { ok: false, reason: "No safe path: steep ground blocks the way." };
  const W = g.meta.width;
  const pts = Array.from(path, (i) => toLonLat(g.meta, Math.floor(i / W), i % W));
  const line = simplify(g, m, pts);
  // keep the exact stop positions at both ends when they are reachable in a straight line
  if (segmentClear(g, m, a, line[0])) line.unshift(a);
  if (segmentClear(g, m, line[line.length - 1], b)) line.push(b);
  return { ok: true, points: line };
}
