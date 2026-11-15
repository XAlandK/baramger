import { describe, expect, it } from "vitest";
import { COLOUR_MIN_SAT, GROUND_FROM, SKY_HORIZON, SKY_TOP, groundMean, isMastcamColour, isNavcam, pickGroundColour, saturation, toHex } from "../src/groundcolour";

/** RGBA pixels: the top part one colour (sky or rover), the bottom part (from GROUND_FROM) another. */
function photo(w: number, h: number, top: number[], ground: number[], dark = 0): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = y < Math.floor(h * GROUND_FROM) ? top : x < dark ? [0, 0, 0] : ground;
      d.set([...c, 255], i);
    }
  }
  return d;
}

describe("groundMean", () => {
  it("measures only the lower part of the photo (the ground in front of the rover)", () => {
    const m = groundMean(photo(20, 20, [40, 60, 200], [160, 140, 100]), 20, 20)!;
    expect([m.r, m.g, m.b].map(Math.round)).toEqual([160, 140, 100]);
  });
  it("leaves out deep shadows and glare", () => {
    const m = groundMean(photo(20, 20, [0, 0, 0], [160, 140, 100], 8), 20, 20)!; // 8 black columns: shadow
    expect([m.r, m.g, m.b].map(Math.round)).toEqual([160, 140, 100]);
    expect(groundMean(photo(4, 4, [0, 0, 0], [255, 255, 255]), 4, 4)).toBeNull(); // only glare
  });
});

describe("pickGroundColour", () => {
  const tan = { r: 174, g: 150, b: 120 };
  const khaki = { r: 128, g: 118, b: 81 };
  const grey = { r: 150, g: 150, b: 150 };
  it("uses Mastcam-Z colour photos when the zone has any", () => {
    const g = pickGroundColour([
      { imageId: "ZL0_0670_x", instrument: "MCZ_LEFT", mean: tan },
      { imageId: "NLF_0652_x", instrument: "NAVCAM_LEFT", mean: khaki },
    ])!;
    expect(g.camera).toBe("Mastcam-Z");
    expect(g.hex).toBe("#ae9678");
    expect(g.from).toEqual(["ZL0_0670_x"]);
  });
  it("else the mean of the colour Navcam photos, without black-and-white ones and other cameras", () => {
    const g = pickGroundColour([
      { imageId: "NLF_1", instrument: "NAVCAM_LEFT", mean: khaki },
      { imageId: "NLF_2", instrument: "NAVCAM_LEFT", mean: { r: 130, g: 120, b: 83 } },
      { imageId: "NLG_3", instrument: "NAVCAM_LEFT", mean: grey }, // black-and-white
      { imageId: "ZL7_4", instrument: "MCZ_LEFT", mean: tan }, // Mastcam-Z, but a narrow filter: not a colour photo
      { imageId: "LRF_5", instrument: "SUPERCAM_RMI", mean: tan }, // a close-up camera
      { imageId: "NLF_6", instrument: "NAVCAM_LEFT", mean: null }, // could not be read
    ])!;
    expect(g.camera).toBe("Navcam");
    expect(g.from).toEqual(["NLF_1", "NLF_2"]);
    expect(g.hex).toBe("#817752");
  });
  it("is null when the zone has no colour photo of the ground", () => {
    expect(pickGroundColour([])).toBeNull();
    expect(pickGroundColour([{ imageId: "NLG_1", instrument: "NAVCAM_LEFT", mean: grey }])).toBeNull();
  });
});

describe("colour helpers", () => {
  it("saturation, hex and camera names", () => {
    expect(saturation({ r: 150, g: 150, b: 150 })).toBe(0);
    expect(saturation({ r: 128, g: 118, b: 81 })).toBeGreaterThan(COLOUR_MIN_SAT);
    expect(toHex({ r: 174.4, g: 149.6, b: 300 })).toBe("#ae96ff");
    expect(isMastcamColour("ZR0_1")).toBe(true);
    expect(isMastcamColour("ZL7_1")).toBe(false);
    expect(isNavcam("NAVCAM_RIGHT")).toBe(true);
    expect(isNavcam("MCZ_LEFT")).toBe(false);
  });
  it("the drawn sky is a dusty butterscotch, lighter at the horizon", () => {
    const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, v, k) => a + v * [0.2126, 0.7152, 0.0722][k], 0);
    expect(lum(SKY_HORIZON)).toBeGreaterThan(lum(SKY_TOP));
  });
});
