import assert from 'node:assert/strict';
import {computeHydrology} from './hydro-core.mjs';
import {computeTerrain} from './terrain-core.mjs';
const run=(values,width,height,nodata=null)=>computeHydrology({values,width,height,dx:30,dy:30,nodata},computeTerrain);
function conserved(r){assert(r.diagnostics.conservationPassed);assert.equal(r.diagnostics.outletWeight,r.validCells);for(const [k,a] of Object.entries(r.layers))for(const v of a)assert(Number.isFinite(v),k);}
// East-descending plane: cardinal E beats diagonal distance; each row accumulates 1..5.
let r=run(Array.from({length:25},(_,i)=>5-i%5),5,5);conserved(r);
assert.equal(r.diagnostics.filledCells,0);
for(let y=0;y<5;y++)for(let x=0;x<5;x++){const i=y*5+x;assert.equal(r.layers.flowacc[i],x+1);assert.equal(r.layers.flow_direction[i],x===4?0:1);}
// Interior bowl fills exactly to its spill elevation, preserving boundary elevations.
const bowl=[10,10,10,10,10,10,2,2,2,10,10,2,0,2,5,10,2,2,2,10,10,10,10,10,10];
r=run(bowl,5,5);conserved(r);assert.equal(r.layers.dem_filled[12],5);assert.equal(r.diagnostics.filledCells,9);assert.equal(r.diagnostics.maxFillDepth,5);
for(let i=0;i<25;i++)assert(r.layers.dem_filled[i]>=bowl[i]);
// A flat has no artificial elevation slope, but routes without cycles.
r=run(Array(49).fill(7),7,7);conserved(r);assert(r.diagnostics.flatRoutedCells>0);assert(r.layers.dem_filled.every(v=>v===7));
// Missing data preserved, isolated component drains to its own open boundary.
r=run([1,-9999,3,-9999,-9999,-9999,2,-9999,4],3,3,-9999);conserved(r);assert.equal(r.validCells,4);for(const a of Object.values(r.layers))assert.equal(a[4],-9999);
// TWI formula checked independently at an interior plane cell.
r=run(Array.from({length:25},(_,i)=>5-i%5),5,5);
assert(Math.abs(r.layers.twi[12]-Math.log(4/(1/30+0.001)))<1e-6);
// Stress irregular masks, flat plateaux and steep terrain with deterministic random data.
let seed=42;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
for(let t=0;t<30;t++){const z=Array.from({length:1024},()=>rand()<0.1?-9999:Math.floor(rand()*10));r=run(z,32,32,-9999);conserved(r);}
r=run([1],1,1);conserved(r);assert.equal(r.layers.flow_direction[0],0);
assert.throws(()=>run([-9999],1,1,-9999));
console.log('Passed: plane directions/counts, spill filling, flat routing, NoData, TWI, 30 random drainage checks, single cell and invalid input.');
