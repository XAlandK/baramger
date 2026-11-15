import { describe, expect, it } from "vitest";
import { PREVIEW_FACTORS, REPLAY_BUTTONS, REPLAY_TIMES, WALK_BUTTONS, WALK_TIMES, nextSpeed, perSecond, timesLabel } from "../src/speeds";

describe("walk and replay speeds", () => {
  it("start at ×5 and ×10 (the crew asked for slower speeds than ×30)", () => {
    expect(WALK_TIMES.slice(0, 2)).toEqual([5, 10]);
    expect(REPLAY_TIMES.slice(0, 2)).toEqual([5, 10]);
    expect(WALK_BUTTONS.slice(0, 2)).toEqual([5, 10]);
    expect(REPLAY_BUTTONS.slice(0, 2)).toEqual([5, 10]);
  });

  it("are sorted, and every button is a speed the control box can step to", () => {
    for (const list of [WALK_TIMES, REPLAY_TIMES, WALK_BUTTONS, REPLAY_BUTTONS, PREVIEW_FACTORS]) expect([...list].sort((a, b) => a - b)).toEqual(list);
    for (const x of WALK_BUTTONS) expect(WALK_TIMES).toContain(x);
    for (const x of REPLAY_BUTTONS) expect(REPLAY_TIMES).toContain(x);
  });

  it("count in simulated minutes per real second: ×60 is 1, ×5 is one minute every 12 s", () => {
    expect(perSecond(60)).toBe(1);
    expect(perSecond(5) * 12).toBeCloseTo(1, 12);
    expect(timesLabel(perSecond(5))).toBe("×5");
    expect(timesLabel(perSecond(10))).toBe("×10");
    expect(timesLabel(2)).toBe("×120");
    // the walk's and the replay's first speeds (1 and 2) are buttons
    expect(WALK_BUTTONS.map(perSecond)).toContain(1);
    expect(REPLAY_BUTTONS.map(perSecond)).toContain(2);
  });
});

describe("nextSpeed", () => {
  const walk = WALK_TIMES.map(perSecond);
  it("steps one speed slower or faster and stays inside the list", () => {
    expect(nextSpeed(walk, perSecond(10), -1)).toBe(perSecond(5));
    expect(nextSpeed(walk, perSecond(5), -1)).toBe(perSecond(5));
    expect(nextSpeed(walk, perSecond(30), 1)).toBe(perSecond(60));
    expect(nextSpeed(walk, perSecond(480), 1)).toBe(perSecond(480));
  });
  it("steps from the nearest speed when the speed now is not in the list", () => {
    expect(nextSpeed(WALK_TIMES, 20, 0)).toBe(15); // ×20 is nearer to ×15 than to ×30
    expect(nextSpeed(WALK_TIMES, 20, 1)).toBe(30);
    expect(nextSpeed(WALK_TIMES, 1000, -1)).toBe(240);
    expect(nextSpeed(WALK_TIMES, 0, 1)).toBe(10); // a stopped clock steps from the slowest
    expect(nextSpeed([], 3, 1)).toBe(3);
  });
});
