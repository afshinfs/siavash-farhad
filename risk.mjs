import { appendRiverLegend, showStudyArea, rangeLegend } from './raster-cards.mjs?v=river-maps';
// Self-contained for execution inside the aligned GeoTIFF worker.
export function computeRisk({ layers, mask, width, method, binning }) {
  const specs = { nightlights: [.25, true], builtup: [.2, false], population: [.25, false],
    slope: [.1, true], river: [.1, true], road: [.05, true], buildings: [.05, false] };
  const blank = () => new Float32Array(mask.length);
  const quantile = (sorted, p) => {
    const k = (sorted.length - 1) * p, lower = Math.floor(k);
    return sorted[lower] + (sorted[Math.ceil(k)] - sorted[lower]) * (k - lower);
  };
  function scale(raw, omitZeros = false) {
    const sorted = raw.filter(x => Number.isFinite(x) && (!omitZeros || x !== 0)).sort();
    const lo = quantile(sorted, .02), hi = quantile(sorted, .98);
    return raw.map(x => omitZeros && x === 0 ? NaN : Math.max(0, Math.min(1, (x-lo)/(hi>lo ? hi-lo : 1e-6))));
  }
  const vulnerability = blank(), exposure = blank(), used = {}, exposureWeights = {};
  let total = 0, exposureTotal = 0;
  for (const [name, [weight, inverse]] of Object.entries(specs)) {
    const raw = layers[name];
    if (!raw || !raw.some((v,i) => mask[i] && Number.isFinite(v))) continue;
    const scaled = name === 'buildings' ? raw.map(x => Math.min(1, Math.max(0,x))) : scale(raw);
    for (let i=0; i<mask.length; i++) {
      if (Number.isFinite(scaled[i])) vulnerability[i] += weight * (inverse ? 1-scaled[i] : scaled[i]);
    }
    used[name] = weight;
    total += weight;
    if (name === 'population' || name === 'buildings') {
      const w = name === 'population' ? .6 : .4;
      const sparse = name === 'population' && raw.filter(x => x===0).length > .95 * raw.filter(Number.isFinite).length;
      const component = sparse ? scale(raw,true) : scaled;
      for (let i=0; i<mask.length; i++) exposure[i] += w * (component[i] || 0);
      exposureWeights[name] = w;
      exposureTotal += w;
    }
  }
  if (!total) throw Error('No vulnerability inputs have valid cells on this DEM.');
  if (!exposureTotal && method === 'HEV') throw Error('Retrieve population or building coverage in Step 03, or select H × V.');
  for (const name in used) used[name] /= total;
  for (const name in exposureWeights) exposureWeights[name] /= exposureTotal;
  for (let i=0; i<mask.length; i++) {
    vulnerability[i] = mask[i] ? Math.min(1,vulnerability[i]/total) : NaN;
    exposure[i] = mask[i] && exposureTotal ? Math.min(1,exposure[i]/exposureTotal) : NaN;
  }
  const rasters = { vulnerability, vulnerability_class: vulnerability.map(v => Math.min(5,1+Math.floor(v*5))) };
  if (exposureTotal) rasters.exposure = exposure;
  const frameworks = {}, noRisk = {};
  for (const [key, weights, n] of [['foen',[0,.33,.66,1,.5],4],['adr7',[0,.15,.3,.5,.7,.85,1],5]]) {
    const hazard = layers[key];
    const risk = vulnerability.map((v,i) => {
      const r = weights[hazard[i]] * v * (method === 'HEV' ? exposure[i] : 1);
      return r > 1e-6 ? r : NaN;
    });
    const seen = new Uint8Array(mask.length);
    for (let i=0; i<risk.length; i++) {
      if (seen[i] || !Number.isFinite(risk[i])) continue;
      const region = [i];
      seen[i] = 1;
      for (const cell of region) {
        const x = cell % width;
        for (const j of [x ? cell-1 : -1, x+1<width ? cell+1 : -1,cell-width,cell+width]) {
          if (Number.isFinite(risk[j]) && !seen[j]) { seen[j]=1; region.push(j); }
        }
      }
      if (region.length < 4) for (const cell of region) risk[cell] = NaN;
    }
    const positive = risk.filter(Number.isFinite).sort();
    let edges = Array.from({length:n+1},(_,i)=>i/n), applied = 'equal interval';
    if (binning === 'quantile' && positive.length) {
      const q = edges.map(p => Math.fround(quantile(positive,p)));
      if (new Set(q.map(x=>x.toFixed(6))).size === n+1) { edges=q; edges[0]=0; edges[n]=1; applied='quantile'; }
    }
    const counts = new Array(n+1).fill(0);
    const classes = risk.map((r,i) => {
      if (!mask[i] || !Number.isFinite(r)) return NaN;
      const c = edges.findIndex((edge,j)=>j>0 && r<=edge);
      counts[c]++;
      return c;
    });
    const coveredWithoutMappedRisk = Uint8Array.from(risk, (value, i) => Number(
      !Number.isFinite(value) && Number.isFinite(hazard[i]) &&
      Number.isFinite(vulnerability[i]) && (method !== 'HEV' || Number.isFinite(exposure[i]))
    ));
    noRisk[key] = coveredWithoutMappedRisk;
    rasters[key+'_risk'] = risk;
    rasters[key+'_class'] = classes;
    frameworks[key] = {edges, counts, applied, positiveCells:positive.length,
      noMappedRiskCells: coveredWithoutMappedRisk.reduce((sum, cell) => sum + cell, 0)};
  }
  return { rasters, noRisk, frameworks, vulnerabilityWeights:used, exposureWeights };
}

const labels = {foen_class:'FOEN risk classes', adr7_class:'ADR7 risk classes', foen_risk:'FOEN risk index', adr7_risk:'ADR7 risk index',
  vulnerability:'Vulnerability index', vulnerability_class:'Vulnerability classes', exposure:'Exposure index'};
const palettes = {foen_class:['','Low','Medium','High','Very high'],adr7_class:['','Very low','Low','Medium','High','Extreme'],
  vulnerability_class:['','Very low','Low','Moderate','High','Very high']};
const colors = ['#edf1ef','#ffedbc','#ffc96d','#f18f4e','#c94e42','#802744'];
export function createRiskPanel({element, read, readRivers, rasterWorker, callWorker}) {
  const el = name => element('risk-'+name);
  let job, urls=[];
  function refresh() {
    const {hazard,layers} = read();
    const need = !hazard ? 'Calculate flood hazard in Step 07.' :
      el('method').value === 'HEV' && !layers.population && !layers.buildings ? 'Retrieve population or buildings in Step 03, or select H × V.' : '';
    el('ready').textContent = need || 'Ready · '+hazard.report.depthSource+' · '+hazard.report.mode+' mode.';
    el('run').disabled = Boolean(job || need);
    el('cancel').disabled = !job;
  }
  function reset() {
    job?.controller.abort(); job?.worker?.terminate(); job=null;
    urls.forEach(URL.revokeObjectURL); urls=[];
    el('maps').replaceChildren(); el('other-maps').replaceChildren(); el('optional').open=false; el('optional').hidden=true; el('report').hidden=true; el('status').textContent='';
    refresh();
  }
  function link(data,type) { const url=URL.createObjectURL(new Blob([data],{type})); urls.push(url); return url; }
  function render(name, product, grid, report, download, noRisk, rivers, container) {
    const label = labels[name], canvas = document.createElement('canvas');
    const {width,height} = grid.dimensions;
    canvas.width=width; canvas.height=height; canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',label);
    const ctx=canvas.getContext('2d'), image=ctx.createImageData(width,height), names=palettes[name];
    const rgb=colors.map(hex=>[1,3,5].map(k=>parseInt(hex.slice(k,k+2),16)));
    new Float32Array(product.values).forEach((v,i)=>{
      if (!Number.isFinite(v)) {
        if (noRisk?.[i]) image.data.set([237, 241, 239, 180], i*4);
        return;
      }
      const color=names ? rgb[v] : [231-195*v,244-137*v,237-145*v];
      image.data.set([...color,255],i*4);
    });
    ctx.putImageData(image,0,0);
    const legend=document.createElement('div'); legend.className='map-legend ee-help';
    if (names) names.forEach((label,i)=>{
      if (!label) return;
      const span=document.createElement('span'), swatch=document.createElement('i');
      swatch.style.backgroundColor=colors[i]; span.append(swatch,label); legend.append(span);
    }); else legend.append(rangeLegend(0,1,'Index','#e7f4ed','#246b5c'));
    if (noRisk) {
      const item = document.createElement('span'), swatch = document.createElement('i');
      swatch.style.backgroundColor = colors[0];
      item.append(swatch, 'No mapped risk');
      legend.append(item, 'Transparent = NoData');
    }
    appendRiverLegend(legend, rivers);
    const caption=document.createElement('p'); caption.className='ee-help';
    const stats=report.frameworks[name.split('_')[0]];
    caption.textContent=stats ? stats.positiveCells.toLocaleString()+' positive risk cells · '+stats.applied+' classes' : 'Scaled within the study area';
    const a=document.createElement('a'); a.href=download; a.download='farhad_'+report.mode+'_'+report.method+'_'+name+'.tif';
    a.textContent='Download GeoTIFF'; a.setAttribute('aria-label','Download '+label+' GeoTIFF');
    container.replaceChildren(canvas,legend,caption,a);
    showStudyArea(container,grid,canvas,{ rivers });
  }

  function showResults(products, report, noRisk, rivers) {
    const downloads = Object.fromEntries(Object.entries(products).map(([name, product]) =>
      [name, link(product.tiff, 'image/tiff')]));
    const draw = (name, target) => render(name, products[name], report.grid, report, downloads[name],
      noRisk[name.split('_')[0]], rivers, target);

    for (const name of ['foen_class', 'adr7_class']) {
      const figure = document.createElement('figure'), title = document.createElement('h3');
      const output = document.createElement('div');
      title.textContent = labels[name];
      figure.append(title, output);
      el('maps').append(figure);
      draw(name, output);
    }

    for (const [title, names] of [
      ['Risk index', ['foen_risk', 'adr7_risk']],
      ['Vulnerability', ['vulnerability', 'vulnerability_class']],
      ['Exposure', ['exposure']],
    ]) {
      const figure = document.createElement('figure'), label = document.createElement('label');
      const select = document.createElement('select'), output = document.createElement('div');
      select.replaceChildren(...names.filter(name => products[name]).map(name => new Option(labels[name], name)));
      if (!select.options.length) continue;
      label.append(title, select);
      figure.append(label, output);
      el('other-maps').append(figure);
      select.addEventListener('change', () => draw(select.value, output));
      draw(select.value, output);
    }
  }
  el('run').onclick=async()=>{
    if(el('run').disabled) return;
    reset();
    const {dem,layers,hazard,buildingSource}=read(), method=el('method').value, binning=el('bins').value;
    const active={controller:new AbortController()}; job=active; refresh();
    try {
      const script='('+rasterWorker.toString()+')(null,{},{},{},null,null,null,null,null,'+computeRisk.toString()+');';
      const url=URL.createObjectURL(new Blob([script],{type:'text/javascript'}));
      try { active.worker=new Worker(url); } finally { URL.revokeObjectURL(url); }
      el('status').textContent='Checking the DEM and aligned inputs…';
      const buffer=dem instanceof Blob ? await dem.arrayBuffer() : dem.slice(0);
      if(job!==active) return;
      const prepared=await callWorker(active,{action:'prepare',buffer},'Risk');
      if(prepared.sourceSHA256!==hazard.report.demSHA256) throw Error('The DEM changed. Recalculate Step 07.');
      const response=await callWorker(active,{action:'risk',method,binning,layers:{...layers,foen:hazard.products.foen_final.tiff,adr7:hazard.products.adr7_first_class.tiff}},'Risk',msg=>el('status').textContent=msg);
      if(job!==active) return;
      const {products,noRisk,...stats}=response;
      const report={method,binning,mode:hazard.report.mode,depthSource:hazard.report.depthSource,champion:hazard.report.champion,grid:prepared.grid,demSHA256:prepared.sourceSHA256,
        buildingSource,scenarioSelection:hazard.report.scenarios,minimumPatchCells:4,zeroThreshold:1e-6,scalingPercentiles:[2,98],inverted:['nightlights','slope','road','river'],
        missingInputs:Object.keys(layers).filter(k=>!(k in stats.vulnerabilityWeights)),classLabels:palettes,...stats};
      showResults(products, report, noRisk, readRivers());
      el('optional').hidden=false;
      el('report').href=link(JSON.stringify(report,null,2),'application/json'); el('report').hidden=false;
      el('status').textContent='Risk maps ready. '+(report.missingInputs.length?'Available weights rescaled. Missing inputs: '+report.missingInputs.join(', ')+'. ':'')+'Pale cells have no mapped risk. Transparent cells have no data.';
    } catch(e) { if(job===active) el('status').textContent=e.message; }
    finally { active.worker?.terminate(); if(job===active){ job=null; refresh(); } }
  };
  el('method').onchange=el('bins').onchange=reset;
  el('cancel').onclick=()=>{reset();el('status').textContent='Calculation cancelled.';};
  return {reset,refresh};
}
