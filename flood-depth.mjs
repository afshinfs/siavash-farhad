export const glofasAsset = 'JRC/CEMS_GLOFAS/FloodHazard/v2_1';
export const glofasPeriods = [10, 20, 50, 75, 100, 200, 500];

export function buildFloodRequest(periods, { maskSpurious, maskWater }, { bounds, grid }) {
  if (!periods.length || new Set(periods).size !== periods.length ||
      periods.some(period => !glofasPeriods.includes(period))) {
    throw Error('Select one or more published GloFAS return periods.');
  }
  const bandNames = periods.map(period => 'RP' + period + '_depth');
  const constant = constantValue => ({ constantValue });
  const invoke = (functionName, args) => ({ functionInvocationValue: { functionName, arguments: args } });
  const ref = valueReference => ({ valueReference });
  const image = value => invoke('Image.constant', { value: constant(value) });
  const select = (input, names) => invoke('Image.select', { input, bandSelectors: constant(names) });
  const unmask = (input, value) => invoke('Image.unmask', {
    input, value: image(value), sameFootprint: constant(false),
  });
  const applyMask = (input, mask) => invoke('Image.updateMask', { image: input, mask });
  const { west, south, east, north } = bounds;
  const region = invoke('GeometryConstructors.Rectangle', {
    coordinates: constant([west, south, east, north]), geodesic: constant(false),
  });
  const { scaleX, scaleY, translateX, translateY } = grid.affineTransform;
  const tile = { argumentReference: 'tile' };
  let depth = select(tile, bandNames);
  for (const [enabled, name] of [[maskSpurious, 'spurious_depth_category'], [maskWater, 'permanent_water_class']]) {
    if (!enabled) continue;
    // The QA bands can be sparse. Treat an absent flag as clear without filling depth.
    const flag = unmask(select(tile, [name]), 0);
    depth = applyMask(depth, invoke('Image.neq', { image1: flag, image2: image(1) }));
  }
  const projection = invoke('Projection', {
    crs: constant(grid.crsCode), transform: constant([scaleX, 0, translateX, 0, scaleY, translateY]),
  });
  // Resample individual source images using their own projections before mosaicking.
  const aligned = invoke('Image.reproject', {
    image: invoke('Image.resample', { image: depth, mode: constant('bilinear') }),
    crs: ref('outputProjection'),
  });
  const tiles = invoke('Collection.map', {
    collection: invoke('ImageCollection.load', { id: constant(glofasAsset) }),
    baseAlgorithm: { functionDefinitionValue: { argumentNames: ['tile'], body: 'alignTile' } },
  });
  const mosaic = invoke('Image.setDefaultProjection', {
    image: invoke('ImageCollection.mosaic', { collection: tiles }), crs: ref('outputProjection'),
  });
  const clipped = invoke('Image.clip', { input: mosaic, geometry: region });
  return {
    bandNames,
    expression: {
      result: 'depth',
      values: {
        outputProjection: projection,
        alignTile: aligned,
        depth: unmask(invoke('Image.toFloat', { value: clipped }), -9999),
      },
    },
  };
}

// Serialized into the existing raster worker, so this function is self-contained.
export function decodeFloodDepth(_group, bands, mask) {
  return Object.fromEntries(Object.entries(bands).map(([name, samples]) => {
    if (samples.length !== mask.length) throw Error('Flood-depth band does not match the DEM dimensions.');
    const values = Float32Array.from(samples, (value, i) =>
      mask[i] && Number.isFinite(value) && value !== -9999 ? Math.max(0, value) : -9999);
    return [name, values];
  }));
}

export function createFloodDepthPanel({ element, readConnection, request, rasterWorker, callWorker }) {
  const field = name => element('flood-' + name);
  const options = field('options');
  let source = null;
  let active = null;
  let outputs = [];
  let report = null;

  function message(text, error = false) {
    field('status').textContent = text;
    field('status').classList.toggle('error', error);
  }
  function clear() {
    for (const product of outputs) URL.revokeObjectURL(product.url);
    outputs = [];
    report = null;
    for (const id of ['preview', 'downloads', 'layer']) field(id).replaceChildren();
    field('result').textContent = '';
    field('report').disabled = true;
    field('layer').disabled = true;
  }
  function refresh() {
    const connected = Boolean(readConnection().accessToken);
    field('run').disabled = !source || !connected || Boolean(active);
    field('cancel').disabled = !active;
    field('file').disabled = Boolean(active);
    options.disabled = Boolean(active);
    field('auth').textContent = connected
      ? 'Using the Earth Engine connection above.'
      : 'Connect your Google account above to retrieve GloFAS depths.';
  }
  function stop() {
    active?.controller.abort();
    active?.worker?.terminate();
    active = null;
    refresh();
  }
  function setSource(blob, info) {
    stop();
    clear();
    source = blob ? { blob, info } : null;
    field('source').textContent = blob
      ? 'DEM ready · ' + (info?.label || 'retrieved elevation')
      : 'Retrieve a DEM above or open a DEM here.';
    message('');
    refresh();
  }
  function showLayer() {
    const product = outputs.find(output => output.name === field('layer').value);
    if (!product) return;
    const { width, height } = report.grid.dimensions;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('aria-label', product.period + '-year GloFAS depth preview');
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(product.preview), width, height), 0, 0);
    field('preview').replaceChildren(canvas);
    const { min, max, validCells } = product.summary;
    const coverage = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(validCells / report.demValidCells);
    field('result').textContent = `${min.toPrecision(4)} to ${max.toPrecision(4)} m · ${validCells.toLocaleString()} cells (${coverage} of valid DEM cells)`;
  }
  async function run() {
    if (!source || active) return;
    const periods = Array.from(options.querySelectorAll('[data-flood-period]:checked'), input => Number(input.value));
    if (!periods.length) { message('Select at least one return period.', true); return; }
    const settings = { maskSpurious: field('spurious').checked, maskWater: field('water').checked };
    const selected = source;
    const connection = readConnection();
    const job = { controller: new AbortController(), worker: null };
    active = job;
    clear();
    refresh();
    const signal = job.controller.signal;
    try {
      message('Reading the DEM grid…');
      const buffer = await selected.blob.arrayBuffer();
      if (signal.aborted) return;
      const units = Object.fromEntries(periods.map(period => ['RP' + period + '_depth', 'm']));
      const code = '(' + rasterWorker.toString() + ')(' + decodeFloodDepth.toString() + ',{},{},' + JSON.stringify(units) + ');';
      const workerURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { job.worker = new Worker(workerURL); }
      finally { URL.revokeObjectURL(workerURL); }
      const prepared = await callWorker(job, { action: 'prepare', buffer }, 'Flood-depth');
      const { expression, bandNames } = buildFloodRequest(periods, settings, prepared);
      message('Retrieving GloFAS v2.1 reference depths…');
      const pixels = await request({ ...connection, expression, grid: prepared.grid, bands: bandNames, signal });
      if (signal.aborted) return;
      const { products } = await callWorker(job, {
        action: 'product', group: 'flood-depth', buffer: pixels, bands: bandNames,
      }, 'Flood-depth');
      if (signal.aborted) return;
      report = {
        schemaVersion: 1, stage: 'reference flood depths', asset: glofasAsset, nominalSourceResolutionM: 90,
        source: selected.info, sourceSHA256: prepared.sourceSHA256, grid: prepared.grid,
        demValidCells: prepared.validCells, periods, settings, nodata: -9999,
        resampling: 'Earth Engine bilinear on the DEM grid', processedAt: new Date().toISOString(),
        products: Object.fromEntries(products.map(product => [product.name, product.summary])),
        periodsWithoutValidData: [],
      };
      for (const product of products) {
        const period = Number(product.name.match(/^RP(\d+)_depth$/)[1]);
        if (!product.summary.validCells) {
          report.periodsWithoutValidData.push(period);
          continue;
        }
        const url = URL.createObjectURL(new Blob([product.tiff], { type: 'image/tiff' }));
        outputs.push({ ...product, period, url });
        field('layer').add(new Option(period + '-year depth', product.name));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'flood_' + period + 'yr_aligned.tif';
        link.textContent = 'Download ' + period + '-year depth';
        field('downloads').append(link);
      }
      field('report').disabled = false;
      field('layer').disabled = !outputs.length;
      showLayer();
      const missing = report.periodsWithoutValidData;
      report.status = outputs.length ? (missing.length ? 'partial' : 'completed') : 'no_data';
      message(
        outputs.length + ' reference depth layers ready.' +
        (missing.length ? ' No valid depths after masking for these return periods (years): ' + missing.join(', ') + '.' : ''),
        !outputs.length,
      );
    } catch (error) {
      if (!signal.aborted) message(error.message, true);
    } finally {
      if (active === job) stop();
    }
  }

  field('run').addEventListener('click', run);
  field('cancel').addEventListener('click', () => { stop(); message('Flood-depth retrieval cancelled.'); });
  field('layer').addEventListener('change', showLayer);
  options.addEventListener('change', () => { clear(); message(''); });
  field('file').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { message('Use a DEM no larger than 8 MB.', true); return; }
    setSource(file, { kind: 'local file', label: file.name });
  });
  field('report').addEventListener('click', () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'siavash-reference-flood-depth-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return { setSource, refresh };
}
