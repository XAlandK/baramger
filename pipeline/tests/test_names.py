"""Official place names: read from the labels USGS printed on its geologic map (SIM 3464, R2)."""
import math

import pytest

from baroler_pipeline import config as C
from baroler_pipeline import geology

GDB = C.RAW / "usgs" / "sim3464" / "sim3464_JezeroNili_FINAL" / "Geodatabase" / "Nili.gdb"


def test_clean_label_reads_letter_spaced_names():
    assert geology.clean_label("J  E  Z  E  R  O") == "Jezero"
    assert geology.clean_label("N   I   L   I      P   L   A   N   U   M") == "Nili Planum"


def test_clean_label_reads_a_name_stacked_on_two_lines():
    assert geology.clean_label("N  I  L  I\r\nP  L  A  N  U  M") == "Nili Planum"
    assert geology.clean_label("N I L I\nP L A N U M") == "Nili Planum"
    assert geology.clean_label("Neretva\nVallis") == "Neretva Vallis"


def test_clean_label_reads_uneven_letter_gaps():
    assert geology.clean_label("J  E  Z E  R  O") == "Jezero"          # one gap is narrower: still one word
    assert geology.clean_label("N  I  L  I    P  L  A  N  U  M") == "Nili Planum"   # a double gap is a word break
    assert geology.clean_label("N  I  L  I   P  L  A  N  U  M") == "Nili Planum"    # so is a gap half as long again
    assert geology.clean_label("N   I   L   I     P   L   A   N   U   M") == "Nili Planum"


def test_clean_label_drops_format_tags():
    assert geology.clean_label("<ITA>Una Vallis</ITA>") == "Una Vallis"
    assert geology.clean_label("<BOL>J  E  Z  E  R  O</BOL>") == "Jezero"


def test_clean_label_keeps_ordinary_names():
    assert geology.clean_label("Neretva Vallis") == "Neretva Vallis"
    assert geology.clean_label("  Belva ") == "Belva"
    assert geology.clean_label("Una   Vallis") == "Una Vallis"
    assert geology.clean_label("A") == "A"          # one letter is a name, not a spaced-out word
    assert geology.clean_label("A B") == "A B"      # two letters could be two short words: left as printed


@pytest.mark.skipif(not GDB.exists(), reason="the USGS map database is not downloaded")
def test_names_printed_on_the_usgs_map():
    names = geology.place_names(GDB)
    by = {n["name"]: n for n in names}
    assert sorted(by) == ["Angelica", "Belva", "Hartwell", "Jezero", "Marysville", "Neretva Vallis",
                          "Nili Planum", "Sedona", "Ulricehamn", "Una Vallis"]
    assert all(n["sourceId"] == "R2-usgs-pgm" for n in names)
    # the two large features come first
    assert [n["name"] for n in names[:2]] == ["Jezero", "Nili Planum"]
    assert {n["name"] for n in names if n["rank"] == "major"} == {"Jezero", "Nili Planum"}
    # every label lies on the map sheet (lon 76.8-77.8, lat 17.7-18.7)
    for n in names:
        assert 76.8 <= n["position"]["lon"] <= 77.8 and 17.7 <= n["position"]["lat"] <= 18.7, n
    # the Jezero label sits inside the crater: within 3 km of the centre Mars Trek gives (R1)
    km_per_deg = 3396.19 * math.pi / 180
    j = by["Jezero"]["position"]
    dx = (j["lon"] - C.CRATER["lon"]) * km_per_deg * math.cos(math.radians(C.CRATER["lat"]))
    dy = (j["lat"] - C.CRATER["lat"]) * km_per_deg
    assert math.hypot(dx, dy) < 3.0
    # Belva crater lies between the two walk zones
    b = by["Belva"]["position"]
    assert C.Z2.aoi[2] < b["lon"] < C.Z1.aoi[0]


def test_conditions_downloads_are_listed_under_their_own_source():
    """Every download gets a provenance entry with the right source (the DONKI answer too)."""
    from baroler_pipeline import cli
    assert cli.source_of("https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json") == "S7-noaa-swpc"
    assert cli.source_of("https://api.nasa.gov/DONKI/SEP?startDate=2026-10-15&endDate=2026-11-14&api_key=<key>") == "S3-nasa-donki"
    assert cli.source_of("https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/SEP?startDate=2026-10-15&endDate=2026-11-14") == "S3-nasa-donki"
    assert cli.source_of("https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/data_calibrated_env/sol_1210.csv") == "S4-m20-meda-weather"


def test_sun_activity_keeps_the_donki_answer_and_hides_the_key(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timezone
    from baroler_pipeline import conditions

    monkeypatch.setenv("NASA_API_KEY", "SECRET123")
    asked = []

    def fake_get(url, timeout=90):
        asked.append(url)
        if "kauai" in url:
            raise OSError("timed out")
        if "DONKI" in url:
            return json.dumps([{"eventTime": "2026-11-02T10:00Z"}]).encode()
        if "xray-flares" in url:
            return json.dumps([{"max_class": "M1.7", "max_time": "2026-11-11T21:21:00Z", "time_tag": "2026-11-11T21:00:00Z"}]).encode()
        return json.dumps([{"energy": ">=10 MeV", "flux": 0.2, "time_tag": "2026-11-14T16:55:00Z"}]).encode()

    monkeypatch.setattr(conditions, "_get", fake_get)
    raw = tmp_path / "noaa"
    raw.mkdir()
    out = conditions.sun_activity(raw, datetime(2026, 11, 14, 17, 0, tzinfo=timezone.utc))
    assert out["donki"]["status"] == "ok" and out["donki"]["sep_events_30d"] == 1
    urls = [u for u, _ in out["files"]]
    donki = [(u, p) for u, p in out["files"] if "DONKI" in u]
    assert len(donki) == 1 and len(urls) == 3
    url, path = donki[0]
    assert "SECRET123" not in url and "<key>" in url          # the key never reaches a package
    assert "SECRET123" not in json.dumps(out["donki"])
    assert json.loads(path.read_text()) == [{"eventTime": "2026-11-02T10:00Z"}]   # the answer is kept for the sha256
    assert path == tmp_path / "nasa" / "donki_sep_30d.json"                       # with the other NASA files


def test_sun_activity_keeps_an_empty_donki_answer_as_it_was_sent(tmp_path, monkeypatch):
    """DONKI sends an empty body when there is no event: that is what must be kept and hashed."""
    from datetime import datetime, timezone
    from baroler_pipeline import conditions

    def fake_get(url, timeout=90):
        if "kauai" in url:
            raise OSError("timed out")
        return b"" if "DONKI" in url else b"[]"

    monkeypatch.setattr(conditions, "_get", fake_get)
    raw = tmp_path / "noaa"
    raw.mkdir()
    out = conditions.sun_activity(raw, datetime(2026, 11, 14, 17, 0, tzinfo=timezone.utc))
    assert out["donki"]["status"] == "ok" and out["donki"]["sep_events_30d"] == 0
    assert (tmp_path / "nasa" / "donki_sep_30d.json").read_bytes() == b""


def test_sun_activity_lists_no_donki_file_when_donki_does_not_answer(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timezone
    from baroler_pipeline import conditions

    def fake_get(url, timeout=90):
        if "DONKI" in url:
            raise OSError("HTTP Error 429: Too Many Requests")
        if "xray-flares" in url:
            return b"[]"
        return b"[]"

    monkeypatch.setattr(conditions, "_get", fake_get)
    raw = tmp_path / "noaa"
    raw.mkdir()
    out = conditions.sun_activity(raw, datetime(2026, 11, 14, 17, 0, tzinfo=timezone.utc))
    assert out["donki"]["status"] == "unreachable"
    assert not (tmp_path / "nasa").exists()
    assert all("DONKI" not in u for u, _ in out["files"]) and len(out["files"]) == 2


def test_committed_packages_hold_the_ten_names():
    """The place names in the packages that ship with the repository (no raw data needed)."""
    import json
    lists = []
    for zone in C.ZONES.values():
        path = zone.package_dir / "mission-package.json"
        if not path.exists():
            continue
        pkg = json.loads(path.read_text())
        names = pkg.get("placeNames", [])
        assert sorted(n["name"] for n in names) == ["Angelica", "Belva", "Hartwell", "Jezero", "Marysville", "Neretva Vallis",
                                                   "Nili Planum", "Sedona", "Ulricehamn", "Una Vallis"], zone.key
        assert {n["name"] for n in names if n.get("rank") == "major"} == {"Jezero", "Nili Planum"}
        sources = {s["id"] for s in pkg["sources"]}
        for n in names:
            assert n["sourceId"] == "R2-usgs-pgm" and n["sourceId"] in sources
            # every label lies on the sheet of USGS SIM 3464
            assert 76.79 <= n["position"]["lon"] <= 77.81 and 17.69 <= n["position"]["lat"] <= 18.71, (zone.key, n)
        lists.append(names)
    assert all(names == lists[0] for names in lists)     # both zones show the same names
