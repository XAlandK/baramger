# Baroler — Analysis & Plan

> Challenge: **"Interplanetary Survival Guide: Martian Map"** (NASA hackathon challenge, source text in `TheChallenge.txt`).
> Status: **planning only — nothing is implemented yet.**
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

**"Baroler — Marswalk Planner & Field Guide"**: one offline-first web app with three views that share one data package.

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

| ID | Source (producer) | Use in Baroler | Status |
|---|---|---|---|
| S1 | Perseverance rover waypoints (NASA JPL) | Put R5 photos on the map | ✅ Checked — ready |
| S2 | Cesium Mars tileset (Cesium / Bentley; NASA, USGS, ESA data) | Optional far-zoom globe | ⏳ C2: read Cesium ion terms first |
| S3 | DONKI space weather (NASA CCMC) | Solar storm and radiation alerts | ⏳ Run C1–C5 |
| S4 | Perseverance MEDA weather (NASA PDS) | Wind, temperature and dust at Jezero | ⏳ Run C1–C5 |
| S5 | Curiosity RAD surface radiation (NASA PDS) | Typical surface dose (measured at Gale; label it so) | ⏳ Run C1–C5 |
| S6 | MRO MARCI weather images (NASA / MSSS) | Dust storm watch | ⏳ Run C1–C5 |

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
- **Map tiles:** 1,285 cached Trek tiles (HiRISE, CTX, THEMIS, MOLA).
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

- **One pipeline, many zones:** `config.py` has a `Zone` record per walk zone (`ZONES = {z1, z2}`). Build with `uv run baroler-build --zone z1`. Each build also writes `data/package/index.json`, the zone list the app reads.
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

## 9. Files in this repo

- `docs/PLAN.md` — this file
- `docs/Baroler-Report.html` — the same content as a readable web page
- `docs/Baroler-User-Scenario.html` — what the end user sees and does, start to finish
- `schema/marswalk.schema.json` — data model (JSON Schema 2020-12)
- `schema/README.md` — how the schema fits together + rules the schema can't express
- `data/sources.registry.json` — the verified source ledger (R1–R5 + S1)
- `CLAUDE.md`, `.claude/` — Claude Code setup
