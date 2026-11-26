const version = '314.0.8';
const indexURL = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

async function readSource(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw Error(`Could not load ${path} (HTTP ${response.status}).`);
  return response.text();
}

self.onmessage = async ({ data }) => {
  const progress = message => self.postMessage({ type: 'progress', message });
  try {
    progress('Loading Python and XGBoost. The first run downloads the browser runtime.');
    const [{ loadPyodide }, helpers, program] = await Promise.all([
      import(indexURL + 'pyodide.mjs'), readSource('./ml.py?v=desktop-training'), readSource('./train-depth.py?v=automatic-folds'),
    ]);
    const py = await loadPyodide({ indexURL });
    await py.loadPackage(['numpy', 'scipy', 'scikit-learn', 'xgboost', 'rasterio']);
    py.FS.writeFile('/ml.py', helpers);
    py.FS.mkdir('/training');
    py.FS.writeFile('/training/dem.tif', new Uint8Array(data.dem));
    for (const { name, raster } of data.entries) {
      if (!/^[a-zA-Z0-9_]+$/.test(name)) throw Error('Unexpected raster name.');
      const buffer = raster instanceof Blob ? await raster.arrayBuffer() : raster;
      py.FS.writeFile('/training/' + name + '.tif', new Uint8Array(buffer));
    }
    progress('Reading model inputs on the DEM grid…');
    py.globals.set('training_config', JSON.stringify(data.config));
    py.globals.set('training_progress', progress);
    py.runPython(`import os, sys, json
os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
os.environ["GDAL_NUM_THREADS"] = "1"
sys.path.insert(0, "/")`);
    py.runPython(program);
    const report = JSON.parse(await py.runPythonAsync(`
config = json.loads(training_config)
json.dumps(train_depth_models("/training", config["predictors"], config["targets"],
                             config["blockSize"], training_progress, fold_count=config["foldCount"], cv_mode=config["cvMode"]), allow_nan=False)
`));
    const exports = [];
    const transfer = [];
    const analysisDepths = {};
    for (const { period } of report.results) {
      const analysis = py.FS.readFile(`/training/xgb_analysis_${period}.tif`).buffer;
      analysisDepths[period] = analysis;
      transfer.push(analysis);
      for (const [kind, filename] of [['depth', `xgb_depth_${period}.tif`], ['model', `xgb_model_${period}.json`]]) {
        const { buffer } = py.FS.readFile('/training/' + filename);
        exports.push({ period, kind, filename, buffer });
        transfer.push(buffer);
      }
    }
    self.postMessage({ type: 'complete', report: { ...report, runtime: version }, exports, analysisDepths }, transfer);
  } catch (error) {
    const detail = String(error.message || error).trim().split('\n').at(-1);
    self.postMessage({ type: 'error', message: detail.slice(0, 500) });
  }
};
