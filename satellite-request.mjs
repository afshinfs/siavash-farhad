export async function requestSatellite({project,accessToken,expression,grid=null,bands=null,signal,fetchImpl=fetch,timeoutMs=90000}){
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
