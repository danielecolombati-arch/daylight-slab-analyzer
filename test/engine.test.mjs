import { buildScene, daylightFactor, makeRng, makeSensorGrid, classifySensors, MAT_OPAQUE, MAT_GLASS } from '../src/engine.js';

const opts = { samples: 4096, maxBounces: 8, groundRho: 0.2 };
const rng = makeRng(1);
const quad = (a,b,c,d) => [...a,...b,...c, ...a,...c,...d];

// 1. empty scene horizontal -> 100
let S = buildScene(new Float32Array(0), new Int32Array(0), {type:[0],rho:[0.5],tau:[0]});
console.log('empty horiz DF (100):', daylightFactor(S,0,0,1,0,0,1,opts,rng).toFixed(2));
console.log('empty vertical DF (~39.6 sky + 10 ground = 49.6):', daylightFactor(S,0,0,1,1,0,0,opts,rng).toFixed(2));

// 2. Box room 6x6x3 (interior faces), window on south wall x from 1..5, z 0.9..2.4 with glass tau 0.7
function room(withGlass, tau=0.7) {
  const P=[], M=[];
  const add=(arr,m)=>{P.push(...arr); for(let i=0;i<arr.length/9;i++) M.push(m);};
  const W=6,D=6,H=3;
  add(quad([0,0,0],[W,0,0],[W,D,0],[0,D,0]),0);          // floor
  add(quad([0,0,H],[0,D,H],[W,D,H],[W,0,H]),0);          // ceiling
  add(quad([0,D,0],[W,D,0],[W,D,H],[0,D,H]),0);          // north
  add(quad([0,0,0],[0,D,0],[0,D,H],[0,0,H]),0);          // west
  add(quad([W,0,0],[W,0,H],[W,D,H],[W,D,0]),0);          // east
  // south wall y=0 with opening x 1..5 z 0.9..2.4
  add(quad([0,0,0],[W,0,0],[W,0,0.9],[0,0,0.9]),0);
  add(quad([0,0,2.4],[W,0,2.4],[W,0,H],[0,0,H]),0);
  add(quad([0,0,0.9],[1,0,0.9],[1,0,2.4],[0,0,2.4]),0);
  add(quad([5,0,0.9],[W,0,0.9],[W,0,2.4],[5,0,2.4]),0);
  if (withGlass) add(quad([1,0,0.9],[5,0,0.9],[5,0,2.4],[1,0,2.4]),1);
  return { pos:new Float32Array(P), mat:new Int32Array(M), mats:{type:[MAT_OPAQUE,MAT_GLASS],rho:[-1,0],tau:[0,tau]} };
}
const r = room(true);
S = buildScene(r.pos, r.mat, r.mats);
const slab = new Float32Array(quad([0,0,0],[6,0,0],[6,6,0],[0,6,0]));
const sens = makeSensorGrid(slab, new Int32Array(2), 0.5, 0.85);
const cls = classifySensors(S, sens);
console.log('sensors', sens.count, 'indoor', cls.filter(c=>c===1).length);
const o2 = { samples: 256, maxBounces: 6, groundRho: 0.2 };
let t0=performance.now(), sum=0; const rows=[];
for (let i=0;i<sens.count;i++){ const v=daylightFactor(S,sens.x[i],sens.y[i],sens.z[i],0,0,1,o2,rng); sum+=v; if (Math.abs(sens.x[i]-3.25)<0.01) rows.push([sens.y[i],v.toFixed(2)]);}
const t=performance.now()-t0;
console.log('mean DF', (sum/sens.count).toFixed(2), 'time ms', t.toFixed(0), 'rays/s approx', ((sens.count*256*2)/(t/1000)).toExponential(2));
console.log('profile along depth (y, DF):', rows.map(r=>r.join(':')).join('  '));
// BRE average DF: DF = T*Aw*theta / (A*(1-R^2)); Aw=6, theta~90 deg for unobstructed vertical window, A total interior = 2*36+4*18=144
const R = (36*0.2+36*0.7+72*0.5-6*0.5)/144; // approx area-weighted
console.log('BRE estimate (approx, room average over all surfaces basis):', (0.7*6*90/(144*(1-R*R))).toFixed(2), 'R=',R.toFixed(2));
