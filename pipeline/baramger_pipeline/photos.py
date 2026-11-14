"""Ground photos: Perseverance raw images (R5) placed with rover waypoints (S1).

Join key: raw image `site` + `drive`  ->  waypoint `RMC` = "<site>_<drive>".
Only full-frame images are used. Medium (800 px) copies are saved for offline use.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .config import StopSpec

UA = {"User-Agent": "baramger-pipeline/0.1 (educational hackathon project)"}
RAW_API = "https://mars.nasa.gov/rss/api/"
WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"

# Cameras that show what a person would see, in order of preference.
VIEW_CAMS = ("NAVCAM_LEFT", "MCZ_LEFT", "MCZ_RIGHT", "NAVCAM_RIGHT", "FRONT_HAZCAM_LEFT_A")
CLOSE_CAMS = ("SHERLOC_WATSON", "SUPERCAM_RMI")


def _get_json(url: str, retries: int = 3) -> dict:
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # network hiccup: retry with backoff
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"GET failed: {url}: {last}")


def fetch_waypoints(cache: Path) -> list[dict]:
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(WAYPOINTS_URL, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            cache.write_bytes(r.read())
    feats = json.loads(cache.read_text())["features"]
    return [f["properties"] for f in feats]


def raw_images_for_sol(sol: int, max_pages: int = 8) -> list[dict]:
    out: list[dict] = []
    for page in range(max_pages):
        q = {
            "feed": "raw_images", "category": "mars2020", "feedtype": "json", "ver": "1.2",
            "num": "100", "page": str(page), "order": "sol desc",
            "condition_2": f"{sol}:sol:gte", "condition_3": f"{sol}:sol:lte",
            "extended": "sample_type::full,",
        }
        d = _get_json(RAW_API + "?" + urllib.parse.urlencode(q))
        imgs = d.get("images") or []
        out.extend(imgs)
        if len(imgs) < 100:
            break
    return out


def _f(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_pov(img: dict, stop: StopSpec, wp: dict, kind: str) -> dict:
    ext = img.get("extended") or {}
    cam = img.get("camera") or {}
    files = img.get("image_files") or {}
    caption = (img.get("caption") or "").strip().split("\n")[0][:300]
    pov = {
        "imageId": img["imageid"],
        "sourceId": "R5-perseverance-raw-images",
        "sol": int(img["sol"]),
        "instrument": cam.get("instrument", "UNKNOWN"),
        "takenUtc": img.get("date_taken_utc", ""),
        "takenMars": img.get("date_taken_mars", ""),
        "sampleType": img.get("sample_type", ""),
        "urls": {k2: files[k1] for k1, k2 in (("small", "small"), ("medium", "medium"), ("large", "large"), ("full_res", "full")) if files.get(k1)},
        "credit": img.get("credit") or "NASA/JPL-Caltech",
        "caption": caption,
        "rover": {
            "site": int(img["site"]), "drive": int(img["drive"]), "rmc": wp["RMC"],
            "position": {"lon": round(wp["lon"], 7), "lat": round(wp["lat"], 7), "elev_m": round(wp["elev_geoid"], 2)},
            "yaw_deg": round(float(wp.get("yaw", 0.0)), 2),
        },
        "pointing": {},
        "cameraModel": {},
        "link": {"stopId": stop.id, "distance_m": 0.0},
        "poseSource": "waypoint_join",
    }
    az, el = _f(ext.get("mastAz")), _f(ext.get("mastEl"))
    if az is not None:
        pov["pointing"]["mastAz_deg"] = round(az, 2)
    if el is not None:
        pov["pointing"]["mastEl_deg"] = round(el, 2)
    if cam.get("camera_model_type") and cam.get("camera_model_type") != "UNK":
        pov["cameraModel"] = {"type": cam["camera_model_type"], "components": cam.get("camera_model_component_list", "")}
    pov["_kind"] = kind  # view | closeup (removed before packaging)
    return pov


def pick_images(imgs: list[dict], site: int, drive: int, n_view: int = 3, n_close: int = 1) -> list[tuple[dict, str]]:
    here = [i for i in imgs if str(i.get("site")) == str(site) and str(i.get("drive")) == str(drive)]
    views = []
    for cam in VIEW_CAMS:
        for i in here:
            if (i.get("camera") or {}).get("instrument") != cam:
                continue
            el = _f((i.get("extended") or {}).get("mastEl"))
            if el is not None and -25 <= el <= 10:
                views.append(i)
    # spread views around the horizon: keep images whose azimuths differ by >= 40 deg
    chosen: list[dict] = []
    for i in views:
        az = _f((i.get("extended") or {}).get("mastAz")) or 0.0
        if all(abs(((az - (_f((c.get("extended") or {}).get("mastAz")) or 0.0)) + 180) % 360 - 180) >= 40 for c in chosen):
            chosen.append(i)
        if len(chosen) >= n_view:
            break
    closes = [i for i in here if (i.get("camera") or {}).get("instrument") in CLOSE_CAMS][:n_close]
    return [(i, "view") for i in chosen] + [(i, "closeup") for i in closes]


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        dest.write_bytes(r.read())


def build(out_dir: Path, stops: tuple[StopSpec, ...], waypoint_cache: Path) -> dict:
    (out_dir / "photos").mkdir(parents=True, exist_ok=True)
    wps = fetch_waypoints(waypoint_cache)
    by_rmc = {w["RMC"]: w for w in wps}
    result = {"stops": {}, "povImages": [], "waypoints": wps, "queries": []}
    for stop in stops:
        wp = by_rmc.get(stop.rmc)
        if wp is None:
            raise ValueError(f"Waypoint {stop.rmc} not found for {stop.id}")
        site, drive = (int(x) for x in stop.rmc.split("_"))
        picked: list[tuple[dict, str]] = []
        evidence: dict[str, int] = {}
        for sol in range(stop.sols[0], stop.sols[1] + 1):
            imgs = raw_images_for_sol(sol)
            result["queries"].append({"sol": sol, "images": len(imgs)})
            # what the rover's cameras did at this exact spot (e.g. CACHECAM = sample-tube handling camera)
            for i in imgs:
                if str(i.get("site")) == str(site) and str(i.get("drive")) == str(drive):
                    cam = (i.get("camera") or {}).get("instrument", "?")
                    evidence[cam] = evidence.get(cam, 0) + 1
            have_ids = {p[0]["imageid"] for p in picked}
            more = [p for p in pick_images(imgs, site, drive) if p[0]["imageid"] not in have_ids]
            n_view = sum(1 for _, k in picked if k == "view")
            n_close = sum(1 for _, k in picked if k == "closeup")
            for img, kind in more:
                if kind == "view" and n_view < 3:
                    picked.append((img, kind)); n_view += 1
                elif kind == "closeup" and n_close < 1:
                    picked.append((img, kind)); n_close += 1
        povs = []
        for img, kind in picked:
            pov = to_pov(img, stop, wp, kind)
            med = pov["urls"].get("medium") or pov["urls"].get("large")
            if med:
                fname = f"{pov['imageId']}.jpg"
                download(med, out_dir / "photos" / fname)
                pov["urls"]["packagePath"] = f"photos/{fname}"
            povs.append(pov)
        result["stops"][stop.id] = {"waypoint": wp, "povImageIds": [p["imageId"] for p in povs], "evidence": evidence}
        result["povImages"].extend(povs)
    return result
