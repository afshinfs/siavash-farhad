// Source/result state is shared only with the local Earth Engine controller.
let hydroTimer=null,hydroSource=null,hydroSourceInfo=null,hydroWorker=null,hydroEpoch=0,hydroReport=null;
let hydroProducts=[],hydroURLs=[];
const hydroNames={dem_filled:'Filled DEM',flow_direction:'D8 flow direction',flowacc:'Flow accumulation',logflowacc:'Log flow accumulation',twi:'TWI'};
function hydroMessage(text,error=false){el('hydro-message').textContent=text;el('hydro-message').className=error?'ee-message error':'ee-message';}
function clearHydroProducts(){
  for(const url of hydroURLs)URL.revokeObjectURL(url);hydroURLs=[];hydroProducts=[];hydroReport=null;
  el('hydro-downloads').replaceChildren();el('hydro-preview').replaceChildren();el('hydro-report').disabled=true;el('hydro-layer').disabled=true;
  el('hydro-result').textContent='No hydrology layers computed yet.';
}
function stopHydro(){clearTimeout(hydroTimer);hydroTimer=null;hydroEpoch++;hydroWorker?.terminate();hydroWorker=null;el('hydro-run').disabled=!hydroSource;el('hydro-cancel').disabled=true;el('hydro-file').disabled=false;}
function setHydroSource(blob,info=null){
  stopHydro();clearHydroProducts();hydroSource=blob;hydroSourceInfo=info;
  el('hydro-source').textContent=blob?`DEM ready: ${info?.label||'retrieved elevation'} · ${(blob.size/1024).toFixed(1)} KB`:'Retrieve a DEM above or open a previously downloaded DEM.';
  el('hydro-run').disabled=!blob;hydroMessage(blob?'Elevation is ready for hydrological processing.':'Hydrology processing runs locally in your browser.');
}
function showHydroLayer(){
  const product=hydroProducts.find(p=>p.name===el('hydro-layer').value);if(!product||!hydroReport)return;
  const canvas=document.createElement('canvas');canvas.width=hydroReport.width;canvas.height=hydroReport.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(product.preview),canvas.width,canvas.height),0,0);
  canvas.setAttribute('aria-label',hydroNames[product.name]+' raster preview');el('hydro-preview').replaceChildren(canvas);
  const s=product.summary;
  el('hydro-result').textContent=`${hydroNames[product.name]}: ${s.min.toPrecision(5)} to ${s.max.toPrecision(5)} ${s.unit} · ${s.validCells.toLocaleString()} valid cells`;
}
async function runHydro(){
  if(!hydroSource)return;stopHydro();clearHydroProducts();const epoch=hydroEpoch;
  el('hydro-run').disabled=true;el('hydro-cancel').disabled=false;el('hydro-file').disabled=true;
  hydroMessage('Starting the hydro worker…');
  try{
    const buffer=await hydroSource.arrayBuffer();if(epoch!==hydroEpoch)return;
    const body='('+hydroWorkerMain.toString()+')('+computeHydrology.toString()+','+computeTerrain.toString()+');';
    const url=URL.createObjectURL(new Blob([body],{type:'text/javascript'}));hydroWorker=new Worker(url);URL.revokeObjectURL(url);
    const timeout=hydroTimer=setTimeout(()=>{if(epoch===hydroEpoch){stopHydro();hydroMessage('Hydrology processing timed out. Try a smaller area.',true);}},90000);
    hydroWorker.onmessage=({data})=>{
      if(epoch!==hydroEpoch)return;
      if(data.type==='progress'){hydroMessage(data.message);return;}
      clearTimeout(timeout);
      if(data.type==='error'){stopHydro();hydroMessage(data.message,true);return;}
      hydroProducts=data.products;hydroReport=data.report;
      for(const p of hydroProducts){
        const downloadURL=URL.createObjectURL(new Blob([p.tiff],{type:'image/tiff'}));hydroURLs.push(downloadURL);
        const link=document.createElement('a');link.href=downloadURL;link.download=p.name+'_aligned.tif';link.textContent='Download '+hydroNames[p.name];el('hydro-downloads').append(link);
      }
      el('hydro-report').disabled=false;el('hydro-layer').disabled=false;el('hydro-layer').value='flowacc';showHydroLayer();
      stopHydro();hydroMessage(`Hydrology layers computed in ${hydroReport.seconds.toFixed(2)} s. GeoTIFFs keep the DEM grid.`);
    };
    hydroWorker.onerror=()=>{if(epoch!==hydroEpoch)return;clearTimeout(timeout);stopHydro();hydroMessage('The hydro worker could not run. Check your connection and try again.',true);};
    hydroWorker.postMessage({buffer,source:hydroSourceInfo},[buffer]);
  }catch(error){if(epoch!==hydroEpoch)return;stopHydro();hydroMessage(String(error.message||error),true);}
}
el('hydro-file').addEventListener('change',()=>{
  const file=el('hydro-file').files[0];if(!file)return;
  if(file.size>8*1024*1024){hydroMessage('Use a DEM smaller than 8 MB.',true);return;}
  setHydroSource(file,{kind:'local file',label:file.name});
});
el('hydro-run').addEventListener('click',runHydro);
el('hydro-cancel').addEventListener('click',()=>{stopHydro();clearHydroProducts();hydroMessage('Hydrology processing cancelled.');});
el('hydro-layer').addEventListener('change',showHydroLayer);
el('hydro-report').addEventListener('click',()=>{
  if(!hydroReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(hydroReport,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='siavash-farhad-hydro-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
