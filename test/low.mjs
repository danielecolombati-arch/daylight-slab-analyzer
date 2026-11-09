import { makeDemo } from '../src/demo.js';
import { buildScene, makeSensorGrid, classifySensors, daylightFactor, makeRng } from '../src/engine.js';
const d = makeDemo(); const roles=[0,0,1,0]; // slab, wall opaque, glass, context
let P=[],M=[]; d.objects.forEach(o=>{P.push(...o.positions); for(let i=0;i<o.positions.length/9;i++) M.push(roles[o.layer]);});
const S=buildScene(new Float32Array(P),new Int32Array(M),{type:[0,1],rho:[-1,0],tau:[0,0.7]});
const sl=d.objects[0].positions; const up=[]; for(let i=0;i<sl.length;i+=9){const e1z=sl[i+5]-sl[i+2],e2z=sl[i+8]-sl[i+2];const e1x=sl[i+3]-sl[i],e1y=sl[i+4]-sl[i+1],e2x=sl[i+6]-sl[i],e2y=sl[i+7]-sl[i+1];const nz=e1x*e2y-e1y*e2x; if(nz>0&&Math.abs(e1z)<1e-6&&Math.abs(e2z)<1e-6) up.push(...sl.subarray(i,i+9));}
const sens=makeSensorGrid(new Float32Array(up),new Int32Array(up.length/9),0.5,0.75);
const c=classifySensors(S,sens); const rng=makeRng(3);
const lows=[]; for(let i=0;i<sens.count;i++){ if(c[i]!==1) continue; const v=daylightFactor(S,sens.x[i],sens.y[i],sens.z[i],0,0,1,{samples:64,maxBounces:4,groundRho:0.2},rng); if(v<0.05) lows.push([sens.x[i],sens.y[i],sens.zs[i],v.toFixed(3)]);}
console.log(lows.length, lows.slice(0,20).map(a=>a.join(',')).join(' | '));
import { intersect } from '../src/engine.js';
const B={...S}; B.nodeI=new Int32Array([0,-S.nTris]); B.nodeB=new Float32Array([-1e9,-1e9,-1e9,1e9,1e9,1e9]); B.stack=new Int32Array(8);
const o=[11.25,5.75,0.75]; let mism=0;
for(let k=0;k<200;k++){let d=[rng()-0.5,rng()-0.5,rng()-0.5];const l=Math.hypot(...d);d=d.map(x=>x/l);
 const a=intersect(S,...o,...d,1e30),ta=S.hitT,b=intersect(B,...o,...d,1e30),tb=B.hitT; if(a!==b) mism++; if(k<5) console.log(d.map(x=>x.toFixed(2)), a, ta.toFixed(2), b, tb.toFixed(2), S.tri[a*12+11]);}
console.log('mism',mism);
