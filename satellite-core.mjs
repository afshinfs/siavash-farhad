export const manningLookup={10:.15,20:.10,30:.045,40:.05,50:.20,60:.04,70:.02,80:.035,90:.08,95:.12,100:.07};
export const soilGroupLookup={1:4,2:4,3:4,4:3,5:3,6:3,7:3,8:3,9:2,10:4,11:2,12:1};
export function validateSatelliteSettings(input,now=new Date()){
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
export function fillSatelliteTemplate(template,settings,bounds){
  if(!bounds||!['west','south','east','north'].every(k=>Number.isFinite(bounds[k]))||bounds.west>=bounds.east||bounds.south>=bounds.north)throw Error('Invalid satellite request bounds.');
  const replacements={__NDVI_START__:settings.ndviStart,__NDVI_END__:settings.ndviEnd,__RAIN_START__:settings.rainStart,__RAIN_END__:settings.rainEnd,__BASE_START__:settings.baselineStartYear+'-01-01',__BASE_END__:(settings.baselineEndYear+1)+'-01-01',__TARGET_MONTH__:settings.targetMonth+'-01',__NMONTHS__:String(settings.nmonths),__WORLDCOVER__:'ESA/WorldCover/'+(settings.worldcoverYear==='2020'?'v100':'v200')};
  const coords=new Map([[12.345601,bounds.west],[23.456702,bounds.south],[34.567803,bounds.east],[45.678904,bounds.north]]);
  const walk=v=>{if(typeof v==='string'&&/^__.*__$/.test(v)){if(replacements[v]===undefined)throw Error('Missing satellite request setting '+v);return replacements[v];}if(typeof v==='number'&&coords.has(v))return coords.get(v);if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));return v;};return walk(template);
}
export function validateSatelliteAudit(group,audit){
  if(group==='ndvi'&&!(audit.scenes>0))throw Error('No Sentinel-2 SR scenes found for these dates and bounds.');
  if(group==='rainfall'&&(!(audit.days>0)||audit.days!==audit.expectedDays))throw Error('CHIRPS rainfall period is incomplete or unavailable. Choose earlier or shorter dates.');
  if(group==='spi'&&(!(audit.samples>=30)||!(audit.targetDays>0)||audit.targetDays!==audit.expectedTargetDays))throw Error('The anomaly needs at least 30 complete baseline windows and complete target rainfall.');
  return audit;
}
export function deriveSatelliteLayers(group,bands,demValid,lookupTables){
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
