import { describe, expect, it } from "vitest";
import { PANEL_W, cleanStopName, discRadiusPx, fovAcross, needsShaping, planetFitAltitude, uiLayout, widenFactor } from "../src/layout";

const FOV = (60 * Math.PI) / 180; // CesiumJS default: 60 degrees across the larger side
const MARS_R = 3_396_190;

describe("uiLayout: the panel never needs to scroll", () => {
  it("draws the panel at full size when the window is tall enough", () => {
    expect(uiLayout(1280, 800)).toEqual({ scale: 1, narrow: false, popupFull: false, tooSmall: false });
    expect(uiLayout(1920, 1080).scale).toBe(1);
  });

  it("scales the panel down on a short window, but not below 0.55", () => {
    expect(uiLayout(1024, 560).scale).toBeCloseTo(560 / 740, 5);
    expect(uiLayout(1024, 300).scale).toBe(0.55);
  });

  it("keeps the panel beside the map while a usable strip is left", () => {
    // the Claude desktop browser pane is about 600 px wide: the map keeps a 218 px strip
    const pane = uiLayout(598, 718);
    expect(pane.narrow).toBe(false);
    expect(598 - PANEL_W * pane.scale).toBeGreaterThan(200);
    expect(uiLayout(500, 600).narrow).toBe(true); // a phone-sized window: the panel lies over the map
  });

  it("says when the window is too short to show the whole panel", () => {
    expect(uiLayout(598, 268).tooSmall).toBe(true); // a browser pane squeezed to a strip
    expect(uiLayout(598, 268).scale).toBe(0.55);
    expect(uiLayout(1024, 560).tooSmall).toBe(false);
    expect(uiLayout(500, 600).tooSmall).toBe(false);
  });

  it("sends pop-ups to the whole window when there is no room beside the panel", () => {
    expect(uiLayout(598, 718).popupFull).toBe(true);
    expect(uiLayout(800, 725).popupFull).toBe(true);
    expect(uiLayout(1280, 800).popupFull).toBe(false);
  });
});

describe("camera fit on narrow maps", () => {
  it("uses the full angle across a wide map and a smaller one across a narrow map", () => {
    expect(fovAcross(888, 720, FOV)).toBe(FOV);
    expect((fovAcross(218, 718, FOV) * 180) / Math.PI).toBeCloseTo(19.9, 1);
  });

  it("does not move the camera back on a wide or square map", () => {
    expect(widenFactor(888, 720, FOV)).toBe(1);
    expect(widenFactor(1280, 800, FOV)).toBe(1);
    expect(widenFactor(700, 700, FOV)).toBe(1);
  });

  it("moves the camera back on a very wide, low map, where the view is cut at the top and bottom", () => {
    expect(widenFactor(2168, 950, FOV)).toBeGreaterThan(1.15); // a 21:9 screen: Z2's stop 4 was below the edge
    expect(widenFactor(2168, 950, FOV)).toBeLessThan(1.3);
    expect(widenFactor(1920, 620, FOV)).toBeGreaterThan(1.5);
    expect(widenFactor(1056, 718, FOV)).toBe(1); // a normal laptop window beside the panel
  });

  it("moves the camera back on a narrow strip so the same ground still fits", () => {
    const f = widenFactor(218, 718, FOV);
    expect(f).toBeGreaterThan(2.2);
    expect(f).toBeLessThan(2.4);
    // what the camera sees from side to side at distance d grows with d: the factor restores the framing
    const seenBefore = 2 * Math.tan((22 * Math.PI) / 180);
    const seenAfter = 2 * f * Math.tan(fovAcross(218, 718, FOV) / 2);
    expect(seenAfter).toBeCloseTo(seenBefore, 6);
  });
});

describe("the whole planet fits the map", () => {
  const sizes: [number, number][] = [[888, 720], [1280, 800], [711, 718], [218, 718], [600, 300], [1920, 1080]];

  it("makes the disc take about 70% of the smaller side, whatever the map's shape", () => {
    for (const [w, h] of sizes) {
      const altitude = planetFitAltitude(w, h, FOV, MARS_R);
      const share = (2 * discRadiusPx(w, h, FOV, MARS_R, altitude)) / Math.min(w, h);
      expect(share).toBeGreaterThan(0.62);
      expect(share).toBeLessThan(0.72);
    }
  });

  it("is farther away for a narrow strip than for a wide map", () => {
    const wide = planetFitAltitude(888, 720, FOV, MARS_R);
    const strip = planetFitAltitude(218, 718, FOV, MARS_R);
    expect(wide / 1000).toBeGreaterThan(5_000);
    expect(wide / 1000).toBeLessThan(9_000);
    expect(strip / 1000).toBeGreaterThan(20_000);
    expect(strip / 1000).toBeLessThan(30_000);
  });

  it("keeps the disc the same size while the panel slides in beside a wide map", () => {
    // launch animation ending: the map goes from 1280 to 888 px wide; the height (the smaller side) stays
    const before = discRadiusPx(1280, 800, FOV, MARS_R, planetFitAltitude(1280, 800, FOV, MARS_R));
    const after = discRadiusPx(888, 800, FOV, MARS_R, planetFitAltitude(888, 800, FOV, MARS_R));
    expect(Math.abs(before - after)).toBeLessThan(10);
  });
});

describe("cleanStopName: names the crew gives to their own stops", () => {
  it("keeps a normal name", () => {
    expect(cleanStopName("Delta edge", "New stop 1")).toBe("Delta edge");
  });

  it("trims spaces at the ends and joins runs of spaces", () => {
    expect(cleanStopName("   Dark   spots \t rock  ", "New stop 1")).toBe("Dark spots rock");
  });

  it("falls back to the default name when the field is empty or only spaces", () => {
    expect(cleanStopName("", "New stop 3")).toBe("New stop 3");
    expect(cleanStopName("     ", "New stop 3")).toBe("New stop 3");
  });

  it("cuts a name at 40 characters and leaves no space at the end", () => {
    const long = "A very long name for a stop that goes on and on and on";
    const out = cleanStopName(long, "New stop 1");
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toBe(long.slice(0, 40).trim());
    expect(cleanStopName("x".repeat(39) + " y", "f")).toBe("x".repeat(39));
  });

  it("keeps Kurdish, Arabic and other scripts as typed", () => {
    expect(cleanStopName("  بەردی خاڵدار ", "New stop 1")).toBe("بەردی خاڵدار");
  });
});

describe("needsShaping: which names the map must not draw letter by letter", () => {
  it("lets the map engine draw Latin, Greek and Cyrillic names", () => {
    for (const name of ["Cheyava Falls rock", "Rover stop, sol 1231", "Depot spot 1 (sol 652)", "Çiya û deşt", "Δέλτα", "Кратер", "New stop 3 · north – east"]) {
      expect(needsShaping(name)).toBe(false);
    }
  });

  it("hands Kurdish (Sorani), Arabic, Persian, Hebrew and Hindi names to the browser", () => {
    for (const name of ["بەردی سوور", "صخرة حمراء", "سنگ سرخ", "סלע אדום", "लाल चट्टान", "Rock بەرد 2"]) {
      expect(needsShaping(name)).toBe(true);
    }
  });
});
