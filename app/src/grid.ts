// Regular lon/lat grids from the mission package. Row 0 is the northern edge.

export interface GridMeta {
  width: number;
  height: number;
  west: number;
  south: number;
  east: number;
  north: number;
  cellLonDeg: number;
  cellLatDeg: number;
  dxM: number; // true east-west cell size (metres) at the grid's centre latitude
  dyM: number;
}

export interface HeightGrid {
  meta: GridMeta;
  h: Float32Array;
}

export interface RouteGrid extends HeightGrid {
  slope: Uint8Array; // whole degrees, 255 = unknown
  rough: Uint8Array; // centimetres, 255 = unknown
}

export interface LonLat {
  lon: number;
  lat: number;
}

export const UNKNOWN = 255;

/** Fractional row/col; cell centres sit on whole numbers. */
export function toRC(m: GridMeta, lon: number, lat: number): { r: number; c: number } {
  return { r: (m.north - lat) / m.cellLatDeg - 0.5, c: (lon - m.west) / m.cellLonDeg - 0.5 };
}

export function toLonLat(m: GridMeta, r: number, c: number): LonLat {
  return { lon: m.west + (c + 0.5) * m.cellLonDeg, lat: m.north - (r + 0.5) * m.cellLatDeg };
}

export function inside(m: GridMeta, lon: number, lat: number): boolean {
  return lon >= m.west && lon <= m.east && lat >= m.south && lat <= m.north;
}

export function cellIndex(m: GridMeta, lon: number, lat: number): number {
  const { r, c } = toRC(m, lon, lat);
  const rr = Math.min(m.height - 1, Math.max(0, Math.round(r)));
  const cc = Math.min(m.width - 1, Math.max(0, Math.round(c)));
  return rr * m.width + cc;
}

/** Bilinear sample; positions outside the grid are clamped to the edge. */
export function bilinear(m: GridMeta, a: Float32Array, lon: number, lat: number): number {
  let { r, c } = toRC(m, lon, lat);
  r = Math.min(m.height - 1, Math.max(0, r));
  c = Math.min(m.width - 1, Math.max(0, c));
  const r0 = Math.floor(r);
  const c0 = Math.floor(c);
  const r1 = Math.min(m.height - 1, r0 + 1);
  const c1 = Math.min(m.width - 1, c0 + 1);
  const fr = r - r0;
  const fc = c - c0;
  const w = m.width;
  const top = a[r0 * w + c0] * (1 - fc) + a[r0 * w + c1] * fc;
  const bot = a[r1 * w + c0] * (1 - fc) + a[r1 * w + c1] * fc;
  return top * (1 - fr) + bot * fr;
}

/** Metres per degree in each direction, consistent with the grid's own cell sizes. */
export function metresPerDeg(m: GridMeta): { kx: number; ky: number } {
  return { kx: m.dxM / m.cellLonDeg, ky: m.dyM / m.cellLatDeg };
}

export function metresBetween(m: GridMeta, a: LonLat, b: LonLat): number {
  const { kx, ky } = metresPerDeg(m);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky);
}

export async function loadGridMeta(url: string): Promise<GridMeta> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
  return (await r.json()) as GridMeta;
}

export async function loadBinary<T extends Float32Array | Uint8Array>(
  url: string,
  Kind: { new (b: ArrayBuffer): T },
  expected: number,
  onBytes?: (bytes: number) => void,
): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
  let buf: ArrayBuffer;
  if (onBytes && r.body) {
    // read it piece by piece, to show how much has arrived (bytes after decompression)
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onBytes(value.length);
    }
    const all = new Uint8Array(got);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    buf = all.buffer;
  } else buf = await r.arrayBuffer();
  const a = new Kind(buf);
  if (a.length !== expected) throw new Error(`${url}: expected ${expected} values, got ${a.length}`);
  return a;
}
