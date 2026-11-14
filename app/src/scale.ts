// The map's scale card: a scale bar, plus a drawing of something familiar at the same scale
// (a person, a rover, a spacecraft), so the crew can tell how large the place on screen is.
//
// The drawings are simple silhouettes made for this app. Only their overall size is real:
//   rover    Perseverance: 3 m long, 2.2 m tall
//            https://science.nasa.gov/mission/mars-2020-perseverance/rover-components/ (Tech Specs)
//   orbiter  Mars Reconnaissance Orbiter (it took this map's CTX and HiRISE photos): 13.6 m wide
//            with its solar panels, 6.5 m tall. NASA, MRO Launch Press Kit (Aug 2005), "Quick Facts"
//            https://www.jpl.nasa.gov/news/press_kits/mro-launch.pdf
//   shuttle  Space Shuttle orbiter (the winged part, not the whole Shuttle with its tank):
//            122 feet long (37.2 m), wingspan 78 feet (23.8 m)
//            https://www.nasa.gov/reference/the-space-shuttle/ (Shuttle Basics)
//   station  International Space Station: 109 m end to end, solar arrays 73 m across
//            https://www.nasa.gov/international-space-station/space-station-facts-and-figures/
//   person   a person in a suit, about 1.8 m tall: a round value, not a measurement. The app passes
//            the height from the mission package (assumption A22)
// All checked on 2026-11-14 (extra source S8 in data/sources.registry.json).
//
// The scale is measured at the middle of the map. On a tilted view it changes across the screen,
// so the card says where it holds.

export type ScaleRefId = "person" | "rover" | "orbiter" | "shuttle" | "station";

export interface ScaleRef {
  id: ScaleRefId;
  /** Size of the drawing from left to right and from bottom to top, in metres. */
  widthM: number;
  heightM: number;
  /** The caption under the bar (24 characters at most: the card is small). */
  caption: string;
  /** A shorter name, only for the things a person is drawn beside: "Rover 3 m" + " · person 1.8 m". */
  shortCaption?: string;
  /** One sentence about it, for screen readers. */
  about: string;
  /** Where the size comes from. */
  source: string;
  /** The drawing: SVG shapes in a box of `box[0]` x `box[1]` units that it fills completely. */
  box: [number, number];
  shapes: string;
}

/** A person in a suit: the height the app draws (assumption A22). */
export const PERSON_HEIGHT_M = 1.8;

/** Largest first. */
export const SCALE_REFS: ScaleRef[] = [
  {
    id: "station",
    widthM: 109,
    heightM: 73,
    caption: "Space station: 109 m",
    about: "The International Space Station is 109 m from end to end (NASA).",
    source: "https://www.nasa.gov/international-space-station/space-station-facts-and-figures/",
    box: [1090, 730],
    // seen from above: the long truss, four pairs of solar arrays, the modules across the middle
    shapes:
      `<rect x="0" y="352" width="1090" height="26"/>` +
      [20, 160, 820, 960].map((x) => `<rect x="${x}" y="0" width="110" height="322"/><rect x="${x}" y="408" width="110" height="322"/>`).join("") +
      `<rect x="512" y="150" width="66" height="470" rx="20"/><rect x="430" y="318" width="230" height="94" rx="20"/>` +
      `<rect x="340" y="392" width="46" height="150"/><rect x="704" y="392" width="46" height="150"/>`,
  },
  {
    id: "shuttle",
    widthM: 37.2,
    heightM: 23.8,
    caption: "Shuttle orbiter: 37 m",
    about: "A Space Shuttle orbiter is 37 m long (122 feet), with a wingspan of 24 m (NASA).",
    source: "https://www.nasa.gov/reference/the-space-shuttle/",
    box: [372, 238],
    // seen from above, nose to the right: body and double-delta wings
    shapes:
      `<path d="M372 119 C356 100 328 93 296 92 L214 88 L96 10 L62 0 L40 0 L32 88 L0 94 L0 144 L32 150 L40 238 L62 238 L96 228 L214 150 L296 146 C328 145 356 138 372 119 Z"/>`,
  },
  {
    id: "orbiter",
    widthM: 13.6,
    heightM: 6.5,
    caption: "MRO orbiter: 13.6 m",
    about: "The Mars Reconnaissance Orbiter, which took this map's photos, is 13.6 m wide with its solar panels (NASA).",
    source: "https://www.jpl.nasa.gov/news/press_kits/mro-launch.pdf",
    box: [136, 65],
    // the dish on top, the body, and one solar panel on each side
    shapes:
      `<circle cx="68" cy="15" r="15"/><rect x="56" y="27" width="24" height="38" rx="3"/>` +
      `<rect x="0" y="33" width="53.5" height="25.3"/><rect x="82.5" y="33" width="53.5" height="25.3"/>` +
      `<rect x="52" y="43" width="32" height="5"/>`,
  },
  {
    id: "rover",
    widthM: 3,
    heightM: 2.2,
    caption: "Mars rover: 3 m",
    shortCaption: "Rover 3 m",
    about: "The Perseverance rover is 3 m long and 2.2 m tall (NASA).",
    source: "https://science.nasa.gov/mission/mars-2020-perseverance/rover-components/",
    box: [150, 110],
    // seen from the side: three wheels, the body, the camera mast and the folded arm
    shapes:
      `<circle cx="24" cy="97" r="13"/><circle cx="72" cy="97" r="13"/><circle cx="118" cy="97" r="13"/>` +
      `<rect x="20" y="52" width="104" height="24" rx="4"/>` +
      `<path d="M24 97 L46 74 L52 78 L30 100 Z M72 97 L52 74 L58 72 L78 94 Z M118 97 L96 74 L102 72 L122 94 Z"/>` +
      `<rect x="4" y="36" width="22" height="17" rx="4" transform="rotate(-18 15 45)"/>` +
      `<rect x="100" y="10" width="6" height="44"/><rect x="92" y="0" width="24" height="13" rx="3"/>` +
      `<path d="M122 58 L142 44 L150 50 L150 66 L143 66 L143 54 L126 66 Z"/>`,
  },
  {
    id: "person",
    widthM: 0.75,
    heightM: PERSON_HEIGHT_M,
    caption: "Person in a suit: 1.8 m",
    about: "A person in a suit is about 1.8 m tall (a round value, not a measurement).",
    source: "assumption A22",
    box: [30, 72],
    // seen from the front: helmet, body with the life-support pack, arms and legs
    shapes:
      `<circle cx="15" cy="8" r="8"/><rect x="6" y="15" width="18" height="29" rx="4"/>` +
      `<rect x="0" y="17" width="6.5" height="25" rx="3"/><rect x="23.5" y="17" width="6.5" height="25" rx="3"/>` +
      `<rect x="6.5" y="41" width="7.5" height="31" rx="2.5"/><rect x="16" y="41" width="7.5" height="31" rx="2.5"/>`,
  },
];

/** The drawing area of the card and the smallest drawing worth showing (CSS pixels). */
export const FIG_W = 144;
export const FIG_H = 56;
export const MIN_PX = 12;
/** The longest bar. With the gap and the widest label ("5,000 km") the bar row is still narrower than the card. */
export const BAR_MAX = 76;
/**
 * The card has a memory, so that it does not flip back and forth when the scale moves around a
 * step (the walk-through looks along the ground, where the scale changes all the time):
 * a drawing that is shown stays down to KEEP_PX, a bar stays down to KEEP_BAR of BAR_MAX, and a
 * larger drawing takes over only when it fits with room to spare (SPARE of the drawing area).
 */
const KEEP_PX = 10;
const KEEP_BAR = 0.3;
const SPARE = 0.85;
const GAP = 10;

const ref = (id: ScaleRefId) => SCALE_REFS.find((r) => r.id === id)!;

/** "1.8 m": the person's height as the card writes it. */
const tallText = (m: number) => `${Number(m.toFixed(1))} m`;

/** The person at another height (the mission package's A22), with the texts that name that height. */
function personRef(heightM: number): ScaleRef {
  const base = ref("person");
  const m = Number.isFinite(heightM) && heightM >= 1 && heightM <= 2.5 ? heightM : PERSON_HEIGHT_M;
  const text = tallText(m);
  return {
    ...base,
    heightM: m,
    widthM: (base.widthM / base.heightM) * m,
    caption: `Person in a suit: ${text}`,
    shortCaption: `person ${text}`,
    about: `A person in a suit is about ${text} tall (a round value, not a measurement).`,
  };
}

/** The longest "round" length (1, 2 or 5 times a power of ten) that is not longer than `maxM` metres. */
export function niceLength(maxM: number): number {
  if (!(maxM > 0) || !Number.isFinite(maxM)) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(maxM)));
  const lead = maxM / pow; // 1 <= lead < 10
  const step = lead >= 5 ? 5 : lead >= 2 ? 2 : 1;
  return Number((step * pow).toPrecision(1));
}

/** "50 cm", "20 m", "5 km", "2,000 km". */
export function lengthText(m: number): string {
  if (m < 1) return `${Math.round(m * 100)} cm`;
  if (m < 1000) return `${m} m`;
  return `${(m / 1000).toLocaleString("en-US")} km`;
}

/** A count for a sentence: two leading digits ("92", "460", "18,000"). */
export function roundCount(n: number): string {
  if (n < 100) return String(Math.round(n));
  const pow = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return (Math.round(n / pow) * pow).toLocaleString("en-US");
}

export interface DrawnRef {
  ref: ScaleRef;
  /** Size on screen in CSS pixels. */
  w: number;
  h: number;
  /** A person who is too tall for the card is drawn lying along the bar. */
  lying: boolean;
}

export interface ScaleCard {
  /** Metres per CSS pixel this card was made for. */
  mpp: number;
  barM: number;
  barPx: number;
  barText: string;
  /** "drawn": drawings at the map's scale. "count": the view is too wide for any drawing, so the
   *  card says how many space stations fit in the bar. "bar": too close for any drawing. */
  mode: "drawn" | "count" | "bar";
  drawn: DrawnRef[];
  /** In "count" mode: how many space stations fit in the bar. */
  count: number;
  caption: string;
  /** The full explanation, for screen readers. */
  about: string;
}

export interface ScaleOptions {
  /** Height of the person in metres: assumption A22 of the mission package. */
  personM?: number;
  /** The card that is on screen now: its bar and its drawing stay while they still fit. */
  prev?: ScaleCard | null;
}

const WHERE = "The scale holds at the middle of the map.";

function fits(r: ScaleRef, mpp: number, minPx = MIN_PX): DrawnRef | null {
  const w = r.widthM / mpp;
  const h = r.heightM / mpp;
  if (w > FIG_W || h > FIG_H || Math.max(w, h) < minPx) return null;
  return { ref: r, w, h, lying: false };
}

/**
 * What the scale card shows for a map scale of `mpp` metres per CSS pixel.
 * Returns null when there is no usable scale (the view shows no ground).
 */
export function scaleCard(mpp: number, options: ScaleOptions = {}): ScaleCard | null {
  if (!(mpp > 0) || !Number.isFinite(mpp)) return null;
  const prev = options.prev ?? null;
  const person = personRef(options.personM ?? PERSON_HEIGHT_M);
  const refs = SCALE_REFS.map((r) => (r.id === "person" ? person : r)); // largest first
  const station = refs.find((r) => r.id === "station")!;

  // The bar: a round length. The one on screen stays while it still fits its slot.
  let barM = niceLength(BAR_MAX * mpp);
  if (prev && prev.barM / mpp <= BAR_MAX && prev.barM / mpp >= BAR_MAX * KEEP_BAR) barM = prev.barM;
  const base = { mpp, barM, barPx: barM / mpp, barText: lengthText(barM) };

  const shown = prev?.mode === "drawn" ? prev.drawn : [];
  const wasShown = (id: ScaleRefId, lying = false) => shown.some((d) => d.ref.id === id && d.lying === lying);
  const fit = (r: ScaleRef) => fits(r, mpp, wasShown(r.id) ? KEEP_PX : MIN_PX);

  // The largest thing that fits the card and is still large enough to recognise ...
  let main = refs.map(fit).find((d) => d !== null) ?? null;
  // ... but the drawing on screen stays until it no longer fits, or a larger one fits with room to spare.
  const first = shown[0];
  const kept = first && !first.lying ? fit(refs.find((r) => r.id === first.ref.id)!) : null;
  const tight = (d: DrawnRef) => d.w > SPARE * FIG_W || d.h > SPARE * FIG_H;
  if (kept && main && main.ref.id !== kept.ref.id && refs.indexOf(main.ref) < refs.indexOf(kept.ref) && tight(main)) main = kept;
  // A person who was drawn lying down stands up again only when there is room to spare.
  if (main && main.ref.id === "person" && wasShown("person", true) && tight(main)) main = null;

  if (main) {
    const drawn = [main];
    let caption = main.ref.caption;
    let about = main.ref.about;
    // A person beside it, while the person is large enough to see. Only next to the things whose
    // caption has room to name the person too: the card never shows a drawing without its name.
    const p = main.ref.id !== "person" && main.ref.shortCaption ? fit(person) : null;
    if (p && main.w + GAP + p.w <= FIG_W) {
      drawn.push(p);
      caption = `${main.ref.shortCaption} · ${person.shortCaption}`;
      about += ` ${person.about}`;
    }
    return { ...base, mode: "drawn", drawn, count: 0, caption, about: `Drawn to scale. ${about} ${WHERE}` };
  }

  // too close for a standing person: draw the person lying along the bar
  const lyingW = person.heightM / mpp;
  const lyingH = person.widthM / mpp;
  if (person.heightM / mpp > SPARE * FIG_H) {
    if (lyingW <= FIG_W && lyingH <= FIG_H) {
      return {
        ...base, mode: "drawn", drawn: [{ ref: person, w: lyingW, h: lyingH, lying: true }], count: 0,
        caption: person.caption, about: `Drawn to scale, lying down. ${person.about} ${WHERE}`,
      };
    }
    return { ...base, mode: "bar", drawn: [], count: 0, caption: `A person: about ${tallText(person.heightM)}`, about: `${person.about} ${WHERE}` };
  }

  // too far for any drawing: how many space stations fit in the bar
  const count = barM / station.widthM;
  return {
    ...base, mode: "count", drawn: [], count,
    caption: `≈ ${roundCount(count)} space stations`,
    about: `This bar is about as long as ${roundCount(count)} International Space Stations in a row (109 m each, NASA). ${WHERE}`,
  };
}

const px = (v: number) => (Math.round(v * 2) / 2).toString(); // half pixels: steady while zooming

function figure(d: DrawnRef, extraClass = ""): string {
  const [bw, bh] = d.ref.box;
  // a lying person: the same drawing turned a quarter turn, head to the left
  const view = d.lying ? `0 0 ${bh} ${bw}` : `0 0 ${bw} ${bh}`;
  const body = d.lying ? `<g transform="rotate(-90) translate(${-bw} 0)">${d.ref.shapes}</g>` : d.ref.shapes;
  return `<svg class="sc-ref${extraClass}" data-key="${d.ref.id}${d.lying ? "-lying" : ""}" viewBox="${view}" width="${px(d.w)}" height="${px(d.h)}" preserveAspectRatio="none" aria-hidden="true">${body}</svg>`;
}

/** The card's HTML (three rows of fixed height: drawings, bar, caption). */
export function scaleHtml(card: ScaleCard): string {
  const station = ref("station");
  const figures = card.mode === "count"
    // not to scale: a small picture of the station and how many of them fit in the bar
    ? `${figure({ ref: station, w: 54, h: (54 * station.heightM) / station.widthM, lying: false }, " dim")}<span class="sc-times">× ${roundCount(card.count)}</span>`
    : card.drawn.map((d) => figure(d)).join("");
  return `<div class="sc-fig" data-mode="${card.mode}">${figures}</div>` +
    `<div class="sc-bar"><span class="sc-line" style="width:${px(card.barPx)}px"></span><b>${card.barText}</b></div>` +
    `<div class="sc-cap">${card.caption}</div>`;
}
