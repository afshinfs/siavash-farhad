/** Buffered line rasterisation, exact Euclidean raster distance and smoothed river fraction. */
export function computeLinear({values,width,height,dx,dy,nodata=null,origin,roads,rivers,bufferMetres=1000,densityWindowMetres=200}) {
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
