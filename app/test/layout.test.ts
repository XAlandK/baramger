import { describe, expect, it } from "vitest";
import {
  NAMES_FAR_M, NAMES_HIGH_M, NAMES_LOW_M, NARROW_MAP_W, PANEL_W, PHOTO_FULL_KM, PHOTO_GONE_KM, CRATER_VIEW_MAX_M, POLE_ARROW_TIP, POLE_HINT_ROOM_PX, POLE_LABEL_GAP_PX, POLE_LABEL_W_PX, POLE_TITLE_W, axisPointPx, cleanStopName, craterView, discRadiusPx, fovAcross,
  namesVisible, needsShaping, photoAlpha, photoLayerAlpha, planetFill, planetFitAltitude, uiLayout, widenFactor,
} from "../src/layout";
import css from "../src/style.css?raw";

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

describe("craterView: the whole crater, with every zone and its name in view", () => {
  const jezero = { name: "Jezero", lon: 77.68734927, lat: 18.4082, diameter_km: 47.52, source: "R1-mars-trek" };
  const zones = [{ lon: 77.4084, lat: 18.4534 }, { lon: 77.3051, lat: 18.4968 }]; // Z1 Three Forks (east), Z2 Bright Angel (west)
  const photoBox = [76.95, 17.78, 78.39, 19.04]; // the wide CTX layer of the mission packages
  const kmPerDeg = (3396.19 * Math.PI) / 180;
  type View = { lon: number; lat: number; heightM: number };
  /** Half of the view on the ground, in km (camera straight down, ground `groundM` below the sphere). */
  const half = (v: View, w: number, h: number, groundM = 0) => {
    const large = Math.max(w, h);
    const up = (v.heightM - groundM) / 1000;
    return { w: up * Math.tan(FOV / 2) * (w / large), h: up * Math.tan(FOV / 2) * (h / large) };
  };
  /** Where a place lies in the view: -1 = left or bottom edge, 0 = middle, 1 = right or top edge. */
  const place = (v: View, p: { lon: number; lat: number }, w: number, h: number, groundM = 0) => {
    const size = half(v, w, h, groundM);
    return {
      x: ((p.lon - v.lon) * kmPerDeg * Math.cos((v.lat * Math.PI) / 180)) / size.w,
      y: ((p.lat - v.lat) * kmPerDeg) / size.h,
    };
  };
  /** The four ends of the rim, in the same -1..1 measure (1 is the edge of the view). */
  const rim = (v: View, w: number, h: number, groundM = 0) => {
    const r = jezero.diameter_km / 2 / kmPerDeg;
    const rLon = r / Math.cos((jezero.lat * Math.PI) / 180);
    return [
      place(v, { lon: jezero.lon + rLon, lat: jezero.lat }, w, h, groundM).x,
      -place(v, { lon: jezero.lon - rLon, lat: jezero.lat }, w, h, groundM).x,
      place(v, { lon: jezero.lon, lat: jezero.lat + r }, w, h, groundM).y,
      -place(v, { lon: jezero.lon, lat: jezero.lat - r }, w, h, groundM).y,
    ];
  };
  /** The zone names as the map draws them: 121 px wide, 24 px from the marker; over the marker on a narrow map. */
  const nameBoxes = (v: View, w: number, h: number, groundM = 0) => {
    const meanLon = zones.reduce((a, z) => a + z.lon, 0) / zones.length;
    return zones.map((z) => {
      const x = ((1 + place(v, z, w, h, groundM).x) / 2) * w;
      if (w < NARROW_MAP_W) return [x - 60.5, x + 60.5];
      return z.lon >= meanLon ? [x + 24, x + 24 + 121] : [x - 24 - 121, x - 24];
    });
  };
  const MAPS: [number, number][] = [
    [888, 740], [888, 800], [1044, 718], [1528, 900], [632, 560], [632, 768], [653, 700], [482, 600], [708, 800], [420, 725], [412, 718], [219, 720],
    [500, 600], [414, 896], [568, 1080], [472, 1030], [662, 450], [567, 440],
  ];

  it("looks straight at the crater's centre from about 62 km on a normal wide map", () => {
    const v = craterView(jezero, zones, 888, 740, FOV)!;
    expect(v.lon).toBeCloseTo(jezero.lon, 6);
    expect(v.lat).toBeCloseTo(jezero.lat, 6);
    expect(v.heightM / 1000).toBeGreaterThan(60);
    expect(v.heightM / 1000).toBeLessThan(64);
  });

  it("never cuts a zone's name at the map's edge", () => {
    for (const [w, h] of MAPS) {
      for (const options of [{ groundM: 0 }, { photoBox, groundM: -2500 }]) {
        const v = craterView(jezero, zones, w, h, FOV, options)!;
        for (const [left, right] of nameBoxes(v, w, h, options.groundM)) {
          expect(left, `${w}x${h} left`).toBeGreaterThanOrEqual(0);
          expect(right, `${w}x${h} right`).toBeLessThanOrEqual(w);
        }
        for (const z of zones) expect(Math.abs(place(v, z, w, h, options.groundM).y), `${w}x${h} y`).toBeLessThanOrEqual(0.7 + 1e-9);
      }
    }
  });

  it("shows the whole rim wherever the map's shape allows it under the height limit", () => {
    for (const [w, h] of MAPS) {
      const v = craterView(jezero, zones, w, h, FOV)!;
      expect(v.heightM).toBeLessThanOrEqual(CRATER_VIEW_MAX_M);
      if (v.heightM < CRATER_VIEW_MAX_M) for (const edge of rim(v, w, h)) expect(edge, `${w}x${h}`).toBeLessThanOrEqual(0.96);
    }
  });

  it("stops at the height limit on a very low or very narrow map, where the rim cannot fit", () => {
    const low = craterView(jezero, zones, 1920, 620, FOV)!; // a very wide, low map
    expect(low.heightM).toBe(CRATER_VIEW_MAX_M);
    expect(Math.max(...rim(low, 1920, 620))).toBeGreaterThan(1); // the north and south rim are outside the map
    const narrow = craterView(jezero, zones, 219, 720, FOV)!; // the map strip of a 600 px wide window
    expect(narrow.heightM).toBe(CRATER_VIEW_MAX_M);
    expect(narrow.lon).toBeLessThan(jezero.lon); // the zones lie west of the crater's centre
    expect(narrow.lon).toBeGreaterThan(Math.min(...zones.map((z) => z.lon))); // but the view never goes past them
  });

  it("stays inside the wide photo map when the crater still fits", () => {
    for (const [w, h] of [[888, 740], [888, 800], [1044, 718], [708, 800]]) {
      const v = craterView(jezero, zones, w, h, FOV, { photoBox, groundM: -2500 })!;
      const size = half(v, w, h, -2500);
      const kmLon = kmPerDeg * Math.cos((v.lat * Math.PI) / 180);
      expect(v.lon - size.w / kmLon, `${w}x${h} west`).toBeGreaterThanOrEqual(photoBox[0] - 1e-6);
      expect(v.lon + size.w / kmLon, `${w}x${h} east`).toBeLessThanOrEqual(photoBox[2] + 1e-6);
      expect(v.lat - size.h / kmPerDeg, `${w}x${h} south`).toBeGreaterThanOrEqual(photoBox[1] - 1e-6);
      expect(v.lat + size.h / kmPerDeg, `${w}x${h} north`).toBeLessThanOrEqual(photoBox[3] + 1e-6);
      for (const edge of rim(v, w, h, -2500)) expect(edge).toBeLessThanOrEqual(0.96); // and the rim is still whole
    }
  });

  it("goes a little past the photo map rather than cut the rim (a full-HD window, a tall map)", () => {
    for (const [w, h] of [[1528, 900], [412, 718], [632, 768]]) {
      const inBox = craterView(jezero, zones, w, h, FOV, { photoBox, groundM: -2500 })!;
      const free = craterView(jezero, zones, w, h, FOV, { groundM: -2500 })!;
      expect(inBox.heightM).toBeLessThan(free.heightM); // lower than without the photo map: less of the planet map shows
      for (const edge of rim(inBox, w, h, -2500)) expect(edge).toBeLessThanOrEqual(0.96); // the rim is whole, with 5% free
    }
  });

  it("looks at the middle of the zones when they are wider apart than the view", () => {
    const far = [{ lon: 77.0, lat: 18.4 }, { lon: 78.4, lat: 18.4 }];
    const v = craterView(jezero, far, 120, 600, FOV)!;
    expect(v.lon).toBeCloseTo(77.7, 6);
  });

  it("works without zones: the crater alone", () => {
    const v = craterView(jezero, [], 888, 740, FOV)!;
    expect([v.lon, v.lat]).toEqual([jezero.lon, jezero.lat]);
  });

  it("gives a finite view for a map with no size", () => {
    for (const [w, h] of [[0, 0], [1, 1], [0, 700], [900, 0]]) {
      const v = craterView(jezero, zones, w, h, FOV)!;
      expect(Number.isFinite(v.lon) && Number.isFinite(v.lat) && Number.isFinite(v.heightM)).toBe(true);
      expect(v.heightM).toBeGreaterThan(0);
    }
  });

  it("gives nothing for an older zone list without a usable crater", () => {
    for (const bad of [null, undefined, {}, { lon: "77.6", lat: 18.4, diameter_km: 47 }, { lon: 77.6, lat: Number.NaN, diameter_km: 47 },
      { lon: 277.6, lat: 18.4, diameter_km: 47 }, { lon: 77.6, lat: 18.4 }, { lon: 77.6, lat: 18.4, diameter_km: 0 }]) {
      expect(craterView(bad, zones, 888, 740, FOV)).toBeNull();
    }
  });

});

describe("photoAlpha: the grey photo maps show only from near", () => {
  it("shows them fully at every crater and zone view", () => {
    for (const km of [0.03, 2, 12, 62, 108, 120, PHOTO_FULL_KM]) expect(photoAlpha(km)).toBe(1);
  });

  it("hides them on the whole planet, where they would be a small grey square", () => {
    for (const km of [PHOTO_GONE_KM, 1000, 9000, 220_000]) expect(photoAlpha(km)).toBe(0);
  });

  it("fades in steadily while the camera comes down", () => {
    let last = 0;
    for (let km = PHOTO_GONE_KM; km >= PHOTO_FULL_KM; km -= 10) {
      const a = photoAlpha(km);
      expect(a).toBeGreaterThanOrEqual(last);
      expect(a - last).toBeLessThanOrEqual(0.05); // no jump
      last = a;
    }
    expect(photoAlpha((PHOTO_FULL_KM + PHOTO_GONE_KM) / 2)).toBeCloseTo(0.5, 6);
  });

  it("never hides the maps because of a bad height", () => {
    expect(photoAlpha(Number.NaN)).toBe(1);
    expect(photoAlpha(-5)).toBe(1);
  });
});

describe("photoLayerAlpha: the stack of photo maps", () => {
  it("fades only the lowest map; the sharper maps on top join when it is complete", () => {
    const mid = (PHOTO_FULL_KM + PHOTO_GONE_KM) / 2;
    expect(photoLayerAlpha(mid, 0)).toBeCloseTo(0.5, 6);
    for (const i of [1, 2, 3]) expect(photoLayerAlpha(mid, i)).toBe(0); // no half-drawn maps on each other
  });

  it("shows every map at crater and zone views, and none on the whole planet", () => {
    for (const i of [0, 1, 2, 3]) {
      expect(photoLayerAlpha(108, i)).toBe(1);
      expect(photoLayerAlpha(0.2, i)).toBe(1);
      expect(photoLayerAlpha(9000, i)).toBe(0);
    }
  });

  it("is never partly drawn for the upper maps, at any height", () => {
    for (let km = 0; km < 600; km += 7) for (const i of [1, 2]) expect([0, 1]).toContain(photoLayerAlpha(km, i));
  });
});

describe("namesVisible: official place names show at crater scale only", () => {
  it("shows them in the whole-crater view, also on a tall narrow map (camera up to 108 km)", () => {
    for (const km of [64.5, 80, 110.5]) expect(namesVisible(km * 1000)).toBe(true);
    expect(namesVisible(NAMES_LOW_M)).toBe(true);
    expect(namesVisible(NAMES_HIGH_M)).toBe(true);
  });

  it("hides them inside a walk zone, in the walk-through and in the helmet view", () => {
    for (const m of [1.8, 55, 380, 3000, 7999]) expect(namesVisible(m)).toBe(false);
  });

  it("hides them once the crater has its own marker (120 km) and on the whole planet", () => {
    for (const km of [117.5, 400, 9700]) expect(namesVisible(km * 1000)).toBe(false);
  });

  it("hides them when the height is not a number", () => {
    expect(namesVisible(Number.NaN)).toBe(false);
  });

  it("hides them when the camera is low but far from the crater (a tilted or far-away view)", () => {
    expect(namesVisible(98_000, 150_000)).toBe(false); // tilted 50 degrees and zoomed out: the crater has its own marker
    expect(namesVisible(100_000, 600_000)).toBe(false); // 600 km away: the names would pile up at the horizon
    expect(namesVisible(100_000, NAMES_FAR_M)).toBe(false);
    expect(namesVisible(100_000, NAMES_FAR_M - 1)).toBe(true);
    expect(namesVisible(64_500, 68_000)).toBe(true); // the whole-crater view
  });
});

describe("style.css uses the map sizes of layout.ts", () => {
  it("puts the scale card in the top right corner from NARROW_MAP_W on", () => {
    expect(css).toContain(`@container (min-width: ${NARROW_MAP_W}px) { #scale {`);
  });

  it("shows no scale card on a narrow whole-planet map (the north pole's name and the zones need that place)", () => {
    expect(css).toContain(`@container (width < ${NARROW_MAP_W}px) { body[data-screen="globe"] #scale { display: none; } }`);
  });

  it("keeps the 'drag to turn Mars' hint left of the south pole's name, and lets it span a narrow map", () => {
    expect(css).toMatch(/#globe-hint \{[^}]*left: 14px;[^}]*transform: none;[^}]*max-width: calc\(50% - 70px\);/);
    expect(css).toContain(`@container (width < ${NARROW_MAP_W}px) { #globe-hint { max-width: calc(100% - 28px); } }`);
  });
});

describe("the pole arrows on the whole-planet screen", () => {
  const R = 3_396_190;
  const MAPS: [number, number][] = [[888, 800], [1528, 900], [632, 560], [632, 768], [412, 718], [219, 720], [662, 450], [500, 600], [414, 896], [1024, 768], [1920, 1080], [2560, 1080], [402, 520], [500, 450], [560, 400]];
  const where = (w: number, h: number) => {
    const fill = planetFill(w, h, FOV, R);
    const alt = planetFitAltitude(w, h, FOV, R, fill);
    return {
      fill,
      north: h / 2 - axisPointPx(w, h, FOV, R, alt, POLE_ARROW_TIP), // px from the top: the north name's middle
      south: h / 2 - axisPointPx(w, h, FOV, R, alt, -POLE_ARROW_TIP), // px from the top: the south name's middle
      disc: discRadiusPx(w, h, FOV, R, alt),
    };
  };

  it("keeps both pole names inside the map, the north one below the title on a narrow map", () => {
    for (const [w, h] of MAPS) {
      expect(w / 2 + POLE_LABEL_GAP_PX + POLE_LABEL_W_PX, `${w}x${h} right edge`).toBeLessThanOrEqual(w - 4);
      const p = where(w, h);
      expect(p.north - 12, `${w}x${h} north`).toBeGreaterThanOrEqual(w < POLE_TITLE_W ? 90 - 0.5 : 10 - 0.5);
      expect(h - (p.south + 12), `${w}x${h} south`).toBeGreaterThanOrEqual((w < NARROW_MAP_W ? POLE_HINT_ROOM_PX : 34) - 0.5);
    }
  });

  it("leaves the planet as large as before where there is room", () => {
    for (const [w, h] of [[888, 800], [1528, 900], [1920, 1080], [632, 768], [414, 896]] as [number, number][]) expect(planetFill(w, h, FOV, R), `${w}x${h}`).toBe(0.7);
  });

  it("makes the planet smaller only on a narrow, short map, and only as much as it needs", () => {
    expect(planetFill(662, 450, FOV, R)).toBe(0.7); // wide: the names are right of the title column
    const small = planetFill(402, 520, FOV, R); // narrow and short: the north name must pass under the title
    expect(small).toBeLessThan(0.7);
    expect(small).toBeGreaterThan(0.55);
  });

  it("puts the names right of the title column from POLE_TITLE_W on", () => {
    expect(POLE_TITLE_W / 2 + POLE_LABEL_GAP_PX).toBeGreaterThanOrEqual(258); // the title chip ends at about 254 px
  });

  it("draws the arrows out of the disc", () => {
    const p = where(888, 800);
    expect(800 / 2 - p.north).toBeGreaterThan(p.disc + 20); // the tip (and its name) is well outside the disc
    expect(POLE_ARROW_TIP).toBeGreaterThan(1.1);
  });

  it("puts the north pole above the middle and the south pole below it", () => {
    expect(axisPointPx(888, 800, FOV, R, 7e6, 1)).toBeGreaterThan(0);
    expect(axisPointPx(888, 800, FOV, R, 7e6, -1)).toBeLessThan(0);
  });
});
