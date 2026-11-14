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
  if(demURL) URL.revokeObjectURL(demURL);demURL=null;resultReport=null;
  el('ee-dem-download').hidden=true;el('ee-report-download').disabled=true;
  el('ee-result').textContent='No Earth Engine data retrieved yet.';el('ee-preview').replaceChildren();
  if(elevationLayer&&map){map.removeLayer(elevationLayer);elevationLayer=null;}
}
function clearAccess() {pendingAuth=false;token=null;expiresAt=0;connectedClient=null;session++;refresh();}
function stopRequest() {requestController?.abort();requestController=null;inspector?.terminate();inspector=null;if(inspectionReject){const reject=inspectionReject;inspectionReject=null;reject(new DOMException('Cancelled','AbortError'));}busy=false;refresh();}
function disconnect() {stopRequest();clearAccess();clearResult();el('ee-state').textContent='Disconnected';message('Local connection cleared. Google permissions can be managed in your Google account.');}
function refresh() {
  const connected=Boolean(token)&&Date.now()<expiresAt;
  el('ee-connect').disabled=busy||pendingAuth;el('ee-disconnect').disabled=!token&&!busy&&!pendingAuth;
  el('ee-fetch').disabled=!connected||!grid||busy||drawing;el('ee-cancel').disabled=!busy;
  for(const id of ['ee-client','ee-project','west','south','east','north','ee-apply','ee-preset','ee-draw']) el(id).disabled=busy;
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
  selected=b;grid=nextGrid;clearResult();
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
      for(let i=0;i<values.length;i++){const v=values[i];if(!Number.isFinite(v)||(nodata!==null&&v===nodata))continue;const x=max===min?0.5:(v-min)/(max-min);rgba.set([Math.round(48+175*x),Math.round(90+122*x),Math.round(82+90*x),215],i*4);}
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
el('ee-disconnect').addEventListener('click',disconnect);
for(const id of ['ee-client','ee-project'])el(id).addEventListener('input',()=>{if(token||pendingAuth){disconnect();message('Connection settings changed. Connect again.');}});
el('ee-cancel').addEventListener('click',()=>{session++;stopRequest();clearResult();el('ee-state').textContent='Request stopped';message('Local request stopped. Earth Engine may finish the computation remotely.');});
el('ee-fetch').addEventListener('click',retrieveDem);
for(const id of ['west','south','east','north'])el(id).addEventListener('input',()=>{grid=null;clearResult();refresh();message('Apply the edited coordinates to select the study area.');});
el('ee-report-download').addEventListener('click',()=>{if(!resultReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(resultReport,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='siavash-farhad-earth-engine-dem.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
setInterval(()=>{if(token&&Date.now()>=expiresAt&&!busy){clearAccess();el('ee-state').textContent='Session expired';message('Google access expired. Connect again to retrieve more data.');}},1000);
async function startMap() {
  try {
    await Promise.all([loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js','leaflet-sdk'),loadScript('https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.js','proj4-sdk')]);
    map=window.L.map('ee-map').setView([33.145,47.715],13);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'}).addTo(map);
    map.on('click',event=>{
      if(!drawing||busy)return;
      if(!selectionStart){selectionStart=event.latlng;drawingAnchor=window.L.circleMarker(selectionStart,{radius:4,color:'#b77a18',fillColor:'#fff',fillOpacity:1,weight:2,interactive:false}).addTo(map);updateDrawingPreview(selectionStart);message('Move the pointer to preview; click the opposite corner to finish, or press Escape to cancel.');return;}
      try{applyBounds({west:Math.min(selectionStart.lng,event.latlng.lng),east:Math.max(selectionStart.lng,event.latlng.lng),south:Math.min(selectionStart.lat,event.latlng.lat),north:Math.max(selectionStart.lat,event.latlng.lat)},{fit:false});}catch(e){message(e.message,true);}
      setDrawing(false);
    });
    map.on('mousemove',event=>updateDrawingPreview(event.latlng));
    applyBounds(PRESET);
  }catch(error){message(error.message,true);el('ee-state').textContent='Map unavailable';}
}
loadScript('https://accounts.google.com/gsi/client','google-identity-sdk').catch(error=>message('Google sign-in could not load. Check your connection and reload.',true));
startMap();refresh();
