// The clock speeds of the walk demo and the replay, and the walk-through's flying speeds.
// The walk and replay clocks count in minutes, so their speed is simulated minutes per real
// second: "×60" (one simulated minute each second) is 1.

/** Simulated minutes per real second for a speed of `times` × real time. */
export const perSecond = (times: number): number => times / 60;

/** The label of a walk or replay speed ("×5", "×60"). */
export const timesLabel = (minutesPerSecond: number): string => `×${Math.round(minutesPerSecond * 60)}`;

/** The speeds the map's control box steps through, as × real time. */
export const WALK_TIMES = [5, 10, 15, 30, 60, 120, 240, 480];
export const REPLAY_TIMES = [5, 10, 30, 60, 120, 240, 480];

/** The speed buttons on the walk tablet and in the replay window (some of the box's speeds). */
export const WALK_BUTTONS = [5, 10, 30, 60, 120];
export const REPLAY_BUTTONS = [5, 10, 30, 60, 120, 240];

/** The walk-through is a flight along the route (45 m per second at 1×), not a clock: its own factors. */
export const PREVIEW_FACTORS = [0.5, 1, 2, 4, 8];

/**
 * One step slower (dir -1) or faster (+1) in `list` from the speed `now`, kept inside the list.
 * A speed that is not in the list steps from the nearest one in it.
 */
export function nextSpeed(list: number[], now: number, dir: number): number {
  if (!list.length) return now;
  let i = list.indexOf(now);
  if (i < 0) {
    // nearest by ratio: ×20 is nearer to ×15 than to ×30
    let best = Infinity;
    list.forEach((v, k) => {
      const d = Math.abs(Math.log(v / now));
      if (d < best) { best = d; i = k; }
    });
    if (i < 0) i = 0;
  }
  return list[Math.max(0, Math.min(list.length - 1, i + Math.sign(dir)))];
}
