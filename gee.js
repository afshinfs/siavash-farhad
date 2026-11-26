import { createRiskPanel } from './risk.mjs?v=gap-size';
import { showStudyArea, appendRasterCard, rangeLegend } from './raster-cards.mjs?v=gap-size';
import { createHazardPanel } from './hazard.mjs?v=gap-size';
import { createMLStackPanel } from './ml-stack.mjs?v=automatic-folds';
import { createWeaklinePanel, screenWeaklines, compareWeaklineClosure } from './weaklines.mjs?v=gap-size';
import { createFloodDepthPanel } from './flood-depth.mjs?v=gap-size';

// Pure request and validation logic; also included in the deployed gee.js bundle.
const DATASET = 'USGS/SRTMGL1_003';
const EE_SCOPE = 'https://www.googleapis.com/auth/earthengine.readonly';
const MAX_AREA_KM2 = 25;
const MAX_DIMENSION = 512;
function validateBounds(bounds) {
  const b = Object.fromEntries(['west','south','east','north'].map(k=>[k,Number(bounds[k])]));
  if (Object.values(b).some(v=>!Number.isFinite(v)) || Object.values(bounds).some(v=>(typeof v === 'string' && v.trim() === '') || v === null)) throw new Error('Enter four finite coordinates.');
  if (b.west < -180 || b.east > 180 || b.west >= b.east || b.south >= b.north) throw new Error('Use west < east and south < north, without crossing the date line.');
  if (b.south < -56 || b.north > 60) throw new Error('This SRTM test supports latitudes from 56°S to 60°N.');
  const rad=Math.PI/180;
  const areaKm2=6371.0088**2 * Math.abs(Math.sin(b.north*rad)-Math.sin(b.south*rad)) * (b.east-b.west)*rad;
  if (areaKm2 > MAX_AREA_KM2) throw new Error('Select a smaller rectangle (maximum 25 km² for this test).');
  return {...b, areaKm2};
}
function validateProject(project) {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error('Enter a valid Google Cloud project ID, not a project name or number.');
  return project;
}
function validateClientId(id) {
  if (!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('Enter a Web OAuth client ID ending in .apps.googleusercontent.com.');
  return id;
}
function makeGrid(bounds, projectPoint) {
  const b=validateBounds(bounds), lon=(b.west+b.east)/2, lat=(b.south+b.north)/2;
  const zone=Math.min(60,Math.max(1,Math.floor((lon+180)/6)+1));
  const crsCode=`EPSG:${(lat<0?32700:32600)+zone}`;
  const projection=`+proj=utm +zone=${zone} ${lat<0?'+south ':''}+datum=WGS84 +units=m +no_defs`;
  const points=[];
  for(let i=0;i<=8;i++) {
    const x=b.west+(b.east-b.west)*i/8, y=b.south+(b.north-b.south)*i/8;
    for(const p of [[x,b.south],[x,b.north],[b.west,y],[b.east,y]]) points.push(projectPoint(projection,p));
  }
  if(points.some(p=>!p.every(Number.isFinite))) throw new Error('Could not project this study area.');
  const left=Math.floor(Math.min(...points.map(p=>p[0]))/30)*30;
  const right=Math.ceil(Math.max(...points.map(p=>p[0]))/30)*30;
  const bottom=Math.floor(Math.min(...points.map(p=>p[1]))/30)*30;
  const top=Math.ceil(Math.max(...points.map(p=>p[1]))/30)*30;
  const width=Math.round((right-left)/30), height=Math.round((top-bottom)/30);
  if(width<1||height<1||width>MAX_DIMENSION||height>MAX_DIMENSION) throw new Error('Use a smaller or less elongated rectangle (maximum 512 cells on each side).');
  return {dimensions:{width,height},crsCode,affineTransform:{scaleX:30,shearX:0,translateX:left,shearY:0,scaleY:-30,translateY:top}};
}
function buildRequest(grid) {
  return {expression:{result:'dem',values:{dem:{functionInvocationValue:{functionName:'Image.load',arguments:{id:{constantValue:DATASET}}}}}},
    fileFormat:'GEO_TIFF',bandIds:['elevation'],grid};
}
function safeError(message) {
  return String(message).replace(/ya29\.[\w.-]+/g,'[redacted]').slice(0,500);
}
async function fetchDem({project,token,grid,signal,fetchImpl=fetch}) {
  validateProject(project);
  if(!token) throw new Error('Connect your Google account first.');
  const response=await fetchImpl(`https://earthengine.googleapis.com/v1/projects/${project}/image:computePixels`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(buildRequest(grid)),signal,
  });
  if(!response.ok) {
    let message='';try{message=(await response.json()).error?.message || '';}catch{}
    const advice={401:'Google access has expired. Disconnect and connect again.',403:'Check Earth Engine registration, API enablement and permissions for this project.',429:'Earth Engine quota exceeded. Wait and try again.'}[response.status] || 'Earth Engine could not complete the request.';
    const error=new Error(`${advice}${message?' '+safeError(message):''}`);error.status=response.status;throw error;
  }
  if(Number(response.headers.get('Content-Length')||0)>4*1024*1024) throw new Error('DEM response exceeds the 4 MB prototype limit.');
  const buffer=await response.arrayBuffer();
  if(buffer.byteLength>4*1024*1024) throw new Error('DEM response exceeds the 4 MB prototype limit.');
  const a=new Uint8Array(buffer,0,Math.min(4,buffer.byteLength));
  if(a.length<4 || !((a[0]===73&&a[1]===73&&a[2]===42&&a[3]===0)||(a[0]===77&&a[1]===77&&a[2]===0&&a[3]===42))) throw new Error('Earth Engine returned an unexpected file format.');
  return buffer;
}

// Controller appended to the pure Earth Engine request module during packaging.
const el=id=>document.getElementById(id);
const PRESET={west:47.70,south:33.135,east:47.73,north:33.155};
let map, rectangle, drawingPreview, drawingAnchor, elevationLayer, selectionStart, drawing=false, selected, grid, token=null, expiresAt=0, connectedClient=null;
let requestController, inspector, demURL, resultReport, session=0, busy=false, pendingAuth=false, inspectionReject=null;
function message(text,isError=false) {el('ee-message').textContent=text;el('ee-message').className=isError?'ee-message error':'ee-message';}
function clearResult() {
  setTerrainSource(null);
  if(demURL) URL.revokeObjectURL(demURL);demURL=null;resultReport=null;
  el('ee-dem-download').hidden=true;el('ee-report-download').disabled=true;
  el('ee-result').textContent='No Earth Engine data retrieved yet.';el('ee-preview').replaceChildren();
  if(elevationLayer&&map){map.removeLayer(elevationLayer);elevationLayer=null;}
}
function clearAccess() {pendingAuth=false;token=null;expiresAt=0;connectedClient=null;session++;refresh();}
function stopRequest() {requestController?.abort();requestController=null;inspector?.terminate();inspector=null;if(inspectionReject){const reject=inspectionReject;inspectionReject=null;reject(new DOMException('Cancelled','AbortError'));}busy=false;refresh();}
const EE_SETUP_STORAGE_KEY = 'siavash-farhad:earth-engine-setup:v1';
function setupValues() {
  return { project: el('ee-project').value.trim(), clientId: el('ee-client').value.trim() };
}
function rememberStatus(text) {
  el('ee-remember-status').textContent = text;
}
function saveSetup(setup) {
  try {
    if (setup) localStorage.setItem(EE_SETUP_STORAGE_KEY, JSON.stringify(setup));
    else localStorage.removeItem(EE_SETUP_STORAGE_KEY);
    return true;
  } catch {
    rememberStatus(setup ? 'Browser storage is unavailable. The IDs could not be saved.'
      : 'Browser storage is unavailable. If the IDs reappear, clear this site’s browser data.');
    return false;
  }
}
function syncRememberedSetup() {
  let setup = null;
  if (el('ee-remember').checked) {
    const ids = setupValues();
    try {
      validateProject(ids.project);
      validateClientId(ids.clientId);
      setup = ids;
    } catch {
      // Save a complete, valid pair only.
    }
  }
  if (saveSetup(setup)) {
    rememberStatus(setup ? 'Setup saved on this browser.' : el('ee-remember').checked
      ? 'Enter both IDs to save your setup.' : '');
  }
}
function restoreSetup() {
  try {
    const raw = localStorage.getItem(EE_SETUP_STORAGE_KEY);
    if (!raw) return;
    const { project, clientId } = JSON.parse(raw);
    if (typeof project !== 'string' || typeof clientId !== 'string') return;
    validateProject(project);
    validateClientId(clientId);
    el('ee-project').value = project;
    el('ee-client').value = clientId;
    el('ee-remember').checked = true;
    rememberStatus('Setup loaded from this browser.');
  } catch {
    // Corrupt or unavailable browser storage does not prevent Google sign-in.
  }
}
function disconnectSession() {
  stopRequest();
  clearAccess();
  clearResult();
  el('ee-state').textContent = 'Disconnected';
}
function disconnectAndForget() {
  el('ee-project').value = '';
  el('ee-client').value = '';
  el('ee-remember').checked = false;
  const removed = saveSetup(null);
  if (removed) rememberStatus('');
  disconnectSession();
  message(removed ? 'Earth Engine disconnected and setup cleared from this browser.'
    : 'Earth Engine disconnected and both fields cleared. The saved setup could not be removed.', !removed);
}
function refresh() {
  const connected=Boolean(token)&&Date.now()<expiresAt;
  queueMicrotask(() => { refreshSatellite(); exposurePanel.refresh(); floodDepthPanel.refresh(); });
  el('ee-connect').disabled=busy||pendingAuth;el('ee-disconnect').disabled=!token&&!busy&&!pendingAuth&&!el('ee-remember').checked&&
    !el('ee-project').value&&!el('ee-client').value;
  el('ee-fetch').disabled=!connected||!grid||busy||drawing;el('ee-cancel').disabled=!busy;
  for(const id of ['ee-client','ee-project','west','south','east','north','ee-apply','ee-preset','ee-aqqala','ee-draw']) el(id).disabled=busy;
}
function clearDrawingPreview() {
  if(drawingPreview&&map)map.removeLayer(drawingPreview);
  if(drawingAnchor&&map)map.removeLayer(drawingAnchor);
  drawingPreview=null;drawingAnchor=null;
}
function setDrawing(enabled) {
  clearDrawingPreview();drawing=enabled;selectionStart=null;
  if(map)map.getContainer().style.cursor=enabled?'crosshair':'';
  el('ee-draw').textContent=enabled?'Stop drawing':'Draw rectangle';refresh();
}
function updateDrawingPreview(latlng) {
  if(!drawing||busy||!selectionStart)return;
  const bounds=window.L.latLngBounds(selectionStart,latlng);
  if(drawingPreview)drawingPreview.setBounds(bounds);
  else drawingPreview=window.L.rectangle(bounds,{color:'#b77a18',weight:2,dashArray:'6 4',fillOpacity:0.12,interactive:false}).addTo(map);
}
function readBounds() {return Object.fromEntries(['west','south','east','north'].map(k=>[k,el(k).value]));}
function applyBounds(bounds,{fit=true}={}) {
  const b=validateBounds(bounds);
  if(!window.proj4) throw new Error('Projection library has not loaded. Check your connection and reload.');
  const nextGrid=makeGrid(b,(projection,point)=>window.proj4('EPSG:4326',projection,point));
  selected=b;grid=nextGrid;clearResult();el('ee-map-key').hidden=false;
  for(const k of ['west','south','east','north']) el(k).value=Number(b[k].toFixed(6));
  el('ee-area').textContent=`${b.areaKm2.toFixed(2)} km² · ${grid.dimensions.width} × ${grid.dimensions.height} cells · ${grid.crsCode}`;
  if(map) {
    if(rectangle) map.removeLayer(rectangle);
    rectangle=window.L.rectangle([[b.south,b.west],[b.north,b.east]],{color:'#197361',weight:2,fillOpacity:0.1}).addTo(map);
    if(fit)map.fitBounds(rectangle.getBounds(),{padding:[35,35]});
  }
  message('Study area selected. Connect Earth Engine to retrieve its elevation data.');refresh();
}
function loadScript(src,id) {
  return new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.id=id;script.src=src;script.async=true;
    const timeout=setTimeout(()=>{script.remove();reject(new Error('External library timed out. Check your connection and reload.'));},20000);
    script.onload=()=>{clearTimeout(timeout);resolve();};script.onerror=()=>{clearTimeout(timeout);reject(new Error('An external library could not load. Check your connection and reload.'));};document.head.append(script);
  });
}
function inspectRaster(buffer,expected) {
  // No account token enters this worker; it receives only raster bytes and expected grid.
  const workerCode=`
    importScripts('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js');
    self.onmessage=async({data})=>{try{
      const tiff=await GeoTIFF.fromArrayBuffer(data.buffer);const image=await tiff.getImage();
      const {width,height}=data.grid.dimensions;
      if(image.getWidth()!==width||image.getHeight()!==height)throw new Error('DEM dimensions do not match the requested grid.');
      if(image.getSamplesPerPixel()!==1)throw new Error('Expected one elevation band.');
      const keys=image.getGeoKeys();const epsg=keys.ProjectedCSTypeGeoKey;
      if(Number(epsg)!==Number(data.grid.crsCode.split(':')[1]))throw new Error('DEM CRS does not match the requested UTM grid.');
      const origin=image.getOrigin(),resolution=image.getResolution(),tr=data.grid.affineTransform;
      if(Math.abs(origin[0]-tr.translateX)>0.01||Math.abs(origin[1]-tr.translateY)>0.01||Math.abs(Math.abs(resolution[0])-30)>1e-5||Math.abs(Math.abs(resolution[1])-30)>1e-5)throw new Error('DEM pixel transform does not match the requested 30 m grid.');
      const values=await image.readRasters({samples:[0],interleave:true});const rawNodata=image.getGDALNoData();const nodata=rawNodata===null?null:Number(rawNodata);
      let count=0,sum=0,min=Infinity,max=-Infinity;
      for(const v of values)if(Number.isFinite(v)&&(nodata===null||v!==nodata)){count++;sum+=v;min=Math.min(min,v);max=Math.max(max,v);}
      if(!count)throw new Error('No valid SRTM elevation cells were returned for this area.');
      const rgba=new Uint8ClampedArray(width*height*4);
      for(let i=0;i<values.length;i++){const v=values[i];if(!Number.isFinite(v)||(nodata!==null&&v===nodata))continue;const x=max===min?0.5:(v-min)/(max-min);rgba.set([Math.round(40+190*x),Math.round(87+137*x),Math.round(82+80*x),255],i*4);}
      self.postMessage({ok:true,summary:{width,height,crs:data.grid.crsCode,resolutionMetres:30,nodata,validCells:count,minElevationM:min,maxElevationM:max,meanElevationM:sum/count},rgba:rgba.buffer},[rgba.buffer]);
    }catch(error){self.postMessage({ok:false,error:error.message});}};
  `;
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));inspector=new Worker(url);URL.revokeObjectURL(url);
    const timeout=setTimeout(()=>{inspector?.terminate();inspector=null;inspectionReject=null;reject(new Error('DEM inspection timed out. Try a smaller area.'));},45000);
    inspectionReject=error=>{clearTimeout(timeout);reject(error);};
    inspector.onmessage=({data})=>{clearTimeout(timeout);inspectionReject=null;inspector?.terminate();inspector=null;data.ok?resolve(data):reject(new Error(data.error));};
    inspector.onerror=()=>{clearTimeout(timeout);inspectionReject=null;inspector?.terminate();inspector=null;reject(new Error('DEM inspection worker could not run. Check your connection.'));};
    inspector.postMessage({buffer,grid:expected},[buffer]);
  });
}
function drawElevation(data,requestedGrid) {
  const {width,height}=requestedGrid.dimensions;
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.rgba),width,height),0,0);
  el('ee-preview').replaceChildren(canvas);canvas.setAttribute('aria-label','SRTM elevation preview; relative elevation colours');
  showStudyArea(el('ee-preview'), requestedGrid);
  el('ee-preview').append(rangeLegend(data.summary.minElevationM,data.summary.maxElevationM,'Elevation (m)'));
  // Keep the preview in its native UTM grid. Avoid draping a UTM image on a
  // latitude/longitude rectangle without reprojection.
}
async function retrieveDem() {
  const active=session;
  try {
    validateProject(el('ee-project').value.trim());
    if(!token||Date.now()>=expiresAt){clearAccess();throw new Error('Google access has expired. Connect again.');}
    applyBounds(readBounds(),{fit:false});busy=true;refresh();
    const requestedGrid=structuredClone(grid),bounds={...selected};const project=el('ee-project').value.trim();
    requestController=new AbortController();const timer=setTimeout(()=>requestController?.abort(),90000);const started=performance.now();
    el('ee-state').textContent='Retrieving DEM…';message('Requesting real SRTM elevation from Earth Engine.');
    let buffer;
    try {buffer=await fetchDem({project,token,grid:requestedGrid,signal:requestController.signal});}finally{clearTimeout(timer);}
    if(active!==session)return;
    const byteLength=buffer.byteLength;const blob=new Blob([buffer],{type:'image/tiff'});
    message('Elevation received. Checking GeoTIFF pixels and projection in your browser…');
    const data=await inspectRaster(buffer,requestedGrid);
    if(active!==session)return;
    setTerrainSource(blob,{kind:'Earth Engine',dataset:DATASET,project,label:'SRTM elevation',bounds});
    demURL=URL.createObjectURL(blob);el('ee-dem-download').href=demURL;el('ee-dem-download').hidden=false;
    resultReport={schemaVersion:1,status:'passed',source:'Earth Engine',dataset:DATASET,project,requestedBounds:bounds,grid:requestedGrid,
      raster:data.summary,bytes:byteLength,seconds:(performance.now()-started)/1000,retrievedAt:new Date().toISOString(),
      limitations:['SRTM retrieval and raster metadata checks only; no flood-depth, hazard or risk analysis.','Output covers a snapped UTM bounding grid; it is not a polygon mask.','SRTM uses its native Earth Engine sampling; terrain predictor generation is not included.']};
    drawElevation(data,requestedGrid);el('ee-result').textContent=`${data.summary.validCells.toLocaleString()} valid elevation cells · ${data.summary.minElevationM.toFixed(1)}–${data.summary.maxElevationM.toFixed(1)} m · 30 m UTM grid`;
    el('ee-report-download').disabled=false;el('ee-state').textContent='DEM retrieved';message('Real Earth Engine elevation is ready to inspect and download.');
  }catch(error){
    if(active!==session)return;
    if(error.name==='AbortError'){message('Request stopped or timed out. Earth Engine may finish the computation remotely.');el('ee-state').textContent='Request stopped';}
    else {if(error.status===401)clearAccess();message(safeError(error.message),true);el('ee-state').textContent='Retrieval failed';}
  }finally{if(active===session)stopRequest();}
}
el('ee-apply').addEventListener('click',()=>{try{setDrawing(false);applyBounds(readBounds());}catch(e){message(e.message,true);}});
el('ee-preset').addEventListener('click',()=>{try{setDrawing(false);applyBounds(PRESET);}catch(e){message(e.message,true);}});
el('ee-aqqala').addEventListener('click',()=>{try{setDrawing(false);applyBounds({west:54.44,south:37.002,east:54.47,north:37.022});}catch(e){message(e.message,true);}});
el('ee-draw').addEventListener('click',()=>{setDrawing(!drawing);message(drawing?'Click the first corner, then move the pointer to preview the rectangle.':'Rectangle selection stopped.');});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&drawing){setDrawing(false);message('Rectangle selection stopped.');}});
el('ee-connect').addEventListener('click',()=>{
  try {
    const clientId=validateClientId(el('ee-client').value.trim());validateProject(el('ee-project').value.trim());
    if(!window.google?.accounts?.oauth2)throw new Error('Google sign-in library has not loaded. Check your connection and reload.');
    clearAccess();clearResult();pendingAuth=true;refresh();el('ee-state').textContent='Connecting…';
    const active=session;
    const client=window.google.accounts.oauth2.initTokenClient({client_id:clientId,scope:EE_SCOPE,include_granted_scopes:false,
      callback:response=>{
        if(active!==session)return;
        if(response.error){clearAccess();el('ee-state').textContent='Connection failed';message(safeError(response.error_description||response.error),true);return;}
        if(!window.google.accounts.oauth2.hasGrantedAllScopes(response,EE_SCOPE)){clearAccess();el('ee-state').textContent='Permission needed';message('Earth Engine read-only permission was not granted.',true);return;}
        if(!response.access_token||!Number.isFinite(Number(response.expires_in))||Number(response.expires_in)<=30){clearAccess();message('Google returned an invalid or expired access session.',true);return;}
        pendingAuth=false;token=response.access_token;expiresAt=Date.now()+Math.max(0,Number(response.expires_in)*1000-30000);connectedClient=clientId;
        el('ee-state').textContent='Google access ready';message('Google access is ready. Retrieve the DEM to verify Earth Engine project access.');refresh();
      },error_callback:error=>{if(active!==session)return;clearAccess();el('ee-state').textContent='Not connected';message(error.type==='popup_closed'?'Google sign-in was closed.':'Google sign-in could not open. Allow its popup and try again.',true);},
    });
    client.requestAccessToken({prompt:'select_account'});
  }catch(error){clearAccess();el('ee-state').textContent='Setup required';message(safeError(error.message),true);}
});
restoreSetup();
el('ee-disconnect').addEventListener('click',disconnectAndForget);
el('ee-remember').addEventListener('change',()=>{
  syncRememberedSetup();
  refresh();
});
for(const id of ['ee-client','ee-project'])el(id).addEventListener('input',()=>{
  if(token||pendingAuth){
    disconnectSession();
    message('Connection settings changed. Connect again.');
  }
  if(el('ee-remember').checked)syncRememberedSetup();
  refresh();
});
el('ee-cancel').addEventListener('click',()=>{session++;stopRequest();clearResult();el('ee-state').textContent='Request stopped';message('Local request stopped. Earth Engine may finish the computation remotely.');});
el('ee-fetch').addEventListener('click',retrieveDem);
for(const id of ['west','south','east','north'])el(id).addEventListener('input',()=>{grid=null;clearResult();refresh();message('Apply the edited coordinates to select the study area.');});
el('ee-report-download').addEventListener('click',()=>{if(!resultReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(resultReport,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='siavash-farhad-earth-engine-dem.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
setInterval(()=>{if(token&&Date.now()>=expiresAt&&!busy){clearAccess();el('ee-state').textContent='Session expired';message('Google access expired. Connect again to retrieve more data.');}},1000);
async function startMap() {
  try {
    await Promise.all([loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js','leaflet-sdk'),loadScript('https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.js','proj4-sdk')]);
    window.dispatchEvent(new Event('study-map-libraries-ready'));
    map=window.L.map('ee-map',{zoomSnap:0.25});
    let firstView=true;
    const resize=new ResizeObserver(()=>{
      if (!el('ee-map').clientWidth || !el('ee-map').clientHeight) return;
      map.invalidateSize({pan:false});
      if(firstView){
        if (!selected) map.fitBounds([[25,44],[40,63.5]],{padding:[10,10]});
        else map.fitBounds(rectangle.getBounds(),{padding:[35,35]});
        firstView=false;
      }
    });
    resize.observe(el('ee-map'));
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'}).addTo(map);
    map.on('click',event=>{
      if(!drawing||busy)return;
      if(!selectionStart){selectionStart=event.latlng;drawingAnchor=window.L.circleMarker(selectionStart,{radius:4,color:'#b77a18',fillColor:'#fff',fillOpacity:1,weight:2,interactive:false}).addTo(map);updateDrawingPreview(selectionStart);message('Move the pointer to preview; click the opposite corner to finish, or press Escape to cancel.');return;}
      try{applyBounds({west:Math.min(selectionStart.lng,event.latlng.lng),east:Math.max(selectionStart.lng,event.latlng.lng),south:Math.min(selectionStart.lat,event.latlng.lat),north:Math.max(selectionStart.lat,event.latlng.lat)},{fit:false});}catch(e){message(e.message,true);}
      setDrawing(false);
    });
    map.on('mousemove',event=>updateDrawingPreview(event.latlng));
    el('ee-area').textContent='Choose an example or draw a study area (up to 25 km²).';
    if (!el('ee-message').classList.contains('error')) message('Zoom in to draw a rectangle, choose an example, or enter coordinates.');
  }catch(error){message(error.message,true);el('ee-state').textContent='Map unavailable';}
}
loadScript('https://accounts.google.com/gsi/client','google-identity-sdk').catch(error=>message('Google sign-in could not load. Check your connection and reload.',true));
startMap();refresh();

/**
 * Independent implementation of published Horn (1981) derivatives and
 * Zevenbergen–Thorne (1987) contour curvature. Native RichDEM is used only
 * as an external verification reference. No RichDEM code is bundled.
 */
function computeTerrain({values,width,height,dx,dy,nodata=null}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>512||height>512||values.length!==width*height)throw new Error('DEM dimensions are invalid or exceed 512 cells per side.');
  if(!Number.isFinite(dx)||!Number.isFinite(dy)||dx<=0||dy<=0||Math.abs(dx-dy)>1e-8)throw new Error('Terrain processing requires a square projected grid with metre units.');
  const size=width*height,dem=Float32Array.from(values),valid=new Uint8Array(size);
  const slope=new Float32Array(size),aspect=new Float32Array(size),plan_curvature=new Float32Array(size),trasp=new Float32Array(size);
  for(const layer of [slope,aspect,plan_curvature,trasp])layer.fill(-9999);
  let validCells=0,edgeAffectedCells=0;
  for(let i=0;i<size;i++)if(Number.isFinite(dem[i])&&(nodata===null||dem[i]!==nodata)){valid[i]=1;validCells++;}
  if(!validCells)throw new Error('The DEM has no valid elevation cells.');
  for(let row=0;row<height;row++)for(let col=0;col<width;col++) {
    const i=row*width+col;if(!valid[i])continue;
    const z=dem[i];let substituted=false;
    const sample=(x,y)=>{if(x<0||x>=width||y<0||y>=height||!valid[y*width+x]){substituted=true;return z;}return dem[y*width+x];};
    const nw=sample(col-1,row-1),n=sample(col,row-1),ne=sample(col+1,row-1);
    const w=sample(col-1,row),e=sample(col+1,row);
    const sw=sample(col-1,row+1),s=sample(col,row+1),se=sample(col+1,row+1);
    if(substituted)edgeAffectedCells++;
    // Horizontal derivative to the east; vertical derivative to the north.
    const eastGradient=((ne+2*e+se)-(nw+2*w+sw))/(8*dx);
    const northGradient=((nw+2*n+ne)-(sw+2*s+se))/(8*dy);
    slope[i]=Math.atan(Math.sqrt(eastGradient**2+northGradient**2))*180/Math.PI;
    // Compass direction of steepest descent. Preserve the reference's flat-cell
    // convention (270 degrees), including how TRASP is defined on those cells.
    let bearing;
    if(eastGradient===0&&northGradient===0)bearing=270;
    else {bearing=Math.atan2(-eastGradient,-northGradient)*180/Math.PI;if(bearing<0)bearing+=360;}
    aspect[i]=bearing;
    trasp[i]=(1-Math.cos((aspect[i]-30)*Math.PI/180))/2;
    // Curvature of the local elevation contour: Hessian along its unit tangent.
    const gx=(e-w)/(2*dx),gy=(n-s)/(2*dy),length=Math.sqrt(gx*gx+gy*gy);
    if(length===0)plan_curvature[i]=0;
    else {
      const tx=-gy/length,ty=gx/length;
      const dxx=(e-2*z+w)/(dx*dx),dyy=(n-2*z+s)/(dy*dy);
      const dxy=(ne-nw-se+sw)/(4*dx*dy);
      plan_curvature[i]=-100*(dxx*tx*tx+2*dxy*tx*ty+dyy*ty*ty);
    }
  }
  return {layers:{slope,aspect,plan_curvature,trasp},validCells,edgeAffectedCells,nodata:-9999};
}

/** Worker entry point. Receives only DEM bytes; never receives Google credentials. */
function terrainWorkerMain(computeTerrain) {
  importScripts('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js');
  function writeFloatTIFF(values,width,height,dx,dy,origin,epsg){
    // Baseline little-endian TIFF: one uncompressed float32 strip and explicit GeoKeys.
    const entries=[
      [256,4,[width]],[257,4,[height]],[258,3,[32]],[259,3,[1]],
      [262,3,[1]],[273,4,[0]],[277,3,[1]],[278,4,[height]],
      [279,4,[values.length*4]],[284,3,[1]],[339,3,[3]],
      [33550,12,[dx,dy,0]],[33922,12,[0,0,0,origin[0],origin[1],0]],
      [34735,3,[1,1,0,4,1024,0,1,1,1025,0,1,1,3072,0,1,epsg,3076,0,1,9001]],
      [42113,2,Array.from('-9999\0',c=>c.charCodeAt(0))]
    ];
    const sizes={2:1,3:2,4:4,12:8};let cursor=8+2+12*entries.length+4;
    for(const e of entries)if(e[2].length*sizes[e[1]]>4){e[3]=cursor;cursor+=e[2].length*sizes[e[1]];cursor=(cursor+7)&~7;}
    entries.find(e=>e[0]===273)[2][0]=cursor;
    const buffer=new ArrayBuffer(cursor+values.length*4),v=new DataView(buffer);
    v.setUint16(0,0x4949,true);v.setUint16(2,42,true);v.setUint32(4,8,true);v.setUint16(8,entries.length,true);
    entries.forEach((e,i)=>{const p=10+i*12;v.setUint16(p,e[0],true);v.setUint16(p+2,e[1],true);v.setUint32(p+4,e[2].length,true);
      const start=e[3]??(p+8);if(e[3]!==undefined)v.setUint32(p+8,e[3],true);
      e[2].forEach((n,j)=>{const q=start+j*sizes[e[1]];if(e[1]===2)v.setUint8(q,n);else if(e[1]===3)v.setUint16(q,n,true);else if(e[1]===4)v.setUint32(q,n,true);else v.setFloat64(q,n,true);});
    });
    values.forEach((n,i)=>v.setFloat32(cursor+i*4,n,true));return buffer;
  }
  self.onmessage=async({data})=>{
    try {
      const started=performance.now();
      self.postMessage({type:'progress',message:'Reading the elevation GeoTIFF…'});
      const hash=await crypto.subtle.digest('SHA-256',data.buffer);
      const sourceSHA256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
      const tiff=await GeoTIFF.fromArrayBuffer(data.buffer);
      if(await tiff.getImageCount()!==1)throw new Error('Use a single-image DEM without overview or internal mask images.');
      const image=await tiff.getImage(),keys=image.getGeoKeys(),fd=image.getFileDirectory();
      const epsg=Number(keys.ProjectedCSTypeGeoKey);
      if(!((epsg>=32601&&epsg<=32660)||(epsg>=32701&&epsg<=32760)))throw new Error('This stage requires a WGS84 UTM DEM in metre units.');
      const matrix=fd.ModelTransformation;
      const rotated=matrix&&(matrix[1]!==0||matrix[2]!==0||matrix[4]!==0||matrix[6]!==0);
      if(Number(keys.GTRasterTypeGeoKey||1)!==1||rotated||fd.SubIFDs)throw new Error('Use a north-up PixelIsArea GeoTIFF with no transformed or sub-image grid.');
      if(image.getSamplesPerPixel()!==1)throw new Error('The DEM must have one elevation band.');
      const width=image.getWidth(),height=image.getHeight(),origin=image.getOrigin(),resolution=matrix?[matrix[0],matrix[5],matrix[10]]:image.getResolution();
      if(width>512||height>512)throw new Error('Use a DEM no larger than 512 × 512 cells for this stage.');
      if(!Number.isFinite(origin[0])||!Number.isFinite(origin[1])||resolution[0]<=0||resolution[1]>=0)throw new Error('DEM origin or orientation is unsupported.');
      const rawNodata=image.getGDALNoData(),nodata=rawNodata===null?null:Number(rawNodata);
      const values=await image.readRasters({samples:[0],interleave:true});
      self.postMessage({type:'progress',message:'Computing slope, aspect, TRASP and planform curvature…'});
      const result=computeTerrain({values,width,height,dx:resolution[0],dy:Math.abs(resolution[1]),nodata});
      const products=[];const transfer=[];
      const units={slope:'degrees',aspect:'degrees clockwise from north',trasp:'dimensionless 0–1',plan_curvature:'1/metre ×100 (original scale)'};
      for(const [name,layer] of Object.entries(result.layers)) {
        self.postMessage({type:'progress',message:'Preparing '+name+' GeoTIFF…'});
        let min=Infinity,max=-Infinity,sum=0,count=0;
        for(const v of layer)if(v!==result.nodata&&Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);sum+=v;count++;}
        const preview=new Uint8ClampedArray(width*height*4);
        for(let i=0;i<layer.length;i++) {
          const v=layer[i];if(v===result.nodata||!Number.isFinite(v))continue;
          const f=max===min?.5:(v-min)/(max-min);
          preview.set([Math.round(40+190*f),Math.round(87+137*f),Math.round(82+80*f),255],i*4);
        }
        const output=writeFloatTIFF(layer,width,height,resolution[0],Math.abs(resolution[1]),origin,epsg);
        products.push({name,tiff:output,preview:preview.buffer,summary:{min,max,mean:sum/count,validCells:count,unit:units[name]}});
        transfer.push(output,preview.buffer);
      }
      self.postMessage({type:'complete',products,report:{schemaVersion:1,status:'passed',stage:'terrain attributes',
        sourceSHA256,source:data.source,width,height,crs:'EPSG:'+epsg,
        transform:{scaleX:resolution[0],scaleY:resolution[1],translateX:origin[0],translateY:origin[1]},
        nodata:result.nodata,validCells:result.validCells,edgeAffectedCells:result.edgeAffectedCells,
        methods:{slope:'Horn (1981)',aspect:'Horn (1981), flat-cell convention 270°',plan_curvature:'Zevenbergen–Thorne (1987), original ×100 scale',trasp:'(1 - cos(aspect - 30°))/2'},
        reference:{commit:'9a1c97bb2529e386451a7dd54768b8b74bb4d620',comparison:'Verified against external RichDEM C++ reference on synthetic fixtures and a live Poldokhtar DEM; original installed RichDEM version is unknown.'},
        products:Object.fromEntries(products.map(p=>[p.name,p.summary])),seconds:(performance.now()-started)/1000,
        limitations:['Terrain attributes only. Depression filling, flow accumulation, TWI and flood modelling are not included yet.',
          'Outside-grid and NoData neighbours use the centre elevation, matching the original reference. Boundary cells can be affected by AOI cropping.',
          'Reference comparisons do not establish terrain truth or full model accuracy.','Single-band, single-image, north-up WGS84 UTM square grids; scalar NoData only.']}},transfer);
    }catch(error){self.postMessage({type:'error',message:String(error.message||error)});}
  };
}

// Source/result state is shared only with the local Earth Engine controller.
let terrainTimer=null,terrainSource=null,terrainSourceInfo=null,terrainWorker=null,terrainEpoch=0,terrainReport=null;
let terrainProducts=[],terrainURLs=[];
const terrainNames={slope:'Slope',aspect:'Aspect',trasp:'TRASP',plan_curvature:'Planform curvature'};
function terrainMessage(text,error=false){el('terrain-message').textContent=text;el('terrain-message').className=error?'ee-message error':'ee-message';}
function clearTerrainProducts(){mlStackPanel.invalidate();
  for(const url of terrainURLs)URL.revokeObjectURL(url);terrainURLs=[];terrainProducts=[];terrainReport=null;
  el('terrain-cards').replaceChildren();
  el('terrain-report').disabled=true;
}
function stopTerrain(){clearTimeout(terrainTimer);terrainTimer=null;terrainEpoch++;terrainWorker?.terminate();terrainWorker=null;el('terrain-run').disabled=!terrainSource;el('terrain-cancel').disabled=true;el('terrain-file').disabled=false;}
function setTerrainSource(blob,info=null){
  setSatelliteSource(blob,info);
  exposurePanel.setSource(blob, info);
  floodDepthPanel.setSource(blob, info);
  setLinearSource(blob,info);
  setHydroSource(blob,info);
  stopTerrain();clearTerrainProducts();terrainSource=blob;terrainSourceInfo=info;
  mlStackPanel.refresh();
  weaklinePanel.refresh();
  hazardPanel.refresh();
  el('terrain-source').textContent=blob?`DEM ready: ${info?.label||'retrieved elevation'} · ${(blob.size/1024).toFixed(1)} KB`:'Retrieve a DEM under Study area or open a downloaded DEM here.';
  el('terrain-run').disabled=!blob;terrainMessage(blob?'Elevation is ready for terrain processing.':'Terrain processing runs locally in your browser.');
}
async function runTerrain(){
  if(!terrainSource)return;stopTerrain();clearTerrainProducts();const epoch=terrainEpoch;
  el('terrain-run').disabled=true;el('terrain-cancel').disabled=false;el('terrain-file').disabled=true;
  terrainMessage('Starting the terrain worker…');
  try{
    const buffer=await terrainSource.arrayBuffer();if(epoch!==terrainEpoch)return;
    const body='('+terrainWorkerMain.toString()+')('+computeTerrain.toString()+');';
    const url=URL.createObjectURL(new Blob([body],{type:'text/javascript'}));terrainWorker=new Worker(url);URL.revokeObjectURL(url);
    const timeout=terrainTimer=setTimeout(()=>{if(epoch===terrainEpoch){stopTerrain();terrainMessage('Terrain processing timed out. Try a smaller area.',true);}},90000);
    terrainWorker.onmessage=({data})=>{
      if(epoch!==terrainEpoch)return;
      if(data.type==='progress'){terrainMessage(data.message);return;}
      clearTimeout(timeout);
      if(data.type==='error'){stopTerrain();terrainMessage(data.message,true);return;}
      terrainProducts=data.products;terrainReport=data.report;mlStackPanel.invalidate();
      for(const p of terrainProducts){
        const downloadURL=URL.createObjectURL(new Blob([p.tiff],{type:'image/tiff'}));terrainURLs.push(downloadURL);
        appendRasterCard(el('terrain-cards'), p, {
          grid: terrainReport,
          label: terrainNames[p.name], width: terrainReport.width, height: terrainReport.height,
          url: downloadURL, filename: p.name + '_aligned.tif',
        });
      }
      el('terrain-report').disabled=false;
      stopTerrain();terrainMessage(`Four terrain predictors computed in ${terrainReport.seconds.toFixed(2)} s. GeoTIFFs keep the DEM grid.`);
    };
    terrainWorker.onerror=()=>{if(epoch!==terrainEpoch)return;clearTimeout(timeout);stopTerrain();terrainMessage('The terrain worker could not run. Check your connection and try again.',true);};
    terrainWorker.postMessage({buffer,source:terrainSourceInfo},[buffer]);
  }catch(error){if(epoch!==terrainEpoch)return;stopTerrain();terrainMessage(String(error.message||error),true);}
}
el('terrain-file').addEventListener('change',()=>{
  const file=el('terrain-file').files[0];if(!file)return;
  if(file.size>8*1024*1024){terrainMessage('Use a DEM smaller than 8 MB.',true);return;}
  setTerrainSource(file,{kind:'local file',label:file.name});
});
el('terrain-run').addEventListener('click',runTerrain);
el('terrain-cancel').addEventListener('click',()=>{stopTerrain();clearTerrainProducts();terrainMessage('Terrain processing cancelled.');});

el('terrain-report').addEventListener('click',()=>{
  if(!terrainReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(terrainReport,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='siavash-farhad-terrain-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});


/** Deterministic Priority-Flood filling and D8 routing on a north-up metre grid.
 * Flats follow the flood discovery tree, without artificial elevation increments.
 * NoData holes and raster edges are open drainage boundaries.
 */
function computeHydrology(input, computeTerrain) {
  const {values,width,height,dx,dy,nodata=null}=input;
  // The terrain kernel validates dimensions, resolution, and valid elevations.
  const terrain=computeTerrain(input), size=width*height, missing=-9999;
  const valid=new Uint8Array(size),seen=new Uint8Array(size),parent=new Int32Array(size);
  const filled=new Float32Array(size),direction=new Float32Array(size),acc=new Float32Array(size);
  const downstream=new Int32Array(size);parent.fill(-1);downstream.fill(-1);
  const moves=[[1,0,1],[1,1,2],[0,1,4],[-1,1,8],[-1,0,16],[-1,-1,32],[0,-1,64],[1,-1,128]];
  for(let i=0;i<size;i++){valid[i]=Number.isFinite(values[i])&&(nodata===null||values[i]!==nodata);filled[i]=valid[i]?values[i]:missing;direction[i]=valid[i]?0:missing;acc[i]=valid[i]?1:missing;}
  // Stable min heap: elevation first, insertion order second.
  const heap=[];let serial=0;
  const less=(a,b)=>a.z<b.z||(a.z===b.z&&a.order<b.order);
  function push(i){const a={i,z:filled[i],order:serial++};let k=heap.length;heap.push(a);while(k){const p=(k-1)>>1;if(!less(a,heap[p]))break;heap[k]=heap[p];k=p;}heap[k]=a;}
  function pop(){const result=heap[0],last=heap.pop();if(heap.length){let k=0;while(2*k+1<heap.length){let c=2*k+1;if(c+1<heap.length&&less(heap[c+1],heap[c]))c++;if(!less(heap[c],last))break;heap[k]=heap[c];k=c;}heap[k]=last;}return result.i;}
  function neighbours(i,fn){const x=i%width,y=Math.floor(i/width);for(const [ox,oy,code] of moves){const nx=x+ox,ny=y+oy;fn(nx>=0&&nx<width&&ny>=0&&ny<height?ny*width+nx:-1,ox,oy,code);}}
  let boundaryCells=0;
  for(let i=0;i<size;i++)if(valid[i]){let edge=false;neighbours(i,j=>{if(j<0||!valid[j])edge=true;});if(edge){seen[i]=1;push(i);boundaryCells++;}}
  let visited=0;
  while(heap.length){const i=pop();visited++;neighbours(i,j=>{if(j<0||!valid[j]||seen[j])return;seen[j]=1;parent[j]=i;filled[j]=Math.max(filled[j],filled[i]);push(j);});}
  if(visited!==terrain.validCells)throw new Error('Drainage traversal did not reach every valid cell.');
  let filledCells=0,maxFillDepth=0,flatRoutedCells=0;
  for(let i=0;i<size;i++)if(valid[i]){
    const depth=filled[i]-values[i];if(depth>0){filledCells++;maxFillDepth=Math.max(maxFillDepth,depth);}
    let best=0,target=-1,code=0;
    neighbours(i,(j,ox,oy,c)=>{if(j<0||!valid[j])return;const gradient=(filled[i]-filled[j])/Math.hypot(ox*dx,oy*dy);if(gradient>best){best=gradient;target=j;code=c;}});
    if(target<0&&parent[i]>=0){target=parent[i];flatRoutedCells++;neighbours(i,(j,ox,oy,c)=>{if(j===target)code=c;});}
    downstream[i]=target;direction[i]=code;
  }
  // Topological accumulation detects cycles and conserves the unit cell weights.
  const indegree=new Uint8Array(size),queue=new Int32Array(size);let start=0,end=0;
  for(let i=0;i<size;i++)if(valid[i]&&downstream[i]>=0)indegree[downstream[i]]++;
  for(let i=0;i<size;i++)if(valid[i]&&!indegree[i])queue[end++]=i;
  let processed=0,outlets=0,outletWeight=0;
  while(start<end){const i=queue[start++],j=downstream[i];processed++;if(j>=0){acc[j]+=acc[i];if(--indegree[j]===0)queue[end++]=j;}else{outlets++;outletWeight+=acc[i];}}
  if(processed!==terrain.validCells||outletWeight!==terrain.validCells)throw new Error('Drainage routing failed its cycle or accumulation conservation check.');
  const twi=new Float32Array(size),logflowacc=new Float32Array(size);twi.fill(missing);logflowacc.fill(missing);
  for(let i=0;i<size;i++)if(valid[i]){const slope=Math.min(89.9,Math.max(0,terrain.layers.slope[i]));twi[i]=Math.log((acc[i]+1)/(Math.tan(slope*Math.PI/180)+1e-3));logflowacc[i]=Math.log1p(acc[i]);}
  return {layers:{dem_filled:filled,flow_direction:direction,flowacc:acc,logflowacc,twi},nodata:missing,validCells:terrain.validCells,
    diagnostics:{boundaryCells,filledCells,maxFillDepth,flatRoutedCells,outlets,outletWeight,processedCells:processed,conservationPassed:true}};
}

/** Worker entry point. Receives only DEM bytes; never receives Google credentials. */
function hydroWorkerMain(computeHydrology, computeTerrain) {
  importScripts('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js');
  function writeFloatTIFF(values,width,height,dx,dy,origin,epsg){
    // Baseline little-endian TIFF: one uncompressed float32 strip and explicit GeoKeys.
    const entries=[
      [256,4,[width]],[257,4,[height]],[258,3,[32]],[259,3,[1]],
      [262,3,[1]],[273,4,[0]],[277,3,[1]],[278,4,[height]],
      [279,4,[values.length*4]],[284,3,[1]],[339,3,[3]],
      [33550,12,[dx,dy,0]],[33922,12,[0,0,0,origin[0],origin[1],0]],
      [34735,3,[1,1,0,4,1024,0,1,1,1025,0,1,1,3072,0,1,epsg,3076,0,1,9001]],
      [42113,2,Array.from('-9999\0',c=>c.charCodeAt(0))]
    ];
    const sizes={2:1,3:2,4:4,12:8};let cursor=8+2+12*entries.length+4;
    for(const e of entries)if(e[2].length*sizes[e[1]]>4){e[3]=cursor;cursor+=e[2].length*sizes[e[1]];cursor=(cursor+7)&~7;}
    entries.find(e=>e[0]===273)[2][0]=cursor;
    const buffer=new ArrayBuffer(cursor+values.length*4),v=new DataView(buffer);
    v.setUint16(0,0x4949,true);v.setUint16(2,42,true);v.setUint32(4,8,true);v.setUint16(8,entries.length,true);
    entries.forEach((e,i)=>{const p=10+i*12;v.setUint16(p,e[0],true);v.setUint16(p+2,e[1],true);v.setUint32(p+4,e[2].length,true);
      const start=e[3]??(p+8);if(e[3]!==undefined)v.setUint32(p+8,e[3],true);
      e[2].forEach((n,j)=>{const q=start+j*sizes[e[1]];if(e[1]===2)v.setUint8(q,n);else if(e[1]===3)v.setUint16(q,n,true);else if(e[1]===4)v.setUint32(q,n,true);else v.setFloat64(q,n,true);});
    });
    values.forEach((n,i)=>v.setFloat32(cursor+i*4,n,true));return buffer;
  }
  self.onmessage=async({data})=>{
    try {
      const started=performance.now();
      self.postMessage({type:'progress',message:'Reading the elevation GeoTIFF…'});
      const hash=await crypto.subtle.digest('SHA-256',data.buffer);
      const sourceSHA256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
      const tiff=await GeoTIFF.fromArrayBuffer(data.buffer);
      if(await tiff.getImageCount()!==1)throw new Error('Use a single-image DEM without overview or internal mask images.');
      const image=await tiff.getImage(),keys=image.getGeoKeys(),fd=image.getFileDirectory();
      const epsg=Number(keys.ProjectedCSTypeGeoKey);
      if(!((epsg>=32601&&epsg<=32660)||(epsg>=32701&&epsg<=32760)))throw new Error('This stage requires a WGS84 UTM DEM in metre units.');
      const matrix=fd.ModelTransformation;
      const rotated=matrix&&(matrix[1]!==0||matrix[2]!==0||matrix[4]!==0||matrix[6]!==0);
      if(Number(keys.GTRasterTypeGeoKey||1)!==1||rotated||fd.SubIFDs)throw new Error('Use a north-up PixelIsArea GeoTIFF with no transformed or sub-image grid.');
      if(image.getSamplesPerPixel()!==1)throw new Error('The DEM must have one elevation band.');
      const width=image.getWidth(),height=image.getHeight(),origin=image.getOrigin(),resolution=matrix?[matrix[0],matrix[5],matrix[10]]:image.getResolution();
      if(width>512||height>512)throw new Error('Use a DEM no larger than 512 × 512 cells for this stage.');
      if(!Number.isFinite(origin[0])||!Number.isFinite(origin[1])||resolution[0]<=0||resolution[1]>=0)throw new Error('DEM origin or orientation is unsupported.');
      const rawNodata=image.getGDALNoData(),nodata=rawNodata===null?null:Number(rawNodata);
      const values=await image.readRasters({samples:[0],interleave:true});
      self.postMessage({type:'progress',message:'Filling depressions and routing D8 flow…'});
      const result=computeHydrology({values,width,height,dx:resolution[0],dy:Math.abs(resolution[1]),nodata},computeTerrain);
      const products=[];const transfer=[];
      const units={dem_filled:'metres',flow_direction:'D8 code (0 = outlet)',flowacc:'contributing cells, including self',logflowacc:'ln(1 + contributing cells)',twi:'count-based index (desktop formula)'};
      const d8=[[142,142,142],[215,48,39],[252,141,89],[254,224,144],[145,207,96],[26,152,80],[50,136,189],[81,73,164],[179,88,165]];
      for(const [name,layer] of Object.entries(result.layers)) {
        self.postMessage({type:'progress',message:'Preparing '+name+' GeoTIFF…'});
        let min=Infinity,max=-Infinity,sum=0,count=0;
        for(const v of layer)if(v!==result.nodata&&Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);sum+=v;count++;}
        const preview=new Uint8ClampedArray(width*height*4);
        for(let i=0;i<layer.length;i++) {
          const v=layer[i];if(v===result.nodata||!Number.isFinite(v))continue;
          const f=max===min?.5:(name==='flowacc'?Math.log1p(v-min)/Math.log1p(max-min):(v-min)/(max-min));
          const rgb=name==='flow_direction'?d8[v===0?0:1+Math.log2(v)]:[Math.round(40+190*f),Math.round(87+137*f),Math.round(82+80*f)];
          preview.set([...rgb,255],i*4);
        }
        const output=writeFloatTIFF(layer,width,height,resolution[0],Math.abs(resolution[1]),origin,epsg);
        products.push({name,tiff:output,preview:preview.buffer,summary:{min,max,mean:sum/count,validCells:count,unit:units[name]}});
        transfer.push(output,preview.buffer);
      }
      self.postMessage({type:'complete',products,report:{schemaVersion:1,status:'passed',stage:'hydrological terrain processing',
        sourceSHA256,source:data.source,width,height,crs:'EPSG:'+epsg,
        transform:{scaleX:resolution[0],scaleY:resolution[1],translateX:origin[0],translateY:origin[1]},
        nodata:result.nodata,validCells:result.validCells,diagnostics:result.diagnostics,
        methods:{fill:'Priority-Flood, eight neighbours, no epsilon elevation changes',routing:'D8 steepest descent; equal gradients prefer E, SE, S, SW, W, NW, N, NE; flats follow flood discovery parent',flowacc:'Unit weights including each cell itself',twi:'ln((flowacc + 1) / (tan(original DEM Horn slope, clipped to 0–89.9 degrees) + 0.001))',logflowacc:'ln(1 + flowacc)'},
        directionCodes:{E:1,SE:2,S:4,SW:8,W:16,NW:32,N:64,NE:128,outlet:0},
        products:Object.fromEntries(products.map(p=>[p.name,p.summary])),seconds:(performance.now()-started)/1000,
        limitations:['Raster edges and NoData holes are open boundaries. Upslope catchments outside this DEM are omitted; use a buffered DEM.',
          'Flat routing differs from RichDEM epsilon filling. This browser stage is not yet numerically equivalent to the desktop hydrology pipeline.',
          'TWI preserves the desktop count-based formula; it does not use contributing area in square metres or specific catchment area.',
          'This is terrain drainage routing, not a flood simulation. Flat-cell drainage paths depend on the deterministic tie rule.',
          'Single-band, single-image, north-up WGS84 UTM square grids; scalar NoData only.' ]}},transfer);
    }catch(error){self.postMessage({type:'error',message:String(error.message||error)});}
  };
}

// Source/result state is shared only with the local Earth Engine controller.
let hydroTimer=null,hydroSource=null,hydroSourceInfo=null,hydroWorker=null,hydroEpoch=0,hydroReport=null;
let hydroProducts=[],hydroURLs=[];
const hydroNames={dem_filled:'Filled DEM',flow_direction:'D8 flow direction',flowacc:'Flow accumulation',logflowacc:'Log flow accumulation',twi:'TWI'};
function hydroMessage(text,error=false){el('hydro-message').textContent=text;el('hydro-message').className=error?'ee-message error':'ee-message';}
function clearHydroProducts(){mlStackPanel.invalidate();
  for(const url of hydroURLs)URL.revokeObjectURL(url);hydroURLs=[];hydroProducts=[];hydroReport=null;
  el('hydro-cards').replaceChildren();
  el('hydro-report').disabled=true;
}
function stopHydro(){clearTimeout(hydroTimer);hydroTimer=null;hydroEpoch++;hydroWorker?.terminate();hydroWorker=null;el('hydro-run').disabled=!hydroSource;el('hydro-cancel').disabled=true;el('hydro-file').disabled=false;}
function setHydroSource(blob,info=null){
  stopHydro();clearHydroProducts();hydroSource=blob;hydroSourceInfo=info;
  el('hydro-source').textContent=blob?`DEM ready: ${info?.label||'retrieved elevation'} · ${(blob.size/1024).toFixed(1)} KB`:'Retrieve a DEM under Study area or open a downloaded DEM here.';
  el('hydro-run').disabled=!blob;hydroMessage(blob?'Elevation is ready for hydrological processing.':'Hydrology processing runs locally in your browser.');
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
      hydroProducts=data.products;hydroReport=data.report;mlStackPanel.invalidate();
      for(const p of hydroProducts){
        const downloadURL=URL.createObjectURL(new Blob([p.tiff],{type:'image/tiff'}));hydroURLs.push(downloadURL);
        appendRasterCard(el('hydro-cards'), p, {
          grid: hydroReport,
          label: hydroNames[p.name], width: hydroReport.width, height: hydroReport.height,
          url: downloadURL, filename: p.name + '_aligned.tif',
        });
      }
      el('hydro-report').disabled=false;
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

el('hydro-report').addEventListener('click',()=>{
  if(!hydroReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(hydroReport,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='siavash-farhad-hydro-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});


/** Buffered line rasterisation, exact Euclidean raster distance and smoothed river fraction. */
function computeLinear({values,width,height,dx,dy,nodata=null,origin,roads,rivers,bufferMetres=1000,densityWindowMetres=200}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>512||height>512||values.length!==width*height)throw Error('Use a DEM up to 512 × 512 cells.');
  if(!Number.isFinite(dx)||dx<=0||!Number.isFinite(dy)||dy<=0||Math.abs(dx-dy)>1e-8||!origin?.slice(0,2).every(Number.isFinite))throw Error('Use a square metre grid with a finite origin.');
  if(dx<10||dx>100)throw Error('Use 10–100 m pixels for roads and rivers.');
  if(bufferMetres!==1000||densityWindowMetres!==200)throw Error('This stage uses a 1,000 m search buffer and 200 m density window.');
  const pad=Math.ceil(bufferMetres/dx),w=width+2*pad,h=height+2*pad;
  if(w*h>4000000)throw Error('Use a DEM resolution of at least 2 m for buffered processing.');
  const ox=origin[0]-pad*dx,oy=origin[1]+pad*dy,radius=Math.max(5,dx/2),size=w*h;
  // Segment-to-rectangle squared distance. Intersection gives zero; otherwise
  // the minimum occurs at an endpoint-to-box or corner-to-segment pair.
  function pointSegment(x,y,a,b){const vx=b[0]-a[0],vy=b[1]-a[1],l=vx*vx+vy*vy,t=l?Math.max(0,Math.min(1,((x-a[0])*vx+(y-a[1])*vy)/l)):0;return (x-a[0]-t*vx)**2+(y-a[1]-t*vy)**2;}
  function touches(a,b,l,t,r,bot){
    let lo=0,hi=1;const vx=b[0]-a[0],vy=b[1]-a[1];
    for(const [p,q] of [[-vx,a[0]-l],[vx,r-a[0]],[-vy,a[1]-bot],[vy,t-a[1]]]){if(p===0){if(q<0){lo=2;break;}}else{const u=q/p;if(p<0)lo=Math.max(lo,u);else hi=Math.min(hi,u);}}
    if(lo<=hi)return true;
    const box=(p)=>Math.max(l-p[0],0,p[0]-r)**2+Math.max(bot-p[1],0,p[1]-t)**2;
    return Math.min(box(a),box(b),pointSegment(l,t,a,b),pointSegment(r,t,a,b),pointSegment(l,bot,a,b),pointSegment(r,bot,a,b))<=radius*radius+1e-8;
  }
  function burn(lines){const mask=new Uint8Array(size);let segments=0;
    for(const line of lines)for(let k=1;k<line.length;k++){
      const a=line[k-1],b=line[k];if(!a?.every(Number.isFinite)||!b?.every(Number.isFinite))throw Error('Line coordinates must be finite.');segments++;
      const x0=Math.max(0,Math.ceil((Math.min(a[0],b[0])-radius-ox)/dx)-1),x1=Math.min(w-1,Math.floor((Math.max(a[0],b[0])+radius-ox)/dx));
      const y0=Math.max(0,Math.ceil((oy-Math.max(a[1],b[1])-radius)/dy)-1),y1=Math.min(h-1,Math.floor((oy-Math.min(a[1],b[1])+radius)/dy));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(!mask[y*w+x]&&touches(a,b,ox+x*dx,oy-y*dy,ox+(x+1)*dx,oy-(y+1)*dy))mask[y*w+x]=1;
    }
    return {mask,segments,seedCells:mask.reduce((a,b)=>a+b,0)};
  }
  // Felzenszwalb/Huttenlocher lower envelope of squared-distance parabolas.
  function edt1(f){const n=f.length,v=new Int32Array(n),z=new Float64Array(n+1),d=new Float64Array(n);d.fill(Infinity);let k=-1;
    for(let q=0;q<n;q++)if(Number.isFinite(f[q])){let s=-Infinity;while(k>=0){const p=v[k];s=((f[q]+q*q)-(f[p]+p*p))/(2*(q-p));if(s>z[k])break;k--;}k++;v[k]=q;z[k]=k===0?-Infinity:s;z[k+1]=Infinity;}
    if(k<0)return d;let j=0;for(let q=0;q<n;q++){while(j<k&&z[j+1]<q)j++;d[q]=(q-v[j])**2+f[v[j]];}return d;
  }
  function distances(mask){const tmp=new Float64Array(size),out=new Float32Array(size);
    for(let y=0;y<h;y++){const f=new Float64Array(w);for(let x=0;x<w;x++)f[x]=mask[y*w+x]?0:Infinity;tmp.set(edt1(f),y*w);}
    for(let x=0;x<w;x++){const f=new Float64Array(h);for(let y=0;y<h;y++)f[y]=tmp[y*w+x];const d=edt1(f);for(let y=0;y<h;y++)out[y*w+x]=Math.sqrt(d[y])*dx;}return out;
  }
  const reflect=(i,n)=>{if(n===1)return 0;let j=((i%(2*n))+2*n)%(2*n);return j<n?j:2*n-1-j;};
  function filterAxis(a,kernel,vertical){const result=new Float32Array(size),half=(kernel.length-1)/2;for(let y=0;y<h;y++)for(let x=0;x<w;x++){let sum=0;for(let k=-half;k<=half;k++){const i=vertical?reflect(y+k,h)*w+x:y*w+reflect(x+k,w);sum+=a[i]*kernel[k+half];}result[y*w+x]=sum;}return result;}
  const rm=burn(rivers),rd=burn(roads);let win=Math.max(3,Math.round(densityWindowMetres/dx));if(win%2===0)win++;
  if(win>1025)throw Error('Density window too large for this prototype.');
  let density=new Float32Array(size);
  if(rm.seedCells){const box=Array(win).fill(1/win);density=filterAxis(filterAxis(rm.mask,box,true),box,false);const sigma=Math.max(1,win/6),rad=Math.floor(4*sigma+0.5),gauss=Array.from({length:2*rad+1},(_,k)=>Math.exp(-0.5*((k-rad)/sigma)**2)),sum=gauss.reduce((a,b)=>a+b,0);for(let k=0;k<gauss.length;k++)gauss[k]/=sum;density=filterAxis(filterAxis(density,gauss,true),gauss,false);}
  const riverDistance=rm.seedCells?distances(rm.mask):null,roadDistance=rd.seedCells?distances(rd.mask):null;
  const layers={river_distance:new Float32Array(width*height),road_distance:new Float32Array(width*height),river_density:new Float32Array(width*height)};
  for(const a of Object.values(layers))a.fill(-9999);let validCells=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x,j=(y+pad)*w+x+pad;if(!Number.isFinite(values[i])||(nodata!==null&&values[i]===nodata))continue;validCells++;layers.river_distance[i]=riverDistance?riverDistance[j]:-9999;layers.road_distance[i]=roadDistance?roadDistance[j]:-9999;layers.river_density[i]=Math.max(0,Math.min(1,density[j]));}
  if(!validCells)throw Error('DEM has no valid cells.');
  return {layers,validCells,nodata:-9999,diagnostics:{searchBufferMetres:pad*dx,lineBufferMetres:radius,densityWindowPixels:win,densityWindowMetres:win*dx,riverSegments:rm.segments,roadSegments:rd.segments,riverSeedCells:rm.seedCells,roadSeedCells:rd.seedCells},warnings:[...(!rm.seedCells?['No river pixels found in the search grid: river distance is NoData; river density is zero.']:[]),...(!rd.seedCells?['No major-road pixels found in the search grid: road distance is NoData.']:[])]};
}

/** Worker receives DEM bytes and optional public OSM data, never Google credentials. */
function linearWorkerMain(computeLinear, retrieveOverpass) {
  importScripts('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js','https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.js');
  function writeFloatTIFF(values,width,height,dx,dy,origin,epsg){
    // Baseline little-endian TIFF: one uncompressed float32 strip and explicit GeoKeys.
    const entries=[
      [256,4,[width]],[257,4,[height]],[258,3,[32]],[259,3,[1]],
      [262,3,[1]],[273,4,[0]],[277,3,[1]],[278,4,[height]],
      [279,4,[values.length*4]],[284,3,[1]],[339,3,[3]],
      [33550,12,[dx,dy,0]],[33922,12,[0,0,0,origin[0],origin[1],0]],
      [34735,3,[1,1,0,4,1024,0,1,1,1025,0,1,1,3072,0,1,epsg,3076,0,1,9001]],
      [42113,2,Array.from('-9999\0',c=>c.charCodeAt(0))]
    ];
    const sizes={2:1,3:2,4:4,12:8};let cursor=8+2+12*entries.length+4;
    for(const e of entries)if(e[2].length*sizes[e[1]]>4){e[3]=cursor;cursor+=e[2].length*sizes[e[1]];cursor=(cursor+7)&~7;}
    entries.find(e=>e[0]===273)[2][0]=cursor;
    const buffer=new ArrayBuffer(cursor+values.length*4),v=new DataView(buffer);
    v.setUint16(0,0x4949,true);v.setUint16(2,42,true);v.setUint32(4,8,true);v.setUint16(8,entries.length,true);
    entries.forEach((e,i)=>{const p=10+i*12;v.setUint16(p,e[0],true);v.setUint16(p+2,e[1],true);v.setUint32(p+4,e[2].length,true);
      const start=e[3]??(p+8);if(e[3]!==undefined)v.setUint32(p+8,e[3],true);
      e[2].forEach((n,j)=>{const q=start+j*sizes[e[1]];if(e[1]===2)v.setUint8(q,n);else if(e[1]===3)v.setUint16(q,n,true);else if(e[1]===4)v.setUint32(q,n,true);else v.setFloat64(q,n,true);});
    });
    values.forEach((n,i)=>v.setFloat32(cursor+i*4,n,true));return buffer;
  }
  self.onmessage=async({data})=>{
    try{
      const started=performance.now(),progress=message=>self.postMessage({type:'progress',message});
      progress('Reading the DEM grid…');
      const hash=await crypto.subtle.digest('SHA-256',data.buffer),sourceSHA256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
      const tiff=await GeoTIFF.fromArrayBuffer(data.buffer);if(await tiff.getImageCount()!==1)throw Error('Use a single-image DEM without overviews.');
      const image=await tiff.getImage(),keys=image.getGeoKeys(),fd=image.getFileDirectory(),epsg=Number(keys.ProjectedCSTypeGeoKey);
      if(!((epsg>=32601&&epsg<=32660)||(epsg>=32701&&epsg<=32760)))throw Error('Use a WGS84 UTM DEM in metre units.');
      const matrix=fd.ModelTransformation;if(Number(keys.GTRasterTypeGeoKey||1)!==1||fd.SubIFDs||(matrix&&(matrix[1]!==0||matrix[2]!==0||matrix[4]!==0||matrix[6]!==0)))throw Error('Use a north-up PixelIsArea DEM without sub-images.');
      if(image.getSamplesPerPixel()!==1)throw Error('DEM must have one elevation band.');
      const width=image.getWidth(),height=image.getHeight(),origin=image.getOrigin(),resolution=matrix?[matrix[0],matrix[5],matrix[10]]:image.getResolution(),dx=resolution[0],dy=Math.abs(resolution[1]);
      if(width>512||height>512||dx<10||dx>100||resolution[1]>=0||Math.abs(dx-dy)>1e-8||!origin.slice(0,2).every(Number.isFinite))throw Error('Use a north-up square 10–100 m grid, at most 512 × 512 cells.');
      if(width*dx*height*dy>25000000)throw Error('Use a DEM covering at most 25 km² for OSM retrieval.');
      const projection=`+proj=utm +zone=${epsg%100} ${epsg>=32700?'+south ':''}+datum=WGS84 +units=m +no_defs`;
      const pad=Math.ceil(1000/dx),left=origin[0]-pad*dx,right=origin[0]+(width+pad)*dx,top=origin[1]+pad*dy,bottom=origin[1]-(height+pad)*dy;
      const edge=[];for(let k=0;k<=8;k++){const x=left+(right-left)*k/8,y=bottom+(top-bottom)*k/8;for(const p of [[x,bottom],[x,top],[left,y],[right,y]])edge.push(proj4(projection,'EPSG:4326',p));}
      const bbox={west:Math.min(...edge.map(p=>p[0])),east:Math.max(...edge.map(p=>p[0])),south:Math.min(...edge.map(p=>p[1])),north:Math.max(...edge.map(p=>p[1]))};
      if(Object.values(bbox).some(v=>!Number.isFinite(v))||bbox.east-bbox.west>10||bbox.south< -80||bbox.north>84)throw Error('The DEM search bounds are unsupported.');
      let raw,endpoint=null,osmAttempts=[];
      const query=`[out:json][timeout:35];(way["waterway"="river"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way["highway"~"^(trunk|trunk_link|primary|primary_link)$"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom;`;
      if(data.osmText){progress('Reading the selected OSM file…');raw=JSON.parse(data.osmText);}
      else {
        const response = await retrieveOverpass(query, data.server, progress);
        ({ raw, endpoint, attempts: osmAttempts } = response);
      }
      // Overpass can return partial data plus a runtime remark. Never treat it as complete.
      if(raw.remark)throw Error('OSM returned incomplete data: '+String(raw.remark).slice(0,250));
      const features=[],roads=[],rivers=[];let points=0;
      function add(coords,properties,id){
        const kind=properties.waterway==='river'?'river':(['trunk','trunk_link','primary','primary_link'].includes(properties.highway)?'road':properties.kind==='river'?'river':properties.kind==='road'?'road':null);
        if(!kind)return;if(!Array.isArray(coords)||coords.length<2)throw Error('A line has invalid coordinates.');
        if((points+=coords.length)>300000||features.length>=20000)throw Error('Too many OSM features. Use a smaller area.');
        const projected=[];for(const p of coords){if(!Array.isArray(p)||!Number.isFinite(p[0])||!Number.isFinite(p[1])||p[0]< -180||p[0]>180||p[1]< -90||p[1]>90)throw Error('OSM coordinates must be WGS84 longitude/latitude.');projected.push(proj4('EPSG:4326',projection,p.slice(0,2)));}
        (kind==='river'?rivers:roads).push(projected);features.push({type:'Feature',id,properties:{...properties,kind},geometry:{type:'LineString',coordinates:coords.map(p=>p.slice(0,2))}});
      }
      if(raw.type==='FeatureCollection'&&Array.isArray(raw.features)){
        for(const f of raw.features){if(f.geometry?.type==='LineString')add(f.geometry.coordinates,f.properties||{},f.id);else if(f.geometry?.type==='MultiLineString')for(const c of f.geometry.coordinates)add(c,f.properties||{},f.id);}
      }else if(Array.isArray(raw.elements)){
        for(const e of raw.elements)if(e.type==='way'&&Array.isArray(e.geometry))add(e.geometry.map(p=>[p.lon,p.lat]),e.tags||{},e.type+'/'+e.id);
      }else throw Error('Use an Overpass JSON response or a WGS84 GeoJSON FeatureCollection of tagged lines.');
      const values=await image.readRasters({samples:[0],interleave:true}),rawNodata=image.getGDALNoData(),nodata=rawNodata===null?null:Number(rawNodata);
      progress('Rasterising lines and calculating distances and density…');
      const result=computeLinear({values,width,height,dx,dy,nodata,origin,roads,rivers});
      const products=[],transfer=[],units={river_distance:'metres to buffered river pixels',road_distance:'metres to buffered major-road pixels',river_density:'smoothed river-pixel fraction (0–1)'};
      for(const [name,layer] of Object.entries(result.layers)){
        let min=Infinity,max=-Infinity,sum=0,count=0;for(const v of layer)if(v!==-9999&&Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);sum+=v;count++;}
        const preview=new Uint8ClampedArray(width*height*4);for(let i=0;i<layer.length;i++){const v=layer[i];if(v===-9999)continue;const f=max===min?0.5:(v-min)/(max-min);preview.set([Math.round(40+190*f),Math.round(87+137*f),Math.round(82+80*f),255],i*4);}
        const output=writeFloatTIFF(layer,width,height,dx,dy,origin,epsg);products.push({name,tiff:output,preview:preview.buffer,summary:{min:count?min:null,max:count?max:null,mean:count?sum/count:null,validCells:count,unit:units[name]}});transfer.push(output,preview.buffer);
      }
      self.postMessage({type:'complete',products,vectors:{type:'FeatureCollection',features},report:{schemaVersion:1,stage:'roads and rivers',status:result.warnings.length?'completed_with_warnings':'completed',sourceSHA256,source:data.source,osmSource:data.osmText?'selected file':'Overpass API',osmTimestamp:raw.osm3s?.timestamp_osm_base||null,processedAt:new Date().toISOString(),endpoint,osmAttempts,query: data.osmText?null:query,queryBounds:bbox,width,height,crs:'EPSG:'+epsg,transform:{scaleX:dx,scaleY:-dy,translateX:origin[0],translateY:origin[1]},nodata:-9999,validCells:result.validCells,diagnostics:result.diagnostics,featureCounts:{roads:roads.length,rivers:rivers.length},warnings:result.warnings,
        methods:{roads:'OSM ways: trunk, trunk_link, primary, primary_link',rivers:'OSM ways: waterway=river',mask:'Capsule line buffer of max(5 m, half a cell); burn every touched pixel',distance:'Exact Euclidean distance between buffered raster-cell centres, in metres',density:'200 m target odd box window, followed by Gaussian sigma=max(1,window/6), truncate=4, half-sample reflect boundaries'},products:Object.fromEntries(products.map(p=>[p.name,p.summary])),seconds:(performance.now()-started)/1000,
        limitations:['Search covers the DEM plus approximately 1 km; features beyond the search bounds are omitted.','Distances are to buffered raster pixels, not exact vector centrelines.','OSM coverage varies. Missing mapped features do not establish absence of roads or rivers.','Only OSM ways are retrieved; relation-only features are omitted.','River density is a smoothed pixel fraction, not river length per square kilometre.','Desktop equivalence has not been established; rasterisation and buffered query extents may differ.','Selected OSM files must cover the search area; their completeness cannot be established automatically.']}},transfer);
    }catch(e){self.postMessage({type:'error',message: 'Roads/rivers: '+String(e.message||e).slice(0,600)});}
  };
}

// Source/result state is shared only with the local Earth Engine controller.
let linearTimer=null,linearSource=null,linearSourceInfo=null,linearWorker=null,linearEpoch=0,linearReport=null;
let linearProducts=[],linearURLs=[],linearVectors=null,linearMapLayer=null,linearOSMText=null;
const linearNames={river_distance:'Distance to rivers',road_distance:'Distance to major roads',river_density:'River density'};
function linearMessage(text,error=false){el('linear-message').textContent=text;el('linear-message').className=error?'ee-message error':'ee-message';}
function clearLinearProducts(){mlStackPanel.invalidate();
  for(const url of linearURLs)URL.revokeObjectURL(url);linearURLs=[];linearProducts=[];linearReport=null;linearVectors=null;el('linear-vectors').disabled=true;if(linearMapLayer&&map)map.removeLayer(linearMapLayer);linearMapLayer=null;el('ee-vector-key').hidden=true;
  el('linear-cards').replaceChildren();
  el('linear-report').disabled=true;
}
function stopLinear(){clearTimeout(linearTimer);linearTimer=null;linearEpoch++;linearWorker?.terminate();linearWorker=null;el('linear-run').disabled=!linearSource;el('linear-cancel').disabled=true;el('linear-file').disabled=false;el('linear-osm-file').disabled=false;el('linear-live').disabled=false;el('linear-server').disabled=false;}
function setLinearSource(blob,info=null){
  stopLinear();clearLinearProducts();linearSource=blob;linearSourceInfo=info;
  el('linear-source').textContent=blob?`DEM ready: ${info?.label||'retrieved elevation'} · ${(blob.size/1024).toFixed(1)} KB`:'Retrieve a DEM under Study area or open a downloaded DEM here.';
  el('linear-run').disabled=!blob;linearMessage(blob?'DEM ready. Retrieve OSM features, or open saved OSM data.':'Road/river processing runs locally in your browser.');
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
      linearProducts=data.products;linearReport=data.report;mlStackPanel.invalidate();linearVectors=data.vectors;el('linear-vectors').disabled=false;
      if(map&&window.L){el('ee-vector-key').hidden=false;linearMapLayer=window.L.geoJSON(linearVectors,{style:f=>({color:f.properties.kind==='river'?'#267ab2':'#b16e28',weight:3,opacity:0.9})}).addTo(map);}
      for(const p of linearProducts){
        const downloadURL=URL.createObjectURL(new Blob([p.tiff],{type:'image/tiff'}));linearURLs.push(downloadURL);
        appendRasterCard(el('linear-cards'), p, {
          grid: linearReport,
          label: linearNames[p.name], width: linearReport.width, height: linearReport.height,
          url: downloadURL, filename: p.name + '_aligned.tif',
        });
      }
      el('linear-report').disabled=false;
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


const satelliteGraphTemplates={"worldcover":{"image":{"result":"0","values":{"1":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}},"2":{"constantValue":["Map"]},"3":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.load","arguments":{"id":{"constantValue":"__WORLDCOVER__"}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.intersects","arguments":{"leftField":{"constantValue":".all"},"rightValue":{"functionInvocationValue":{"functionName":"Feature","arguments":{"geometry":{"valueReference":"1"}}}}}}}}}},"0":{"functionInvocationValue":{"functionName":"Image.unmask","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.toFloat","arguments":{"value":{"functionInvocationValue":{"functionName":"Image.clip","arguments":{"geometry":{"valueReference":"1"},"input":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.setDefaultProjection","arguments":{"crs":{"functionInvocationValue":{"functionName":"Image.projection","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"valueReference":"2"},"input":{"functionInvocationValue":{"functionName":"Collection.first","arguments":{"collection":{"valueReference":"3"}}}}}}}}}},"image":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"valueReference":"2"},"input":{"functionInvocationValue":{"functionName":"ImageCollection.mosaic","arguments":{"collection":{"valueReference":"3"}}}}}}}}}},"names":{"constantValue":["lulc"]}}}}}}}}}},"sameFootprint":{"constantValue":false},"value":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":-9999}}}}}}}}},"bands":["lulc"]},"soil":{"image":{"result":"0","values":{"0":{"functionInvocationValue":{"functionName":"Image.unmask","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.toFloat","arguments":{"value":{"functionInvocationValue":{"functionName":"Image.clip","arguments":{"geometry":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}},"input":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"constantValue":["b0"]},"input":{"functionInvocationValue":{"functionName":"Image.load","arguments":{"id":{"constantValue":"OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02"}}}}}}},"names":{"constantValue":["soil_texture"]}}}}}}}}}},"sameFootprint":{"constantValue":false},"value":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":-9999}}}}}}}}},"bands":["soil_texture"]},"merit":{"image":{"result":"0","values":{"0":{"functionInvocationValue":{"functionName":"Image.unmask","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.toFloat","arguments":{"value":{"functionInvocationValue":{"functionName":"Image.clip","arguments":{"geometry":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}},"input":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.resample","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"constantValue":["hnd"]},"input":{"functionInvocationValue":{"functionName":"Image.load","arguments":{"id":{"constantValue":"MERIT/Hydro/v1_0_1"}}}}}}},"mode":{"constantValue":"bilinear"}}}},"names":{"constantValue":["merit_hnd"]}}}}}}}}}},"sameFootprint":{"constantValue":false},"value":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":-9999}}}}}}}}},"bands":["merit_hnd"]},"ndvi":{"image":{"result":"0","values":{"1":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}},"3":{"constantValue":"B8"},"4":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.load","arguments":{"id":{"constantValue":"COPERNICUS/S2_SR_HARMONIZED"}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.intersects","arguments":{"leftField":{"constantValue":".all"},"rightValue":{"functionInvocationValue":{"functionName":"Feature","arguments":{"geometry":{"valueReference":"1"}}}}}}}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.dateRangeContains","arguments":{"leftValue":{"functionInvocationValue":{"functionName":"DateRange","arguments":{"end":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__NDVI_END__"}}}},"start":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__NDVI_START__"}}}}}}},"rightField":{"constantValue":"system:time_start"}}}}}}},"2":{"functionInvocationValue":{"functionName":"Image.projection","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"arrayValue":{"values":[{"valueReference":"3"}]}},"input":{"functionInvocationValue":{"functionName":"Collection.first","arguments":{"collection":{"valueReference":"4"}}}}}}}}}},"7":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"constantValue":["SCL"]},"input":{"argumentReference":"_MAPPING_VAR_0_0"}}}},"8":{"constantValue":["ndvi"]},"6":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.normalizedDifference","arguments":{"bandNames":{"arrayValue":{"values":[{"valueReference":"3"},{"constantValue":"B4"}]}},"input":{"functionInvocationValue":{"functionName":"Image.updateMask","arguments":{"image":{"argumentReference":"_MAPPING_VAR_0_0"},"mask":{"functionInvocationValue":{"functionName":"Image.or","arguments":{"image1":{"functionInvocationValue":{"functionName":"Image.or","arguments":{"image1":{"functionInvocationValue":{"functionName":"Image.or","arguments":{"image1":{"functionInvocationValue":{"functionName":"Image.eq","arguments":{"image1":{"valueReference":"7"},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":4}}}}}}},"image2":{"functionInvocationValue":{"functionName":"Image.eq","arguments":{"image1":{"valueReference":"7"},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":5}}}}}}}}}},"image2":{"functionInvocationValue":{"functionName":"Image.eq","arguments":{"image1":{"valueReference":"7"},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":6}}}}}}}}}},"image2":{"functionInvocationValue":{"functionName":"Image.eq","arguments":{"image1":{"valueReference":"7"},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":11}}}}}}}}}}}}}}}},"names":{"valueReference":"8"}}}},"5":{"functionInvocationValue":{"functionName":"Collection.map","arguments":{"baseAlgorithm":{"functionDefinitionValue":{"argumentNames":["_MAPPING_VAR_0_0"],"body":"6"}},"collection":{"valueReference":"4"}}}},"0":{"functionInvocationValue":{"functionName":"Image.unmask","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.toFloat","arguments":{"value":{"functionInvocationValue":{"functionName":"Image.clip","arguments":{"geometry":{"valueReference":"1"},"input":{"functionInvocationValue":{"functionName":"Image.addBands","arguments":{"dstImg":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.resample","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.setDefaultProjection","arguments":{"crs":{"valueReference":"2"},"image":{"functionInvocationValue":{"functionName":"reduce.mean","arguments":{"collection":{"valueReference":"5"}}}}}}},"mode":{"constantValue":"bilinear"}}}},"names":{"valueReference":"8"}}}},"srcImg":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.setDefaultProjection","arguments":{"crs":{"valueReference":"2"},"image":{"functionInvocationValue":{"functionName":"reduce.count","arguments":{"collection":{"valueReference":"5"}}}}}}},"names":{"constantValue":["ndvi_observations"]}}}}}}}}}}}}},"sameFootprint":{"constantValue":false},"value":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":-9999}}}}}}}}},"bands":["ndvi","ndvi_observations"],"audit":{"result":"0","values":{"0":{"dictionaryValue":{"values":{"scenes":{"functionInvocationValue":{"functionName":"Collection.size","arguments":{"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.load","arguments":{"id":{"constantValue":"COPERNICUS/S2_SR_HARMONIZED"}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.intersects","arguments":{"leftField":{"constantValue":".all"},"rightValue":{"functionInvocationValue":{"functionName":"Feature","arguments":{"geometry":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}}}}}}}}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.dateRangeContains","arguments":{"leftValue":{"functionInvocationValue":{"functionName":"DateRange","arguments":{"end":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__NDVI_END__"}}}},"start":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__NDVI_START__"}}}}}}},"rightField":{"constantValue":"system:time_start"}}}}}}}}}}}}}}}},"rainfall":{"image":{"result":"0","values":{"1":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}},"3":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"constantValue":["precipitation"]},"input":{"argumentReference":"_MAPPING_VAR_0_0"}}}},"2":{"functionInvocationValue":{"functionName":"Collection.map","arguments":{"baseAlgorithm":{"functionDefinitionValue":{"argumentNames":["_MAPPING_VAR_0_0"],"body":"3"}},"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.load","arguments":{"id":{"constantValue":"UCSB-CHG/CHIRPS/DAILY"}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.intersects","arguments":{"leftField":{"constantValue":".all"},"rightValue":{"functionInvocationValue":{"functionName":"Feature","arguments":{"geometry":{"valueReference":"1"}}}}}}}}}}}}},"5":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__RAIN_END__"}}}},"6":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__RAIN_START__"}}}},"4":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"valueReference":"2"},"filter":{"functionInvocationValue":{"functionName":"Filter.dateRangeContains","arguments":{"leftValue":{"functionInvocationValue":{"functionName":"DateRange","arguments":{"end":{"valueReference":"5"},"start":{"valueReference":"6"}}}},"rightField":{"constantValue":"system:time_start"}}}}}}},"7":{"functionInvocationValue":{"functionName":"Date.difference","arguments":{"date":{"valueReference":"5"},"start":{"valueReference":"6"},"unit":{"constantValue":"day"}}}},"0":{"functionInvocationValue":{"functionName":"Image.unmask","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.toFloat","arguments":{"value":{"functionInvocationValue":{"functionName":"Image.clip","arguments":{"geometry":{"valueReference":"1"},"input":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.resample","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.setDefaultProjection","arguments":{"crs":{"functionInvocationValue":{"functionName":"Image.projection","arguments":{"image":{"functionInvocationValue":{"functionName":"Collection.first","arguments":{"collection":{"valueReference":"2"}}}}}}},"image":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"constantValue":"expected"},"object":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"constantValue":"days"},"object":{"functionInvocationValue":{"functionName":"Image.updateMask","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"reduce.sum","arguments":{"collection":{"valueReference":"4"}}}},"names":{"constantValue":["P"]}}}},"mask":{"functionInvocationValue":{"functionName":"Image.eq","arguments":{"image1":{"functionInvocationValue":{"functionName":"reduce.count","arguments":{"collection":{"valueReference":"4"}}}},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"valueReference":"7"}}}}}}}}}},"value":{"functionInvocationValue":{"functionName":"Collection.size","arguments":{"collection":{"valueReference":"4"}}}}}}},"value":{"valueReference":"7"}}}}}}},"mode":{"constantValue":"bilinear"}}}},"names":{"constantValue":["rainfall"]}}}}}}}}}},"sameFootprint":{"constantValue":false},"value":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":-9999}}}}}}}}},"bands":["rainfall"],"audit":{"result":"0","values":{"1":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"constantValue":["precipitation"]},"input":{"argumentReference":"_MAPPING_VAR_0_0"}}}},"2":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__RAIN_END__"}}}},"3":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__RAIN_START__"}}}},"0":{"dictionaryValue":{"values":{"days":{"functionInvocationValue":{"functionName":"Collection.size","arguments":{"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"Collection.map","arguments":{"baseAlgorithm":{"functionDefinitionValue":{"argumentNames":["_MAPPING_VAR_0_0"],"body":"1"}},"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.load","arguments":{"id":{"constantValue":"UCSB-CHG/CHIRPS/DAILY"}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.intersects","arguments":{"leftField":{"constantValue":".all"},"rightValue":{"functionInvocationValue":{"functionName":"Feature","arguments":{"geometry":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}}}}}}}}}}}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.dateRangeContains","arguments":{"leftValue":{"functionInvocationValue":{"functionName":"DateRange","arguments":{"end":{"valueReference":"2"},"start":{"valueReference":"3"}}}},"rightField":{"constantValue":"system:time_start"}}}}}}}}}},"expectedDays":{"functionInvocationValue":{"functionName":"Date.difference","arguments":{"date":{"valueReference":"2"},"start":{"valueReference":"3"},"unit":{"constantValue":"day"}}}}}}}}}},"spi":{"image":{"result":"0","values":{"1":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}},"3":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"constantValue":["precipitation"]},"input":{"argumentReference":"_MAPPING_VAR_0_0"}}}},"2":{"functionInvocationValue":{"functionName":"Collection.map","arguments":{"baseAlgorithm":{"functionDefinitionValue":{"argumentNames":["_MAPPING_VAR_0_0"],"body":"3"}},"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.load","arguments":{"id":{"constantValue":"UCSB-CHG/CHIRPS/DAILY"}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.intersects","arguments":{"leftField":{"constantValue":".all"},"rightValue":{"functionInvocationValue":{"functionName":"Feature","arguments":{"geometry":{"valueReference":"1"}}}}}}}}}}}}},"4":{"constantValue":"expected"},"5":{"constantValue":"days"},"8":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__TARGET_MONTH__"}}}},"9":{"constantValue":"month"},"7":{"functionInvocationValue":{"functionName":"Date.advance","arguments":{"date":{"valueReference":"8"},"delta":{"constantValue":1},"unit":{"valueReference":"9"}}}},"12":{"functionInvocationValue":{"functionName":"Number.parse","arguments":{"input":{"constantValue":"__NMONTHS__"}}}},"11":{"functionInvocationValue":{"functionName":"Number.multiply","arguments":{"left":{"valueReference":"12"},"right":{"constantValue":-1}}}},"10":{"functionInvocationValue":{"functionName":"Date.advance","arguments":{"date":{"valueReference":"7"},"delta":{"valueReference":"11"},"unit":{"valueReference":"9"}}}},"13":{"constantValue":"system:time_start"},"6":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"valueReference":"2"},"filter":{"functionInvocationValue":{"functionName":"Filter.dateRangeContains","arguments":{"leftValue":{"functionInvocationValue":{"functionName":"DateRange","arguments":{"end":{"valueReference":"7"},"start":{"valueReference":"10"}}}},"rightField":{"valueReference":"13"}}}}}}},"14":{"constantValue":["P"]},"16":{"constantValue":"day"},"15":{"functionInvocationValue":{"functionName":"Date.difference","arguments":{"date":{"valueReference":"7"},"start":{"valueReference":"10"},"unit":{"valueReference":"16"}}}},"19":{"constantValue":"year"},"22":{"functionInvocationValue":{"functionName":"Date.get","arguments":{"date":{"valueReference":"8"},"unit":{"valueReference":"9"}}}},"21":{"functionInvocationValue":{"functionName":"Date.advance","arguments":{"date":{"functionInvocationValue":{"functionName":"Date.fromYMD","arguments":{"day":{"constantValue":1},"month":{"valueReference":"22"},"year":{"argumentReference":"_MAPPING_VAR_1_0"}}}},"delta":{"constantValue":1},"unit":{"valueReference":"9"}}}},"23":{"functionInvocationValue":{"functionName":"Date.advance","arguments":{"date":{"valueReference":"21"},"delta":{"valueReference":"11"},"unit":{"valueReference":"9"}}}},"20":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"valueReference":"2"},"filter":{"functionInvocationValue":{"functionName":"Filter.dateRangeContains","arguments":{"leftValue":{"functionInvocationValue":{"functionName":"DateRange","arguments":{"end":{"valueReference":"21"},"start":{"valueReference":"23"}}}},"rightField":{"valueReference":"13"}}}}}}},"24":{"functionInvocationValue":{"functionName":"Date.difference","arguments":{"date":{"valueReference":"21"},"start":{"valueReference":"23"},"unit":{"valueReference":"16"}}}},"18":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"valueReference":"19"},"object":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"valueReference":"4"},"object":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"valueReference":"5"},"object":{"functionInvocationValue":{"functionName":"Image.updateMask","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"reduce.sum","arguments":{"collection":{"valueReference":"20"}}}},"names":{"valueReference":"14"}}}},"mask":{"functionInvocationValue":{"functionName":"Image.eq","arguments":{"image1":{"functionInvocationValue":{"functionName":"reduce.count","arguments":{"collection":{"valueReference":"20"}}}},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"valueReference":"24"}}}}}}}}}},"value":{"functionInvocationValue":{"functionName":"Collection.size","arguments":{"collection":{"valueReference":"20"}}}}}}},"value":{"valueReference":"24"}}}},"value":{"argumentReference":"_MAPPING_VAR_1_0"}}}},"17":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.fromImages","arguments":{"images":{"functionInvocationValue":{"functionName":"List.map","arguments":{"baseAlgorithm":{"functionDefinitionValue":{"argumentNames":["_MAPPING_VAR_1_0"],"body":"18"}},"dropNulls":{"constantValue":false},"list":{"functionInvocationValue":{"functionName":"List.sequence","arguments":{"end":{"functionInvocationValue":{"functionName":"Number.subtract","arguments":{"left":{"functionInvocationValue":{"functionName":"Date.get","arguments":{"date":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__BASE_END__"}}}},"unit":{"valueReference":"19"}}}},"right":{"constantValue":1}}}},"start":{"functionInvocationValue":{"functionName":"Number.add","arguments":{"left":{"functionInvocationValue":{"functionName":"Date.get","arguments":{"date":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__BASE_START__"}}}},"unit":{"valueReference":"19"}}}},"right":{"functionInvocationValue":{"functionName":"Number.lt","arguments":{"left":{"valueReference":"22"},"right":{"valueReference":"12"}}}}}}}}}}}}}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.equals","arguments":{"leftField":{"valueReference":"5"},"rightField":{"valueReference":"4"}}}}}}},"25":{"functionInvocationValue":{"functionName":"ImageCollection.reduce","arguments":{"collection":{"valueReference":"17"},"reducer":{"functionInvocationValue":{"functionName":"Reducer.stdDev","arguments":{}}}}}},"0":{"functionInvocationValue":{"functionName":"Image.unmask","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.toFloat","arguments":{"value":{"functionInvocationValue":{"functionName":"Image.clip","arguments":{"geometry":{"valueReference":"1"},"input":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"Image.resample","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.setDefaultProjection","arguments":{"crs":{"functionInvocationValue":{"functionName":"Image.projection","arguments":{"image":{"functionInvocationValue":{"functionName":"Collection.first","arguments":{"collection":{"valueReference":"2"}}}}}}},"image":{"functionInvocationValue":{"functionName":"Image.updateMask","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.updateMask","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.divide","arguments":{"image1":{"functionInvocationValue":{"functionName":"Image.subtract","arguments":{"image1":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"valueReference":"4"},"object":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"valueReference":"5"},"object":{"functionInvocationValue":{"functionName":"Image.updateMask","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"reduce.sum","arguments":{"collection":{"valueReference":"6"}}}},"names":{"valueReference":"14"}}}},"mask":{"functionInvocationValue":{"functionName":"Image.eq","arguments":{"image1":{"functionInvocationValue":{"functionName":"reduce.count","arguments":{"collection":{"valueReference":"6"}}}},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"valueReference":"15"}}}}}}}}}},"value":{"functionInvocationValue":{"functionName":"Collection.size","arguments":{"collection":{"valueReference":"6"}}}}}}},"value":{"valueReference":"15"}}}},"image2":{"functionInvocationValue":{"functionName":"reduce.mean","arguments":{"collection":{"valueReference":"17"}}}}}}},"image2":{"valueReference":"25"}}}},"mask":{"functionInvocationValue":{"functionName":"Image.gt","arguments":{"image1":{"valueReference":"25"},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":0}}}}}}}}}},"mask":{"functionInvocationValue":{"functionName":"Image.gte","arguments":{"image1":{"functionInvocationValue":{"functionName":"reduce.count","arguments":{"collection":{"valueReference":"17"}}}},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":30}}}}}}}}}}}}},"mode":{"constantValue":"bilinear"}}}},"names":{"constantValue":["spi_proxy"]}}}}}}}}}},"sameFootprint":{"constantValue":false},"value":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"constantValue":-9999}}}}}}}}},"bands":["spi_proxy"],"audit":{"result":"0","values":{"2":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__TARGET_MONTH__"}}}},"3":{"constantValue":"month"},"1":{"functionInvocationValue":{"functionName":"Date.advance","arguments":{"date":{"valueReference":"2"},"delta":{"constantValue":1},"unit":{"valueReference":"3"}}}},"6":{"functionInvocationValue":{"functionName":"Number.parse","arguments":{"input":{"constantValue":"__NMONTHS__"}}}},"5":{"functionInvocationValue":{"functionName":"Number.multiply","arguments":{"left":{"valueReference":"6"},"right":{"constantValue":-1}}}},"4":{"functionInvocationValue":{"functionName":"Date.advance","arguments":{"date":{"valueReference":"1"},"delta":{"valueReference":"5"},"unit":{"valueReference":"3"}}}},"7":{"constantValue":"day"},"9":{"constantValue":"year"},"10":{"constantValue":"expected"},"11":{"constantValue":"days"},"14":{"functionInvocationValue":{"functionName":"Image.select","arguments":{"bandSelectors":{"constantValue":["precipitation"]},"input":{"argumentReference":"_MAPPING_VAR_0_0"}}}},"13":{"functionInvocationValue":{"functionName":"Collection.map","arguments":{"baseAlgorithm":{"functionDefinitionValue":{"argumentNames":["_MAPPING_VAR_0_0"],"body":"14"}},"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.load","arguments":{"id":{"constantValue":"UCSB-CHG/CHIRPS/DAILY"}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.intersects","arguments":{"leftField":{"constantValue":".all"},"rightValue":{"functionInvocationValue":{"functionName":"Feature","arguments":{"geometry":{"functionInvocationValue":{"functionName":"GeometryConstructors.Rectangle","arguments":{"coordinates":{"constantValue":[12.345601,23.456702,34.567803,45.678904]},"geodesic":{"constantValue":false}}}}}}}}}}}}}}}},"16":{"functionInvocationValue":{"functionName":"Date.get","arguments":{"date":{"valueReference":"2"},"unit":{"valueReference":"3"}}}},"15":{"functionInvocationValue":{"functionName":"Date.advance","arguments":{"date":{"functionInvocationValue":{"functionName":"Date.fromYMD","arguments":{"day":{"constantValue":1},"month":{"valueReference":"16"},"year":{"argumentReference":"_MAPPING_VAR_1_0"}}}},"delta":{"constantValue":1},"unit":{"valueReference":"3"}}}},"17":{"functionInvocationValue":{"functionName":"Date.advance","arguments":{"date":{"valueReference":"15"},"delta":{"valueReference":"5"},"unit":{"valueReference":"3"}}}},"18":{"constantValue":"system:time_start"},"12":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"valueReference":"13"},"filter":{"functionInvocationValue":{"functionName":"Filter.dateRangeContains","arguments":{"leftValue":{"functionInvocationValue":{"functionName":"DateRange","arguments":{"end":{"valueReference":"15"},"start":{"valueReference":"17"}}}},"rightField":{"valueReference":"18"}}}}}}},"19":{"functionInvocationValue":{"functionName":"Date.difference","arguments":{"date":{"valueReference":"15"},"start":{"valueReference":"17"},"unit":{"valueReference":"7"}}}},"8":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"valueReference":"9"},"object":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"valueReference":"10"},"object":{"functionInvocationValue":{"functionName":"Element.set","arguments":{"key":{"valueReference":"11"},"object":{"functionInvocationValue":{"functionName":"Image.updateMask","arguments":{"image":{"functionInvocationValue":{"functionName":"Image.rename","arguments":{"input":{"functionInvocationValue":{"functionName":"reduce.sum","arguments":{"collection":{"valueReference":"12"}}}},"names":{"constantValue":["P"]}}}},"mask":{"functionInvocationValue":{"functionName":"Image.eq","arguments":{"image1":{"functionInvocationValue":{"functionName":"reduce.count","arguments":{"collection":{"valueReference":"12"}}}},"image2":{"functionInvocationValue":{"functionName":"Image.constant","arguments":{"value":{"valueReference":"19"}}}}}}}}}},"value":{"functionInvocationValue":{"functionName":"Collection.size","arguments":{"collection":{"valueReference":"12"}}}}}}},"value":{"valueReference":"19"}}}},"value":{"argumentReference":"_MAPPING_VAR_1_0"}}}},"0":{"dictionaryValue":{"values":{"expectedTargetDays":{"functionInvocationValue":{"functionName":"Date.difference","arguments":{"date":{"valueReference":"1"},"start":{"valueReference":"4"},"unit":{"valueReference":"7"}}}},"samples":{"functionInvocationValue":{"functionName":"Collection.size","arguments":{"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"functionInvocationValue":{"functionName":"ImageCollection.fromImages","arguments":{"images":{"functionInvocationValue":{"functionName":"List.map","arguments":{"baseAlgorithm":{"functionDefinitionValue":{"argumentNames":["_MAPPING_VAR_1_0"],"body":"8"}},"dropNulls":{"constantValue":false},"list":{"functionInvocationValue":{"functionName":"List.sequence","arguments":{"end":{"functionInvocationValue":{"functionName":"Number.subtract","arguments":{"left":{"functionInvocationValue":{"functionName":"Date.get","arguments":{"date":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__BASE_END__"}}}},"unit":{"valueReference":"9"}}}},"right":{"constantValue":1}}}},"start":{"functionInvocationValue":{"functionName":"Number.add","arguments":{"left":{"functionInvocationValue":{"functionName":"Date.get","arguments":{"date":{"functionInvocationValue":{"functionName":"Date","arguments":{"value":{"constantValue":"__BASE_START__"}}}},"unit":{"valueReference":"9"}}}},"right":{"functionInvocationValue":{"functionName":"Number.lt","arguments":{"left":{"valueReference":"16"},"right":{"valueReference":"6"}}}}}}}}}}}}}}}},"filter":{"functionInvocationValue":{"functionName":"Filter.equals","arguments":{"leftField":{"valueReference":"11"},"rightField":{"valueReference":"10"}}}}}}}}}},"targetDays":{"functionInvocationValue":{"functionName":"Collection.size","arguments":{"collection":{"functionInvocationValue":{"functionName":"Collection.filter","arguments":{"collection":{"valueReference":"13"},"filter":{"functionInvocationValue":{"functionName":"Filter.dateRangeContains","arguments":{"leftValue":{"functionInvocationValue":{"functionName":"DateRange","arguments":{"end":{"valueReference":"1"},"start":{"valueReference":"4"}}}},"rightField":{"valueReference":"18"}}}}}}}}}}}}}}}}};

const manningLookup={10:.15,20:.10,30:.045,40:.05,50:.20,60:.04,70:.02,80:.035,90:.08,95:.12,100:.07};
const soilGroupLookup={1:4,2:4,3:4,4:3,5:3,6:3,7:3,8:3,9:2,10:4,11:2,12:1};
function validateSatelliteSettings(input,now=new Date()){
  const groups=Array.from(new Set(input.groups||[]));if(!groups.length||groups.some(g=>!['worldcover','ndvi','rainfall','spi','soil','merit'].includes(g)))throw Error('Select at least one satellite dataset.');
  const out={groups,worldcoverYear:String(input.worldcoverYear||'2021')};
  if(!['2020','2021'].includes(out.worldcoverYear))throw Error('WorldCover year must be 2020 or 2021.');
  const date=(s,label)=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw Error(label+' must be a valid calendar date.');return s;};
  const tomorrow=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1));
  for(const [g,prefix,minimum] of [['ndvi','ndvi','2017-03-28'],['rainfall','rain','1981-01-01']])if(groups.includes(g)){
    const start=date(input[prefix+'Start'],g+' start'),end=date(input[prefix+'End'],g+' end'),days=(Date.parse(end)-Date.parse(start))/86400000;
    if(start<minimum||days<=0||days>366||Date.parse(end)>tomorrow.getTime())throw Error(g+': use a period of 1–366 days within available historical dates (end is exclusive).');
    out[prefix+'Start']=start;out[prefix+'End']=end;
  }
  if(groups.includes('spi')){
    const a=Number(input.baselineStartYear),b=Number(input.baselineEndYear),m=Number(input.nmonths),target=String(input.targetMonth||'');
    if(!Number.isInteger(a)||!Number.isInteger(b)||a<1981||b>=now.getUTCFullYear()||b-a<29||b-a>99)throw Error('Use at least 30 complete baseline years from 1981 onwards, ending before this year.');
    if(![1,3,6,12].includes(m))throw Error('Choose a 1-, 3-, 6- or 12-month precipitation window.');
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(target))throw Error('Choose a valid target ending month.');
    const [year,month]=target.split('-').map(Number),start=new Date(Date.UTC(year,month-m,1)),end=new Date(Date.UTC(year,month,1));
    if(start.getTime()<Date.UTC(1981,0,1)||end.getTime()>Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1))throw Error('The target accumulation must use complete historical months from 1981 onwards.');
    const sampleYears=b-a+1-(Number(target.slice(5))<m?1:0);if(sampleYears<30)throw Error('This ending month needs an extra baseline year for 30 full accumulation windows.');
    Object.assign(out,{baselineStartYear:a,baselineEndYear:b,nmonths:m,targetMonth:target,baselineSamplesExpected:sampleYears});
  }
  return out;
}
function fillSatelliteTemplate(template,settings,bounds){
  if(!bounds||!['west','south','east','north'].every(k=>Number.isFinite(bounds[k]))||bounds.west>=bounds.east||bounds.south>=bounds.north)throw Error('Invalid satellite request bounds.');
  const replacements={__NDVI_START__:settings.ndviStart,__NDVI_END__:settings.ndviEnd,__RAIN_START__:settings.rainStart,__RAIN_END__:settings.rainEnd,__BASE_START__:settings.baselineStartYear+'-01-01',__BASE_END__:(settings.baselineEndYear+1)+'-01-01',__TARGET_MONTH__:settings.targetMonth+'-01',__NMONTHS__:String(settings.nmonths),__WORLDCOVER__:'ESA/WorldCover/'+(settings.worldcoverYear==='2020'?'v100':'v200')};
  const coords=new Map([[12.345601,bounds.west],[23.456702,bounds.south],[34.567803,bounds.east],[45.678904,bounds.north]]);
  const walk=v=>{if(typeof v==='string'&&/^__.*__$/.test(v)){if(replacements[v]===undefined)throw Error('Missing satellite request setting '+v);return replacements[v];}if(typeof v==='number'&&coords.has(v))return coords.get(v);if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));return v;};return walk(template);
}
function validateSatelliteAudit(group,audit){
  if(group==='ndvi'&&!(audit.scenes>0))throw Error('No Sentinel-2 SR scenes found for these dates and bounds.');
  if(group==='rainfall'&&(!(audit.days>0)||audit.days!==audit.expectedDays))throw Error('CHIRPS rainfall period is incomplete or unavailable. Choose earlier or shorter dates.');
  if(group==='spi'&&(!(audit.samples>=30)||!(audit.targetDays>0)||audit.targetDays!==audit.expectedTargetDays))throw Error('The anomaly needs at least 30 complete baseline windows and complete target rainfall.');
  return audit;
}
function deriveSatelliteLayers(group,bands,demValid,lookupTables){
  const ml=lookupTables?lookupTables.manning:manningLookup,sl=lookupTables?lookupTables.soil:soilGroupLookup;
  const n=demValid.length,out={},copy=(name,input,accept)=>{if(!input||input.length!==n)throw Error('Satellite band length does not match DEM.');const a=new Float32Array(n);a.fill(-9999);for(let i=0;i<n;i++)if(demValid[i]&&Number.isFinite(input[i])&&input[i]!==-9999&&accept(input[i]))a[i]=input[i];out[name]=a;return a;};
  if(group==='worldcover'){const lulc=copy('lulc',bands.lulc,x=>Object.hasOwn(ml,x)),m=new Float32Array(n);m.fill(-9999);for(let i=0;i<n;i++)if(lulc[i]!==-9999)m[i]=ml[lulc[i]];out.manning=m;}
  else if(group==='soil'){const texture=bands.soil_texture;if(!texture||texture.length!==n)throw Error('Soil texture band is missing.');const a=new Float32Array(n);a.fill(-9999);for(let i=0;i<n;i++)if(demValid[i]&&Object.hasOwn(sl,texture[i]))a[i]=sl[texture[i]];out.hsg_proxy=a;}
  else if(group==='ndvi'){copy('ndvi',bands.ndvi,x=>x>=-1&&x<=1);copy('ndvi_observations',bands.ndvi_observations,x=>Number.isInteger(x)&&x>=0);}
  else if(group==='rainfall')copy('rainfall',bands.rainfall,x=>x>=0);
  else if(group==='spi')copy('spi_proxy',bands.spi_proxy,()=>true);
  else if(group==='merit')copy('merit_hnd',bands.merit_hnd,()=>true);
  else throw Error('Unsupported satellite dataset.');
  return out;
}

async function requestSatellite({project,accessToken,expression,grid=null,bands=null,signal,fetchImpl=fetch,timeoutMs=90000}){
  if(!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)||!accessToken)throw Error('Connect an Earth Engine-enabled project above first.');
  const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)throw new DOMException('Cancelled','AbortError');signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeoutMs);
  try{
    const pixels=Boolean(grid),body=pixels?{expression,fileFormat:'GEO_TIFF',bandIds:bands,grid}:{expression};
    const response=await fetchImpl(`https://earthengine.googleapis.com/v1/projects/${project}/${pixels?'image:computePixels':'value:compute'}`,{method:'POST',headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    if(!response.ok){let msg='';try{msg=(await response.json()).error?.message||'';}catch{}msg=String(msg).replace(/ya29\.[\w.-]+/g,'[redacted]').slice(0,400);const advice={401:'Google access expired. Connect again.',403:'Check Earth Engine project access and dataset permissions.',429:'Earth Engine quota exceeded. Retry later.'}[response.status]||'Earth Engine request failed (HTTP '+response.status+').';throw Error(advice+(msg?' '+msg:''));}
    if(!pixels){const json=await response.json();if(!Object.hasOwn(json,'result'))throw Error('Earth Engine returned no metadata result.');return json.result;}
    if(Number(response.headers.get('Content-Length')||0)>8*1024*1024)throw Error('Satellite response exceeds 8 MB. Use a smaller area.');
    const buffer=await response.arrayBuffer();if(buffer.byteLength>8*1024*1024)throw Error('Satellite response exceeds 8 MB.');const a=new Uint8Array(buffer,0,Math.min(4,buffer.byteLength));
    if(a.length!==4||!((a[0]===73&&a[1]===73&&a[2]===42&&a[3]===0)||(a[0]===77&&a[1]===77&&a[2]===0&&a[3]===42)))throw Error('Earth Engine returned a non-TIFF response.');return buffer;
  }catch(e){if(controller.signal.aborted&&!signal?.aborted)throw Error('Earth Engine request timed out after '+Math.round(timeoutMs/1000)+' seconds. Try fewer datasets or a smaller area.');throw e;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

/** Source decoding/worker. Google credentials never enter this worker. */
function satelliteWorkerMain(deriveSatelliteLayers,manningLookup,soilGroupLookup,extraUnits={},auditRasterStack=null,screenWeaklines=null,compareWeaklineClosure=null,computeHazards=null,runWeaklineScenarios=null,computeRisk=null){
  importScripts('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js','https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.js');
  let template=null;
  function writeFloatTIFF(values,width,height,dx,dy,origin,epsg,nodata='-9999'){
    // Baseline little-endian TIFF: one uncompressed float32 strip and explicit GeoKeys.
    const entries=[
      [256,4,[width]],[257,4,[height]],[258,3,[32]],[259,3,[1]],
      [262,3,[1]],[273,4,[0]],[277,3,[1]],[278,4,[height]],
      [279,4,[values.length*4]],[284,3,[1]],[339,3,[3]],
      [33550,12,[dx,dy,0]],[33922,12,[0,0,0,origin[0],origin[1],0]],
      [34735,3,[1,1,0,4,1024,0,1,1,1025,0,1,1,3072,0,1,epsg,3076,0,1,9001]],
      [42113,2,Array.from(nodata+'\0',c=>c.charCodeAt(0))]
    ];
    const sizes={2:1,3:2,4:4,12:8};let cursor=8+2+12*entries.length+4;
    for(const e of entries)if(e[2].length*sizes[e[1]]>4){e[3]=cursor;cursor+=e[2].length*sizes[e[1]];cursor=(cursor+7)&~7;}
    entries.find(e=>e[0]===273)[2][0]=cursor;
    const buffer=new ArrayBuffer(cursor+values.length*4),v=new DataView(buffer);
    v.setUint16(0,0x4949,true);v.setUint16(2,42,true);v.setUint32(4,8,true);v.setUint16(8,entries.length,true);
    entries.forEach((e,i)=>{const p=10+i*12;v.setUint16(p,e[0],true);v.setUint16(p+2,e[1],true);v.setUint32(p+4,e[2].length,true);
      const start=e[3]??(p+8);if(e[3]!==undefined)v.setUint32(p+8,e[3],true);
      e[2].forEach((n,j)=>{const q=start+j*sizes[e[1]];if(e[1]===2)v.setUint8(q,n);else if(e[1]===3)v.setUint16(q,n,true);else if(e[1]===4)v.setUint32(q,n,true);else v.setFloat64(q,n,true);});
    });
    values.forEach((n,i)=>v.setFloat32(cursor+i*4,n,true));return buffer;
  }
  async function readGrid(buffer,dem=false){
    const tiff=await GeoTIFF.fromArrayBuffer(buffer);if(await tiff.getImageCount()!==1)throw Error('Use a single-image GeoTIFF without overviews.');
    const image=await tiff.getImage(),keys=image.getGeoKeys(),fd=image.getFileDirectory(),epsg=Number(keys.ProjectedCSTypeGeoKey),matrix=fd.ModelTransformation;
    if(!((epsg>=32601&&epsg<=32660)||(epsg>=32701&&epsg<=32760))||Number(keys.GTRasterTypeGeoKey||1)!==1||fd.SubIFDs||(matrix&&(matrix[1]||matrix[2]||matrix[4]||matrix[6])))throw Error('Use a north-up PixelIsArea WGS84 UTM GeoTIFF.');
    const width=image.getWidth(),height=image.getHeight(),origin=image.getOrigin(),resolution=matrix?[matrix[0],matrix[5],matrix[10]]:image.getResolution(),dx=resolution[0],dy=-resolution[1];
    if(width<1||height<1||width>512||height>512||!origin.slice(0,2).every(Number.isFinite)||!Number.isFinite(dx)||!Number.isFinite(dy)||dx<=0||dy<=0||Math.abs(dx-dy)>1e-8||width*height*dx*dy>25e6)throw Error('Use square metre pixels, at most 512 × 512 cells and 25 km².');
    if(dem&&image.getSamplesPerPixel()!==1)throw Error('The DEM must have one band.');
    return {image,width,height,origin,dx,dy,epsg};
  }
  async function readAlignedValues(raster, maskToDEM = false) {
    const buffer = raster instanceof Blob ? await raster.arrayBuffer() : raster;
    const t = await readGrid(buffer);
    const s = template;
    if (t.width !== s.width || t.height !== s.height || t.epsg !== s.epsg ||
        Math.abs(t.dx - s.dx) > 1e-8 || Math.abs(t.dy - s.dy) > 1e-8 ||
        Math.abs(t.origin[0] - s.origin[0]) > 1e-6 || Math.abs(t.origin[1] - s.origin[1]) > 1e-6) {
      throw Error('CRS, dimensions, cell size, or origin differs from the DEM.');
    }
    if (t.image.getSamplesPerPixel() !== 1) throw Error('A single-band GeoTIFF is required.');
    const values = await t.image.readRasters({ samples: [0], interleave: true });
    const nodata = t.image.getGDALNoData();
    return Float32Array.from(values, (value, i) =>
      (!maskToDEM || s.mask[i]) && Number.isFinite(value) && value !== nodata ? value : NaN);
  }
  self.onmessage=async({data})=>{
    try{
      if(data.action==='prepare'){
        const t=await readGrid(data.buffer,true),raw=await t.image.readRasters({samples:[0],interleave:true}),nd=t.image.getGDALNoData(),mask=Uint8Array.from(raw,v=>Number.isFinite(v)&&(nd===null||v!==Number(nd))),validCells=mask.reduce((a,b)=>a+b,0);
        if(!validCells)throw Error('The DEM has no valid elevation cells.');
        const projection=`+proj=utm +zone=${t.epsg%100} ${t.epsg>=32700?'+south ':''}+datum=WGS84 +units=m +no_defs`,points=[];
        const left=t.origin[0],right=left+t.width*t.dx,top=t.origin[1],bottom=top-t.height*t.dy;
        for(let i=0;i<=8;i++){const x=left+(right-left)*i/8,y=bottom+(top-bottom)*i/8;for(const p of [[x,bottom],[x,top],[left,y],[right,y]])points.push(proj4(projection,'EPSG:4326',p));}
        const bounds={west:Math.min(...points.map(p=>p[0])),east:Math.max(...points.map(p=>p[0])),south:Math.min(...points.map(p=>p[1])),north:Math.max(...points.map(p=>p[1]))};
        if(Object.values(bounds).some(v=>!Number.isFinite(v))||bounds.west< -180||bounds.east>180||bounds.east-bounds.west>10)throw Error('Unsupported geographic DEM bounds.');
        const hash=await crypto.subtle.digest('SHA-256',data.buffer),sourceSHA256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
        template={...t,mask};delete template.image;
        const dem = data.normalizeTraining
          ? writeFloatTIFF(Float32Array.from(raw, (value, i) => mask[i] ? value : NaN),
              t.width,t.height,t.dx,t.dy,t.origin,t.epsg,'nan') : null;
        self.postMessage({type:'prepared',dem,grid:{dimensions:{width:t.width,height:t.height},crsCode:'EPSG:'+t.epsg,affineTransform:{scaleX:t.dx,shearX:0,translateX:t.origin[0],shearY:0,scaleY:-t.dy,translateY:t.origin[1]}},bounds,validCells,sourceSHA256}, dem ? [dem] : []);return;
      }
      if(data.action==='auditStack'){
        if(!template||!auditRasterStack)throw Error('Prepare a DEM before checking the raster stack.');
        const normalized = [];
        const readAlignedRaster = async (raster, name) => {
          const values = await readAlignedValues(raster);
          const s = template;
          const encoded = writeFloatTIFF(values,s.width,s.height,s.dx,s.dy,s.origin,s.epsg,'nan');
          normalized.push({ name, raster: encoded });
          return { values, nodata: null };
        };
        const result = await auditRasterStack(data, template, readAlignedRaster);
        const trainingEntries = result.passed ? normalized : [];
        self.postMessage({ result, trainingEntries }, trainingEntries.map(entry => entry.raster));
        return;
      }
      if (data.action === 'risk') {
        const { width,height,mask,dx,dy,origin,epsg } = template;
        const layers = {};
        for (const [name,raster] of Object.entries(data.layers)) {
          if (!raster) continue;
          self.postMessage({type:'progress',message:'Checking '+name+' coverage…'});
          try { layers[name] = await readAlignedValues(raster,true); }
          catch(error) { throw Error(name+' · '+error.message); }
        }
        const {rasters,noRisk,...report} = computeRisk({...data,layers,width,mask});
        const products = {}, transfer = Object.values(noRisk).map(values => values.buffer);
        for (const [name,values] of Object.entries(rasters)) {
          const tiff = writeFloatTIFF(values,width,height,dx,dy,origin,epsg,'nan');
          products[name] = {tiff,values:values.buffer};
          transfer.push(tiff,values.buffer);
        }
        self.postMessage({...report,products,noRisk},transfer);
        return;
      }
      if (data.action === 'hazard') {
        if (!template || !computeHazards) throw Error('Prepare the DEM before calculating hazard.');
        const { width, height, dx, dy, origin, epsg } = template;
        async function read(raster, label) {
          try {
            const values = await readAlignedValues(raster, true);
            if (!values.some(Number.isFinite)) throw Error('No valid cells on the DEM grid.');
            return values;
          } catch (error) {
            throw Error(label + ' · ' + error.message);
          }
        }
        const [slope, manning] = await Promise.all([read(data.slope, 'Slope'), read(data.manning, 'Manning n')]);
        const depths = {};
        for (const period of data.periods) {
          const values = await read(data.depths[period], period + '-year depth');
          if (values.some(value => value < 0)) throw Error(period + '-year depth contains negative values.');
          depths[period] = values;
        }
        const referenceDepths = {};
        for (const [period, buffer] of Object.entries(data.referenceDepths ?? {})) {
          referenceDepths[period] = await readAlignedValues(buffer, true);
        }
        const scenarioDepths = {};
        for (const [period, buffer] of Object.entries(data.scenarios ?? {})) {
          scenarioDepths[period] = await read(buffer, period + '-year scenario depth');
        }
        const { rasters, coverage, champion } = computeHazards({
          width, height, periods: data.periods, depths, slope, manning, scenarioDepths, referenceDepths,
          basis: data.basis, clean: data.clean,
        });
        const products = {}, transfer = [];
        for (const [name, values] of Object.entries(rasters)) {
          let max = -Infinity, min = Infinity, validCells = 0;
          for (const value of values) {
            if (!Number.isFinite(value)) continue;
            validCells++;
            max = Math.max(max, value);
            min = Math.min(min, value);
          }
          const tiff = writeFloatTIFF(values, width, height, dx, dy, origin, epsg, 'nan');
          products[name] = { tiff, values: values.buffer, summary: { validCells, min: validCells ? min : null, max: validCells ? max : null } };
          transfer.push(tiff, values.buffer);
        }
        self.postMessage({ products, coverage, champion }, [...new Set(transfer)]);
        return;
      }
      if (data.action === 'previewScenario') {
        const {width,height,dx} = template;
        const inputDepth = await readAlignedValues(data.depth,true);
        let values = inputDepth;
        if (data.barrierCells.length) {
          const terrain = await readAlignedValues(data.terrain,true);
          const riverDistance = data.riverDistance ? await readAlignedValues(data.riverDistance,true) : new Float32Array(width*height).fill(NaN);
          const cap = inputDepth.reduce((m,v)=>Number.isFinite(v)?Math.max(m,v):m,0)+2;
          const routed = compareWeaklineClosure({width,height,dx,inputDepth,terrain,riverDistance,cap,barrierCells:data.barrierCells,scenarioOnly:true});
          values = routed.map((v,i)=>Number.isFinite(v)?v:inputDepth[i]);
        }
        self.postMessage({values},[values.buffer]);
        return;
      }
      if (data.action === 'weaklineBatch') {
        if (!template || !runWeaklineScenarios) throw Error('Prepare the DEM before running scenarios.');
        const { width, height, dx, dy, origin, epsg } = template;
        const terrain = await readAlignedValues(data.terrain, true);
        const riverDistance = data.riverDistance ? await readAlignedValues(data.riverDistance, true) : new Float32Array(width * height).fill(NaN);
        const population = data.population ? await readAlignedValues(data.population, true).catch(() => null) : null;
        const weights = population?.some(value => value > 0)
          ? population.map(value => value >= 0 ? value * dx * dy / 1e6 : NaN) : null;
        const envelope = {}, worst = {}, transfer = [], periods = [];
        for (const period of data.periods) {
          self.postMessage({ type: 'progress', message: 'Testing ' + period + '-year weakline states…' });
          const inputDepth = await readAlignedValues(data.depths[period], true);
          const result = runWeaklineScenarios({
            candidates: data.candidates.filter(line => line.period === period), inputDepth,
            terrain, riverDistance, population: weights, width, height, dx, exhaustive: data.exhaustive,
            progress: (tested, total) => self.postMessage({ type: 'progress',
              message: period + '-year event · ' + tested + ' tested of ' + total + ' possible non-open states.' }),
          }, compareWeaklineClosure);
          periods.push({ period, ...result.report });
          if (!result.report.winner) continue;
          envelope[period] = writeFloatTIFF(result.envelope, width, height, dx, dy, origin, epsg, 'nan');
          worst[period] = writeFloatTIFF(result.worst, width, height, dx, dy, origin, epsg, 'nan');
          transfer.push(envelope[period], worst[period]);
        }
        self.postMessage({ envelope, worst, report: { periods,
          metric: weights ? 'population-weighted depth (person-metres)' : 'depth × cell area (m³)' } }, transfer);
        return;
      }
      if (data.action === 'screenWeaklines' || data.action === 'compareClosure') {
        if (!template) throw Error('Prepare the DEM before processing weaklines.');
        const { width, height, origin, dx, dy, epsg, mask } = template;
        async function read(raster, label) {
          const values = await readAlignedValues(raster, true).catch(error => { throw Error(label + ' · ' + error.message); });
          if (!values.some(Number.isFinite)) throw Error(label + ' has no valid cells on the DEM grid.');
          return values;
        }
        if (data.action === 'screenWeaklines') {
          const { settings, reference, depthByPeriod } = data;
          const referenceValues = await read(reference, settings.method === 'depth25' ? '25-year reference' : 'River distance');
          const footprintThreshold = Math.fround(settings.referenceDepthThresholdM);
          const corridor = Int8Array.from(referenceValues, value => {
            if (!Number.isFinite(value) || value < 0) return -1;
            return Number(settings.method === 'depth25' ? value > footprintThreshold : value <= settings.bufferM);
          });
          const depths = {};
          for (const [period, raster] of Object.entries(depthByPeriod)) {
            depths[period] = await read(raster, period + '-year depth');
            if (depths[period].some(value => value < 0)) throw Error(period + '-year depth contains negative values.');
          }
          const candidates = screenWeaklines({ width, height, dx, corridor,
            depthByPeriod: depths, thresholdM: settings.thresholdM, minimumM: settings.minimumM });
          const projection = `+proj=utm +zone=${epsg % 100} ${epsg >= 32700 ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
          const convert = proj4(projection, 'EPSG:4326');
          const vertex = id => convert.forward([
            origin[0] + (id % (width + 1)) * dx, origin[1] - Math.floor(id / (width + 1)) * dy,
          ]);
          const features = candidates.map(({ id, period, lengthM, segments }) => ({
            type: 'Feature', id, properties: { id, firstScreenedPeriodYears: period, lengthM },
            geometry: { type: 'MultiLineString', coordinates: segments.map(edge => edge.map(vertex)) },
          }));
          const coverage = { demCells: mask.reduce((sum, valid) => sum + valid, 0),
            corridorCells: corridor.reduce((sum, value) => sum + Number(value === 1), 0),
            missingCorridorCells: corridor.reduce((sum, value, i) => sum + Number(mask[i] && value < 0), 0),
            validDepthCells: Object.fromEntries(Object.entries(depths).map(([period, values]) =>
              [period, values.reduce((sum, value) => sum + Number(Number.isFinite(value)), 0)])),
          };
          self.postMessage({ features, coverage, candidates: candidates.map(({ id, period, cells }) => ({ id, period, cells })) });
        } else {
          const terrain = await read(data.terrain, 'Filled DEM');
          const inputDepth = await read(data.depth, 'Scenario depth');
          const riverDistance = data.riverDistance ? await read(data.riverDistance, 'River distance') : new Float32Array(width * height).fill(NaN);
          let cap = 0;
          for (const value of inputDepth) if (Number.isFinite(value)) cap = Math.max(cap, value);
          cap += 2;
          const { metrics, ...outputs } = compareWeaklineClosure({
            width, height, dx, terrain, inputDepth, riverDistance, barrierCells: data.barrierCells, cap,
          });
          const rasters = Object.fromEntries(Object.entries(outputs).map(([name, values]) =>
            [name, writeFloatTIFF(values, width, height, dx, dy, origin, epsg, 'nan')]));
          self.postMessage({ metrics, rasters, cap }, Object.values(rasters));
        }
        return;
      }
      if(data.action==='product'){
        if(!template)throw Error('Prepare a DEM before requesting satellite layers.');
        const t=await readGrid(data.buffer),s=template;
        if(t.width!==s.width||t.height!==s.height||t.epsg!==s.epsg||Math.abs(t.dx-s.dx)>1e-8||Math.abs(t.dy-s.dy)>1e-8||Math.abs(t.origin[0]-s.origin[0])>1e-5||Math.abs(t.origin[1]-s.origin[1])>1e-5)throw Error('Earth Engine response does not match the DEM grid.');
        if(t.image.getSamplesPerPixel()!==data.bands.length)throw Error('Earth Engine returned an unexpected band count.');
        const raster=await t.image.readRasters(),bands=Object.fromEntries(data.bands.map((name,i)=>[name,raster[i]])),layers=deriveSatelliteLayers(data.group,bands,s.mask,{manning:manningLookup,soil:soilGroupLookup}),products=[],transfer=[];
        const units={lulc:'ESA class code',manning:'Manning n (s m⁻¹ᐟ³)',ndvi:'NDVI (−1 to 1)',ndvi_observations:'valid scene observations',rainfall:'mm accumulated over the selected period',spi_proxy:'standardised precipitation anomaly (z-score)',hsg_proxy:'soil-texture proxy group A=1, B=2, C=3, D=4',merit_hnd:'metres above EGM96 geoid (adjusted elevation)',...extraUnits};
        const classColors={10:[0,100,0],20:[255,187,34],30:[255,255,76],40:[240,150,255],50:[250,0,0],60:[180,180,180],70:[240,240,240],80:[0,100,200],90:[0,150,160],95:[0,207,117],100:[250,230,160]};
        for(const [name,layer] of Object.entries(layers)){
          let count=0,zeroCells=0,min=Infinity,max=-Infinity,sum=0;for(const v of layer)if(v!==-9999){count++;if(v===0)zeroCells++;min=Math.min(min,v);max=Math.max(max,v);sum+=v;}
          const preview=new Uint8ClampedArray(layer.length*4);for(let i=0;i<layer.length;i++){const v=layer[i];if(v===-9999)continue;const f=['building_presence_proxy','building_footprint_mask'].includes(name)?v:min===max?.5:(v-min)/(max-min),c=name==='lulc'?classColors[v]:name==='hsg_proxy'?[[0,0,0],[80,180,235],[100,190,100],[235,185,60],[175,85,65]][v]:[Math.round(40+190*f),Math.round(87+137*f),Math.round(82+80*f)];preview.set([...c,255],i*4);}
          const output=writeFloatTIFF(layer,s.width,s.height,s.dx,s.dy,s.origin,s.epsg);products.push({name,tiff:output,preview:preview.buffer,summary:{validCells:count,noDataCells:layer.length-count,...(data.group==='flood-depth'?{zeroDepthCells:zeroCells}:{}),min:count?min:null,max:count?max:null,mean:count?sum/count:null,unit:units[name]}});transfer.push(output,preview.buffer);
        }
        self.postMessage({type:'products',group:data.group,products},transfer);
      }
    }catch(e){self.postMessage({type:'error',message:String(e.message||e)});}
  };
}

// The Earth Engine controller owns the OAuth token; no token is passed to workers.
let satSource=null,satSourceInfo=null,satWorker=null,satEpoch=0,satBusy=false,satAbort=null,satPending=null,satReport=null,satProducts=[],satURLs=[];
const satNames={lulc:'Land cover',manning:'Manning n',ndvi:'Mean NDVI',ndvi_observations:'NDVI observations',rainfall:'Accumulated rainfall',spi_proxy:'Precipitation anomaly (SPI proxy)',hsg_proxy:'Soil-group proxy',merit_hnd:'MERIT adjusted elevation (hnd)'};
const satGroupNames={worldcover:'WorldCover and Manning n',ndvi:'Sentinel-2 NDVI',rainfall:'CHIRPS rainfall',spi:'CHIRPS precipitation anomaly',soil:'OpenLandMap soil proxy',merit:'MERIT adjusted elevation'};
function satelliteMessage(text,error=false){el('sat-message').textContent=text;el('sat-message').className=error?'ee-message error':'ee-message';}
function refreshSatellite(){const connected=Boolean(token)&&Date.now()<expiresAt;el('sat-run').disabled=!satSource||!connected||satBusy;el('sat-cancel').disabled=!satBusy;el('sat-auth').textContent=connected?'Uses the Earth Engine connection under Study area.':'Connect Google above, then retrieve or open a DEM.';for(const input of document.querySelectorAll('#sat-options input,#sat-options select,#sat-file'))input.disabled=satBusy;}
function clearSatelliteProducts(){mlStackPanel.invalidate();for(const url of satURLs)URL.revokeObjectURL(url);satURLs=[];satProducts=[];satReport=null;el('sat-cards').replaceChildren();el('sat-report').disabled=true;}
function stopSatellite(){satEpoch++;satAbort?.abort();satAbort=null;satWorker?.terminate();satWorker=null;if(satPending){satPending.reject(new DOMException('Cancelled','AbortError'));satPending=null;}satBusy=false;refreshSatellite();}
function setSatelliteSource(blob,info=null){stopSatellite();clearSatelliteProducts();satSource=blob;satSourceInfo=info;el('sat-source').textContent=blob?`DEM ready: ${info?.label||'retrieved elevation'} · ${(blob.size/1024).toFixed(1)} KB`:'Retrieve a DEM above or open a downloaded DEM.';satelliteMessage(blob?'DEM ready. Choose datasets and dates, then retrieve.':'Select the DEM grid and connect Earth Engine under Study area.');refreshSatellite();}
function satelliteWorkerCall(message,transfer=[]){return new Promise((resolve,reject)=>{if(satPending)return reject(Error('Satellite worker is already busy.'));const timer=setTimeout(()=>{if(satPending){satPending=null;reject(Error('Satellite decoding timed out.'));}},30000);satPending={expectedGroup:message.group,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};satWorker.postMessage(message,transfer);});}
function addSatelliteProducts(products) {
  mlStackPanel.invalidate();
  for (const product of products) {
    satProducts.push(product);
    const url = URL.createObjectURL(new Blob([product.tiff], { type: 'image/tiff' }));
    satURLs.push(url);
    appendRasterCard(el('sat-cards'), product, {
          grid: satReport.grid,
      ...satReport.grid.dimensions, label: satNames[product.name],
      url, filename: product.name + '_aligned.tif',
    });
  }
}
function readSatelliteSettings(){return validateSatelliteSettings({groups:Array.from(document.querySelectorAll('#sat-options input[data-sat-group]:checked')).map(i=>i.dataset.satGroup),worldcoverYear:el('sat-worldcover').value,ndviStart:el('sat-ndvi-start').value,ndviEnd:el('sat-ndvi-end').value,rainStart:el('sat-rain-start').value,rainEnd:el('sat-rain-end').value,baselineStartYear:el('sat-base-start').value,baselineEndYear:el('sat-base-end').value,targetMonth:el('sat-target').value,nmonths:el('sat-months').value});}
async function runSatellite(){
  let settings,project;try{settings=readSatelliteSettings();project=validateProject(el('ee-project').value.trim());if(!satSource)throw Error('Retrieve or open a DEM first.');if(!token||Date.now()>=expiresAt)throw Error('Connect your Google account under Study area first.');}catch(e){satelliteMessage(e.message,true);return;}
  stopSatellite();clearSatelliteProducts();satBusy=true;satAbort=new AbortController();const active=satEpoch,signal=satAbort.signal,started=performance.now();refreshSatellite();
  try{
    satelliteMessage('Preparing the exact DEM grid…');const buffer=await satSource.arrayBuffer();if(active!==satEpoch)return;
    const body='('+satelliteWorkerMain.toString()+')('+deriveSatelliteLayers.toString()+','+JSON.stringify(manningLookup)+','+JSON.stringify(soilGroupLookup)+');',url=URL.createObjectURL(new Blob([body],{type:'text/javascript'}));satWorker=new Worker(url);URL.revokeObjectURL(url);
    satWorker.onmessage=({data})=>{if(active!==satEpoch||!satPending)return;if(data.type==='products'&&data.group!==satPending.expectedGroup)return;const p=satPending;satPending=null;if(data.type==='error')p.reject(Error(data.message));else p.resolve(data);};satWorker.onerror=()=>{if(satPending){const p=satPending;satPending=null;p.reject(Error('Satellite decoding worker failed. Check the connection and retry.'));}};
    const prepared=await satelliteWorkerCall({action:'prepare',buffer},[buffer]);if(active!==satEpoch)return;
    if((settings.groups.includes('rainfall')||settings.groups.includes('spi'))&&(prepared.bounds.south< -50||prepared.bounds.north>50))throw Error('CHIRPS is supported here only between 50°S and 50°N. Deselect rainfall and precipitation anomaly for this DEM.');
    satReport={schemaVersion:1,stage:'satellite and environment',status:'running',processedAt:new Date().toISOString(),source:satSourceInfo,sourceSHA256:prepared.sourceSHA256,project,sourceDatasets:{worldcover:'ESA/WorldCover/'+(settings.worldcoverYear==='2020'?'v100':'v200'),ndvi:'COPERNICUS/S2_SR_HARMONIZED',rainfall:'UCSB-CHG/CHIRPS/DAILY',spi:'UCSB-CHG/CHIRPS/DAILY',soil:'OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02',merit:'MERIT/Hydro/v1_0_1'},lookupTables:{manning:manningLookup,soilGroup:soilGroupLookup},grid:prepared.grid,geographicBounds:prepared.bounds,demValidCells:prepared.validCells,settings,datasets:{},products:{},failures:[],warnings:[],
      methods:{worldcover:'Nearest-neighbour WorldCover classes; browser Manning lookup',ndvi:'Mean per-scene (B8−B4)/(B8+B4), SCL classes 4,5,6,11 retained; bilinear mean, nearest observation counts',rainfall:'Sum of daily CHIRPS values; complete requested days required',spi:'Rolling accumulation z-score against the same ending calendar month; minimum 30 complete baseline windows and nonzero standard deviation; not gamma-fitted SPI',soil:'OpenLandMap 0 cm USDA texture remapped with desktop lookup; HSG proxy only',merit:'MERIT Hydro hnd band, labelled hydrologically adjusted elevation, not computed relative HAND'},
      limitations:['Data are sampled onto the DEM grid; this does not increase source spatial detail.','WorldCover is 10 m; S2 is 10–20 m; CHIRPS is approximately 5.6 km; soil texture is 250 m; MERIT is approximately 90 m.','SCL-only Sentinel-2 masking differs from the desktop QA60-plus-SCL implementation. No L1C fallback is used.','The precipitation anomaly uses a z-score as in the desktop code, not a distribution-fitted SPI.','Soil groups and Manning values are proxies/lookup assumptions, not site measurements.','True relative HAND has not been calculated. MERIT hnd is kept separately to avoid treating adjusted elevations as relative heights.','Requests run on Earth Engine; decoding, lookup mapping, masking and run in the browser.','Full desktop numerical equivalence and flood model accuracy have not been established.']};
    el('sat-report').disabled=false;
    for(const group of settings.groups){
      if(active!==satEpoch)return;if(!token||Date.now()>=expiresAt){satReport.failures.push({group,error:'Google access expired. Connect again.'});break;}
      const template=satelliteGraphTemplates[group];try{
        satelliteMessage('Retrieving '+satGroupNames[group]+'…');let audit=null;
        if(template.audit){audit=await requestSatellite({project,accessToken:token,expression:fillSatelliteTemplate(template.audit,settings,prepared.bounds),signal});validateSatelliteAudit(group,audit);}
        if(active!==satEpoch)return;
        const pixels=await requestSatellite({project,accessToken:token,expression:fillSatelliteTemplate(template.image,settings,prepared.bounds),grid:prepared.grid,bands:template.bands,signal});if(active!==satEpoch)return;
        const data=await satelliteWorkerCall({action:'product',group,buffer:pixels,bands:template.bands},[pixels]);if(active!==satEpoch)return;
        addSatelliteProducts(data.products);satReport.datasets[group]={status:'retrieved',audit};for(const p of data.products){satReport.products[p.name]=p.summary;if(!p.summary.validCells)satReport.warnings.push(satNames[p.name]+': no valid source cells.');}
      }catch(e){if(active!==satEpoch||signal.aborted)return;const error=String(e.message||e);satReport.datasets[group]={status:'failed',error};satReport.failures.push({group,error});}
    }
    satReport.seconds=(performance.now()-started)/1000;satReport.status=satReport.failures.length?(satProducts.length?'partial':'failed'):(satReport.warnings.length?'completed_with_warnings':'completed');
    const errors=satReport.failures.map(f=>satGroupNames[f.group]+': '+f.error).join(' ');satelliteMessage(`${satProducts.length} layers ready in ${satReport.seconds.toFixed(1)} s.${errors?' '+errors:''}${satReport.warnings.length?' '+satReport.warnings.join(' '):''}`,Boolean(satReport.failures.length));
  }catch(e){if(active!==satEpoch)return;satelliteMessage(String(e.message||e),true);if(satReport){satReport.status='failed';satReport.failures.push({error:String(e.message||e)});}}
  finally{if(active===satEpoch){satWorker?.terminate();satWorker=null;satAbort=null;satBusy=false;refreshSatellite();}}
}
el('sat-file').addEventListener('change',()=>{const file=el('sat-file').files[0];if(!file)return;if(file.size>8*1024*1024){satelliteMessage('Use a DEM smaller than 8 MB.',true);return;}setSatelliteSource(file,{kind:'local file',label:file.name});});
el('sat-run').addEventListener('click',runSatellite);el('sat-cancel').addEventListener('click',()=>{stopSatellite();if(satReport)satReport.status='cancelled';satelliteMessage('Satellite retrieval cancelled. Any completed layers remain available.');});
el('sat-report').addEventListener('click',()=>{if(!satReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(satReport,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='siavash-satellite-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
for(const input of document.querySelectorAll('#sat-options input,#sat-options select'))input.addEventListener('change',()=>{if(satProducts.length){stopSatellite();clearSatelliteProducts();satelliteMessage('Settings changed. Retrieve again to update the layers.');}});
refreshSatellite();

const exposureGraphs = {
  "population": {
    "expression": {
      "result": "0",
      "values": {
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "functionInvocationValue": {
                              "functionName": "GeometryConstructors.Rectangle",
                              "arguments": {
                                "coordinates": {
                                  "constantValue": [
                                    12.345601,
                                    23.456702,
                                    34.567803,
                                    45.678904
                                  ]
                                },
                                "geodesic": {
                                  "constantValue": false
                                }
                              }
                            }
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.multiply",
                                    "arguments": {
                                      "image1": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.select",
                                          "arguments": {
                                            "bandSelectors": {
                                              "constantValue": [
                                                "population_count"
                                              ]
                                            },
                                            "input": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.load",
                                                "arguments": {
                                                  "id": {
                                                    "constantValue": "__POP_ASSET__"
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      },
                                      "image2": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.constant",
                                          "arguments": {
                                            "value": {
                                              "constantValue": 100
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "population_density"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "population_density"
    ]
  },
  "builtup": {
    "expression": {
      "result": "0",
      "values": {
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "functionInvocationValue": {
                              "functionName": "GeometryConstructors.Rectangle",
                              "arguments": {
                                "coordinates": {
                                  "constantValue": [
                                    12.345601,
                                    23.456702,
                                    34.567803,
                                    45.678904
                                  ]
                                },
                                "geodesic": {
                                  "constantValue": false
                                }
                              }
                            }
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.divide",
                                    "arguments": {
                                      "image1": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.select",
                                          "arguments": {
                                            "bandSelectors": {
                                              "constantValue": [
                                                "built_surface"
                                              ]
                                            },
                                            "input": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.load",
                                                "arguments": {
                                                  "id": {
                                                    "constantValue": "__BUILT_ASSET__"
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      },
                                      "image2": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.constant",
                                          "arguments": {
                                            "value": {
                                              "constantValue": 10000
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "builtup_fraction"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "builtup_fraction"
    ]
  },
  "proxy": {
    "expression": {
      "result": "0",
      "values": {
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "functionInvocationValue": {
                              "functionName": "GeometryConstructors.Rectangle",
                              "arguments": {
                                "coordinates": {
                                  "constantValue": [
                                    12.345601,
                                    23.456702,
                                    34.567803,
                                    45.678904
                                  ]
                                },
                                "geodesic": {
                                  "constantValue": false
                                }
                              }
                            }
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.reproject",
                                    "arguments": {
                                      "crs": {
                                        "functionInvocationValue": {
                                          "functionName": "Projection",
                                          "arguments": {
                                            "crs": {
                                              "constantValue": "__EXPOSURE_CRS__"
                                            },
                                            "transform": {
                                              "constantValue": [
                                                101.0101,
                                                0,
                                                102.0102,
                                                0,
                                                -103.0103,
                                                104.0104
                                              ]
                                            }
                                          }
                                        }
                                      },
                                      "image": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.reduceResolution",
                                          "arguments": {
                                            "bestEffort": {
                                              "constantValue": false
                                            },
                                            "image": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.gt",
                                                "arguments": {
                                                  "image1": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Image.select",
                                                      "arguments": {
                                                        "bandSelectors": {
                                                          "constantValue": [
                                                            "built_surface"
                                                          ]
                                                        },
                                                        "input": {
                                                          "functionInvocationValue": {
                                                            "functionName": "Image.load",
                                                            "arguments": {
                                                              "id": {
                                                                "constantValue": "JRC/GHSL/P2023A/GHS_BUILT_S_10m/2018"
                                                              }
                                                            }
                                                          }
                                                        }
                                                      }
                                                    }
                                                  },
                                                  "image2": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Image.constant",
                                                      "arguments": {
                                                        "value": {
                                                          "constantValue": 0
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            },
                                            "maxPixels": {
                                              "constantValue": 1024
                                            },
                                            "reducer": {
                                              "functionInvocationValue": {
                                                "functionName": "Reducer.max",
                                                "arguments": {}
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "building_presence_proxy"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "building_presence_proxy"
    ]
  },
  "footprints": {
    "expression": {
      "result": "0",
      "values": {
        "1": {
          "functionInvocationValue": {
            "functionName": "GeometryConstructors.Rectangle",
            "arguments": {
              "coordinates": {
                "constantValue": [
                  12.345601,
                  23.456702,
                  34.567803,
                  45.678904
                ]
              },
              "geodesic": {
                "constantValue": false
              }
            }
          }
        },
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "valueReference": "1"
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.reproject",
                                    "arguments": {
                                      "crs": {
                                        "functionInvocationValue": {
                                          "functionName": "Projection",
                                          "arguments": {
                                            "crs": {
                                              "constantValue": "__EXPOSURE_CRS__"
                                            },
                                            "transform": {
                                              "constantValue": [
                                                101.0101,
                                                0,
                                                102.0102,
                                                0,
                                                -103.0103,
                                                104.0104
                                              ]
                                            }
                                          }
                                        }
                                      },
                                      "image": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.paint",
                                          "arguments": {
                                            "color": {
                                              "constantValue": 1
                                            },
                                            "featureCollection": {
                                              "functionInvocationValue": {
                                                "functionName": "Collection.filter",
                                                "arguments": {
                                                  "collection": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Collection.loadTable",
                                                      "arguments": {
                                                        "tableId": {
                                                          "constantValue": "GOOGLE/Research/open-buildings/v3/polygons"
                                                        }
                                                      }
                                                    }
                                                  },
                                                  "filter": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Filter.intersects",
                                                      "arguments": {
                                                        "leftField": {
                                                          "constantValue": ".all"
                                                        },
                                                        "rightValue": {
                                                          "functionInvocationValue": {
                                                            "functionName": "Feature",
                                                            "arguments": {
                                                              "geometry": {
                                                                "valueReference": "1"
                                                              }
                                                            }
                                                          }
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            },
                                            "image": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.toByte",
                                                "arguments": {
                                                  "value": {
                                                    "functionInvocationValue": {
                                                      "functionName": "Image.constant",
                                                      "arguments": {
                                                        "value": {
                                                          "constantValue": 0
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "building_footprint_mask"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "building_footprint_mask"
    ],
    "audit": {
      "result": "0",
      "values": {
        "0": {
          "dictionaryValue": {
            "values": {
              "features": {
                "functionInvocationValue": {
                  "functionName": "Collection.size",
                  "arguments": {
                    "collection": {
                      "functionInvocationValue": {
                        "functionName": "Collection.filter",
                        "arguments": {
                          "collection": {
                            "functionInvocationValue": {
                              "functionName": "Collection.loadTable",
                              "arguments": {
                                "tableId": {
                                  "constantValue": "GOOGLE/Research/open-buildings/v3/polygons"
                                }
                              }
                            }
                          },
                          "filter": {
                            "functionInvocationValue": {
                              "functionName": "Filter.intersects",
                              "arguments": {
                                "leftField": {
                                  "constantValue": ".all"
                                },
                                "rightValue": {
                                  "functionInvocationValue": {
                                    "functionName": "Feature",
                                    "arguments": {
                                      "geometry": {
                                        "functionInvocationValue": {
                                          "functionName": "GeometryConstructors.Rectangle",
                                          "arguments": {
                                            "coordinates": {
                                              "constantValue": [
                                                12.345601,
                                                23.456702,
                                                34.567803,
                                                45.678904
                                              ]
                                            },
                                            "geodesic": {
                                              "constantValue": false
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "nightlights": {
    "expression": {
      "result": "0",
      "values": {
        "2": {
          "constantValue": [
            "avg_rad"
          ]
        },
        "3": {
          "functionInvocationValue": {
            "functionName": "Collection.filter",
            "arguments": {
              "collection": {
                "functionInvocationValue": {
                  "functionName": "ImageCollection.load",
                  "arguments": {
                    "id": {
                      "constantValue": "NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG"
                    }
                  }
                }
              },
              "filter": {
                "functionInvocationValue": {
                  "functionName": "Filter.dateRangeContains",
                  "arguments": {
                    "leftValue": {
                      "functionInvocationValue": {
                        "functionName": "DateRange",
                        "arguments": {
                          "end": {
                            "constantValue": "__LIGHT_END__"
                          },
                          "start": {
                            "constantValue": "__LIGHT_START__"
                          }
                        }
                      }
                    },
                    "rightField": {
                      "constantValue": "system:time_start"
                    }
                  }
                }
              }
            }
          }
        },
        "1": {
          "functionInvocationValue": {
            "functionName": "Image.projection",
            "arguments": {
              "image": {
                "functionInvocationValue": {
                  "functionName": "Image.select",
                  "arguments": {
                    "bandSelectors": {
                      "valueReference": "2"
                    },
                    "input": {
                      "functionInvocationValue": {
                        "functionName": "Collection.first",
                        "arguments": {
                          "collection": {
                            "valueReference": "3"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "6": {
          "functionInvocationValue": {
            "functionName": "Image.constant",
            "arguments": {
              "value": {
                "constantValue": 0
              }
            }
          }
        },
        "5": {
          "functionInvocationValue": {
            "functionName": "Image.updateMask",
            "arguments": {
              "image": {
                "functionInvocationValue": {
                  "functionName": "Image.select",
                  "arguments": {
                    "bandSelectors": {
                      "valueReference": "2"
                    },
                    "input": {
                      "argumentReference": "_MAPPING_VAR_0_0"
                    }
                  }
                }
              },
              "mask": {
                "functionInvocationValue": {
                  "functionName": "Image.gt",
                  "arguments": {
                    "image1": {
                      "functionInvocationValue": {
                        "functionName": "Image.select",
                        "arguments": {
                          "bandSelectors": {
                            "constantValue": [
                              "cf_cvg"
                            ]
                          },
                          "input": {
                            "argumentReference": "_MAPPING_VAR_0_0"
                          }
                        }
                      }
                    },
                    "image2": {
                      "valueReference": "6"
                    }
                  }
                }
              }
            }
          }
        },
        "4": {
          "functionInvocationValue": {
            "functionName": "Collection.map",
            "arguments": {
              "baseAlgorithm": {
                "functionDefinitionValue": {
                  "argumentNames": [
                    "_MAPPING_VAR_0_0"
                  ],
                  "body": "5"
                }
              },
              "collection": {
                "valueReference": "3"
              }
            }
          }
        },
        "0": {
          "functionInvocationValue": {
            "functionName": "Image.unmask",
            "arguments": {
              "input": {
                "functionInvocationValue": {
                  "functionName": "Image.toFloat",
                  "arguments": {
                    "value": {
                      "functionInvocationValue": {
                        "functionName": "Image.clip",
                        "arguments": {
                          "geometry": {
                            "functionInvocationValue": {
                              "functionName": "GeometryConstructors.Rectangle",
                              "arguments": {
                                "coordinates": {
                                  "constantValue": [
                                    12.345601,
                                    23.456702,
                                    34.567803,
                                    45.678904
                                  ]
                                },
                                "geodesic": {
                                  "constantValue": false
                                }
                              }
                            }
                          },
                          "input": {
                            "functionInvocationValue": {
                              "functionName": "Image.rename",
                              "arguments": {
                                "input": {
                                  "functionInvocationValue": {
                                    "functionName": "Image.addBands",
                                    "arguments": {
                                      "dstImg": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.resample",
                                          "arguments": {
                                            "image": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.setDefaultProjection",
                                                "arguments": {
                                                  "crs": {
                                                    "valueReference": "1"
                                                  },
                                                  "image": {
                                                    "functionInvocationValue": {
                                                      "functionName": "reduce.mean",
                                                      "arguments": {
                                                        "collection": {
                                                          "valueReference": "4"
                                                        }
                                                      }
                                                    }
                                                  }
                                                }
                                              }
                                            },
                                            "mode": {
                                              "constantValue": "bilinear"
                                            }
                                          }
                                        }
                                      },
                                      "srcImg": {
                                        "functionInvocationValue": {
                                          "functionName": "Image.setDefaultProjection",
                                          "arguments": {
                                            "crs": {
                                              "valueReference": "1"
                                            },
                                            "image": {
                                              "functionInvocationValue": {
                                                "functionName": "Image.unmask",
                                                "arguments": {
                                                  "input": {
                                                    "functionInvocationValue": {
                                                      "functionName": "reduce.count",
                                                      "arguments": {
                                                        "collection": {
                                                          "valueReference": "4"
                                                        }
                                                      }
                                                    }
                                                  },
                                                  "value": {
                                                    "valueReference": "6"
                                                  }
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                },
                                "names": {
                                  "constantValue": [
                                    "nightlights",
                                    "nightlights_months"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "sameFootprint": {
                "constantValue": false
              },
              "value": {
                "functionInvocationValue": {
                  "functionName": "Image.constant",
                  "arguments": {
                    "value": {
                      "constantValue": -9999
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "bands": [
      "nightlights",
      "nightlights_months"
    ],
    "audit": {
      "result": "0",
      "values": {
        "0": {
          "dictionaryValue": {
            "values": {
              "months": {
                "functionInvocationValue": {
                  "functionName": "Collection.size",
                  "arguments": {
                    "collection": {
                      "functionInvocationValue": {
                        "functionName": "Collection.filter",
                        "arguments": {
                          "collection": {
                            "functionInvocationValue": {
                              "functionName": "ImageCollection.load",
                              "arguments": {
                                "id": {
                                  "constantValue": "NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG"
                                }
                              }
                            }
                          },
                          "filter": {
                            "functionInvocationValue": {
                              "functionName": "Filter.dateRangeContains",
                              "arguments": {
                                "leftValue": {
                                  "functionInvocationValue": {
                                    "functionName": "DateRange",
                                    "arguments": {
                                      "end": {
                                        "constantValue": "__LIGHT_END__"
                                      },
                                      "start": {
                                        "constantValue": "__LIGHT_START__"
                                      }
                                    }
                                  }
                                },
                                "rightField": {
                                  "constantValue": "system:time_start"
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

const exposureProducts = {
  population_density: { label: 'Residential population density', unit: 'people per km²' },
  builtup_fraction: { label: 'Built-up surface fraction', unit: 'fraction (0–1)' },
  building_presence_proxy: { label: 'Building presence proxy', unit: '0 or 1' },
  building_footprint_mask: { label: 'Mapped building footprints', unit: '0 or 1' },
  nightlights: { label: 'Mean night-light radiance', unit: 'nW/cm²/sr' },
  nightlights_months: { label: 'Months with usable night-light observations', unit: 'months (0–12)' },
};

function exposureRequests({ groups, epoch, viirsYear, buildingSource }, now = new Date()) {
  if (!groups.length) throw Error('Select at least one exposure layer.');
  if (!Number.isInteger(epoch) || epoch < 1975 || epoch > 2020 || epoch % 5 !== 0) {
    throw Error('Choose a GHSL estimate year in five-year steps from 1975 to 2020.');
  }
  if (groups.includes('nightlights') && (!Number.isInteger(viirsYear) || viirsYear < 2014 || viirsYear >= now.getUTCFullYear())) {
    throw Error('Choose a completed VIIRS year from 2014 onwards.');
  }
  if (!['proxy', 'footprints'].includes(buildingSource)) throw Error('Choose a building source.');
  return groups.map(group => {
    switch (group) {
      case 'population':
        return { key: group, label: 'GHSL population', asset: 'JRC/GHSL/P2023A/GHS_POP/' + epoch };
      case 'builtup':
        return { key: group, label: 'GHSL built-up surface', asset: 'JRC/GHSL/P2023A/GHS_BUILT_S/' + epoch };
      case 'buildings':
        return buildingSource === 'proxy'
          ? { key: 'proxy', label: 'GHSL building presence proxy', asset: 'JRC/GHSL/P2023A/GHS_BUILT_S_10m/2018' }
          : { key: 'footprints', label: 'Open Buildings footprints', asset: 'GOOGLE/Research/open-buildings/v3/polygons' };
      case 'nightlights':
        return { key: group, label: 'VIIRS night lights', asset: 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG' };
      default:
        throw Error('Unknown exposure layer.');
    }
  });
}

function fillExposureGraph(graph, request, viirsYear, { bounds, grid }) {
  const { scaleX, translateX, scaleY, translateY } = grid.affineTransform;
  const replacements = new Map([
    ['__EXPOSURE_CRS__', grid.crsCode], ['__POP_ASSET__', request.asset], ['__BUILT_ASSET__', request.asset],
    ['__LIGHT_START__', viirsYear + '-01-01'], ['__LIGHT_END__', (viirsYear + 1) + '-01-01'],
    [12.345601, bounds.west], [23.456702, bounds.south], [34.567803, bounds.east], [45.678904, bounds.north],
    [101.0101, scaleX], [102.0102, translateX], [-103.0103, scaleY], [104.0104, translateY],
  ]);
  function replace(value) {
    if (replacements.has(value)) return replacements.get(value);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  }
  return replace(graph);
}

function checkExposureAudit(key, result) {
  if (key === 'nightlights' && result?.months !== 12) {
    throw Error('VIIRS did not return all 12 monthly composites. Choose an earlier year.');
  }
  if (key === 'footprints' && !(result?.features > 0)) {
    throw Error('Open Buildings returned no footprints in this area. Use the GHSL presence proxy or choose a different area.');
  }
}

function decodeExposureLayers(group, bands, mask) {
  const layers = {};
  for (const [name, values] of Object.entries(bands)) {
    if (values.length !== mask.length) throw Error('Exposure band does not match the DEM dimensions.');
    const layer = new Float32Array(mask.length).fill(-9999);
    for (let i = 0; i < mask.length; i++) {
      const value = values[i];
      if (!mask[i] || !Number.isFinite(value) || value === -9999) continue;
      if (name === 'population_density' && value < 0) continue;
      if (name === 'builtup_fraction' && (value < 0 || value > 1)) continue;
      if (name === 'nightlights_months' && (!Number.isInteger(value) || value < 0 || value > 12)) continue;
      if ((name === 'building_presence_proxy' || name === 'building_footprint_mask') && value !== 0 && value !== 1) continue;
      layer[i] = value;
    }
    layers[name] = layer;
  }
  return layers;
}

function callAlignedRasterWorker(active, data, label, onProgress) {
  return new Promise((resolve, reject) => {
    const { worker } = active;
    const signal = active.controller.signal;
    const startTimer = () => setTimeout(() => {
      worker.terminate();
      finish(reject, Error(label + ' raster processing timed out.'));
    }, 30000);
    let timer = startTimer();
    function finish(callback, value) {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      callback(value);
    }
    function onAbort() { finish(reject, new DOMException('Cancelled', 'AbortError')); }
    worker.onmessage = ({ data: response }) => {
      if (response.type === 'progress' && onProgress) {
        clearTimeout(timer);
        timer = startTimer();
        onProgress(response.message);
      } else if (response.type === 'error') finish(reject, Error(response.message));
      else finish(resolve, response);
    };
    worker.onerror = () => finish(reject, Error(label + ' raster worker could not load or decode the response.'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    try { worker.postMessage(data, data.buffer ? [data.buffer] : []); }
    catch (error) { finish(reject, error); }
  });
}

/** Exposure requests share the satellite transport and aligned raster worker. */
function createExposurePanel({ element, readConnection, onPopulationChange, onExposureChange }) {
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
    field('auth').textContent = connected ? 'Using the Earth Engine connection under Study area.' : 'Connect your Google account under Study area to retrieve exposure layers.';
  }
  function clear() {
    urls.forEach(url => URL.revokeObjectURL(url));
    urls = [];
    const hadPopulation = outputs.some(product => product.name === 'population_density');
    outputs = [];
    if (hadPopulation) onPopulationChange?.();
    onExposureChange?.();
    report = null;
    field('cards').replaceChildren();
    field('report').disabled = true;
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
    field('source').textContent = blob ? 'DEM ready · ' + (info?.label || 'retrieved elevation') : 'Retrieve a DEM under Study area or open one here.';
    message('');
    refresh();
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
      onExposureChange?.();
      if (name === 'population_density') onPopulationChange?.();
      const url = URL.createObjectURL(new Blob([tiff], { type: 'image/tiff' }));
      urls.push(url);
      appendRasterCard(field('cards'), product, {
        grid: report.grid,
        ...report.grid.dimensions, label, url, filename: name + '_aligned.tif',
      });
    }
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
      const prepared = await callAlignedRasterWorker(active, { action: 'prepare', buffer }, 'Exposure');
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
          const result = await callAlignedRasterWorker(active, { action: 'product', group: request.key, buffer: pixels, bands: template.bands }, 'Exposure');
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
  field('report').addEventListener('click', () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'siavash-exposure-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return { refresh, setSource, getProducts: () => outputs };
}

const exposurePanel = createExposurePanel({
  element: el,
  onExposureChange: () => queueMicrotask(() => riskPanel.reset()),
  onPopulationChange: () => queueMicrotask(() => weaklinePanel.invalidate()),
  readConnection: () => ({
    project: el('ee-project').value.trim(),
    accessToken: Date.now() < expiresAt ? token : null,
  }),
});
exposurePanel.refresh();

const floodDepthPanel = createFloodDepthPanel({
  element: el,
  onChange: () => mlStackPanel.invalidate(),
  readConnection: () => ({
    project: el('ee-project').value.trim(),
    accessToken: Date.now() < expiresAt ? token : null,
  }),
  request: requestSatellite,
  rasterWorker: satelliteWorkerMain,
  callWorker: callAlignedRasterWorker,
});
floodDepthPanel.refresh();

const weaklinePanel = createWeaklinePanel({
  element: el,
  readInputs: () => mlStackPanel.getFloodAnalysisInputs(),
  onClosureChange: () => hazardPanel.closureChanged(),
  rasterWorker: satelliteWorkerMain,
  callWorker: callAlignedRasterWorker,
});
function riverFeatures() {
  return linearVectors?.features.filter(feature => feature.properties?.kind === 'river') ?? [];
}
const hazardPanel = createHazardPanel({
  element: el,
  readRivers: riverFeatures,
  readInputs: () => mlStackPanel.getFloodAnalysisInputs(),
  onChange: () => queueMicrotask(() => riskPanel.reset()),
  readScenarios: () => weaklinePanel.getScenarios(),
  rasterWorker: satelliteWorkerMain,
  callWorker: callAlignedRasterWorker,
});
const mlStackPanel = createMLStackPanel({
  element: el,
  onWeaklineInputsChange: () => { weaklinePanel.invalidate(); hazardPanel.invalidate(); },
  readSession: () => ({
    dem: terrainSource,
    layers: [...terrainProducts, ...hydroProducts, ...linearProducts, ...satProducts, ...floodDepthPanel.getProducts(), ...exposurePanel.getProducts()],
  }),
  rasterWorker: satelliteWorkerMain,
  callWorker: callAlignedRasterWorker,
});
const riskPanel = createRiskPanel({
  element: el, rasterWorker: satelliteWorkerMain, callWorker: callAlignedRasterWorker,
  readRivers: riverFeatures,
  read: () => {
    const { dem, riskLayers: layers, buildingSource } = mlStackPanel.getFloodAnalysisInputs();
    return {dem,layers,buildingSource,hazard:hazardPanel.getResult()};
  },
});
riskPanel.refresh();
mlStackPanel.refresh();
weaklinePanel.invalidate();
hazardPanel.refresh();

// Keep the request independent of the worker so the failover rules can be tested.
async function retrieveOverpass(query, mode, progress, fetchImpl = fetch, timeoutMs = 45000) {
  const servers = {
    fosssgis: { name: 'FOSSGIS', url: 'https://overpass-api.de/api/interpreter' },
    privatecoffee: { name: 'Private.coffee', url: 'https://overpass.private.coffee/api/interpreter' },
  };
  const order = mode === 'auto'
    ? [servers.fosssgis, servers.privatecoffee]
    : [servers[mode] || servers.privatecoffee];
  const attempts = [];

  for (const { name, url } of order) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let failure;
    let transient = false;
    progress(attempts.length ? attempts[0].error + ' Trying ' + name + '…' : 'Retrieving OSM roads and rivers from ' + name + '…');

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });
      if (!response.ok) {
        failure = name + ' returned HTTP ' + response.status + '.';
        transient = [500, 502, 503, 504].includes(response.status);
      } else {
        if (Number(response.headers.get('Content-Length') || 0) > 20000000) {
          throw Error('The OSM response is too large. Use a smaller area.');
        }
        const text = await response.text();
        if (text.length > 20000000) throw Error('The OSM response is too large. Use a smaller area.');
        let raw;
        try { raw = JSON.parse(text); }
        catch { throw Error(name + ' returned a response that could not be read as JSON.'); }
        if (!raw || !Array.isArray(raw.elements)) throw Error(name + ' returned an invalid Overpass response.');
        if (raw.remark) {
          failure = name + ' returned incomplete data. ' + String(raw.remark).slice(0, 160);
          transient = /timed? ?out|timeout|too busy|server (?:load|overloaded)/i.test(raw.remark);
        } else {
          attempts.push({ server: name, endpoint: url, status: 'complete' });
          return { raw, endpoint: url, attempts };
        }
      }
    } catch (error) {
      transient = controller.signal.aborted || error instanceof TypeError;
      failure = controller.signal.aborted ? name + ' timed out.'
        : error instanceof TypeError ? name + ' could not be reached.'
        : error.message;
    } finally {
      clearTimeout(timer);
    }
    attempts.push({ server: name, endpoint: url, status: 'failed', error: failure });
    if (!transient) break;
  }

  throw Error(attempts.map(attempt => attempt.error).join(' ') + ' Retry later or open a saved OSM JSON or GeoJSON file.');
}