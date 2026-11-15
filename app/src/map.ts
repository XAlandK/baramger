// CesiumJS map on a Mars 2000 sphere (the same sphere as every Mars Trek product).
// Note: Cesium's built-in Ellipsoid.MARS is flattened (3,396,190 x 3,376,200 m), so it reads
// latitudes differently from our planetocentric data. We use a true sphere instead.

import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { type HeightGrid, type LonLat, bilinear, inside } from "./grid";
import type { Leg } from "./plan";
import { CRATER_VIEW_MAX_M, NARROW_MAP_W, POLE_ARROW_TIP, POLE_LABEL_GAP_PX, namesVisible, needsShaping, photoLayerAlpha, planetFill, planetFitAltitude, widenFactor } from "./layout";
import { BASE_STYLES, type BaseStyle } from "./basemap";
import { CHASE_DEFAULT, CREW_MAX, type CameraPose, type ChaseOffset, type CrewSpot, type PathPoint, chaseOffsetFrom, chasePose, clampChase, metresApart } from "./crew";

export const MARS = new Cesium.Ellipsoid(3_396_190, 3_396_190, 3_396_190);
const OCCLUDER = new Cesium.Ellipsoid(3_387_190, 3_387_190, 3_387_190);

export type OverlayKey = "slope" | "geology" | "themis";

/** The view buttons: move on the ground (as seen on screen), up and down, turn, tilt, zoom. */
export type Nudge = "forward" | "back" | "left" | "right" | "up" | "down" | "turnLeft" | "turnRight" | "tiltUp" | "tiltDown" | "in" | "out";
export const NUDGES: Nudge[] = ["forward", "back", "left", "right", "up", "down", "turnLeft", "turnRight", "tiltUp", "tiltDown", "in", "out"];
/** One press moves this share of the camera's height above the ground (at least 1 m), or turns / tilts by these degrees. */
export const NUDGE_SHARE = 0.08;
export const NUDGE_TURN_DEG = 4;
export const NUDGE_TILT_DEG = 3;
/** A camera move this soon after the crew's own mouse or touch input is theirs (the follow camera keeps it). */
export const CHASE_INPUT_MS = 1500;
/** The camera never goes higher than this (m), as with the mouse. */
const CAMERA_MAX_M = 40_000_000;

/** A named place that is always labelled, whether or not it is a stop in the plan. */
export interface PlacePin extends LonLat {
  id: string;
  name: string;
}

/** A walk zone, highlighted on the whole-planet map. */
export interface ZonePin extends LonLat {
  key: string;
  label: string;
  elevM: number;
  aoi?: number[]; // west, south, east, north
}

interface Hit {
  id: string;
  at: Cesium.Cartesian3;
  radius: number;
  minDist?: number; // clickable only while the marker is shown (camera distance in metres)
  maxDist?: number;
}

/** Camera distances (m) at which the two kinds of zone marker are shown. */
const ZONE_NEAR_M = 12_000;
const ZONE_SPLIT_M = 120_000;
const ZONE_FAR_M = 80_000_000;
const PIN_FAR_M = 250_000;
/** Stop and place names are shown up to this camera distance (the widened views of narrow maps stand 6-7 km away). */
const NAME_FAR_M = ZONE_NEAR_M;
const PLACE_FAR_M = 30_000;

export interface StopPin extends LonLat {
  id: string;
  label: string;
  name: string;
  kind: "base" | "stop" | "new";
}

const COLORS = {
  easy: Cesium.Color.fromCssColorString("#3DDC97"),
  care: Cesium.Color.fromCssColorString("#FFC145"),
  stop: Cesium.Color.fromCssColorString("#55C2C5"),
  selected: Cesium.Color.fromCssColorString("#FF8A5B"),
  base: Cesium.Color.WHITE,
  rover: Cesium.Color.fromCssColorString("#E8E1D9").withAlpha(0.85),
  pole: Cesium.Color.fromCssColorString("#F2EDE6"),
};

/**
 * The crew figure: NASA's Z2 Spacesuit 3D model (NASA 3D Resources, extra source S9), at its real
 * size (about 1.93 m). The app's copy only leaves out NASA's JPEG copies of its WebP pictures
 * (pipeline/baramger_pipeline/suit_model.py).
 */
const SUIT_URL = `${import.meta.env.BASE_URL}models/z2-spacesuit.glb`;
/** Shown in the map's "Data attribution" list while the figures are on the map (the same credit as source S9). */
const SUIT_CREDIT = "Crew figures: Z2 Spacesuit 3D model, NASA/LaRC/Advanced Concepts Lab, via NASA 3D Resources (cleaned copy)";
/**
 * Light on the crew figures: a light from the viewer's side of this strength, plus an even,
 * colourless light from all around. CesiumJS's own all-around light is made for Earth's sky and
 * made the white suits look dull and greenish ("dirty"). NASA's picture of the suit also has
 * some dirt painted on, which a brighter light makes less dark.
 */
const SUIT_LIGHT = 2.2;
const SUIT_AMBIENT = 0.9;
function suitLighting(): Cesium.ImageBasedLighting {
  const ibl = new Cesium.ImageBasedLighting();
  ibl.imageBasedLightingFactor = new Cesium.Cartesian2(1, 0); // no Earth sky reflected in the suit
  ibl.sphericalHarmonicCoefficients = [new Cesium.Cartesian3(SUIT_AMBIENT, SUIT_AMBIENT, SUIT_AMBIENT), ...Array.from({ length: 8 }, () => new Cesium.Cartesian3())];
  return ibl;
}
/** Turn (degrees) that makes NASA's model face the heading it is given (found by looking at it). */
const SUIT_FACING_DEG = -90;
/** The round crew marker shows only from this far (m): nearer, the real-size figures can be seen. */
export const CREW_DOT_FROM_M = 220;
/** Each astronaut's name tag (A1, A2 ...) shows up to this distance (m). */
export const CREW_TAG_TO_M = 160;

/** The lowest the camera may go above the ground (m): under the helmet view's eye height (1.8 m). */
export const CAMERA_MIN_ABOVE_GROUND_M = 1.5;

/** The pole arrows show only on a camera this high (km), so they never stand on a close horizon. */
export const POLE_ARROW_MIN_KM = 1500;

const markerCache = new Map<string, HTMLCanvasElement>();

/** A round marker (optionally with a number or H in the middle), drawn at 2x for sharp edges. */
/** The crew marker with an arrowhead: this many pixels wide and high (the circle stays CREW_DOT_PX). */
const CREW_DOT_PX = 24;
const CREW_ARROW_PX = 46;

/**
 * The crew marker while it walks: the circle and a point on its rim, drawn pointing up (north).
 * The billboard is turned to the walking direction (setWalker).
 */
function crewArrowImage(fill: string, stroke = "#FFFFFF", strokeWidth = 3): { key: string; canvas: HTMLCanvasElement } {
  const key = `crew-arrow|${fill}|${stroke}|${strokeWidth}`;
  let c = markerCache.get(key);
  if (!c) {
    const k = 2;
    const S = CREW_ARROW_PX;
    const mid = S / 2;
    const r = CREW_DOT_PX / 2;
    c = document.createElement("canvas");
    c.width = c.height = S * k;
    const g = c.getContext("2d")!;
    g.scale(k, k);
    // the point: from inside the circle out to 9 px beyond its rim
    g.beginPath();
    g.moveTo(mid, mid - r - 9);
    g.lineTo(mid + 8, mid - r + 4);
    g.lineTo(mid - 8, mid - r + 4);
    g.closePath();
    g.lineJoin = "round";
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = stroke;
    g.stroke();
    // the circle on top (as markerImage draws it)
    g.beginPath();
    g.arc(mid, mid, r - strokeWidth / 2, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = strokeWidth;
    g.strokeStyle = stroke;
    g.stroke();
    markerCache.set(key, c);
  }
  return { key, canvas: c };
}

/**
 * A grey photo-map tile in the helmet view's approximate colour: the tile's own brightness (its
 * detail) with the hue and saturation of `colour` (canvas blend mode "color"), and the tile's own
 * transparency (the edges of the mapped area).
 */
function tintTile(img: CanvasImageSource & { width: number; height: number }, colour: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "color";
  g.fillStyle = colour;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "destination-in";
  g.drawImage(img, 0, 0);
  return c;
}

function markerImage(text: string, fill: string, size: number, stroke = "#0C1216", strokeWidth = 2): { key: string; canvas: HTMLCanvasElement } {
  const key = `marker|${text}|${fill}|${size}|${stroke}|${strokeWidth}`;
  let c = markerCache.get(key);
  if (!c) {
    const k = 2;
    c = document.createElement("canvas");
    c.width = c.height = size * k;
    const g = c.getContext("2d")!;
    g.scale(k, k);
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - strokeWidth / 2, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = strokeWidth;
    g.strokeStyle = stroke;
    g.stroke();
    if (text) {
      g.fillStyle = "#0C1216";
      g.font = `700 ${text.length > 1 ? 11 : 12}px Inter, system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, size / 2, size / 2 + 0.5);
    }
    markerCache.set(key, c);
  }
  return { key, canvas: c };
}

/** A glowing ring that marks a walk zone on the planet. */
function ringImage(size: number): { key: string; canvas: HTMLCanvasElement } {
  const key = `ring|${size}`;
  let c = markerCache.get(key);
  if (!c) {
    const k = 2;
    c = document.createElement("canvas");
    c.width = c.height = size * k;
    const g = c.getContext("2d")!;
    g.scale(k, k);
    const r = size / 2;
    g.beginPath();
    g.arc(r, r, r - 3, 0, Math.PI * 2);
    g.fillStyle = "rgba(85, 194, 197, 0.22)";
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = "#55C2C5";
    g.shadowColor = "#55C2C5";
    g.shadowBlur = 4;
    g.stroke();
    g.shadowBlur = 0;
    g.beginPath();
    g.arc(r, r, 3.2, 0, Math.PI * 2);
    g.fillStyle = "#FFFFFF";
    g.fill();
    markerCache.set(key, c);
  }
  return { key, canvas: c };
}

/**
 * Markers (stop pins, the crew, notes, place and zone names) as their own billboard and label
 * collections. Markers ignore depth, so they stay visible over hills.
 * Draw order: CesiumJS draws these collections in the opaque pass (also with
 * BlendOption.TRANSLUCENT), in the order of scene.primitives. The faint "behind the hill"
 * copies of the lines (setGhost) are in the same pass, so they are inserted at the front of
 * that list: copies first, markers last, and the markers stay on top.
 */
class MarkerLayer {
  private readonly dots: Cesium.BillboardCollection;
  private readonly labels: Cesium.LabelCollection;

  constructor(scene: Cesium.Scene) {
    this.dots = scene.primitives.add(new Cesium.BillboardCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
    this.labels = scene.primitives.add(new Cesium.LabelCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
  }

  clear(): void {
    this.dots.removeAll();
    this.labels.removeAll();
  }

  /** Show or hide the whole layer. */
  setShown(show: boolean): void {
    if (this.dots.show !== show) this.dots.show = show;
    if (this.labels.show !== show) this.labels.show = show;
  }

  /** range = camera distances (m) between which the marker is shown. */
  dot(position: Cesium.Cartesian3, img: { key: string; canvas: HTMLCanvasElement }, size: number, id?: unknown, range?: [number, number]): Cesium.Billboard {
    const b = this.dots.add({
      position,
      id,
      width: size,
      height: size,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: range ? new Cesium.DistanceDisplayCondition(range[0], range[1]) : undefined,
    });
    b.setImage(img.key, img.canvas);
    return b;
  }

  /**
   * A name beside a marker, for text that Cesium's own labels cannot draw (see needsShaping).
   * It takes the same place as label() would: left edge `offsetX` px right of the point.
   */
  tag(position: Cesium.Cartesian3, text: string, font: string, background: string, offsetX: number, padX: number, padY: number, id: unknown, range: [number, number]): Cesium.Billboard {
    const img = tagImage(text, font, "#FFFFFF", background, padX, padY);
    const b = this.dots.add({
      position,
      id,
      width: img.w,
      height: img.h,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(offsetX - padX, 0),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(range[0], range[1]),
    });
    b.setImage(img.key, img.canvas);
    return b;
  }

  label(position: Cesium.Cartesian3, options: Record<string, unknown>): Cesium.Label {
    return this.labels.add({
      position,
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      ...options,
    });
  }
}

/** A name tag drawn by the browser (any script, see needsShaping in layout.ts), as an image for a map marker. */
function tagImage(text: string, font: string, fill: string, background: string, padX: number, padY: number): { key: string; canvas: HTMLCanvasElement; w: number; h: number } {
  const k = 2; // drawn at twice the size, shown at half: sharp on dense screens
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d")!;
  g.font = font;
  const textW = Math.ceil(g.measureText(text).width);
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 13);
  const w = textW + 2 * padX;
  const h = Math.ceil(size * 1.35) + 2 * padY;
  canvas.width = w * k;
  canvas.height = h * k;
  g.scale(k, k);
  g.fillStyle = background;
  g.fillRect(0, 0, w, h);
  g.font = font;
  g.fillStyle = fill;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2 + 0.5);
  return { key: `tag|${font}|${fill}|${background}|${text}`, canvas, w, h };
}

/** Below this gap (metres) to the nearest other pin, a pin's name label is shown only up close. */
const CROWDED_M = 60;

/** Distance in metres from each pin to its nearest other pin (Infinity if it is alone). */
export function nearestGaps(pins: LonLat[]): number[] {
  const R = 3_396_190;
  return pins.map((a, i) => {
    let best = Infinity;
    for (const [j, b] of pins.entries()) {
      if (i === j) continue;
      const kx = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
      const dx = ((b.lon - a.lon) * Math.PI * R * kx) / 180;
      const dy = ((b.lat - a.lat) * Math.PI * R) / 180;
      best = Math.min(best, Math.hypot(dx, dy));
    }
    return best;
  });
}

/** A faint copy of a line that is drawn even where terrain hides the line (see setGhost). */
interface GhostRun {
  positions: Cesium.Cartesian3[];
  color: Cesium.Color;
  width: number;
  dash?: number;
}

const GHOST_RENDER_STATE = {
  depthTest: { enabled: false },
  depthMask: false,
  blending: Cesium.BlendingState.ALPHA_BLEND,
};

export class MapView {
  readonly viewer: Cesium.Viewer;
  readonly overlays: Partial<Record<OverlayKey, Cesium.ImageryLayer>> = {};
  private pinLayer!: MarkerLayer;
  private pinHits: Hit[] = [];
  private placeLayer!: MarkerLayer;
  private placeHits: Hit[] = [];
  private zoneLayer!: MarkerLayer;
  private nameLayer!: MarkerLayer;
  private zoneHits: Hit[] = [];
  private zoneCenter: Cesium.Cartesian3 | null = null;
  private nameCenter: Cesium.Cartesian3 | null = null; // the middle of the official place names
  private noteLayer!: MarkerLayer;
  private crewLayer!: MarkerLayer;
  private routeEntities: Cesium.Entity[] = [];
  private poleEntities: Cesium.Entity[] = [];
  private polesWanted = false;
  private suits: Cesium.Model[] = [];
  private suitsLoading: Promise<void> | null = null;
  private crewTags!: Cesium.LabelCollection;
  private crewNow: { spots: CrewSpot[]; hide: number; mark: number } = { spots: [], hide: -1, mark: -1 };
  private roverEntity: Cesium.Entity | null = null;
  private readonly tiling = new Cesium.GeographicTilingScheme({ ellipsoid: MARS });
  private readonly ghosts = new Map<string, Cesium.Primitive[]>();

  /**
   * The zone's height grids (1 m walk area, 20 m around it) are large downloads. The map starts
   * without them (the whole planet needs no zone heights): until `setGrids()`, the ground is a
   * flat `groundGuess` (m) everywhere, which looks the same from far away.
   */
  private walk: HeightGrid | null = null;
  private context: HeightGrid | null = null;

  constructor(
    container: HTMLElement,
    private readonly groundGuess = 0,
  ) {
    Cesium.Ellipsoid.default = MARS;
    this.viewer = new Cesium.Viewer(container, {
      ellipsoid: MARS,
      globe: new Cesium.Globe(MARS),
      mapProjection: new Cesium.GeographicProjection(MARS),
      terrainProvider: this.makeTerrain(),
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      skyAtmosphere: false,
      scene3DOnly: true,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
    });
    const scene = this.viewer.scene;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    scene.globe.depthTestAgainstTerrain = true;
    this.pinLayer = new MarkerLayer(scene);
    this.noteLayer = new MarkerLayer(scene);
    this.crewLayer = new MarkerLayer(scene);
    this.nameLayer = new MarkerLayer(scene); // under the markers: a name never hides a stop or a zone
    this.placeLayer = new MarkerLayer(scene);
    this.zoneLayer = new MarkerLayer(scene);
    this.crewTags = scene.primitives.add(new Cesium.LabelCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
    // The crew figures are lit from the viewer's side ("head-light"): the map has no sun position
    // for Mars, and CesiumJS's own sun is placed for Earth.
    const light = new Cesium.DirectionalLight({ direction: Cesium.Cartesian3.clone(scene.camera.directionWC), intensity: SUIT_LIGHT });
    scene.light = light;
    scene.preRender.addEventListener(() => Cesium.Cartesian3.clone(scene.camera.directionWC, light.direction));
    scene.globe.baseColor = Cesium.Color.fromCssColorString("#5b3f2e");
    scene.fog.enabled = false;
    if (scene.moon) scene.moon.show = false;
    // CesiumJS also adds its own Sun, placed for Earth's rotation. At some hours it would glow
    // beside Mars in the whole-planet view and in the launch animation: wrong, and not Mars data.
    if (scene.sun) scene.sun.show = false;
    scene.backgroundColor = Cesium.Color.BLACK;
    // CesiumJS keeps the camera at least this high above the ground (also a camera the app places).
    // It was 25 m, which lifted the helmet view (1.8 m) and every close look at the crew to 25 m.
    scene.screenSpaceCameraController.minimumZoomDistance = CAMERA_MIN_ABOVE_GROUND_M;
    scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000; // free flight around the planet, without losing it (see refit)
    // The map only redraws when asked (requestRenderMode). Ask again whenever map tiles finish
    // loading, or a still camera (the whole-planet view) would keep showing an empty globe.
    scene.globe.tileLoadProgressEvent.addEventListener(() => scene.requestRender());
    // A browser can drop the 3D picture while the page is in the background or its size changes.
    // Redraw when the page is shown again, and at a slow heartbeat, so the map never stays black.
    const again = () => {
      this.refit();
      scene.requestRender();
    };
    window.addEventListener("resize", again);
    // Any camera move by hand ends the "fitted whole-planet view" (see showPlanet).
    for (const ev of ["pointerdown", "wheel"]) scene.canvas.addEventListener(ev, () => { this.home = null; this.craterFit = null; }, { passive: true });
    // the crew's own mouse or touch moves of the camera (the follow camera keeps them: syncChase)
    for (const ev of ["pointerdown", "pointerup", "wheel"]) scene.canvas.addEventListener(ev, () => { this.lastInput = performance.now(); }, { passive: true });
    scene.canvas.addEventListener("pointermove", (e) => { if (e.buttons) this.lastInput = performance.now(); }, { passive: true });
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    window.addEventListener("pageshow", again);
    window.setInterval(again, 1500);
    // The official place names show at crater scale only: by the camera's height above the ground
    // (see namesVisible), and not from so far that the crater has its own marker, which already
    // carries the name (a tilted or far-away camera can be low and still far from the crater).
    scene.preRender.addEventListener(() => {
      const at = scene.camera.positionCartographic;
      const ground = this.heightAt(Cesium.Math.toDegrees(at.longitude), Cesium.Math.toDegrees(at.latitude));
      const anchor = this.zoneCenter ?? this.nameCenter;
      const distance = anchor ? Cesium.Cartesian3.distance(scene.camera.positionWC, anchor) : 0;
      this.nameLayer.setShown(namesVisible(this.cameraHeightKm() * 1000 - ground, distance));
    });
    // The photo maps fade in while the camera comes down to the crater (see photoLayerAlpha).
    scene.preRender.addEventListener(() => this.syncPhotoLayers());
    // Zone outlines are plain lines (no built-in display range): show them only from mid distance.
    scene.preRender.addEventListener(() => {
      if (!this.zoneCenter) return;
      const d = Cesium.Cartesian3.distance(scene.camera.positionWC, this.zoneCenter);
      const show = d > 6000 && d < 600_000;
      for (const prim of this.ghosts.get("zones") ?? []) if (prim.show !== show) prim.show = show;
    });
    scene.preRender.addEventListener(() => this.syncPoles());
    scene.globe.maximumScreenSpaceError = 1.5;
  }

  /** Heights: 1 m HiRISE grid in the walk area, 20 m CTX grid around it (edges clamped beyond). */
  heightAt(lon: number, lat: number): number {
    if (!this.walk || !this.context) return this.groundGuess; // the zone's grids are still loading
    return inside(this.walk.meta, lon, lat)
      ? bilinear(this.walk.meta, this.walk.h, lon, lat)
      : bilinear(this.context.meta, this.context.h, lon, lat);
  }

  /** The zone's height grids have arrived: the terrain is made again from them. */
  setGrids(walk: HeightGrid, context: HeightGrid): void {
    this.walk = walk;
    this.context = context;
    this.viewer.scene.terrainProvider = this.makeTerrain();
    this.redraw();
  }

  /** Are the zone's height grids in (for tests)? */
  hasGrids(): boolean {
    return !!this.walk && !!this.context;
  }

  private makeTerrain(): Cesium.CustomHeightmapTerrainProvider {
    const N = 65;
    const tiling = new Cesium.GeographicTilingScheme({ ellipsoid: MARS });
    return new Cesium.CustomHeightmapTerrainProvider({
      width: N,
      height: N,
      tilingScheme: tiling,
      ellipsoid: MARS,
      credit: "Terrain: HiRISE and CTX DEMs (NASA/JPL-Caltech/UArizona/MSSS, USGS), via Mars Trek",
      callback: (x, y, level) => {
        const r = tiling.tileXYToRectangle(x, y, level);
        const w = Cesium.Math.toDegrees(r.west);
        const e = Cesium.Math.toDegrees(r.east);
        const s = Cesium.Math.toDegrees(r.south);
        const n = Cesium.Math.toDegrees(r.north);
        const out = new Float32Array(N * N);
        for (let j = 0; j < N; j++) {
          const lat = n - ((n - s) * j) / (N - 1);
          for (let i = 0; i < N; i++) out[j * N + i] = this.heightAt(w + ((e - w) * i) / (N - 1), lat);
        }
        return out;
      },
    });
  }

  /** The whole-planet base maps, by look (see basemap.ts). Only one look is shown at a time. */
  private readonly baseLayers: Record<BaseStyle, Cesium.ImageryLayer[]> = { heights: [], colour: [] };
  /** The grey photo maps (CTX, HiRISE) on the base map, lowest first. They show only from near (see photoLayerAlpha). */
  private readonly photoLayers: Cesium.ImageryLayer[] = [];
  /** How each photo map was made (for its tinted copy). */
  private readonly photoSpecs: { urlTemplate: string; minLevel: number; maxLevel: number; rect: number[] | undefined; credit: string }[] = [];
  /** The photo maps in the helmet view's approximate colour (made when first needed, one per photo map), and their colour. */
  private tintLayers: Cesium.ImageryLayer[] = [];
  private tintColour: string | null = null;
  /** The ground colour shown now (null: the grey photo maps), and the sky colour (null: black space). */
  private groundTint: string | null = null;
  private skyTint: string | null = null;

  /**
   * The helmet view's approximate colour: the grey photo maps tinted with `colour` (the ground's
   * colour measured in the rover's photos), and the sky `sky` (a drawing) instead of black space.
   * Null: back to the grey maps and the black sky. Hidden layers load no tiles.
   */
  setGroundTint(colour: string | null, sky: string | null = null): void {
    const skyNow = colour ? sky : null;
    if (colour === this.groundTint && skyNow === this.skyTint) return; // called on every step of a walk: nothing to do
    const scene = this.viewer.scene;
    scene.backgroundColor = skyNow ? Cesium.Color.fromCssColorString(skyNow) : Cesium.Color.BLACK;
    if (scene.skyBox) scene.skyBox.show = !skyNow; // the stars would cover the sky colour
    this.skyTint = skyNow;
    this.groundTint = colour;
    if (colour && colour !== this.tintColour) {
      for (const l of this.tintLayers) this.viewer.imageryLayers.remove(l, true);
      this.tintLayers = this.photoLayers.map((grey, i) => this.makeTintLayer(grey, i, colour));
      this.tintColour = colour;
    }
    this.syncPhotoLayers();
    this.redraw();
  }

  /**
   * Show each photo map at its alpha for the camera's height (it fades in while the camera comes
   * down to the crater, see photoLayerAlpha): the grey one, or its tinted copy while the helmet
   * view's colour is on. Before every frame, and at once when the colour is switched.
   */
  private syncPhotoLayers(): void {
    const km = this.cameraHeightKm();
    this.photoLayers.forEach((layer, i) => {
      const alpha = photoLayerAlpha(km, i);
      const t = this.tintLayers[i];
      const tinted = !!this.groundTint && !!t;
      if (layer.alpha !== alpha) layer.alpha = alpha;
      if (layer.show !== (alpha > 0 && !tinted)) layer.show = alpha > 0 && !tinted; // a hidden layer loads no tiles
      if (t) {
        if (t.alpha !== alpha) t.alpha = alpha;
        if (t.show !== (alpha > 0 && tinted)) t.show = alpha > 0 && tinted;
      }
    });
  }

  /** The ground colour shown now (for tests and the dev tour). */
  groundTintNow(): string | null {
    return this.groundTint;
  }

  private makeTintLayer(grey: Cesium.ImageryLayer, i: number, colour: string): Cesium.ImageryLayer {
    const spec = this.photoSpecs[i];
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: spec.urlTemplate,
      tilingScheme: this.tiling,
      minimumLevel: spec.minLevel,
      maximumLevel: spec.maxLevel,
      rectangle: spec.rect ? Cesium.Rectangle.fromDegrees(spec.rect[0], spec.rect[1], spec.rect[2], spec.rect[3]) : undefined,
      credit: spec.credit,
    });
    const load = provider.requestImage.bind(provider);
    provider.requestImage = (x, y, level, request) => load(x, y, level, request)?.then((img) => tintTile(img as CanvasImageSource & { width: number; height: number }, colour));
    const layer = new Cesium.ImageryLayer(provider, { brightness: grey.brightness, contrast: grey.contrast, show: false });
    layer.alpha = grey.alpha;
    this.viewer.imageryLayers.add(layer, this.viewer.imageryLayers.indexOf(grey) + 1);
    return layer;
  }

  /** Where the horizon (straight ahead, level) is on the map: a share of its height from the top. For the helmet view's haze. */
  horizonFraction(): number {
    const cam = this.viewer.camera;
    const fovy = (cam.frustum as Cesium.PerspectiveFrustum).fovy ?? Cesium.Math.toRadians(60);
    return 0.5 - Math.tan(-cam.pitch) / Math.tan(fovy / 2) / 2;
  }

  /** The looks this mission package has tiles for. */
  baseStyles(): BaseStyle[] {
    return BASE_STYLES.filter((s) => this.baseLayers[s].length > 0);
  }

  /** Show one look of the whole-planet map and hide the other (a hidden layer loads no tiles). */
  setBaseStyle(style: BaseStyle): void {
    for (const s of BASE_STYLES) for (const layer of this.baseLayers[s]) layer.show = s === style;
    this.redraw();
  }

  /**
   * Add a tiled map from the mission package. `role` says what it is: one of the two whole-planet
   * looks, a photo map that lies on them, or (null) an overlay the caller switches on and off.
   */
  addTiles(urlTemplate: string, minLevel: number, maxLevel: number, rect: number[] | undefined, credit: string, alpha = 1, role: BaseStyle | "photo" | null = null): Cesium.ImageryLayer {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: urlTemplate,
      tilingScheme: this.tiling,
      minimumLevel: minLevel,
      maximumLevel: maxLevel,
      rectangle: rect ? Cesium.Rectangle.fromDegrees(rect[0], rect[1], rect[2], rect[3]) : undefined,
      credit,
    });
    const layer = this.viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = alpha;
    if (role === "photo") {
      this.photoLayers.push(layer);
      this.photoSpecs.push({ urlTemplate, minLevel, maxLevel, rect, credit });
    }
    else if (role) this.baseLayers[role].push(layer);
    return layer;
  }

  async addOverlay(key: OverlayKey, url: string, rect: number[], credit: string, alpha: number, show: boolean): Promise<void> {
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(url, {
      rectangle: Cesium.Rectangle.fromDegrees(rect[0], rect[1], rect[2], rect[3]),
      credit,
      ellipsoid: MARS,
    });
    const layer = this.viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = alpha;
    layer.show = show;
    this.overlays[key] = layer;
    this.redraw();
  }

  setOverlay(key: OverlayKey, show: boolean): void {
    const l = this.overlays[key];
    if (l) l.show = show;
    this.redraw();
  }

  setCompare(on: boolean, position = 0.5): void {
    for (const l of Object.values(this.overlays)) {
      if (l) l.splitDirection = on ? Cesium.SplitDirection.RIGHT : Cesium.SplitDirection.NONE;
    }
    this.viewer.scene.splitPosition = position;
    this.redraw();
  }

  setSplit(position: number): void {
    this.viewer.scene.splitPosition = position;
    this.redraw();
  }

  redraw(): void {
    this.viewer.scene.requestRender();
  }

  /**
   * Resolves when the map has drawn the current view with all its tiles (or after `timeoutMs`,
   * so a slow disk or a background tab cannot hold the app back for ever).
   */
  whenDrawn(timeoutMs = 6000): Promise<void> {
    const scene = this.viewer.scene;
    const globe = scene.globe;
    // "tilesLoaded" is also true before the first tile was even asked for, so wait until
    // loading has started (or tiles are on screen) and then finished, plus two more frames.
    let started = false;
    let framesAfter = 0;
    const onProgress = (queued: number) => { if (queued > 0) started = true; };
    const onFrame = () => {
      const onScreen = ((globe as unknown as { _surface?: { _tilesToRender?: unknown[] } })._surface?._tilesToRender?.length ?? 0) > 0;
      if ((started || onScreen) && globe.tilesLoaded) framesAfter++;
      else framesAfter = 0;
    };
    globe.tileLoadProgressEvent.addEventListener(onProgress);
    scene.postRender.addEventListener(onFrame);
    const t0 = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        if (framesAfter >= 2 || performance.now() - t0 > timeoutMs) {
          globe.tileLoadProgressEvent.removeEventListener(onProgress);
          scene.postRender.removeEventListener(onFrame);
          resolve();
          return;
        }
        scene.requestRender();
        window.setTimeout(check, 80);
      };
      check();
    });
  }

  private zoneArgs: [ZonePin[], (LonLat & { label: string; elevM: number }) | null] | null = null;
  private zonesStacked = false;
  /** The centre of the standard whole-planet view, while the camera still shows it (null once it was moved). */
  private home: LonLat | null = null;
  private homeSize = "";
  private homeAt: Cesium.Cartesian3 | null = null; // where the fitted view put the camera
  /** The whole-crater view while the camera still shows it: the map size it was framed for, where it put the camera, and how to frame it again. */
  private craterFit: { size: string; at: Cesium.Cartesian3; again: () => void } | null = null;

  private narrowMap(): boolean {
    return this.lens().w < NARROW_MAP_W;
  }

  /** The map's size on screen and the camera's angle across its larger side. */
  private lens(): { w: number; h: number; fov: number } {
    const c = this.viewer.scene.canvas;
    const fov = (this.viewer.camera.frustum as Cesium.PerspectiveFrustum).fov ?? Cesium.Math.toRadians(60);
    return { w: c.clientWidth || 1, h: c.clientHeight || 1, fov };
  }

  /**
   * The camera views are framed for a wide map. On a narrow map (a small window, or a tall one)
   * the camera sees a smaller angle from side to side, so it moves back by this factor.
   */
  private widen(): number {
    const { w, h, fov } = this.lens();
    return widenFactor(w, h, fov);
  }

  /** The camera height from which the whole planet fits the map: the disc takes about 70% of the smaller side. */
  planetAltitude(): number {
    const { w, h, fov } = this.lens();
    return planetFitAltitude(w, h, fov, MARS.maximumRadius, planetFill(w, h, fov, MARS.maximumRadius)); // room for the pole names
  }

  /**
   * Look straight down on the planet. Without a height, the whole disc is fitted to the map, and
   * it stays fitted when the map changes size (see refit) until the camera is moved.
   */
  showPlanet(center: LonLat, altitudeM?: number): void {
    this.chaseAt = null;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat - 8, altitudeM ?? this.planetAltitude(), MARS) });
    this.home = altitudeM === undefined ? center : null;
    this.craterFit = null;
    this.homeSize = this.sizeKey();
    this.homeAt = Cesium.Cartesian3.clone(this.viewer.camera.positionWC);
    this.redraw();
  }

  flyToPlanet(center: LonLat, duration = 3): void {
    this.home = null;
    this.chaseAt = null;
    this.craterFit = null;
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat - 8, this.planetAltitude(), MARS),
      duration,
      complete: () => {
        this.home = center;
        this.homeSize = "";
        this.homeAt = Cesium.Cartesian3.clone(this.viewer.camera.positionWC);
        this.refit(); // the map may have changed size during the flight
      },
    });
  }

  /** The map changed size: fit the whole-planet view again, and place the zone names again if needed. */
  refit(): void {
    // The zoom-out limit: the whole planet must fit any map shape, and the zone marker must stay in range.
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = Math.min(ZONE_FAR_M * 0.95, Math.max(40_000_000, this.planetAltitude() * 1.6));
    // A drag that began during the flight to the planet never passed through "pointerdown" after
    // the flight: if the camera is no longer where the fitted view put it, the crew moved it.
    if (this.home && (!this.homeAt || !Cesium.Cartesian3.equalsEpsilon(this.viewer.camera.positionWC, this.homeAt, 0, 1))) this.home = null;
    if (this.home && this.homeSize !== this.sizeKey()) this.showPlanet(this.home);
    // The same for the whole-crater view: it is framed for the map's size, so it is made again
    // when the size changes (the panel slides in, the window is resized), until the crew moves the camera.
    const fit = this.craterFit;
    if (fit && !Cesium.Cartesian3.equalsEpsilon(this.viewer.camera.positionWC, fit.at, 0, 1)) this.craterFit = null;
    else if (fit && fit.size !== this.sizeKey()) fit.again();
    if (this.zoneArgs && this.zonesStacked !== this.narrowMap()) this.setZones(...this.zoneArgs);
  }

  private sizeKey(): string {
    const { w, h } = this.lens();
    return `${w}x${h}`;
  }

  /**
   * A view of the whole crater, where each walk zone has its own marker: the camera stays below
   * CRATER_VIEW_MAX_M, which is below ZONE_SPLIT_M. See craterView() for the point and the height.
   */
  flyToCrater(center: LonLat, heightM?: number, duration = 3, again?: () => void): void {
    this.home = null;
    this.chaseAt = null;
    this.craterFit = null;
    const height = Math.min(CRATER_VIEW_MAX_M, ZONE_SPLIT_M * 0.9, heightM ?? 62_000 * this.widen());
    const destination = Cesium.Cartesian3.fromDegrees(center.lon, center.lat, height, MARS);
    // `again` frames the view once more for a new map size: the view stays fitted (see refit) until
    // the crew moves the camera. The size is the one this view was framed for, also when the map
    // changes size during the flight: refit() then frames it again on arrival.
    const framedFor = this.sizeKey();
    const arrived = () => {
      if (again) this.craterFit = { size: framedFor, at: Cesium.Cartesian3.clone(this.viewer.camera.positionWC), again };
    };
    if (duration <= 0) {
      this.viewer.camera.cancelFlight();
      this.viewer.camera.setView({ destination });
      arrived();
      this.redraw();
      return;
    }
    this.viewer.camera.flyTo({ destination, duration, complete: arrived });
  }

  /** The map's size on screen (CSS pixels) and the camera's angle across its larger side. */
  viewSize(): { w: number; h: number; fov: number } {
    return this.lens();
  }

  /** Camera height above the reference sphere, in km. */
  cameraHeightKm(): number {
    return (Cesium.Cartesian3.magnitude(this.viewer.camera.positionWC) - MARS.maximumRadius) / 1000;
  }

  flyToSite(center: LonLat, duration = 4): void {
    this.home = null;
    this.chaseAt = null;
    this.craterFit = null;
    const h = this.heightAt(center.lon, center.lat);
    const f = this.widen();
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(center.lon + 0.002 * f, center.lat - 0.028 * f, h + 1450 * f, MARS),
      orientation: { heading: Cesium.Math.toRadians(-4), pitch: Cesium.Math.toRadians(-36), roll: 0 },
      duration,
    });
  }

  flyToPoint(p: LonLat): void {
    this.home = null;
    this.chaseAt = null;
    this.craterFit = null;
    const h = this.heightAt(p.lon, p.lat);
    const f = this.widen();
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat - 0.0042 * f, h + 260 * f, MARS),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-42), roll: 0 },
      duration: 1.8,
    });
  }

  private pos(p: LonLat, lift: number): Cesium.Cartesian3 {
    return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, this.heightAt(p.lon, p.lat) + lift, MARS);
  }

  setPins(pins: StopPin[], selectedId: string | null): void {
    this.pinLayer.clear();
    this.pinHits = [];
    const near = nearestGaps(pins);
    for (const [i, p] of pins.entries()) {
      const selected = p.id === selectedId;
      // Stops a few metres apart (the Z1 tube depot) would hide each other's name labels:
      // show the name only when zoomed in close enough to separate them. The number stays.
      const nameRange = selected || near[i] >= CROWDED_M ? NAME_FAR_M : Math.max(40, 5 * near[i]);
      const color = p.kind === "base" ? COLORS.base : selected ? COLORS.selected : COLORS.stop;
      const size = selected ? 26 : 22;
      const at = this.pos(p, 3);
      const id = { pinId: p.id };
      this.pinLayer.dot(at, markerImage(p.label, color.toCssColorString(), size), size, id, [0, PIN_FAR_M]);
      this.pinHits.push({ id: p.id, at, radius: size / 2, maxDist: PIN_FAR_M });
      if (needsShaping(p.name)) {
        // a name the crew typed in Kurdish, Arabic or another joined script: the browser draws it
        this.pinLayer.tag(at, p.name, "500 13px Inter, system-ui, sans-serif", "rgba(12, 18, 22, 0.72)", 18, 7, 4, id, [0, nameRange]);
        continue;
      }
      this.pinLayer.label(at, {
        id,
        text: p.name,
        font: "500 13px Inter, system-ui, sans-serif",
        backgroundColor: Cesium.Color.fromCssColorString("#0C1216").withAlpha(0.72),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(18, 0),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, nameRange),
      });
    }
    this.redraw();
  }

  /**
   * Named places that are not stops in the plan right now: a small ring and the name, always shown.
   * They tell the crew where a stop can go, even after every stop has been removed.
   */
  setPlaces(places: PlacePin[]): void {
    this.placeLayer.clear();
    this.placeHits = [];
    const near = nearestGaps(places);
    for (const [i, p] of places.entries()) {
      const at = this.pos(p, 3);
      const id = { placeId: p.id };
      const nameRange = near[i] >= CROWDED_M ? NAME_FAR_M : Math.max(40, 5 * near[i]);
      this.placeLayer.dot(at, markerImage("", "rgba(12, 18, 22, 0.55)", 16, "#E8E1D9", 2), 16, id, [0, PLACE_FAR_M]);
      this.placeHits.push({ id: p.id, at, radius: 10, maxDist: PLACE_FAR_M });
      this.placeLayer.label(at, {
        id,
        text: p.name,
        font: "500 12px Inter, system-ui, sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#E8E1D9"),
        backgroundColor: Cesium.Color.fromCssColorString("#0C1216").withAlpha(0.6),
        backgroundPadding: new Cesium.Cartesian2(6, 3),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(14, 0),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, nameRange),
      });
    }
    this.redraw();
  }

  /**
   * Official place names (USGS map, R2) as plain lettering, without a marker. They show at crater
   * scale only (by camera height, see namesVisible). A small feature gets its name just above it,
   * so the name does not cover the feature.
   */
  setNames(names: (LonLat & { name: string; major: boolean })[]): void {
    this.nameLayer.clear();
    this.nameCenter = names.length
      ? this.pos({ lon: names.reduce((a, n) => a + n.lon, 0) / names.length, lat: names.reduce((a, n) => a + n.lat, 0) / names.length }, 0)
      : null;
    for (const n of names) {
      this.nameLayer.label(this.pos(n, 40), {
        text: n.major ? n.name.toUpperCase() : n.name,
        font: n.major ? "600 15px Inter, system-ui, sans-serif" : "italic 500 13px Inter, system-ui, sans-serif",
        showBackground: false,
        fillColor: Cesium.Color.fromCssColorString("#F4ECDF"),
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineColor: Cesium.Color.fromCssColorString("#0C1216"),
        outlineWidth: 3,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: n.major ? Cesium.VerticalOrigin.CENTER : Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: n.major ? Cesium.Cartesian2.ZERO : new Cesium.Cartesian2(0, -7),
      });
    }
    this.redraw();
  }

  /**
   * Highlight the walk zones on the planet. From far away the zones sit on top of each other
   * (they are a few km apart), so one marker stands for the crater; closer in, each zone has
   * its own marker, its name and the outline of its walk area.
   */
  /**
   * Mars's spin axis as an arrow out of each pole, with the pole's name (the whole-planet screen).
   * The axis is the z axis of the planetocentric frame that every map layer uses. The arrows are
   * real 3D lines, so they turn with the planet and the far one hides behind Mars.
   */
  setPoles(show: boolean): void {
    if (show && !this.poleEntities.length) {
      const r = MARS.maximumRadius;
      for (const [sign, name] of [[1, "North pole"], [-1, "South pole"]] as const) {
        this.poleEntities.push(this.viewer.entities.add({
          polyline: {
            positions: [new Cesium.Cartesian3(0, 0, sign * r), new Cesium.Cartesian3(0, 0, sign * r * POLE_ARROW_TIP)],
            width: 18,
            arcType: Cesium.ArcType.NONE, // a straight line in space, not along the ground
            material: new Cesium.PolylineArrowMaterialProperty(COLORS.pole),
          },
        }));
        this.poleEntities.push(this.viewer.entities.add({
          position: new Cesium.Cartesian3(0, 0, sign * r * POLE_ARROW_TIP), // beside the tip: clear of the title and of the hint
          label: {
            text: name,
            font: "600 13px Inter, system-ui, sans-serif",
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#0C1216").withAlpha(0.78),
            backgroundPadding: new Cesium.Cartesian2(8, 5),
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            pixelOffset: new Cesium.Cartesian2(POLE_LABEL_GAP_PX, 0),
          },
        }));
      }
    }
    this.polesWanted = show;
    this.syncPoles();
    this.redraw();
  }

  private syncPoles(): void {
    const show = this.polesWanted && this.cameraHeightKm() > POLE_ARROW_MIN_KM;
    for (const e of this.poleEntities) if (e.show !== show) e.show = show;
  }

  /** Is a pole arrow on (for tests and the dev tour)? */
  polesShown(): boolean {
    return this.poleEntities.length > 0 && this.poleEntities[0].show;
  }

  /** Where the pole names are on screen (CSS px, like getBoundingClientRect), leaving out a name behind Mars. */
  poleLabelBoxes(): { name: string; left: number; top: number; right: number; bottom: number }[] {
    if (!this.polesShown()) return [];
    const scene = this.viewer.scene;
    const canvas = scene.canvas.getBoundingClientRect();
    const occluder = new Cesium.EllipsoidalOccluder(MARS, scene.camera.positionWC);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = "600 13px Inter, system-ui, sans-serif";
    const now = Cesium.JulianDate.now();
    const out: { name: string; left: number; top: number; right: number; bottom: number }[] = [];
    for (const e of this.poleEntities) {
      const pos = e.position?.getValue(now);
      if (!e.label || !pos || !occluder.isPointVisible(pos)) continue;
      const at = Cesium.SceneTransforms.worldToWindowCoordinates(scene, pos);
      if (!at) continue;
      const name = String(e.label.text?.getValue(now) ?? "");
      const left = canvas.left + at.x + POLE_LABEL_GAP_PX;
      out.push({ name, left, right: left + ctx.measureText(name).width + 16, top: canvas.top + at.y - 13, bottom: canvas.top + at.y + 13 });
    }
    return out;
  }

  setZones(zones: ZonePin[], crater: (LonLat & { label: string; elevM: number }) | null): void {
    this.zoneArgs = [zones, crater];
    // On a narrow map a name beside its marker would be cut off at the map's edge:
    // put the names under (or over) their markers instead.
    const stacked = this.narrowMap();
    this.zonesStacked = stacked;
    this.zoneLayer.clear();
    this.zoneHits = [];
    const label = (at: Cesium.Cartesian3, id: unknown, text: string, side: number, range: [number, number]) =>
      this.zoneLayer.label(at, {
        id,
        text,
        font: "600 13px Inter, system-ui, sans-serif",
        backgroundColor: Cesium.Color.fromCssColorString("#0C1216").withAlpha(0.78),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        horizontalOrigin: stacked ? Cesium.HorizontalOrigin.CENTER : side > 0 ? Cesium.HorizontalOrigin.LEFT : Cesium.HorizontalOrigin.RIGHT,
        verticalOrigin: stacked ? (side > 0 ? Cesium.VerticalOrigin.TOP : Cesium.VerticalOrigin.BOTTOM) : Cesium.VerticalOrigin.CENTER,
        pixelOffset: stacked ? new Cesium.Cartesian2(0, side * 24) : new Cesium.Cartesian2(side * 24, 0),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(range[0], range[1]),
      });
    const meanLon = zones.reduce((a, z) => a + z.lon, 0) / Math.max(1, zones.length);
    const outlines: GhostRun[] = [];
    for (const z of zones) {
      const at = Cesium.Cartesian3.fromDegrees(z.lon, z.lat, z.elevM + 30, MARS);
      const id = { zoneKey: z.key };
      this.zoneLayer.dot(at, ringImage(30), 30, id, [ZONE_NEAR_M, ZONE_SPLIT_M]);
      label(at, id, z.label, z.lon >= meanLon ? 1 : -1, [ZONE_NEAR_M, ZONE_SPLIT_M]);
      this.zoneHits.push({ id: z.key, at, radius: 17, minDist: ZONE_NEAR_M, maxDist: ZONE_SPLIT_M });
      if (z.aoi) {
        const [w, s, e, n] = z.aoi;
        const corner = (lon: number, lat: number) => Cesium.Cartesian3.fromDegrees(lon, lat, z.elevM + 20, MARS);
        outlines.push({ positions: [corner(w, s), corner(e, s), corner(e, n), corner(w, n), corner(w, s)], color: COLORS.stop.withAlpha(0.9), width: 2 });
      }
    }
    if (crater) {
      const at = Cesium.Cartesian3.fromDegrees(crater.lon, crater.lat, crater.elevM + 30, MARS);
      const id = { zoneKey: "crater" };
      this.zoneLayer.dot(at, ringImage(34), 34, id, [ZONE_SPLIT_M, ZONE_FAR_M]);
      label(at, id, crater.label, 1, [ZONE_SPLIT_M, ZONE_FAR_M]);
      this.zoneHits.push({ id: "crater", at, radius: 19, minDist: ZONE_SPLIT_M, maxDist: ZONE_FAR_M });
      this.zoneCenter = at;
    } else this.zoneCenter = null;
    this.setGhost("zones", outlines);
  }

  /** Draw the route in runs: green = easy, yellow = 15-25 deg; dashed where there is no radio. */
  setRoute(legs: Leg[], comfortSlope: number): void {
    this.clearRoute();
    const ghost: GhostRun[] = [];
    for (const leg of legs) {
      const s = leg.samples;
      let start = 0;
      const key = (i: number) => `${s[i].slope > comfortSlope ? "care" : "easy"}|${s[i].radio ? "r" : "n"}`;
      for (let i = 1; i <= s.length; i++) {
        if (i < s.length && key(i) === key(start)) continue;
        const run = s.slice(start, Math.min(i + 1, s.length));
        if (run.length >= 2) {
          const [cls, radio] = key(start).split("|");
          const color = cls === "care" ? COLORS.care : COLORS.easy;
          const positions = run.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + 1.2, MARS));
          const material =
            radio === "r"
              ? new Cesium.ColorMaterialProperty(color)
              : new Cesium.PolylineDashMaterialProperty({ color, gapColor: Cesium.Color.TRANSPARENT, dashLength: 14 });
          this.routeEntities.push(
            this.viewer.entities.add({
              polyline: { positions, width: 6, arcType: Cesium.ArcType.NONE, material },
            }),
          );
          ghost.push({ positions, color: color.withAlpha(0.45), width: 6, dash: radio === "r" ? undefined : 14 });
        }
        start = i;
      }
    }
    this.setGhost("route", ghost);
  }

  clearRoute(): void {
    for (const e of this.routeEntities) this.viewer.entities.remove(e);
    this.routeEntities = [];
    this.setGhost("route", []);
  }

  /**
   * Lines are drawn at their real height, so a small bump in the terrain can hide part of them.
   * Each line therefore gets a faint copy that ignores depth. Cesium's own option for this
   * (depthFailMaterial) also fires where a pin is "in front" of the line (pins ignore depth too),
   * so it painted the route over the pins. This copy is drawn in the opaque pass with blending,
   * and it is put first in the scene's list (see the add(prim, 0) below): the marker layers are
   * in the same pass and are drawn in list order, so they come later and stay on top.
   */
  private setGhost(key: string, runs: GhostRun[]): void {
    for (const prim of this.ghosts.get(key) ?? []) this.viewer.scene.primitives.remove(prim);
    const groups = new Map<string, GhostRun[]>();
    for (const r of runs) {
      if (r.positions.length < 2) continue;
      const k = r.dash ? `dash|${r.dash}|${r.color.toCssColorString()}` : "solid";
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const prims: Cesium.Primitive[] = [];
    for (const list of groups.values()) {
      const dash = list[0].dash;
      const appearance = dash
        ? new Cesium.PolylineMaterialAppearance({
            material: new Cesium.Material({
              fabric: { type: "PolylineDash", uniforms: { color: list[0].color, gapColor: Cesium.Color.TRANSPARENT, dashLength: dash } },
              translucent: false,
            }),
            translucent: false,
            renderState: GHOST_RENDER_STATE,
          })
        : new Cesium.PolylineColorAppearance({ translucent: false, renderState: GHOST_RENDER_STATE });
      const vertexFormat = dash ? Cesium.PolylineMaterialAppearance.VERTEX_FORMAT : Cesium.PolylineColorAppearance.VERTEX_FORMAT;
      const prim = new Cesium.Primitive({
        geometryInstances: list.map(
          (r) =>
            new Cesium.GeometryInstance({
              geometry: new Cesium.PolylineGeometry({ positions: r.positions, width: r.width, vertexFormat, arcType: Cesium.ArcType.NONE }),
              attributes: dash ? undefined : { color: Cesium.ColorGeometryInstanceAttribute.fromColor(r.color) },
            }),
        ),
        appearance,
        asynchronous: false,
        allowPicking: false,
      });
      // Index 0: first in the scene's list, so the faint copies are drawn before the marker
      // layers. (Added at the end they were painted over every pin and name.)
      prims.push(this.viewer.scene.primitives.add(prim, 0));
    }
    this.ghosts.set(key, prims);
    this.redraw();
  }

  setRoverPath(points: (LonLat & { h: number })[], show: boolean): void {
    if (this.roverEntity) this.viewer.entities.remove(this.roverEntity);
    this.roverEntity = null;
    if (show && points.length > 1) {
      const positions = points.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + 0.6, MARS));
      this.roverEntity = this.viewer.entities.add({
        polyline: {
          positions,
          width: 2.5,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.PolylineDashMaterialProperty({ color: COLORS.rover, dashLength: 8 }),
        },
      });
      this.setGhost("rover", [{ positions, color: COLORS.rover.withAlpha(0.3), width: 2.5, dash: 8 }]);
    } else {
      this.setGhost("rover", []);
    }
  }

  // ---------------------------------------------------------------- walkers, track, notes, cameras
  private walker: { dot: Cesium.Billboard; label: Cesium.Label; arrow: boolean } | null = null;
  private trackEnt: Cesium.Entity | null = null;
  private trackPts: Cesium.Cartesian3[] = [];
  private trackGhostAt = 0;
  private trackGhostTimer = 0;
  private smoothHeading: number | null = null;

  /**
   * The crew marker (seen from afar) and its name. `headingDeg` = the direction the crew walks
   * (0 = north): the circle then has an arrowhead pointing that way on the map. Null (standing at
   * a stop, waiting at the start): the plain circle.
   */
  setWalker(p: (LonLat & { h: number }) | null, label = "Crew (2)", headingDeg: number | null = null): void {
    if (!p) {
      this.crewLayer.clear();
      this.walker = null;
      this.redraw();
      return;
    }
    const at = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + 3, MARS);
    if (!this.walker) {
      this.walker = {
        dot: this.crewLayer.dot(at, markerImage("", COLORS.selected.toCssColorString(), CREW_DOT_PX, "#FFFFFF", 3), CREW_DOT_PX, undefined, [CREW_DOT_FROM_M, Number.MAX_VALUE]),
        label: this.crewLayer.label(at, {
          text: label,
          font: "600 12px Inter, system-ui, sans-serif",
          backgroundColor: Cesium.Color.fromCssColorString("#0C1216").withAlpha(0.8),
          backgroundPadding: new Cesium.Cartesian2(6, 3),
          pixelOffset: new Cesium.Cartesian2(0, -30), // above the arrowhead too, when it points up
        }),
        arrow: false,
      };
    } else {
      this.walker.dot.position = at;
      this.walker.label.position = at;
      this.walker.label.text = label;
    }
    this.pointWalker(at, headingDeg);
    this.redraw();
  }

  /** Turn the crew marker's arrowhead to the walking direction, or show the plain circle. */
  private pointWalker(at: Cesium.Cartesian3, headingDeg: number | null): void {
    const w = this.walker;
    if (!w) return;
    const arrow = headingDeg !== null && Number.isFinite(headingDeg);
    if (arrow !== w.arrow) {
      const img = arrow ? crewArrowImage(COLORS.selected.toCssColorString()) : markerImage("", COLORS.selected.toCssColorString(), CREW_DOT_PX, "#FFFFFF", 3);
      w.dot.setImage(img.key, img.canvas);
      w.dot.width = w.dot.height = arrow ? CREW_ARROW_PX : CREW_DOT_PX;
      w.arrow = arrow;
    }
    if (arrow) {
      // the image's "up" follows the local north on screen, and is turned clockwise by the heading
      const north = Cesium.Matrix4.getColumn(Cesium.Transforms.eastNorthUpToFixedFrame(at, MARS), 1, new Cesium.Cartesian4());
      w.dot.alignedAxis = Cesium.Cartesian3.normalize(new Cesium.Cartesian3(north.x, north.y, north.z), new Cesium.Cartesian3());
      w.dot.rotation = -Cesium.Math.toRadians(headingDeg);
    } else {
      w.dot.alignedAxis = Cesium.Cartesian3.ZERO;
      w.dot.rotation = 0;
    }
  }

  /** The crew marker as drawn (for tests and the dev tour): with an arrowhead, and its heading on the map. */
  walkerState(): { arrow: boolean; headingDeg: number | null } | null {
    const w = this.walker;
    if (!w) return null;
    return { arrow: w.arrow, headingDeg: w.arrow ? (((-Cesium.Math.toDegrees(w.dot.rotation)) % 360) + 360) % 360 : null };
  }

  /**
   * The astronauts as 3D figures at real size, one per crew member (at most 4), or none.
   * `hide` = the one whose eyes the helmet view looks through (its figure would fill the view).
   * `mark` = the one the camera follows: its name tag has the crew marker's colour.
   */
  setCrew(spots: CrewSpot[], hide = -1, mark = -1): void {
    this.crewNow = { spots, hide, mark };
    if (spots.length && !this.suitsLoading) this.suitsLoading = this.loadSuits();
    this.placeCrew();
  }

  /** How many crew figures are loaded and shown (for tests and the dev tour). */
  crewShown(): { loaded: number; shown: number; ready: number } {
    return { loaded: this.suits.length, shown: this.suits.filter((m) => m.show).length, ready: this.suits.filter((m) => m.ready).length };
  }

  private async loadSuits(): Promise<void> {
    for (let i = 0; i < CREW_MAX; i++) {
      try {
        // the same address each time: CesiumJS reads and decodes the file once and shares it
        const m = await Cesium.Model.fromGltfAsync({
          url: SUIT_URL,
          credit: SUIT_CREDIT,
          show: false,
          shadows: Cesium.ShadowMode.DISABLED,
          imageBasedLighting: suitLighting(),
        });
        m.readyEvent.addEventListener(() => this.redraw());
        this.viewer.scene.primitives.add(m);
        this.suits.push(m);
      } catch (err) {
        console.warn("The crew figure could not be loaded; the crew marker stays.", err);
        return;
      }
    }
    this.placeCrew();
  }

  private placeCrew(): void {
    const { spots, hide, mark } = this.crewNow;
    this.suits.forEach((m, i) => {
      const s = spots[i];
      if (s) {
        const at = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.h, MARS);
        const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(s.headingDeg + SUIT_FACING_DEG), 0, 0);
        m.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(at, hpr, MARS);
      }
      const show = !!s && i !== hide;
      if (m.show !== show) m.show = show;
    });
    this.crewTags.removeAll();
    spots.forEach((s, i) => {
      if (i === hide) return;
      this.crewTags.add({
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.h + 2.2, MARS),
        text: s.name,
        font: "600 11px Inter, system-ui, sans-serif",
        fillColor: i === mark ? Cesium.Color.fromCssColorString("#0C1216") : Cesium.Color.WHITE, // dark on the bright crew colour: easier to read
        showBackground: true,
        backgroundColor: i === mark ? COLORS.selected : Cesium.Color.fromCssColorString("#0C1216").withAlpha(0.7),
        backgroundPadding: new Cesium.Cartesian2(4, 2),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, CREW_TAG_TO_M),
      });
    });
    this.redraw();
  }

  setTrack(points: (LonLat & { h: number })[]): void {
    this.trackPts = points.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + 1.6, MARS));
    if (!this.trackEnt && points.length) {
      this.trackEnt = this.viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => this.trackPts, false),
          width: 4,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.ColorMaterialProperty(Cesium.Color.WHITE),
        },
      });
    }
    if (!points.length && this.trackEnt) {
      this.viewer.entities.remove(this.trackEnt);
      this.trackEnt = null;
    }
    this.updateTrackGhost();
    this.redraw();
  }

  private updateTrackGhost(): void {
    window.clearTimeout(this.trackGhostTimer);
    const build = () => {
      this.trackGhostAt = performance.now();
      this.setGhost("track", [{ positions: this.trackPts, color: Cesium.Color.WHITE.withAlpha(0.45), width: 4 }]);
    };
    if (!this.trackPts.length || performance.now() - this.trackGhostAt > 500) build();
    else this.trackGhostTimer = window.setTimeout(build, 500);
  }

  setNotes(notes: (LonLat & { kind: "note" | "idea"; text: string })[]): void {
    this.noteLayer.clear();
    for (const n of notes) {
      const at = this.pos(n, 3);
      this.noteLayer.dot(at, markerImage("", n.kind === "idea" ? "#B9A7FF" : "#FFC145", 15), 15);
      this.noteLayer.label(at, {
        text: n.kind === "idea" ? "Next time" : "Note",
        font: "500 11px Inter, system-ui, sans-serif",
        backgroundColor: Cesium.Color.fromCssColorString("#0C1216").withAlpha(0.7),
        pixelOffset: new Cesium.Cartesian2(0, -18),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, NAME_FAR_M),
      });
    }
    this.redraw();
  }

  /** Camera behind and above the walkers, looking along their direction (walk-through). */
  droneView(p: LonLat & { h: number }, headingDeg: number, back = 120, up = 55): void {
    this.home = null;
    this.chaseAt = null;
    this.craterFit = null;
    if (this.smoothHeading === null) this.smoothHeading = headingDeg;
    const diff = ((headingDeg - this.smoothHeading + 540) % 360) - 180;
    this.smoothHeading = (this.smoothHeading + diff * 0.08 + 360) % 360;
    const hd = Cesium.Math.toRadians(this.smoothHeading);
    const kx = 59274 * Math.cos(Cesium.Math.toRadians(p.lat));
    const lon = p.lon - (Math.sin(hd) * back) / kx;
    const lat = p.lat - (Math.cos(hd) * back) / 59274;
    const h = Math.max(p.h, this.heightAt(lon, lat)) + up;
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, h, MARS),
      orientation: { heading: hd, pitch: Cesium.Math.toRadians(-20), roll: 0 },
    });
    this.redraw();
  }

  resetDrone(): void {
    this.smoothHeading = null;
  }

  /** Where the follow camera stands around the astronaut (kept when the followed astronaut changes). */
  private chaseOff: ChaseOffset = { ...CHASE_DEFAULT };
  /** The follow camera's last place: the astronaut, the heading used and the camera. Null when another view took over. */
  private chaseAt: { p: PathPoint; heading: number; cam: CameraPose } | null = null;
  /** When the crew last pressed, dragged or scrolled on the map (performance.now() ms). */
  private lastInput = -Infinity;

  /**
   * The camera that follows one astronaut from close by: behind and above them (CHASE_DEFAULT),
   * turning with them. A mouse move of the camera since the last call is kept (syncChase), so the
   * follow goes on from where the crew put the camera.
   */
  chaseView(p: PathPoint, headingDeg: number): void {
    this.home = null;
    this.craterFit = null;
    this.syncChase();
    if (this.smoothHeading === null || !this.chaseAt) this.smoothHeading = headingDeg;
    else {
      const diff = ((headingDeg - this.smoothHeading + 540) % 360) - 180;
      this.smoothHeading = (this.smoothHeading + diff * 0.08 + 360) % 360;
    }
    this.placeChase(p, this.smoothHeading);
  }

  private placeChase(p: PathPoint, heading: number): void {
    const cam = chasePose(p, heading, this.chaseOff, (lon, lat) => this.groundHeight(lon, lat));
    this.viewer.camera.cancelFlight();
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.h, MARS),
      orientation: { heading: Cesium.Math.toRadians(cam.headingDeg), pitch: Cesium.Math.toRadians(cam.pitchDeg), roll: 0 },
    });
    // where the camera really is (the same place, up to rounding): the next syncChase compares with it
    const c = this.viewer.camera.positionCartographic;
    this.chaseAt = { p, heading, cam: { ...cam, lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), h: c.height } };
    this.redraw();
  }

  /**
   * If the crew moved the follow camera with the mouse (or a finger) since it was placed, keep
   * that place around the astronaut. Only after the crew's own input (CHASE_INPUT_MS, which also
   * covers CesiumJS's coasting after a drag): CesiumJS also lifts the camera a little where its
   * ground is higher than ours, and that must not change the follow's distance and angle.
   */
  private syncChase(): void {
    const at = this.chaseAt;
    if (!at || performance.now() - this.lastInput > CHASE_INPUT_MS) return;
    const c = this.viewer.camera.positionCartographic;
    const now = { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), h: c.height };
    if (metresApart(now, at.cam) + Math.abs(now.h - at.cam.h) < 0.2) return; // smaller: rounding, or CesiumJS lifting the camera off the ground
    this.chaseOff = chaseOffsetFrom(now, at.p, at.heading);
  }

  /**
   * A view button while the camera follows an astronaut: zoom changes the distance, turn goes
   * around them, tilt looks more down or more level. The follow goes on, also while the clock
   * is paused. False for the other buttons (and when the follow camera is not on): the caller
   * then moves the free camera.
   */
  chaseNudge(kind: Nudge, steps = 1): boolean {
    const at = this.chaseAt;
    if (!at) return false;
    this.syncChase();
    const o = { ...this.chaseOff };
    if (kind === "in") o.rangeM *= 0.88 ** steps;
    else if (kind === "out") o.rangeM /= 0.88 ** steps;
    else if (kind === "turnLeft") o.aroundDeg -= NUDGE_TURN_DEG * steps;
    else if (kind === "turnRight") o.aroundDeg += NUDGE_TURN_DEG * steps;
    else if (kind === "tiltUp") o.pitchDeg += NUDGE_TILT_DEG * steps;
    else if (kind === "tiltDown") o.pitchDeg -= NUDGE_TILT_DEG * steps;
    else return false;
    this.chaseOff = clampChase(o);
    this.placeChase(at.p, at.heading);
    return true;
  }

  /** The follow camera goes back to its first place: behind and above the astronaut. */
  chaseReset(): void {
    this.chaseOff = { ...CHASE_DEFAULT };
  }

  /** True while the camera is the follow camera (no other view took over). */
  chasing(): boolean {
    return !!this.chaseAt;
  }

  /** The follow camera's offset now (for tests and the dev tour). */
  chaseState(): ChaseOffset | null {
    return this.chaseAt ? { ...this.chaseOff } : null;
  }

  /** Eye-level camera for the helmet view: about 1.8 m above the ground, looking where the crew walks. */
  firstPerson(p: LonLat & { h: number }, headingDeg: number): void {
    this.home = null;
    this.chaseAt = null;
    this.craterFit = null;
    if (this.smoothHeading === null) this.smoothHeading = headingDeg;
    const diff = ((headingDeg - this.smoothHeading + 540) % 360) - 180;
    this.smoothHeading = (this.smoothHeading + diff * 0.15 + 360) % 360;
    const ground = Math.max(p.h, this.heightAt(p.lon, p.lat));
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, ground + 1.8, MARS),
      orientation: { heading: Cesium.Math.toRadians(this.smoothHeading), pitch: Cesium.Math.toRadians(-7), roll: 0 },
    });
    this.redraw();
  }

  /**
   * One step of a view button. Moves follow the camera's heading (forward = the way the camera
   * looks, along the ground), heights stay above the ground, and steps grow with the height.
   */
  nudge(kind: Nudge, steps = 1): void {
    const cam = this.viewer.camera;
    this.home = null;
    this.chaseAt = null;
    this.craterFit = null;
    this.smoothHeading = null;
    cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
    const here = Cesium.Cartographic.fromCartesian(cam.positionWC, MARS);
    if (!here) return;
    const lon = Cesium.Math.toDegrees(here.longitude);
    const lat = Cesium.Math.toDegrees(here.latitude);
    const ground = this.groundHeight(lon, lat);
    const above = Math.max(CAMERA_MIN_ABOVE_GROUND_M, here.height - ground);
    const step = Math.max(1, NUDGE_SHARE * above) * steps;
    let heading = cam.heading;
    let pitch = cam.pitch;
    let dest = Cesium.Cartesian3.clone(cam.positionWC);
    const lowest = () => ground + CAMERA_MIN_ABOVE_GROUND_M + 0.5;
    if (kind === "forward" || kind === "back" || kind === "left" || kind === "right") {
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(cam.positionWC, MARS);
      const east = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian4());
      const north = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian4());
      const ang = heading + (kind === "back" ? Math.PI : kind === "left" ? -Math.PI / 2 : kind === "right" ? Math.PI / 2 : 0);
      const dir = new Cesium.Cartesian3(east.x * Math.sin(ang) + north.x * Math.cos(ang), east.y * Math.sin(ang) + north.y * Math.cos(ang), east.z * Math.sin(ang) + north.z * Math.cos(ang));
      const moved = Cesium.Cartesian3.add(cam.positionWC, Cesium.Cartesian3.multiplyByScalar(dir, step, dir), new Cesium.Cartesian3());
      const to = Cesium.Cartographic.fromCartesian(moved, MARS);
      if (!to) return;
      const toGround = this.groundHeight(Cesium.Math.toDegrees(to.longitude), Cesium.Math.toDegrees(to.latitude));
      to.height = Math.max(toGround + (here.height - ground), toGround + CAMERA_MIN_ABOVE_GROUND_M + 0.5); // the same height above the ground
      dest = Cesium.Cartographic.toCartesian(to, MARS);
    } else if (kind === "up" || kind === "down") {
      const h = kind === "up" ? Math.min(CAMERA_MAX_M, here.height + step) : Math.max(lowest(), here.height - step);
      dest = Cesium.Cartesian3.fromRadians(here.longitude, here.latitude, h, MARS);
    } else if (kind === "turnLeft" || kind === "turnRight") {
      heading += Cesium.Math.toRadians(NUDGE_TURN_DEG * steps * (kind === "turnLeft" ? -1 : 1));
    } else if (kind === "tiltUp" || kind === "tiltDown") {
      pitch = Cesium.Math.clamp(pitch + Cesium.Math.toRadians(NUDGE_TILT_DEG * steps * (kind === "tiltUp" ? 1 : -1)), -Cesium.Math.PI_OVER_TWO, Cesium.Math.toRadians(10));
    } else {
      // zoom: along the view direction, but never through the ground
      const dist = step * 1.5 * (kind === "in" ? 1 : -1);
      const moved = Cesium.Cartesian3.add(cam.positionWC, Cesium.Cartesian3.multiplyByScalar(cam.directionWC, dist, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      const to = Cesium.Cartographic.fromCartesian(moved, MARS);
      if (!to) return;
      const toGround = this.groundHeight(Cesium.Math.toDegrees(to.longitude), Cesium.Math.toDegrees(to.latitude));
      if (to.height < toGround + CAMERA_MIN_ABOVE_GROUND_M + 0.5) return; // the ground is in the way
      to.height = Math.min(CAMERA_MAX_M, to.height);
      dest = Cesium.Cartographic.toCartesian(to, MARS);
    }
    cam.setView({ destination: dest, orientation: { heading, pitch, roll: 0 } });
    this.redraw();
  }

  /** The ground's height under a place: the map's height grids near the zone, the drawn globe elsewhere. */
  private groundHeight(lon: number, lat: number): number {
    if (this.context && inside(this.context.meta, lon, lat)) return this.heightAt(lon, lat);
    const h = this.viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat, 0));
    return h ?? 0;
  }

  /** The camera as numbers (for tests and the dev tour): place, height above the sphere, heading and tilt in degrees. */
  cameraState(): { lon: number; lat: number; h: number; heading: number; pitch: number } {
    const cam = this.viewer.camera;
    const c = cam.positionCartographic;
    return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude), h: c.height, heading: Cesium.Math.toDegrees(cam.heading), pitch: Cesium.Math.toDegrees(cam.pitch) };
  }

  /** Camera looking down on the walkers, north up (tablet map). */
  topView(p: LonLat & { h: number }, height = 380): void {
    this.home = null;
    this.chaseAt = null;
    this.craterFit = null;
    const f = this.widen();
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat - 0.0012 * f, p.h + height * f, MARS),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-72), roll: 0 },
    });
    this.redraw();
  }

  /**
   * The map's scale at a screen position (CSS pixels from the map's top left corner): metres of
   * ground per pixel, measured from side to side. Null where the view shows no ground there
   * (the sky, or ground whose tiles are not loaded yet).
   */
  metersPerPixel(x: number, y: number, span = 40): number | null {
    const scene = this.viewer.scene;
    const ground = (px: number) => {
      const ray = this.viewer.camera.getPickRay(new Cesium.Cartesian2(px, y));
      return ray ? scene.globe.pick(ray, scene) : undefined;
    };
    const a = ground(x - span / 2);
    const b = ground(x + span / 2);
    if (!a || !b) return null;
    const d = Cesium.Cartesian3.distance(a, b);
    return d > 0 && Number.isFinite(d) ? d / span : null;
  }

  /** Call `cb` after every frame the map draws (it draws only when something changed). */
  onRender(cb: () => void): void {
    this.viewer.scene.postRender.addEventListener(cb);
  }

  /** The ground point in the middle of the map (null where the middle shows sky). The assistant reads it as "here". */
  centerLonLat(): LonLat | null {
    const { w, h } = this.viewSize();
    return this.pickLonLat(new Cesium.Cartesian2(w / 2, h / 2));
  }

  pickLonLat(pos: Cesium.Cartesian2): LonLat | null {
    const ray = this.viewer.camera.getPickRay(pos);
    if (!ray) return null;
    const c = this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!c) return null;
    const g = MARS.cartesianToCartographic(c);
    if (!g) return null;
    return { lon: Cesium.Math.toDegrees(g.longitude), lat: Cesium.Math.toDegrees(g.latitude) };
  }

  /**
   * The marker under a screen position. Markers have a fixed size on screen, so a hit test in
   * screen space is exact; it does not depend on GPU picking (unreliable in some embedded
   * browsers, and unavailable while the page is hidden). The nearest marker centre wins.
   */
  private hit(list: Hit[], pos: Cesium.Cartesian2): string | null {
    const scene = this.viewer.scene;
    const cam = scene.camera;
    // Jezero lies ~2.5 km below the Mars 2000 sphere, so test against a sphere 9 km lower
    // (below the deepest point on Mars, Hellas at about -8.2 km), or every pin would count as hidden.
    const occluder = new Cesium.EllipsoidalOccluder(OCCLUDER, cam.positionWC);
    const toPin = new Cesium.Cartesian3();
    let best: string | null = null;
    let bestD = Infinity;
    for (const h of list) {
      Cesium.Cartesian3.subtract(h.at, cam.positionWC, toPin);
      if (Cesium.Cartesian3.dot(toPin, cam.directionWC) <= 0 || !occluder.isPointVisible(h.at)) continue;
      const dist = Cesium.Cartesian3.magnitude(toPin);
      if ((h.minDist !== undefined && dist < h.minDist) || (h.maxDist !== undefined && dist > h.maxDist)) continue;
      const w = Cesium.SceneTransforms.worldToWindowCoordinates(scene, h.at);
      if (!w) continue;
      const d = Math.hypot(w.x - pos.x, w.y - pos.y);
      if (d <= h.radius + 2 && d < bestD) {
        best = h.id;
        bestD = d;
      }
    }
    return best;
  }

  pickPinId(pos: Cesium.Cartesian2): string | null {
    return this.hit(this.pinHits, pos);
  }

  pickPlaceId(pos: Cesium.Cartesian2): string | null {
    return this.hit(this.placeHits, pos);
  }

  /** A zone key, or "crater" for the far-away marker that stands for all zones. */
  pickZoneKey(pos: Cesium.Cartesian2): string | null {
    return this.hit(this.zoneHits, pos);
  }

  onClick(cb: (pos: Cesium.Cartesian2) => void): void {
    const h = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    h.setInputAction((e: { position: Cesium.Cartesian2 }) => cb(e.position), Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  onMove(cb: (pos: Cesium.Cartesian2) => void): void {
    const h = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    let pending: Cesium.Cartesian2 | null = null;
    h.setInputAction((e: { endPosition: Cesium.Cartesian2 }) => {
      if (!pending) requestAnimationFrame(() => { if (pending) cb(pending); pending = null; });
      pending = Cesium.Cartesian2.clone(e.endPosition);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }
}
