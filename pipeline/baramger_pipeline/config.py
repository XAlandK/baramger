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

# Whole-planet base maps (two looks; the app lets the crew switch between them):
#   MOLA   = colours show height (the app's first look; blue is low ground, not water)
#   VIKING = natural colour, approximate: Mars Trek's own default base map. Its producer's record
#            (USGS Astrogeology, "Mars Viking Colorized Global Mosaic 232m", published 2009-02-02, public
#            domain) says NASA Ames blended the Viking colour mosaic over the grey MDIM 2.1 mosaic, as an
#            "artistically colorized" map. So never call it true colour: say natural colour, approximate.
TREK_MOLA_LABEL = "Mars_MGS_MOLA_ClrShade_merge_global_463m"
TREK_VIKING_LABEL = "Mars_Viking_MDIM21_ClrMosaic_global_232m"   # WMTS levels 0-7, jpg (checked 2026-11-14)
VIKING_PRODUCER_PAGE = "https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m"
# Both base maps are cached for the whole planet up to level 3, and up to level 7 around Jezero.
REGION_BBOX = (70.0, 12.0, 85.0, 25.0)
# The controlled Jezero CTX photo mosaic and its full extent on Mars Trek (WMTS capabilities, checked
# 2026-11-14). It covers only the western 40% of the crater: the delta and both walk zones.
TREK_CTX_LABEL = "JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0"
CTX_MOSAIC_BBOX = (77.1604655, 18.2110274, 77.6991776, 18.7211945)
# A wider CTX mosaic on Mars Trek, titled "MRO CTX, Jezero Mosaic, Preliminary" (lon 75.15..78.87,
# lat 15.91..19.45). It covers the whole crater, but it lies about 80 m south (and 20-30 m west) of the
# controlled mosaic, is darker, and shows seams between image strips: context only, drawn under the
# controlled mosaic.
TREK_CTX_WIDE_LABEL = "Jezero_CTX_BlockAdj_dd"
# Jezero crater as Mars Trek's own name layer gives it (R1; the IAU name was adopted in 2007). Read on
# 2026-11-14 from https://trek.nasa.gov/mars/trekarcgis/rest/services/combinedNom/MapServer/0/query
# with where=clean_name='Jezero': FID 186, center_lat 18.4082, center_lon 77.68734927, diameter 47.5212.
CRATER = {"name": "Jezero", "lon": 77.68734927, "lat": 18.4082, "diameter_km": 47.52}
# The box of the wide crater photo map: the crater with about 14 km around it. The app keeps its
# whole-crater view inside this box when the map's shape allows it (craterView in app/src/layout.ts);
# on a very wide or a tall map the view is larger, and the planet map shows at its edges.
# At level 7, the lowest level cached, this box has four tiles (CesiumJS advises four or fewer).
CRATER_VIEW_BBOX = (76.95, 17.78, 78.39, 19.04)


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
    notes: tuple[str, ...] = ()     # extra caveats written into the package


# Mars Trek gives no credit line for this product; this one follows the producer's record (see above).
VIKING_CREDIT = "NASA Ames and USGS Astrogeology Science Center (Viking Orbiter colourised mosaic, MDIM 2.1), via Mars Trek"
VIKING_NOTES = (
    "Natural colour, approximate: a colourised mosaic. NASA Ames blended the Viking orbiters' colour mosaic "
    "(photos from 1976-1980) over the grey MDIM 2.1 mosaic. USGS published the result in 2009. "
    f"Producer's record: {VIKING_PRODUCER_PAGE}",
    "Level 7 is the finest level Mars Trek serves (about 326 m per pixel; the mosaic itself is 232 m). "
    "It is cached around Jezero, and level 3 for the rest of the planet. Far-away context only.",
    "The mosaic shows joins between Viking photos in places (for example about 250 km north of Jezero). "
    "They are in the source data.",
)


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
    """Map tiles cached in a mission package, in drawing order (first = bottom)."""
    return (
        TileLayer("mola", TREK_MOLA_LABEL, "jpg", (0, 3), None,
                  "MOLA colour shaded relief (global)", "topographic", 463,
                  "NASA/JPL/GSFC MOLA, via Mars Trek"),
        TileLayer("mola-region", TREK_MOLA_LABEL, "jpg", (4, 7), REGION_BBOX,
                  "MOLA colour shaded relief (region)", "topographic", 463,
                  "NASA/JPL/GSFC MOLA, via Mars Trek"),
        TileLayer("viking", TREK_VIKING_LABEL, "jpg", (0, 3), None,
                  "Viking colour mosaic (global, natural colour)", "optical", 232,
                  VIKING_CREDIT, VIKING_NOTES),
        TileLayer("viking-region", TREK_VIKING_LABEL, "jpg", (4, 7), REGION_BBOX,
                  "Viking colour mosaic (region, natural colour)", "optical", 232,
                  VIKING_CREDIT, VIKING_NOTES),
        TileLayer("ctx-wide", TREK_CTX_WIDE_LABEL, "png", (7, 10), CRATER_VIEW_BBOX,
                  "CTX photo mosaic, Jezero crater and around it (preliminary)", "optical", 6,
                  "NASA/JPL-Caltech/MSSS (CTX), via Mars Trek",
                  ("Mars Trek calls this mosaic preliminary. It lies about 80 m south of the controlled CTX mosaic "
                   "(measured on three tiles) and shows seams between image strips: far-away context only, not for positions.",
                   "Cached to level 10 (about 40 m per pixel) for the crater and about 14 km around it. "
                   "A very wide or a tall window shows more than that: the planet map is at its edges then.",
                   "The mosaic has one gap of about 3 km2 just south-west of the crater rim (near 77.38 E, 17.98 N). "
                   "The planet map shows through there. The gap is in the source data.")),
        TileLayer("ctx-crater", TREK_CTX_LABEL, "png", (8, 11), CTX_MOSAIC_BBOX,
                  "CTX photo mosaic, west side of Jezero crater (controlled)", "optical", 6,
                  "NASA/JPL-Caltech/MSSS (CTX), via Mars Trek",
                  ("Cached to level 11 (about 20 m per pixel) for the whole controlled mosaic. It covers the western 40% "
                   "of Jezero crater (the delta and both walk zones); the 6 m detail is cached only around the walk zone.",)),
        TileLayer("ctx", TREK_CTX_LABEL, "png", (8, 13), zone.context,
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
    {"id": "A3", "statement": "Walking speed on flat ground in a suit, carrying the standard kit (A17)", "value": 2.5, "unit": "km/h", "status": "to_verify",
     "reference": "Speed on slopes scaled with Tobler's hiking function. Carried load changes the time (A15-A21)"},
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
    # Gear load (Part 2). Walking time is multiplied by (A15 + A16 + heaviest load) / (A15 + A16 + A17):
    # time grows with the mass moved. Mass, not weight: on Mars a load weighs 0.38 of its Earth weight,
    # but its mass (inertia) stays, and NASA's metabolic model scales with mass. Route paths do not change.
    {"id": "A15", "statement": "Astronaut body mass (load model)", "value": 82, "unit": "kg", "status": "to_verify",
     "reference": "NASA JSC, Mars Spacesuit Mass Requirements, ICES-2026-127 (2026), NTRS 20260005410: average male crew member 180 lbm (82 kg). A planning value, not a measurement"},
    {"id": "A16", "statement": "Mass of a Mars spacesuit with its life support", "value": 104, "unit": "kg", "status": "to_verify",
     "reference": "NASA JSC ICES-2026-127 (2026): estimated maximum Mars suit mass 229 lbm (104 kg); today's Artemis xEMU is 376 lbm (170 kg). An estimate, not a measured suit"},
    {"id": "A17", "statement": "Standard kit each astronaut carries from the start (tools, camera, sample bags); walking speed A3 applies with this kit",
     "value": 15, "unit": "kg", "status": "to_verify",
     "reference": "Starting value chosen for Baramger, below the 50 lbm (22.7 kg) of tools and samples in NASA's Mars suit sizing (ICES-2026-127)"},
    {"id": "A18", "statement": "Mass of one Mars 2020 sample tube with its sample", "value": 0.08, "unit": "kg", "status": "to_verify",
     "reference": "JPL (21 Dec 2020): each empty tube weighs less than 57 g; about 20 g of sample added (estimate). https://www.jpl.nasa.gov/news/a-martian-roundtrip-nasas-perseverance-rover-sample-tubes/"},
    {"id": "A19", "statement": "Mass of one rock sample taken by the crew", "value": 1.0, "unit": "kg", "status": "to_verify",
     "reference": "Starting value for a field-geology hand sample. For scale: Apollo returned 382 kg in 2,196 samples, about 0.17 kg each (NASA)"},
    {"id": "A20", "statement": "Carried load per astronaut above which to take care", "value": 22.7, "unit": "kg", "status": "to_verify",
     "reference": "NASA JSC ICES-2026-127 (2026): 50 lbm (22.7 kg) of tools and samples per astronaut assumed in Mars suit sizing"},
    {"id": "A21", "statement": "Most load one astronaut may carry; more is too heavy and the plan cannot be approved", "value": 30, "unit": "kg",
     "status": "to_verify", "reference": "Starting value chosen for Baramger; to verify with suited load tests (NASA plans ARGOS tests with varied mass)"},
    # Scale card: the map draws a person next to its scale bar (the spacecraft sizes are NASA's, source S8).
    {"id": "A22", "statement": "Height of the person drawn in the map's scale card (a person in a suit)", "value": 1.8, "unit": "m",
     "status": "to_verify", "reference": "A round value, the same as the suit antenna height (A8). A drawing for scale, not a measurement"},
)

COMFORT_SLOPE_DEG = 15.0
MAX_SLOPE_DEG = 25.0
FLAT_SPEED_KMH = 2.5
EVA_MIN = 360
RESERVE_FRACTION = 0.30
BASE_ANTENNA_M = 3.0
SUIT_ANTENNA_M = 1.8
