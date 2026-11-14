"""Rock types: USGS SIM 3464 geologic units (R2), clipped to the walk area.

The map is in Mars Transverse Mercator (central meridian 77.5 E) on the Mars 2000
sphere. We reproject to longitude/latitude on the same sphere.
Caveat from the USGS readme: unit borders can be 100-200 m off compared with the
controlled CTX/HiRISE mosaics, because the map was drawn on a semi-controlled mosaic.
"""

from __future__ import annotations

import colorsys
import hashlib
import json
import re
from pathlib import Path

import numpy as np
import pyogrio
from pyproj import CRS, Transformer
from shapely import box, make_valid, transform as shp_transform
from shapely.geometry import mapping, shape

GEOG_MARS = CRS.from_proj4("+proj=longlat +R=3396190 +no_defs +type=crs")
OFFSET_NOTE = "Rock-type borders may be 100-200 m off (USGS SIM 3464 readme)."


# Distinct categorical colours (our own palette, not the USGS sheet colours).
PALETTE = ("#3B8EA5", "#E09F3E", "#8E6AC8", "#5BAE5B", "#D1495B", "#C2A83E", "#4F6D7A", "#E07BB5", "#7FB7BE", "#A26769")


def unit_color(symbol: str, order: dict[str, int] | None = None) -> str:
    """Colour per unit symbol: palette position by sorted order, hash as a fallback."""
    if order is not None and symbol in order:
        return PALETTE[order[symbol] % len(PALETTE)]
    h = int(hashlib.sha1(symbol.encode()).hexdigest()[:6], 16) / 0xFFFFFF
    r, g, b = colorsys.hls_to_rgb(h, 0.55, 0.55)
    return "#{:02x}{:02x}{:02x}".format(int(r * 255), int(g * 255), int(b * 255))


def rasterize_png(feats: list[dict], units: dict[str, dict], rect: tuple[float, float, float, float],
                  size: tuple[int, int], path: Path, alpha: int = 150) -> None:
    """Draw the units as a transparent PNG over rect (w, s, e, n); darker 1-px borders between units."""
    from affine import Affine
    from PIL import Image
    from rasterio import features as rfeatures

    w, s, e, n = rect
    width, height = size
    tf = Affine((e - w) / width, 0, w, 0, -(n - s) / height, n)
    syms = sorted(units)
    idx = {sym: i + 1 for i, sym in enumerate(syms)}
    grid = rfeatures.rasterize(((f["geometry"], idx[f["properties"]["symbol"]]) for f in feats),
                               out_shape=(height, width), transform=tf, fill=0, dtype="uint8")
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    for sym, i in idx.items():
        c = units[sym]["color"].lstrip("#")
        rgba[grid == i] = (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), alpha)
    edge = np.zeros_like(grid, dtype=bool)
    edge[:, 1:] |= grid[:, 1:] != grid[:, :-1]
    edge[1:, :] |= grid[1:, :] != grid[:-1, :]
    rgba[edge & (grid > 0)] = (30, 30, 30, 220)
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)


def build(out_dir: Path, gdb: Path, aoi: tuple[float, float, float, float], margin_deg: float = 0.004,
          raster_rect: tuple[float, float, float, float] | None = None, raster_size: tuple[int, int] | None = None) -> dict:
    (out_dir / "geology").mkdir(parents=True, exist_ok=True)
    meta = pyogrio.read_info(gdb, layer="GeoUnits_v1")
    src_crs = CRS.from_wkt(meta["crs"]) if meta["crs"].startswith(("PROJCS", "PROJCRS")) else CRS.from_user_input(meta["crs"])
    to_ll = Transformer.from_crs(src_crs, GEOG_MARS, always_xy=True)
    to_src = Transformer.from_crs(GEOG_MARS, src_crs, always_xy=True)

    w, s, e, n = aoi
    w, s, e, n = w - margin_deg, s - margin_deg, e + margin_deg, n + margin_deg
    xs, ys = to_src.transform([w, e, e, w], [s, s, n, n])
    bbox_src = (min(xs), min(ys), max(xs), max(ys))

    table = pyogrio.read_dataframe(gdb, layer="GeoUnits_v1", bbox=bbox_src) if _has_geopandas() else None
    if table is None:
        geoms, fields = _read_raw(gdb, bbox_src)
    else:  # pragma: no cover - geopandas path not used by default
        geoms, fields = list(table.geometry), table.drop(columns="geometry").to_dict("records")

    clip = box(w, s, e, n)
    feats = []
    units: dict[str, dict] = {}

    def fn(coords: np.ndarray) -> np.ndarray:
        x, y = to_ll.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([x, y])

    for geom, props in zip(geoms, fields):
        if geom is None:
            continue
        g = make_valid(shp_transform(geom, fn))
        g = g.intersection(clip)
        if g.is_empty or g.area <= 0:
            continue
        g = g.simplify(0.00001, preserve_topology=True)  # ~0.6 m
        sym = str(props.get("symbol") or props.get("unit") or "?")
        name = str(props.get("name") or sym)
        col = unit_color(sym)
        units.setdefault(sym, {"symbol": sym, "name": name, "color": col})
        feats.append({"type": "Feature", "geometry": mapping(g),
                      "properties": {"unit": str(props.get("unit") or sym), "symbol": sym, "name": name, "color": col}})

    order = {sym: i for i, sym in enumerate(sorted(units))}
    for sym, u in units.items():
        u["color"] = unit_color(sym, order)
    for f in feats:
        f["properties"]["color"] = units[f["properties"]["symbol"]]["color"]

    fc = {"type": "FeatureCollection", "name": "SIM3464 geologic units (clipped)",
          "crs_note": "lon/lat degrees on the Mars 2000 sphere (R = 3,396,190 m); not WGS 84",
          "caveat": OFFSET_NOTE, "features": feats}
    (out_dir / "geology" / "units.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    if raster_rect and raster_size:
        (out_dir / "overlays").mkdir(parents=True, exist_ok=True)
        rasterize_png(feats, units, raster_rect, raster_size, out_dir / "overlays" / "geology.png")
    return {"features": len(feats), "units": sorted(units.values(), key=lambda u: u["symbol"]),
            "geoms": [(shape(f["geometry"]), f["properties"]) for f in feats]}


def unit_at(geo: dict, lon: float, lat: float) -> dict | None:
    from shapely.geometry import Point
    p = Point(lon, lat)
    for g, props in geo["geoms"]:
        if g.contains(p):
            return props
    return None


def _has_geopandas() -> bool:
    try:
        import geopandas  # noqa: F401
        return True
    except ImportError:
        return False


def clean_label(text: str) -> str:
    """A label as the map prints it, as a plain name.

    Large names are printed with spaces between the letters: 'J  E  Z  E  R  O' is 'Jezero' and
    'N   I   L   I      P   L   A   N   U   M' is 'Nili Planum' (the longer gap is the word break).
    """
    text = re.sub(r"</?[A-Za-z]{1,6}>", "", text)  # ArcGIS format tags such as <ITA>...</ITA>
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) > 1:  # a name stacked on two lines: a line break is a word break
        return " ".join(clean_label(line) for line in lines)
    parts = re.split(r"(\s+)", text.strip())
    letters, gaps = parts[0::2], parts[1::2]
    # three or more single letters: a spaced-out name ("A B" could also be two one-letter words)
    if len(letters) >= 3 and all(len(x) == 1 for x in letters):
        usual = sorted(len(g) for g in gaps)[len(gaps) // 2]  # the usual gap between two letters
        spelled = letters[0]
        for gap, letter in zip(gaps, letters[1:]):
            # a word break is a clearly longer gap (half as long again, or more); a gap that is only
            # a little uneven stays inside the word
            spelled += (" " if len(gap) >= 1.5 * usual else "") + letter
        return " ".join(word.capitalize() for word in spelled.split(" "))
    return " ".join(text.split())


def place_names(gdb: Path) -> list[dict]:
    """Official place names, read from the labels USGS printed on SIM 3464 (layer 'Nomenclature', R2).

    The position is the middle of the printed label, which the map maker put on or beside the
    feature: good enough to name the place from far away, not a surveyed centre.
    """
    import shapely
    meta, _, geometry, field_data = pyogrio.raw.read(gdb, layer="Nomenclature")[:4]
    crs = meta["crs"]
    src_crs = CRS.from_wkt(crs) if crs.startswith(("PROJCS", "PROJCRS")) else CRS.from_user_input(crs)
    to_ll = Transformer.from_crs(src_crs, GEOG_MARS, always_xy=True)
    fields = list(meta["fields"])
    texts, sizes = field_data[fields.index("TextString")], field_data[fields.index("FontSize")]
    out = []
    for geom, text, size in zip(shapely.from_wkb(geometry), texts, sizes):
        if geom is None or not isinstance(text, str) or not text.strip():  # an empty label is not a name
            continue
        c = geom.centroid
        lon, lat = to_ll.transform(c.x, c.y)
        out.append({"name": clean_label(text), "position": {"lon": round(float(lon), 5), "lat": round(float(lat), 5)},
                    # the map prints the names of large features in large letters
                    "rank": "major" if float(size) >= 20 else "minor", "sourceId": "R2-usgs-pgm"})
    return sorted(out, key=lambda n: (n["rank"] != "major", n["name"]))


def _read_raw(gdb: Path, bbox_src) -> tuple[list, list[dict]]:
    """Read geometries + attributes without geopandas."""
    import shapely
    res = pyogrio.raw.read(gdb, layer="GeoUnits_v1", bbox=bbox_src)
    meta, _, geometry, field_data = res[0], res[1], res[2], res[3]
    geoms = list(shapely.from_wkb(geometry))
    names = list(meta["fields"])
    rows = [{names[j]: (v.item() if hasattr(v, "item") else v) for j, v in enumerate(vals)} for vals in zip(*field_data)]
    return geoms, rows
