import { showStudyArea, rangeLegend } from './raster-cards.mjs?v=map-legends';
// Keep this kernel self-contained so the aligned GeoTIFF worker can run it.
export function computeHazards({ width, height, periods, depths, slope, manning, scenarioDepths = {}, mode = 'baseline', basis = 'auto', clean }) {
  const size = width * height;
  const wetDepth = Math.fround(0.05);
  const adrLimits = [[0.3, 2, 0.3], [0.5, 2, 0.6], [1.2, 2, 0.6], [2, 2, 1], [4, 4, 4]]
    .map(limits => limits.map(Math.fround));
  const rasters = {};
  const floats = () => new Float32Array(size).fill(NaN);
  function classify(depth) {
    const velocity = floats(), product = floats(), adr = floats(), intensityD = floats(), intensityDV = floats();
    for (let i = 0; i < size; i++) {
      const h = depth[i];
      if (!Number.isFinite(h) || h < 0) continue;
      const wet = h > wetDepth;
      intensityD[i] = wet ? (h >= 2 ? 3 : h >= 0.5 ? 2 : 1) : 0;
      if (!wet) {
        adr[i] = 0;
        intensityDV[i] = 0;
        continue;
      }
      if (!(slope[i] >= 0 && slope[i] <= 90 && Number.isFinite(manning[i]) && manning[i] > 0)) continue;
      const gradient = Math.min(0.01, Math.max(0.00001, Math.tan(slope[i] * Math.PI / 180)));
      const roughness = Math.min(0.2, Math.max(0.01, manning[i]));
      const v = Math.fround(Math.min(20, Math.max(h, 0.1) ** (2 / 3) * Math.sqrt(gradient) / roughness));
      const dv = Math.fround(h * v);
      velocity[i] = v;
      product[i] = dv;
      intensityDV[i] = dv >= 2 ? 3 : dv >= 0.5 ? 2 : dv > wetDepth ? 1 : 0;
      const level = adrLimits.findIndex(([maxH, maxV, maxDV]) => h <= maxH && v <= maxV && dv <= maxDV);
      adr[i] = level === -1 ? 6 : level + 1;
    }
    return { velocity, product, adr, intensityD, intensityDV };
  }
  function cleanClasses(values) {
    if (!clean) return values;
    const visited = new Uint8Array(size);
    const filtered = values.slice();
    for (let cell = 0; cell < size; cell++) {
      const code = values[cell];
      if (!(code > 0) || visited[cell]) continue;
      const region = [cell];
      visited[cell] = 1;
      for (const i of region) {
        const x = i % width;
        const neighbours = [x ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
        for (const next of neighbours) {
          if (next >= 0 && next < size && !visited[next] && values[next] === code) {
            visited[next] = 1;
            region.push(next);
          }
        }
      }
      if (region.length < 6) for (const i of region) filtered[i] = 0;
    }
    const updated = filtered.slice();
    const votes = new Uint8Array(7);
    const order = new Uint8Array(6);
    for (let i = 0; i < size; i++) {
      const code = filtered[i];
      if (!(code > 0)) continue;
      const x = i % width, y = Math.floor(i / width);
      votes.fill(0);
      let distinct = 0;
      for (let row = Math.max(0, y - 1); row <= Math.min(height - 1, y + 1); row++) {
        for (let col = Math.max(0, x - 1); col <= Math.min(width - 1, x + 1); col++) {
          const value = filtered[row * width + col];
          if (!(value > 0)) continue;
          if (!votes[value]) order[distinct++] = value;
          votes[value]++;
        }
      }
      let winner = code;
      for (let j = 0; j < distinct; j++) {
        const alt = order[j];
        if (votes[alt] >= 2 && votes[alt] > votes[winner]) winner = alt;
      }
      updated[i] = winner;
    }
    return updated;
  }
  function firstExceedance(layers) {
    const periodAtCell = floats(), firstClass = floats();
    for (let i = 0; i < size; i++) {
      for (let k = 0; k < periods.length; k++) {
        const value = layers[k][i];
        if (!Number.isFinite(value)) continue;
        periodAtCell[i] = 0;
        firstClass[i] = 0;
        if (value > 0) {
          periodAtCell[i] = periods[k];
          firstClass[i] = value;
          break;
        }
      }
    }
    return { periodAtCell, firstClass };
  }
  function foenDanger(layers, filter = true) {
    const { periodAtCell, firstClass } = firstExceedance(layers);
    for (let i=0;i<size;i++) if(periodAtCell[i]===1000) firstClass[i]=1;
    const intensity = filter ? cleanClasses(firstClass) : firstClass;
    const matrix = {30:[0,3,6,9],100:[0,2,5,8],300:[0,1,4,7],1000:[0,10,10,10]};
    return intensity.map((code,i) => code>0 ? matrix[periodAtCell[i]][code] : code);
  }
  const dangerGroup = code => [0,1,1,2,1,2,2,3,3,3,4][code] ?? NaN;
  const composite = [], coverage = {};
  for (const period of periods) {
    const baseline = classify(depths[period]);
    const modified = scenarioDepths[period] ? classify(scenarioDepths[period]) : null;
    const selected = modified ?? baseline;
    const adr = cleanClasses(selected.adr);
    const intensityD = cleanClasses(selected.intensityD);
    const intensityDV = cleanClasses(selected.intensityDV);
    composite.push({ adr, intensityD, intensityDV });
    rasters['adr7_' + period] = adr;
    rasters['foen_depth_intensity_' + period] = intensityD;
    rasters['foen_dv_intensity_' + period] = intensityDV;
    rasters['velocity_' + period] = baseline.velocity;
    rasters['depth_velocity_' + period] = baseline.product;
    if (modified) {
      rasters['closure_velocity_' + period] = modified.velocity;
      rasters['closure_depth_velocity_' + period] = modified.product;
    }
    let validDepthCells = 0, wetCells = 0, hydraulicCells = 0;
    for (let i = 0; i < size; i++) {
      if (Number.isFinite(baseline.intensityD[i])) validDepthCells++;
      if (baseline.intensityD[i] > 0) wetCells++;
      if (Number.isFinite(baseline.velocity[i])) hydraulicCells++;
    }
    coverage[period] = { validDepthCells, wetCells, wetCellsWithVelocity: hydraulicCells };
  }
  for (const [name, field] of [['foen_depth_danger', 'intensityD'], ['foen_dv_danger', 'intensityDV']]) {
    rasters[name] = foenDanger(composite.map(item => item[field])).map(dangerGroup);
  }
  rasters.adr7_envelope = cleanClasses(composite[0].adr.map((_,i)=>{
    const values=composite.map(item=>item.adr[i]).filter(Number.isFinite);
    return values.length ? Math.max(...values) : NaN;
  }));
  const first = firstExceedance(composite.map(item => item.adr));
  rasters.adr7_first_period = first.periodAtCell;
  rasters.adr7_first_class = cleanClasses(first.firstClass);
  const significant = values => values.reduce((count, code) => count + Number(code === 3), 0);
  const depthCount = significant(rasters.foen_depth_danger), dvCount = significant(rasters.foen_dv_danger);
  const chosen = basis === 'auto' ? (dvCount > depthCount ? 'dv' : 'depth') : basis;
  rasters.foen_champion = chosen === 'dv' ? rasters.foen_dv_danger : rasters.foen_depth_danger;
  const chosenIntensity = chosen === 'dv' ? 'intensityDV' : 'intensityD';
  rasters.foen_matrix = foenDanger(composite.map(item => item[chosenIntensity]), false);
  rasters.foen_final = rasters.foen_matrix.map(dangerGroup);
  return { rasters, coverage, champion: { basis: chosen, selection: basis, depthCount, dvCount } };
}

const periods = [30, 100, 300, 1000];

function productDescription(name) {
  if (name === 'foen_matrix') return ['FOEN frequency–intensity matrix', 'matrix'];
  if (name === 'foen_final') return ['FOEN final danger matrix for risk', 'danger'];
  if (name === 'foen_champion') return ['FOEN champion danger', 'danger'];
  if (name === 'foen_depth_danger') return ['FOEN danger · depth', 'danger'];
  if (name === 'foen_dv_danger') return ['FOEN danger · depth × velocity', 'danger'];
  if (name === 'adr7_envelope') return ['ADR7 maximum class across all periods', 'adr'];
  if (name === 'adr7_first_class') return ['ADR7 class at first exceedance', 'adr'];
  if (name === 'adr7_first_period') return ['ADR7 first exceedance period', 'period'];
  const match = name.match(/^(.*)_(\d+)$/);
  const descriptions = {
    adr7: ['ADR7 class', 'adr'], foen_depth_intensity: ['FOEN depth intensity', 'intensity'],
    foen_dv_intensity: ['FOEN depth × velocity intensity', 'intensity'],
    velocity: ['Baseline Manning velocity', 'velocity'], depth_velocity: ['Baseline depth × velocity', 'dv'],
    closure_velocity: ['Closure Manning velocity', 'velocity'], closure_depth_velocity: ['Closure depth × velocity', 'dv'],
  };
  const [label, type] = descriptions[match[1]];
  return [label + ' · ' + Number(match[2]).toLocaleString() + ' years', type];
}

export function createHazardPanel({ element, readInputs, readScenarios, onChange, rasterWorker, callWorker }) {
  const field = name => element('hazard-' + name);
  let active = null, result = null, url = null;
  const legends = {
    danger: [[0, 'Dry / no class', '#edf3ee'], [1, 'Low', '#efcf58'], [2, 'Medium', '#628fce'], [3, 'Significant', '#a12639'], [4, 'Residual', '#bab3c7']],
    adr: [[0, 'Dry / no class', '#edf3ee'], [1, 'H1', '#94d1ae'], [2, 'H2', '#e2d46e'], [3, 'H3', '#efa65a'], [4, 'H4', '#e47052'], [5, 'H5', '#b63f62'], [6, 'H6', '#69204b']],
    intensity: [[0, 'Dry / no class', '#edf3ee'], [1, 'Low', '#ecd779'], [2, 'Middle', '#e49453'], [3, 'High', '#a12639']],
    period: [[0, 'No classified exceedance', '#edf3ee'], [30, '30 years', '#9a3050'], [100, '100 years', '#d17338'], [300, '300 years', '#36838a'], [1000, '1,000 years', '#7f6ba9']],
  };
  legends.matrix = [[0,'Dry / no class','#edf3ee'],[1,'300 yr · low','#efcf58'],[2,'100 yr · low','#efcf58'],[3,'30 yr · low','#628fce'],
    [4,'300 yr · middle','#efcf58'],[5,'100 yr · middle','#628fce'],[6,'30 yr · middle','#628fce'],
    [7,'300 yr · high','#a12639'],[8,'100 yr · high','#a12639'],[9,'30 yr · high','#a12639'],[10,'Residual','#bab3c7']];
  const fromHex = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  function read() {
    const inputs = readInputs();
    const predicted = field('source').value === 'trained';
    const closure = readScenarios();
    const available = closure?.predicted === predicted ? closure : null;
    return { ...inputs, predicted, available, depths: predicted ? inputs.trainedDepths : inputs.referenceDepths };
  }
  function refresh() {
    const { dem, depths, slope, manning, available } = read();
    const need = !dem ? 'Provide a DEM under Study area or Depth models.'
      : !slope || !manning ? 'Provide aligned slope in degrees and Manning n from terrain and WorldCover, or load them under Depth models.'
      : !periods.every(period => depths?.[period]) ? 'Provide all four depth rasters for this source.'
      : '';
    field('ready').textContent = need;
    const hasScenarios = Boolean(available && Object.keys(available.worst).length);
    field('closure-note').textContent = hasScenarios
      ? 'Completed weakline scenarios are available for this depth source.'
      : 'Run the search under Weakline scenarios with this depth source to enable Weaklines and Worst-case.';
    for (const option of field('mode').options) {
      option.disabled = option.value !== 'baseline' && !hasScenarios;
    }
    if (!hasScenarios) field('mode').value = 'baseline';
    field('mode').disabled = Boolean(active);
    field('basis').disabled = Boolean(active);
    field('source').disabled = Boolean(active);
    field('clean').disabled = Boolean(active);
    field('run').disabled = Boolean(active) || Boolean(need);
    field('cancel').disabled = !active;
  }
  function status(message, error = false) {
    field('status').textContent = message;
    field('status').hidden = !message;
    field('status').classList.toggle('error', error);
  }
  function clearDownload() {
    if (url) URL.revokeObjectURL(url);
    url = null;
    field('download').removeAttribute('href');
  }
  function invalidate() {
    active?.controller.abort();
    active?.worker?.terminate();
    active = null;
    result = null;
    onChange();
    clearDownload();
    field('results').hidden = true;
    status('');
    queueMicrotask(refresh);
  }
  function drawLayer(name, canvas, legendNode) {
    const [label, type] = productDescription(name);
    const product = result.products[name];
    const { width, height } = result.report.grid.dimensions;
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('aria-label', label);
    const pixels = new ImageData(width, height);
    const legend = legends[type];
    const colors = new Map(legend?.map(([code, , hex]) => [code, fromHex(hex)]));
    const values = new Float32Array(product.values);
    const max = product.summary.max ?? 0;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) continue;
      const t = Math.min(1, value / (max || 1));
      const color = legend ? colors.get(value) : [Math.round(218 - 174 * t), Math.round(239 - 136 * t), Math.round(235 - 86 * t)];
      pixels.data.set([...color, 255], i * 4);
    }
    canvas.getContext('2d').putImageData(pixels, 0, 0);
    const unit = type === 'velocity' ? 'm/s' : 'm²/s';
    legendNode.replaceChildren();
    if (legend) {
      for (const [, text, hex] of (type === 'matrix' ? legends.danger : legend)) {
        const item = document.createElement('span');
        const swatch = document.createElement('span');
        swatch.className = 'hazard-swatch';
        swatch.style.backgroundColor = hex;
        swatch.setAttribute('aria-hidden', 'true');
        item.append(swatch, text);
        legendNode.append(item);
      }
    } else {
      legendNode.append(rangeLegend(0,max,unit,'#daefeb',max?'#2c6795':'#daefeb'));
    }
    const noData = document.createElement('span');
    noData.textContent = 'Transparent = NoData';
    legendNode.append(noData);
    const preview = canvas.closest('study-area-map')?.parentElement ?? canvas.parentElement;
    showStudyArea(preview, result.report.grid, canvas);
  }
  function showLayer() {
    if (!result) return;
    const name = field('layer').value;
    const product = result.products[name];
    drawLayer(name, field('canvas'), field('legend'));
    field('coverage').textContent = product.summary.validCells.toLocaleString() + ' classified or calculated cells.';
    clearDownload();
    url = URL.createObjectURL(new Blob([product.tiff], { type: 'image/tiff' }));
    field('download').href = url;
    field('download').download = 'siavash_' + result.report.mode + '_' + name + '.tif';
  }
  field('run').addEventListener('click', async () => {
    if (field('run').disabled) return;
    const { dem, slope, manning, depths, predicted, available } = read();
    const mode = field('mode').value;
    const basis = field('basis').value;
    const scenarios = mode === 'baseline' ? null : available;
    const clean = field('clean').checked;
    invalidate();
    const job = { controller: new AbortController(), worker: null };
    active = job;
    refresh();
    status('Calculating velocity and hazard on the DEM grid…');
    try {
      const code = '(' + rasterWorker.toString() + ')(null, {}, {}, {}, null, null, null, ' + computeHazards.toString() + ');';
      const workerURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { job.worker = new Worker(workerURL); }
      finally { URL.revokeObjectURL(workerURL); }
      const buffer = dem instanceof Blob ? await dem.arrayBuffer() : dem.slice(0);
      if (active !== job) return;
      const prepared = await callWorker(job, { action: 'prepare', buffer }, 'Hazard');
      if (scenarios && scenarios.demSHA256 !== prepared.sourceSHA256) throw Error('Run the closure comparison again using this DEM.');
      const { products, coverage, champion } = await callWorker(job, {
        action: 'hazard', slope, manning, depths, periods, clean,
        mode, basis, scenarios: scenarios?.[mode === 'worst' ? 'worst' : 'envelope'],
      }, 'Hazard');
      if (active !== job) return;
      result = { products, report: {
        schemaVersion: 1, stage: 'SIAVASH flood hazard', mode, periods, grid: prepared.grid, demSHA256: prepared.sourceSHA256,
        depthSource: predicted ? 'XGBoost predictions' : 'GloFAS reference depths',
        champion,
        scenarios: scenarios?.report.periods.map(({ period, winner, tested }) => ({ period, winner, tested })) ?? null,
        rankingMetric: scenarios?.report.metric ?? null,
        wetDepthM: 0.05, velocity: { formula: 'max(h, 0.10)^(2/3) * sqrt(S) / n',
          slope: 'tan(slopeDegrees × pi / 180)', gradientRange: [0.00001, 0.01], roughnessRange: [0.01, 0.20], maxMps: 20 },
        clean: clean ? 'Remove four-connected groups under six cells, then apply a 3 × 3 majority update to positive classes.' : null,
        noData: 'Dry is 0 in categorical rasters. Velocity and D×V are NoData for dry cells or missing terrain inputs. First exceedance uses the earliest available classified period.',
        codebook: legends, coverage, products: Object.fromEntries(Object.entries(products).map(([name, product]) =>
          [name, { label: productDescription(name)[0], ...product.summary }])),
      } };
      onChange();
      const names = Object.keys(products).sort((a, b) => Number(/_\d+$/.test(a)) - Number(/_\d+$/.test(b)));
      field('layer').replaceChildren(...names.map(name => new Option(productDescription(name)[0], name)));
      field('layer').value = 'adr7_envelope';
      field('results').hidden = false;
      drawLayer('foen_champion', field('foen-map'), field('foen-legend'));
      drawLayer('adr7_envelope', field('adr-map'), field('adr-legend'));
      field('champion-note').textContent = 'FOEN champion · ' + (champion.basis === 'dv' ? 'Depth × velocity' : 'Depth') +
        ' · Significant cells: ' + champion.depthCount.toLocaleString() + ' by depth, ' + champion.dvCount.toLocaleString() + ' by depth × velocity.';
      showLayer();
      const missingVelocity = Object.values(coverage).some(row => row.wetCells > row.wetCellsWithVelocity);
      status('Hazard layers ready.' + (missingVelocity ? ' Some wet cells lack valid slope or roughness. Check the layer coverage in the report.' : ''));
    } catch (error) {
      if (active === job) status(error.message, true);
    } finally {
      job.worker?.terminate();
      if (active === job) {
        active = null;
        refresh();
      }
    }
  });
  for (const name of ['source', 'mode', 'basis', 'clean']) field(name).addEventListener('change', invalidate);
  field('cancel').addEventListener('click', () => { invalidate(); status('Hazard processing cancelled.'); });
  field('layer').addEventListener('change', showLayer);
  field('report').addEventListener('click', () => {
    if (!result) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(result.report, null, 2)], { type: 'application/json' }));
    link.download = 'siavash-hazard-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  return { invalidate, refresh, getResult: () => result, closureChanged: () => field('mode').value !== 'baseline' ? invalidate() : queueMicrotask(refresh) };
}
