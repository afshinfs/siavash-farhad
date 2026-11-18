// Source/result state is shared only with the local Earth Engine controller.
let linearTimer=null,linearSource=null,linearSourceInfo=null,linearWorker=null,linearEpoch=0,linearReport=null;
let linearProducts=[],linearURLs=[],linearVectors=null,linearMapLayer=null,linearOSMText=null;
const linearNames={river_distance:'Distance to rivers',road_distance:'Distance to major roads',river_density:'River density'};
function linearMessage(text,error=false){el('linear-message').textContent=text;el('linear-message').className=error?'ee-message error':'ee-message';}
function clearLinearProducts(){
  for(const url of linearURLs)URL.revokeObjectURL(url);linearURLs=[];linearProducts=[];linearReport=null;linearVectors=null;el('linear-vectors').disabled=true;if(linearMapLayer&&map)map.removeLayer(linearMapLayer);linearMapLayer=null;
  el('linear-downloads').replaceChildren();el('linear-preview').replaceChildren();el('linear-report').disabled=true;el('linear-layer').disabled=true;
  el('linear-result').textContent='No road/river predictors computed yet.';
}
function stopLinear(){clearTimeout(linearTimer);linearTimer=null;linearEpoch++;linearWorker?.terminate();linearWorker=null;el('linear-run').disabled=!linearSource;el('linear-cancel').disabled=true;el('linear-file').disabled=false;el('linear-osm-file').disabled=false;el('linear-live').disabled=false;el('linear-server').disabled=false;}
function setLinearSource(blob,info=null){
  stopLinear();clearLinearProducts();linearSource=blob;linearSourceInfo=info;
  el('linear-source').textContent=blob?`DEM ready: ${info?.label||'retrieved elevation'} · ${(blob.size/1024).toFixed(1)} KB`:'Retrieve a DEM above or open a previously downloaded DEM.';
  el('linear-run').disabled=!blob;linearMessage(blob?'DEM ready. Retrieve OSM features, or open saved OSM data.':'Road/river processing runs locally in your browser.');
}
function showLinearLayer(){
  const product=linearProducts.find(p=>p.name===el('linear-layer').value);if(!product||!linearReport)return;
  const canvas=document.createElement('canvas');canvas.width=linearReport.width;canvas.height=linearReport.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(product.preview),canvas.width,canvas.height),0,0);
  canvas.setAttribute('aria-label',linearNames[product.name]+' raster preview');el('linear-preview').replaceChildren(canvas);
  const s=product.summary;if(!s.validCells){el('linear-result').textContent=linearNames[product.name]+': no mapped features found; distance is NoData.';return;}
  el('linear-result').textContent=`${linearNames[product.name]}: ${s.min.toPrecision(5)} to ${s.max.toPrecision(5)} ${s.unit} · ${s.validCells.toLocaleString()} valid cells`;
}
async function runLinear(){
  if(!linearSource)return;stopLinear();clearLinearProducts();const epoch=linearEpoch;
  el('linear-run').disabled=true;el('linear-cancel').disabled=false;el('linear-file').disabled=true;el('linear-osm-file').disabled=true;el('linear-live').disabled=true;el('linear-server').disabled=true;
  linearMessage('Starting the linear worker…');
  try{
    const buffer=await linearSource.arrayBuffer();if(epoch!==linearEpoch)return;
    const body='('+linearWorkerMain.toString()+')('+computeLinear.toString()+','+retrieveOverpass.toString()+');';
    const url=URL.createObjectURL(new Blob([body],{type:'text/javascript'}));linearWorker=new Worker(url);URL.revokeObjectURL(url);
    const timeout=linearTimer=setTimeout(()=>{if(epoch===linearEpoch){stopLinear();linearMessage('Road/river processing timed out. Try a smaller area.',true);}},110000);
    linearWorker.onmessage=({data})=>{
      if(epoch!==linearEpoch)return;
      if(data.type==='progress'){linearMessage(data.message);return;}
      clearTimeout(timeout);
      if(data.type==='error'){stopLinear();linearMessage(data.message,true);return;}
      linearProducts=data.products;linearReport=data.report;linearVectors=data.vectors;el('linear-vectors').disabled=false;
      if(map&&window.L){linearMapLayer=window.L.geoJSON(linearVectors,{style:f=>({color:f.properties.kind==='river'?'#267ab2':'#b16e28',weight:3,opacity:0.9})}).addTo(map);}
      for(const p of linearProducts){
        const downloadURL=URL.createObjectURL(new Blob([p.tiff],{type:'image/tiff'}));linearURLs.push(downloadURL);
        const link=document.createElement('a');link.href=downloadURL;link.download=p.name+'_aligned.tif';link.textContent='Download '+linearNames[p.name];el('linear-downloads').append(link);
      }
      el('linear-report').disabled=false;el('linear-layer').disabled=false;el('linear-layer').value='river_distance';showLinearLayer();
      stopLinear();linearMessage(`Road/river layers computed in ${linearReport.seconds.toFixed(2)} s. ${linearReport.featureCounts.rivers} river lines · ${linearReport.featureCounts.roads} major-road lines. ${linearReport.warnings.join(' ')}`);
    };
    linearWorker.onerror=()=>{if(epoch!==linearEpoch)return;clearTimeout(timeout);stopLinear();linearMessage('The linear worker could not run. Check your connection and try again.',true);};
    linearWorker.postMessage({buffer,source:linearSourceInfo,osmText:linearOSMText,server:el('linear-server').value},[buffer]);
  }catch(error){if(epoch!==linearEpoch)return;stopLinear();linearMessage(String(error.message||error),true);}
}
el('linear-file').addEventListener('change',()=>{
  const file=el('linear-file').files[0];if(!file)return;
  if(file.size>8*1024*1024){linearMessage('Use a DEM smaller than 8 MB.',true);return;}
  setLinearSource(file,{kind:'local file',label:file.name});
});
el('linear-run').addEventListener('click',runLinear);
el('linear-cancel').addEventListener('click',()=>{stopLinear();clearLinearProducts();linearMessage('Road/river processing cancelled.');});
el('linear-layer').addEventListener('change',showLinearLayer);
el('linear-report').addEventListener('click',()=>{
  if(!linearReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(linearReport,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='siavash-farhad-linear-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});

el('linear-osm-file').addEventListener('change',async()=>{
  const file=el('linear-osm-file').files[0];if(!file)return;
  if(file.size>20*1024*1024){linearMessage('Use an OSM file smaller than 20 MB.',true);return;}
  stopLinear();clearLinearProducts();const epoch=linearEpoch;linearOSMText=null;
  try{const text=await file.text();if(epoch!==linearEpoch)return;JSON.parse(text);linearOSMText=text;el('linear-osm-source').textContent='OSM source: '+file.name;linearMessage('Saved OSM data selected. Calculate using the DEM grid.');}
  catch(e){if(epoch===linearEpoch)linearMessage('Could not read the OSM JSON file: '+e.message,true);}
});
el('linear-live').addEventListener('click',()=>{stopLinear();clearLinearProducts();linearOSMText=null;el('linear-osm-file').value='';el('linear-osm-source').textContent='OSM source: live Overpass API';linearMessage('Live OSM source selected.');});
el('linear-vectors').addEventListener('click',()=>{if(!linearVectors)return;const blob=new Blob([JSON.stringify(linearVectors)],{type:'application/geo+json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='siavash-roads-rivers.geojson';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});

el('linear-server').addEventListener('change',()=>{stopLinear();clearLinearProducts();linearMessage('OSM server selected. Calculate to retrieve features.');});
