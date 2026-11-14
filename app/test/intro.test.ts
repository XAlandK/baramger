// @vitest-environment jsdom
// The launch animation (telescope on Earth -> flight to Mars) talks to the app through four
// hooks. These tests drive the animation by hand (step) and check the order of the scenes and
// that every hook is called when it must be, also when the crew presses "Skip intro".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playIntro, type IntroControl } from "../src/intro";

interface Run {
  root: HTMLElement;
  control: IntroControl;
  zooms: number[];
  filters: string[];
  arrive: ReturnType<typeof vi.fn>;
  done: ReturnType<typeof vi.fn>;
  mapReady: () => Promise<void>;
  stepFor: (seconds: number) => void;
}

function start(): Run {
  const root = document.createElement("div");
  root.hidden = true;
  document.body.appendChild(root);
  let resolve!: () => void;
  const ready = new Promise<void>((r) => (resolve = r));
  const zooms: number[] = [];
  const filters: string[] = [];
  const arrive = vi.fn();
  const done = vi.fn();
  const control = playIntro(root, {
    ready,
    facts: { distanceMkm: 197.4, lightMin: 10.97 },
    setZoom: (k) => zooms.push(k),
    setMapFilter: (css) => filters.push(css),
    arrive,
    done,
  });
  return {
    root, control, zooms, filters, arrive, done,
    mapReady: async () => {
      resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    stepFor: (seconds) => {
      for (let t = 0; t < seconds; t += 0.05) control.step(0.05);
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  // the tests move the clock themselves; jsdom has no canvas
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});

describe("launch animation: the scenes", () => {
  it("opens on the night sky with the real distance and light time", () => {
    const run = start();
    expect(run.root.hidden).toBe(false);
    expect(run.control.phase()).toBe("sky");
    const text = run.root.textContent ?? "";
    expect(text).toContain("From Earth to Mars");
    expect(text).toContain("197 million km");
    expect(text).toContain("11 minutes");
    expect(text).toContain("drawing"); // the first picture is an illustration, and says so
    expect(run.root.querySelector(".skip")).not.toBeNull();
  });

  it("waits on the first scene until the map is ready", async () => {
    const run = start();
    run.stepFor(10);
    expect(run.control.phase()).toBe("sky");
    expect(run.zooms).toEqual([]);
    await run.mapReady();
    expect(run.zooms).toEqual([0]); // Mars is put far away before the eyepiece opens
    run.control.step(0.05);
    expect(run.control.phase()).toBe("fade");
  });

  it("goes sky -> eyepiece -> flight -> the app, and calls each hook once", async () => {
    const run = start();
    await run.mapReady();
    const seen: string[] = [];
    for (let i = 0; i < 400 && run.control.phase() !== "done"; i++) {
      run.control.step(0.05);
      if (seen[seen.length - 1] !== run.control.phase()) seen.push(run.control.phase());
    }
    expect(seen).toEqual(["sky", "fade", "fly", "out", "done"]);
    expect(run.arrive).toHaveBeenCalledTimes(1);
    expect(run.done).toHaveBeenCalledTimes(1);
    expect(run.arrive.mock.invocationCallOrder[0]).toBeLessThan(run.done.mock.invocationCallOrder[0]);
    expect(run.root.hidden).toBe(true);
    expect(run.root.innerHTML).toBe("");
    expect(run.filters[run.filters.length - 1]).toBe(""); // the map is shown untouched at the end
  });

  it("flies in smoothly: the zoom only grows, from 0 to exactly 1", async () => {
    const run = start();
    await run.mapReady();
    run.stepFor(20);
    expect(run.zooms[0]).toBe(0);
    expect(Math.max(...run.zooms)).toBe(1);
    for (let i = 1; i < run.zooms.length; i++) {
      expect(run.zooms[i]).toBeGreaterThanOrEqual(run.zooms[i - 1]);
      expect(run.zooms[i] - run.zooms[i - 1]).toBeLessThan(0.05); // no jump in the flight
    }
  });

  it("does nothing more once it has ended", async () => {
    const run = start();
    await run.mapReady();
    run.stepFor(20);
    const calls = run.zooms.length;
    run.stepFor(5);
    run.control.skip();
    expect(run.zooms.length).toBe(calls);
    expect(run.done).toHaveBeenCalledTimes(1);
  });
});

describe("launch animation: Skip intro", () => {
  it("ends at once when the map is ready", async () => {
    const run = start();
    await run.mapReady();
    run.stepFor(5); // somewhere in the flight
    expect(run.control.phase()).toBe("fly");
    (run.root.querySelector(".skip") as HTMLButtonElement).click();
    expect(run.control.phase()).toBe("done");
    expect(run.done).toHaveBeenCalledTimes(1);
    expect(run.filters[run.filters.length - 1]).toBe("");
    expect(run.root.hidden).toBe(true);
  });

  it("waits for the map when it is pressed too early, then ends", async () => {
    const run = start();
    const button = run.root.querySelector(".skip") as HTMLButtonElement;
    button.click();
    expect(run.done).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Loading");
    run.stepFor(6);
    expect(run.done).not.toHaveBeenCalled();
    await run.mapReady();
    expect(run.done).toHaveBeenCalledTimes(1);
    expect(run.control.phase()).toBe("done");
  });

  it("can be pressed twice without ending twice", async () => {
    const run = start();
    await run.mapReady();
    run.control.skip();
    run.control.skip();
    expect(run.done).toHaveBeenCalledTimes(1);
  });
});
