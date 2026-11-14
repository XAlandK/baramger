---
name: source-compliance
description: Check that a data source, layer, or feature for the Baroler Marswalk project traces back to the five challenge resources (R1 Mars Trek, R2 USGS PGM, R3 Curiosity route map, R4 NASA Worldview, R5 Perseverance raw images), and that any extra source passes the D2 checks (no link to China, permission, verified, qualified, real). Use before adding any new layer, data source, download, MCP, or map feature, and before a submission.
---

# Source compliance check

Hard project rule: the product must be built on the five resources listed in `TheChallenge.txt`.

## Steps

1. Read `data/sources.registry.json` and `CLAUDE.md` (decisions D1–D5 and "Extra data rules").
2. For the thing being added, answer:
   - Which source ID does it come from? (`R1`–`R5`, or `S<n>`)
   - If `S<n>`, it must pass **all** D2 checks. If any check fails, don't use it. If a check can't be confirmed, **stop and ask the user**.
     - **C1 No link to China:**
       - Producer mission or agency isn't Chinese (CNSA, Tianwen-1, Zhurong, Chang'e…).
       - Not hosted in China, and not blended with Chinese data.
       - The tool or MCP that fetches it talks only to allowed hosts.
     - **C2 Permission:** a license or terms that allow our use. Credit recorded.
     - **C3 Verified:** official producer or archive. Opened and checked against its metadata.
     - **C4 Qualified:** official, documented product with known resolution, date and accuracy.
     - **C5 Real:** measured data. Nothing simulated, AI-generated or made up.
   - If it came through an MCP: is that MCP one of `nasa`, `pds`, `gdal`, with a pinned version? Cross-check key values against the official source.
   - Is the role right? R3 = design reference only, R4 = UX inspiration only (Earth data). Neither may be drawn as Mars data.
   - Does the layer's coverage include the chosen site AOI? (HiRISE Jezero: lon 77.2229–77.5840, lat 18.3068–18.6693)
   - Is the resolution fit for a walk (≤ 1 m for hazards, coarser = context only)? Say so in `caveats`.
   - Is the attribution/credit recorded?
   - Is the download > 200 MB? → ask the user first.
3. If it's a new source, add it to the registry with `verified.date` and `status`. Put the C1–C5 results in `verified.notes` and `caveats`.
4. Validate:
   ```bash
   uv run --quiet --no-project --python 3.12 --with jsonschema python -I -c "import json,sys;from jsonschema import Draft202012Validator as V;s=json.load(open('schema/marswalk.schema.json'));d=json.load(open(sys.argv[1]));e=list(V(s).iter_errors(d));print('valid' if not e else e[0].message)" data/sources.registry.json
   ```
5. Report back to the user in simple English: source ID, role, coverage OK?, resolution note, credit, the C1–C5 result for extras, and any flag.

## Coverage summary (keep up to date)

| Resource | Used for |
|---|---|
| R1 | HiRISE/CTX imagery + DEMs, THEMIS/TES thermal & spectral, global geology tiles, traverse, the two whole-planet maps (MOLA height colours, Viking colour mosaic), the Jezero record of Trek's name layer (crater centre and width) |
| R2 | SIM 3464 Jezero geologic units and the ten place names printed on it, SIM 3292 context |
| R3 | Annotated route-map visual style |
| R4 | Layer picker, timeline, compare-view UX patterns |
| R5 | Ground "what you will see" photos at each stop |
