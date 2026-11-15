/** Worker entry point. Receives only DEM bytes; never receives Google credentials. */
export function hydroWorkerMain(computeHydrology, computeTerrain) {
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
      for(const [name,layer] of Object.entries(result.layers)) {
        self.postMessage({type:'progress',message:'Preparing '+name+' GeoTIFF…'});
        let min=Infinity,max=-Infinity,sum=0,count=0;
        for(const v of layer)if(v!==result.nodata&&Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);sum+=v;count++;}
        const preview=new Uint8ClampedArray(width*height*4);
        for(let i=0;i<layer.length;i++) {
          const v=layer[i];if(v===result.nodata||!Number.isFinite(v))continue;
          const f=max===min?.5:(name==='flowacc'?Math.log1p(v-min)/Math.log1p(max-min):(v-min)/(max-min));
          preview.set([Math.round(40+190*f),Math.round(87+137*f),Math.round(82+80*f),255],i*4);
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
