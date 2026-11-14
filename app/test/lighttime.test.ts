import { describe, expect, it } from "vitest";
import { earthMarsLightTime } from "../src/lighttime";

// Reference distances from astropy's built-in ephemeris (computed 2026-11-14, independent of our code).
const REFERENCE: [string, number][] = [
  ["2023-11-18", 2.5264], // solar conjunction
  ["2025-01-12", 0.6423], // close approach
  ["2026-11-14", 1.3244],
  ["2027-02-19", 0.678], // opposition
  ["2028-01-01", 2.2962],
];

describe("Earth-Mars light time", () => {
  it("matches an independent ephemeris within 0.002 AU", () => {
    for (const [d, au] of REFERENCE) {
      expect(Math.abs(earthMarsLightTime(new Date(`${d}T00:00:00Z`)).distanceAu - au)).toBeLessThan(0.002);
    }
  });

  it("turns distance into minutes (0.6423 AU is about 5.3 min)", () => {
    expect(earthMarsLightTime(new Date("2025-01-12T00:00:00Z")).oneWayMin).toBeCloseTo(5.34, 1);
  });

  it("stays inside the known range of 3 to 23 minutes", () => {
    for (let y = 2024; y <= 2030; y++) {
      for (let m = 0; m < 12; m += 2) {
        const t = earthMarsLightTime(new Date(Date.UTC(y, m, 1))).oneWayMin;
        expect(t).toBeGreaterThan(3);
        expect(t).toBeLessThan(23);
      }
    }
  });
});
