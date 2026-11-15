/** Deterministic Priority-Flood filling and D8 routing on a north-up metre grid.
 * Flats follow the flood discovery tree, without artificial elevation increments.
 * NoData holes and raster edges are open drainage boundaries.
 */
export function computeHydrology(input, computeTerrain) {
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
