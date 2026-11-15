# Roads and rivers: browser processing

Stage 5 adds public OpenStreetMap rivers and major roads, distance-to-river,
distance-to-major-road and smoothed river-pixel density. The page retains the
Earth Engine, terrain, hydrology and Python compatibility stages.

Live retrieval uses https://overpass-api.de/api/interpreter, with a projected
1 km padding around the DEM (rounded up to whole pixels). No Google credentials
are passed to this worker. A saved Overpass JSON response or WGS84 GeoJSON
FeatureCollection can be used instead. Saved files must cover the search grid.
Query failures and Overpass partial-data remarks are errors, not empty datasets.

Filters match the desktop defaults: waterway=river and highways trunk,
trunk_link, primary and primary_link. Live queries retrieve ways only. Only
line geometries are processed. Local GeoJSON may use these OSM tags or an
explicit kind property of river or road. Geometry can be downloaded as GeoJSON.

Distances use an exact Euclidean distance transform of buffered raster masks.
The half-cell (minimum 5 m) round buffer is burned into all intersected cells;
distances are to their cell centres, not vector centrelines. Density uses an
odd box window nearest to 200 m (at least three pixels), Gaussian sigma
max(1, window/6), truncate=4, and half-sample reflect boundaries. Its units are
pixel fraction (0–1), not length per area. Processing includes the search buffer
before cropping outputs to the DEM. The DEM NoData footprint is preserved.

Missing mapped roads/rivers produce NoData distance, not the desktop diagonal
fallback. Missing rivers produce zero density after a successful empty query.
This stage is not numerically interchangeable with the desktop pipeline:
rasterisation and search extents differ, and no full equivalence is claimed.
OSM coverage is variable and features beyond the buffer are omitted.

Inputs: north-up, single-band, single-image WGS84 UTM square 10–100 m grids,
at most 512 × 512 cells, 25 km² and 8 MB. Local OSM data limit: 20 MB; line limit:
20,000 lines and 300,000 coordinate points. Live request timeout: 45 seconds.

Run `node linear.test.mjs` for analytic distance, buffered features outside the
DEM, point-to-grid Euclidean distance, NoData and validation cases. Distance
and density kernels were also compared with SciPy EDT, uniform_filter and
Gaussian filter on independent reference masks. Full real-world model accuracy
and desktop equivalence remain unvalidated.

Data © OpenStreetMap contributors, https://www.openstreetmap.org/copyright,
ODbL. The application copyright does not replace OSM attribution or licensing.
Application copyright (c) 2026 Afshin Fouladi. All rights reserved.
