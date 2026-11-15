/** Source decoding/export worker. Google credentials never enter this worker. */
export function satelliteWorkerMain(deriveSatelliteLayers,manningLookup,soilGroupLookup){
  importScripts('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js','https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.js');
  let template=null;
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
  async function readGrid(buffer,dem=false){
    const tiff=await GeoTIFF.fromArrayBuffer(buffer);if(await tiff.getImageCount()!==1)throw Error('Use a single-image GeoTIFF without overviews.');
    const image=await tiff.getImage(),keys=image.getGeoKeys(),fd=image.getFileDirectory(),epsg=Number(keys.ProjectedCSTypeGeoKey),matrix=fd.ModelTransformation;
    if(!((epsg>=32601&&epsg<=32660)||(epsg>=32701&&epsg<=32760))||Number(keys.GTRasterTypeGeoKey||1)!==1||fd.SubIFDs||(matrix&&(matrix[1]||matrix[2]||matrix[4]||matrix[6])))throw Error('Use a north-up PixelIsArea WGS84 UTM GeoTIFF.');
    const width=image.getWidth(),height=image.getHeight(),origin=image.getOrigin(),resolution=matrix?[matrix[0],matrix[5],matrix[10]]:image.getResolution(),dx=resolution[0],dy=-resolution[1];
    if(width<1||height<1||width>512||height>512||!origin.slice(0,2).every(Number.isFinite)||!Number.isFinite(dx)||!Number.isFinite(dy)||dx<=0||dy<=0||Math.abs(dx-dy)>1e-8||width*height*dx*dy>25e6)throw Error('Use square metre pixels, at most 512 × 512 cells and 25 km².');
    if(dem&&image.getSamplesPerPixel()!==1)throw Error('The DEM must have one band.');
    return {image,width,height,origin,dx,dy,epsg};
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
        self.postMessage({type:'prepared',grid:{dimensions:{width:t.width,height:t.height},crsCode:'EPSG:'+t.epsg,affineTransform:{scaleX:t.dx,shearX:0,translateX:t.origin[0],shearY:0,scaleY:-t.dy,translateY:t.origin[1]}},bounds,validCells,sourceSHA256});return;
      }
      if(data.action==='product'){
        if(!template)throw Error('Prepare a DEM before requesting satellite layers.');
        const t=await readGrid(data.buffer),s=template;
        if(t.width!==s.width||t.height!==s.height||t.epsg!==s.epsg||Math.abs(t.dx-s.dx)>1e-8||Math.abs(t.dy-s.dy)>1e-8||Math.abs(t.origin[0]-s.origin[0])>1e-5||Math.abs(t.origin[1]-s.origin[1])>1e-5)throw Error('Earth Engine response does not match the DEM grid.');
        if(t.image.getSamplesPerPixel()!==data.bands.length)throw Error('Earth Engine returned an unexpected band count.');
        const raster=await t.image.readRasters(),bands=Object.fromEntries(data.bands.map((name,i)=>[name,raster[i]])),layers=deriveSatelliteLayers(data.group,bands,s.mask,{manning:manningLookup,soil:soilGroupLookup}),products=[],transfer=[];
        const units={lulc:'ESA class code',manning:'Manning n (s m⁻¹ᐟ³)',ndvi:'NDVI (−1 to 1)',ndvi_observations:'valid scene observations',rainfall:'mm accumulated over the selected period',spi_proxy:'standardised precipitation anomaly (z-score)',hsg_proxy:'soil-texture proxy group A=1, B=2, C=3, D=4',merit_hnd:'metres above EGM96 geoid (adjusted elevation)'};
        const classColors={10:[0,100,0],20:[255,187,34],30:[255,255,76],40:[240,150,255],50:[250,0,0],60:[180,180,180],70:[240,240,240],80:[0,100,200],90:[0,150,160],95:[0,207,117],100:[250,230,160]};
        for(const [name,layer] of Object.entries(layers)){
          let count=0,min=Infinity,max=-Infinity,sum=0;for(const v of layer)if(v!==-9999){count++;min=Math.min(min,v);max=Math.max(max,v);sum+=v;}
          const preview=new Uint8ClampedArray(layer.length*4);for(let i=0;i<layer.length;i++){const v=layer[i];if(v===-9999)continue;const f=min===max?.5:(v-min)/(max-min),c=name==='lulc'?classColors[v]:name==='hsg_proxy'?[[0,0,0],[80,180,235],[100,190,100],[235,185,60],[175,85,65]][v]:[Math.round(40+190*f),Math.round(87+137*f),Math.round(82+80*f)];preview.set([...c,255],i*4);}
          const output=writeFloatTIFF(layer,s.width,s.height,s.dx,s.dy,s.origin,s.epsg);products.push({name,tiff:output,preview:preview.buffer,summary:{validCells:count,noDataCells:layer.length-count,min:count?min:null,max:count?max:null,mean:count?sum/count:null,unit:units[name]}});transfer.push(output,preview.buffer);
        }
        self.postMessage({type:'products',group:data.group,products},transfer);
      }
    }catch(e){self.postMessage({type:'error',message:String(e.message||e)});}
  };
}
