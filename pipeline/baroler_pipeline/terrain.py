"""Terrain: clip Mars Trek DEMs (R1), derive slope / roughness / no-go, export grids.

Mars Trek DEMs use an equirectangular projection on the Mars 2000 sphere with
standard parallel 0 and central meridian 0, so x = R*lon and y = R*lat (radians).
A clipped window is therefore a regular longitude/latitude grid.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from PIL import Image
from rasterio import features
from rasterio.windows import from_bounds

from .config import MARS_RADIUS_M, MAX_SLOPE_DEG, COMFORT_SLOPE_DEG

R = MARS_RADIUS_M
NODATA_FLOOR = -1.0e20  # anything below this is treated as "no data"


@dataclass
class Grid:
    """Heights on a regular lon/lat grid. Row 0 is the northern edge."""

    z: np.ndarray            # float32 metres above the MOLA areoid, NaN = unknown
    west: float
    south: float
    east: float
    north: float

    @property
    def height(self) -> int:
        return int(self.z.shape[0])

    @property
    def width(self) -> int:
        return int(self.z.shape[1])

    @property
    def dlon(self) -> float:
        return (self.east - self.west) / self.width

    @property
    def dlat(self) -> float:
        return (self.north - self.south) / self.height

    @property
    def center_lat(self) -> float:
        return (self.north + self.south) / 2

    @property
    def dx_m(self) -> float:
        """True east-west cell size in metres at the grid's centre latitude."""
        return math.radians(self.dlon) * R * math.cos(math.radians(self.center_lat))

    @property
    def dy_m(self) -> float:
        return math.radians(self.dlat) * R

    def transform(self) -> Affine:
        return Affine(self.dlon, 0.0, self.west, 0.0, -self.dlat, self.north)

    def cell_center(self, row: float, col: float) -> tuple[float, float]:
        return self.west + (col + 0.5) * self.dlon, self.north - (row + 0.5) * self.dlat

    def rowcol(self, lon: float, lat: float) -> tuple[int, int]:
        return int((self.north - lat) / self.dlat), int((lon - self.west) / self.dlon)

    def meta(self, encoding: str, extra: dict | None = None) -> dict:
        m = {
            "width": self.width, "height": self.height,
            "west": self.west, "south": self.south, "east": self.east, "north": self.north,
            "cellLonDeg": self.dlon, "cellLatDeg": self.dlat,
            "dxM": round(self.dx_m, 4), "dyM": round(self.dy_m, 4),
            "rowOrder": "north-to-south", "encoding": encoding,
            "heightReference": "metres above MOLA areoid (Mars Trek DeltaGeoid DEM)",
        }
        if extra:
            m.update(extra)
        return m


def _check_crs(src: rasterio.DatasetReader) -> None:
    p = src.crs.to_dict()
    ok = (
        p.get("proj") == "eqc"
        and abs(float(p.get("lat_ts", 0))) < 1e-9
        and abs(float(p.get("lon_0", 0))) < 1e-9
        and abs(float(p.get("R", p.get("a", 0))) - R) < 1
    )
    if not ok:
        raise ValueError(f"Unexpected DEM projection {p}; expected eqc, lat_ts=0, lon_0=0, R={R}")


def read_clip(path: Path, bbox: tuple[float, float, float, float]) -> Grid:
    """Read the part of a Mars Trek DEM inside bbox (minLon, minLat, maxLon, maxLat)."""
    w, s, e, n = bbox
    with rasterio.open(path) as src:
        _check_crs(src)
        x0, y0 = R * math.radians(w), R * math.radians(s)
        x1, y1 = R * math.radians(e), R * math.radians(n)
        win = from_bounds(x0, y0, x1, y1, transform=src.transform)
        win = win.round_offsets().round_lengths()
        full = rasterio.windows.Window(0, 0, src.width, src.height)
        win = win.intersection(full)
        z = src.read(1, window=win).astype("float64")
        if src.nodata is not None:
            z[np.isclose(z, src.nodata)] = np.nan
        z[z < NODATA_FLOOR] = np.nan
        t = src.window_transform(win)
        px, py = t.a, -t.e
        h, wd = z.shape
        west = math.degrees(t.c / R)
        north = math.degrees(t.f / R)
        east = math.degrees((t.c + wd * px) / R)
        south = math.degrees((t.f - h * py) / R)
    return Grid(z.astype("float32"), west, south, east, north)


REMOTE_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MAX_RETRY": "5",
    "GDAL_HTTP_RETRY_DELAY": "2",
    "VSI_CACHE": "TRUE",
}


def fetch_window(url: str, bbox: tuple[float, float, float, float], dest: Path, margin_deg: float = 0.001) -> dict:
    """Read only the bbox window of a remote GeoTIFF (HTTP range reads) and save it locally."""
    w, s, e, n = bbox
    w, s, e, n = w - margin_deg, s - margin_deg, e + margin_deg, n + margin_deg
    dest.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.Env(**REMOTE_ENV):
        with rasterio.open(f"/vsicurl/{url}") as src:
            _check_crs(src)
            win = from_bounds(R * math.radians(w), R * math.radians(s), R * math.radians(e), R * math.radians(n),
                              transform=src.transform).round_offsets().round_lengths()
            win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            data = src.read(1, window=win)
            profile = src.profile.copy()
            profile.update(width=int(win.width), height=int(win.height), transform=src.window_transform(win),
                           tiled=True, blockxsize=256, blockysize=256, compress="deflate", predictor=3)
            remote = {"width": src.width, "height": src.height, "res": list(src.res)}
    with rasterio.open(dest, "w", **profile) as dst:
        dst.write(data, 1)
        dst.update_tags(SOURCE_URL=url, WINDOW=f"col {int(win.col_off)} row {int(win.row_off)} "
                                               f"size {int(win.width)}x{int(win.height)}")
    return {"remote": remote, "window": [int(win.col_off), int(win.row_off), int(win.width), int(win.height)]}


def fill_gaps(z: np.ndarray, max_iter: int = 200) -> tuple[np.ndarray, np.ndarray]:
    """Fill NaN cells from their neighbours. Returns (filled, unknown_mask)."""
    unknown = ~np.isfinite(z)
    out = z.astype("float64").copy()
    if not unknown.any():
        return out.astype("float32"), unknown
    if unknown.all():
        raise ValueError("DEM clip has no valid heights")
    for _ in range(max_iter):
        nan = ~np.isfinite(out)
        if not nan.any():
            break
        p = np.pad(out, 1, mode="edge")
        stack = np.stack([p[1:-1, :-2], p[1:-1, 2:], p[:-2, 1:-1], p[2:, 1:-1]])
        with np.errstate(invalid="ignore"):
            mean = np.nanmean(np.where(np.isfinite(stack), stack, np.nan), axis=0)
        out[nan] = mean[nan]
    out[~np.isfinite(out)] = np.nanmean(z)
    return out.astype("float32"), unknown


def block_mean(g: Grid, factor: int) -> Grid:
    """Downsample by an integer factor (mean of each block, NaN-aware)."""
    h = (g.height // factor) * factor
    w = (g.width // factor) * factor
    z = g.z[:h, :w].reshape(h // factor, factor, w // factor, factor)
    with np.errstate(invalid="ignore"):
        zm = np.nanmean(z, axis=(1, 3)).astype("float32")
    east = g.west + w * g.dlon
    south = g.north - h * g.dlat
    return Grid(zm, g.west, south, east, g.north)


def slope_deg(z: np.ndarray, dx: float, dy: float) -> np.ndarray:
    gy, gx = np.gradient(z.astype("float64"), dy, dx)
    return np.degrees(np.arctan(np.hypot(gx, gy))).astype("float32")


def box_mean(a: np.ndarray, size: int) -> np.ndarray:
    """Mean over a size x size window (edges padded by reflection)."""
    r = size // 2
    p = np.pad(a.astype("float64"), r, mode="reflect")
    c = p.cumsum(0).cumsum(1)
    c = np.pad(c, ((1, 0), (1, 0)))
    s = c[size:, size:] - c[:-size, size:] - c[size:, :-size] + c[:-size, :-size]
    return (s / (size * size)).astype("float32")


def roughness_m(z: np.ndarray) -> np.ndarray:
    """Local bumpiness: distance of each cell from the 3x3 average height (metres)."""
    return np.abs(z - box_mean(z, 3)).astype("float32")


def slope_overlay_png(slope: np.ndarray, unknown: np.ndarray, path: Path) -> None:
    """Transparent PNG: yellow = take care, red = no-go, grey hatch = unknown."""
    h, w = slope.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    care = (slope >= COMFORT_SLOPE_DEG) & (slope <= MAX_SLOPE_DEG)
    nogo = slope > MAX_SLOPE_DEG
    rgba[care] = (236, 176, 38, 120)
    rgba[nogo] = (214, 48, 39, 170)
    rgba[unknown] = (120, 120, 120, 120)
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)


def nogo_polygons(g: Grid, nogo: np.ndarray, min_cells: int = 25, limit: int = 60) -> list[dict]:
    """Vectorise no-go cells into lon/lat polygons (largest first)."""
    shapes = features.shapes(nogo.astype("uint8"), mask=nogo, transform=g.transform(), connectivity=8)
    cell_area = g.dx_m * g.dy_m
    polys = []
    for geom, _ in shapes:
        ring = geom["coordinates"][0]
        # shoelace area in cells
        a = 0.0
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            a += x1 * y2 - x2 * y1
        cells = abs(a) / 2 / (g.dlon * g.dlat)
        if cells >= min_cells:
            polys.append((cells * cell_area, geom))
    polys.sort(key=lambda t: -t[0])
    return [{"area_m2": round(a, 1), "geometry": geom} for a, geom in polys[:limit]]


def write_f32(path: Path, a: np.ndarray) -> None:
    np.ascontiguousarray(a, dtype="<f4").tofile(path)


def write_u8(path: Path, a: np.ndarray) -> None:
    np.ascontiguousarray(a, dtype="u1").tofile(path)


def _bilinear_rc(z: np.ndarray, r: np.ndarray, c: np.ndarray) -> np.ndarray:
    h, w = z.shape
    r = np.clip(r, 0, h - 1)
    c = np.clip(c, 0, w - 1)
    r0 = np.floor(r).astype(int)
    c0 = np.floor(c).astype(int)
    r1 = np.minimum(r0 + 1, h - 1)
    c1 = np.minimum(c0 + 1, w - 1)
    fr = r - r0
    fc = c - c0
    top = z[r0, c0] * (1 - fc) + z[r0, c1] * fc
    bot = z[r1, c0] * (1 - fc) + z[r1, c1] * fc
    return top * (1 - fr) + bot * fr


def visible_fraction(g: Grid, z: np.ndarray, base_rc: tuple[float, float], base_h: float,
                     targets_rc: np.ndarray, target_h: np.ndarray) -> float:
    """Share of targets the base antenna can see (straight line over terrain + planet curve)."""
    r0, c0 = base_rc
    dr = targets_rc[:, 0] - r0
    dc = targets_rc[:, 1] - c0
    D = np.hypot(dr * g.dy_m, dc * g.dx_m)
    n = int(np.ceil(D.max() / min(g.dx_m, g.dy_m))) + 1
    t = np.linspace(0.0, 1.0, n)[1:-1][None, :]          # (1, n-2)
    rr = r0 + dr[:, None] * t
    cc = c0 + dc[:, None] * t
    ground = _bilinear_rc(z, rr, cc)
    d1 = D[:, None] * t
    bulge = d1 * (D[:, None] - d1) / (2 * R)
    sight = base_h + (target_h[:, None] - base_h) * t
    blocked = (ground + bulge > sight).any(axis=1)
    return float(1.0 - blocked.mean())


def choose_base(g2: Grid, slope2: np.ndarray, unknown2: np.ndarray, stops: list[tuple[float, float]],
                min_from_stops_m: float = 300.0, max_from_centre_m: float = 900.0,
                edge_m: float = 60.0, base_antenna_m: float = 3.0, suit_antenna_m: float = 1.8,
                lattice_m: float = 20.0) -> tuple[float, float, float, float]:
    """Pick a flat 30 m patch for the habitat: at least `min_from_stops_m` from every stop, not too far
    from the stops' centre, and with the best radio line of sight to the stops and the walking corridor
    between them. Returns (lon, lat, mean_slope, visible_fraction)."""
    win = max(3, int(round(30.0 / g2.dy_m)) | 1)
    mean_slope = box_mean(slope2, win)
    bad = box_mean((slope2 > COMFORT_SLOPE_DEG).astype("float32") + unknown2.astype("float32"), win) > 0
    rows, cols = np.indices(slope2.shape)
    lon = g2.west + (cols + 0.5) * g2.dlon
    lat = g2.north - (rows + 0.5) * g2.dlat
    kx = math.radians(1) * R * math.cos(math.radians(g2.center_lat))
    ky = math.radians(1) * R

    def dist_to(p: tuple[float, float]) -> np.ndarray:
        return np.hypot((lon - p[0]) * kx, (lat - p[1]) * ky)

    nearest = np.min(np.stack([dist_to(p) for p in stops]), axis=0)
    centre = (sum(p[0] for p in stops) / len(stops), sum(p[1] for p in stops) / len(stops))
    edge_c = int(edge_m / g2.dy_m)
    inner = np.zeros_like(bad)
    inner[edge_c:-edge_c, edge_c:-edge_c] = True
    ok = inner & ~bad & (nearest >= min_from_stops_m) & (dist_to(centre) <= max_from_centre_m)
    if not ok.any():
        raise ValueError("No flat base site found in the search ring")

    # radio targets: the stops plus points every ~25 m along straight lines between them
    def rc(p: tuple[float, float]) -> tuple[float, float]:
        return (g2.north - p[1]) / g2.dlat - 0.5, (p[0] - g2.west) / g2.dlon - 0.5

    pts = [rc(p) for p in stops]
    targets = list(pts)
    for a, b in zip(pts, pts[1:]):
        L = math.hypot((b[0] - a[0]) * g2.dy_m, (b[1] - a[1]) * g2.dx_m)
        k = max(1, int(L / 25.0))
        targets += [(a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k) for i in range(1, k)]
    trc = np.array(targets)
    th = _bilinear_rc(g2.z, trc[:, 0], trc[:, 1]) + suit_antenna_m

    step = max(1, int(round(lattice_m / g2.dy_m)))
    cand = np.argwhere(ok[::step, ::step]) * step
    scored = []
    for r, c in cand:
        vis = visible_fraction(g2, g2.z, (float(r), float(c)), float(g2.z[r, c]) + base_antenna_m, trc, th)
        scored.append((vis, float(mean_slope[r, c]), int(r), int(c)))
    # Prefer level ground (mean slope <= 5 deg) that still sees most of the walk; otherwise trade off.
    level = [s for s in scored if s[1] <= 5.0 and s[0] >= 0.75]
    if level:
        vis, slope_mean, r, c = max(level, key=lambda s: (s[0], -s[1]))
    else:
        vis, slope_mean, r, c = max(scored, key=lambda s: s[0] - 0.02 * s[1])
    lo, la = g2.cell_center(r, c)
    return float(lo), float(la), slope_mean, vis


SLOPE_SMOOTH = 3  # 3x3 mean on the 2 m grid (~6 m baseline); best match to rover-measured tilt


def verify_against_rover(g: Grid, slope: np.ndarray, waypoints: list[dict]) -> dict:
    """Compare map heights and slopes with the rover's own measurements (S1).

    Rover heights are probably tied to the same orbital map, so the height check shows agreement,
    not independent accuracy. Rover tilt comes from the rover's own sensors, so the slope check is
    independent (the rover's 3 m body averages small bumps).
    """
    pts = [w for w in waypoints if g.west <= w["lon"] <= g.east and g.south <= w["lat"] <= g.north
           and w.get("Note") != "Interpolated" and w.get("tilt") is not None]
    if not pts:
        return {"points": 0}

    def at(a: np.ndarray, w: dict) -> float:
        r, c = g.rowcol(w["lon"], w["lat"])
        return float(a[min(max(r, 0), a.shape[0] - 1), min(max(c, 0), a.shape[1] - 1)])

    dh = np.array([at(g.z, w) - float(w["elev_geoid"]) for w in pts])
    ds = np.array([at(slope, w) - float(w["tilt"]) for w in pts])
    return {
        "points": len(pts),
        "height_diff_median_m": round(float(np.median(dh)), 3),
        "height_diff_max_abs_m": round(float(np.abs(dh).max()), 3),
        "slope_minus_tilt_median_deg": round(float(np.median(ds)), 2),
        "slope_minus_tilt_mae_deg": round(float(np.mean(np.abs(ds))), 2),
        "rover_tilt_median_deg": round(float(np.median([float(w["tilt"]) for w in pts])), 2),
    }


def build(out_dir: Path, hirise_dem: Path, ctx_dem: Path, aoi, context, route_cell_m: float,
          stops_lonlat: list[tuple[float, float]], waypoints: list[dict]) -> dict:
    """Run the terrain step. Returns a summary dict used by the package step."""
    (out_dir / "terrain").mkdir(parents=True, exist_ok=True)
    (out_dir / "route").mkdir(parents=True, exist_ok=True)
    (out_dir / "overlays").mkdir(parents=True, exist_ok=True)

    # --- walk-scale terrain (HiRISE 1 m)
    g1 = read_clip(hirise_dem, aoi)
    z1, unk1 = fill_gaps(g1.z)
    g1f = Grid(z1, g1.west, g1.south, g1.east, g1.north)
    write_f32(out_dir / "terrain" / "height_1m.f32", g1f.z)
    (out_dir / "terrain" / "height_1m.json").write_text(json.dumps(g1f.meta("float32-le"), indent=2))

    # --- routing grid (~2 m): mean heights, slope over a 4 m baseline, roughness
    factor = max(1, int(round(route_cell_m / g1.dy_m)))
    g2 = block_mean(Grid(np.where(unk1, np.nan, g1.z), g1.west, g1.south, g1.east, g1.north), factor)
    unk2 = ~np.isfinite(g2.z)
    z2, _ = fill_gaps(g2.z)
    g2 = Grid(z2, g2.west, g2.south, g2.east, g2.north)
    s2 = slope_deg(box_mean(g2.z, SLOPE_SMOOTH), g2.dx_m, g2.dy_m)
    r2 = roughness_m(g2.z)
    check = verify_against_rover(g2, s2, waypoints)
    write_f32(out_dir / "route" / "height_2m.f32", g2.z)
    slope_u8 = np.where(unk2, 255, np.clip(np.ceil(s2), 0, 90)).astype("u1")
    rough_u8 = np.where(unk2, 255, np.clip(np.round(r2 * 100), 0, 254)).astype("u1")
    write_u8(out_dir / "route" / "slope_2m.u8", slope_u8)
    write_u8(out_dir / "route" / "rough_2m.u8", rough_u8)
    (out_dir / "route" / "grid.json").write_text(json.dumps(g2.meta(
        "height_2m.f32 float32-le; slope_2m.u8 whole degrees (255=unknown); rough_2m.u8 centimetres (255=unknown)",
        {"factorFrom1m": factor}), indent=2))

    nogo = (s2 > MAX_SLOPE_DEG) | unk2
    slope_overlay_png(s2, unk2, out_dir / "overlays" / "slope.png")
    polys = nogo_polygons(g2, s2 > MAX_SLOPE_DEG)

    base_lon, base_lat, base_slope, base_vis = choose_base(g2, s2, unk2, stops_lonlat)

    # --- context terrain (CTX 20 m)
    gc = read_clip(ctx_dem, context)
    zc, unkc = fill_gaps(gc.z)
    gcf = Grid(zc, gc.west, gc.south, gc.east, gc.north)
    write_f32(out_dir / "terrain" / "height_ctx_20m.f32", gcf.z)
    (out_dir / "terrain" / "height_ctx_20m.json").write_text(json.dumps(gcf.meta("float32-le"), indent=2))

    def height_at(lon: float, lat: float) -> float:
        r, c = g2.rowcol(lon, lat)
        r = min(max(r, 0), g2.height - 1)
        c = min(max(c, 0), g2.width - 1)
        return float(g2.z[r, c])

    valid = s2[~unk2]
    return {
        "grid1m": g1f.meta("float32-le"),
        "grid2m": g2.meta("route"),
        "unknown_fraction_1m": float(unk1.mean()),
        "slope_stats": {
            "p50": float(np.percentile(valid, 50)), "p95": float(np.percentile(valid, 95)),
            "max": float(valid.max()),
            "care_fraction": float(((s2 >= COMFORT_SLOPE_DEG) & (s2 <= MAX_SLOPE_DEG) & ~unk2).mean()),
            "nogo_fraction": float(((s2 > MAX_SLOPE_DEG) & ~unk2).mean()),
        },
        "height_range": [float(np.nanmin(g1.z)), float(np.nanmax(g1.z))],
        "nogo_polygons": polys,
        "rover_check": check,
        "base": {"lon": base_lon, "lat": base_lat, "mean_slope_deg": base_slope, "radio_visible_fraction": base_vis,
                 "elev_m": height_at(base_lon, base_lat)},
        "height_at": height_at,
        "overlay_rect": [g2.west, g2.south, g2.east, g2.north],
    }
