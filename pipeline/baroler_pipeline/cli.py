"""Build a mission package:  uv run baroler-build --zone z1|z2 [--skip-tiles] [--skip-photos] [--walk-dem ctx]."""

from __future__ import annotations

import argparse
import json
import sys
import time

from . import config as C
from . import conditions, geology, package, photos, terrain, tiles


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def write_index() -> None:
    """data/package/index.json lists the zones that have a built package (the app's zone switcher)."""
    zones = []
    for z in C.ZONES.values():
        p = z.package_dir / "mission-package.json"
        if p.exists():
            pkg = json.loads(p.read_text())
            zones.append({"key": z.key, "code": z.code, "name": z.name, "path": f"{z.slug}/",
                          "title": pkg["title"], "description": z.description,
                          "stops": len(pkg["stops"]), "generatedAt": pkg["provenance"]["generatedAt"]})
    zones.sort(key=lambda x: x["code"])
    (C.PACKAGES / "index.json").write_text(json.dumps({"zones": zones, "default": "z2" if any(z["key"] == "z2" for z in zones) else zones[0]["key"]}, indent=1))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zone", choices=sorted(C.ZONES), default="z2", help="Which walk zone to build.")
    ap.add_argument("--walk-dem", choices=["hirise", "ctx"], default="hirise",
                    help="Terrain for the walk area. 'ctx' (20 m) is only for testing.")
    ap.add_argument("--skip-tiles", action="store_true", help="Do not download map tiles (reuse what is cached).")
    ap.add_argument("--skip-photos", action="store_true", help="Reuse photos from the last run.")
    args = ap.parse_args(argv)
    zone = C.ZONES[args.zone]
    log(f"Zone {zone.code}: {zone.name}")

    out = zone.package_dir
    out.mkdir(parents=True, exist_ok=True)
    raw_trek = C.RAW / "trek"
    hirise = C.RAW / "usgs" / "trn" / f"{C.TREK_DEM_LABEL}_{zone.key}-window.tif"
    ctx = raw_trek / f"{C.TREK_CTX_DEM_LABEL}.tif"
    walk_label = C.TREK_DEM_LABEL if args.walk_dem == "hirise" else C.TREK_CTX_DEM_LABEL
    walk_dem = hirise if args.walk_dem == "hirise" else ctx
    inputs: list[dict] = []
    stamp = package.now()
    if args.walk_dem == "hirise" and not hirise.exists():
        log("Terrain: reading the walk-area window of the HiRISE DEM (USGS copy, HTTP range reads)")
        info = terrain.fetch_window(C.USGS_TRN_DEM_URL, zone.aoi, hirise)
        log(f"  window {info['window']} of {info['remote']['width']}x{info['remote']['height']}")
    for f in (walk_dem, ctx):
        if not f.exists():
            print(f"Missing terrain file: {f}", file=sys.stderr)
            return 2

    # 1. photos first: the stop positions come from the rover waypoints (S1)
    cache = out / "photos-cache.json"
    if args.skip_photos and cache.exists():
        log("Photos: reusing last run")
        ph = json.loads(cache.read_text())
    else:
        log("Photos: rover waypoints (S1) + raw images (R5)")
        ph = photos.build(out, zone.stops, C.RAW / "nasa" / "M20_waypoints.json")
        cache.write_text(json.dumps(ph))
    log(f"  {len(ph['povImages'])} photos for {len(ph['stops'])} stops")
    inputs.append({"sourceId": "S1-m20-rover-waypoints", "url": photos.WAYPOINTS_URL, "retrievedAt": stamp,
                   "sha256": package.sha256(C.RAW / "nasa" / "M20_waypoints.json")})
    for p in ph["povImages"]:
        inputs.append({"sourceId": "R5-perseverance-raw-images", "url": p["urls"].get("medium", ""), "retrievedAt": stamp,
                       **({"sha256": package.sha256(out / p["urls"]["packagePath"])} if p["urls"].get("packagePath") else {})})

    by_rmc = {w["RMC"]: w for w in ph["waypoints"]}
    stop_pts = [(by_rmc[s.rmc]["lon"], by_rmc[s.rmc]["lat"]) for s in zone.stops]

    # 2. terrain
    log(f"Terrain: {walk_dem.name}")
    tr = terrain.build(out, walk_dem, ctx, zone.aoi, zone.context, C.ROUTE_CELL_M, stop_pts, ph["waypoints"])
    log(f"  rover check: {tr['rover_check']}")
    log(f"  grid {tr['grid1m']['width']}x{tr['grid1m']['height']} cells, unknown {tr['unknown_fraction_1m']:.1%}, "
        f"slope p50 {tr['slope_stats']['p50']:.1f} p95 {tr['slope_stats']['p95']:.1f} max {tr['slope_stats']['max']:.1f} deg, "
        f"no-go {tr['slope_stats']['nogo_fraction']:.1%}")
    log(f"  base at {tr['base']['lon']:.5f} E {tr['base']['lat']:.5f} N (mean slope {tr['base']['mean_slope_deg']:.1f} deg, "
        f"radio view of the walk {tr['base']['radio_visible_fraction']:.0%})")
    walk_url = C.USGS_TRN_DEM_URL if args.walk_dem == "hirise" else \
        f"https://trek.nasa.gov/mars/TrekWS/rest/cat/data/stream?label={walk_label}"
    inputs.append({"sourceId": "R1-mars-trek", "layerId": "dem-walk-1m", "url": walk_url,
                   "retrievedAt": stamp, "sha256": package.sha256(walk_dem)})
    inputs.append({"sourceId": "R1-mars-trek", "layerId": "dem-context-20m",
                   "url": f"https://trek.nasa.gov/mars/TrekWS/rest/cat/data/stream?label={C.TREK_CTX_DEM_LABEL}",
                   "retrievedAt": stamp, "sha256": package.sha256(ctx)})

    # 3. geology
    log("Rock types: USGS SIM 3464 (R2)")
    gdb = C.RAW / "usgs" / "sim3464" / "sim3464_JezeroNili_FINAL" / "Geodatabase" / "Nili.gdb"
    g2 = tr["grid2m"]
    geo = geology.build(out, gdb, zone.aoi, raster_rect=tuple(tr["overlay_rect"]), raster_size=(g2["width"], g2["height"]))
    log(f"  {geo['features']} areas, {len(geo['units'])} rock types")
    inputs.append({"sourceId": "R2-usgs-pgm", "layerId": "geology-sim3464",
                   "url": "https://pubs.usgs.gov/sim/3464/sim3464_database.zip", "retrievedAt": stamp,
                   "sha256": package.sha256(C.RAW / "usgs" / "sim3464_database.zip")})

    # 4. map tiles
    layers = C.tile_layers(zone)
    if args.skip_tiles:
        log("Tiles: skipped")
        tl = {t.key: {"requested": 0} for t in layers}
    else:
        log("Tiles: Mars Trek WMTS (R1)")
        tl = tiles.build(out, layers)
        for k, v in tl.items():
            log(f"  {k}: {v}")
    for t in layers:
        inputs.append({"sourceId": "R1-mars-trek", "layerId": f"tiles-{t.key}",
                       "url": f"{C.TREK_TILE_ROOT}/{t.label}/1.0.0/default/default028mm/{{z}}/{{y}}/{{x}}.{t.ext}",
                       "retrievedAt": stamp})

    # 5. conditions: weather (S4), daylight (computed), sun activity (S7; S3 when reachable)
    log("Conditions: Perseverance MEDA weather (S4), daylight, NOAA sun activity (S7)")
    ref = by_rmc[zone.stops[zone.weather_stop].rmc]
    cond = conditions.build(out, C.RAW, ref["lon"], ref["lat"], zone.weather_sols, zone.name)
    wd = cond["weather"]
    log(f"  weather sols {wd['sols'][0]}-{wd['sols'][-1]} ({wd['date_range']}), walk-hours air {wd['walk_hours_air_c']} C, "
        f"sunrise {wd['daylight']['days'][0]['sunrise_lmst']} sunset {wd['daylight']['days'][0]['sunset_lmst']} "
        f"(feed check max {wd['daylight']['check'].get('max_diff_min')} min, EOT check {wd['clock_check'].get('eot_max_diff_min')} min)")
    sw = cond["space"]
    log(f"  sun: flares 7 d {sw['noaa']['flares_7d']}, protons >=10 MeV {sw['noaa']['protons_10mev_latest_pfu']} pfu; DONKI {sw['donki']['status']}")
    for url, path in cond["files"]:
        sid = "S7-noaa-swpc" if "swpc.noaa.gov" in url else "S4-m20-meda-weather"
        inputs.append({"sourceId": sid, "url": url, "retrievedAt": stamp, "sha256": package.sha256(path)})

    # 6. package + checks
    log("Package: mission-package.json")
    res = package.build(out, tr, ph, geo, tl, inputs, walk_label, cond, zone)
    log(f"  {res['layers']} layers, {res['stops']} stops, {res['photos']} photos, {res['hazards']} no-go areas, "
        f"{res['roverWaypoints']} rover points")
    if res["errors"]:
        for e in res["errors"]:
            print("  CHECK FAILED:", e, file=sys.stderr)
        return 1
    write_index()
    log("  all checks passed; zone index updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
