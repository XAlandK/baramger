import { describe, expect, it } from "vitest";
import { mins } from "../src/format";

describe("mins", () => {
  it("rounds the total first, so it never shows 60 minutes", () => {
    expect(mins(359.6)).toBe("6 h 00 min");
    expect(mins(59.6)).toBe("1 h 00 min");
    expect(mins(119.5)).toBe("2 h 00 min");
  });

  it("formats hours and minutes", () => {
    expect(mins(125)).toBe("2 h 05 min");
    expect(mins(221.2)).toBe("3 h 41 min");
    expect(mins(45.4)).toBe("45 min");
    expect(mins(0)).toBe("0 min");
  });
});
