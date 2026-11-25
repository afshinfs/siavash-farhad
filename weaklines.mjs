import { showStudyArea, rangeLegend } from './raster-cards.mjs?v=map-legends';
// Runs in the aligned raster worker. Raster vertices use DEM grid coordinates.
export function screenWeaklines({ width, height, dx, corridor, depthByPeriod, thresholdM, minimumM }) {
  const periods = Object.keys(depthByPeriod).map(Number).sort((a, b) => a - b);
  const stride = width + 1;
  const edges = new Map(periods.map(period => [period, []]));
  function addEdge(a, b, start, end) {
    if (corridor[a] < 0 || corridor[b] < 0 || corridor[a] === corridor[b]) return;
    for (const period of periods) {
      const depths = depthByPeriod[period];
      if (depths[a] > thresholdM || depths[b] > thresholdM) {
        edges.get(period).push({ start, end, cells: [a, b] });
        break;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x, vertex = y * stride + x;
      if (x + 1 < width) addEdge(i, i + 1, vertex + 1, vertex + 1 + stride);
      if (y + 1 < height) addEdge(i, i + width, vertex + stride, vertex + stride + 1);
    }
  }
  const candidates = [];
  for (const [period, items] of edges) {
    const adjoining = new Map();
    items.forEach(({ start, end }, id) => {
      for (const point of [start, end]) {
        if (!adjoining.has(point)) adjoining.set(point, []);
        adjoining.get(point).push(id);
      }
    });
    const visited = new Uint8Array(items.length);
    for (let i = 0; i < items.length; i++) {
      if (visited[i]) continue;
      const queue = [i], segments = [], cells = new Set(), expanded = new Set();
      visited[i] = 1;
      for (const edgeId of queue) {
        const edge = items[edgeId];
        segments.push([edge.start, edge.end]);
        edge.cells.forEach(cell => cells.add(cell));
        for (const point of [edge.start, edge.end]) {
          if (expanded.has(point)) continue;
          expanded.add(point);
          for (const next of adjoining.get(point)) {
            if (visited[next]) continue;
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
      const lengthM = segments.length * dx;
      if (lengthM >= minimumM) {
        candidates.push({ id: candidates.length + 1, period, lengthM, segments, cells: [...cells] });
      }
    }
  }
  return candidates;
}

// A paired priority flood on water-surface elevation. The same domain, river
// outlets and depth cap are used in both runs, with a raised wall in the closure.
export function compareWeaklineClosure({ width, height, dx, terrain, inputDepth, riverDistance, barrierCells, cap, scenarioOnly = false }) {
  const n = width * height;
  const valid = Uint8Array.from(terrain, (z, i) => Number.isFinite(z) &&
    Number.isFinite(inputDepth[i]) && inputDepth[i] >= 0);
  const barrier = new Uint8Array(n);
  for (const cell of barrierCells) barrier[cell] = valid[cell];
  if (!barrier.some(Boolean)) throw Error('The selected candidates have no valid depth cells for this period.');

  const directions = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
  function neighbours(i, visit) {
    const x = i % width, y = Math.floor(i / width);
    for (const [ox, oy] of directions) {
      const nx = x + ox, ny = y + oy;
      visit(nx >= 0 && nx < width && ny >= 0 && ny < height ? ny * width + nx : -1);
    }
  }
  function route(closed) {
    const surface = new Float64Array(n);
    const visited = new Uint8Array(n);
    const heap = [];
    function push(i) {
      let k = heap.length;
      heap.push(i);
      while (k > 0) {
        const parent = (k - 1) >> 1;
        if (surface[heap[parent]] <= surface[i]) break;
        heap[k] = heap[parent];
        k = parent;
      }
      heap[k] = i;
    }
    function pop() {
      const first = heap[0], last = heap.pop();
      if (heap.length) {
        let k = 0;
        while (2 * k + 1 < heap.length) {
          let child = 2 * k + 1;
          if (child + 1 < heap.length && surface[heap[child + 1]] < surface[heap[child]]) child++;
          if (surface[last] <= surface[heap[child]]) break;
          heap[k] = heap[child];
          k = child;
        }
        heap[k] = last;
      }
      return first;
    }
    for (let i = 0; i < n; i++) {
      if (!valid[i]) continue;
      const wall = closed && barrier[i];
      const river = !wall && riverDistance[i] === 0;
      surface[i] = wall ? terrain[i] + cap + 0.01 : river ? terrain[i] : terrain[i] + inputDepth[i];
      let outlet = river;
      neighbours(i, j => { if (j < 0 || !valid[j]) outlet = true; });
      if (outlet) {
        visited[i] = 1;
        push(i);
      }
    }
    while (heap.length) {
      const i = pop();
      neighbours(i, j => {
        if (j < 0 || !valid[j] || visited[j]) return;
        visited[j] = 1;
        surface[j] = Math.max(surface[j], surface[i]);
        push(j);
      });
    }
    return Float32Array.from(surface, (value, i) =>
      valid[i] && !barrier[i] ? Math.min(cap, Math.max(0, value - terrain[i])) : NaN);
  }
  const closure = route(true);
  if (scenarioOnly) return closure;
  const baseline = route(false);
  const difference = new Float32Array(n).fill(NaN);
  let comparedCells = 0, baselineWet = 0, closureWet = 0, deeper = 0, shallower = 0;
  let excludedBarrierCells = 0, baselineVolume = 0, closureVolume = 0;
  const wet = Math.fround(0.05);
  for (let i = 0; i < n; i++) {
    if (barrier[i]) excludedBarrierCells++;
    if (!Number.isFinite(baseline[i])) continue;
    comparedCells++;
    const delta = closure[i] - baseline[i];
    difference[i] = delta;
    baselineWet += Number(baseline[i] >= wet);
    closureWet += Number(closure[i] >= wet);
    deeper += Number(delta > 0.001);
    shallower += Number(delta < -0.001);
    baselineVolume += baseline[i] * dx * dx;
    closureVolume += closure[i] * dx * dx;
  }
  if (!comparedCells) throw Error('The closure footprint covers every valid comparison cell.');
  return { baseline, closure, difference, metrics: {
    comparedCells, excludedBarrierCells, baselineWetAreaM2: baselineWet * dx * dx,
    closureWetAreaM2: closureWet * dx * dx, baselineVolumeM3: baselineVolume,
    closureVolumeM3: closureVolume, deeperCells: deeper, shallowerCells: shallower,
  } };
}

// The empty subset is the original open baseline. Every other subset closes
// exactly the listed lines and leaves the remaining lines open.
export function runWeaklineScenarios({ candidates, inputDepth, terrain, riverDistance, population, width, height, dx, exhaustive, progress }, route) {
  const eligible = candidates.filter(line => line.cells.some(i => Number.isFinite(terrain[i]) && inputDepth[i] > 0));
  const maskKeys = new Set();
  const scenarios = [];
  const envelope = inputDepth.slice();
  let winner = null, worst = null, duplicateMasks = 0, skipped = 0;
  const validCells = terrain.reduce((count, z, i) => count + Number(Number.isFinite(z) && Number.isFinite(inputDepth[i])), 0);
  let lastProgress = Date.now();
  const cap = inputDepth.reduce((max, depth) => Number.isFinite(depth) ? Math.max(max, depth) : max, 0) + 2;
  const totalPossible = (2n ** BigInt(eligible.length) - 1n).toString();
  function score(depth) {
    let total = 0;
    for (let i = 0; i < depth.length; i++) {
      if (Number.isFinite(depth[i])) total += depth[i] * (population ? (Number.isFinite(population[i]) ? population[i] : 0) : dx * dx);
    }
    return total;
  }
  function evaluate(lines) {
    if (Date.now() - lastProgress >= 1000) {
      progress(scenarios.length, totalPossible);
      lastProgress = Date.now();
    }
    const cells = [...new Set(lines.flatMap(line => line.cells)
      .filter(i => Number.isFinite(terrain[i]) && Number.isFinite(inputDepth[i])))].sort((a, b) => a - b);
    const key = cells.join(',');
    if (maskKeys.has(key)) { duplicateMasks++; return; }
    maskKeys.add(key);
    if (cells.length >= validCells) {
      skipped++;
      return;
    }
    const routed = route({ width, height, terrain, inputDepth, riverDistance, barrierCells: cells, cap, scenarioOnly: true });
    // Retain open depths where closure routing does not report a value,
    // including the artificial barrier footprint. Score each on the same grid.
    const depth = routed.map((value, i) => Number.isFinite(value) ? value : inputDepth[i]);
    for (let i = 0; i < depth.length; i++) if (depth[i] > envelope[i]) envelope[i] = depth[i];
    const row = { closed: lines.map(line => line.id), score: score(depth) };
    scenarios.push(row);
    if (!winner || row.score > winner.score) { winner = row; worst = depth; }

  }
  function* subsets(start, remaining, prefix = []) {
    if (!remaining) { yield prefix; return; }
    for (let i = start; i <= eligible.length - remaining; i++) {
      yield* subsets(i + 1, remaining - 1, [...prefix, eligible[i]]);
    }
  }
  if (exhaustive) {
    for (let length = 1; length <= eligible.length; length++) {
      for (const lines of subsets(0, length)) evaluate(lines);
    }
  } else {
    for (const line of eligible) evaluate([line]);
    for (let length = 2; length <= eligible.length; length++) evaluate(eligible.slice(0, length));
    let mixed = 0;
    for (const length of [2, 3]) {
      for (const lines of subsets(0, length)) {
        if (mixed >= 200) break;
        const before = scenarios.length;
        evaluate(lines);
        if (scenarios.length > before) mixed++;
      }
    }
  }
  return { envelope, worst, report: { totalPossible, eligible: eligible.map(line => line.id), tested: scenarios.length,
    duplicateMasks, skipped, baselineScore: score(inputDepth), winner, scenarios } };
}

export function createWeaklinePanel({ element, readInputs, rasterWorker, callWorker, onClosureChange }) {
  const field = name => element('weakline-' + name);
  const periods = [30, 100, 300, 1000];
  const colors = { 30: '#a52935', 100: '#a65c00', 300: '#166879', 1000: '#61439a' };
  let active = null, result = null, comparison = null, batchOutput = null, map = null, overlay = null;
  const selected = new Set();
  const urls = [];

  function sourceInputs() {
    const inputs = readInputs();
    const predicted = field('source').value === 'trained';
    const method = field('method').value;
    const localDepth25 = field('depth25').files[0];
    return {
      ...inputs, method, predicted,
      reference: method === 'depth25' ? localDepth25 ?? inputs.fittedDepth25 : inputs.riverDistance,
      referenceSource: method === 'depth25'
        ? (localDepth25 ? 'Local 25-year depth GeoTIFF' : 'GloFAS Gumbel interpolation') : 'River distance',
      depths: predicted ? inputs.trainedDepths : inputs.referenceDepths,
    };
  }
  function refresh() {
    const { dem, method, reference, depths, terrain } = sourceInputs();
    const waiting = !dem ? 'Provide a DEM under Study area or Depth models.'
      : !reference ? method === 'depth25' ? 'Enable the Gumbel fit under GloFAS reference depths, or choose an aligned 25-year GeoTIFF here.'
        : 'Calculate river distance under Predictors or open an aligned river_distance GeoTIFF under Depth models.'
      : !periods.every(period => depths?.[period]) ? 'Provide all four depth rasters for the selected source.'
      : '';
    const selectedCandidates = result?.candidates.filter(candidate => selected.has(candidate.id)) ?? [];
    const period = Number(field('period').value);
    const tooEarly = selectedCandidates.some(candidate => candidate.period > period);
    field('ready').textContent = waiting || (method === 'depth25'
      ? 'Using ' + (reference instanceof File ? reference.name : 'the fitted 25-year depth from GloFAS') + '.' : '');
    field('buffer').disabled = Boolean(active) || method !== 'river';
    field('depth25').disabled = Boolean(active) || method !== 'depth25';
    field('footprint-threshold').disabled = Boolean(active) || method !== 'depth25';
    for (const name of ['source', 'method', 'threshold', 'minimum', 'period', 'candidate']) {
      field(name).disabled = Boolean(active);
    }
    field('run').disabled = Boolean(active) || Boolean(waiting);
    field('cancel').disabled = !active;
    field('batch').disabled = Boolean(active) || !terrain || !result?.features.length;
    for (const name of ['search','view-period','view-scenario','view-run']) field(name).disabled = Boolean(active);
    field('search-size').textContent = result?.features.length ? 'Possible closures before wet-cell filtering · ' +
      periods.map(year => year.toLocaleString() + ' years: ' +
        (2n ** BigInt(result.candidates.filter(candidate => candidate.period === year).length) - 1n).toLocaleString())
        .join(' · ') + '. Exhaustive search can take substantial time for large groups.' : '';
    field('toggle').disabled = Boolean(active) || !result?.features.length;
    field('closure').disabled = Boolean(active) || !selected.size || !terrain || tooEarly;
    field('selection').textContent = selected.size
      ? 'Selected candidates ' + [...selected].join(', ') + '.'
      : 'Choose up to three candidates using the list or map.';
    field('closure-ready').textContent = !terrain ? 'Run hydrology under Terrain & hydrology or open an aligned dem_filled GeoTIFF under Depth models.'
      : tooEarly ? 'Choose a return period at or above the first screened period of every selected candidate.' : '';
  }
  function status(text, error = false) {
    field('status').textContent = text;
    field('status').classList.toggle('error', error);
    field('status').hidden = !text;
  }
  function clearComparison() {
    comparison = null;
    urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    field('exports').replaceChildren();
    field('comparison').hidden = true;
  }
  function invalidate() {
    active?.controller.abort();
    active?.worker?.terminate();
    active = null;
    result = null;
    batchOutput = null;
    field('view-map').replaceChildren();
    field('batch-results').hidden = true;
    onClosureChange?.();
    selected.clear();
    clearComparison();
    overlay?.remove();
    overlay = null;
    field('results').hidden = true;
    status('');
    queueMicrotask(refresh);
  }
  function download(data, filename, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function runWorker(action, dem, data) {
    const job = { controller: new AbortController(), worker: null };
    active = job;
    refresh();
    try {
      const code = '(' + rasterWorker.toString() + ')(null, {}, {}, {}, null, ' +
        screenWeaklines.toString() + ', ' + compareWeaklineClosure.toString() + ', null, ' + runWeaklineScenarios.toString() + ');';
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { job.worker = new Worker(url); }
      finally { URL.revokeObjectURL(url); }
      const buffer = dem instanceof Blob ? await dem.arrayBuffer() : dem.slice(0);
      if (active !== job) return null;
      const prepared = await callWorker(job, { action: 'prepare', buffer }, 'Weakline');
      const output = await callWorker(job, { action, ...data }, 'Weakline', progress => status(progress));
      return active === job ? { ...output, prepared } : null;
    } catch (error) {
      if (active === job) status(error.message, true);
      return null;
    } finally {
      job.worker?.terminate();
      if (active === job) {
        active = null;
        refresh();
      }
    }
  }
  function style(feature) {
    const chosen = selected.has(feature.id);
    return { color: chosen ? '#112127' : colors[feature.properties.firstScreenedPeriodYears],
      weight: chosen ? 6 : 4, opacity: 0.95 };
  }
  function toggle(id) {
    if (active || !result?.candidates.some(candidate => candidate.id === id)) return;
    if (selected.has(id)) selected.delete(id);
    else if (selected.size < 3) selected.add(id);
    else { status('Remove a candidate before selecting another.'); return; }
    field('candidate').value = String(id);
    clearComparison();
    overlay?.setStyle(style);
    status('');
    refresh();
  }
  function showMap(features, bounds) {
    const L = window.L;
    field('map').hidden = !L;
    if (!L) return;
    if (!map) {
      map = L.map(field('map'), { scrollWheelZoom: false, preferCanvas: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).addTo(map);
    }
    overlay = L.geoJSON(features, {
      style,
      onEachFeature(feature, layer) {
        layer.bindTooltip('Candidate ' + feature.id + ' · ' + feature.properties.firstScreenedPeriodYears + ' years');
        layer.on('click', () => toggle(feature.id));
      },
    }).addTo(map);
    map.invalidateSize();
    map.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], { padding: [16, 16], maxZoom: 17 });
  }
  field('run').addEventListener('click', async () => {
    const { dem, reference, referenceSource, depths, method, predicted } = sourceInputs();
    const settings = {
      method, depthSource: predicted ? 'XGBoost predictions' : 'GloFAS reference depths',
      bufferM: method === 'river' ? field('buffer').valueAsNumber : null,
      referenceDepthThresholdM: method === 'depth25' ? field('footprint-threshold').valueAsNumber : null,
      referenceSource,
      referenceFile: reference instanceof File ? reference.name : null,
      thresholdM: field('threshold').valueAsNumber, minimumM: field('minimum').valueAsNumber,
    };
    const controls = ['threshold', 'minimum', method === 'river' ? 'buffer' : 'footprint-threshold'];
    const invalid = controls.find(name => !field(name).checkValidity());
    if (invalid) {
      field(invalid).reportValidity();
      return;
    }
    invalidate();
    status('Screening the four return periods…');
    const output = await runWorker('screenWeaklines', dem, { settings, reference, depthByPeriod: depths });
    if (!output) return;
    const { features, coverage, candidates, prepared } = output;
    result = { features, candidates, report: {
      schemaVersion: 1, stage: 'Weakline candidate screening', settings, coverage,
      grid: prepared.grid, demSHA256: prepared.sourceSHA256,
      candidateRule: 'Internal raster-corridor edges with depth above the threshold on either adjoining cell. Assign each edge to its first detected return period and group connected edges within that period.',
      counts: periods.map(period => ({ period, candidates: candidates.filter(item => item.period === period).length })),
    } };
    const counts = result.report.counts.map(({ period, candidates }) => period.toLocaleString() + ' yr: ' + candidates);
    field('counts').textContent = counts.join(' · ');
    field('candidate').replaceChildren(...features.map(feature => {
      const option = document.createElement('option');
      const { id, lengthM, firstScreenedPeriodYears } = feature.properties;
      option.value = id;
      option.textContent = 'Candidate ' + id + ' · ' + firstScreenedPeriodYears.toLocaleString() + ' yr · ' +
        Math.round(lengthM).toLocaleString() + ' m';
      return option;
    }));
    field('results').hidden = false;

    field('scenario').hidden = !features.length;
    showMap(features, prepared.bounds);
    refresh();
    status(features.length ? features.length.toLocaleString() + ' candidate weaklines found.'
      : 'No corridor edges met the depth and length thresholds on this grid.');
  });

  field('closure').addEventListener('click', async () => {
    if (field('closure').disabled) return;
    clearComparison();
    const { dem, terrain, depths, riverDistance } = sourceInputs();
    const period = Number(field('period').value);
    const ids = [...selected].sort((a, b) => a - b);
    const candidates = result.candidates.filter(candidate => selected.has(candidate.id));
    const barrierCells = [...new Set(candidates.flatMap(candidate => candidate.cells))];
    status('Comparing the open baseline with the selected closure…');
    const output = await runWorker('compareClosure', dem, {
      terrain, depth: depths[period], riverDistance, barrierCells,
    });
    if (!output) return;
    const { metrics, rasters, cap } = output;
    comparison = { ...result.report, stage: 'Weakline closure comparison',
      periodYears: period, candidateIds: ids, depthCapM: cap,
      routingMethod: 'Paired D8 priority flood on water-surface elevation',
      outlets: riverDistance ? 'Valid-domain edges and zero-distance river cells' : 'Valid-domain edges',
      barrierRule: 'Raise both cells adjoining the selected raster edges. Exclude these cells from both comparison outputs.',
      comparisonWetThresholdM: 0.05, reportedChangeThresholdM: 0.001, metrics };
    const rows = [
      ['Wet area (m²)', metrics.baselineWetAreaM2, metrics.closureWetAreaM2],
      ['Sum of water depth × cell area (m³)', metrics.baselineVolumeM3, metrics.closureVolumeM3],
    ];
    field('metrics').replaceChildren(...rows.map(([label, baseline, closure]) => {
      const row = document.createElement('tr');
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = label;
      row.append(heading);
      for (const value of [baseline, closure, closure - baseline]) {
        row.insertCell().textContent = value.toLocaleString(undefined, { maximumFractionDigits: 1 });
      }
      return row;
    }));
    field('cells').textContent = metrics.comparedCells.toLocaleString() + ' compared cells · ' +
      metrics.excludedBarrierCells.toLocaleString() + ' barrier cells excluded · ' +
      metrics.deeperCells.toLocaleString() + ' deeper and ' + metrics.shallowerCells.toLocaleString() + ' shallower (>1 mm change).';
    const labels = { baseline: 'Baseline depth GeoTIFF', closure: 'Closure depth GeoTIFF', difference: 'Depth change GeoTIFF' };
    for (const [name, buffer] of Object.entries(rasters)) {
      const link = document.createElement('a');
      link.textContent = labels[name];
      link.download = 'weakline-' + period + 'yr-' + ids.join('-') + '-' + name + '.tif';
      link.href = URL.createObjectURL(new Blob([buffer], { type: 'image/tiff' }));
      urls.push(link.href);
      field('exports').append(link);
    }
    field('comparison').hidden = false;
    status(period.toLocaleString() + '-year closure comparison complete.');
  });
  field('batch').addEventListener('click', async () => {
    if (field('batch').disabled) return;
    const { dem, terrain, depths, riverDistance, population, predicted } = sourceInputs();
    const exhaustive = field('search').value === 'all';
    status('Preparing the scenario search…');
    const output = await runWorker('weaklineBatch', dem, {
      terrain, depths, riverDistance, population, candidates: result.candidates, periods, exhaustive,
    });
    if (!output) return;
    batchOutput = { ...output, predicted, demSHA256: output.prepared.sourceSHA256,
      report: { ...output.report, method: exhaustive ? 'Exhaustive' : 'Desktop-style bounded search',
        screening: result.report } };
    field('batch-metric').textContent = 'Ranking uses ' + batchOutput.report.metric +
      '. Open depths fill artificial barrier cells for comparable scoring.';
    field('batch-rows').replaceChildren(...batchOutput.report.periods.map(row => {
      const tr = document.createElement('tr');
      for (const value of [row.period, row.eligible.length, row.totalPossible, row.tested,
        row.winner?.closed.join(', ') ?? 'Open baseline', row.winner?.score.toPrecision(6) ?? '—']) {
        tr.insertCell().textContent = value;
      }
      return tr;
    }));
    field('batch-results').hidden = false;
    updateScenarioChoices();
    onClosureChange?.();
    status('Scenario search complete. Use Flood hazard maps to inspect the three modes.');
  });
  function updateScenarioChoices() {
    field('view-map').replaceChildren();
    const period = Number(field('view-period').value);
    const row = batchOutput?.report.periods.find(r=>r.period===period);
    const choices = field('view-scenario');
    choices.replaceChildren(new Option('Open baseline','open'));
    for (const [index,state] of (row?.scenarios ?? []).entries()) {
      const winner = row.winner?.closed.join() === state.closed.join();
      choices.add(new Option('Close '+state.closed.join(', ')+(winner?' · highest exposure':''),String(index)));
    }
  }
  field('view-period').addEventListener('change',updateScenarioChoices);
  field('view-scenario').addEventListener('change',()=>field('view-map').replaceChildren());
  field('view-run').addEventListener('click',async()=>{
    if(active || !batchOutput) return;
    const period = Number(field('view-period').value);
    const row = batchOutput.report.periods.find(r=>r.period===period);
    const choice = field('view-scenario').value;
    const closed = new Set(choice==='open' ? [] : row.scenarios[Number(choice)].closed);
    const cells = result.candidates.filter(c=>closed.has(c.id)).flatMap(c=>c.cells);
    const {dem,terrain,riverDistance,depths}=sourceInputs();
    const parent = field('view-map');
    parent.replaceChildren();
    status('Preparing the selected depth map…');
    const output = await runWorker('previewScenario',dem,{terrain,riverDistance,depth:depths[period],barrierCells:[...new Set(cells)]});
    if (!output) return;
    const {width,height}=result.report.grid.dimensions;
    const max=output.values.reduce((m,v)=>Number.isFinite(v)?Math.max(v,m):m,0);
    const canvas=document.createElement('canvas'), title=document.createElement('h4');
    title.textContent=period.toLocaleString()+' years · '+field('view-scenario').selectedOptions[0].text;
    canvas.setAttribute('aria-label',title.textContent+' · flood depth'); canvas.width=width; canvas.height=height;
    const image=new ImageData(width,height);
    output.values.forEach((v,i)=>{
      if (!Number.isFinite(v)) return;
      const f=max?v/max:0;
      image.data.set([223-196*f,241-151*f,250-119*f,255],4*i);
    });
    canvas.getContext('2d').putImageData(image,0,0);
    parent.append(title,canvas,rangeLegend(0,max,'Flood depth (m)','#dff1fa',max?'#1b5a83':'#dff1fa'));
    showStudyArea(parent,result.report.grid,canvas);
    status('Selected scenario depth displayed.');
  });
  field('batch-report').addEventListener('click', () => {
    if (batchOutput) download(batchOutput.report, 'siavash-weakline-scenarios.json');
  });
  field('toggle').addEventListener('click', () => toggle(Number(field('candidate').value)));
  field('period').addEventListener('change', () => { clearComparison(); status(''); refresh(); });
  for (const name of ['method', 'source', 'depth25', 'footprint-threshold', 'buffer', 'threshold', 'minimum']) {
    field(name).addEventListener('change', invalidate);
  }
  field('cancel').addEventListener('click', () => {
    active?.controller.abort();
    active?.worker?.terminate();
    active = null;
    status('Weakline processing cancelled.');
    refresh();
  });
  field('geojson').addEventListener('click', () => {
    if (result) download({ type: 'FeatureCollection', features: result.features }, 'siavash-weaklines.geojson', 'application/geo+json');
  });
  field('report').addEventListener('click', () => { if (result) download(result.report, 'siavash-weakline-screening.json'); });
  field('closure-report').addEventListener('click', () => { if (comparison) download(comparison, 'siavash-weakline-closure.json'); });
  return { invalidate, refresh, getScenarios: () => batchOutput };
}
