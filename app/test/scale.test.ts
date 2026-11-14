// The scale card on the map: a scale bar plus a drawing of a person, a rover or a spacecraft at
// the same scale. These tests check the rules, the real sizes, and that every zoom gets a card.
import { describe, expect, it } from "vitest";
import {
  BAR_MAX, FIG_H, FIG_W, MIN_PX, PERSON_HEIGHT_M, SCALE_REFS,
  type ScaleCard, lengthText, niceLength, roundCount, scaleCard, scaleHtml,
} from "../src/scale";

/** Map scales from the closest zoom on a wide screen to far beyond the whole planet, in small steps. */
function scales(from: number, to: number, step = 1.03): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m *= step) out.push(m);
  return out;
}

describe("scale card: the bar", () => {
  it("uses round lengths: 1, 2 or 5 times a power of ten", () => {
    expect(niceLength(3.25)).toBe(2);
    expect(niceLength(5)).toBe(5);
    expect(niceLength(9.99)).toBe(5);
    expect(niceLength(10)).toBe(10);
    expect(niceLength(1362)).toBe(1000);
    expect(niceLength(0.73)).toBe(0.5);
    expect(niceLength(0.03)).toBe(0.02);
    expect(niceLength(1_500_000)).toBe(1_000_000);
  });

  it("gives nothing for a length that is not a positive number", () => {
    expect(niceLength(0)).toBe(0);
    expect(niceLength(-4)).toBe(0);
    expect(niceLength(Number.NaN)).toBe(0);
    expect(niceLength(Infinity)).toBe(0);
  });

  it("writes lengths in simple units", () => {
    expect(lengthText(0.5)).toBe("50 cm");
    expect(lengthText(2)).toBe("2 m");
    expect(lengthText(500)).toBe("500 m");
    expect(lengthText(1000)).toBe("1 km");
    expect(lengthText(2_000_000)).toBe("2,000 km");
  });

  it("is never longer than its slot, and never shorter than 40% of it", () => {
    for (const mpp of scales(0.005, 60_000)) {
      const card = scaleCard(mpp)!;
      expect(card.barPx).toBeLessThanOrEqual(BAR_MAX + 1e-6);
      expect(card.barPx).toBeGreaterThanOrEqual(BAR_MAX * 0.4 - 1e-6);
      expect(card.barPx * mpp).toBeCloseTo(card.barM, 6); // the bar really is that long on the map
    }
  });
});

describe("scale card: the real sizes", () => {
  const size = (id: string) => SCALE_REFS.find((r) => r.id === id)!;

  it("uses the sizes NASA publishes", () => {
    expect([size("rover").widthM, size("rover").heightM]).toEqual([3, 2.2]); // Perseverance: 10 feet long, 7 feet tall
    expect([size("orbiter").widthM, size("orbiter").heightM]).toEqual([13.6, 6.5]); // MRO press kit
    expect(size("shuttle").widthM).toBeCloseTo(122 * 0.3048, 1); // 122 feet
    expect(size("shuttle").heightM).toBeCloseTo(78 * 0.3048, 1); // wingspan 78 feet
    expect([size("station").widthM, size("station").heightM]).toEqual([109, 73]);
    expect(size("person").heightM).toBe(PERSON_HEIGHT_M);
    expect(PERSON_HEIGHT_M).toBe(1.8);
  });

  it("names a NASA page for every spacecraft, and says the person is a round value", () => {
    for (const r of SCALE_REFS) {
      if (r.id === "person") {
        expect(r.source).toContain("A22");
        expect(r.about).toContain("round value");
      } else {
        expect(r.source).toMatch(/^https:\/\/([a-z]+\.)*nasa\.gov\//);
        expect(r.about).toContain("NASA");
      }
    }
  });

  it("draws every figure in a box with the true proportions", () => {
    for (const r of SCALE_REFS) expect(r.box[0] / r.box[1]).toBeCloseTo(r.widthM / r.heightM, 2);
  });

  it("is sorted from the largest to the smallest", () => {
    const widths = SCALE_REFS.map((r) => Math.max(r.widthM, r.heightM));
    expect([...widths].sort((a, b) => b - a)).toEqual(widths);
  });
});

describe("scale card: which drawing at which zoom", () => {
  const ids = (mpp: number) => scaleCard(mpp)!.drawn.map((d) => `${d.ref.id}${d.lying ? " lying" : ""}`);

  it("walks down the ladder as the crew zooms in", () => {
    expect(ids(4)).toEqual(["station"]);
    expect(ids(0.8)).toEqual(["shuttle"]);
    expect(ids(0.2)).toEqual(["orbiter"]);
    expect(ids(0.13)).toEqual(["orbiter"]); // no room in the caption to name a person too: none is drawn
    expect(ids(0.06)).toEqual(["rover", "person"]);
    expect(ids(0.035)).toEqual(["person"]);
    expect(ids(0.02)).toEqual(["person lying"]); // too tall for the card: drawn lying along the bar
  });

  it("names every drawing it shows", () => {
    expect(scaleCard(0.06)!.caption).toBe("Rover 3 m · person 1.8 m");
    expect(scaleCard(0.2)!.caption).toBe("MRO orbiter: 13.6 m");
    expect(scaleCard(0.8)!.caption).toBe("Shuttle orbiter: 37 m"); // 37 m is the orbiter, not the whole Shuttle
    expect(scaleCard(4)!.caption).toBe("Space station: 109 m");
    expect(scaleCard(0.035)!.caption).toBe("Person in a suit: 1.8 m");
    for (const mpp of scales(0.0134, 9)) {
      const card = scaleCard(mpp)!;
      if (card.drawn.some((d) => d.ref.id === "person") && card.drawn.length === 2) expect(card.caption).toContain("person");
    }
  });

  it("draws to scale: every drawing is as large as the thing would be on the map", () => {
    for (const mpp of scales(0.0134, 9)) {
      for (const d of scaleCard(mpp)!.drawn) {
        const long = Math.max(d.ref.widthM, d.ref.heightM);
        expect(Math.max(d.w, d.h) * mpp).toBeCloseTo(long, 6);
        expect(Math.min(d.w, d.h) * mpp).toBeCloseTo(Math.min(d.ref.widthM, d.ref.heightM), 6);
      }
    }
  });

  it("has a drawing at every zoom between the closest view and about 9 m per pixel, and it always fits", () => {
    for (const mpp of scales(0.0134, 9.08)) {
      const card = scaleCard(mpp)!;
      expect(card.mode, `at ${mpp} m per pixel`).toBe("drawn");
      expect(card.drawn.length).toBeGreaterThan(0);
      const width = card.drawn.reduce((a, d) => a + d.w, 0) + 10 * (card.drawn.length - 1);
      expect(width).toBeLessThanOrEqual(FIG_W + 1e-6);
      for (const d of card.drawn) {
        expect(d.h).toBeLessThanOrEqual(FIG_H + 1e-6);
        expect(Math.max(d.w, d.h)).toBeGreaterThanOrEqual(MIN_PX - 1e-6);
      }
    }
  });

  it("counts space stations when the view is too wide for any drawing", () => {
    const crater = scaleCard(80)!; // the whole-crater view: about 80 m per pixel
    expect(crater.mode).toBe("count");
    expect(crater.barText).toBe("5 km");
    expect(crater.count).toBeCloseTo(5000 / 109, 6);
    expect(crater.caption).toBe("≈ 46 space stations");
    const planet = scaleCard(15_000)!; // the whole planet: about 15 km per pixel
    expect(planet.barText).toBe("1,000 km");
    expect(planet.caption).toBe("≈ 9,200 space stations");
    expect(planet.about).toContain("109 m each");
  });

  it("shows the bar alone when even a lying person is too large", () => {
    const card = scaleCard(0.008)!;
    expect(card.mode).toBe("bar");
    expect(card.drawn).toEqual([]);
    expect(card.barText).toBe("50 cm");
    expect(card.caption).toBe("A person: about 1.8 m");
  });

  it("gives no card without a usable scale", () => {
    for (const bad of [0, -1, Number.NaN, Infinity]) expect(scaleCard(bad)).toBeNull();
  });

  it("says where the scale holds, at every zoom", () => {
    for (const mpp of [0.008, 0.02, 0.06, 0.8, 4, 80, 15_000]) expect(scaleCard(mpp)!.about).toContain("middle of the map");
  });

  it("keeps every caption short enough for the card", () => {
    for (const mpp of scales(0.005, 60_000)) expect(scaleCard(mpp)!.caption.length).toBeLessThanOrEqual(24);
  });

  it("rounds counts to two leading digits", () => {
    expect(roundCount(9.17)).toBe("9");
    expect(roundCount(45.9)).toBe("46");
    expect(roundCount(183.5)).toBe("180");
    expect(roundCount(18_349)).toBe("18,000");
  });
});

describe("scale card: the HTML", () => {
  it("has three rows: drawings, bar and caption", () => {
    const html = scaleHtml(scaleCard(0.06)!);
    expect(html).toContain('class="sc-fig" data-mode="drawn"');
    expect(html).toContain('data-key="rover"');
    expect(html).toContain('data-key="person"');
    expect(html).toContain("<b>2 m</b>");
    expect(html).toContain("Rover 3 m · person 1.8 m");
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("gives each drawing its size on screen", () => {
    const card = scaleCard(0.06)!;
    const html = scaleHtml(card);
    expect(html).toContain(`width="${Math.round((3 / 0.06) * 2) / 2}" height="${Math.round((2.2 / 0.06) * 2) / 2}"`);
    expect(html).toContain(`style="width:${Math.round(card.barPx * 2) / 2}px"`);
  });

  it("turns a lying person a quarter turn", () => {
    const html = scaleHtml(scaleCard(0.02)!);
    expect(html).toContain('data-key="person-lying"');
    expect(html).toContain('viewBox="0 0 72 30"');
    expect(html).toContain("rotate(-90)");
  });

  it("marks the space station picture as not to scale in the count mode", () => {
    const html = scaleHtml(scaleCard(80)!);
    expect(html).toContain('data-mode="count"');
    expect(html).toContain("sc-ref dim");
    expect(html).toContain("× 46");
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("never writes something that is not a number, at any zoom", () => {
    for (const mpp of scales(0.005, 60_000, 1.4)) expect(scaleHtml(scaleCard(mpp)!)).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe("scale card: the bar row fits the card", () => {
  it("is never wider than the drawing area, with the gap and the widest label", () => {
    // IBM Plex Mono 12 px: about 7.2 px per letter; the card's content box is 142 px wide
    for (const mpp of scales(0.005, 60_000)) {
      const card = scaleCard(mpp)!;
      expect(card.barPx + 8 + card.barText.length * 7.25, `${card.barText} at ${mpp}`).toBeLessThanOrEqual(142);
    }
  });
});

describe("scale card: the person comes from the mission package (A22)", () => {
  it("draws and names the height it is given", () => {
    const alone = scaleCard(0.035, { personM: 1.7 })!;
    expect(alone.caption).toBe("Person in a suit: 1.7 m");
    expect(alone.drawn[0].h).toBeCloseTo(1.7 / 0.035, 6);
    expect(alone.about).toContain("1.7 m");
    const beside = scaleCard(0.06, { personM: 1.7 })!;
    expect(beside.caption).toBe("Rover 3 m · person 1.7 m");
    expect(beside.drawn[1].h).toBeCloseTo(1.7 / 0.06, 6);
    expect(scaleCard(0.008, { personM: 1.7 })!.caption).toBe("A person: about 1.7 m");
  });

  it("keeps the figure's proportions at another height", () => {
    const d = scaleCard(0.035, { personM: 1.6 })!.drawn[0];
    expect(d.w / d.h).toBeCloseTo(0.75 / 1.8, 6);
  });

  it("falls back to 1.8 m for a value that is not a person's height", () => {
    for (const bad of [0, -1, 0.2, 12, Number.NaN]) expect(scaleCard(0.035, { personM: bad })!.caption).toBe("Person in a suit: 1.8 m");
  });
});

describe("scale card: it does not flip back and forth around a step", () => {
  const ids = (c: { drawn: { ref: { id: string }; lying: boolean }[]; mode: string }) => c.mode + ":" + c.drawn.map((d) => d.ref.id + (d.lying ? " lying" : "")).join("+");

  it("keeps the bar that is on screen while it still fits its slot", () => {
    const before = scaleCard(0.2379)!; // 76 px * 0.2379 = 18.08 m -> a 10 m bar
    expect(before.barText).toBe("10 m");
    expect(scaleCard(0.265)!.barText).toBe("20 m"); // a fresh card would take the longer bar
    const after = scaleCard(0.265, { prev: before })!;
    expect(after.barText).toBe("10 m"); // the card on screen keeps its bar
    expect(after.barPx).toBeCloseTo(10 / 0.265, 6); // and still draws it to scale
    // far enough, it must change: 10 m would be shorter than 30% of the slot
    expect(scaleCard(0.5, { prev: after })!.barText).toBe("20 m");
  });

  it("keeps the drawing that is on screen until a larger one fits with room to spare", () => {
    const orbiter = scaleCard(0.42)!; // just before the Shuttle orbiter fits
    expect(ids(orbiter)).toBe("drawn:orbiter");
    expect(ids(scaleCard(0.43)!)).toBe("drawn:shuttle"); // a fresh card switches at once
    expect(ids(scaleCard(0.43, { prev: orbiter })!)).toBe("drawn:orbiter"); // the card on screen does not
    expect(ids(scaleCard(0.52, { prev: orbiter })!)).toBe("drawn:shuttle"); // with 15% to spare it does
  });

  it("goes back to the smaller drawing as soon as the larger one no longer fits", () => {
    const shuttle = scaleCard(0.5)!;
    expect(ids(scaleCard(0.42, { prev: shuttle })!)).toBe("drawn:orbiter");
  });

  it("changes far less often than a card without memory when the scale wanders", () => {
    // a walk along rough ground: the scale swings by a quarter around 0.24 m per pixel, 400 updates
    let prev: ScaleCard | null = null;
    let withMemory = 0;
    let without = 0;
    let lastFresh = "";
    let lastKept = "";
    for (let i = 0; i < 400; i++) {
      const mpp = 0.24 * (1 + 0.25 * Math.sin(i / 3) * Math.cos(i / 17));
      const fresh: ScaleCard = scaleCard(mpp)!;
      const kept: ScaleCard = scaleCard(mpp, { prev })!;
      const f = `${fresh.barText}|${ids(fresh)}`;
      const k = `${kept.barText}|${ids(kept)}`;
      if (i > 0 && f !== lastFresh) without++;
      if (i > 0 && k !== lastKept) withMemory++;
      lastFresh = f;
      lastKept = k;
      prev = kept;
    }
    expect(without).toBeGreaterThan(20);
    expect(withMemory).toBeLessThanOrEqual(2);
  });

  it("is still a true card at every step, zooming in and zooming out", () => {
    for (const order of [scales(0.012, 12, 1.07), scales(0.012, 12, 1.07).reverse()]) {
      let prev: ScaleCard | null = null;
      for (const mpp of order) {
        const card: ScaleCard = scaleCard(mpp, { prev })!;
        expect(card.barPx).toBeLessThanOrEqual(BAR_MAX + 1e-6);
        expect(card.barPx).toBeGreaterThanOrEqual(BAR_MAX * 0.3 - 1e-6);
        expect(card.barPx * mpp).toBeCloseTo(card.barM, 6);
        for (const d of card.drawn) {
          expect(d.w).toBeLessThanOrEqual(FIG_W + 1e-6);
          expect(d.h).toBeLessThanOrEqual(FIG_H + 1e-6);
          expect(Math.max(d.w, d.h)).toBeGreaterThanOrEqual(10 - 1e-6);
          expect(Math.max(d.w, d.h) * mpp).toBeCloseTo(Math.max(d.ref.widthM, d.ref.heightM), 6);
        }
        if (mpp >= 0.0134 && mpp <= 9.08) expect(card.mode, `at ${mpp}`).toBe("drawn");
        prev = card;
      }
    }
  });

  it("lets a lying person stand up again only when there is room to spare", () => {
    const lying = scaleCard(0.031)!;
    expect(ids(lying)).toBe("drawn:person lying");
    expect(ids(scaleCard(0.033)!)).toBe("drawn:person"); // a fresh card: the person fits standing (54.5 px)
    expect(ids(scaleCard(0.033, { prev: lying })!)).toBe("drawn:person lying"); // on screen: stays lying
    expect(ids(scaleCard(0.039, { prev: lying })!)).toBe("drawn:person"); // 46 px: room to spare
  });
});
