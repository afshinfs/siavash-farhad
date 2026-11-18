export const exposureProducts = {
  population_density: { label: 'Residential population density', unit: 'people per km²' },
  builtup_fraction: { label: 'Built-up surface fraction', unit: 'fraction (0–1)' },
  building_presence_proxy: { label: 'Building presence proxy', unit: '0 or 1' },
  building_footprint_mask: { label: 'Mapped building footprints', unit: '0 or 1' },
  nightlights: { label: 'Mean night-light radiance', unit: 'nW/cm²/sr' },
  nightlights_months: { label: 'Months with usable night-light observations', unit: 'months (0–12)' },
};

export function exposureRequests({ groups, epoch, viirsYear, buildingSource }, now = new Date()) {
  if (!groups.length) throw Error('Select at least one exposure layer.');
  if (!Number.isInteger(epoch) || epoch < 1975 || epoch > 2020 || epoch % 5 !== 0) {
    throw Error('Choose a GHSL estimate year in five-year steps from 1975 to 2020.');
  }
  if (groups.includes('nightlights') && (!Number.isInteger(viirsYear) || viirsYear < 2014 || viirsYear >= now.getUTCFullYear())) {
    throw Error('Choose a completed VIIRS year from 2014 onwards.');
  }
  if (!['proxy', 'footprints'].includes(buildingSource)) throw Error('Choose a building source.');
  return groups.map(group => {
    switch (group) {
      case 'population':
        return { key: group, label: 'GHSL population', asset: 'JRC/GHSL/P2023A/GHS_POP/' + epoch };
      case 'builtup':
        return { key: group, label: 'GHSL built-up surface', asset: 'JRC/GHSL/P2023A/GHS_BUILT_S/' + epoch };
      case 'buildings':
        return buildingSource === 'proxy'
          ? { key: 'proxy', label: 'GHSL building presence proxy', asset: 'JRC/GHSL/P2023A/GHS_BUILT_S_10m/2018' }
          : { key: 'footprints', label: 'Open Buildings footprints', asset: 'GOOGLE/Research/open-buildings/v3/polygons' };
      case 'nightlights':
        return { key: group, label: 'VIIRS night lights', asset: 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG' };
      default:
        throw Error('Unknown exposure layer.');
    }
  });
}

export function fillExposureGraph(graph, request, viirsYear, { bounds, grid }) {
  const { scaleX, translateX, scaleY, translateY } = grid.affineTransform;
  const replacements = new Map([
    ['__EXPOSURE_CRS__', grid.crsCode], ['__POP_ASSET__', request.asset], ['__BUILT_ASSET__', request.asset],
    ['__LIGHT_START__', viirsYear + '-01-01'], ['__LIGHT_END__', (viirsYear + 1) + '-01-01'],
    [12.345601, bounds.west], [23.456702, bounds.south], [34.567803, bounds.east], [45.678904, bounds.north],
    [101.0101, scaleX], [102.0102, translateX], [-103.0103, scaleY], [104.0104, translateY],
  ]);
  function replace(value) {
    if (replacements.has(value)) return replacements.get(value);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  }
  return replace(graph);
}

export function checkExposureAudit(key, result) {
  if (key === 'nightlights' && result?.months !== 12) {
    throw Error('VIIRS did not return all 12 monthly composites. Choose an earlier year.');
  }
  if (key === 'footprints' && !(result?.features > 0)) {
    throw Error('Open Buildings returned no footprints in this area. Use the GHSL presence proxy or choose a different area.');
  }
}

export function decodeExposureLayers(group, bands, mask) {
  const layers = {};
  for (const [name, values] of Object.entries(bands)) {
    if (values.length !== mask.length) throw Error('Exposure band does not match the DEM dimensions.');
    const layer = new Float32Array(mask.length).fill(-9999);
    for (let i = 0; i < mask.length; i++) {
      const value = values[i];
      if (!mask[i] || !Number.isFinite(value) || value === -9999) continue;
      if (name === 'population_density' && value < 0) continue;
      if (name === 'builtup_fraction' && (value < 0 || value > 1)) continue;
      if (name === 'nightlights_months' && (!Number.isInteger(value) || value < 0 || value > 12)) continue;
      if ((name === 'building_presence_proxy' || name === 'building_footprint_mask') && value !== 0 && value !== 1) continue;
      layer[i] = value;
    }
    layers[name] = layer;
  }
  return layers;
}
