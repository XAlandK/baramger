// Earth-Mars distance and one-way light time, from JPL's "Keplerian Elements for Approximate
// Positions of the Major Planets" (E. M. Standish, Table 1, valid 1800-2050).

const AU_LIGHT_S = 499.004784; // seconds for light to cross 1 AU

type Elements = [number, number, number, number, number, number]; // a, e, I, L, long. perihelion, long. node
const EARTH: [Elements, Elements] = [
  [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
  [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
];
const MARS: [Elements, Elements] = [
  [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
  [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
];

const rad = (d: number) => (d * Math.PI) / 180;

/** Heliocentric ecliptic position (AU) at a Julian date. */
function position([e0, rate]: [Elements, Elements], jd: number): [number, number, number] {
  const T = (jd - 2451545.0) / 36525;
  const [a, e, I, L, wbar, node] = e0.map((v, i) => v + rate[i] * T);
  const w = wbar - node;
  let M = (((L - wbar) % 360) + 540) % 360 - 180;
  M = rad(M);
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 20; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const [cw, sw, cO, sO, cI, sI] = [Math.cos(rad(w)), Math.sin(rad(w)), Math.cos(rad(node)), Math.sin(rad(node)), Math.cos(rad(I)), Math.sin(rad(I))];
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

export function julianDate(d: Date): number {
  return d.getTime() / 86400000 + 2440587.5;
}

export interface LightTime {
  distanceAu: number;
  distanceMkm: number;
  oneWayMin: number;
}

export function earthMarsLightTime(d: Date): LightTime {
  const jd = julianDate(d);
  const a = position(EARTH, jd);
  const b = position(MARS, jd);
  const au = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return { distanceAu: au, distanceMkm: au * 149.5978707, oneWayMin: (au * AU_LIGHT_S) / 60 };
}
