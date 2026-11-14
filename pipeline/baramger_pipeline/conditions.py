"""Conditions for the walk: weather (S4), daylight (computed), sun activity (S7 / S3).

- Weather: Perseverance MEDA measurements from NASA PDS (Atmospheres node), for the sols the rover
  was in the walk zone. These are real reference conditions for this place and season.
- Daylight: sunrise/sunset in local mean solar time, computed with the NASA GISS Mars24 equations
  (Allison & McEwen 2000) and checked against Perseverance's own weather feed.
- Sun activity: NOAA SWPC GOES measurements (near Earth). NASA DONKI is tried first when reachable.
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

UA = {"User-Agent": "baramger-pipeline/0.1 (educational hackathon project)"}
PDS_MEDA = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
M2020_WEATHER_FEED = "https://mars.nasa.gov/rss/api/?feed=weather&category=mars2020&feedtype=json&ver=1.0"
NOAA_FLARES = "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json"
NOAA_PROTONS = "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-3-day.json"
DONKI_KAUAI = "https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/{kind}?startDate={start}&endDate={end}"
DONKI_API = "https://api.nasa.gov/DONKI/{kind}?startDate={start}&endDate={end}&api_key={key}"

M2020_SOL0_MSD = 52304          # Perseverance sol N starts at local midnight of Mars Sol Date N + 52304
SCLK_EPOCH = datetime(2000, 1, 1, 11, 58, 55, 816000, tzinfo=timezone.utc)
TT_MINUS_UTC_S = 69.184         # 32.184 s + 37 leap seconds (unchanged since 2017)


# ----------------------------------------------------------------- Mars24 time and sun
def jd_tt(t: datetime) -> float:
    return t.timestamp() / 86400.0 + 2440587.5 + TT_MINUS_UTC_S / 86400.0


def utc_from_jd_tt(jd: float) -> datetime:
    return datetime.fromtimestamp((jd - 2440587.5 - TT_MINUS_UTC_S / 86400.0) * 86400.0, tz=timezone.utc)


def _mars_angles(jd: float) -> tuple[float, float]:
    """Return (Ls, EOT) in degrees for a Julian date (TT)."""
    dt = jd - 2451545.0
    M = 19.3871 + 0.52402073 * dt
    a_fms = 270.3871 + 0.524038496 * dt
    A = (0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.0020, 0.0018)
    tau = (2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493)
    phi = (49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095)
    pbs = sum(a * math.cos(math.radians(0.985626 * dt / t + p)) for a, t, p in zip(A, tau, phi))
    r = math.radians
    nu_m = ((10.691 + 3.0e-7 * dt) * math.sin(r(M)) + 0.623 * math.sin(r(2 * M)) + 0.050 * math.sin(r(3 * M))
            + 0.005 * math.sin(r(4 * M)) + 0.0005 * math.sin(r(5 * M)) + pbs)
    ls = (a_fms + nu_m) % 360.0
    eot = 2.861 * math.sin(r(2 * ls)) - 0.071 * math.sin(r(4 * ls)) + 0.002 * math.sin(r(6 * ls)) - nu_m
    return ls, eot


def msd(jd: float) -> float:
    return (jd - 2405522.0028779) / 1.0274912517


def jd_from_sol_lmst(sol: int, lmst_h: float, lon_e: float) -> float:
    """Julian date (TT) of a Perseverance sol and local mean solar time at east longitude lon_e."""
    m = sol + M2020_SOL0_MSD + lmst_h / 24.0 - lon_e / 360.0
    return m * 1.0274912517 + 2405522.0028779


def lmst_hours(jd: float, lon_e: float) -> float:
    return ((msd(jd) % 1.0) * 24.0 + lon_e / 15.0) % 24.0


def local_sol(jd: float, lon_e: float) -> int:
    return int(math.floor(msd(jd) + lon_e / 360.0)) - M2020_SOL0_MSD


def sun_elevation(jd: float, lon_e: float, lat_c: float) -> float:
    """Solar elevation (deg). lat_c is planetocentric; Mars24 uses planetographic latitude."""
    ls, eot = _mars_angles(jd)
    mst = (msd(jd) % 1.0) * 24.0
    sub_w = (mst * 15.0 + eot + 180.0) % 360.0                 # subsolar west longitude
    dec = math.degrees(math.asin(0.42565 * math.sin(math.radians(ls)))) + 0.25 * math.sin(math.radians(ls))
    lat_g = math.degrees(math.atan(math.tan(math.radians(lat_c)) * (3396.19 / 3376.20) ** 2))
    lon_w = (360.0 - lon_e) % 360.0
    cz = (math.sin(math.radians(dec)) * math.sin(math.radians(lat_g))
          + math.cos(math.radians(dec)) * math.cos(math.radians(lat_g)) * math.cos(math.radians(lon_w - sub_w)))
    return 90.0 - math.degrees(math.acos(max(-1.0, min(1.0, cz))))


def sunrise_sunset(sol: int, lon_e: float, lat_c: float, horizon_deg: float = 0.0) -> tuple[float, float, float]:
    """LMST hours of sunrise and sunset on a sol, and Ls (deg) at local noon."""
    def el(h: float) -> float:
        return sun_elevation(jd_from_sol_lmst(sol, h, lon_e), lon_e, lat_c) - horizon_deg

    def cross(a: float, b: float) -> float:
        fa = el(a)
        for _ in range(60):
            m = (a + b) / 2
            fm = el(m)
            if (fa < 0) == (fm < 0):
                a, fa = m, fm
            else:
                b = m
        return (a + b) / 2

    rise = cross(2.0, 12.0)
    sset = cross(12.0, 22.0)
    ls, _ = _mars_angles(jd_from_sol_lmst(sol, 12.0, lon_e))
    return rise, sset, ls


def hhmm(h: float) -> str:
    m = int(round(h * 60)) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


# ----------------------------------------------------------------- downloads
def _get(url: str, timeout: int = 90) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _cached(url: str, dest: Path) -> bytes:
    if dest.exists() and dest.stat().st_size > 0:
        return dest.read_bytes()
    data = _get(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return data


def _sol_dir(sol: int) -> str:
    """PDS MEDA folders hold 120 sols each from sol 300 onwards (e.g. sol_1140_1259)."""
    if sol < 300:
        raise ValueError("sol range layout below 300 not needed here")
    start = 300 + ((sol - 300) // 120) * 120
    return f"sol_{start:04d}_{start + 119:04d}/sol_{sol:04d}"


# ----------------------------------------------------------------- weather (S4)
def _lmst_h(s: str) -> float:
    # "01210M08:15:03.123" -> 8.2508
    t = s.split("M", 1)[1]
    h, m, sec = t.split(":")
    return int(h) + int(m) / 60 + float(sec) / 3600


def weather(raw: Path, sols: range, walk_hours: tuple[float, float] = (8.0, 15.0)) -> dict:
    per_sol = []
    hourly_air: dict[int, list[float]] = {}
    hourly_ground: dict[int, list[float]] = {}
    files = []
    for sol in sols:
        base = f"{PDS_MEDA}/data_calibrated_env/{_sol_dir(sol)}/WE__{sol:04d}___________"
        tirs_url = base + "CAL_TIRS________________P02.CSV"
        ps_url = f"{PDS_MEDA}/data_derived_env/{_sol_dir(sol)}/WE__{sol:04d}___________DER_PS__________________P01.CSV"
        try:
            tirs = _cached(tirs_url, raw / f"sol_{sol}_CAL_TIRS.csv").decode()
            ps = _cached(ps_url, raw / f"sol_{sol}_DER_PS.csv").decode()
        except urllib.error.HTTPError:
            continue
        files += [(tirs_url, raw / f"sol_{sol}_CAL_TIRS.csv"), (ps_url, raw / f"sol_{sol}_DER_PS.csv")]
        air, ground, press, hours = [], [], [], set()
        for row in csv.DictReader(io.StringIO(tirs)):
            if not row.get("LMST", "").startswith(f"{sol:05d}M"):
                continue
            h = _lmst_h(row["LMST"])
            hours.add(int(h))
            for key, store, hstore in (("AIR_TEMP", air, hourly_air), ("GROUND_TEMP", ground, hourly_ground)):
                v = row.get(key)
                if v:
                    c = float(v) - 273.15
                    store.append(c)
                    hstore.setdefault(int(h), []).append(c)
        for row in csv.DictReader(io.StringIO(ps)):
            v = row.get("PRESSURE")
            if v and row.get("LMST", "").startswith(f"{sol:05d}M"):
                press.append(float(v))
        if not air and not press:
            continue
        per_sol.append({
            "sol": sol,
            "air_c": [round(min(air), 1), round(max(air), 1)] if air else None,
            "ground_c": [round(min(ground), 1), round(max(ground), 1)] if ground else None,
            "pressure_pa": [round(min(press), 1), round(sum(press) / len(press), 1), round(max(press), 1)] if press else None,
            "hours_covered": len(hours),
        })
    def med(v: list[float]) -> float:
        v = sorted(v)
        return round(v[len(v) // 2], 1)
    profile = [{"hour": h, "air_c": med(hourly_air[h]) if h in hourly_air else None,
                "ground_c": med(hourly_ground[h]) if h in hourly_ground else None} for h in range(24)
               if h in hourly_air or h in hourly_ground]
    walk_air = [v for h in range(int(walk_hours[0]), int(walk_hours[1])) for v in hourly_air.get(h, [])]
    return {
        "sols": per_sol,
        "hourly_median": profile,
        "walk_hours_air_c": [round(min(walk_air), 1), round(max(walk_air), 1)] if walk_air else None,
        "files": files,
    }


# ----------------------------------------------------------------- daylight (computed, checked)
def daylight(sols: range, lon_e: float, lat_c: float, raw: Path) -> dict:
    days = []
    for sol in sols:
        rise, sset, ls = sunrise_sunset(sol, lon_e, lat_c)
        days.append({"sol": sol, "sunrise_lmst": hhmm(rise), "sunset_lmst": hhmm(sset), "ls_deg": round(ls, 1)})
    check = {"compared_sols": 0}
    try:
        feed = json.loads(_cached(M2020_WEATHER_FEED, raw / "m2020_weather_feed.json"))
        diffs = []
        for s in feed.get("sols", []):
            sol = int(s["sol"])
            r, st, ls = sunrise_sunset(sol, lon_e, lat_c)
            fr = [int(x) for x in s["sunrise"].split(":")]
            fs = [int(x) for x in s["sunset"].split(":")]
            diffs.append(abs(r * 60 - (fr[0] * 60 + fr[1] + fr[2] / 60)))
            diffs.append(abs(st * 60 - (fs[0] * 60 + fs[1] + fs[2] / 60)))
        if diffs:
            check = {"compared_sols": len(diffs) // 2, "max_diff_min": round(max(diffs), 1),
                     "mean_diff_min": round(sum(diffs) / len(diffs), 1),
                     "against": "Perseverance weather feed (sunrise/sunset, sols "
                                f"{feed['sols'][0]['sol']}-{feed['sols'][-1]['sol']})"}
    except Exception as e:  # the check is best-effort; the computed times stand on their own
        check = {"compared_sols": 0, "error": str(e)[:200]}
    return {"method": "NASA GISS Mars24 equations (Allison & McEwen 2000); sun centre on the horizon",
            "days": days, "check": check}


def verify_solar_time(raw: Path, sol: int, lon_e: float) -> dict:
    """Check our Mars24 maths against MEDA's own clocks: MEDA logs both local mean solar time (LMST)
    and local true solar time (LTST). Their difference is the equation of time, which we compute.
    (The rover's raw SCLK is not used: it drifts by tens of minutes over the mission.)"""
    text = (raw / f"sol_{sol}_CAL_TIRS.csv").read_text()
    diffs = []
    for i, row in enumerate(csv.DictReader(io.StringIO(text))):
        if i % 2000:
            continue
        lmst = _lmst_h(row["LMST"])
        lt_sol, lt_time = row["LTST"].split()
        h, m, s = lt_time.split(":")
        ltst = int(h) + int(m) / 60 + float(s) / 3600 + (int(lt_sol) - sol) * 24
        meda_eot_min = (ltst - lmst) * 60
        _, eot = _mars_angles(jd_from_sol_lmst(sol, lmst, lon_e))
        diffs.append(abs(meda_eot_min - eot * 4.0))   # 1 deg of EOT = 4 min
    return {"rows_compared": len(diffs), "eot_max_diff_min": round(max(diffs), 2) if diffs else None,
            "what": "Equation of time from our Mars24 maths vs MEDA's LTST - LMST"}


# ----------------------------------------------------------------- sun activity (S7, S3)
def _flare_class_rank(c: str) -> int:
    return {"A": 0, "B": 1, "C": 2, "M": 3, "X": 4}.get((c or "?")[0], -1)


def sun_activity(raw: Path, now: datetime) -> dict:
    out: dict = {"retrieved_utc": now.replace(microsecond=0).isoformat().replace("+00:00", "Z")}
    # NASA DONKI (S3): kauai first, then api.nasa.gov with NASA_API_KEY (or DEMO_KEY)
    start = (now - timedelta(days=30)).strftime("%Y-%m-%d")
    end = now.strftime("%Y-%m-%d")
    donki = {"status": "unreachable"}
    donki_files: list[tuple[str, Path]] = []
    key = os.environ.get("NASA_API_KEY", "DEMO_KEY")
    for url in (DONKI_KAUAI.format(kind="SEP", start=start, end=end),
                DONKI_API.format(kind="SEP", start=start, end=end, key=key)):
        try:
            body = _get(url, timeout=40)
            data = json.loads(body or b"[]")  # DONKI sends an empty body when there is no event
            shown = url.replace(key, "<key>") if key in url else url  # never write the key into a package
            donki = {"status": "ok", "sep_events_30d": len(data),
                     "latest_sep": max((d.get("eventTime", "") for d in data), default=None),
                     "url": shown}
            # keep the answer as it was sent, so the package can record it like every other
            # download (URL, time, sha256). It is NASA's, so it goes beside the other NASA files.
            kept = raw.parent / "nasa" / "donki_sep_30d.json"
            kept.parent.mkdir(parents=True, exist_ok=True)
            kept.write_bytes(body)
            donki_files = [(shown, kept)]
            break
        except Exception as e:
            donki = {"status": "unreachable", "error": str(e)[:160]}
    out["donki"] = donki

    # NOAA SWPC GOES (S7)
    flares = json.loads(_get(NOAA_FLARES))
    protons = json.loads(_get(NOAA_PROTONS))
    (raw / "noaa_xray_flares_7d.json").write_text(json.dumps(flares))
    (raw / "noaa_protons_3d.json").write_text(json.dumps(protons))
    counts = {"C": 0, "M": 0, "X": 0}
    big = []
    for f in flares:
        c = f.get("max_class") or ""
        if c[:1] in counts:
            counts[c[:1]] += 1
        if _flare_class_rank(c) >= 3:
            big.append({"class": c, "max_time": f.get("max_time")})
    p10 = [p for p in protons if p.get("energy") == ">=10 MeV" and p.get("flux") is not None]
    p10.sort(key=lambda p: p["time_tag"])
    out["noaa"] = {
        "flares_7d": counts,
        "strong_flares_7d": sorted(big, key=lambda b: b["max_time"] or "")[-5:],
        "latest_strong_flare": (sorted(big, key=lambda b: b["max_time"] or "")[-1] if big else None),
        "protons_10mev_latest_pfu": round(p10[-1]["flux"], 3) if p10 else None,
        "protons_10mev_latest_time": p10[-1]["time_tag"] if p10 else None,
        "protons_10mev_max_3d_pfu": round(max(p["flux"] for p in p10), 3) if p10 else None,
        "flare_window": [flares[0]["time_tag"], flares[-1]["time_tag"]] if flares else None,
        "where_measured": "GOES satellites near Earth (1 AU). Mars is about 1.5 AU from the Sun and often on another side, so storms seen here may or may not reach Mars.",
    }
    out["files"] = [(NOAA_FLARES, raw / "noaa_xray_flares_7d.json"), (NOAA_PROTONS, raw / "noaa_protons_3d.json")] + donki_files
    return out


def sol_dates(sols: range, lon_e: float) -> str:
    """Earth dates of the first and last sol (local noon), e.g. 'Dec 2022 - Jan 2023'."""
    a = utc_from_jd_tt(jd_from_sol_lmst(sols[0], 12.0, lon_e))
    b = utc_from_jd_tt(jd_from_sol_lmst(sols[-1], 12.0, lon_e))
    fa, fb = a.strftime("%b %Y"), b.strftime("%b %Y")
    return fa if fa == fb else f"{fa} - {fb}"


def build(out_dir: Path, raw_root: Path, site_lon: float, site_lat: float, sols: range, place: str = "here") -> dict:
    raw = raw_root / "pds" / "meda"
    raw_sw = raw_root / "noaa"
    raw_sw.mkdir(parents=True, exist_ok=True)
    (out_dir / "conditions").mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)

    w = weather(raw, sols)
    d = daylight(sols, site_lon, site_lat, raw)
    clock = verify_solar_time(raw, sols[0], site_lon) if w["sols"] else {}
    s = sun_activity(raw_sw, now)

    weather_json = {
        "title": "Weather measured here by Perseverance",
        "source": "Perseverance MEDA, NASA PDS Atmospheres node (calibrated TIRS air/ground temperature, derived pressure)",
        "sols": [x["sol"] for x in w["sols"]],
        "per_sol": w["sols"],
        "hourly_median": w["hourly_median"],
        "walk_hours_air_c": w["walk_hours_air_c"],
        "daylight": d,
        "clock_check": clock,
        "date_range": sol_dates(sols, site_lon),
        "note": f"Real measurements from when the rover was at {place} ({sol_dates(sols, site_lon)}). They show typical conditions for this place and season; on a crewed mission the habitat's own station would give today's values.",
    }
    space_json = {
        "title": "Sun activity",
        "retrieved_utc": s["retrieved_utc"],
        "noaa": s["noaa"],
        "donki": s["donki"],
    }
    (out_dir / "conditions" / "weather.json").write_text(json.dumps(weather_json, indent=1))
    (out_dir / "conditions" / "space-weather.json").write_text(json.dumps(space_json, indent=1))
    return {"weather": weather_json, "space": space_json, "files": w["files"] + s["files"]}
