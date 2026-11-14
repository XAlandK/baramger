"""Assemble and check the offline mission package (mission-package.json)."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from jsonschema import Draft202012Validator

from . import config as C
from .geology import OFFSET_NOTE, unit_at

SCHEMA_VERSION = "0.1.0"
USED_SOURCES = ("R1-mars-trek", "R2-usgs-pgm", "R3-curiosity-route-map", "R4-nasa-worldview",
                "R5-perseverance-raw-images", "S1-m20-rover-waypoints", "S4-m20-meda-weather", "S7-noaa-swpc")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _rover_check_text(c: dict) -> str:
    if not c.get("points"):
        return "Not yet checked against rover measurements."
    return (f"Checked at {c['points']} Perseverance positions: slope minus rover-measured tilt "
            f"{c['slope_minus_tilt_median_deg']:+.1f} deg median, {c['slope_minus_tilt_mae_deg']:.1f} deg mean error. "
            f"Map height minus rover height {c['height_diff_median_m']:+.2f} m median "
            f"(rover heights likely use the same map, so this shows agreement only).")


def _layers(terrain: dict, tiles: dict, walk_dem_label: str, geo_units: list[dict], zone: C.Zone) -> list[dict]:
    layers: list[dict] = []
    for t in C.tile_layers(zone):
        layers.append({
            "id": f"tiles-{t.key}", "title": t.title, "sourceId": "R1-mars-trek", "dataKind": t.data_kind,
            "productId": t.label, **({"resolution_m": t.resolution_m} if t.resolution_m else {}),
            **({"coverage": list(t.bbox)} if t.bbox else {}),
            "access": {"type": "package_file", "urlTemplate": f"tiles/{t.key}/{{z}}/{{x}}/{{y}}.{t.ext}",
                       "tileMatrixSet": "default028mm", "format": f"image/{'jpeg' if t.ext == 'jpg' else 'png'}",
                       "minLevel": t.levels[0], "maxLevel": t.levels[1],
                       "downloadUrl": f"{C.TREK_TILE_ROOT}/{t.label}/1.0.0/default/default028mm/{{z}}/{{y}}/{{x}}.{t.ext}"},
            "attribution": t.attribution,
            "caveats": [f"Cached tiles: {tiles.get(t.key, {}).get('ok', 0) + tiles.get(t.key, {}).get('cached', 0)} of {tiles.get(t.key, {}).get('requested', 0)} requested"],
        })
    g1, g2 = terrain["grid1m"], terrain["grid2m"]
    aoi = [g1["west"], g1["south"], g1["east"], g1["north"]]
    layers += [
        {"id": "dem-walk-1m", "title": "Walk-area terrain (HiRISE DEM)", "sourceId": "R1-mars-trek", "dataKind": "topographic",
         "mission": "Mars Reconnaissance Orbiter", "instrument": "HiRISE" if "hirise" in walk_dem_label else "CTX",
         "productId": walk_dem_label, "resolution_m": round(g1["dyM"], 3), "coverage": aoi,
         "access": {"type": "package_file", "packagePath": "terrain/height_1m.f32", "format": "float32 little-endian, rows north to south"},
         "values": {"meaning": "elevation", "unit": "m", "reference": "MOLA areoid"},
         "attribution": "NASA/JPL-Caltech/University of Arizona (HiRISE), via Mars Trek"},
        {"id": "dem-context-20m", "title": "Context terrain (CTX DEM)", "sourceId": "R1-mars-trek", "dataKind": "topographic",
         "mission": "Mars Reconnaissance Orbiter", "instrument": "CTX", "productId": C.TREK_CTX_DEM_LABEL, "resolution_m": 20,
         "coverage": list(zone.context),
         "access": {"type": "package_file", "packagePath": "terrain/height_ctx_20m.f32", "format": "float32 little-endian, rows north to south"},
         "values": {"meaning": "elevation", "unit": "m", "reference": "MOLA areoid"},
         "attribution": "NASA/JPL-Caltech/MSSS (CTX), via Mars Trek"},
        {"id": "slope-2m", "title": "Steep ground", "sourceId": "R1-mars-trek", "dataKind": "derived",
         "resolution_m": round(g2["dyM"], 3), "coverage": [g2["west"], g2["south"], g2["east"], g2["north"]],
         "derivedFrom": ["dem-walk-1m"],
         "process": "Mean heights on a ~2 m grid, smoothed 3x3 (~6 m baseline); slope from central differences. "
                    "Yellow 15-25 deg, red > 25 deg.",
         "caveats": [_rover_check_text(terrain.get("rover_check", {}))],
         "access": {"type": "package_file", "packagePath": "overlays/slope.png", "format": "image/png"},
         "values": {"meaning": "slope class", "unit": "deg"},
         "display": {"defaultVisible": True, "opacity": 0.8, "views": ["plan"],
                     "legend": [{"label": "Take care (15-25 deg)", "color": "#ECB026"}, {"label": "No-go (over 25 deg)", "color": "#D63027"}]},
         "attribution": "Derived by Baroler from the HiRISE DEM (Mars Trek)"},
        {"id": "routing-grid-2m", "title": "Routing grid", "sourceId": "R1-mars-trek", "dataKind": "derived",
         "resolution_m": round(g2["dyM"], 3), "derivedFrom": ["dem-walk-1m"],
         "process": "2 m heights, slope (whole degrees) and roughness (cm) used by the route finder and the radio check.",
         "access": {"type": "package_file", "packagePath": "route/grid.json", "format": "JSON + binary grids"},
         "attribution": "Derived by Baroler from the HiRISE DEM (Mars Trek)"},
        {"id": "geology-sim3464", "title": "Rock types (USGS SIM 3464)", "sourceId": "R2-usgs-pgm", "dataKind": "geologic",
         "mapScale": "1:75,000", "coverage": [g2["west"], g2["south"], g2["east"], g2["north"]],
         "access": {"type": "package_file", "packagePath": "overlays/geology.png", "format": "image/png"},
         "process": "Units clipped and reprojected from the SIM 3464 geodatabase; drawn as an image. "
                    "Vector shapes for look-ups: geology/units.geojson.",
         "display": {"defaultVisible": False, "opacity": 0.7, "views": ["plan"],
                     "legend": [{"label": f"{u['symbol']}: {u['name']}", "color": u["color"]} for u in geo_units]},
         "attribution": "Sun, V.Z., and Stack, K.M., 2020, USGS SIM 3464 (public domain)",
         "caveats": [OFFSET_NOTE]},
    ]
    return layers


def _check_refs(pkg: dict) -> list[str]:
    errs: list[str] = []
    src = {s["id"] for s in pkg["sources"]}
    lay = {l["id"] for l in pkg["layers"]}
    pov = {p["imageId"] for p in pkg["povImages"]}
    obj = {o["id"] for o in pkg["objectives"]}
    for l in pkg["layers"]:
        if l["sourceId"] not in src:
            errs.append(f"layer {l['id']}: unknown source {l['sourceId']}")
        for d in l.get("derivedFrom", []):
            if d not in lay:
                errs.append(f"layer {l['id']}: unknown derivedFrom {d}")
    kinds = {l["dataKind"] for l in pkg["layers"] if l["dataKind"] != "derived"}
    if len(kinds) < 3:
        errs.append(f"only {len(kinds)} data kinds: {sorted(kinds)}")
    for s in pkg["stops"]:
        for i in s.get("povImageIds", []):
            if i not in pov:
                errs.append(f"stop {s['id']}: unknown photo {i}")
        for o in s.get("objectiveIds", []):
            if o not in obj:
                errs.append(f"stop {s['id']}: unknown objective {o}")
        w, so, e, n = pkg["site"]["aoi"]
        p = s["position"]
        if not (w <= p["lon"] <= e and so <= p["lat"] <= n):
            errs.append(f"stop {s['id']} is outside the area")
    for h in pkg["hazards"]:
        for ev in h["evidence"]:
            if ev["layerId"] not in lay:
                errs.append(f"hazard {h['id']}: unknown layer {ev['layerId']}")
    used = {l["sourceId"] for l in pkg["layers"]} | {p["sourceId"] for p in pkg["povImages"]} \
        | {s["sourceId"] for s in pkg.get("roverWaypoints", [])}
    roles = {s["id"]: s["role"] for s in pkg["sources"]}
    for rid in ("R1-mars-trek", "R2-usgs-pgm", "R3-curiosity-route-map", "R4-nasa-worldview", "R5-perseverance-raw-images"):
        if rid not in used and roles.get(rid) == "primary_data":
            errs.append(f"{rid} is listed but no layer or photo uses it")
    return errs


def _condition_layers(cond: dict) -> list[dict]:
    w, s = cond["weather"], cond["space"]
    d = w["daylight"]
    return [
        {"id": "weather-meda", "title": "Weather measured here (Perseverance MEDA)", "sourceId": "S4-m20-meda-weather",
         "dataKind": "atmospheric", "mission": "Mars 2020", "instrument": "MEDA (TIRS, PS)",
         "access": {"type": "package_file", "packagePath": "conditions/weather.json", "format": "JSON"},
         "values": {"meaning": "air and ground temperature, pressure; sunrise and sunset", "unit": "deg C, Pa, LMST"},
         "process": f"Daily min/max and hourly medians over sols {w['sols'][0]}-{w['sols'][-1]}. "
                    f"Sunrise/sunset computed with Mars24 equations (checked: within {d['check'].get('max_diff_min')} min of the "
                    f"rover's feed; equation of time within {w['clock_check'].get('eot_max_diff_min')} min of MEDA's clocks).",
         "attribution": "NASA/JPL-Caltech/CAB (MEDA), NASA PDS Atmospheres node",
         "caveats": [f"Reference conditions from {w['date_range']}, when Perseverance was here; not today's weather."]},
        {"id": "space-weather-noaa", "title": "Sun activity (NOAA GOES)", "sourceId": "S7-noaa-swpc", "dataKind": "radiation",
         "access": {"type": "package_file", "packagePath": "conditions/space-weather.json", "format": "JSON"},
         "values": {"meaning": "solar flares (7 days) and >=10 MeV proton level (3 days)", "unit": "flare class, pfu"},
         "attribution": "NOAA Space Weather Prediction Center (GOES)",
         "caveats": [s["noaa"]["where_measured"], f"Retrieved {s['retrieved_utc']}.",
                     f"NASA DONKI (S3): {s['donki']['status']} at build time."]},
    ]


def build(out_dir: Path, terrain: dict, photos: dict, geo: dict, tiles: dict, inputs: list[dict],
          walk_dem_label: str, cond: dict, zone: C.Zone) -> dict:
    registry = json.loads(C.REGISTRY.read_text())
    used = USED_SOURCES + (("S3-nasa-donki",) if cond["space"]["donki"]["status"] == "ok" else ())
    sources = [s for s in registry["sources"] if s["id"] in used]

    by_rmc = {w["RMC"]: w for w in photos["waypoints"]}
    stops = []
    for spec in zone.stops:
        wp = by_rmc[spec.rmc]
        unit = unit_at(geo, wp["lon"], wp["lat"])
        sols = f"sol {spec.sols[0]}" if spec.sols[0] == spec.sols[1] else f"sols {spec.sols[0]}-{spec.sols[1]}"
        ev = photos["stops"][spec.id].get("evidence", {})
        evidence = f" The rover's tube-handling camera (CacheCam) took {ev['CACHECAM']} photos here." if ev.get("CACHECAM") else ""
        stops.append({
            "id": spec.id, "name": spec.name,
            "kind": "sample" if any("sample" in t.lower() or "tube" in t.lower() for t in spec.tasks) else "science",
            "position": {"lon": round(wp["lon"], 7), "lat": round(wp["lat"], 7),
                         "elev_m": round(terrain["height_at"](wp["lon"], wp["lat"]), 2)},
            "plannedMinutes": spec.minutes, "tasks": list(spec.tasks), "objectiveIds": list(spec.objective_ids),
            **({"geologicUnit": f"{unit['symbol']}: {unit['name']}"} if unit else {}),
            "povImageIds": photos["stops"][spec.id]["povImageIds"],
            "notes": (f"{spec.note} " if spec.note else "")
                     + f"Perseverance stood here ({sols}; rover site {spec.rmc.split('_')[0]}, drive {spec.rmc.split('_')[1]})."
                     + evidence,
        })

    b = terrain["base"]
    centre = stops[zone.weather_stop]["position"]
    site = {
        "id": zone.slug, "name": zone.site_name, "region": "Jezero crater",
        "center": {"lon": centre["lon"], "lat": centre["lat"]},
        "aoi": [round(v, 7) for v in terrain["overlay_rect"]],
        "description": zone.description,
        "objectiveIds": [o["id"] for o in zone.objectives],
        "base": {"kind": "habitat", "position": {"lon": round(b["lon"], 7), "lat": round(b["lat"], 7), "elev_m": round(b["elev_m"], 2)},
                 "antennaHeight_m": C.BASE_ANTENNA_M},
    }

    hazards = []
    for i, p in enumerate(terrain["nogo_polygons"], 1):
        ring = [[round(x, 7), round(y, 7)] for x, y in p["geometry"]["coordinates"][0]]
        hazards.append({
            "id": f"nogo-{i:03d}", "type": "steep_slope", "severity": "no_go",
            "geometry": {"type": "Polygon", "coordinates": [ring]},
            "message": "Too steep (over 25 deg). Do not walk here.",
            "evidence": [{"layerId": "slope-2m", "value": round(p["area_m2"], 1), "unit": "m2",
                          "method": "Area of ground steeper than 25 deg (A2) on the 2 m grid"}],
        })

    w, s, e, n = site["aoi"]
    rover_wps = [{
        "rmc": wp["RMC"], "site": int(wp["site"]), "drive": int(wp["drive"]), "sol": int(wp["sol"]),
        "position": {"lon": round(wp["lon"], 7), "lat": round(wp["lat"], 7), "elev_m": round(wp["elev_geoid"], 2)},
        "yaw_deg": round(float(wp.get("yaw", 0)), 2), "distTotal_m": round(float(wp.get("dist_total_m", 0)), 1),
        "note": str(wp.get("Note", "")), "sourceId": "S1-m20-rover-waypoints",
    } for wp in photos["waypoints"] if w <= wp["lon"] <= e and s <= wp["lat"] <= n]

    povs = [{k: v for k, v in p.items() if not k.startswith("_")} for p in photos["povImages"]]
    for p in povs:
        if not p["pointing"]:
            p.pop("pointing")
        if not p["cameraModel"]:
            p.pop("cameraModel")

    pkg = {
        "kind": "mission-package", "schemaVersion": SCHEMA_VERSION, "id": zone.slug,
        "title": zone.title,
        "crs": {"body": "Mars", "datum": "Mars_2000_Sphere_IAU", "authority": "IAU_2015:49900", "radius_m": 3396190,
                "lonConvention": "planetocentric-east-180", "elevationReference": "MOLA-areoid"},
        "sources": sources,
        "layers": _layers(terrain, tiles, walk_dem_label, geo["units"], zone) + _condition_layers(cond),
        "site": site,
        "objectives": [dict(o, layerIds=["tiles-hirise", "geology-sim3464"]) for o in zone.objectives],
        "stops": stops,
        "routes": [],
        "hazards": hazards,
        "povImages": povs,
        "roverWaypoints": rover_wps,
        "assumptions": [dict(a) for a in C.ASSUMPTIONS + zone.extra_assumptions],
        "provenance": {"generatedAt": now(), "generator": "baroler-pipeline 0.1.0", "inputs": inputs},
    }

    schema = json.loads(C.SCHEMA.read_text())
    errors = [f"{list(e.absolute_path)}: {e.message[:200]}" for e in Draft202012Validator(schema).iter_errors(pkg)]
    errors += _check_refs(pkg)
    (out_dir / "mission-package.json").write_text(json.dumps(pkg, indent=1))
    return {"errors": errors, "stops": len(stops), "photos": len(povs), "hazards": len(hazards),
            "roverWaypoints": len(rover_wps), "layers": len(pkg["layers"])}
