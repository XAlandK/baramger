"""Cache Mars Trek WMTS tiles (R1) for the area so the app works offline.

Mars Trek's "default028mm" tile matrix set is a geographic grid:
level 0 = 2 x 1 tiles of 180 degrees, and each level doubles both counts.
Saved as tiles/<key>/<z>/<x>/<y>.<ext> (x = column from 180 W, y = row from 90 N),
which is what CesiumJS's GeographicTilingScheme + UrlTemplateImageryProvider read.
"""

from __future__ import annotations

import math
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .config import TREK_TILE_ROOT, TileLayer

UA = {"User-Agent": "baroler-pipeline/0.1 (educational hackathon project)"}


def tile_deg(level: int) -> float:
    return 180.0 / (2 ** level)


def tile_range(bbox: tuple[float, float, float, float] | None, level: int) -> tuple[range, range]:
    """Columns and rows that cover bbox (minLon, minLat, maxLon, maxLat) at a level."""
    cols_total, rows_total = 2 ** (level + 1), 2 ** level
    if bbox is None:
        return range(cols_total), range(rows_total)
    w, s, e, n = bbox
    d = tile_deg(level)
    c0 = max(0, math.floor((w + 180.0) / d))
    c1 = min(cols_total - 1, math.floor((e + 180.0) / d))
    r0 = max(0, math.floor((90.0 - n) / d))
    r1 = min(rows_total - 1, math.floor((90.0 - s) / d))
    return range(c0, c1 + 1), range(r0, r1 + 1)


def tile_url(layer: TileLayer, z: int, x: int, y: int) -> str:
    return f"{TREK_TILE_ROOT}/{layer.label}/1.0.0/default/default028mm/{z}/{y}/{x}.{layer.ext}"


def _fetch(args) -> tuple[str, int]:
    url, dest = args
    if dest.exists() and dest.stat().st_size > 0:
        return "cached", dest.stat().st_size
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        return ("missing" if e.code == 404 else f"http{e.code}"), 0
    except Exception:
        return "error", 0
    if not data:
        return "missing", 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return "ok", len(data)


def build(out_dir: Path, layers: tuple[TileLayer, ...], workers: int = 6) -> dict:
    summary = {}
    for layer in layers:
        jobs = []
        for z in range(layer.levels[0], layer.levels[1] + 1):
            cols, rows = tile_range(layer.bbox, z)
            for x in cols:
                for y in rows:
                    dest = out_dir / "tiles" / layer.key / str(z) / str(x) / f"{y}.{layer.ext}"
                    jobs.append((tile_url(layer, z, x, y), dest))
        counts: dict[str, int] = {}
        nbytes = 0
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for status, size in ex.map(_fetch, jobs):
                counts[status] = counts.get(status, 0) + 1
                nbytes += size
        summary[layer.key] = {"requested": len(jobs), "bytes": nbytes, **counts}
    return summary
