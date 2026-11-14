// Launch animation: a telescope on Earth finds Mars, then the view flies to the planet.
//
//   Scene 1  Night on Earth: a telescope, and Mars as a small orange dot. Plain HTML/SVG/canvas,
//            so it can play while the mission package and the 3D map are still loading.
//   Scene 2  The eyepiece: the app's own 3D Mars seen from very far away, small and soft.
//   Scene 3  The flight: the camera moves in while the eyepiece opens, until Mars fills the view.
//
// Mars is drawn by the app's CesiumJS map (real NASA map data), not by a second 3D engine, so
// the animation ends exactly on the globe the crew then moves around freely. Earth is only a
// drawn silhouette: no Earth data is used. The warm tint and the blur in the eyepiece are a
// display effect that fades out during the flight; the map at the end is the untouched layer.

export interface IntroHooks {
  /** Resolves when the 3D map can be shown. */
  ready: Promise<void>;
  /** Real numbers for the first scene (computed from JPL planet positions). */
  facts: { distanceMkm: number; lightMin: number };
  /** Camera straight above the walk zones: 0 = far away (Mars is a small disc), 1 = Mars fills the map. */
  setZoom(k: number): void;
  /** CSS filter for the map while it is seen through the eyepiece ("" = none). */
  setMapFilter(css: string): void;
  /** Mars fills the view: the app's own panel can come in while the animation fades out. */
  arrive(): void;
  /** Called once, when the animation has ended or was skipped. */
  done(): void;
}

export interface IntroControl {
  skip(): void;
  /** Advance by dt seconds. The animation calls this itself; tests can call it by hand. */
  step(dt: number): void;
  phase(): string;
}

const T_SKY = 3.4;
const T_FADE = 1.2;
const T_FLY = 4.8;
const T_OUT = 0.7;

type Phase = "sky" | "fade" | "fly" | "out" | "done";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** Small seeded random generator, so the star field is the same every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawStars(canvas: HTMLCanvasElement): void {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const k = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(k, k);
  const rnd = seeded(7);
  for (let i = 0; i < 190; i++) {
    const x = rnd() * w;
    const y = Math.pow(rnd(), 1.4) * h * 0.82; // more stars high in the sky
    const r = 0.4 + rnd() * 1.1;
    g.globalAlpha = 0.35 + rnd() * 0.65;
    g.fillStyle = rnd() < 0.12 ? "#cfe0ff" : "#ffffff";
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

function mapFilter(k: number): string {
  if (k >= 1) return "";
  const u = 1 - k;
  return `blur(${(1.3 * u).toFixed(2)}px) sepia(${(0.75 * u).toFixed(2)}) saturate(${(1 + 0.7 * u).toFixed(2)}) brightness(${(1 + 0.15 * u).toFixed(2)})`;
}

export function playIntro(root: HTMLElement, hooks: IntroHooks): IntroControl {
  const km = Math.round(hooks.facts.distanceMkm);
  const light = Math.round(hooks.facts.lightMin);
  root.hidden = false;
  root.style.opacity = "1";
  root.innerHTML = `
    <div class="sky" role="img" aria-label="Night on Earth: a telescope points at Mars, a small orange dot in the sky">
      <div class="scene play">
      <canvas class="stars"></canvas>
      <span class="mars-dot"></span><span class="mars-tag">MARS</span>
      <svg class="ground" viewBox="0 0 1000 460" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <path d="M0 322 C 150 286, 300 318, 450 298 S 760 268, 1000 306 L1000 460 L0 460 Z" fill="#0a1826"/>
        <path d="M0 384 C 200 352, 380 402, 560 374 S 860 352, 1000 388 L1000 460 L0 460 Z" fill="#04090f"/>
        <g stroke="#1d3144" stroke-width="2" fill="#02060a" stroke-linejoin="round">
          <path d="M318 336 L292 398 M318 336 L320 402 M318 336 L346 398" fill="none" stroke="#0c1a26" stroke-width="5" stroke-linecap="round"/>
          <circle class="pivot" cx="318" cy="334" r="9"/>
          <g class="tube" transform="translate(318 330) rotate(-37)">
            <rect x="-64" y="-12" width="150" height="24" rx="5"/>
            <rect x="82" y="-16" width="24" height="32" rx="4"/>
            <rect x="-82" y="-7" width="20" height="14" rx="3"/>
          </g>
        </g>
      </svg>
      </div>
      <div class="intro-text">
        <p class="eyebrow">Baramger</p>
        <h1>From Earth to Mars</h1>
        <p>Tonight Mars is ${km} million km away. Its light needs ${light} minutes to reach this telescope.</p>
      </div>
      <p class="intro-note">This first picture is a drawing. The Mars you fly to is NASA map data.</p>
    </div>
    <div class="scope" hidden></div>
    <p class="scope-text" hidden></p>
    <button type="button" class="skip">Skip intro</button>`;

  const sky = root.querySelector(".sky") as HTMLElement;
  const scope = root.querySelector(".scope") as HTMLElement;
  const caption = root.querySelector(".scope-text") as HTMLElement;
  const skipBtn = root.querySelector(".skip") as HTMLButtonElement;
  const stars = root.querySelector("canvas.stars") as HTMLCanvasElement;
  drawStars(stars);
  /** Turn the telescope so that it points at the Mars dot, whatever the window's shape. */
  const aim = () => {
    const dot = root.querySelector(".mars-dot");
    const pivot = root.querySelector(".pivot");
    const tube = root.querySelector(".tube");
    if (!dot || !pivot || !tube) return;
    const d = dot.getBoundingClientRect();
    const p = pivot.getBoundingClientRect();
    const deg = (Math.atan2(d.top + d.height / 2 - (p.top + p.height / 2), d.left + d.width / 2 - (p.left + p.width / 2)) * 180) / Math.PI;
    tube.setAttribute("transform", `translate(318 330) rotate(${deg.toFixed(1)})`);
  };
  aim();
  const onResize = () => {
    drawStars(stars);
    aim();
  };
  window.addEventListener("resize", onResize);

  let phase: Phase = "sky";
  let phaseT = 0;
  let mapIsReady = false;
  let skipWanted = false;
  let raf = 0;

  const finish = () => {
    if (phase === "done") return;
    phase = "done";
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    root.hidden = true;
    root.innerHTML = "";
    root.style.opacity = "";
    hooks.setMapFilter("");
    hooks.done();
  };

  const go = (p: Phase) => {
    phase = p;
    phaseT = 0;
  };

  /** Radius of the eyepiece opening: small at first, then it opens past the screen corners. */
  const setRadius = (k: number) => {
    const small = Math.min(window.innerWidth, window.innerHeight) * 0.21;
    const big = Math.hypot(window.innerWidth, window.innerHeight) * 0.75;
    scope.style.setProperty("--r", `${(small + (big - small) * k * k).toFixed(1)}px`);
  };

  const step = (dt: number) => {
    if (phase === "done") return;
    phaseT += dt;
    if (phase === "sky") {
      // the sky scene is a CSS animation; wait for it and for the map
      if (phaseT >= T_SKY && mapIsReady) {
        scope.hidden = false;
        caption.hidden = false;
        caption.textContent = `THROUGH THE TELESCOPE · MARS, ${km} MILLION KM AWAY`;
        setRadius(0);
        go("fade");
      }
    } else if (phase === "fade") {
      const k = clamp01(phaseT / T_FADE);
      sky.style.opacity = String(1 - k);
      if (k >= 1) {
        sky.hidden = true;
        go("fly");
      }
    } else if (phase === "fly") {
      const k = clamp01(phaseT / T_FLY);
      const e = easeInOut(k);
      hooks.setZoom(e); // even steps in "zoom", not in metres
      hooks.setMapFilter(mapFilter(e));
      setRadius(e);
      scope.style.setProperty("--reticle", (0.28 * (1 - e)).toFixed(3));
      caption.textContent = k < 0.25 ? `THROUGH THE TELESCOPE · MARS, ${km} MILLION KM AWAY` : "FLYING TO MARS";
      caption.style.opacity = String(clamp01((1 - k) * 4));
      if (k >= 1) {
        go("out");
        hooks.arrive();
      }
    } else if (phase === "out") {
      const k = clamp01(phaseT / T_OUT);
      root.style.opacity = String(1 - k);
      hooks.setZoom(1); // the map area gets smaller while the panel slides in: keep Mars fitted
      if (k >= 1) finish();
    }
  };

  void hooks.ready.then(() => {
    if (phase === "done") return;
    mapIsReady = true;
    hooks.setZoom(0);
    hooks.setMapFilter(mapFilter(0));
    if (skipWanted) finish();
  });

  const skip = () => {
    if (mapIsReady) finish();
    else {
      skipWanted = true; // the map is still loading: leave as soon as it is ready
      skipBtn.textContent = "Loading the map…";
      skipBtn.disabled = true;
    }
  };
  skipBtn.addEventListener("click", skip);

  let last = performance.now();
  const frame = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    // The first scene runs on the real clock (frames are slow while the package loads).
    // The flight never jumps: a slow frame counts as 0.1 s at most.
    step(phase === "sky" ? dt : Math.min(0.1, dt));
    if (phase !== "done") raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return { skip, step, phase: () => phase };
}
