# Baroler: a Marswalk planner for Jezero crater

Baroler helps two astronauts plan a walk on Mars, stay safe on the way, and do real science at each stop. It was built for the NASA challenge **"Interplanetary Survival Guide: Martian Map"** (full text in [`TheChallenge.txt`](TheChallenge.txt)).

It layers NASA data from several missions into one offline map of a small walk area in Jezero crater, the place where the Perseverance rover works. It covers the whole walk: planning it the evening before, guiding the crew outside, and looking back afterwards.

## What it does

| Step | Screen | What the crew gets |
|---|---|---|
| **Start** | Habitat wall screen | A short launch animation: a telescope on Earth finds Mars, then the view flies to the planet. It ends on the whole of Mars, which can be turned and zoomed freely. The walk zones are marked; click one to fly in. |
| **Plan** | Habitat wall screen | A 3D map with layers (photo map, steep ground, rock types, rocky or dusty ground, the rover's path). Stops with real rover photos of each spot; the crew can add their own stops and name them. Known places keep their name on the map, also when they are not stops. The safest route between stops. A crew size and the load each astronaut carries. A safety check (time and reserve, slope, radio contact, daylight, sun activity, carried load, buddy rule, turn-back times). Walk conditions measured by Perseverance. A walk-through preview. |
| **Walk** | Tablet on the suit arm | The next stop with distance, time and direction. Warnings ahead (steep ground, sand ripples, rocky ground, radio loss, running late, sunset). Stop timer and task list; picking up a tube or a sample adds to the crew's load and to the walking time. Skip a stop or head home, and the route re-plans from where the crew stands. Field notes pinned to the map. |
| **Helmet** | Helmet display (HUD) | An eye-level view with only the essentials: next stop, time left, radio, and one warning at a time. |
| **After** | Habitat | A replay of the walk, "plan and reality" per stop, and a printable walk report. "Send to Earth" shows today's Earth–Mars signal delay (about 11 minutes on 14 Nov 2026). |

On the tablet and in the helmet, the walk runs as a **time-lapse demo** along the approved route. On Mars, the suits' navigation would give the real position.

**Nothing scrolls.** Every screen is one side panel with tabs; details open in pop-ups, and long lists have pages. On a short window the panel is scaled down to fit. While the walk plays, no button moves or blinks: the screen updates only the text that changed.

## Two walk zones

| | Zone Z2: Bright Angel | Zone Z1: Three Forks |
|---|---|---|
| Science goal | Study the spotted rocks at Cheyava Falls | Collect the ten sample tubes Perseverance left on the ground |
| Stops | 4 | 10 |
| Route | 3.20 km, 3 h 42 min with stops | 1.23 km, 2 h 10 min with stops |
| Reserve (rule: at least 30%) | 38% | 64% |
| Steepest ground | 21° | 6° |
| Radio contact | 2 short gaps, 4 min at most | The whole walk |
| Weather reference | Perseverance MEDA, sols 1210–1218 (Jul 2024) | Perseverance MEDA, sols 653–659 (Dec 2022) |

The app opens on the whole planet. Click a marked zone on the map or press **Open** in the zone list. Inside a zone, the menu at the top of the map switches zones and **Mars globe** goes back to the planet. `#z1` / `#z2` in the address bar opens that zone.

**About the Z1 tube positions:** NASA publishes the exact tube spots only as a picture ([PIA25682](https://www.jpl.nasa.gov/images/pia25682-perseverances-three-forks-sample-depot-map/)), not as data. Each depot stop is where Perseverance parked while it dropped a tube, so the tube should lie within a few metres. The app says this on screen (assumption A14, to verify).

## Run the app

You need **Node.js** (tested with version 24) and **npm**. The two mission packages are already in this repository, so nothing needs to be downloaded or built first.

```bash
cd app
npm ci
npm run dev
```

Then open http://localhost:5173. The app works without internet: map tiles, terrain, photos, weather and fonts are all in the app and the mission packages.

- The launch animation plays once per browser tab. Add `?nointro` to the address to skip it; it is also skipped when the system asks for reduced motion. "Play the launch animation again" is on the whole-planet screen.
- The app is made for a wide window (about 1100 px or more). In a narrow window the map gets a small strip beside the panel; the `›` button hides the panel, and the helmet view uses the whole window.

Other commands, from the `app` folder:

```bash
npm test          # unit tests (vitest; the screen tests use jsdom)
npm run build     # type check + production build into app/dist
```

`app/public/package` and `app/public/cesiumStatic` are symbolic links (to `data/package` and to the CesiumJS build in `node_modules`). On Windows, turn on symlink support in git before cloning.

## Deploy (Cloudflare)

The app is hosted on Cloudflare as static files (Workers static assets, config in `app/wrangler.jsonc`).

- **Automatic:** the GitHub Actions workflow `.github/workflows/ci-deploy.yml` runs the app and pipeline tests on every push and pull request. On a push to `main`, it deploys the app if the tests pass.
- **By hand:** from the `app` folder, run `npx wrangler login` once, then `npm run deploy` (builds, then uploads `app/dist`).

The workflow needs two repository secrets (GitHub > Settings > Secrets and variables > Actions):

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token made from the "Edit Cloudflare Workers" template
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID

## Rebuild a mission package (optional)

The data pipeline is in Python. You need **[uv](https://docs.astral.sh/uv/)**; it brings Python 3.12 and the GIS libraries itself.

```bash
cd pipeline
uv run baroler-build --zone z2      # or --zone z1
```

- Building both zones downloaded about 0.5 GB of raw data into `data/raw/` (not in git). This includes the walk-area window of the HiRISE 1 m terrain model, read with HTTP range requests from the USGS copy.
- Add `--skip-tiles --skip-photos` to reuse tiles and photos that were already downloaded.
- The build ends with "all checks passed" or a list of what failed, and it updates `data/package/index.json` (the app's zone list).
- Optional: set `NASA_API_KEY` (a free key from api.nasa.gov) to add NASA DONKI space-weather events. NOAA SWPC sun data is always used.

Pipeline tests:

```bash
cd pipeline
uv run --group dev pytest -q
```

## Data sources and credits

The challenge lists five resources. Baroler uses all five; the mission package schema refuses a package that does not list them.

| ID | Source | Used for | Credit |
|---|---|---|---|
| R1 | [JPL Mars Trek](https://trek.nasa.gov/mars/) | HiRISE and CTX photo maps, HiRISE 1 m and CTX terrain, THEMIS night heat, MOLA | NASA/JPL-Caltech Mars Trek; instrument teams per layer |
| R2 | [USGS–NASA Planetary Geologic Mapping](https://planetarymapping.wr.usgs.gov/) | Rock types at each stop and along the route | Sun, V.Z., and Stack, K.M., 2020, [USGS SIM 3464](https://doi.org/10.3133/sim3464) |
| R3 | [Curiosity's Proposed Path up Mount Sharp (PIA23179)](https://www.jpl.nasa.gov/images/pia23179-curiositys-proposed-path-up-mount-sharp/) | Design reference for the annotated route (not map data) | NASA/JPL-Caltech/ESA/Univ. of Arizona/JHUAPL/MSSS/USGS |
| R4 | [NASA Worldview](https://worldview.earthdata.nasa.gov/) | Design reference for the layer list and compare view (Earth only, not Mars data) | NASA Worldview / EOSDIS |
| R5 | [Mars Perseverance Raw Images](https://mars.nasa.gov/mars2020/multimedia/raw-images/) | "What you will see" photos at each stop | Per image, e.g. NASA/JPL-Caltech/LANL/CNES/IRAP |

Extra sources are used **next to** the five resources, never instead of them. Each must pass five checks: no link to China, permission to use, verified from the official producer, a documented product, and real measured data.

| ID | Source | Used for | Credit |
|---|---|---|---|
| S1 | [Perseverance rover waypoints](https://mars.nasa.gov/mars2020/mission/where-is-the-rover/) | Placing rover photos on the map; the Z1 depot stops | NASA/JPL-Caltech |
| S4 | [Perseverance MEDA weather, NASA PDS](https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/) | Air and ground temperature, air pressure | NASA/JPL-Caltech/CAB (MEDA), NASA PDS |
| S7 | [NOAA Space Weather Prediction Center](https://www.swpc.noaa.gov/) | Solar flares and particle levels (measured near Earth) | NOAA SWPC |

The full source ledger, with what was checked and when, is in [`data/sources.registry.json`](data/sources.registry.json). Every photo in the app carries its own credit line.

NASA does not endorse this project.

## How it works

1. **Pipeline** (`pipeline/`) builds one offline **mission package** per zone in `data/package/`: terrain grids, a 2 m routing grid with slope and roughness, no-go areas (steeper than 25°), rock types, map tiles, rover photos and positions, weather, daylight and sun activity. Every download is recorded with its URL, time and sha256. The package is checked against [`schema/marswalk.schema.json`](schema/marswalk.schema.json).
2. **App** (`app/`, Vite + TypeScript + CesiumJS 1.146) loads the package and does the rest in the browser: route finding (A* with walking speed by slope), radio line of sight from the habitat antenna, safety checks, the walk demo, the replay and the report. CesiumJS is the only map engine: the Mars in the launch animation is the same globe the crew then plans on (the night sky before it is a drawing, and the screen says so).

Some facts we checked along the way:

- Mars is drawn on the **Mars 2000 sphere** (radius 3,396,190 m). CesiumJS's built-in `Ellipsoid.MARS` is flattened and would shift latitudes by about 12 km at Jezero.
- The slope map agrees with the rover's own tilt sensor: **1.9° mean error** at 79 rover positions (Z2) and **1.3°** at 124 (Z1).
- Sunrise and sunset use the NASA GISS Mars24 equations, within 0.6 minutes of the rover's own times.
- Earth–Mars signal delay uses JPL's approximate planet elements, checked against astropy to 0.0001 AU.

## Limits and open assumptions

- **Starting values to confirm (A1–A21).** For example: 15° comfortable slope, 25° maximum slope, 2.5 km/h walking speed on flat ground, a 6-hour walk, and 30% time kept in reserve. The app lists them on screen.
- **Carried load is a model, not a measurement.** Walking time grows with the mass each astronaut moves (body + suit + load, about +0.5% per extra kg), using NASA planning values for body and suit mass (A15–A21). NASA has no published test of suited walking speed versus load at Mars gravity yet.
- **Small rocks.** The terrain model has 1 m detail and routing uses 2 m cells. Rocks smaller than that do not show up as obstacles; the crew sees them on the 25 cm photo map and in the rover photos.
- **Rock borders.** The USGS rock map's unit borders can be 100–200 m off (USGS readme), and the app says so. Unit names are shown exactly as USGS publishes them, including its typo "Crater riim unit".
- **Weather and sun activity** are real measurements from a reference period, not a forecast for the day of the walk. Sun activity is measured near Earth.
- **Demo mode.** The walk runs as a time-lapse on one screen, and "Send to Earth" saves the report files instead of sending them.
- **The whole-planet map shows heights, not true colour.** It is the MOLA height map from Mars Trek (blue is low ground, not water). The sharp photo maps are only inside the walk zones.

## Repository layout

```
app/         CesiumJS web app (launch animation, Mars globe, Plan, Walk, helmet display, replay, report)
pipeline/    Python pipeline that builds and checks the mission packages
data/        mission packages (data/package/) and the source ledger
schema/      JSON Schema for mission packages and the source ledger
docs/        plan, report, short summary, user scenario, MCP guide
CLAUDE.md    project brief for Claude Code
```

More detail: [`docs/PLAN.md`](docs/PLAN.md) (analysis, decisions, findings), [`docs/Baroler-Report.html`](docs/Baroler-Report.html) (full report), [`docs/Baroler-Summary.html`](docs/Baroler-Summary.html) (short summary for everyone), and [`docs/Baroler-User-Scenario.html`](docs/Baroler-User-Scenario.html) (the story of two walks, told from the user's side).

## License

No license has been chosen yet. NASA, USGS and NOAA data keep their own terms and credits, listed above.
