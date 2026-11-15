import assert from 'node:assert/strict';
import {validateSatelliteSettings,fillSatelliteTemplate,validateSatelliteAudit,deriveSatelliteLayers,manningLookup,soilGroupLookup} from './satellite-core.mjs';
import {requestSatellite} from './satellite-request.mjs';
import {satelliteGraphTemplates} from './satellite-graphs.mjs';
const settings={groups:['worldcover','ndvi','rainfall','spi','soil','merit'],worldcoverYear:'2021',ndviStart:'2020-01-01',ndviEnd:'2021-01-01',rainStart:'2020-01-01',rainEnd:'2021-01-01',baselineStartYear:1981,baselineEndYear:2024,targetMonth:'2020-12',nmonths:3};
const s=validateSatelliteSettings(settings,new Date('2026-11-15'));assert.equal(s.baselineSamplesExpected,44);
for(const bad of [{ndviStart:'2020-02-30'},{rainEnd:'2020-01-01'},{baselineStartYear:2000},{targetMonth:'2026-11'},{nmonths:5},{groups:[]}])assert.throws(()=>validateSatelliteSettings({...settings,...bad},new Date('2026-11-15')));
assert.equal(validateSatelliteSettings({...settings,targetMonth:'2020-01'},new Date('2026-11-15')).baselineSamplesExpected,43);
const bbox={west:47.69,south:33.14,east:47.72,north:33.17};
for(const [group,t] of Object.entries(satelliteGraphTemplates))for(const key of ['image','audit'])if(t[key]){
 const graph=fillSatelliteTemplate(t[key],s,bbox),text=JSON.stringify(graph);assert(!/__\w+__/.test(text));assert(graph.result in graph.values);assert(text.includes('functionInvocationValue'));
 if(key==='image')assert(text.includes('Image.unmask'));
}
assert.throws(()=>validateSatelliteAudit('rainfall',{days:300,expectedDays:366}));assert.throws(()=>validateSatelliteAudit('ndvi',{scenes:0}));assert.throws(()=>validateSatelliteAudit('spi',{samples:29,targetDays:90,expectedTargetDays:90}));validateSatelliteAudit('spi',{samples:44,targetDays:92,expectedTargetDays:92});
const mask=Uint8Array.from([1,1,1,1,0]);let r=deriveSatelliteLayers('worldcover',{lulc:[10,80,0,999,50]},mask);assert.equal(r.manning[0],Math.fround(.15));assert.equal(r.manning[1],Math.fround(.035));assert.deepEqual(Array.from(r.lulc),[10,80,-9999,-9999,-9999]);
r=deriveSatelliteLayers('soil',{soil_texture:[1,9,12,0,5]},mask);assert.deepEqual(Array.from(r.hsg_proxy),[4,2,1,-9999,-9999]);
r=deriveSatelliteLayers('ndvi',{ndvi:[0,-1,1,NaN,.5],ndvi_observations:[0,10,2,1,2]},mask);assert.deepEqual(Array.from(r.ndvi),[0,-1,1,-9999,-9999]);assert.equal(r.ndvi_observations[0],0);
r=deriveSatelliteLayers('rainfall',{rainfall:[0,100,-1,-9999,4]},mask);assert.deepEqual(Array.from(r.rainfall),[0,100,-9999,-9999,-9999]);
r=deriveSatelliteLayers('merit',{merit_hnd:[-15,0,200,-9999,10]},mask);assert.deepEqual(Array.from(r.merit_hnd),[-15,0,200,-9999,-9999]);
assert.throws(()=>deriveSatelliteLayers('soil',{soil_texture:[1]},mask));
let called=0;const mock=async(url,o)=>{called++;assert(url.endsWith('/value:compute'));assert.equal(o.headers.Authorization,'Bearer mock-token');assert(JSON.parse(o.body).expression);return {ok:true,json:async()=>({result:{scenes:12}})};};
assert.deepEqual(await requestSatellite({project:'ee-test-project',accessToken:'mock-token',expression:{result:'x'},fetchImpl:mock}),{scenes:12});assert.equal(called,1);
await assert.rejects(requestSatellite({project:'ee-test-project',accessToken:'mock-token',expression:{},fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:{message:'ya29.secret'}})})}),e=>e.message.includes('expired')&&!e.message.includes('ya29.secret'));
await assert.rejects(requestSatellite({project:'ee-test-project',accessToken:'mock-token',expression:{},grid:{},bands:['x'],fetchImpl:async()=>({ok:true,headers:new Headers(),arrayBuffer:async()=>new TextEncoder().encode('not tiff').buffer})}),/non-TIFF/);
await assert.rejects(requestSatellite({project:'ee-test-project',accessToken:'mock-token',expression:{},timeoutMs:5,fetchImpl:async(u,o)=>new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))}),/timed out/);
console.log('PASS: date/baseline validation, all expression templates, source completeness guards, all class mappings, NoData, zero/negative preservation, request auth/redaction, invalid TIFF and timeout handling.');
