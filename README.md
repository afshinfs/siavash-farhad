# SIAVASH & FARHAD

Browser prototype for SIAVASH flood hazard and FARHAD flood risk workflows.
The desktop source repository remains separate and private.

Earth Engine retrieves SRTM elevation on a 30 m WGS84 UTM grid. Each visitor
connects their own Earth Engine-enabled project using a Web OAuth client with
https://afshinfs.github.io as an authorised origin. Tokens stay in browser memory.
Terrain and hydrology calculations run in background browser workers.

## Current processing

- Terrain: Horn slope/aspect, TRASP and Zevenbergen–Thorne planform curvature.
- Hydrology: Priority-Flood depression filling, D8 direction, contributing-cell
  accumulation, log accumulation and the desktop count-based TWI formula.
- Each layer has a preview, aligned Float32 GeoTIFF export and a JSON report.
- Retrieve a DEM first, or open a downloaded single-band GeoTIFF. Limits:
  512 × 512 cells, 8 MB, north-up square pixels in WGS84 UTM metre units.

Hydrology uses eight-neighbour Priority-Flood with no epsilon changes to heights.
Strict downhill flow takes the greatest elevation drop per distance; flats follow
flood discovery parents. D8 codes: E=1, SE=2, S=4, SW=8, W=16, NW=32, N=64,
NE=128; outlet=0. Equal downhill gradients use this same ordering. NoData holes
and raster edges are open boundaries. Accumulation includes the cell itself.

TWI = ln((flowacc + 1) / (tan(original DEM Horn slope) + 0.001)), with slope
clipped to 0–89.9 degrees. This preserves the desktop formula and is count-based,
not a specific-catchment-area index. Log accumulation = ln(1 + flowacc).

Flat routing differs from RichDEM epsilon filling, so numerical equivalence to
the desktop hydrology pipeline has not been established. Catchments outside
the raster are omitted: use a buffered DEM. Drainage products are not a flood
simulation. Full SIAVASH/FARHAD hazard and risk calculations remain pending.

## Verification and source

Run `node hydro.test.mjs` for known-direction/count planes, a spill-level bowl,
flat drainage, NoData islands, the TWI formula, deterministic random grids,
single-cell handling and invalid input. Each processing run checks for routing
cycles and conservation of contributing cell counts at outlets. These are
implementation checks, not validation against real drainage observations.

Hydrology source is in hydro-core.mjs, hydro-worker.mjs and hydro-ui.js; the page
loads the bundled gee.js. The worker receives DEM bytes, not Google credentials.
The separate synthetic Python/ML compatibility checks remain available.

## Hosting

GitHub Pages deploys main at the repository root. `.nojekyll` preserves files.
Copyright (c) 2026 Afshin Fouladi. All rights reserved. See COPYRIGHT.
No open-source licence is granted.
