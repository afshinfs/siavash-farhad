import assert from 'node:assert/strict';
import { exposureGraphs } from './exposure-graphs.mjs';
import { checkExposureAudit, decodeExposureLayers, exposureRequests, fillExposureGraph } from './exposure-core.mjs';

const settings = { groups: ['population','builtup','buildings','nightlights'], epoch: 2020, viirsYear: 2021, buildingSource: 'proxy' };
const dem = {
  bounds: { west: 47.69, south: 33.14, east: 47.72, north: 33.17 },
  grid: { crsCode: 'EPSG:32638', affineTransform: { scaleX: 30, scaleY: -30, translateX: 751260, translateY: 3672660 } },
};
for (const request of [...exposureRequests(settings), ...exposureRequests({ ...settings, groups: ['buildings'], buildingSource: 'footprints' })]) {
  const { expression, audit } = exposureGraphs[request.key];
  for (const template of [expression, audit].filter(Boolean)) {
    const filled = fillExposureGraph(template, request, settings.viirsYear, dem);
    assert(filled.result in filled.values);
    const serialized = JSON.stringify(filled);
    assert(!/__\w+__|101\.0101|12\.345601/.test(serialized));
    assert(serialized.includes(request.asset));
    if (['proxy', 'footprints'].includes(request.key) && template === expression) {
      assert(serialized.includes('EPSG:32638'));
      assert(serialized.includes('751260'));
    }
    if (request.key === 'nightlights') assert(serialized.includes('2022-01-01'));
  }
}
assert.throws(() => exposureRequests({ ...settings, epoch: 2021 }), /five-year/);
assert.throws(() => exposureRequests({ ...settings, viirsYear: 2013 }), /completed VIIRS year/);
assert.throws(() => checkExposureAudit('nightlights', { months: 11 }), /12 monthly/);
assert.throws(() => checkExposureAudit('footprints', { features: 0 }), /no footprints/);
const results = decodeExposureLayers('test', {
  population_density: [0, 42, -1, 55],
  builtup_fraction: [0, .5, 1.1, .9],
  building_footprint_mask: [0, 1, 2, 1],
  nightlights: [-1, 0, NaN, 3],
  nightlights_months: [0, 12, 13, 3],
}, [1, 1, 1, 0]);
assert.deepEqual(Object.values(results).map(layer => Array.from(layer)), [
  [0,42,-9999,-9999], [0,.5,-9999,-9999], [0,1,-9999,-9999], [-1,0,-9999,-9999], [0,12,-9999,-9999],
]);
console.log('Exposure settings, graph substitution, source audits, raster values and DEM masks passed.');
