"""Fixed inputs for each walk zone (Z2 Bright Angel, Z1 Three Forks), all in Jezero crater.

Every number here is either a verified fact (with its source ID) or a labelled
assumption (A-numbers, also written into the package's `assumptions`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------- paths
ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
PACKAGES = ROOT / "data" / "package"
SCHEMA = ROOT / "schema" / "marswalk.schema.json"
REGISTRY = ROOT / "data" / "sources.registry.json"

# ---------------------------------------------------------------- Mars frame
# Mars 2000 sphere used by Mars Trek products (R1).
MARS_RADIUS_M = 3_396_190.0
GRAVITY_MS2 = 3.71

# Grid used for routing and line-of-sight (metres per cell).
ROUTE_CELL_M = 2.0

# ---------------------------------------------------------------- Mars Trek products (R1)
TREK_DEM_LABEL = "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40"
TREK_CTX_DEM_LABEL = "JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0"
TREK_TILE_ROOT = "https://trek.nasa.gov/tiles/Mars/EQ"
# Same HiRISE DEM product, hosted by its producer (USGS Astrogeology, Mars 2020 TRN release).
# Allows HTTP range reads, so only the walk area is read (Trek's copy can only be downloaded whole).
USGS_TRN_DEM_URL = ("https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/"
                    f"{TREK_DEM_LABEL}.tif")


@dataclass(frozen=True)
class TileLayer:
    key: str            # folder name in the package
    label: str          # Mars Trek productLabel
    ext: str            # png | jpg
    levels: tuple[int, int]   # min, max tile level to cache
    bbox: tuple[float, float, float, float] | None  # None = whole planet
    title: str
    data_kind: str
    resolution_m: float | None
    attribution: str


# ---------------------------------------------------------------- stops (real rover positions, S1)
@dataclass(frozen=True)
class StopSpec:
    id: str
    name: str
    rmc: str            # rover waypoint key "<site>_<drive>"
    sols: tuple[int, int]   # sols the rover spent here (photo search window)
    minutes: int
    tasks: tuple[str, ...]
    objective_ids: tuple[str, ...]
    note: str = ""      # extra text for the stop card (e.g. what the position means)


@dataclass(frozen=True)
class Zone:
    key: str                     # "z1", "z2"
    slug: str                    # package folder name
    code: str                    # "Z1"
    name: str                    # short name, e.g. "Three Forks"
    description: str
    aoi: tuple[float, float, float, float]       # walk area (minLon, minLat, maxLon, maxLat)
    context: tuple[float, float, float, float]   # wider area for 20 m terrain and CTX/THEMIS tiles
    stops: tuple[StopSpec, ...]
    objectives: tuple[dict, ...]
    weather_sols: range          # MEDA reference sols (rover was here)
    weather_stop: int            # index of the stop whose position the weather/daylight refer to
    extra_assumptions: tuple[dict, ...] = field(default_factory=tuple)

    @property
    def package_dir(self) -> Path:
        return PACKAGES / self.slug

    @property
    def site_name(self) -> str:
        return f"{self.name} (zone {self.code})"

    @property
    def title(self) -> str:
        return f"{self.name} Marswalk (zone {self.code}, Jezero crater)"


def tile_layers(zone: Zone) -> tuple[TileLayer, ...]:
    return (
        TileLayer("mola", "Mars_MGS_MOLA_ClrShade_merge_global_463m", "jpg", (0, 3), None,
                  "MOLA colour shaded relief (global)", "topographic", 463,
                  "NASA/JPL/GSFC MOLA, via Mars Trek"),
        TileLayer("mola-region", "Mars_MGS_MOLA_ClrShade_merge_global_463m", "jpg", (4, 7), (70.0, 12.0, 85.0, 25.0),
                  "MOLA colour shaded relief (region)", "topographic", 463,
                  "NASA/JPL/GSFC MOLA, via Mars Trek"),
        TileLayer("ctx", "JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0", "png", (8, 13), zone.context,
                  "CTX photo mosaic, 6 m", "optical", 6,
                  "NASA/JPL-Caltech/MSSS (CTX), via Mars Trek"),
        TileLayer("hirise", "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd", "png", (13, 17), zone.aoi,
                  "HiRISE photo mosaic, 25 cm", "optical", 0.25,
                  "NASA/JPL-Caltech/University of Arizona (HiRISE), via Mars Trek"),
        TileLayer("themis-night", "THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018", "png", (6, 9), zone.context,
                  "THEMIS night-time heat (rocky vs dusty)", "thermal", 100,
                  "NASA/JPL-Caltech/Arizona State University (THEMIS), via Mars Trek"),
    )


# ---------------------------------------------------------------- zone Z2: Bright Angel / Cheyava Falls
Z2 = Zone(
    key="z2", slug="z2-bright-angel", code="Z2", name="Bright Angel",
    description="Walk area around the Cheyava Falls rock, where Perseverance worked in mid-2024.",
    aoi=(77.2900, 18.4800, 77.3220, 18.5030),
    context=(77.2229, 18.4300, 77.3900, 18.5500),
    stops=(
        StopSpec("stop-1", "Rover stop, sol 1159", "52_3158", (1159, 1161), 30,
                 ("Wide photos of the area", "Note the rock type underfoot"), ("obj-context",)),
        StopSpec("stop-2", "Cheyava Falls rock", "56_0", (1210, 1218), 40,
                 ("Wide photo", "Close-up photos of the spots", "Voice note", "Take sample"), ("obj-cheyava",)),
        StopSpec("stop-3", "Rover stop, sol 1231", "56_3438", (1231, 1243), 30,
                 ("Wide photos", "Compare rock with Cheyava Falls"), ("obj-context",)),
        StopSpec("stop-4", "Rover stop, sol 1254", "59_204", (1254, 1254), 25,
                 ("Photos up the slope", "Collect a sample if safe"), ("obj-context",)),
    ),
    objectives=(
        {"id": "obj-cheyava", "title": "Study the spotted rocks at Cheyava Falls",
         "question": "Do the small dark spots in the Cheyava Falls rock hold signs of ancient life?",
         "whyHumans": "A geologist can look at the spots from many angles, compare nearby rocks, and choose the best sample on the spot.",
         "targets": ["Cheyava Falls rock"]},
        {"id": "obj-context", "title": "Understand the rocks around Bright Angel",
         "question": "How do the rocks along the walk differ from the Cheyava Falls rock?",
         "whyHumans": "Walking between outcrops lets a person see how the layers connect.",
         "targets": ["Rocks along the route"]},
    ),
    weather_sols=range(1210, 1219),
    weather_stop=1,
)

# ---------------------------------------------------------------- zone Z1: Three Forks sample depot
# Perseverance built the depot on sols 653-690 (Dec 2022 - Jan 2023): 10 tubes, about 5-15 m apart
# (NASA). The exact tube positions are only published as a picture (PIA25682). What is data (S1) are
# the 10 places where the rover parked at site 32 during those sols; each stop below is one of them.
_DEPOT_TASKS = ("Find the tube", "Photograph it where it lies", "Check the tube is sealed and clean", "Pick up the tube")
_DEPOT_NOTE = ("Where Perseverance parked while building the depot. The tube dropped on this visit should lie "
               "within a few metres (assumption A14): check NASA's depot map PIA25682.")
_DEPOT = (("32_148", (652, 653)), ("32_250", (654, 657)), ("32_378", (658, 662)), ("32_482", (663, 666)),
          ("32_580", (667, 669)), ("32_672", (670, 673)), ("32_774", (674, 677)), ("32_896", (678, 680)),
          ("32_1038", (681, 683)), ("32_1184", (686, 692)))

Z1 = Zone(
    key="z1", slug="z1-three-forks", code="Z1", name="Three Forks",
    description="The Three Forks sample depot at the foot of the old river delta, where Perseverance left 10 sample tubes in Dec 2022 - Jan 2023.",
    aoi=(77.3940, 18.4435, 77.4240, 18.4635),
    context=(77.3300, 18.3900, 77.4900, 18.5200),
    stops=tuple(
        StopSpec(f"depot-{i}", f"Depot spot {i} (sol {sols[0]})", rmc, sols, 10, _DEPOT_TASKS,
                 ("obj-depot",), _DEPOT_NOTE)
        for i, (rmc, sols) in enumerate(_DEPOT, 1)
    ),
    objectives=(
        {"id": "obj-depot", "title": "Collect the sample tubes at Three Forks",
         "question": "Can the crew find the ten sample tubes Perseverance left here, check them and bring them back?",
         "whyHumans": "People can spot a tube under dust, check it closely, and carry several at once.",
         "targets": ["Ten sample tubes"]},
        {"id": "obj-delta", "title": "Read the rocks at the foot of the delta",
         "question": "What do the rocks around the depot say about the old river delta?",
         "whyHumans": "Walking between the spots lets a geologist compare rocks and pick extra samples.",
         "targets": ["Rocks around the depot"]},
    ),
    weather_sols=range(653, 662),
    weather_stop=0,
    extra_assumptions=(
        {"id": "A14", "statement": "Each depot stop is where the rover parked during depot building (sols 652-692, site 32); the tube dropped then lies within a few metres",
         "status": "to_verify", "reference": "NASA depot map PIA25682 (image); rover positions from S1"},
    ),
)

ZONES: dict[str, Zone] = {"z1": Z1, "z2": Z2}

# ---------------------------------------------------------------- safety assumptions (to verify)
ASSUMPTIONS = (
    {"id": "A1", "statement": "Comfortable walking slope for a suited astronaut", "value": 15, "unit": "deg", "status": "to_verify"},
    {"id": "A2", "statement": "Maximum slope allowed on foot (steeper = no-go)", "value": 25, "unit": "deg", "status": "to_verify"},
    {"id": "A3", "statement": "Walking speed on flat ground in a suit", "value": 2.5, "unit": "km/h", "status": "to_verify",
     "reference": "Speed on slopes scaled with Tobler's hiking function"},
    {"id": "A4", "statement": "Walk (EVA) length", "value": 360, "unit": "min", "status": "to_verify"},
    {"id": "A5", "statement": "Time kept in reserve for the walk back", "value": 0.30, "unit": "fraction", "status": "to_verify"},
    {"id": "A6", "statement": "Habitat position chosen by the planner: flat ground with the best radio view of the walk; not a real landing site", "status": "accepted"},
    {"id": "A7", "statement": "Habitat radio antenna height above ground", "value": 3.0, "unit": "m", "status": "to_verify"},
    {"id": "A8", "statement": "Suit radio antenna height above ground", "value": 1.8, "unit": "m", "status": "to_verify"},
    {"id": "A9", "statement": "Longest time allowed without radio contact to the habitat", "value": 15, "unit": "min", "status": "to_verify"},
    {"id": "A10", "statement": "Start the walk at least this long after sunrise", "value": 30, "unit": "min", "status": "to_verify"},
    {"id": "A11", "statement": "Be back at least this long before sunset", "value": 60, "unit": "min", "status": "to_verify"},
    {"id": "A12", "statement": "Postpone the walk if the 10 MeV proton level reaches this (NOAA S1 storm level, measured near Earth)",
     "value": 10, "unit": "pfu", "status": "to_verify"},
    {"id": "A13", "statement": "Take extra care for this long after an X-class solar flare", "value": 24, "unit": "h", "status": "to_verify"},
)

COMFORT_SLOPE_DEG = 15.0
MAX_SLOPE_DEG = 25.0
FLAT_SPEED_KMH = 2.5
EVA_MIN = 360
RESERVE_FRACTION = 0.30
BASE_ANTENNA_M = 3.0
SUIT_ANTENNA_M = 1.8
