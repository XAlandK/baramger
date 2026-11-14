// Small text formatters shared by the app screens.

/** Minutes as "45 min" or "5 h 07 min". Rounds the total first, so 359.6 min is "6 h 00 min", never "5 h 60 min". */
export function mins(m: number): string {
  const t = Math.round(m);
  return t >= 60 ? `${Math.floor(t / 60)} h ${String(t % 60).padStart(2, "0")} min` : `${t} min`;
}
