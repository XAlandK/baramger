import math

import numpy as np

from baramger_pipeline import terrain as T
from baramger_pipeline.tiles import tile_range


def plane_grid(slope_deg: float, w=60, h=40, lat=18.49) -> T.Grid:
    """Synthetic grid tilted toward the east with a known slope."""
    g = T.Grid(np.zeros((h, w), "float32"), 77.30, lat - 0.0005, 77.30 + 0.001, lat + 0.0005)
    x = (np.arange(w) + 0.5) * g.dx_m
    g.z[:] = (np.tan(math.radians(slope_deg)) * x)[None, :]
    return g


def test_slope_of_known_plane():
    for want in (5.0, 15.0, 30.0):
        g = plane_grid(want)
        s = T.slope_deg(g.z, g.dx_m, g.dy_m)
        assert abs(float(np.median(s)) - want) < 0.05


def test_cell_size_uses_latitude():
    g = plane_grid(0.0, lat=60.0)
    assert abs(g.dx_m / g.dy_m - g.dlon / g.dlat * math.cos(math.radians(60))) < 1e-3


def test_box_mean_keeps_constant():
    a = np.full((20, 30), 7.0, "float32")
    assert np.allclose(T.box_mean(a, 3), 7.0)
    assert np.allclose(T.box_mean(a, 5), 7.0)


def test_fill_gaps_marks_unknown():
    z = np.ones((5, 5), "float32")
    z[2, 2] = np.nan
    filled, unknown = T.fill_gaps(z)
    assert unknown[2, 2] and unknown.sum() == 1
    assert filled[2, 2] == 1.0


def test_block_mean_halves_size():
    g = plane_grid(10.0, w=60, h=40)
    g2 = T.block_mean(g, 2)
    assert g2.z.shape == (20, 30)
    assert abs(g2.dx_m - 2 * g.dx_m) < 1e-6


def test_tile_range_matches_trek_grid():
    # level 0 is 2 x 1 tiles of 180 deg; Cheyava Falls at level 17
    assert tile_range(None, 0) == (range(2), range(1))
    cols, rows = tile_range((77.30519, 18.49748, 77.30519, 18.49748), 17)
    d = 180 / 2 ** 17
    assert cols == range(int((77.30519 + 180) // d), int((77.30519 + 180) // d) + 1)
    assert rows == range(int((90 - 18.49748) // d), int((90 - 18.49748) // d) + 1)
