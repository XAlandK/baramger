# Baramger — Analysis & Plan

> Challenge: **"Interplanetary Survival Guide: Martian Map"** (NASA hackathon challenge, source text in `TheChallenge.txt`).
> Status: **built: P1 to P4, the review fixes, the gear-load feature, UI round 2 and map round 3 are done and tested in the browser (2026-11-14); round 4 and the AI mission assistant (Ask tab, 2026-11-15) added since: see their sections.** Open: the submission (video, credits), the open questions at the end of "UI round 2", and two points of "Map round 3": three more place names that need the user's decision (finding 51), and an outer ring of crater photo tiles for narrow windows (finding 54, needs a rebuild).
> Last verified against live NASA/USGS services: **2026-11-14**.

---

## 1. The challenge in one paragraph

Build a map, tool, or interface that a Mars astronaut could use on a surface walk ("Marswalk").
It must give a **layered, combined view of one small place or one route** using data from **several NASA missions**.
It should help the crew **plan the walk, stay safe, and do good science**.
The key gap NASA names: today's tools (Mars Trek, the USGS geologic maps) are built for **global and regional** views, not for the **hyper-local** area (a few hundred metres to a few km) that one walk covers.

## 2. Requirements, sorted

| Level | Requirement | Source line |
|---|---|---|
| **Must** | A map/tool/interface usable during a surface mission | Objectives ¶1 |
| **Must** | Use NASA data and tools | Objectives ¶1 |
| **Must** | Layered, integrated view of one location or route | Intro |
| **Must** | Data from multiple NASA science missions | Intro |
| **Must (user rule)** | Use the data listed in the **Resources** section | User instruction |
| Should | Pick science goals + a location that fits them | Objectives ¶1 |
| Should | ≥ 3 kinds of data (optical, thermal, spectral, topographic, …) | Objectives ¶3 |
| Should | Safety first: info that helps the crew move safely | Objectives ¶4 |
| Should | Route map that avoids big obstacles (rocks, etc.) | Objectives ¶4 |
| Should | Think about spacesuit mobility and carried gear | Objectives ¶4 |
| May | Format: habitat screen, tablet, helmet HUD, other | Considerations |
| May | Static, interactive, or a map *generator* | Considerations |
| May | Time frame: past, predicted, or none | Considerations |
| May | Point-of-view (ground) images from rovers | Considerations |
| May | Rover support, astronauts working in pairs | Considerations |

## 3. The five resources — what they really are (verified)

| ID | Resource | What it actually gives us | Format / access | Verified |
|---|---|---|---|---|
| **R1** | JPL **Mars Trek** | Map layers: HiRISE 25 cm image mosaic and 1 m DEM of **Jezero**, CTX 6 m mosaic + 20 m DEM, THEMIS day/night infrared (100 m, global), TES thermal inertia & minerals (km-scale, global), global geology (SIM 3292), Perseverance traverse path. Also Gale crater CTX mosaic + HiRISE 1 m DEM. | OGC **WMTS** tiles (`trek.nasa.gov/tiles/Mars/EQ/<layer>/1.0.0/…`), Solr **search API**, file **download** (`/mars/TrekWS/rest/cat/data/stream?label=<layer>`) | ✅ |
| **R2** | USGS–NASA **Planetary Geologic Mapping** | **SIM 3292** global geologic map (1:20,000,000) and **SIM 3464** Jezero crater & Nili Planum map (1:75,000, Sun & Stack 2020, public domain). | PDF map sheet, GIS database zip (≈349 MB), SIM 3292 also as a Trek layer | ✅ (pages reachable; GIS zip contents not yet opened) |
| **R3** | Curiosity **proposed route map** (PIA23179) | Annotated route up lower Mount Sharp (Gale crater), animation + flyover video. Released **May 2019**. | Static image / video — **not GIS data** | ✅ |
| **R4** | **NASA Worldview** | Satellite imagery of **Earth** (GIBS). **No Mars data.** | Web app / WMTS for Earth | ✅ (by definition) |
| **R5** | **Perseverance Raw Images** | 1,055,868 images (latest: sol 2031, 2026-11-06). Each has sol, camera, UTC + Mars time, image URLs (320/800/1200/full), credit, caption, rover `site`/`drive`, mast azimuth/elevation, CAHV camera model. | JSON API `mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&ver=1.2…` | ✅ |

Working raw-image query (filter by sol):
`…&ver=1.2&num=100&page=0&order=sol+desc&condition_2=<SOL>:sol:gte&condition_3=<SOL>:sol:lte&extended=sample_type::full,`
(sol 1212 → 400 full-frame images at site 56).

## 4. Flags — surprises and risks 🚩

1. **🚩 Location conflict (biggest issue).** The challenge's own example (boxwork, Curiosity, Mount Sharp) and resource R3 are in **Gale crater**. The only ground-image resource (R5, Perseverance) is in **Jezero crater**, about **3,750 km away**. One Marswalk cannot use both rovers' ground data. → **Only Jezero lets all five resources play a real role.**
2. **🚩 NASA Worldview is Earth-only.** It has no Mars data. Honest use: **design inspiration** (layer picker, timeline, side-by-side compare), which the challenge itself invites ("look at how missions to … Earth … created this type of map").
3. **🚩 Links are missing from the text file.** The resource names are there, the URLs are not; lines 32–34 are broken. The text also says "more resources may be added before the hackathon" → re-check the live Resources tab.
4. **🚩 Scale gap.** A Marswalk needs ≤ 1 m detail. Only HiRISE (25 cm image, 1 m DEM) is fine enough. Geologic maps are 1:20M (global) and 1:75k (Jezero); THEMIS is 100 m; TES is kilometres. These are *context*, not walk-level data.
5. **🚩 Spectral/mineral data at walk scale is missing** in the resources for Jezero (Trek CRISM tiles found are elsewhere; TES is km-scale).
6. **🚩 Safety data gaps.** No radiation, space-weather, dust-storm or weather data in the five resources, even though the challenge asks for safety and "current conditions". Needs supplementary NASA data (e.g., Perseverance MEDA weather). → **D2 approved with conditions**: candidate sources and rules in section 6.
7. **🚩 Raw images are not on a map by themselves.** `xyz` is often `(0,0,0)`. To place an image you join `site` + `drive` → rover **waypoints** (`RMC`). The waypoint file (`mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json`, 708 points, sol 13–2022) is on the same NASA site but **not in the resource list**. Fallback: Trek's traverse path (R1), but it is stale (see 8). → **Approved as S1 under D2.**
8. **🚩 Trek's Perseverance path is stale.** Created 2024-07-03; it ends around **sol 1219**. 263 of 708 waypoints (from sol 1219) fall outside it, and 44 waypoints (from sol 1815) are **west of the HiRISE Jezero coverage**. → Pick a walk site visited **before ~sol 1800**.
9. **🚩 Big files.** HiRISE Jezero mosaic ≈ **9.8 GB**, HiRISE DEM ≈ **1.8 GB** (server ignores HTTP Range → must download whole file once, then clip). The DEM is **not** offered as WMTS tiles. SIM 3464 GIS zip ≈ 349 MB.
10. **🚩 R3 is old and only an image.** The 2019 route is no longer Curiosity's real route. Use it as a **visual style reference** for annotated route maps.
11. **🚩 Offline reality.** On Mars there is no internet and a 4–24 min light delay. A real crew tool **cannot call trek.nasa.gov**. Design **offline-first**: a pre-built "mission package" for the chosen area.
12. **🚩 Coordinates & elevation.** Mars 2000 sphere (R = 3,396,190 m), planetocentric, east-positive longitude. Elevations mix *areoid/geoid* and *radius* references (`elev_geoid` vs `elev_radii`). Standardise on **metres above MOLA areoid**. GeoJSON officially means Earth (WGS 84) — we use its structure but declare the Mars CRS in the package.
13. **🚩 Suit limits are assumptions.** No resource gives spacesuit slope/speed limits. Defaults below are placeholders to verify.
14. **🚩 Credit lines.** Every raw image has its own credit (e.g., `NASA/JPL-Caltech/LANL/CNES/IRAP`). Must show it.
15. **ℹ️ Local tooling.** No GDAL installed; system Python is 3.9. `uv` and Node 24 are available → use `uv` with Python 3.12 + rasterio wheels later.
16. **🚩 Cesium Mars is sharp only at Gale.** Cesium's ready-made 3D Mars (Cesium ion, released Sept 2025) has Gale at 25 cm image / 1 m terrain, but **Jezero only at 6 m / 20 m** (global: 232 m / 200 m). It needs a Cesium ion account and internet, and it is **not** in the resource list. → Use the free CesiumJS *engine* with Mars Trek data; Cesium Mars is at most an optional far-zoom globe (extra source S2, needs D2).

## 5. Recommended concept

**"Baramger — Marswalk Planner & Field Guide"**: one offline-first web app with three views that share one data package.

| View | Device | Purpose |
|---|---|---|
| **Plan** | Habitat wall screen | Pick science stops, auto-build the safest route, check time and walk-back limits. |
| **Walk** | Tablet on the suit arm | Current leg, distance/bearing to next stop, hazards ahead, "what you will see" ground photo. |
| **HUD** | Helmet visor (mock-up) | Minimal: arrow, distance, time left, warnings. |

### Location (D1 — decided: Jezero crater, because the chosen zone Z2 is in Jezero)

Candidate walk zones (all inside HiRISE 25 cm + 1 m DEM coverage, with dense Perseverance images):

| Zone | Why | Rover sols |
|---|---|---|
| **Z1 — Three Forks sample depot** (delta front) | Crew could **pick up the 10 sample tubes** Perseverance left; delta-front layers. | ≈ 650–690 |
| **Z2 — Bright Angel / Cheyava Falls** (Neretva Vallis) | Source rock of the "Sapphire Canyon" sample that NASA called a **potential biosignature**; humans can judge it in context. | ≈ 1200–1219 |
| **Z3 — Crater floor (Máaz / Séítah)** | Flattest, safest "first walk"; early-mission images. | ≈ 13–400 |

**Decided (D3): Z2 — Bright Angel / Cheyava Falls.** **Z1** is a later extra: start it only when the user asks for it.

### Data layers (≥ 3 kinds, every one traced to a resource)

| Layer | Kind | From | Res. | Use |
|---|---|---|---|---|
| HiRISE Jezero ortho mosaic | optical | R1 | 0.25 m | Base map, boulder spotting |
| CTX Jezero mosaic | optical | R1 | 6 m | Zoomed-out context |
| HiRISE Jezero DEM | topographic | R1 | 1 m | Slope, roughness, profiles, line-of-sight |
| CTX Jezero DEM | topographic | R1 | 20 m | Regional terrain |
| THEMIS night IR | thermal | R1 | 100 m | Rock vs. dust proxy (warm at night = rocky) |
| TES thermal inertia / minerals | thermal / spectral | R1 | km | Regional context only |
| SIM 3464 geologic units | geologic | R2 | 1:75k | Which rock unit each stop is on |
| SIM 3292 global geology | geologic | R1/R2 | 1:20M | Big-picture context |
| Perseverance traverse | rover track | R1 (+S1) | — | Where ground truth exists |
| Perseverance ground photos | ground imagery | R5 | — | "What you will see" at each stop |
| **Derived:** slope, roughness, cost surface, route, hazards, viewshed | derived | from R1/R2 | 1 m | The integration — the real value |
| Route-map visual style | design ref. | R3 | — | Annotation style |
| Layer picker / timeline / compare UX | UX ref. | R4 | — | Interface patterns |

### Route engine (later implementation)

- **Cost surface** per 1 m cell = weighted mix of slope, roughness, rock proxy, geologic-unit risk, distance.
- **Least-cost path** between stops (A* / `route_through_array`).
- **Constraints** (placeholder values, assumption A1–A4):
  - Slope: ≤ 15° comfortable, 15–25° caution, > 25° no-go.
  - Walking speed on flat ground ≈ 2.5 km/h, slower uphill.
  - EVA length ≈ 6 h with ≥ 30 % reserve for walk-back.
  - Max distance from base/rover: a parameter (walk-back rule).
  - Two-person crew (buddy rule).
- **Safety extras:** line-of-sight to habitat antenna (viewshed), turn-around time per stop, hazard list for the HUD.

### Stack (decision D4 — decided 2026-11-14: CesiumJS)

- **Map engine: CesiumJS** (open source, Apache 2.0) for every map view, with `Ellipsoid.MARS`:
  - **Plan screen (3D):** fly from the whole planet to the site; HiRISE imagery (R1, Trek WMTS) draped on the HiRISE 1 m terrain; route clamped to the ground; stops as pins; no-go and radio-shadow areas as shapes.
  - **Walk-through preview and after-walk replay:** Cesium clock + timeline, camera following the route at eye height.
  - **Tablet:** the same engine in top-down / 2D mode, so there is **one map engine** instead of OpenLayers + Cesium.
  - **HUD:** plain HTML/SVG overlay; no 3D engine needed.
- **App shell:** Vite + TypeScript.
- **Data pipeline:** Python 3.12 via `uv`, rasterio, numpy, shapely, pyproj, scikit-image. New job: turn the clipped HiRISE DEM into **Cesium terrain tiles** and pack them, with pre-cached Trek imagery tiles, into the offline mission package.
- **Hosting:** static site; works offline from the mission package (no Cesium ion needed).
- **Not chosen:**
  - **Three.js:** general 3D; we would have to build the globe, coordinates, tile loading and terrain streaming ourselves.
  - **OpenLayers:** CesiumJS covers top-down maps too.
- **Cesium Mars tileset (S2):** optional far-zoom globe only, if D2 = yes. Not used at walk scale (see flag 16).
- **To check when building:**
  - `Ellipsoid.MARS` radius vs our Mars 2000 sphere (3,396,190 m), so heights line up.
  - Trek WMTS through Cesium's `WebMapTileServiceImageryProvider` + `GeographicTilingScheme` on the Mars ellipsoid.
  - Map speed on a tablet.

## 6. External data and MCP rules (D2 — approved 2026-11-14, with conditions)

The user approved extra data **next to** the five required resources. R1–R5 stay the base. Every extra source (`S<n>`) must pass **all five checks** before we use it:

| # | Condition | What we check |
|---|---|---|
| **C1** | **No link to China** | Not made by a Chinese mission or agency (e.g., CNSA, Tianwen-1, Zhurong, Chang'e). Not hosted or served from China. Not a product that blends in Chinese data. No tool, MCP or service that fetches from or sends our data to hosts in China. |
| **C2** | **Permission** | A license or terms that allow our use (public domain, open license, or terms we have read). Credit line recorded. |
| **C3** | **Verified** | Comes from the official producer or archive (NASA, JPL, USGS, PDS, ESA, the instrument team). We opened it and checked it loads and matches its metadata. |
| **C4** | **Qualified** | An official, documented product (controlled or calibrated where that applies), with known resolution, date and accuracy. |
| **C5** | **Real** | Measured data. No simulated, AI-generated or made-up values shown as real. |

Record the result of each check in `data/sources.registry.json` (`verified`, `caveats`). A source that fails any check is not used. If a check can't be confirmed, ask the user.

### Candidate extra sources

| ID | Source (producer) | Use in Baramger | Status |
|---|---|---|---|
| S1 | Perseverance rover waypoints (NASA JPL) | Put R5 photos on the map; the Z1 depot stops | ✅ Passed C1–C5 — in use |
| S2 | Cesium Mars tileset (Cesium / Bentley; NASA, USGS, ESA data) | Optional far-zoom globe | ⏳ C2: read Cesium ion terms first |
| S3 | DONKI space weather (NASA CCMC) | Solar storm and radiation alerts | ⚠️ Passed C1–C5, but not always reachable (CCMC host timed out; api.nasa.gov DEMO_KEY is rate-limited). The pipeline uses it when it answers: it did at the rebuild of 2026-11-14, 17:02 UTC (no solar particle events in 30 days), so it is in both packages. Set `NASA_API_KEY` for steady access. |
| S4 | Perseverance MEDA weather (NASA PDS) | Air and ground temperature, air pressure at each zone | ✅ Passed C1–C5 — in use |
| S5 | Curiosity RAD surface radiation (NASA PDS) | Typical surface dose (measured at Gale; label it so) | ⏳ Run C1–C5 |
| S6 | MRO MARCI weather images (NASA / MSSS) | Dust storm watch | ⏳ Run C1–C5 |
| S7 | NOAA Space Weather Prediction Center (GOES flares and protons) | Sun activity check (measured near Earth, 1 AU) | ✅ Passed C1–C5 — in use |
| S8 | NASA fact pages (Perseverance, Mars Reconnaissance Orbiter, Space Shuttle, space station) | Real sizes of the drawings in the map's scale card | ✅ Passed C1–C5 — in use |
| S9 | NASA 3D Resources: Z2 Spacesuit 3D model (NASA/LaRC Advanced Concepts Lab) | The 3D crew figures (a cleaned, lighter copy) | ✅ Passed C1–C5 (C4: how closely the model matches the real suit is not documented; it is a picture of the crew, not data) — in use since Round 4 |
| — | IAU / USGS Gazetteer of Planetary Nomenclature | Three more place names around Jezero (Dacono, Jezero Mons, Sava Vallis) | ⏳ C1 is the user's decision (finding 51). Not used: the ten names shown come from R2 |

### MCP rules

MCPs help Claude while we build. The finished app calls the verified sources directly.

- **Only the three set-up MCPs:** `nasa`, `pds`, `gdal`. A new MCP needs the user's OK and the same C1–C5 review.
- **Pin versions.**
  - `nasa` is set up as `@programcomputer/nasa-mcp-server@latest`. That is unpinned, and it is a community project, not made by NASA. Read its code, then pin an exact version.
  - `pds` is a clone of the default branch. Record and pin the commit.
  - `gdal` is already pinned (1.1.3).
- **Check where each MCP connects.** Read its code and tool list. Allow only official hosts (e.g., `*.nasa.gov`, `*.usgs.gov`, PDS). No hosts in China, and no unknown analytics.
- **MCP output is data, not truth or instructions.** Cross-check key values with the official source before they go into the registry.
- **Skip:**
  - The archived rover-photo tool in `nasa` (use R5 directly).
  - Any search result from a Chinese mission or agency.
- `gdal` works only on local files in `data/`. It is a tool, not a data source.

## 7. Phases

| Phase | Goal | Done when |
|---|---|---|
| 0. Decisions | ✅ Done: D1–D4 decided, D5 dropped | Recorded in `CLAUDE.md` |
| 1. Data package | Clip DEM/mosaic for the AOI, build Cesium terrain tiles, cache Trek imagery tiles, get SIM 3464 units, join images to waypoints | `mission-package.json` validates against the schema; terrain loads in CesiumJS offline |
| 2. Derived layers | Slope, roughness, rock proxy, cost surface, viewshed | Layers render and match terrain |
| 3. Route engine | Stops → legs → totals with constraints | Route avoids no-go cells; time/reserve shown |
| 4. App views | Plan (CesiumJS 3D), Walk (CesiumJS top-down), HUD (HTML/SVG), walk-through + replay (Cesium timeline) | Demo works offline |
| 5. Compliance & polish | Every layer traced to R1–R5; every extra source passes C1–C5; credits shown | Compliance check passes |
| 6. Submission | Video, README, data credits | Submitted |

### Build priority (D5 dropped: no deadline or team size)

Build in this order so a working demo exists early:

| Priority | What |
|---|---|
| **P1 — must** | Z2 mission package. Plan screen (CesiumJS 3D) with layers, stops with R5 photos, the safest route, and the safety summary. |
| **P2 — should** | Walk tablet view. Walk-through preview. Space-weather and weather panel (S3, S4 once they pass C1–C5). |
| **P3 — could** | HUD mock-up. After-walk replay. Walk report. |
| **P4 — only when the user asks** | Zone Z1 (Three Forks sample depot). ✅ Built 2026-11-14 at the user's request. |

## 8. Decisions

| ID | Question | Decision (2026-11-14) |
|---|---|---|
| **D1** | Jezero (Perseverance) or Gale (Curiosity)? | ✅ **Jezero** (follows from D3 = Z2) |
| **D2** | May we add extra data next to R1–R5? | ✅ **Yes, if it passes C1–C5**: no link to China, permission, verified, qualified, real. Be careful with MCPs (section 6). |
| **D3** | Walk zone inside Jezero | ✅ **Z2 Bright Angel / Cheyava Falls.** Z1 later, only when the user asks (asked and built 2026-11-14, P4). |
| **D4** | Tech stack | ✅ **CesiumJS** map engine + Vite/TypeScript app + Python (uv) pipeline |
| **D5** | Deadline / team size | ➖ **Dropped.** Build by priority instead (see above). |

### P1 status — built 2026-11-14

**Mission package** (`pipeline/` → `data/package/z2-bright-angel/`, about 52 MB, passes the schema and cross-reference checks):
- **Terrain:** HiRISE 1 m (walk area 1.9 × 1.4 km) and CTX 20 m (context).
- **Routing grid:** 2 m cells with slope and roughness.
- **Image layers:** steep ground and rock types.
- **Map tiles:** 1,068 cached Trek tiles (HiRISE, CTX, THEMIS, MOLA), counted on disk 2026-11-14.
- **Photos:** 15 Perseverance photos at 4 stops.
- **Rover data:** 83 rover positions.
- **Hazards:** 60 no-go areas.
- **Records:** provenance with sha256 for every input.

**Plan screen** (`app/`, CesiumJS 1.146):
- 3D Mars sphere with real terrain, layer switches, and side-by-side compare.
- Stops: add by clicking the map, reorder, remove. Each stop card shows rover photos and the rock type.
- Safest route (A*, about 1 s), with the safety checklist, turn-back times, approve, and save.

Example result with the 4 package stops:
- 3.20 km and 3 h 41 min, with 39% reserve.
- Steepest 21°.
- Two short radio gaps (4 min at most).

**New findings while building:**
17. **🚩 CesiumJS `Ellipsoid.MARS` is flattened, not a sphere.** Mixed with our planetocentric data it would shift latitudes about 12 km. Fixed with our own Mars 2000 sphere.
18. **🚩 Trek's 1.84 GB DEM download crawled** (down to about 30 KB/s), and the server can't resume. Fixed: read only our window from the USGS producer's official copy (HTTP range reads; passes C1–C5).
19. **🚩 SIM 3464 rock borders can be 100–200 m off** (USGS readme). Shown as a warning on the rock-type layer.
20. **🚩 The habitat spot decides radio contact.** The flattest spot left 79 of 90 walking minutes without radio. The pipeline now picks flat ground (≤5°) with the best line of sight (90% of the walk).
21. **✅ Terrain verified against the rover:** slope vs rover-measured tilt has 1.9° mean error at 79 positions. Map heights agree with rover heights to 0.01 m, but those may use the same map.
22. **ℹ️ CesiumJS ground-clamping uses built-in Earth heights**, so we draw lines and pins at real heights and areas as image layers.

### P2 status — built 2026-11-14

- **Conditions in the mission package (`conditions/`):**
  - **Weather (S4):** real Perseverance MEDA measurements from NASA PDS for sols 1210–1218 (the Cheyava Falls stay). Air temperature in walk hours −85 to −40 °C; ground −88 to +1 °C; pressure about 747 Pa.
  - **Daylight:** sunrise 07:10 and sunset 18:03 (local Mars time, sol 1210), computed with the NASA GISS Mars24 equations. Checked two ways: within 0.6 min of Perseverance's own sunrise/sunset feed, and within 0.08 min of MEDA's mean-vs-true solar time.
  - **Sun activity (S7, new):** NOAA SWPC GOES flares (7 days) and ≥10 MeV protons (3 days). NASA DONKI (S3) is tried on every build and used when it can be reached.
- **New safety checks (assumptions A10–A13):**
  - Daylight: start 30 min after sunrise, back 60 min before sunset.
  - Sun activity: postpone at ≥10 pfu; take care for 24 h after an X-class flare.
- **Plan screen additions:**
  - Conditions section with a temperature-through-the-day chart (walk window and daylight shaded).
  - Height profile of the route.
  - Crew notes on stops.
  - "Ideas for next walk", each with an "Add as stop" button.
- **Walk-through:** drone camera along the route, height profile with the current position, and a pause at each stop with its rover photos.
- **Walk (tablet) view:**
  - Time-lapse demo of the approved walk: local Mars clock, on-time status, and a direction arrow with distance and time to the next stop.
  - Warnings: steep ground, sand ripples (USGS eolian bedform unit), bumpy ground, radio loss and return, running late, turn-back time, sunset.
  - At a stop: photos, task checklist and timer, with stay longer / leave now / skip next stop (re-plans from the current spot) / head home now.
  - Field notes and "mark for next walk", pinned on the map.
  - Walked track and an end-of-walk summary.
- **Tests:** 15 app tests (routing, radio, plan, daylight/sun checks, walk simulation) and 6 pipeline tests.

**New findings while building P2:**
23. **🚩 Perseverance's public weather feed is frozen** at sol 1133 (April 2024, 7 sols), and it is an outreach summary. Used NASA PDS MEDA files instead (calibrated, public, up to sol 1859).
24. **🚩 The Curiosity weather feed says "outreach purposes only"** (CAB disclaimer), so it fails C2. Not used.
25. **🚩 NASA DONKI could not be reached:**
    - The CCMC host timed out from this network.
    - api.nasa.gov's shared DEMO_KEY was rate-limited (10 calls/hour; retry after ~13 h).
    - Added NOAA SWPC (S7, passes C1–C5) as the measured source. A free personal NASA API key (`NASA_API_KEY`) would bring DONKI in.
26. **🚩 Sun data is measured near Earth.** Mars is about 1.5 AU from the Sun and often elsewhere in its orbit; the app says so wherever the data appears.
27. **🚩 The rover's raw spacecraft clock (SCLK) drifts** (about 17 min by 2024, 26 min by 2026). Don't use it for timing; use MEDA's LMST/LTST or UTC fields.
28. **✅ Sand-ripple warnings match the photos:** the "Eolian bedform unit" stretches line up with ripples you can see in the HiRISE images.

### P3 status — built 2026-11-14

- **Helmet display (HUD):** "Helmet view" switch in the Walk tab. Shows an eye-level 3D view (1.8 m) facing the walking direction, with a visor overlay:
  - next stop and distance, with an arrow relative to the crew's heading
  - walk time left and radio status
  - the stop timer while at a stop
  - one short warning at a time (60 characters at most, worst first)
- **Walk log:** every walk records time-stamped events (left, arrived, left stop, skipped, headed home early, notes, ideas, back) and a time-stamped track.
- **After-walk replay:**
  - Time slider and play at ×60/×120/×240. The crew marker moves along the real walked track over the planned route.
  - Clickable timeline of what happened.
  - "Plan and reality" table: arrival early or late, time at each stop.
- **Walk report:**
  - Stand-alone printable HTML (summary, vector map of planned vs walked, stop table, field notes with coordinates, timeline, conditions, the safety check at approval, light time, data credits, open assumptions) plus a JSON data file.
  - "Send to Earth" shows today's Earth–Mars distance and one-way signal time from JPL's planet position elements (14 Nov 2026: 1.32 AU, about 11 min). Checked against astropy to 0.0001 AU on 5 dates.
  - The demo does not transmit anything: you save the files.
- **Back in the plan:** stops show "visited / skipped last walk", and ideas marked on the walk appear under "Ideas for next walk" (scene 16).
- **Tests:** 19 app tests (adds light time, walk report) and 6 pipeline tests. Build passes.

**Findings while building P3:**
29. **ℹ️ Today's message delay is 11 minutes** one way (Earth 1.32 AU from Mars); it ranges from about 3 to 22 minutes over the years.
30. **ℹ️ My first light-time test limit was wrong** (it came from memory). The code matched an independent ephemeris, so the test now uses those reference values.

### P4 status — built 2026-11-14 (zone Z1, Three Forks)

- **One pipeline, many zones:** `config.py` has a `Zone` record per walk zone (`ZONES = {z1, z2}`). Build with `uv run baramger-build --zone z1`. Each build also writes `data/package/index.json`, the zone list the app reads.
- **Z1 mission package** (`data/package/z1-three-forks/`, about 57 MB, all checks passed):
  - Walk area 77.394–77.424 E, 18.4435–18.4635 N, inside the HiRISE 1 m DEM (window read from the USGS copy).
  - Slope check against the rover: 124 positions, 1.3° mean error.
  - Habitat on 0.8° ground with radio view of 100% of the area.
  - 10 depot stops, 39 rover photos, 5 rock types (all depot spots are on the Jezero floor unit), 925 map tiles, 18 no-go areas.
  - Weather: MEDA sols 653–659 (Dec 2022). Air in walk hours −85 to −26 °C, sunrise 06:44, sunset 18:41.
- **Depot stops:** the 10 rover parking spots at site 32 while the depot was laid (sols 652–692). Each has the tasks find / photograph / check / pick up the tube (10 min each).
- **App:**
  - Zone switcher (also `#z1` / `#z2` in the address bar).
  - Zone-aware texts, and a depot note linking the NASA depot map.
  - "Suggest order" (nearest-neighbour + 2-opt).
  - A "tubes picked up k of 10" counter in the walk and its summary.
- **Browser test (2026-11-14):** plan → route → approve → walk (all 10 tubes) → HUD → replay → report → Send to Earth all work in Z1. No console errors.
  - Route: 1.23 km, 2 h 10 min with stops, 64% reserve, steepest 6°, radio the whole walk.
  - Z2 re-checked after the fixes.
- **Fixed during the test:**
  - Stop numbers were hidden under the round pins (Z2 too). Each pin is now one image with its number.
  - Depot labels piled up (the spots are 7–22 m apart). A stop's name label now shows only when zoomed in close if another stop is within 60 m; the selected stop always shows its name.
  - Assumptions with no number printed "…: ." (plan panel and report).
  - The "Stops put in a short walking order" hint stayed on screen after it faded.
  - Typing a new zone in the address bar did not switch zones.
- **Tests:** 21 app tests and 11 pipeline tests (adds zone checks: areas nest in HiRISE coverage, stops are real rover positions, depot spots 3–40 m apart).

**Findings while building P4:**
31. **🚩 NASA publishes the depot tube spots only as a picture** (PIA25682). The MMGIS sample layers return 403. We use the rover's parking spots during depot building and say so (assumption **A14, to verify**). The tube from each drop should lie within a few metres of its spot.
32. **ℹ️ CacheCam took exactly 50 photos at every depot spot.** This looks like a fixed photo set for each tube drop, which supports A14. Three sols (658, 669, 670) hit our 800-photo download cap, so counts for other cameras there may be low.
33. **ℹ️ MEDA has no files for sols 660–661**, so the Z1 weather uses sols 653–659.
34. **✅ Fixed: the route line painted over pins** (Z1 and Z2). Cesium's "faint where hidden" line option (depthFailMaterial) also treated pins as hills, because pins ignore depth. Now each line (route, rover path, walked track) gets its own faint copy drawn before the markers, and pins, the crew marker and notes are drawn last.
35. **🚩 Clicking a pin used Cesium's GPU picking**, which was unreliable in the app's browser pane and doesn't work while the page is hidden. Pins are now hit-tested on screen (click within the pin's circle; nearest pin wins). Note: Jezero is about 2.5 km below the Mars 2000 sphere, so a "behind the planet" test must use a lower sphere (we use 9 km lower).
36. **ℹ️ USGS typo kept on purpose:** the SIM 3464 unit list has "Crater riim unit" (next to "Crater rim unit"). The app shows source names exactly as USGS publishes them, so we keep it (user decision, 2026-11-14). Don't "fix" it in the data.

### Review fixes (2026-11-14, Part 1)

A full review found six small problems. Fixed:
- **"Jump to next event" barely moved** when a warning was already showing (Z2 starts with "Sand ripples ahead"). It now stops only on a walk event or on a warning that is new; a warning that goes away and comes back counts as new. Logic in `walk.ts` (`advanceToNextEvent`); each warning has a stable key.
- **"5 h 60 min"** on the tablet: `format.ts` `mins()` rounds the total minutes first.
- **Tile counts with `--skip-tiles`**: the pipeline now counts the requested tiles already on disk (`tiles.count_cached`) instead of writing "0 of 0". Z2 shows the true 1,068 after the next rebuild.
- **Fonts loaded from the internet**: Barlow Semi Condensed, IBM Plex Mono and Inter (SIL OFL, @fontsource 5.3.0) are now bundled with the app.
- **Old text in this file** (status line, the extra-source table, the tile count, the registry list).
- **"Buddy rule" was always green.** Now a crew-size setting (1–4, default 2) drives it: a crew of 1 fails and blocks approval. The map label, the saved plan and the report follow the crew size. (Also fixed: the saved plan named every route "route-z2-…".)

**Tests:** 29 app tests (adds the jump, time-format and buddy-rule tests) and 14 pipeline tests (adds the tile-count tests). Type check and build pass.

### Part 2: gear load (2026-11-14)

The challenge asks how carrying equipment and supplies affects the astronauts' mobility. Before this, route time used only suit walking speed (A3) and slope.

- **Model (approved by the user):** walking time grows with the total mass an astronaut moves: body + suit + load. Time factor = (A15 + A16 + heaviest load) / (A15 + A16 + A17), about +0.5% per extra kg. The crew walks at the pace of the astronaut carrying the most; each pickup goes to the astronaut carrying less. Mass, not weight: on Mars a load weighs 0.38 of its Earth weight, but its mass (inertia) stays, and NASA's metabolic model scales with mass. Only time changes; the route path stays the same; time at stops is not affected. A3 (2.5 km/h) applies with the standard kit, so default plans barely change.
- **New assumptions (all "to verify"):** A15 body 82 kg, A16 Mars suit 104 kg (both NASA JSC ICES-2026-127 planning values), A17 standard kit 15 kg, A18 sample tube with sample 0.08 kg (JPL: empty tube < 57 g), A19 rock sample 1 kg, A20 take care above 22.7 kg (NASA's carry mass in Mars suit sizing), A21 too heavy above 30 kg.
- **Pickups:** Z1 each "Pick up the tube" (A18); Z2 "Take sample" at Cheyava Falls and "Collect a sample if safe" at stop 4 (A19). The plan assumes all planned pickups happen; on the walk, load is added when the pickup task is ticked.
- **App:** a load setting per astronaut, the load per leg in the leg list, a "Carried load" safety check (ok / take care / too heavy, which blocks approval), a "Carrying …" line on the tablet, time estimates on the tablet and helmet from the current load, and a "Carried load" table in the walk report. The saved plan file includes the crew and loads.
- **Effect with the starting values:** Z1 10 tubes → +0.2% on the last legs (seconds). Z2 → +0.5% after the rock sample; total 3 h 42 min (was 3 h 41), reserve 2 h 18 min, planned return 12:27. Carrying 25 kg → +5%.
- **Tests:** 40 app tests (adds 11 load-model tests) and 14 pipeline tests.
- **Rebuild (2026-11-14, 13:11 and 13:17 UTC, `--skip-tiles --skip-photos`):** both zones ended with "all checks passed". Only two files changed per zone: `mission-package.json` (A15–A21 added, A3 reworded, true tile counts, new timestamps) and `conditions/space-weather.json` (NOAA fetched again: 6 M-class and 0 X-class flares in 7 days; protons 0.224 pfu for Z1 and 0.275 pfu for Z2). Terrain, routing grids, overlays, rock map, photos and weather files are byte-identical. Z2 now records 1,068 of 1,068 tiles (Z1 925 of 925).

**Findings while building Part 2:**
37. **🚩 No official study of suited walking speed versus carried load at Mars gravity.** NASA's own slides (ICES-2026-127) call Mars-gravity suit studies "limited"; the 10-km walkback test did not vary weight. So the load effect is a model on NASA planning values, not a measurement (A15–A21 "to verify").
38. **🚩 The JPL sample-tube page contradicts itself:** "9 cubic inches (147 cubic centimeters) … about the size of a piece of chalk" (a chalk-sized core is about 15 cm³). We use only its "less than 57 g" tube mass.
39. **ℹ️ A3 (2.5 km/h) is plausible:** Apollo 15 measured 1.1–2.3 km/h; NASA's walkback planning assumes 3.5 km/h (ICES-2026-127).

### UI round 2 (2026-11-14): launch animation, Mars globe, no-scroll screens

The user asked for six things after trying the app. All six are built and were tested one by one with real mouse clicks and real animation frames, in a wide window (1280 × 800) and in a narrow one (600 × 720, the size of the Claude desktop browser pane).

1. **Launch animation** (`app/src/intro.ts`): night on Earth with a telescope and Mars as an orange dot; then the eyepiece, with Mars as a small disc; then the flight until the planet fills the view; then the panel slides in. It shows today's real Earth–Mars distance and light time (`lighttime.ts`). It plays once per browser tab; "Skip intro" and Escape end it; `?nointro` and "reduce motion" skip it; "Play the launch animation again" is on the whole-planet screen.
   - **Engine choice (flag):** the user said "do it with Three.js, but if there is something better, choose that". We used the app's own CesiumJS globe for Mars and plain HTML/SVG/canvas for the Earth scene. Reasons: D4 keeps one map engine; the animation ends exactly on the globe the crew then moves, with no cut; no second 3D engine to load; and the Mars in the eyepiece is the real NASA map (R1), not a second model. The night sky is a drawing and the screen says so (C5: nothing made up is shown as real). The warm tint and blur in the eyepiece fade out during the flight.
2. **Whole-Mars view:** the app opens on the planet (`state.view = "globe"`). Drag, scroll and tilt move it freely. One marker stands for Jezero from far away; closer in (12–120 km) each walk zone has its own marker, name and outline. Clicking a marker or "Open" flies into the zone; "Mars globe" flies back out. Another zone's package loads with a page reload and goes straight into that zone.
3. **No scrolling, anywhere:** one side panel with tabs (Goal, Layers, Stops, Route, Weather, Safety; Now, Progress, Notes on the walk), details in pop-ups (a stop, a known place, legs and loads, warnings, data and credits, ideas), long lists in pages. The panel has a design size of 392 × 740 px and is scaled down on a short window. A test hook (`overflowReport()`) checks every screen: zero overflow on 70+ screens per zone at five window sizes.
4. **Place names stay on the map:** every known place of the mission package (rover stops, Cheyava Falls rock, depot spots) keeps a ring and its name when it is not a stop, so the crew can see where to put stops. Click a name for its photos and "Add as stop"; "Known places off the plan" lists them. A "Place names" switch is in Layers.
5. **Stops can be renamed:** a new stop is "New stop N" and opens with its name selected, so typing replaces it. The list, the map label, the route legs, the walk and the report follow. Empty names fall back to the default; names are cut at 40 characters. Stops from the mission package keep their NASA-based names.
6. **No flicker on the walk screen.** There were two causes:
   - The panel was rebuilt with `innerHTML` up to five times a second, which re-created every button and photo (hover and pressed states reset, clicks got lost). Now `morph()` (`app/src/morph.ts`) changes only the text and attributes that differ.
   - Buttons also **jumped**: lines above them changed length with the clock (for example "Time here 13 of 30 min · then …" wrapped at some minutes), warnings came and went above the buttons, and tab labels changed width. Now the walk screen has a fixed-height card, then the buttons, then everything that can change; changing lines are single fixed-height lines; digits have equal width; tabs have equal widths; "Play / Pause" has a fixed width.
   - Measured: over a whole walk (1,069 screen updates) and with real frames (602 frames while playing), no control changed position or size and no button or photo was re-created.

**Also done in this round**
- **Narrow windows:** the panel stays beside the map while a strip of 200 px is left (so the middle of the map is never hidden); below that it lies over the map. Camera views move back on a narrow map (`widen()`), and the whole-planet view always fits the map (`planetAltitude()`, re-fitted when the window or the panel changes). Pop-ups use the whole window when there is no room beside the panel. The helmet view takes the whole window on a narrow map ("‹ Tablet" goes back).
- **The panel slides** in and out (also at the end of the launch animation) instead of jumping.
- **The loading screen waits until Mars is drawn** (`map.whenDrawn()`), so the animation never opens on a black map.
- **A window that is too short** (under 420 px) gets a notice instead of silently cut-off content.
- Small text fixes ("1 stop visited", "1 task ticked"), "Total time" instead of a cut-off label, and the map credits kept on one line.
- **Tests:** 86 app tests (adds 15 for `morph`, 8 for the launch animation, 19 for the screen-fitting rules, names and scripts, 4 for the walk fixes below; the DOM tests run in jsdom 29.1.1, a pinned dev dependency) and 14 pipeline tests. Type check and production build pass.
- **"Nothing scrolls" check:** `app/dev/ui-tour.js` opens every screen and pop-up (68 to 77 per zone) and asks the app for overflow. Both zones pass at 1280×800, 1024×560, 800×725, 600×720, 500×600 and 414×896 (870 screens in all). A clean run of both zones in a fresh tab gave no console errors.
- **"Nothing moves" check, after all fixes:** zone Z1 played for 30 seconds with real frames (1,807 frames, three stops with arrivals and departures): no control changed place or size, and all 17 fixed controls were still the same DOM nodes.

**Code review of this round (2026-11-14).** Six reviewers read the new code (panel logic, screen updates, map, start-up, layout, walk and replay); a second reviewer then tried to disprove each finding and checked the fixes. They reported 43 findings, about 31 different problems. None was a false alarm, and all are fixed. What was fixed:
- **🚩 Walk buttons changed their meaning in place.** After "Leave now", "Head home now" appeared in the same spot, so a double-click sent the crew home and skipped every stop that was left. Now the walk has one row with a fixed slot per button (Stay +10 | Leave now | Skip next | Head home); a slot is only switched off, never reused. "Head home" also works at a stop (the crew leaves it first).
- **A place pop-up stayed open when the walk or the walk-through started.** Its "Add as stop" then cleared the plan under the walk and froze the screen. Pop-ups, add-stop mode and the selected pin now close when the crew leaves the plan screen, stops can change only on the plan screen, and one error in a frame can no longer stop all animation.
- **Clicking the open "Walk (tablet)" tab threw a finished walk away** (also from the replay). The tab now only shows the walk; "Start a new walk" is its own button on the plan screen.
- **A new route search ended the old approval 30 ms late**, so a fast tap could open a walk on the old plan. The approval now ends at once, and nothing can be approved while a route is being found (the second reviewer found this gap in the first fix).
- **Arriving at a stop no longer changes the tab the crew chose** (Progress, Notes). The first tab turns into "At stop" with a dot instead.
- **Double-clicks:** "Find safest route" and "Approve plan" keep their own cells, and a click on a button that appeared less than half a second ago is ignored. Approving twice no longer opens the walk.
- **Blocked browser storage** no longer stops the app from starting (the session flags are optional).
- **Warnings looked at the wrong part of a new leg** right after "Leave now", "Skip next" or "Head home" (`lookAhead`).
- **Stop names in Kurdish, Arabic and other joined scripts** were drawn letter by letter on the map (CesiumJS labels do that). Such names are now drawn by the browser. Lists keep numbers in order beside right-to-left names.
- **Renaming a stop during a walk** now also renames it in "What happened" and in the report.
- **Layout:** the Z1 walk summary with four or more notes, the stop screen with a crew note, a warning and a message, the Progress tab with more than 10 stops, the "Legs and loads" and credits pop-ups on phone-size windows, and the photo viewer on short windows all fit now. The whole-planet panel has a hide button. The compare bar no longer stays on the globe. The chart's hover line and the replay slider follow correctly.
- **Typing `#z1` in the address bar** now opens that zone, not the planet.
- **Map:** CesiumJS's own Sun is switched off (it is placed for Earth's rotation and could glow beside Mars at some hours; it is not Mars data). Stop and place names stay visible when the camera stands back on a narrow map. On a very wide, low map the camera stands back too, so no stop falls below the edge. A stop's pin wins over the zone ring that sits on it when zoomed out, and zone markers do nothing during a walk. The fitted whole-planet view ends when the camera was moved during a flight.
- **🚩 The faint line copies were drawn over pins and names after all** (finding 34 was only half fixed). A reviewer read it from the CesiumJS source: marker collections with `BlendOption.TRANSLUCENT` are still drawn in the opaque pass, in the order of `scene.primitives`, and the copies were added after them. With the real, faint colours it was hard to see; a thick red test line showed it clearly. The copies are now inserted at the front of the list, and the same test line passes under the pin and its name.

**Findings in UI round 2:**
40. **🚩 A `data-view` attribute on `<body>` broke every tick box.** The click handler looks for the nearest `[data-view]` (the helmet button); with the attribute on `<body>`, every click in the panel matched it, redrew the panel and undid the tick. Scripted tests missed it because they set the boxes directly; real mouse clicks found it. The body now uses `data-screen`, and the handler ignores matches outside the panel.
41. **ℹ️ "Flicker" had two causes** (see point 6): rebuilt nodes, and buttons that jumped when text above them changed length. A DOM-diff alone would not have fixed the second.
42. **🚩 A browser tab that is not in front gets no animation frames**, even when `document.visibilityState` says "visible" (seen in the Claude desktop browser pane). The map stays black and nothing animates until the tab is shown. Tests must front the tab or drive the steps by hand; the app's loading screen gives up waiting after 6 seconds.
43. **ℹ️ CesiumJS `globe.tilesLoaded` is true before the first tile is asked for**, so "wait until tiles are loaded" needs "loading has started" as well.
44. **ℹ️ CesiumJS `fov` is the angle across the larger side of the map.** On a tall, narrow map the side-to-side angle is much smaller (20° instead of 60° on a 218 × 718 strip), so every fixed camera view cut off its subject. The views now scale with the map's shape.
45. **🚩 The whole-planet layer is the MOLA height-colour map** (blue = low ground). It can be read as "Mars with seas". A colour photo layer (for example the Viking colour mosaic on Mars Trek, R1; it is not true colour, see finding 48) would be better for the globe and the launch animation. It needs a tile download and a package rebuild, so it is an **open question for the user**. **Done in map round 3:** the Viking colour mosaic is a second look that the crew can switch on; the height colours stay the first look.
46. **ℹ️ Between 12 km and 120 km the map is blurry** (MOLA at about 460 m per pixel; the CTX photo map covers only each zone). A wider CTX layer for the crater would fix the crater view; same open question as 45. **Done in map round 3:** a wider CTX mosaic covers the whole crater.
47. **ℹ️ The Z2 numbers moved by one minute with the gear-load model:** 3 h 42 min with stops, reserve 2 h 18 min (38%), back at 12:27. The README is corrected; the three HTML docs still say 3 h 41 min and describe the screens before this round (**open: update them?**).

### Map round 3 (2026-11-14): natural-colour planet, crater photo map, place names, scale card

The user asked for three things: a true-colour planet **as an option** next to the height colours, a sharper map of the whole crater, and a person, probe or spacecraft as a scale reference. Official place names were on the same task card. Everything stays inside the five challenge resources, plus one small extra source for sizes (S8).

1. **Two looks for the planet** (`app/src/basemap.ts`). "Height colours" (MOLA, the look so far) stays the first look. "Natural colour" is the Viking orbiter colour mosaic from Mars Trek (R1), the only whole-planet colour photo map that Trek serves. The switch "Mars colours" is on the whole-planet screen; the choice is kept for the next visit (browser storage). Inside a walk zone the photo maps cover the whole view, so the switch is not shown there.
2. **A photo map of the whole crater.** The controlled CTX mosaic covers only the western 40% of Jezero. Mars Trek also has a wider CTX mosaic (`Jezero_CTX_BlockAdj_dd`, "Preliminary") that covers the whole crater: layer `ctx-wide`, levels 7-10 (about 40 m per pixel). The controlled mosaic lies on top of it at levels 8-11 (`ctx-crater`), and the zone layers as before. The app shows the wide mosaic a little brighter and softer (brightness 1.34, contrast 0.62: the values that give both mosaics the same mean and spread of grey where they overlap), so the controlled part stands out less. Its edge can still be seen as a faint square (finding 59).
3. **"Fly to Jezero crater" shows the whole crater** (`craterView()` in `app/src/layout.ts`). It looks straight down at the crater's real centre. The centre and the width (47.52 km) are Mars Trek's own record of Jezero (name layer, FID 186; written into `data/package/index.json`). The rule, in this order: every zone has room for its marker and its name; the whole rim is in view; the view stays inside the wide photo map. The camera is about 55 to 66 km up on a wide window, about 80 km on a tall one, and at most 108 km. On a very narrow map the crater does not fit, and the view moves toward the zones. A zone's name is beside its marker on a map 560 px or wider, and over or under it on a narrower one. The view is framed again when the map changes size (the window, or the panel hidden or shown), as long as the user has not moved the camera.
4. **The photo maps fade in from above** (`photoLayerAlpha()`). On the whole planet a grey photo square on the coloured map looked like a stamp. The wide mosaic now fades in between 400 km and 150 km camera height, and the sharper maps join when it is complete.
5. **Official place names** (`geology.place_names()`). The USGS map SIM 3464 (R2) has a layer with the names printed on the map: Jezero, Nili Planum, Angelica, Belva, Hartwell, Marysville, Neretva Vallis, Sedona, Ulricehamn and Una Vallis. They are in each package (`placeNames`) and are drawn as plain lettering at crater scale only: camera 8 to 115 km above the ground, and nearer than 120 km to the crater's marker.
6. **Scale card** (`app/src/scale.ts`). In the top-right corner of the map (under the map title when the map is narrower than 560 px): a scale bar, and a drawing at the same scale. From near to far: a person in a suit (1.8 m), the Perseverance rover (3 m) with the person beside it, NASA's Mars Reconnaissance Orbiter (13.6 m), a Space Shuttle orbiter (37 m; the orbiter alone, not the Shuttle with its tank), the International Space Station (109 m). When the view is too wide for any drawing, the card says how many space stations fit in the bar ("5 km = about 46 space stations"). The scale is measured at the middle of the map; the helmet view has no card. The card has a memory: its bar and its drawing stay while they still fit, so it does not flip back and forth when the scale moves around a step. The person's height is read from the package (A22). The card takes no clicks: the map under it stays usable.

**Sources and checks**
- **Viking mosaic (R1).** Label `Mars_Viking_MDIM21_ClrMosaic_global_232m`, jpg, WMTS levels 0-7 only (level 7 is about 326 m per pixel; the mosaic itself is 232 m). Same tile plan as MOLA: 170 tiles for the planet (levels 0-3) and 171 around Jezero (levels 4-7), 18.2 MB per package. Mars Trek gives no credit line for it. The producer's record (USGS Astrogeology, "Mars Viking Colorized Global Mosaic 232m", published 2009-02-02, public domain) says NASA Ames blended the Viking colour mosaic over the grey MDIM 2.1 mosaic.
- **Wide CTX mosaic (R1).** 110 tiles, 6.7 MB per package. Measured on three tiles: it lies about 80 m south and 20-30 m west of the controlled mosaic, and it is darker. It has seams between image strips. Its layer note says "context only, not for positions".
- **Scale-card sizes (S8, new extra source).** NASA pages, read on 2026-11-14: Perseverance 3 m long, 2.7 m wide, 2.2 m tall; MRO 13.6 m wide with its solar panels, 6.5 m tall (launch press kit, "Quick Facts", printed page 6); Space Shuttle orbiter 122 feet long, wingspan 78 feet; space station 109 m end to end, solar arrays 73 m. C1-C5 pass (NASA, no China link, published figures, real sizes). The person is assumption **A22** (1.8 m, a round value).
- **Research and review.** Three researchers looked for the layers and the names; three more tried to prove their facts wrong (39 + 36 + 31 facts checked). Their corrections are in: level 7 is 326 m and not 230 m; the controlled mosaic covers 40% of the crater and not two thirds; R2 already holds ten place names.

**One rebuild of both zones** (2026-11-14, 17:02-17:04 UTC, `--skip-photos`): both ended with "all checks passed", and both packages and the registry pass the schema. Changed files:
- `data/package/index.json` (the crater record; new build times).
- Per zone: `mission-package.json` (4 new tile layers, `placeNames`, A22, sources S3 and S8, new times) and `conditions/space-weather.json` (fresh NOAA values).
- Per zone, new tiles: `tiles/viking`, `tiles/viking-region`, `tiles/ctx-wide`, `tiles/ctx-crater` (540 tiles, 27.6 MB).
- After the rebuild, records were corrected by a script in the registry and copied into both `mission-package.json` files, without a new build: the source records S3 (it still said "failed"), R2 (it still said the database was never opened), S8 (press kit page, credit) and R1 (where the crater record comes from); two more notes for the wide crater mosaic (its box and its gap); and one entry for the DONKI request in the list of downloads (finding 52). Both packages still pass the schema, and every source record in them equals the registry.
- Sizes now (sum of file sizes): Z1 86 MB with 1,465 tiles, Z2 94 MB with 1,608 tiles. The built app (`app/dist`) is about 207 MB in 3,580 files; it was about 152 MB.

**Tests:** 152 app tests (adds 33 for the scale card, 7 for the two looks, 26 for the crater view, the photo fade, the names rule and the card's place) and 29 pipeline tests (adds 4 tile-plan tests for the new layers, 7 for the place names and 4 for the DONKI download record). Type check and production build pass. The "nothing scrolls" tour also checks the scale card on every screen (its rows fit, it stays inside the map, it covers no other chip). The saved look was checked with real clicks and real page reloads; the launch animation, the helmet view and the walk-through were looked at in the natural-colour look. Last run of the tour, on the final code: both zones at eight window sizes each (1280×800, 1024×560, 800×725, 792×718, 760×450, 600×720, 500×600, 414×896), 1,208 screens, nothing to report and a clean console. "+ Add stop" mode is not part of the tour; it was checked by hand at six window sizes.

**Code review of this round (2026-11-14).** Four reviewers read the new code and texts (app logic, map and screen, pipeline and data, honesty of texts and docs); a second reviewer then tried to disprove each finding. They reported 30 findings, about 24 different problems. What was wrong, and is fixed:
- **🚩 A zone's name was cut at the map's edge in the whole-crater view** on windows between about 500 and 1,200 px wide (the new view looked at the crater's centre and kept only the zone markers in view, not their names). The view now gives every zone room for its name, raises the camera so the rim still fits, and only then moves toward the zones. Tested at 15 map sizes.
- **The whole-crater view was larger than the wide photo map on wide windows** (strips of the coarse planet map at the left and right on a full-HD window). The view now stays inside the photo map when the window's shape allows it: 0% outside at 1280×800, 1436×718, 1920×1080 and 1024×560. A tall, narrow window is still larger than the map (finding 54).
- **The scale card flipped back and forth in the walk-through** when the scale moved around a step (30 bar changes on one Z2 walk-through). It now keeps its bar and drawing while they fit. Its bar row could touch the card's edge with a "1,000 km" label: the bar is shorter now. It no longer takes the clicks and wheel turns meant for the map.
- **The names stayed on while the crater's own marker was shown** (tilted or far-away camera). They now also need the camera within 120 km of the crater's marker.
- **Texts that promised more than the data gives:** "232 m" and "25 cm" are the products' own detail, but the app stores about 330 m around Jezero, about 5 km for the rest of the planet, and about 30 cm in the walk zones. "Space Shuttle: 37 m" is the orbiter alone. "Black-and-white cameras" was wrong for HiRISE. The on-screen list now also says that the wide crater photo map is preliminary and about 80 m off.
- **Records:** the DONKI request had no entry in the list of downloads and its answer was not kept (the pipeline keeps it from now on; the key is never written to a package); the R2 record still said the database was never opened; the S8 record gave the wrong page; the crater's width had no address in Mars Trek; `schema/README.md` still said every position lies inside the walk area.
- **🚩 The scale card could lie over a walk zone in the whole-crater view** (it sat under the map title, where the zones are on a short window). It is now in the top-right corner of the map when the map is 560 px wide or more; no zone and no zone name lies there. On a narrower map it stays under the title, and a later check by hand found the same problem there on a short window (a 760×450 window: the Z2 marker was under the card). So the whole-planet screen shows no card when the map is under 560 px wide and under 600 px tall; inside a zone the card is always shown. A test checks that the zones are clear of the card on every narrow map from 600 px tall.
- **The whole-crater view kept its old frame when the map changed size** (window resized, panel hidden or shown), so a name could be cut again. It is framed again for the new size, unless the user has moved the camera.
- **Smaller:** the person's height in the scale card now comes from the package (A22); the "Checks and limits" list has pages on narrow windows and opens on its first page; label cleaning in the pipeline copes with names on two lines and empty labels; two tests said more than they checked.

**Findings in map round 3:**
48. **🚩 Mars Trek has no true-colour planet map.** Its only whole-planet colour photo map is the Viking mosaic, and its producer calls it a colourised mosaic (its stated purpose uses the word "artistically"). So the app says "Natural colour" and "approximate", never "true colour". Dark ground looks a little blue in it. Mars Trek also lists "MGS MOC Atlas, Global Color Mosaic": despite its title it is a grey map (red wide-angle photos, a one-band file), so the Viking mosaic is the only whole-planet colour photo map.
49. **ℹ️ Mars Trek gives no credit lines or use terms** for the Viking mosaic and the Jezero CTX mosaics (its metadata records are placeholders). The credits follow the producers' records; the Viking record says public domain.
50. **🚩 The wide crater mosaic is "Preliminary" in Mars Trek's own title:** about 80 m off the controlled mosaic, with seams. It is far-away context only. Routes, slopes and stops still use only the controlled HiRISE and CTX data.
51. **ℹ️ Three more official names are not in R2:** Dacono, Jezero Mons and Sava Vallis (and Pliva Vallis just outside) are only in the IAU/USGS Gazetteer of Planetary Nomenclature. That list is one worldwide database, kept by USGS for the IAU. It also holds 22 Mars names approved in 2021-2022 near China's Tianwen-1 landing site, other names taken from towns in China, and Moon names near the Chang'e-5 site; none of them is near Jezero. Using it would be a new extra source, and rule C1 ("not blended with Chinese data") cannot be settled without the user. **Not used. Open: the user's decision.** For the record: the crater's centre and width come from Mars Trek's own name layer (R1), which is a copy of that IAU list from 2015; only the one record "Jezero" is read from it.
52. **ℹ️ NASA DONKI answered at this rebuild** (it was rate-limited before). The pipeline uses it when it answers, so S3 is now listed in both packages, and "Checks and limits" says "NASA DONKI lists no solar particle event in the 30 days before". The other sun values on screen are NOAA's. The answer itself was not kept at that build, so its entry in the list of downloads has the address and the time but no sha256; the pipeline keeps the answer from the next build on.
53. **ℹ️ The packages grew by 27.6 MB each**, and the built app from about 152 MB to about 207 MB. Each zone keeps its own copy of the planet and crater tiles (a package must work alone).
54. **ℹ️ On a tall, narrow window the whole-crater view is taller than the wide photo map,** so the coarser planet map shows above and below the grey photo box: about 21% of the view on an 800 px wide window, 37% on a phone, 41% on the 219 px map strip of a 600 px window. Usual wide windows are fine (0% from 1024×560 to 1920×1080); a very wide, low one shows strips at the left and right (about 1% at 1920×950, about 20% on a 2560×1080 screen). The mosaic also has one gap of about 3 km² south-west of the rim. Two ways to fill the view, both need new tiles and a rebuild: **(a)** a wider box for the same layer, about (76.53, 17.32, 78.74, 19.44): 128 more tiles, about 8 MB more per package, sharp everywhere; **(b)** an outer ring of the same mosaic at levels 5-8: 64 tiles, 2.2 MB per package, softer outside the box. **Open: the user's choice.**
55. **ℹ️ In the natural-colour look the crater and the zones are still grey.** The CTX and HiRISE photo maps on Mars Trek are grey. CTX takes grey pictures; the HiRISE mosaic is made from the camera's grey (red channel) pictures, and HiRISE colour covers only a narrow strip of each picture. Mars Trek has no colour photo mosaic of Jezero. The grey photos are never tinted.
56. **ℹ️ A scale card on a tilted map holds only at one place.** The card measures the scale at the middle of the map; "Checks and limits" says so. Its size was cut to 168 px so that it also fits the 219 px map strip of a 600 px wide window. In the whole-crater view it can lie over one place name at some window sizes (never over a walk zone or a zone's name: on the whole-planet screen a map that is both under 560 px wide and under 600 px tall shows no card).
57. **ℹ️ Navigating a browser tab to the address it already shows does not reload the page.** Two test steps looked like reloads and were not; they were repeated with a changing query (`&r=1`, `&r=2`).
58. **ℹ️ A test tab behind the user's own tab gets animation frames only now and then** (the user was trying the app in their tab during the tests). The last test runs drove the map's frames by hand (`viewer.render()` on a timer); the layout checks do not depend on real frames. A screenshot of a hidden pane can also show an older frame: each one was taken twice and compared with the page's state.
59. **ℹ️ The edge of the sharper crater mosaic is still a faint square in the whole-crater view.** The two CTX mosaics are different products. One brightness and one contrast value for the whole wide mosaic cannot match them everywhere, because the wide mosaic's own image strips differ in tone: measured in the whole-crater view, the grey step at the square's edge is about 3 levels (of 255) at its north side, 9 at its south side and 29 at its east side, in the middle of the crater floor. One way to hide it: show only the wide mosaic in the whole-crater view and let the sharper maps join lower down (below about 45 km camera height), where their edge is mostly outside the view. That changes what the crater view shows, so it is **open: the user's choice.**
60. **ℹ️ Seen in passing, not from this round: the "+ Add stop" hint and the map title.** In "+ Add stop" mode the hint ("Click the map to place the new stop") is centred at the top of the map and lies over the end of the map title on most windows (61 px at 1280×800). On a phone-size window the panel stays open over the map in that mode, so the hint is squeezed into the 22 px strip beside it until the panel is hidden. Both are as in UI round 2; this round did not change them. **Open: fix them?**

### Round 4 (2026-11-15): crew figures, pole arrows, control box, Like-I'm-Five answers

The user asked for: real astronaut characters for the crew (1 to 4) instead of a circle ("using Three.js"); north and south pole arrows on the Mars globe; a control to "fully control the x y z and everything of the simulation"; and more Like-I'm-Five answers ("Suggest order", time and reserve, radio, sun activity, rock types with real images, real photos of the sample tubes). Asked and answered on 2026-11-15: **CesiumJS figures, not a Three.js layer** (D4 stays: one map engine; hills hide the figures correctly), **real size**, **an outside model** (NASA 3D Resources), **arrows on the spin axis**, **buttons only** for the view, and **camera and walk** controls in the same box.

1. **Crew figures** (`app/src/crew.ts`, `map.setCrew()`). One 3D astronaut per crew member, at real size, in the walk, the walk-through and the replay. Walking: A1 at the crew's place, the others in single file 3 m apart along the path walked; at a stop: a ring 2 m around it, facing it. Name tags A1–A4 up close; the round crew marker only from 220 m (from the tablet's top view, 380 m up, a real-size figure is a few pixels tall).
2. **The suit model** is NASA's Z2 Spacesuit (NASA 3D Resources, extra source S9): NASA's prototype suit for walking on planets. The app ships a copy made by `pipeline/baramger_pipeline/suit_model.py` (0.94 MB instead of 16.9 MB): the same mesh and material, without NASA's JPEG copies of its WebP pictures, without its bump picture (strength 0 in NASA's file, but CesiumJS drew it as grey speckles), and with the grime painted on the white fabric taken off (the user asked twice why the suits looked dirty). Seams, red stripes, blue bands, black parts, the flag and the patches stay. Lit by a light from the viewer's side and an even, colourless light (CesiumJS's own sky light is made for Earth and made the suits dull and greenish).
3. **Follow an astronaut.** The camera follows the chosen astronaut (A1 by default): the top view in the walk, the drone view behind them in the walk-through, and in the helmet view you look through their visor (their own figure is hidden; following A2 you see A1 ahead).
4. **Pole arrows** on the whole-planet screen: Mars's spin axis drawn as an arrow out of each pole (to 1.24 planet radii), with "North pole" / "South pole" beside the tips. Real 3D lines: they turn with the planet and the far one hides behind it. To keep the names inside the map: the "drag to turn Mars" hint moved to the bottom left corner, a narrow whole-planet map has no scale card, and on a narrow, short map the planet is drawn a little smaller (`planetFill()`).
5. **Control box** ("Controls", map, right edge): buttons to move forward, back, left and right (as seen on screen), up and down, turn, tilt and zoom (hold to keep moving; steps grow with the height), and ◎ to follow the crew again (on the globe: back to the whole planet). In the walk, the walk-through and the replay it also has Play/Pause, a time slider, the speed (×15 to ×480 for the walk) and "Camera follows A1–A4". A walk only runs forward: dragging the time back is refused with a message (the replay goes back). In the helmet view the view buttons are off. The box places itself below the chips in its column, or at the bottom right on a short map.
6. **Like-I'm-Five:** five more answers (13 "Suggest order", 14 time and reserve, 15 radio, 16 sun activity, 17 rock types with five real photos), and real photos of the sample tubes, in English and Sorani, plus the GitHub copy.

**Sources and checks**
- **Z2 Spacesuit model (S9).** NASA page `science.nasa.gov/3d-resources/z2-spacesuit/` ("NASA/LaRC/Advanced Concepts Lab"); file `Z2 Spacesuit.glb` from `assets.science.nasa.gov`, 16,933,148 bytes, sha256 4199762c…a0c2a, downloaded 2026-11-15 into `data/raw/nasa3d/` (with three other NASA suit models that were compared and not used: Astronaut, Extravehicular Mobility Unit, Mark III). NASA says the 3D Resources are free to download and use. 30,904 triangles, about 1.93 m tall, no skeleton.
- **Photos on the Like-I'm-Five page** come from the packages' Perseverance photos (R5) and HiRISE tiles (R1), each with its own credit.

**Tests and checks (2026-11-15):** 170 app tests (adds 13 for the crew placement, 5 for the pole arrows and the planet's room, 2 for the stylesheet rules) and 38 pipeline tests (adds 9 for the suit model: fallback pictures, the switched-off bump picture, the grime cleaning, the app copy). Type check and production build pass; the registry and both packages pass the schema. The screen tour (now with the control box open and used on the globe, the walk-through, the walk and the replay) ran in headless Chrome (`app/dev/tour-headless.mjs`, a private dev server on another port, so the Browser pane was not touched) for both zones at eight window sizes (1280×800, 1920×1080, 1024×560, 800×725, 760×450, 600×720, 500×600, 414×896): 16 runs, 1,474 screens, nothing to report (after the two fixes of finding 67). Checked by hand: the figures from the front, back and side; the helmet view following A2 with the box open (eye 1.95 m above the ground, A2 hidden, A1 ahead, the box below the visor's time-left reading); the pole arrows at seven window sizes.

**Findings in round 4:**
61. **🚩 The helmet view was never at eye height.** CesiumJS keeps the camera at least `minimumZoomDistance` above the ground, also a camera the app places; it was 25 m. So the helmet view (meant to be 1.8 m) was 25 m up, and no close look at the crew was possible. Now 1.5 m.
62. **ℹ️ NASA's suit model:** grime painted on its colour picture; a bump picture marked "strength 0" that CesiumJS still draws; and it faces 90° away from the glTF forward axis. All three are handled in the app's copy and in `map.ts`; NASA's file is unchanged in `data/raw/`.
63. **ℹ️ The figures cannot move their legs.** None of NASA's four suit models has a skeleton or an animation, so the figures glide along the route and turn to face the way they go. A walking animation would need a rigged model, a new source. **Open: wanted?**
64. **ℹ️ The USGS rock map database (R2) has two small slips:** one of the 64 crater-rim shapes is named "Crater riim unit" (the app shows the name as USGS has it), and one shape has the symbol parts of Nili Planum 2 (Nnp2) but the name and symbol of the Upper etched unit (Nue). Neither is at a walk stop: the rock units of all 14 stops match the database.
65. **ℹ️ The route line passes through the figures up close.** It is drawn 1.2 m above the ground so that it is never hidden by the terrain; at eye level it runs at the astronauts' waist. **Open: lower it in close views?**
66. **ℹ️ Seen in passing:** with 4 astronauts, the "Load at start" row of the Safety tab wraps into a tall, narrow block (A1–A4 fields beside each other). It fits (nothing scrolls) but looks crowded. **Open: tidy it?**
67. **🚩 Two old knife-edge layouts, found by the headless tour (zone Z1, 760×450).** Both were there before this round, and the earlier tours missed them. (a) The walk's footer row (Play | ×30 ×60 ×120 | Jump to next event) needed 221 px of a 220 px row once the page's own font (Inter) had loaded (earlier test runs measured before it loaded, with a narrower fallback font) and wrapped, so the Progress tab no longer fitted: its buttons now have 1–2 px less side padding. (b) On a panel scaled down for a short window, at pixel ratio 1, each 1 px border is rounded up to 1.6 px, which made every stop row 31 px instead of 30 (the earlier tours ran in the Browser pane at pixel ratio 2, where this does not happen): ten stops plus "Ideas for next walk" were 5 px too tall. The rows now have 1 px less top and bottom padding and stay 30 px.

68. **🚩 Round 4 broke the start-up for visitors (fixed 2026-11-15).** The launch animation starts before the 3D map exists, and a line added in this round (hide the pole arrows) called the map at its start: "TypeError: undefined is not an object (map.setPoles)". The animation never ran and the app stayed in "animation mode": on a computer only the planet showed (no panel, no title, no arrows); on an iPhone over mobile data the page stayed dark. All the earlier tests opened the app with `?nointro`, so none of them went through the animation. Fixed by leaving the map alone until the animation ends; `app/dev/tour-headless.mjs` now first loads the app WITH the animation and checks that it ends with the panel shown and no script error. Checked at 1280×800 and 390×844 in headless Chrome and in Safari on an iPhone 17 Pro Max simulator (iOS 26.5).

69. **🚩 The start-up waited for about 12 MB before showing anything (fixed 2026-11-15).** Measured on the live site (brotli-compressed): the script 1.2 MB, and the zone's grids 7.8 MB (1 m heights), 2.0 MB (2 m route heights), 0.6 MB (20 m heights) and 0.5 MB (slope and roughness), downloaded one stage after another before the 3D map was even made. On this computer's connection Vercel sent about 235 KB/s (another CDN: about 410 KB/s), so about 50 s of "Loading the mission package…"; on mobile data longer, and some large downloads stalled ("Failed to fetch"). Now the whole planet needs only the script and small files (index, mission package, rock map, weather: about 1.3 MB); the map starts with flat ground (`MapView(container, groundGuess)`), the zone's grids load in the background once Mars is drawn (`loadZoneGrids()`), and opening a zone waits for them with "Loading the walk zone's terrain… x of y MB" (`zoneReady()`; a failed download says so and can be tried again). `app/vercel.json` lets browsers keep the versioned script files for a year and the tiles, CesiumJS files and the suit model for a day. **Open:** the grids could be made about half as big (heights as 16-bit numbers instead of 32-bit), which needs a package format change and a rebuild.

70. **🚩 "Camera follows A2" seemed to do nothing (fixed 2026-11-15).** The choice did move the camera, but in the walk and the replay it moved the top view, 380 m up, by the 3 m between two astronauts: from there the crew is one dot (the figures show only from 220 m), so A1, A2 and A3 looked the same. The user chose a close follow camera: picking an astronaut puts the camera about 20 m behind and above them, turning with them, with the figures and name tags in view (the followed one's tag in the crew colour). Zoom, turn and tilt buttons, and mouse or touch moves, change the distance and angle without stopping the follow; the move buttons free the camera and ◎ follows again from behind. A new first choice, "Whole crew", keeps the earlier views; the box's row now reads "Follow [Whole crew ▾]" (with "Camera follows" the wider menu wrapped the row, and the taller box covered the map's information line at 760×450). In the walk, the walk-through and the replay. Found while testing: switching to the helmet view while the walk was paused did not hide the followed astronaut's own figure (the camera was inside it); now it does. Also: CesiumJS lifts the camera a little where its ground is higher than the app's height grid; the follow now keeps only camera moves made by the crew's own input, so its distance and angle no longer drift on slopes.

71. **ℹ️ Slower clocks (2026-11-15).** The user asked for ×5 and ×10 (the slowest was ×30 on the walk tablet, ×60 in the replay window, ×15/×30 in the control box). The walk has ×5 ×10 ×30 ×60 ×120 on the tablet and ×5–×480 in the control box; the replay ×5–×240 in its window and ×5–×480 in the box. To fit five speed buttons, the walk tablet's "Jump to next event" button now says "Next event" (its tooltip keeps the long name). The walk-through is not a clock (it flies 45 m per second at 1×) and keeps 0.5×–8×.

### AI mission assistant (2026-11-15): the Ask tab

The team asked for an AI chat assistant that answers the crew's questions about a planned walk, using only the zone's mission package. Decided by the team before the work started: an **Ask** tab on the Plan screen (not in the helmet display, not on the globe); five providers in a fallback chain (Gemini, Groq, OpenRouter, Mistral, Cerebras); the keys stay in a Cloudflare Worker; answers come from our data through tools; **the AI never decides what is safe** (plan.ts, los.ts and load.ts do); every answer is labelled "AI explanation" with its provider, model, sources and data values; the app keeps working offline. Asked and answered on 2026-11-15: the site stays on **Vercel** and calls the Worker on Cloudflare (CORS allow-list); the team has keys for all five providers, on free tiers; limits: questions up to 300 characters, answers up to about 120 words, the last 2 questions and answers sent as history, 5 questions per minute per visitor; no "Ask Earth" button and no report drafting for now.

**How it works**
- **Worker** (`app/worker/`, `main` in `app/wrangler.jsonc`): one route, `POST /api/chat`. Everything else is the static site, as before (`run_worker_first: ["/api/*"]`). Per-visitor limit with Cloudflare's rate-limit binding `ASK_LIMIT` (5 a minute; the IP is only the limiter's key, never stored). The Vercel site may call it (`ALLOWED_ORIGINS`); other sites get 403 before any provider is called.
- **Tools** (`worker/tools.ts`): seven read-only look-ups in the same package files the app serves, read through the assets binding: `get_site`, `get_stops`, `get_stop`, `get_hazards_near`, `get_terrain_at` (a point, or a straight line between two points: steepest slope, metres too steep), `get_conditions` (MEDA hourly medians, daylight, sun activity) and `get_plan` (the crew's plan as Baramger computed it, sent by the browser). The 2 m grids are read with the app's own readers (`src/grid.ts`). `mission-package.json` is never pasted into the prompt. Each tool returns its data for the model plus a short list of **facts** (label, value, source ID) made by our code. The facts and the source list under an answer come from the tool calls actually made, never from the model (C5).
- **The model must finish with a `final_answer` tool call** (answer, sources, cannot_tell, off_topic). Our checks: a broken tool-call JSON, a call to a tool that does not exist, an answer without any look-up, or no final answer after 5 rounds = the provider failed. "Can't tell" answers always start with "I can't tell from the mission data." Off-topic questions get one fixed polite sentence.
- **Fallback chain** (`worker/chain.ts`, order in `PROVIDER_CHAIN`, `worker/providers.ts`): one OpenAI-style client with a small per-provider adapter. A provider is skipped when its key is not set, while it rests, or (Gemini) for visitors where its free tier may not be offered. It moves to the next provider on 429, 402, 5xx, timeout (15 s per provider, 45 s in all), network errors, a refused key or missing model (logged), a refused location, a broken tool call (Groq's 400 `tool_use_failed`) or an answer that fails our checks. A fallback restarts the whole question on the next provider. A 400/422 caused by our own request **stops** the chain and is logged, so the bug is seen and fixed (team rule). After a 429 the provider rests for its Retry-After (or Gemini's `retryDelay`, or 60 s; an hour for a daily quota); a refused key or a missing model rests 10 minutes. Answers are not streamed.
- **Logs** (Workers Logs, `observability`): one line per question with the provider that answered, the model, the time and why the others were skipped. The question text is never logged; only its length.
- **Browser** (`src/ask.ts`, `askTab()` in `main.ts`): sends the zone, the question, the last 2 answers and the plan context (stops, legs, totals, radio gaps with where they start, the safety checks, the open stop, the map's centre). Crew notes are **not** sent (free text could hold personal details, and free tiers may keep prompts). With no connection the tab says "The assistant needs an internet connection"; when every provider fails, "The assistant isn't available right now. Try again in a minute." Answers live only in the page's memory (the last 20), never in a package or in browser storage.
- **The tab** (no scrolling): five example questions before the first one; then the latest answer with "AI explanation", provider · model, "Tried first: …" after a fallback, the question, the answer, two data values, the source IDs, and "Read all · N values", a pop-up with two views: the whole answer, and every value with its source (paged). Older questions with a pager. The 300-character question field may scroll inside itself while typing; the panel never does. A long answer is faded at the bottom with "Read all".

**The providers** (five at first; docs and terms read on 2026-11-15 by five research passes, then **tested live with the team's keys the same day**: the five example questions plus one the data cannot answer, in both zones, on each provider alone; `test/ask-live.test.ts`)

| Order | Provider | Model | Why this model | Free tier today | Live test (2026-11-15) |
|---|---|---|---|---|---|
| 1 | Gemini (Google) | `gemini-3.5-flash-lite`, thinking "low" | Google's advice for new projects; `gemini-2.5-flash` is redirected to it on 2026-12-01. Fast, function calling on the free tier. Minimal thinking can end tool use too early (Google). | Yes. Limits are not published (read them in AI Studio; per project, daily reset at midnight Pacific). | ✅ **12 of 12** in the final run (11 of 12 before the last fixes), 2–7 s. Looks up the most (up to 5 tools for the route question) and corrected the false premise in Z1 ("there is no steep ground"). Earlier runs: once it never finished (5 rounds; now its last round offers only `final_answer`), once a 503 "overloaded", and 429s when questions came every 3 s; none with 15 s between questions. Accepts `tool_choice: "required"` and sends thought signatures, which the Worker returns. |
| 2 | Groq | `openai/gpt-oss-120b`, reasoning low, hidden, **answers in plain text** | The only non-Chinese model with tool use left on Groq's free tier (Llama 3.3 70B and 3.1 8B were retired for free users on 2026-08-16). | Yes: 30 requests/min, 1,000/day, **8,000 tokens/min** (confirmed by its headers). | ✅ 10 of 12 in the final run, about 1–2 s (the fastest). It refused to look anything up for the radiation question (a 400 "model did not call a tool", both zones): the chain moves on. With a `final_answer` tool it gave an empty reply after every look-up, also with `tool_choice: "required"`, so Groq gets only the data tools and answers in text ending with a "Sources:" line (`answerMode: "text"`). 429 when questions came faster than about one every 20 s. |
| 3 | OpenRouter | `openai/gpt-oss-120b` on `only: [deepinfra, coreweave, together]`, `allow_fallbacks: false`, `zdr: true`, `data_collection: "deny"` | Three US hosts, all zero-data-retention, all accept `tool_choice: "required"`; Groq and Cerebras left out (already in the chain). | **No** free endpoint for the allowed models. The team's key has credits: about $0.00001–0.0002 a question (served by DeepInfra). | ✅ **12 of 12** in the final run, but slow: 4–20 s a question, so the Worker's 15 s per provider sometimes cuts it off (it then moves on). One weak answer: in Z1 it repeated the question's false premise (steep ground) while quoting the direct line's 6°. |
| 4 | Mistral AI | `ministral-14b-2512` (Ministral 14B) | The team's free key allows **0** requests a minute for Mistral Small and Medium and **2 a minute** (40,000 tokens) for each Ministral model, which calls tools correctly. | Yes, but 2 requests a minute: about one simple question a minute. | ⚠️ Good answers when within its limit (safety checks, temperature, radio gaps), but 429 on about half the questions: a question needs 2–3 calls. A thin last fallback on the free plan. |
| 5 | Cerebras | `gpt-oss-120b`, reasoning low, hidden | The only non-Chinese model on Cerebras's shared endpoints. | **No** since 2026-07-16 ($5 of credits after adding a payment card). | ❌ 402 "Payment required" with the team's key: skipped until billing is added (the chain moves on at once and rests it an hour). |
| 6 | Cloudflare Workers AI (added 2026-11-16, the team's OK) | `@cf/openai/gpt-oss-120b` (Workers AI's own copy, not a billed "Third-party" model), URL with the account id (`CLOUDFLARE_ACCOUNT_ID`), key `CLOUDFLARE_AI_TOKEN` | Cerebras's free tier ended; Workers AI is the free provider with gpt-oss-120b and tool calling found by the research of 2026-11-16 (GitHub Models closed, Hugging Face and NVIDIA no free production use). | Yes: 10,000 neurons a day per Cloudflare account (gpt-oss-120b: 31,818 neurons per million input tokens, 68,182 per million output), about 30 questions a day, shared with any other app on that account. On the paid Workers plan, use past the free amount is billed: keep the account on the free plan. | ⏳ Not yet tested live (tool calling through Workers AI's OpenAI-compatible endpoint is the open point). |

**Rule checks (source-compliance skill, C1 and C2; C3–C5 are about data and do not apply to a service, but C5 applies to its output: see above)**

| Provider | C1: no link to China | C2: terms allow this use |
|---|---|---|
| Gemini | ✅ Google (US); Gemini is not offered in mainland China, Hong Kong or Macau. Where inference runs is not documented (Google has no data centre in mainland China; a Google Cloud region in Hong Kong exists, not confirmed either way). The Worker runs near `gcp:us-east4` (placement hint), so our calls do not start in Cloudflare's Hong Kong data centre. | ⚠️ **Open, the team's decision.** The terms say "18 years of age or older" and forbid use in a service "likely to be accessed by individuals under the age of 18". A public Space Apps demo with a "like I'm five" page may count. Free tier: no API clients for users in the EEA, Switzerland or the UK, and only in Gemini's available regions (Iraq is one): the chain skips Gemini for visitors from those places (`skipCountries`). Free-tier prompts may be read by human reviewers: no personal data in prompts. |
| Groq | ✅ Groq LLC (US); data centres in the US, Canada, Finland, the UK, Saudi Arabia and Australia; no Chinese investor found. ⚠️ Groq also serves Chinese models (Qwen, MiniMax): our model is pinned. | ✅ Customers may offer it to their end users; 18+ account holder; no training on inputs; up to 30 days of logs. Not for "high-risk" uses: the app says the assistant only explains and never decides safety. |
| OpenRouter | ✅ for the route itself: OpenRouter, Inc. (New York); pinned model; `only` allow-list of US hosts; no model fallback. ⚠️ Two points the public docs do not settle: OpenRouter samples a few prompts for "categorization" with an unnamed model, and screens all traffic for abuse in flight. Prompts hold only public NASA data and the question. **Also lock the hosts in a key guardrail** in the OpenRouter account (provider and model allow-lists), so a wrong request body cannot widen them. | ✅ 18+ account holder; building it into our own site is allowed; no reselling. |
| Mistral | ✅ Mistral AI (Paris); lead investor Samsung; no Chinese investor named; served from EU data centres by default. ⚠️ The same API now hosts Z.ai GLM and DeepSeek models: our model is pinned, and only `ministral-14b-2512` is ever sent. | ⚠️ Business terms (the API is not for consumers): a hackathon team is a grey area. Minors may not use the product without a parent's consent. Free mode may be used for training: switch off "Anonymous improvement data" in the console. |
| Cerebras | ✅ Cerebras Systems (Sunnyvale, Nasdaq); no data centre in China found. ℹ️ G42 (UAE) is an investor and a big customer; its stake was changed to non-voting shares in 2025 after a US review, and G42 sold its Chinese holdings in 2024. Whether this counts as a link is the team's call. | ✅ 13+ account holder; outputs may be shown in our app; must not be presented as written by a person (we label them AI). |
| Cloudflare | ✅ Cloudflare, Inc. (San Francisco, NYSE); runs Workers AI on its own network. Its mainland-China network is a separate Enterprise product run by JD Cloud that does not list Workers AI (docs read 2026-11-16); which GPU location serves a request is not documented. ⚠️ The catalogue also has Kimi, GLM, Qwen and DeepSeek models: our model is pinned. | ✅ Cloudflare does not use customer content to train models (Workers AI privacy page, 2026-10-16). An age rule for the account holder was not checked. |

Also: the EU AI Act's rule that people must be told they are talking to an AI applies from 2026-08-02; every answer says "AI explanation".

**Live, end to end (2026-11-15):** `wrangler dev` with the keys: a question from the Ask tab in headless Chrome went through the Vite proxy and the Worker; Gemini answered "Where do we lose radio contact?" from the plan in 3.7 s (two gaps, 09:11 for 3.8 min and 09:45 for 3.4 min), with nothing overflowing. With the Gemini key removed from a second Worker, Groq answered in 1.3 s and the answer said "Tried first: Gemini (Google): no key set". Another site was refused (403). After 5 requests in a minute the sixth got 429 with the agreed message. The log lines hold the question's length, never its text.

**Deployed (2026-11-15):** the Worker and a copy of the site at `https://baramger.baramger-app.workers.dev` (`npm run deploy`; 2,633 files uploaded), the five keys set as Worker secrets (`wrangler secret bulk`, from `app/.dev.vars`, file deleted after). The placement hint was accepted on the free plan. The new `workers.dev` address needed about a minute for its certificate. Checked online: Gemini answered the 14:00 question in 2.4 s, a call with the Vercel site's origin got its CORS header, another site got 403. The Vercel site calls this address (`WORKER_URL` in `src/ask.ts`). The GitHub deploy job still skips Cloudflare (no Cloudflare secrets in the repo): a change to the Worker needs `npm run deploy` by hand until they are added.

**Tests (2026-11-15):** 70 new app tests (251 app tests in all), all with mocked providers (no keys): every tool reads the right values from both real packages (22), the fallback chain (26: a 429 moves on and rests the provider until its Retry-After ends, a timeout moves on, missing keys are skipped with any subset of keys, all failing gives the agreed message, a 400 from our own request stops the chain, Groq's `tool_use_failed` and Gemini's location refusal move on, broken tool JSON, a made-up tool, an answer without look-ups, Gemini's thought signatures are sent back, each provider's quirks, the EEA rule), and the Worker's HTTP side (8: CORS allow-list, the per-visitor limit, input checks, routing). 9 tests for the browser side (the plan context: arrivals, legs, where each radio gap starts; no crew notes; the agreed messages offline, on a network error, when every provider failed, and on a site without the Worker). `test/ask-live.test.ts` asks the five example questions plus one the data cannot answer, in both zones, on each provider with the real keys; it runs only with `ASK_LIVE=1`. The screen tour covers the Ask tab: the examples, waiting, the longest question and answer, a fallback note, both views of the pop-up and their pages, an earlier question, no answer, off topic and offline.

**Findings:**
72. 🚩 **Three of the five providers are not free any more.** Cerebras needs a payment card ($5 of credits for 30 days, since 2026-07-16); Mistral's current docs say API keys need billing; OpenRouter has no free endpoint for an allowed model. The chain still works with any subset of keys: with only Gemini and Groq it has two free providers.
73. 🚩 **Groq, Mistral and Cerebras also serve Chinese models** on the same API (Qwen, MiniMax, GLM, DeepSeek). Each of our providers is pinned to one non-Chinese model in `PROVIDER_CHAIN`, and a test checks that no Chinese model name is in the chain.
74. 🚩 **Gemini's free tier comes with three conditions:** users under 18 (open, the team's decision), no users in the EEA, Switzerland or the UK (skipped by country), and only from available regions (Google checks the caller's location: Cloudflare's Hong Kong data centre was refused in October 2026; the placement hint `gcp:us-east4` avoids it). Whether Cloudflare's free plan accepts this placement hint is not confirmed: if `wrangler deploy` refuses it, delete the `placement` line.
75. ℹ️ **Groq's free tier allows 8,000 tokens a minute**, and each tool round sends the prompt and the tool list again (Groq caches repeated prompt starts, which do not count). It is second in the chain, so it is mostly a fallback.
76. ℹ️ **A provider's rest is remembered by one Worker instance.** Cloudflare may run several; another one may try a resting provider once more. Good enough for a demo; a shared store (KV) would fix it.
77. ℹ️ **Workers Free allows 10 ms of CPU per request.** Waiting for the providers does not count; reading the 360 KB package and the 2 m grid once per instance does. Watch the CPU times in Workers Logs; the paid plan raises the limit.
78. ℹ️ **Gemini's model names move fast:** `gemini-2.5-flash` is redirected on 2026-12-01, and `gemini-3.5-flash-lite` has no `reasoning_effort` mapping in the docs, so its thinking level is set with Gemini's own `extra_body` field.

79. **ℹ️ Natural colour is the first look (2026-11-15, the user's choice).** The whole planet now opens in natural colour (the Viking colour mosaic, R1; still called "approximate", never "true colour") instead of the MOLA height colours. "Height colours" stays as the other choice of the "Mars colours" switch, and a look the crew clicked earlier is still kept for their next visit. The launch animation's telescope view shows the same look. The Viking tiles for the first view are about as big as the MOLA ones (levels 0–3: 2.3 MB against 2.6 MB on disk), so the start-up is not slower. This replaces the first-look rule of finding 45 and map round 3 (item 1).

80. 🚩 **gpt-oss on Groq loses a `final_answer` tool call** (2026-11-15, live): after the first look-up it replied with empty text ("We have answer." in its reasoning), with `tool_choice` "required" (then a 400 "model did not call a tool") or "auto". gpt-oss on OpenRouter (DeepInfra) did call it. Fixed with a plain-text answer mode for Groq: data tools only, a look-up forced in the first round, tools off in the last round, and the same checks on the text ("I can't tell…" opening, "OFF TOPIC", a "Sources:" line).
81. 🚩 **The route question needed data the plan did not have.** The first live answers explained "why the route goes around" with the route's own slope values (21°, 344 m) as if they were the straight line's. `get_plan` now measures each leg's direct line on the 2 m grid (metres over 25°, metres at 15–25°, steepest slope) and states how the route search chooses (`routeRule`). After the fix, all three providers used the direct line's real numbers (for example 22 m at 15–25° and a 21° steepest slope on the 1,212 m direct line from the habitat to stop 1). The prompt now also says to correct a question that assumes something the data does not show (Z1 has no steep ground).
82. ℹ️ **The free tiers seen with the team's keys:** Gemini fine with a question every 15 s; Groq 8,000 tokens a minute (about a question every 20 s); Mistral 2 requests a minute per Ministral model and 0 for Mistral Small; Cerebras needs billing; OpenRouter is paid but cheap. For a public demo with many visitors at once, only Gemini and OpenRouter have headroom.
83. ℹ️ **OpenRouter takes 4–20 s a question** (gpt-oss with reasoning on DeepInfra), against the agreed 15 s per provider: some of its answers are cut off and the chain moves on. Raising its own limit to 25 s would keep the 45 s total. **Open: the team's choice.**

84. **ℹ️ Helmet view "Mars colour" (2026-11-15, the user's choice).** The user asked for the real or true colour of Mars in the helmet view, to feel like walking on Mars. There is no measured true-colour map of the walk zones: Mars Trek (R1) has only grey HiRISE and CTX photo maps there, and the Viking colour mosaic (about 230 m a pixel) is nearly colourless at Jezero (#7f676a mauve-grey at Bright Angel, #2d2732 purple-grey at Three Forks). With the user's OK the ground colour is measured in Perseverance's own colour photos of each zone (R5, the photos already in the mission package): Mastcam-Z colour #ab9172 at Three Forks, the mean of 9 colour Navcam photos #7f744f at Bright Angel. The grey photo maps keep their detail and brightness and take that hue ("color" blend). The photos are raw (not colour-calibrated; raw Navcam colours lean yellow), so the screen says "approximate colour", never "true colour". The sky and the haze at the horizon are a drawing (dusty butterscotch, lighter at the horizon): the package photos look down at the ground and hold no sky. A switch in the helmet view, off until the crew turns it on; the tablet map stays grey.

85. **ℹ️ An arrowhead on the crew marker (2026-11-15).** While the crew is on the way, the round marker has a point on its rim that shows the walking direction (the last stretch of the path), in the walk, the walk-through and the replay. Standing at a stop, at the start or at the end, it is the plain circle again.

86. **🚩 The screen tour never opened the helmet view (found and fixed 2026-11-15).** `app/dev/ui-tour.js` now opens it, with and without "Mars colour". At 760×450 it found two old layout faults: (a) with the control box open at the bottom right of a short map, the box lay over the visor's warning line; the warning now takes the room left of the box (`placeCtl()`, CSS variables `--warn-left` and `--warn-max` on `#hud`); (b) after leaving the helmet view the box was placed while the map title was still fading back in (seen as hidden), so it lay over the title; the box is placed again when the fade ends (`transitionend`) and after 0.45 s (`placeCtlAfterFade()`). The colour switch sits at the top left of the map, where the map title hides in the helmet view: at the bottom left its note met the warning line on short maps.

## 9. Files in this repo

- `docs/PLAN.md` — this file
- `docs/Baramger-Report.html` — the same content as a readable web page
- `docs/Baramger-User-Scenario.html` — what the end user sees and does, start to finish
- `schema/marswalk.schema.json` — data model (JSON Schema 2020-12)
- `schema/README.md` — how the schema fits together + rules the schema can't express
- `data/sources.registry.json` — the verified source ledger (R1–R5 and the extra sources S1, S2, S3, S4, S7, S8)
- `docs/screens/` — six screenshots of map round 3
- `app/public/models/z2-spacesuit.glb` — the crew figure (S9, cleaned copy; `pipeline/baramger_pipeline/suit_model.py` makes it)
- `app/worker/` — the Cloudflare Worker: `POST /api/chat`, the mission assistant (tools, the five providers, the fallback chain)
- `docs/ask-demo.md` — the 3-question demo script for the assistant, with a live fallback
- `app/dev/ui-tour.js`, `app/dev/tour-headless.mjs` — the "nothing scrolls" screen tour, in the dev app or in headless Chrome (both planet looks, the crater view, the scale card, the launch animation)
- `CLAUDE.md`, `.claude/` — Claude Code setup

87. **ℹ️ Cloudflare Workers AI is the sixth provider (2026-11-16, the team's OK).** A research pass on free tiers (three agents, each claim checked against the provider's own page, the main ones re-checked by hand) found Cerebras's free tier gone (a one-time $5 trial with a card since July 2026: the 402), OpenRouter's free gpt-oss-120b and Llama 3.3 70B without any server, GitHub Models closed (2026-07-30), Hugging Face giving free accounts no credits, and NVIDIA and Cohere free keys not allowed in production. Workers AI gives 10,000 free neurons a day per Cloudflare account and serves gpt-oss-120b with function calling. It is last in `PROVIDER_CHAIN`, after Cerebras; its URL carries the account id (`urlVar`, checked to be 32 hex digits before it goes into the URL). Set `CLOUDFLARE_AI_TOKEN` (a token made with the "Workers AI" template) and `CLOUDFLARE_ACCOUNT_ID` as Worker secrets. **Open:** the live test of tool calling on it, and whether to drop Cerebras from the chain.

88. **ℹ️ The chain is Groq → OpenRouter → Mistral → Cloudflare (2026-11-16, the team's decisions).** (a) **Gemini is out:** Google's Gemini API terms forbid using it in a site "likely to be accessed by individuals under the age of 18", and Baramger is a public NASA Space Apps site that students visit. (b) **Cerebras is out:** its free tier ended in July 2026. Both configs stay in `providers.ts` (`GEMINI`, `CEREBRAS`), unused; the chain tests still run on a test chain with Gemini in front, so the fallback rules stay covered. (c) **Cloudflare has 25 s** (`timeoutMs`) instead of 15 s: its live answers took 5–25 s; the 45 s total is unchanged. (d) **CI deploys the Worker:** the repo has `CLOUDFLARE_API_TOKEN` (Workers deploy only) and `CLOUDFLARE_ACCOUNT_ID`. With Gemini gone, OpenRouter (paid, cheap) and Groq carry most questions.
