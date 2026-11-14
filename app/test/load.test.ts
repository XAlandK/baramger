import { describe, expect, it } from "vitest";
import { DEFAULT_LOAD, addPickup, factorText, loadStatus, loadsPerLeg, timeFactor, withLoadFactor } from "../src/load";
import type { Leg } from "../src/plan";

const M = DEFAULT_LOAD; // body 82 + suit 104, kit 15, care 22.7, max 30

describe("load factor", () => {
  it("is 1 with the standard kit", () => {
    expect(timeFactor(M, M.kitKg)).toBe(1);
  });

  it("grows with the mass moved: about +0.5% per extra kg", () => {
    expect(timeFactor(M, 16)).toBeCloseTo((82 + 104 + 16) / (82 + 104 + 15), 12);
    expect(timeFactor(M, 16) - 1).toBeCloseTo(1 / 201, 12);
    expect(timeFactor(M, 25)).toBeGreaterThan(timeFactor(M, 20));
  });

  it("is below 1 when carrying less than the standard kit", () => {
    expect(timeFactor(M, 5)).toBeLessThan(1);
  });

  it("formats the effect", () => {
    expect(factorText(1)).toBe("");
    expect(factorText(timeFactor(M, 16))).toBe("+0.5% time");
    expect(factorText(timeFactor(M, 5))).toBe("−5.0% time");
  });
});

describe("pickups and load status", () => {
  it("gives a pickup to the astronaut carrying the least", () => {
    expect(addPickup([15, 14], 1)).toEqual([15, 15]);
    expect(addPickup([15, 15], 1)).toEqual([16, 15]); // tie: first astronaut
    expect(addPickup([15, 15], 0)).toEqual([15, 15]);
  });

  it("tracks the load on each leg: pickups count from the leg after the stop", () => {
    const per = loadsPerLeg([15, 15], [0, 1, 0, 1]);
    expect(per).toEqual([[15, 15], [15, 15], [16, 15], [16, 15], [16, 16]]);
  });

  it("is ok up to 22.7 kg, take care up to 30 kg, too heavy above", () => {
    expect(loadStatus(M, 22.7)).toBe("ok");
    expect(loadStatus(M, 25)).toBe("care");
    expect(loadStatus(M, 30)).toBe("care");
    expect(loadStatus(M, 30.5)).toBe("fail");
  });

  it("re-times a leg without changing the original or its path", () => {
    const leg: Leg = {
      fromId: "a", toId: "b", fromName: "A", toName: "B", points: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }],
      samples: [{ lon: 0, lat: 0, h: 0, slope: 0, d: 0, t: 0, radio: true }, { lon: 1, lat: 1, h: 0, slope: 0, d: 10, t: 10, radio: false }],
      distanceM: 10, ascentM: 0, descentM: 0, maxSlope: 0, careM: 0, minutes: 10, noRadioMin: 4,
    };
    const slow = withLoadFactor(leg, 1.1, 18);
    expect(slow.minutes).toBeCloseTo(11, 12);
    expect(slow.noRadioMin).toBeCloseTo(4.4, 12);
    expect(slow.samples[1].t).toBeCloseTo(11, 12);
    expect(slow.points).toBe(leg.points);
    expect(leg.minutes).toBe(10); // original untouched
    // applying a new factor is relative to the old one, not stacked
    expect(withLoadFactor(slow, 1.2, 25).minutes).toBeCloseTo(12, 12);
  });
});
