// Gear load (assumptions A15-A21): what each astronaut carries changes the walking time.
//
// Walking time grows with the total mass an astronaut moves: body + suit + load.
//   time factor = (body + suit + heaviest load) / (body + suit + standard kit)
// The crew walks together, so the astronaut carrying the most sets the pace.
// Mass, not weight: on Mars a load weighs 0.38 of its Earth weight, but its mass (inertia) is the
// same, and NASA's metabolic model scales with mass, so the effect is not reduced for Mars gravity.
// Only the time changes; the route path stays the same.

import type { CheckStatus, Leg } from "./plan";

export interface LoadModel {
  bodyKg: number; // A15 astronaut body mass
  suitKg: number; // A16 Mars suit with life support
  kitKg: number; // A17 standard kit; walking speed A3 applies with this load
  careKg: number; // A20 take care above this load per astronaut
  maxKg: number; // A21 most load allowed per astronaut
}

export const DEFAULT_LOAD: LoadModel = { bodyKg: 82, suitKg: 104, kitKg: 15, careKg: 22.7, maxKg: 30 };

/** Walking-time multiplier for the heaviest load in the crew (1 = standard kit). */
export function timeFactor(m: LoadModel, heaviestKg: number): number {
  return (m.bodyKg + m.suitKg + heaviestKg) / (m.bodyKg + m.suitKg + m.kitKg);
}

export function heaviest(loads: number[]): number {
  return loads.length ? Math.max(...loads) : 0;
}

/** A picked-up sample goes to the astronaut carrying the least (the first one on a tie). */
export function addPickup(loads: number[], kg: number): number[] {
  const out = [...loads];
  if (!out.length || !(kg > 0)) return out;
  let i = 0;
  for (let j = 1; j < out.length; j++) if (out[j] < out[i]) i = j;
  out[i] += kg;
  return out;
}

/**
 * Loads during each leg. Leg 0 (habitat to the first stop) starts with startKg; after stop k the
 * pickup made there is added. Returns stops + 1 entries (the last one is the way home).
 */
export function loadsPerLeg(startKg: number[], pickupKgPerStop: number[]): number[][] {
  let cur = [...startKg];
  const out = [cur];
  for (const kg of pickupKgPerStop) {
    cur = addPickup(cur, kg);
    out.push(cur);
  }
  return out;
}

export function loadStatus(m: LoadModel, kg: number): CheckStatus {
  return kg <= m.careKg + 1e-9 ? "ok" : kg <= m.maxKg + 1e-9 ? "care" : "fail";
}

/** A copy of the leg with its walking time set for a new load factor. The path is unchanged. */
export function withLoadFactor(leg: Leg, factor: number, loadKg: number): Leg {
  const r = factor / (leg.loadFactor ?? 1);
  return {
    ...leg,
    minutes: leg.minutes * r,
    noRadioMin: leg.noRadioMin * r,
    samples: leg.samples.map((s) => ({ ...s, t: s.t * r })),
    loadFactor: factor,
    loadKg,
  };
}

/** "+0.5% time", "−2.0% time" or "" when the factor is about 1. */
export function factorText(factor: number): string {
  const pct = (factor - 1) * 100;
  if (Math.abs(pct) < 0.05) return "";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}% time`;
}

export function kgText(kg: number): string {
  return `${(Math.round(kg * 10) / 10).toFixed(1)} kg`;
}
