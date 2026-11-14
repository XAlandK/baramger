// CesiumJS map on a Mars 2000 sphere (the same sphere as every Mars Trek product).
// Note: Cesium's built-in Ellipsoid.MARS is flattened (3,396,190 x 3,376,200 m), so it reads
// latitudes differently from our planetocentric data. We use a true sphere instead.

import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { type HeightGrid, type LonLat, bilinear, inside } from "./grid";
import type { Leg } from "./plan";

export const MARS = new Cesium.Ellipsoid(3_396_190, 3_396_190, 3_396_190);
const OCCLUDER = new Cesium.Ellipsoid(3_387_190, 3_387_190, 3_387_190);

export type OverlayKey = "slope" | "geology" | "themis";

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
};

const markerCache = new Map<string, HTMLCanvasElement>();

/** A round marker (optionally with a number or H in the middle), drawn at 2x for sharp edges. */
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

/**
 * Markers (stop pins, the crew, notes) as their own billboard and label collections in the
 * translucent pass. Markers ignore depth so they stay visible over hills; drawn in the opaque
 * pass they would also fill the depth buffer, and the route's faint "behind the hill" copy
 * (its depth-fail material) would then paint over every pin. Here they write no depth before
 * the lines are drawn, so lines fade only behind real terrain and markers stay on top.
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

  dot(position: Cesium.Cartesian3, img: { key: string; canvas: HTMLCanvasElement }, size: number, id?: unknown): Cesium.Billboard {
    const b = this.dots.add({
      position,
      id,
      width: size,
      height: size,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
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
  private pinHits: { id: string; at: Cesium.Cartesian3; radius: number }[] = [];
  private noteLayer!: MarkerLayer;
  private crewLayer!: MarkerLayer;
  private routeEntities: Cesium.Entity[] = [];
  private roverEntity: Cesium.Entity | null = null;
  private readonly tiling = new Cesium.GeographicTilingScheme({ ellipsoid: MARS });
  private readonly ghosts = new Map<string, Cesium.Primitive[]>();

  constructor(
    container: HTMLElement,
    private readonly walk: HeightGrid,
    private readonly context: HeightGrid,
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
    scene.globe.baseColor = Cesium.Color.fromCssColorString("#5b3f2e");
    scene.fog.enabled = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = Cesium.Color.BLACK;
    scene.screenSpaceCameraController.minimumZoomDistance = 25;
    scene.globe.maximumScreenSpaceError = 1.5;
  }

  /** Heights: 1 m HiRISE grid in the walk area, 20 m CTX grid around it (edges clamped beyond). */
  heightAt(lon: number, lat: number): number {
    return inside(this.walk.meta, lon, lat)
      ? bilinear(this.walk.meta, this.walk.h, lon, lat)
      : bilinear(this.context.meta, this.context.h, lon, lat);
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

  addTiles(urlTemplate: string, minLevel: number, maxLevel: number, rect: number[] | undefined, credit: string, alpha = 1): Cesium.ImageryLayer {
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

  showPlanet(center: LonLat): void {
    this.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat - 8, 9_000_000, MARS) });
  }

  flyToSite(center: LonLat, duration = 4): void {
    const h = this.heightAt(center.lon, center.lat);
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(center.lon + 0.002, center.lat - 0.028, h + 1450, MARS),
      orientation: { heading: Cesium.Math.toRadians(-4), pitch: Cesium.Math.toRadians(-36), roll: 0 },
      duration,
    });
  }

  flyToPoint(p: LonLat): void {
    const h = this.heightAt(p.lon, p.lat);
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat - 0.0042, h + 260, MARS),
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
      const nameRange = selected || near[i] >= CROWDED_M ? 6000 : Math.max(40, 5 * near[i]);
      const color = p.kind === "base" ? COLORS.base : selected ? COLORS.selected : COLORS.stop;
      const size = selected ? 26 : 22;
      const at = this.pos(p, 3);
      const id = { pinId: p.id };
      this.pinLayer.dot(at, markerImage(p.label, color.toCssColorString(), size), size, id);
      this.pinHits.push({ id: p.id, at, radius: size / 2 });
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
   * so it painted the route over the pins. This copy is drawn in the opaque pass with blending;
   * markers come later (translucent pass), so they always stay on top.
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
      prims.push(this.viewer.scene.primitives.add(prim));
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
  private walker: { dot: Cesium.Billboard; label: Cesium.Label } | null = null;
  private trackEnt: Cesium.Entity | null = null;
  private trackPts: Cesium.Cartesian3[] = [];
  private trackGhostAt = 0;
  private trackGhostTimer = 0;
  private smoothHeading: number | null = null;

  setWalker(p: (LonLat & { h: number }) | null, label = "Crew (2)"): void {
    if (!p) {
      this.crewLayer.clear();
      this.walker = null;
      this.redraw();
      return;
    }
    const at = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + 3, MARS);
    if (!this.walker) {
      this.walker = {
        dot: this.crewLayer.dot(at, markerImage("", COLORS.selected.toCssColorString(), 24, "#FFFFFF", 3), 24),
        label: this.crewLayer.label(at, {
          text: label,
          font: "600 12px Inter, system-ui, sans-serif",
          backgroundColor: Cesium.Color.fromCssColorString("#0C1216").withAlpha(0.8),
          backgroundPadding: new Cesium.Cartesian2(6, 3),
          pixelOffset: new Cesium.Cartesian2(0, -24),
        }),
      };
    } else {
      this.walker.dot.position = at;
      this.walker.label.position = at;
      this.walker.label.text = label;
    }
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
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000),
      });
    }
    this.redraw();
  }

  /** Camera behind and above the walkers, looking along their direction (walk-through). */
  droneView(p: LonLat & { h: number }, headingDeg: number, back = 120, up = 55): void {
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

  /** Eye-level camera for the helmet view: about 1.8 m above the ground, looking where the crew walks. */
  firstPerson(p: LonLat & { h: number }, headingDeg: number): void {
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

  /** Camera looking down on the walkers, north up (tablet map). */
  topView(p: LonLat & { h: number }, height = 380): void {
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat - 0.0012, p.h + height, MARS),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-72), roll: 0 },
    });
    this.redraw();
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
   * The pin under a screen position. Pins have a fixed size on screen, so a hit test in screen
   * space is exact; it does not depend on GPU picking (unreliable in some embedded browsers,
   * and unavailable while the page is hidden). The nearest pin centre wins.
   */
  pickPinId(pos: Cesium.Cartesian2): string | null {
    const scene = this.viewer.scene;
    const cam = scene.camera;
    // Jezero lies ~2.5 km below the Mars 2000 sphere, so test against a sphere 9 km lower
    // (below the deepest point on Mars, Hellas at about -8.2 km), or every pin would count as hidden.
    const occluder = new Cesium.EllipsoidalOccluder(OCCLUDER, cam.positionWC);
    const toPin = new Cesium.Cartesian3();
    let best: string | null = null;
    let bestD = Infinity;
    for (const h of this.pinHits) {
      Cesium.Cartesian3.subtract(h.at, cam.positionWC, toPin);
      if (Cesium.Cartesian3.dot(toPin, cam.directionWC) <= 0 || !occluder.isPointVisible(h.at)) continue;
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
