import json

import pytest

from baramger_pipeline import config as C

HIRISE_JEZERO = (77.2229331, 18.3067994, 77.583964, 18.669315)  # Mars Trek bbox of the 25 cm mosaic / 1 m DEM
WAYPOINTS = C.RAW / "nasa" / "M20_waypoints.json"


def inside(b, lon, lat):
    return b[0] <= lon <= b[2] and b[1] <= lat <= b[3]


def contains(outer, inner):
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


@pytest.mark.parametrize("zone", list(C.ZONES.values()), ids=lambda z: z.key)
def test_zone_areas_nest(zone):
    assert contains(HIRISE_JEZERO, zone.aoi), "walk area must be inside the sharp HiRISE coverage"
    assert contains(zone.context, zone.aoi), "context area must contain the walk area"
    assert len({s.id for s in zone.stops}) == len(zone.stops), "stop ids must be unique"
    assert 0 <= zone.weather_stop < len(zone.stops)


@pytest.mark.skipif(not WAYPOINTS.exists(), reason="rover waypoints not downloaded yet")
@pytest.mark.parametrize("zone", list(C.ZONES.values()), ids=lambda z: z.key)
def test_stops_are_real_rover_positions_inside_the_area(zone):
    by_rmc = {f["properties"]["RMC"]: f["properties"] for f in json.loads(WAYPOINTS.read_text())["features"]}
    for s in zone.stops:
        wp = by_rmc.get(s.rmc)
        assert wp is not None, f"{s.id}: rover waypoint {s.rmc} not in S1"
        assert inside(zone.aoi, wp["lon"], wp["lat"]), f"{s.id} is outside the walk area"
        assert s.sols[0] <= s.sols[1]


def test_depot_spots_are_close_together():
    """NASA: the 10 depot tubes are about 5-15 m apart. Our 10 rover spots should be similarly spaced."""
    if not WAYPOINTS.exists():
        pytest.skip("rover waypoints not downloaded yet")
    by_rmc = {f["properties"]["RMC"]: f["properties"] for f in json.loads(WAYPOINTS.read_text())["features"]}
    pts = [by_rmc[s.rmc] for s in C.Z1.stops]
    assert len(pts) == 10
    gaps = []
    for a, b in zip(pts, pts[1:]):
        kx = 59274 * __import__("math").cos(__import__("math").radians(a["lat"]))
        gaps.append(((b["lon"] - a["lon"]) * kx) ** 2 + ((b["lat"] - a["lat"]) * 59274) ** 2)
    gaps = [g ** 0.5 for g in gaps]
    assert all(3 <= g <= 40 for g in gaps), gaps
