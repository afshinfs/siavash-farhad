/** Exposure requests share the satellite transport and aligned raster export worker. */
function createExposurePanel({ element, readConnection }) {
  const field = name => element('exp-' + name);
  let source = null;
  let job = null;
  let outputs = [];
  let report = null;
  let urls = [];

  function message(text, error = false) {
    field('status').textContent = text;
    field('status').classList.toggle('error', error);
  }
  function refresh() {
    const connected = Boolean(readConnection().accessToken);
    field('run').disabled = !source || !connected || Boolean(job);
    field('cancel').disabled = !job;
    field('options').disabled = Boolean(job);
    field('auth').textContent = connected ? 'Using the Earth Engine connection above.' : 'Connect your Google account above to retrieve exposure layers.';
  }
  function clear() {
    urls.forEach(url => URL.revokeObjectURL(url));
    urls = [];
    outputs = [];
    report = null;
    for (const id of ['preview', 'downloads', 'layer']) field(id).replaceChildren();
    field('layer').disabled = true;
    field('report').disabled = true;
    field('result').textContent = '';
  }
  function stop() {
    const active = job;
    job = null;
    active?.controller.abort();
    active?.worker?.terminate();
    refresh();
  }
  function setSource(blob, info) {
    stop();
    clear();
    source = blob ? { blob, info } : null;
    field('source').textContent = blob ? 'DEM ready · ' + (info?.label || 'retrieved elevation') : 'Retrieve a DEM above or open a DEM here.';
    message('');
    refresh();
  }

  function showLayer() {
    const product = outputs.find(item => item.name === field('layer').value);
    if (!product) return;
    const { width, height } = report.grid.dimensions;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('aria-label', exposureProducts[product.name].label + ' raster preview');
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(product.preview), width, height), 0, 0);
    field('preview').replaceChildren(canvas);
    const { min, max, validCells, unit } = product.summary;
    field('result').textContent = validCells
      ? `${min.toPrecision(4)} to ${max.toPrecision(4)} ${unit} · ${validCells.toLocaleString()} valid cells`
      : 'No valid data on this DEM grid.';
  }
  function addProducts(products) {
    for (const product of products) {
      const { name, summary, tiff } = product;
      const { label } = exposureProducts[name];
      report.products[name] = summary;
      if (!summary.validCells) {
        report.warnings.push(label + ' has no valid data on the DEM grid.');
        continue;
      }
      outputs.push(product);
      field('layer').add(new Option(label, name));
      const url = URL.createObjectURL(new Blob([tiff], { type: 'image/tiff' }));
      urls.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = name + '_aligned.tif';
      link.textContent = 'Download ' + label;
      field('downloads').append(link);
    }
    field('layer').disabled = !outputs.length;
    showLayer();
  }

  function workerCall(active, data) {
    return new Promise((resolve, reject) => {
      const { worker } = active;
      const signal = active.controller.signal;
      const timer = setTimeout(() => {
        worker.terminate();
        finish(reject, Error('Exposure raster processing timed out.'));
      }, 30000);
      function finish(callback, value) {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        worker.onmessage = null;
        worker.onerror = null;
        callback(value);
      }
      function onAbort() { finish(reject, new DOMException('Cancelled', 'AbortError')); }
      worker.onmessage = ({ data: response }) => {
        if (response.type === 'error') finish(reject, Error(response.message));
        else finish(resolve, response);
      };
      worker.onerror = () => finish(reject, Error('The exposure raster worker could not load or decode the response.'));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      try { worker.postMessage(data, [data.buffer]); }
      catch (error) { finish(reject, error); }
    });
  }

  async function run() {
    if (!source || job) return;
    const settings = {
      groups: Array.from(field('options').querySelectorAll('[data-exposure-group]:checked'), option => option.dataset.exposureGroup),
      epoch: Number(field('epoch').value),
      viirsYear: Number(field('year').value),
      buildingSource: field('buildings').value,
    };
    let requests;
    try { requests = exposureRequests(settings); }
    catch (error) { message(error.message, true); return; }

    clear();
    const active = { controller: new AbortController(), worker: null };
    job = active;
    refresh();
    const signal = active.controller.signal;
    const connection = readConnection();
    try {
      message('Reading the DEM grid…');
      const buffer = await source.blob.arrayBuffer();
      if (signal.aborted) return;
      const units = Object.fromEntries(Object.entries(exposureProducts).map(([name, product]) => [name, product.unit]));
      const code = '(' + satelliteWorkerMain.toString() + ')(' + decodeExposureLayers.toString() + ',{},{},' + JSON.stringify(units) + ');';
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { active.worker = new Worker(url); }
      finally { URL.revokeObjectURL(url); }
      const prepared = await workerCall(active, { action: 'prepare', buffer });
      if (signal.aborted) return;
      report = {
        schemaVersion: 1,
        stage: 'exposure',
        status: 'running',
        source: source.info,
        sourceSHA256: prepared.sourceSHA256,
        grid: prepared.grid,
        demValidCells: prepared.validCells,
        settings,
        datasets: {},
        products: {},
        warnings: [],
      };
      const { scaleX } = prepared.grid.affineTransform;
      for (const request of requests) {
        if (signal.aborted) return;
        const dataset = report.datasets[request.key] = { asset: request.asset };
        const template = exposureGraphs[request.key];
        const fill = graph => fillExposureGraph(graph, request, settings.viirsYear, prepared);
        try {
          if (request.key === 'proxy' && scaleX < 10) throw Error('The GHSL building proxy requires a DEM grid with cells of at least 10 m.');
          message('Retrieving ' + request.label + '…');
          if (template.audit) {
            dataset.audit = await requestSatellite({ ...connection, expression: fill(template.audit), signal });
            checkExposureAudit(request.key, dataset.audit);
          }
          const pixels = await requestSatellite({
            ...connection, signal, expression: fill(template.expression),
            grid: prepared.grid, bands: template.bands,
          });
          if (signal.aborted) return;
          const result = await workerCall(active, { action: 'product', group: request.key, buffer: pixels, bands: template.bands });
          if (signal.aborted) return;
          addProducts(result.products);
          dataset.status = result.products.some(product => product.summary.validCells) ? 'retrieved' : 'no_data';
        } catch (error) {
          if (signal.aborted) return;
          dataset.status = 'failed';
          dataset.error = error.message;
          report.warnings.push(request.label + '. ' + error.message);
        }
      }
      report.status = outputs.length ? (report.warnings.length ? 'partial' : 'completed') : 'failed';
      field('report').disabled = false;
      message([outputs.length + ' exposure rasters ready.', ...report.warnings].join(' '), !outputs.length);
    } catch (error) {
      if (!signal.aborted) message(error.message, true);
    } finally {
      if (job === active) stop();
    }
  }

  field('file').addEventListener('change', event => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { message('Use a DEM no larger than 8 MB.', true); return; }
    setSource(file, { kind: 'local file', label: file.name });
    event.target.value = '';
  });
  field('run').addEventListener('click', run);
  field('cancel').addEventListener('click', () => {
    stop();
    if (report) { report.status = 'cancelled'; field('report').disabled = false; }
    message(outputs.length ? 'Retrieval cancelled. Completed layers are available below.' : 'Retrieval cancelled.');
  });
  field('options').addEventListener('change', () => { clear(); message(''); });
  field('layer').addEventListener('change', showLayer);
  field('report').addEventListener('click', () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'siavash-exposure-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return { refresh, setSource };
}
