# Satellite and environmental predictors

The satellite panel reuses the existing visitor-owned Earth Engine connection.
Connect above, then retrieve or open a DEM and select datasets and dates. Every
request uses that DEM's exact dimensions, affine grid and WGS84 UTM CRS. Single
image, single-band DEMs are limited to 512 × 512 cells, 25 km² and 8 MB.

Earth Engine computes collection composites and returns GeoTIFFs directly to
the browser. The background worker decodes, validates alignment, preserves the
DEM mask, applies class lookups and writes aligned Float32 GeoTIFFs with -9999
NoData. OAuth access tokens remain in the main controller's memory; they never
enter the worker or reports. Requests can be cancelled; successful earlier
outputs remain available if another source fails.

## Outputs

| Output | Source and method | Native detail |
| --- | --- | --- |
| lulc | ESA WorldCover v100 (2020) or v200 (2021), nearest sampling | 10 m |
| manning | Existing desktop lookup applied to sampled WorldCover classes | Land-cover proxy |
| ndvi | Mean per-scene Sentinel-2 SR (B8−B4)/(B8+B4); SCL 4/5/6/11 retained | 10–20 m inputs |
| ndvi_observations | Count of unmasked per-scene NDVI observations | Diagnostic |
| rainfall | CHIRPS daily sum across the selected end-exclusive interval | About 5.6 km |
| spi_proxy | Rolling precipitation z-score against the same ending calendar month across baseline years | CHIRPS resolution |
| hsg_proxy | OpenLandMap 0 cm texture classes remapped by the existing desktop lookup | 250 m proxy |
| merit_hnd | MERIT Hydro hnd, retained as hydrologically adjusted elevation above EGM96 | About 90 m |

Continuous products use bilinear sampling. Classes and observation counts use
nearest sampling. Output-grid sampling does not add fine-scale source detail.
WorldCover year is independent of the temporal composite settings.

## Important distinctions from the desktop reference

- The anomaly preserves the desktop z-score approach, not distribution-fitted
  gamma SPI. It requires at least 30 complete matching baseline windows, a full
  target period and nonzero per-pixel standard deviation. Baseline years are
  complete January–December years; the first year is omitted when an
  accumulation window would start before the baseline. Calendar/leap-year
  day counts are checked. A constant baseline yields NoData.
- The source MERIT hnd band is not treated as a validated relative height above
  drainage predictor. It is explicitly labelled adjusted elevation. True HAND
  computation remains a separate task; do not silently substitute this output
  for relative HAND in model training.
- NDVI uses SCL without QA60, avoiding the documented QA60 availability gap.
  It has no L1C fallback. This differs from the desktop QA60-plus-SCL mask.
- Soil groups are a texture-derived proxy, not measured hydrologic groups.
  Manning n values are a lookup assumption, not calibrated hydraulic values.
- Incomplete rainfall periods are rejected instead of silently exported as
  complete sums. Cloudy/missing pixels stay NoData; valid zero is preserved.

Dates are end-exclusive, with NDVI/rainfall periods capped at 366 days. NDVI
starts no earlier than 2017-03-28, CHIRPS no earlier than 1981-01-01. CHIRPS
requests are restricted to 50°S–50°N. Baseline years must end before the current
year. The target accumulation must consist of completed historical months.
The metadata check, each download and response decode have bounded timeouts.
Reports record source IDs, dates, grids, mappings, coverage, failures and limits.

## Implementation and validation

The request templates were generated with the official Earth Engine Python
serializer. See graph-provenance.json. No SDK is bundled in the production
page: the existing Earth Engine REST connection sends the filled expressions.
The templates in satellite-graphs.mjs and satellite-graphs.json are equivalent;
core validation, request handling, worker and UI source files are included.
The page loads their bundled implementation in gee.js.

Run `node satellite.test.mjs` for parameter/date checks, template substitution,
metadata completeness, class lookups, zero/negative values, NoData and request
failure/cancellation handling. Generated graph references, algorithm names and
argument names were checked against official public API signatures. The worker
was tested against the downloaded 5,504-cell Poldokhtar DEM and synthetic
source rasters, including multiband NDVI, all eight exports, CRS/origin, every
output pixel and rejection of a mismatched response grid.

These checks do not establish successful authenticated server evaluation of
the composites, full desktop equivalence or flood prediction accuracy. A live
Earth Engine account/project run is still required for those retrieval checks.

## Sources and attribution

- https://developers.google.com/earth-engine/datasets/catalog/ESA_WorldCover_v200
- https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED
- https://developers.google.com/earth-engine/datasets/catalog/UCSB-CHG_CHIRPS_DAILY
- https://developers.google.com/earth-engine/datasets/catalog/OpenLandMap_SOL_SOL_TEXTURE-CLASS_USDA-TT_M_v02
- https://developers.google.com/earth-engine/datasets/catalog/MERIT_Hydro_v1_0_1

Source-data attribution/licences apply to outputs. Application copyright
(c) 2026 Afshin Fouladi. All rights reserved; no open-source licence is granted.
