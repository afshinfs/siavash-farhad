import { appendRasterCard } from './raster-cards.mjs?v=single-map';
export const glofasAsset = 'JRC/CEMS_GLOFAS/FloodHazard/v2_1';
export const glofasPeriods = [10, 20, 50, 75, 100, 200, 500];
const gumbelPeriods = [25, 30, 300, 1000];

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

// Both functions are serialized into the existing raster worker.
export function fitGumbelDepths(basePeriods, inputLayers, targetPeriods) {
  const reducedVariate = period => -Math.log(-Math.log(1 - 1 / period));
  const reduced = basePeriods.map(reducedVariate);
  const mean = reduced.reduce((sum, value) => sum + value, 0) / reduced.length;
  const centered = reduced.map(value => value - mean);
  const variance = centered.reduce((sum, value) => sum + value * value, 0);
  const targets = targetPeriods.map(period => reducedVariate(period) - mean);
  const outputs = targets.map(() => new Float32Array(inputLayers[0].length).fill(-9999));
  for (let cell = 0; cell < inputLayers[0].length; cell++) {
    let sum = 0;
    let complete = true;
    for (const layer of inputLayers) {
      const depth = layer[cell];
      if (depth === -9999 || !Number.isFinite(depth)) {
        complete = false;
        break;
      }
      sum += depth;
    }
    if (!complete) continue;
    const meanDepth = sum / inputLayers.length;
    const covariance = centered.reduce((total, offset, i) =>
      total + offset * (inputLayers[i][cell] - meanDepth), 0);
    const slope = covariance / variance;
    for (const [i, offset] of targets.entries()) {
      outputs[i][cell] = Math.max(0, meanDepth + slope * offset);
    }
  }
  return outputs;
}

export function decodeFloodDepth(bands, mask, basePeriods, publishedPeriods, targetPeriods, fit) {
  const layers = Object.fromEntries(basePeriods.map(period => {
    const samples = bands['RP' + period + '_depth'];
    if (samples?.length !== mask.length) throw Error('Flood-depth band does not match the DEM dimensions.');
    const values = Float32Array.from(samples, (value, i) =>
      mask[i] && Number.isFinite(value) && value !== -9999 ? Math.max(0, value) : -9999);
    return [period, values];
  }));
  const outputs = Object.fromEntries(publishedPeriods.map(period => ['RP' + period + '_depth', layers[period]]));
  if (targetPeriods.length) {
    const fitted = fit(basePeriods, basePeriods.map(period => layers[period]), targetPeriods);
    for (const [i, period] of targetPeriods.entries()) outputs['RP' + period + '_depth'] = fitted[i];
  }
  return outputs;
}

export function createFloodDepthPanel({ element, readConnection, request, rasterWorker, callWorker, onChange = () => {} }) {
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
    onChange();
    field('cards').replaceChildren();
    field('report').disabled = true;
  }
  function refresh() {
    const connected = Boolean(readConnection().accessToken);
    field('run').disabled = !source || !connected || Boolean(active);
    field('cancel').disabled = !active;
    field('file').disabled = Boolean(active);
    options.disabled = Boolean(active);
    field('run').textContent = field('gumbel').checked ? 'Retrieve depths and fit Gumbel' : 'Retrieve reference depths';
    field('auth').textContent = connected
      ? 'Using the Earth Engine connection under Study area.'
      : 'Connect your Google account under Study area to retrieve GloFAS depths.';
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
      : 'Retrieve a DEM under Study area or open one here.';
    message('');
    refresh();
  }
  async function run() {
    if (!source || active) return;
    const periods = Array.from(options.querySelectorAll('[data-flood-period]:checked'), input => Number(input.value));
    const targets = field('gumbel').checked ? gumbelPeriods : [];
    if (!periods.length && !targets.length) { message('Select a published return period or enable the Gumbel fit.', true); return; }
    const inputs = targets.length ? glofasPeriods : periods;
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
      const units = Object.fromEntries([...periods, ...targets].map(period => ['RP' + period + '_depth', 'm']));
      const selections = [inputs, periods, targets].map(values => JSON.stringify(values)).join(',');
      const code = `const decode = ${decodeFloodDepth.toString()};
const fit = ${fitGumbelDepths.toString()};
(${rasterWorker.toString()})((_, bands, mask) => decode(bands, mask, ${selections}, fit), {}, {}, ${JSON.stringify(units)});`;
      const workerURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { job.worker = new Worker(workerURL); }
      finally { URL.revokeObjectURL(workerURL); }
      const prepared = await callWorker(job, { action: 'prepare', buffer }, 'Flood-depth');
      const { expression, bandNames } = buildFloodRequest(inputs, settings, prepared);
      message('Retrieving GloFAS v2.1 reference depths…');
      const pixels = await request({ ...connection, expression, grid: prepared.grid, bands: bandNames, signal });
      if (signal.aborted) return;
      if (targets.length) message('Fitting Gumbel depths in your browser…');
      const { products } = await callWorker(job, {
        action: 'product', group: 'flood-depth', buffer: pixels, bands: bandNames,
      }, 'Flood-depth');
      if (signal.aborted) return;
      report = {
        schemaVersion: 1, stage: 'reference flood depths', asset: glofasAsset, nominalSourceResolutionM: 90,
        source: selected.info, sourceSHA256: prepared.sourceSHA256, grid: prepared.grid,
        demValidCells: prepared.validCells, periods, requestedSourcePeriods: inputs, settings, nodata: -9999,
        resampling: 'Earth Engine bilinear on the DEM grid', processedAt: new Date().toISOString(),
        ...(targets.length && { gumbel: {
          interpolationPeriods: targets.filter(period => period <= inputs.at(-1)),
          extrapolationPeriods: targets.filter(period => period > inputs.at(-1)),
          method: 'Pixel-wise ordinary least squares of depth on -ln(-ln(1 - 1/T)). All seven source values required. Negative fitted depths are set to zero. Slopes are unconstrained.',
        } }),
        products: Object.fromEntries(products.map(product => [product.name, product.summary])),
        periodsWithoutValidData: [],
      };
      for (const product of products) {
        const period = Number(product.name.match(/^RP(\d+)_depth$/)[1]);
        const method = targets.includes(period)
          ? (period > inputs.at(-1) ? 'Gumbel extrapolation' : 'Gumbel interpolation') : 'GloFAS';
        report.products[product.name].method = method;
        if (!product.summary.validCells) {
          report.periodsWithoutValidData.push(period);
          continue;
        }
        const url = URL.createObjectURL(new Blob([product.tiff], { type: 'image/tiff' }));
        const label = period.toLocaleString() + '-year · ' + method;
        outputs.push({ ...product, label, url });
        appendRasterCard(field('cards'), product, {
          grid: report.grid,
          ...report.grid.dimensions, label, url, filename: 'flood_' + period + 'yr_aligned.tif',
        });
      }
      field('report').disabled = false;
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
  options.addEventListener('change', () => { clear(); message(''); refresh(); });
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
  return { setSource, refresh, getProducts: () => outputs };
}
