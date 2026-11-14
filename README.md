# SIAVASH & FARHAD

Website-only distribution of the browser feasibility prototype for the SIAVASH
flood-hazard and FARHAD flood-risk frameworks. The main SIAVASH desktop source
repository remains separate and private.

This stage tests synthetic XGBoost training, spatial cross-validation, Rasterio
GeoTIFF processing and portable model persistence in a background browser worker.
Earth Engine integration and full hazard/risk workflows are not implemented yet.

Contains only the HTML interface, browser worker, checks, styling and ML helper
module needed by the prototype. No credentials or research datasets are included.

## Hosting

GitHub Pages: deploy from the main branch, repository root. `.nojekyll` preserves
the static directory layout. Users need no Python installation; the Python runtime
and scientific packages load into their browsers from the pinned Pyodide CDN.

Copyright (c) 2026 Afshin Fouladi. All rights reserved. See COPYRIGHT.
No open-source licence is granted.
