from baramger_pipeline import config as C
from baramger_pipeline import tiles

# A small layer: two levels over a tiny box, so the job list is short.
LAYER = C.TileLayer(
    key="test", label="TEST_LABEL", ext="png", levels=(3, 4), bbox=(77.29, 18.48, 77.32, 18.50),
    title="Test", data_kind="optical", resolution_m=None, attribution="test",
)


def test_count_cached_reports_true_numbers_without_downloading(tmp_path):
    jobs = tiles.jobs_for(tmp_path, LAYER)
    assert len(jobs) >= 2
    # put all but one tile on disk; an empty file does not count as cached
    for _, dest in jobs[:-1]:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"x")
    jobs[-1][1].parent.mkdir(parents=True, exist_ok=True)
    jobs[-1][1].write_bytes(b"")

    summary = tiles.count_cached(tmp_path, (LAYER,))["test"]
    assert summary == {"requested": len(jobs), "cached": len(jobs) - 1, "missing": 1}


def test_count_cached_all_present_has_no_missing_key(tmp_path):
    jobs = tiles.jobs_for(tmp_path, LAYER)
    for _, dest in jobs:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"x")
    assert tiles.count_cached(tmp_path, (LAYER,))["test"] == {"requested": len(jobs), "cached": len(jobs)}


def test_real_packages_have_every_requested_tile():
    """The --skip-tiles count for the built packages matches the tiles on disk (Z1 1,465, Z2 1,608)."""
    for zone in C.ZONES.values():
        if not (zone.package_dir / "tiles").exists():
            continue
        counts = tiles.count_cached(zone.package_dir, C.tile_layers(zone))
        assert all(v["cached"] == v["requested"] for v in counts.values()), (zone.key, counts)


def test_both_base_maps_use_the_same_level_plan():
    """The crew can switch between height colours (MOLA) and natural colour (Viking): same tiles for both."""
    layers = {t.key: t for t in C.tile_layers(C.Z2)}
    for a, b in (("mola", "viking"), ("mola-region", "viking-region")):
        assert layers[a].levels == layers[b].levels and layers[a].bbox == layers[b].bbox
        assert layers[a].ext == layers[b].ext == "jpg"
    assert layers["viking"].label == layers["viking-region"].label == C.TREK_VIKING_LABEL
    # whole planet at levels 0-3, then the region around Jezero at levels 4-7
    assert len(tiles.jobs_for(C.Z2.package_dir, layers["viking"])) == 2 + 8 + 32 + 128
    assert len(tiles.jobs_for(C.Z2.package_dir, layers["viking-region"])) == 171
    # Mars Trek serves the Viking mosaic up to level 7 only
    assert layers["viking-region"].levels[1] <= 7


def test_crater_photo_layer_covers_the_whole_ctx_mosaic_and_both_zones():
    for zone in C.ZONES.values():
        layers = {t.key: t for t in C.tile_layers(zone)}
        crater, near = layers["ctx-crater"], layers["ctx"]
        assert crater.label == near.label == C.TREK_CTX_LABEL
        assert crater.bbox == C.CTX_MOSAIC_BBOX and crater.levels == (8, 11)
        w, s, e, n = crater.bbox
        zw, zs, ze, zn = zone.context
        assert w <= zw and s <= zs and ze <= e and zn <= n, zone.key   # the walk zone lies inside the mosaic
        # it is drawn under the zone's own, sharper CTX tiles
        keys = [t.key for t in C.tile_layers(zone)]
        assert keys.index("ctx-crater") < keys.index("ctx") < keys.index("hirise")
        assert keys.index("viking-region") < keys.index("ctx-wide") < keys.index("ctx-crater")
        assert len(tiles.jobs_for(zone.package_dir, crater)) == 4 + 9 + 20 + 56


def test_wide_crater_layer_holds_the_crater_and_both_zones():
    """The wide CTX layer must hold the whole crater with room around it, and both walk zones.

    The app (craterView in app/src/layout.ts) keeps its whole-crater view inside this box when the
    map's shape allows it. For that the box must hold the rim with 5% of the half-view free, and
    the comfortable view of a usual window (rim plus 20%, map 888 x 740 px).
    """
    import math
    wide = {t.key: t for t in C.tile_layers(C.Z2)}["ctx-wide"]
    assert wide.label == C.TREK_CTX_WIDE_LABEL and wide.bbox == C.CRATER_VIEW_BBOX and wide.levels == (7, 10)
    w, s, e, n = wide.bbox
    lon, lat, radius_km = C.CRATER["lon"], C.CRATER["lat"], C.CRATER["diameter_km"] / 2
    km_per_deg = 3396.19 * math.pi / 180
    km_lon = km_per_deg * math.cos(math.radians(lat))
    box_w = min(lon - w, e - lon) * km_lon          # from the crater's centre to the nearest edge, km
    box_h = min(lat - s, n - lat) * km_per_deg
    assert box_w >= radius_km / 0.95 and box_h >= radius_km / 0.95      # the rim, with 5% free
    half_h = radius_km / 0.8                                            # a usual window: rim plus 20% up and down
    half_w = half_h * 888 / 740
    assert box_w >= half_w and box_h >= half_h
    for zone in C.ZONES.values():                                       # and both walk zones
        zw, zs, ze, zn = zone.context
        assert w <= zw and s <= zs and ze <= e and zn <= n, zone.key
    assert len(tiles.jobs_for(C.Z2.package_dir, wide)) == 4 + 9 + 25 + 72
    # the preliminary mosaic must say what it is, and where it ends
    assert "preliminary" in wide.title.lower() and "not for positions" in wide.notes[0]
    assert any("gap" in note for note in wide.notes) and any("planet map" in note for note in wide.notes)


def test_every_layer_starts_with_only_a_few_tiles():
    """From far away CesiumJS draws a layer with the tiles of its lowest level, all at once.

    Its documentation advises four or fewer. Six is the most this app has run with (the HiRISE
    layer of zone Z2); the wide layers added for the crater view keep to four.
    """
    for zone in C.ZONES.values():
        for layer in C.tile_layers(zone):
            cols, rows = tiles.tile_range(layer.bbox, layer.levels[0])
            limit = 4 if layer.key in ("mola-region", "viking-region", "ctx-wide", "ctx-crater") else 6
            assert len(cols) * len(rows) <= limit, (zone.key, layer.key, len(cols) * len(rows))
