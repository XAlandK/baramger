from baroler_pipeline import config as C
from baroler_pipeline import tiles

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
    """The --skip-tiles count for the built packages matches the tiles on disk (Z1 925, Z2 1,068)."""
    for zone in C.ZONES.values():
        if not (zone.package_dir / "tiles").exists():
            continue
        counts = tiles.count_cached(zone.package_dir, C.tile_layers(zone))
        assert all(v["cached"] == v["requested"] for v in counts.values()), (zone.key, counts)
