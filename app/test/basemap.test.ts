import { describe, expect, it } from "vitest";
import { BASE_STYLES, BASE_TEXT, DEFAULT_BASE, baseStyleOf, startBaseStyle } from "../src/basemap";

describe("base map looks: height colours or natural colour", () => {
  it("sorts the package's tile layers into the two looks", () => {
    expect(baseStyleOf("tiles-mola")).toBe("heights");
    expect(baseStyleOf("tiles-mola-region")).toBe("heights");
    expect(baseStyleOf("tiles-viking")).toBe("colour");
    expect(baseStyleOf("tiles-viking-region")).toBe("colour");
  });

  it("leaves the photo maps and overlays out: they are drawn on top of either look", () => {
    for (const id of ["tiles-ctx", "tiles-ctx-crater", "tiles-hirise", "tiles-themis-night", "slope-2m", "geology-sim3464", "tiles-molasses"]) {
      expect(baseStyleOf(id)).toBeNull();
    }
  });

  it("starts with the current look (height colours) when nothing was chosen", () => {
    expect(DEFAULT_BASE).toBe("heights");
    expect(startBaseStyle(null, ["heights", "colour"])).toBe("heights");
  });

  it("starts with the look the crew chose last time", () => {
    expect(startBaseStyle("colour", ["heights", "colour"])).toBe("colour");
    expect(startBaseStyle("heights", ["heights", "colour"])).toBe("heights");
  });

  it("ignores a saved choice the package does not have, or a broken one", () => {
    expect(startBaseStyle("colour", ["heights"])).toBe("heights"); // an older package: height colours only
    expect(startBaseStyle("rainbow", ["heights", "colour"])).toBe("heights");
    expect(startBaseStyle("", ["heights", "colour"])).toBe("heights");
  });

  it("falls back to what the package has", () => {
    expect(startBaseStyle(null, ["colour"])).toBe("colour");
    expect(startBaseStyle(null, [])).toBe(DEFAULT_BASE);
  });

  it("has a label and a plain note for each look, and the notes say what the colours mean", () => {
    for (const s of BASE_STYLES) {
      expect(BASE_TEXT[s].label.length).toBeGreaterThan(3);
      expect(BASE_TEXT[s].note.length).toBeGreaterThan(20);
    }
    expect(BASE_TEXT.heights.note).toContain("not water");
    expect(BASE_TEXT.colour.note).toContain("Viking");
    // the Viking mosaic is a colourised product: the app must not promise exact colours
    expect(BASE_TEXT.colour.note).toContain("approximate");
    expect(`${BASE_TEXT.colour.label} ${BASE_TEXT.colour.note}`.toLowerCase()).not.toContain("true colour");
  });
});
