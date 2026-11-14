// Fixed, version-pinned runtime. No arbitrary code is accepted from page messages.
const VERSION = '314.0.8';
const INDEX = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/`;
let busy = false;
self.onmessage = async ({data}) => {
  if (data?.type !== 'run' || busy) return;
  busy = true;
  const report = {schemaVersion:1, status:'running', runtime:VERSION, startedAt:new Date().toISOString(), checks:{},
    fixture:'Deterministic synthetic 64x64 grid, seed 42; not real flood data',
    limitations:[
      'This is a runtime smoke test, not validation of SIAVASH flood accuracy or full workflow equivalence.',
      'No Earth Engine connection, RichDEM terrain processing, weakline, velocity or full hazard/risk workflow is tested.',
      'Single-worker, single-job execution; full tuning and large AOIs are not benchmarked.',
      'Synthetic spatial cross-validation scores are diagnostics only.',
      'Memory sizes are input array estimates, not peak browser or WebAssembly memory.',
    ]};
  let current = 'runtime', py;
  const stageTimes = {};
  const began = performance.now();
  const update = (id,status,detail) => {
    current=id;
    if (status === 'running') stageTimes[id] = performance.now();
    report.checks[id]={status,detail};
    if (stageTimes[id] && status !== 'running') report.checks[id].seconds=(performance.now()-stageTimes[id])/1000; self.postMessage({type:'progress',id,status,detail});
  };
  try {
    update('runtime','running','Downloading runtime');
    const {loadPyodide} = await import(`${INDEX}pyodide.mjs`);
    py = await loadPyodide({indexURL:INDEX, stdout:m=>self.postMessage({type:'log',message:m}), stderr:m=>self.postMessage({type:'log',message:m})});
    report.runtimeActual = py.runPython('import pyodide; pyodide.__version__');
    update('runtime','pass',`Python ${py.runPython('import sys; sys.version.split()[0]')}`);
    update('packages','running','Downloading scientific packages');
    await py.loadPackage(['numpy','scipy','scikit-learn','xgboost','rasterio'], {messageCallback:m=>self.postMessage({type:'log',message:m})});
    py.runPython('import os; os.environ["GDAL_DISABLE_READDIR_ON_OPEN"]="EMPTY_DIR"; os.environ["GDAL_NUM_THREADS"]="1"');
    report.gdalOptions = {GDAL_DISABLE_READDIR_ON_OPEN:'EMPTY_DIR',GDAL_NUM_THREADS:'1'};
    report.versions = JSON.parse(py.runPython('import json, numpy, scipy, sklearn, xgboost, rasterio; json.dumps({"numpy":numpy.__version__,"scipy":scipy.__version__,"sklearn":sklearn.__version__,"xgboost":xgboost.__version__,"rasterio":rasterio.__version__})'));
    update('packages','pass','Five packages imported');
    update('reference','running','Loading original ml.py');
    const originalResponse=await fetch(new URL('./ml.py',import.meta.url));
    if (!originalResponse.ok) throw new Error(`ML source retrieval failed: ${originalResponse.status}`);
    const source = await originalResponse.text();
    const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
    report.referenceSourceSHA256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
    py.FS.writeFile('/reference_ml.py',source);
    py.runPython(`import importlib.util, sys
spec=importlib.util.spec_from_file_location("reference_ml", "/reference_ml.py")
reference=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=reference
spec.loader.exec_module(reference)`);
    update('reference','pass','Original helpers imported');
    const response=await fetch(new URL('./checks.py',import.meta.url));
    if (!response.ok) throw new Error(`Test code retrieval failed: ${response.status}`);
    py.globals.set('notify_js',(id,status,detail)=>update(id,status,detail));
    const checksSource = await response.text();
    const checksHash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(checksSource));
    report.checksSourceSHA256=Array.from(new Uint8Array(checksHash),v=>v.toString(16).padStart(2,'0')).join('');
    py.runPython(checksSource);
    report.results = JSON.parse(await py.runPythonAsync('json.dumps(run_checks(notify_js), allow_nan=False)'));
    report.status='passed';
    report.finishedAt=new Date().toISOString(); report.totalSeconds=(performance.now()-began)/1000;
    const raster=py.FS.readFile('/synthetic-prediction.tif');
    self.postMessage({type:'complete',report,raster:raster.buffer},[raster.buffer]);
  } catch (error) {
    update(current,'fail',String(error.message || error).slice(-1200));
    report.status='failed';report.error=String(error.stack || error);
    report.finishedAt=new Date().toISOString(); report.totalSeconds=(performance.now()-began)/1000;
    self.postMessage({type:'complete',report});
  } finally {busy=false;}
};
