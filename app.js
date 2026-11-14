const labels = {
  runtime: 'Load Python in a background worker',
  packages: 'Load NumPy, SciPy, scikit-learn, XGBoost and Rasterio',
  reference: 'Import the original SIAVASH ML helpers',
  raster: 'Round-trip a GeoTIFF: pixels, CRS, transform and nodata',
  ml: 'Train and predict with XGBoost using spatial group folds',
  persistence: 'Save and reload the trained model',
};
const $ = (id) => document.getElementById(id);
let worker, timer, report, rasterURL, started = 0, beats = 0, checkStates = {};
function resetRows() {
  $('checks').replaceChildren();
  for (const [id, label] of Object.entries(labels)) {
    const row = document.createElement('li'); row.id = `check-${id}`;
    const icon = document.createElement('span'); icon.className = 'symbol'; icon.textContent = '○';
    const title = document.createElement('span'); title.className = 'label'; title.textContent = label;
    const result = document.createElement('span'); result.className = 'result'; result.textContent = 'Waiting';
    row.append(icon, title, result); $('checks').append(row);
  }
}
function rowState(id, state, detail = '') {
  const row = $(`check-${id}`); if (!row) return;
  checkStates[id] = {status:state,detail};
  row.className = state;
  row.querySelector('.symbol').textContent = ({pass:'✓', fail:'×', running:'…', cancelled:'—'})[state] || '○';
  row.querySelector('.result').textContent = detail || state;
}
function log(message) {
  const lines = ($('log').textContent + `${message}\n`).split('\n');
  $('log').textContent = lines.slice(-120).join('\n');
}
function stop() {
  clearInterval(timer); worker?.terminate(); worker = null;
  $('run').disabled = false; $('cancel').disabled = true;
}
function finish(result) {
  result.checks = {...checkStates,...(result.checks || {})};
  if (result.status !== 'passed') {
    for (const id of Object.keys(labels)) {
      if (!result.checks[id] || result.checks[id].status === 'running') result.checks[id] = {status:'skipped',detail:'Not completed'};
    }
  }
  report = {...result, client: {userAgent:navigator.userAgent, hardwareConcurrency:navigator.hardwareConcurrency ?? null,
    deviceMemoryGiB:navigator.deviceMemory ?? null, uiHeartbeats:beats, wallSeconds:(performance.now()-started)/1000}};
  $('status').textContent = report.status === 'passed' ? 'Checks passed' : report.status === 'cancelled' ? 'Cancelled' : 'Checks failed';
  for (const [id, value] of Object.entries(report.checks || {})) rowState(id, value.status, value.detail);
  $('report').textContent = JSON.stringify(report,null,2);
  if (report.error) { log(report.error); $('report-details').open = true; }
  $('download').disabled = false; stop();
}
$('run').addEventListener('click', () => {
  report = null; beats = 0; checkStates = {}; $('report').textContent='Checks in progress…'; $('report-details').open=false; $('elapsed').textContent='0.0 s'; $('heartbeat').textContent='0'; resetRows(); $('log').textContent = '';
  if (rasterURL) URL.revokeObjectURL(rasterURL); rasterURL = null;
  $('raster').hidden = true; $('download').disabled = true; $('run').disabled = true; $('cancel').disabled = false;
  $('status').textContent = 'Running checks…'; started = performance.now();
  timer = setInterval(() => {
    beats += 1; $('heartbeat').textContent = String(beats);
    $('elapsed').textContent = `${((performance.now()-started)/1000).toFixed(1)} s`;
    if (performance.now()-started > 600000) {
      finish({status:'failed', error:'Ten-minute limit reached. Retry on a faster connection/device.', checks:{}});
    }
  }, 100);
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), {type:'module'});
    worker.onmessage = ({data}) => {
      if (data.type === 'progress') {rowState(data.id, data.status, data.detail); log(`${data.id}: ${data.detail || data.status}`);}
      if (data.type === 'log') log(data.message);
      if (data.type === 'complete') {
        if (data.raster) {rasterURL = URL.createObjectURL(new Blob([data.raster], {type:'image/tiff'})); $('raster').href = rasterURL; $('raster').hidden = false;}
        finish(data.report);
      }
    };
    worker.onerror = (event) => {const active=Object.keys(checkStates).find(id=>checkStates[id].status==='running') || 'runtime'; rowState(active,'fail','Worker stopped unexpectedly'); log(event.message || 'Worker failed to start; check that all static assets are served.'); finish({status:'failed',error:event.message || 'Worker failed',checks:{}});};
    worker.postMessage({type:'run'});
  } catch (error) {log(error.message);finish({status:'failed',error:error.message,checks:{}});}
});
$('cancel').addEventListener('click', () => {
  const checks = {};
  for (const id of Object.keys(labels)) {
    const row = $(`check-${id}`);
    checks[id] = {status: row.className === 'pass' ? 'pass' : 'cancelled', detail:row.className === 'pass' ? 'Passed' : 'Cancelled'};
  }
  log('Cancelled. The worker and its in-memory files were discarded.');
  finish({status:'cancelled',checks,limitations:['Incomplete run; no compatibility conclusion.']});
});
$('download').addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const a = document.createElement('a'); a.href=url;a.download='siavash-farhad-browser-feasibility.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
resetRows();
