import { describe, expect, it } from "vitest";
import { CREW_GAP_M, CREW_RING_M, CREW_SIDE_M, bearingTo, crewNames, crewSpots, metresApart, offset } from "../src/crew";

const start = { lon: 77.3, lat: 18.49, h: -2350 };
/** A straight path going east, `metres` long, one point per metre. */
const eastPath = (metres: number) => Array.from({ length: metres + 1 }, (_, i) => ({ ...offset(start, 90, i), h: -2350 + i * 0.1 }));

describe("crewNames", () => {
  it("names the astronauts as in the Safety tab, at most four", () => {
    expect(crewNames(1)).toEqual(["A1"]);
    expect(crewNames(4)).toEqual(["A1", "A2", "A3", "A4"]);
    expect(crewNames(9)).toHaveLength(4);
    expect(crewNames(0)).toEqual([]);
  });
});

describe("crewSpots: walking in single file", () => {
  it("puts A1 at the crew's place and the others behind it, CREW_GAP_M apart", () => {
    const trail = eastPath(40);
    const spots = crewSpots(trail, 4);
    expect(spots.map((s) => s.name)).toEqual(["A1", "A2", "A3", "A4"]);
    expect(metresApart(spots[0], trail[40])).toBeLessThan(0.01);
    for (let k = 1; k < 4; k++) {
      expect(metresApart(spots[k - 1], spots[k])).toBeCloseTo(CREW_GAP_M, 1);
      expect(spots[k].lon).toBeLessThan(spots[k - 1].lon); // behind = further west on an eastward path
    }
  });

  it("faces everyone the way the path goes", () => {
    for (const s of crewSpots(eastPath(40), 3)) expect(s.headingDeg).toBeCloseTo(90, 0);
  });

  it("follows the path round a corner instead of cutting it", () => {
    const corner = offset(start, 0, 5); // 5 m north, then 6 m east
    const trail = [start, { ...corner, h: -2350 }, ...Array.from({ length: 6 }, (_, i) => ({ ...offset(corner, 90, i + 1), h: -2350 }))];
    const [, , , a4] = crewSpots(trail, 4); // A4 is 9 m back: round the corner, 3 m down the northward stretch
    expect(a4.headingDeg).toBeCloseTo(0, 0);
    expect(metresApart(a4, start)).toBeCloseTo(2, 1);
  });

  it("takes heights from the ground under each astronaut when given", () => {
    const spots = crewSpots(eastPath(40), 2, { heightAt: () => -2000 });
    expect(spots.every((s) => s.h === -2000)).toBe(true);
  });

  it("takes heights from the path otherwise", () => {
    const spots = crewSpots(eastPath(40), 2);
    expect(spots[0].h).toBeCloseTo(-2346, 5);
    expect(spots[1].h).toBeCloseTo(-2346.3, 5);
  });

  it("lets the ones still waiting stand side by side at the start when the path is short", () => {
    const spots = crewSpots(eastPath(2), 4); // only 2 m walked: A2 to A4 have not stepped on the path yet
    expect(metresApart(spots[0], spots[1])).toBeGreaterThan(1.9);
    for (let k = 1; k < 4; k++) for (let j = 0; j < k; j++) expect(metresApart(spots[k], spots[j])).toBeGreaterThan(1);
    expect(metresApart(spots[3], start)).toBeCloseTo(3 * CREW_SIDE_M, 1);
  });

  it("works with a single point (the crew has not moved yet)", () => {
    const spots = crewSpots([start], 2, { headingDeg: 45 });
    expect(spots).toHaveLength(2);
    expect(spots[0].headingDeg).toBe(45);
    expect(metresApart(spots[0], spots[1])).toBeCloseTo(CREW_SIDE_M, 1);
  });

  it("gives nobody for an empty path or an empty crew", () => {
    expect(crewSpots([], 3)).toEqual([]);
    expect(crewSpots(eastPath(5), 0)).toEqual([]);
  });
});

describe("crewSpots: at a stop", () => {
  const stop = offset(start, 90, 40);
  it("stands everyone CREW_RING_M around the stop, facing it", () => {
    const spots = crewSpots(eastPath(40), 4, { stopAt: stop });
    for (const s of spots) {
      expect(metresApart(s, stop)).toBeCloseTo(CREW_RING_M, 1);
      expect(Math.abs(((s.headingDeg - bearingTo(s, stop) + 540) % 360) - 180)).toBeLessThan(0.5);
    }
    for (let k = 1; k < 4; k++) expect(metresApart(spots[k], spots[k - 1])).toBeGreaterThan(2);
  });

  it("puts A1 on the side the crew came from", () => {
    const [a1] = crewSpots(eastPath(40), 2, { stopAt: stop });
    expect(a1.lon).toBeLessThan(stop.lon); // came from the west
  });

  it("puts a crew of one right at the stop", () => {
    const [a1] = crewSpots(eastPath(40), 1, { stopAt: stop });
    expect(metresApart(a1, stop)).toBeLessThan(0.01);
  });
});

describe("bearingTo and offset", () => {
  it("agree with each other", () => {
    for (const deg of [0, 45, 90, 180, 270, 333]) {
      const p = offset(start, deg, 100);
      expect(metresApart(start, p)).toBeCloseTo(100, 0);
      expect(bearingTo(start, p)).toBeCloseTo(deg, 0);
    }
  });
});
