"""Generate browser request templates using Earth Engine's expression serializer."""
import argparse
import json
from pathlib import Path
import ee
from ee import _cloud_api_utils

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("algorithms", type=Path, help="Earth Engine algorithms API response")
args = parser.parse_args()
algorithms = _cloud_api_utils.convert_algorithms(json.loads(args.algorithms.read_text()))
ee.data._install_cloud_api_resource = lambda: None
ee.data.getAlgorithms = lambda: algorithms
ee.Initialize(None, '', project='offline-expression-verification')

region = ee.Geometry.Rectangle([12.345601, 23.456702, 34.567803, 45.678904], geodesic=False)
target = ee.Projection('__EXPOSURE_CRS__', [101.0101, 0, 102.0102, 0, -103.0103, 104.0104])
population = ee.Image('__POP_ASSET__').select('population_count').multiply(100)
built = ee.Image('__BUILT_ASSET__').select('built_surface').divide(10000)
surface = ee.Image('JRC/GHSL/P2023A/GHS_BUILT_S_10m/2018').select('built_surface')
presence = surface.gt(0).reduceResolution(ee.Reducer.max(), bestEffort=False, maxPixels=1024).reproject(target)
footprints = ee.FeatureCollection('GOOGLE/Research/open-buildings/v3/polygons').filterBounds(region)
buildings = ee.Image.constant(0).toByte().paint(footprints, 1).reproject(target)
monthly = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG').filterDate('__LIGHT_START__', '__LIGHT_END__')
def mask_dark_observations(image):
    return image.select('avg_rad').updateMask(image.select('cf_cvg').gt(0))
covered = monthly.map(mask_dark_observations)
projection = ee.Image(monthly.first()).select('avg_rad').projection()
radiance = covered.mean().setDefaultProjection(projection).resample('bilinear')
months = covered.count().unmask(0).setDefaultProjection(projection)
def descriptor(image, names, audit=None):
    image = image.rename(names).clip(region).toFloat().unmask(-9999, False)
    result = {'expression': ee.serializer.encode(image, for_cloud_api=True), 'bands': names}
    if audit is not None:
        result['audit'] = ee.serializer.encode(ee.Dictionary(audit), for_cloud_api=True)
    return result
graphs = {
    'population': descriptor(population, ['population_density']),
    'builtup': descriptor(built, ['builtup_fraction']),
    'proxy': descriptor(presence, ['building_presence_proxy']),
    'footprints': descriptor(buildings, ['building_footprint_mask'], {'features': footprints.size()}),
    'nightlights': descriptor(radiance.addBands(months), ['nightlights', 'nightlights_months'], {'months': monthly.size()})
}
Path(__file__).with_name('exposure-graphs.mjs').write_text(
    'export const exposureGraphs = ' + json.dumps(graphs, indent=2) + ';\n'
)
