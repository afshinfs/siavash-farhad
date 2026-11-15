/** Worker receives DEM bytes and optional public OSM data, never Google credentials. */
export function linearWorkerMain(computeLinear) {
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
      let raw,endpoint=null;
      const query=`[out:json][timeout:35];(way["waterway"="river"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way["highway"~"^(trunk|trunk_link|primary|primary_link)$"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom;`;
      if(data.osmText){progress('Reading the selected OSM file…');raw=JSON.parse(data.osmText);}
      else {
        progress('Retrieving public OSM rivers and major roads (up to 45 seconds)…');endpoint='https://overpass-api.de/api/interpreter';
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);try{
          const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:query}),signal:controller.signal});
          if(!response.ok)throw Error('OSM request returned HTTP '+response.status+'. Try again later, or open a saved OSM JSON/GeoJSON file.');
          if(Number(response.headers.get('Content-Length')||0)>20000000)throw Error('OSM response is too large. Use a smaller area.');
          const text=await response.text();if(text.length>20000000)throw Error('OSM response is too large.');raw=JSON.parse(text);
        }catch(e){if(e.name==='AbortError')throw Error('OSM request timed out. Retry later or open saved OSM data.');throw e;}finally{clearTimeout(timer);}
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
      self.postMessage({type:'complete',products,vectors:{type:'FeatureCollection',features},report:{schemaVersion:1,stage:'roads and rivers',status:result.warnings.length?'completed_with_warnings':'completed',sourceSHA256,source:data.source,osmSource:data.osmText?'selected file':'Overpass API',osmTimestamp:raw.osm3s?.timestamp_osm_base||null,processedAt:new Date().toISOString(),endpoint,query: data.osmText?null:query,queryBounds:bbox,width,height,crs:'EPSG:'+epsg,transform:{scaleX:dx,scaleY:-dy,translateX:origin[0],translateY:origin[1]},nodata:-9999,validCells:result.validCells,diagnostics:result.diagnostics,featureCounts:{roads:roads.length,rivers:rivers.length},warnings:result.warnings,
        methods:{roads:'OSM ways: trunk, trunk_link, primary, primary_link',rivers:'OSM ways: waterway=river',mask:'Capsule line buffer of max(5 m, half a cell); burn every touched pixel',distance:'Exact Euclidean distance between buffered raster-cell centres, in metres',density:'200 m target odd box window, followed by Gaussian sigma=max(1,window/6), truncate=4, half-sample reflect boundaries'},products:Object.fromEntries(products.map(p=>[p.name,p.summary])),seconds:(performance.now()-started)/1000,
        limitations:['Search covers the DEM plus approximately 1 km; features beyond the search bounds are omitted.','Distances are to buffered raster pixels, not exact vector centrelines.','OSM coverage varies. Missing mapped features do not establish absence of roads or rivers.','Only OSM ways are retrieved; relation-only features are omitted.','River density is a smoothed pixel fraction, not river length per square kilometre.','Desktop equivalence has not been established; rasterisation and buffered query extents may differ.','Selected OSM files must cover the search area; their completeness cannot be established automatically.']}},transfer);
    }catch(e){self.postMessage({type:'error',message: 'Roads/rivers: '+String(e.message||e).slice(0,600)});}
  };
}
