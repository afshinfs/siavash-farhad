import assert from 'node:assert/strict';
import {computeLinear} from './linear-core.mjs';
const input={values:Array(80).fill(100),width:10,height:8,dx:30,dy:30,origin:[0,240],rivers:[[[150,10000],[150,-10000]]],roads:[[[-150,10000],[-150,-10000]]]};
const r=computeLinear(input);
for(let y=0;y<8;y++)for(let x=0;x<10;x++){
 const i=y*10+x;assert.equal(r.layers.river_distance[i],Math.max(0,Math.max(4-x,x-5))*30);
 assert.equal(r.layers.road_distance[i],(x+5)*30);
 assert(r.layers.river_density[i]>=0&&r.layers.river_density[i]<=1);
}
assert.equal(r.diagnostics.densityWindowPixels,7);assert.equal(r.diagnostics.searchBufferMetres,1020);
const empty=computeLinear({...input,rivers:[],roads:[]});assert(empty.layers.river_distance.every(x=>x===-9999));assert(empty.layers.road_distance.every(x=>x===-9999));assert(empty.layers.river_density.every(x=>x===0));assert.equal(empty.warnings.length,2);
const values=[...input.values];values[42]=-9999;const masked=computeLinear({...input,values,nodata:-9999});for(const a of Object.values(masked.layers))assert.equal(a[42],-9999);assert.equal(masked.validCells,79);
// Point/capsule seeds and exact Euclidean distances checked against brute force centres.
const p=computeLinear({...input,rivers:[[[135,135],[135,135]]],roads:[]});
const seeds=[[4,3],[3,3],[5,3],[4,2],[4,4]];
for(let y=0;y<8;y++)for(let x=0;x<10;x++){const expected=Math.min(...seeds.map(([a,b])=>Math.hypot(x-a,y-b)*30));assert(Math.abs(p.layers.river_distance[y*10+x]-expected)<2e-5);}
assert.throws(()=>computeLinear({...input,dx:1,dy:1}));assert.throws(()=>computeLinear({...input,values:[]}));
assert.throws(()=>computeLinear({...input,values:Array(80).fill(-9999),nodata:-9999}));
console.log('PASS: known buffered line distances, outside-DEM features, exact point distances, density range/window, missing-feature NoData, DEM footprint and invalid inputs.');
