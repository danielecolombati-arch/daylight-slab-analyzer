import { buildScene, makeSensorGrid, classifySensors } from '../src/engine.js';
const quad = (a,b,c,d) => [...a,...b,...c, ...a,...c,...d];
function box(P,x0,y0,z0,x1,y1,z1){const v=[[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];for(const [a,b,c,d] of [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]])P.push(...quad(v[a],v[b],v[c],v[d]));}
// room 12x12x3, slab layer 0, walls 1, core 2
const P=[],M=[]; const add=(arr,m)=>{P.push(...arr);for(let i=0;i<arr.length/9;i++)M.push(m);};
let a=[]; box(a,0,0,-0.3,12,12,0); add(a,0); a=[]; box(a,0,0,3,12,12,3.3); add(a,0);
// case A: closed core volume 2..4 x 2..4 through slab
a=[]; box(a,2,2,-0.3,4,4,3.3); add(a,2);
// case B: core as 4 walls (shaft) 7..10 x 7..10 with a 1 m door gap on one side
a=[]; box(a,7,7,0,10,7.2,3); box(a,7,9.8,0,10,10,3); box(a,7,7.2,0,7.2,9.8,3); box(a,9.8,7.2,0,10,8,3); box(a,9.8,9,0,10,9.8,3); add(a,2);
// case C: flat core patch drawn on slab 2..4 x 8..10
add(quad([2,8,0.001],[4,8,0.001],[4,10,0.001],[2,10,0.001]),2);
const S=buildScene(new Float32Array(P),new Int32Array(M),{type:[0,0,0],rho:[-1,-1,-1],tau:[0,0,0],core:[0,0,1]});
const sens=makeSensorGrid(new Float32Array(quad([0,0,0],[12,0,0],[12,12,0],[0,12,0])),new Int32Array(2),0.5,0.85);
const c=classifySensors(S,sens);
const inside=(i,x0,y0,x1,y1)=>sens.x[i]>x0&&sens.x[i]<x1&&sens.y[i]>y0&&sens.y[i]<y1;
let A=[0,0],B=[0,0],C=[0,0],other=[0,0];
for(let i=0;i<sens.count;i++){const k=c[i]===3?0:1; if(inside(i,2,2,4,4))A[k]++; else if(inside(i,7.2,7.2,9.8,9.8))B[k]++; else if(inside(i,2,8,4,10))C[k]++; else other[k]++;}
console.log('volume core [core,not]',A,' walled shaft',B,' flat patch',C,' rest of floor',other);
