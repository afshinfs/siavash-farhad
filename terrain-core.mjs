/**
 * Independent implementation of published Horn (1981) derivatives and
 * Zevenbergen–Thorne (1987) contour curvature. Native RichDEM is used only
 * as an external verification reference. No RichDEM code is bundled.
 */
export function computeTerrain({values,width,height,dx,dy,nodata=null}) {
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
