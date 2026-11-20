const predictors = {
  dem_filled: 'Filled DEM', twi: 'TWI', logflowacc: 'Log flow accumulation', flowacc: 'Flow accumulation',
  slope: 'Slope', aspect: 'Aspect', trasp: 'TRASP', plan_curvature: 'Planform curvature',
  road_distance: 'Distance to major roads', river_distance: 'Distance to rivers', river_density: 'River density',
  manning: 'Manning n', ndvi: 'NDVI', rainfall: 'Accumulated rainfall', spi_proxy: 'Precipitation anomaly',
  hsg_proxy: 'Hydrologic soil group', merit_hnd: 'MERIT adjusted elevation',
};
const targetPeriods = [30, 100, 300, 1000];
const depths = Object.fromEntries(targetPeriods.map(period => ['RP' + period + '_depth', period]));
const expected = [...Object.keys(predictors), ...Object.keys(depths)];

function localLayerName(filename) {
  const name = filename.toLowerCase().replace(/\.tiff?$/, '').replace(/_aligned$/, '');
  const period = name.match(/^flood_(30|100|300|1000)yr$/);
  if (period) return 'RP' + period[1] + '_depth';
  if (/^manning_(2020|2021)$/.test(name)) return 'manning';
  if (/^spi(?:3m_[0-9]{6})?$/.test(name)) return 'spi_proxy';
  return ({ hand: 'merit_hnd', hsg: 'hsg_proxy' })[name] ?? name;
}

// Runs inside the GeoTIFF worker against the same DEM used for alignment.
export async function auditRasterStack({ predictorNames, targets, entries, blockSize, wetThreshold }, template, readAlignedRaster) {
  const fittingMask = template.mask.slice();
  const layerResults = [];
  const targetMasks = new Map();
  for (const entry of entries) {
    const row = { name: entry.name, source: entry.source, validCells: null, status: 'missing' };
    layerResults.push(row);
    if (!entry.raster) continue;
    try {
      const { values, nodata } = await readAlignedRaster(entry.raster);
      const isTarget = Object.hasOwn(targets, entry.name);
      const mask = Uint8Array.from(values, (value, i) => (
        template.mask[i] && Number.isFinite(value) && value !== nodata && (!isTarget || value >= 0)
      ));
      row.validCells = mask.reduce((count, valid) => count + valid, 0);
      row.status = row.validCells ? 'valid' : 'empty';
      if (isTarget) {
        let negativeCells = 0;
        for (let i = 0; i < values.length; i++) {
          if (template.mask[i] && values[i] !== nodata && Number.isFinite(values[i]) && values[i] < 0) negativeCells++;
        }
        row.negativeDepthCells = negativeCells;
        if (negativeCells) row.status = 'negative depth';
        targetMasks.set(entry.name, { mask, values });
      } else {
        for (let i = 0; i < mask.length; i++) fittingMask[i] &= mask[i];
      }
    } catch (error) {
      row.status = 'invalid';
      row.error = error.message;
    }
  }
  const allPredictorsValid = layerResults
    .filter(layer => predictorNames.includes(layer.name))
    .every(layer => layer.status === 'valid');
  const predictorCells = allPredictorsValid ? fittingMask.reduce((count, value) => count + value, 0) : null;
  const blocksPerRow = Math.ceil(template.width / blockSize);
  const targetResults = Object.entries(targets).map(([name, period]) => {
    const row = layerResults.find(layer => layer.name === name);
    const result = { period, referenceCells: row.validCells, usableCells: null, wetCells: null, occupiedBlocks: null, status: row.status };
    if (row.status !== 'valid') return result;
    if (!allPredictorsValid) return { ...result, status: 'predictors incomplete' };
    const { mask, values } = targetMasks.get(name);
    let usableCells = 0;
    let wetCells = 0;
    const blocks = new Set();
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || !fittingMask[i]) continue;
      usableCells++;
      if (values[i] >= wetThreshold) wetCells++;
      const blockRow = Math.floor(Math.floor(i / template.width) / blockSize);
      const blockColumn = Math.floor((i % template.width) / blockSize);
      blocks.add(blockRow * blocksPerRow + blockColumn);
    }
    return { ...result, usableCells, wetCells, occupiedBlocks: blocks.size, status: usableCells ? 'valid' : 'no overlap' };
  });
  return { layers: layerResults, predictorCells, targetResults, passed: targetResults.every(result => result.status === 'valid') };
}

export function createMLStackPanel({ element, readSession, rasterWorker, callWorker }) {
  const field = name => element('ml-stack-' + name);
  const blockSize = 40;
  const wetThreshold = Math.fround(0.05);
  let localDEM = null;
  let localLayers = new Map();
  let current = null;
  let report = null;
  let checkedInputs = null;
  let trainingReport = null;
  const exportURLs = [];

  function message(text, error = false) {
    field('status').textContent = text;
    field('status').classList.toggle('error', error);
  }
  function refresh() {
    const { dem } = readSession();
    field('source').textContent = localDEM ? 'Local DEM · ' + localDEM.name
      : dem ? 'Using the current WebGIS DEM.' : 'Retrieve a DEM above or open a local DEM here.';
    field('train').disabled = Boolean(current) || !report?.passed ||
      report.targetResults.some(target => target.occupiedBlocks < 5);
    field('run').disabled = Boolean(current) || !(localDEM || dem);
    field('cancel').disabled = !current;
    field('cancel').textContent = current?.training ? 'Cancel training' : 'Cancel check';
    field('clear').disabled = Boolean(current) || !(localDEM || localLayers.size);
    field('dem').disabled = Boolean(current);
    field('layers').disabled = Boolean(current);
  }
  function trainingMessage(text, error = false) {
    field('training-status').textContent = text;
    field('training-status').classList.toggle('error', error);
  }
  function clearTraining() {
    exportURLs.splice(0).forEach(url => URL.revokeObjectURL(url));
    trainingReport = null;
    field('models').replaceChildren();
    field('training-report').disabled = true;
    field('training-results').hidden = true;
    trainingMessage('');
  }
  function invalidate() {
    current?.controller.abort();
    current?.worker?.terminate();
    current = null;
    if (report) message('Inputs changed. Run the check again.');
    report = null;
    checkedInputs = null;
    clearTraining();
    field('report').disabled = true;
    field('results').hidden = true;
    refresh();
  }
  function appendRow(tableBody, values) {
    const row = tableBody.insertRow();
    for (const value of values) row.insertCell().textContent = value ?? '—';
    return row;
  }
  function showReport() {
    const targets = field('targets');
    const layers = field('layer-results');
    const format = value => value?.toLocaleString();
    targets.replaceChildren();
    layers.replaceChildren();
    for (const result of report.targetResults) {
      appendRow(targets, [result.period.toLocaleString(), format(result.referenceCells),
        format(result.usableCells), format(result.wetCells), format(result.occupiedBlocks), result.status]);
    }
    for (const result of report.layers) {
      appendRow(layers, [predictors[result.name] ?? depths[result.name].toLocaleString() + '-year depth',
        result.source, format(result.validCells), result.error ? result.status + ' · ' + result.error : result.status]);
    }
    field('summary').textContent = report.predictorCells === null ? 'Complete the predictor stack to calculate joint coverage.'
      : 'Complete predictor coverage: ' + format(report.predictorCells) + ' of ' + format(report.demCells) + ' valid DEM cells.';
    field('results').hidden = false;
    field('report').disabled = false;
    const sparse = report.targetResults.filter(result => result.occupiedBlocks !== null && result.occupiedBlocks < 5);
    const cv = sparse.length ? ' Fewer than five occupied 40-cell blocks for these periods: ' +
      sparse.map(result => result.period.toLocaleString()).join(', ') + ' years.' : '';
    message((report.passed ? 'Raster-stack check passed.' : 'Raster-stack check found issues. Review the results below.') + cv, !report.passed);
  }

  async function run() {
    if (current) return;
    invalidate();
    const { dem, layers } = readSession();
    const source = localDEM ?? dem;
    if (!source) return;
    const entries = expected.map(name => {
      const file = localLayers.get(name);
      const product = layers.find(layer => layer.name === name);
      return { name, raster: file ?? product?.tiff, source: file?.name ?? (product ? 'Current WebGIS session' : null) };
    });
    const job = { controller: new AbortController(), worker: null };
    current = job;
    refresh();
    message('Reading DEM and aligned GeoTIFFs…');
    try {
      const buffer = await source.arrayBuffer();
      if (current !== job) return;
      const code = '(' + rasterWorker.toString() + ')(null, {}, {}, {}, ' + auditRasterStack.toString() + ');';
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { job.worker = new Worker(url); }
      finally { URL.revokeObjectURL(url); }
      const prepared = await callWorker(job, { action: 'prepare', buffer }, 'Raster-stack');
      const result = await callWorker(job, {
        action: 'auditStack', entries, predictorNames: Object.keys(predictors), targets: depths, blockSize, wetThreshold,
      }, 'Raster-stack');
      if (current !== job) return;
      report = {
        schemaVersion: 1, stage: 'XGBoost input check', checkedAt: new Date().toISOString(),
        demSource: localDEM?.name ?? 'Current WebGIS DEM', demSHA256: prepared.sourceSHA256, grid: prepared.grid,
        demCells: prepared.validCells, blockSizeCells: blockSize, wetThresholdM: 0.05, ...result,
      };
      checkedInputs = { source, entries };
      showReport();
    } catch (error) {
      if (current === job) message(error.message, true);
    } finally {
      if (current === job) {
        job.worker?.terminate();
        current = null;
        refresh();
      }
    }
  }
  function showTraining(result) {
    trainingReport = { ...result.report, demSHA256: report.demSHA256, grid: report.grid,
      layers: report.layers, completedAt: new Date().toISOString() };
    for (const values of trainingReport.results) {
      const row = appendRow(field('models'), [values.period.toLocaleString(), values.targetCells.toLocaleString(),
        values.outOfFold.rmseM.toFixed(3), values.outOfFold.r2?.toFixed(3), values.wetPredictionCells.toLocaleString()]);
      const cell = row.insertCell();
      for (const item of result.exports.filter(item => item.period === values.period)) {
        const link = document.createElement('a');
        link.textContent = item.kind === 'depth' ? 'Depth GeoTIFF' : 'Model JSON';
        link.download = item.filename;
        link.href = URL.createObjectURL(new Blob([item.buffer], { type: item.kind === 'depth' ? 'image/tiff' : 'application/json' }));
        exportURLs.push(link.href);
        if (cell.childNodes.length) cell.append(' · ');
        cell.append(link);
      }
    }
    field('training-results').hidden = false;
    field('training-report').disabled = false;
    trainingMessage('Four depth models trained. GeoTIFFs and model files are ready.');
  }

  async function train() {
    if (field('train').disabled || !checkedInputs) return;
    clearTraining();
    const { source, entries } = checkedInputs;
    const job = { controller: new AbortController(), worker: null, training: true };
    current = job;
    refresh();
    trainingMessage('Preparing the checked raster inputs…');
    try {
      const dem = await source.arrayBuffer();
      if (current !== job) return;
      const worker = new Worker(new URL('./depth-training-worker.js?v=1', import.meta.url), { type: 'module' });
      job.worker = worker;
      function finish(error, result) {
        if (current !== job) return;
        worker.terminate();
        current = null;
        refresh();
        if (error) trainingMessage(error, true);
        else showTraining(result);
      }
      worker.onmessage = ({ data }) => {
        if (current !== job) return;
        if (data.type === 'progress') trainingMessage(data.message);
        else if (data.type === 'error') finish(data.message);
        else if (data.type === 'complete') finish(null, data);
      };
      worker.onerror = () => finish('The training worker could not load. Check your connection and try again.');
      worker.postMessage({
        dem, entries: entries.map(({name, raster}) => ({name, raster})),
        config: { blockSize, predictors: Object.keys(predictors),
          targets: Object.entries(depths).map(([name, period]) => ({name, period})) },
      }, [dem]);
    } catch (error) {
      if (current !== job) return;
      job.worker?.terminate();
      current = null;
      refresh();
      trainingMessage(error.message, true);
    }
  }

  field('train').addEventListener('click', train);
  field('run').addEventListener('click', run);
  field('cancel').addEventListener('click', () => {
    if (current?.training) {
      current.worker?.terminate();
      current = null;
      refresh();
      trainingMessage('Training cancelled. The raster-stack check is still available.');
    } else {
      invalidate();
      message('Raster-stack check cancelled.');
    }
  });
  field('dem').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { message('Choose a DEM no larger than 8 MB.', true); return; }
    localDEM = file;
    invalidate();
    message('');
  });
  field('layers').addEventListener('change', event => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    if (!files.length) return;
    const selected = new Map(localLayers);
    const seen = new Set();
    const ignored = [];
    for (const file of files) {
      const key = localLayerName(file.name);
      if (!expected.includes(key)) { ignored.push(file.name); continue; }
      if (seen.has(key) || file.size > 8 * 1024 * 1024) {
        message('Choose one GeoTIFF per layer, up to 8 MB each. Check ' + file.name + '.', true);
        return;
      }
      seen.add(key);
      selected.set(key, file);
    }
    localLayers = selected;
    invalidate();
    message(localLayers.size + ' local layers selected.' +
      (ignored.length ? ' Unrecognised files: ' + ignored.join(', ') + '.' : ''));
  });
  field('clear').addEventListener('click', () => {
    localDEM = null;
    localLayers.clear();
    invalidate();
    message('Using the current WebGIS session.');
  });
  function downloadReport(data, filename) {
    if (!data) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  field('report').addEventListener('click', () => downloadReport(report, 'siavash-ml-raster-stack-report.json'));
  field('training-report').addEventListener('click', () => downloadReport(trainingReport, 'siavash-xgboost-training-report.json'));
  return { refresh, invalidate };
}
