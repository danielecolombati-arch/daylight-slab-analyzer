import { buildScene, intersect, makeRng } from '../src/engine.js';
const rng = makeRng(7); const n=5000; const P=new Float32Array(n*9);
for (let i=0;i<n;i++){const cx=rng()*20,cy=rng()*20,cz=rng()*20; for(let k=0;k<3;k++){P[i*9+k*3]=cx+rng()-0.5;P[i*9+k*3+1]=cy+rng()-0.5;P[i*9+k*3+2]=cz+rng()-0.5;}}
const S=buildScene(P,new Int32Array(n),{type:[0],rho:[0.5],tau:[0]});
const B=buildScene(P,new Int32Array(n),{type:[0],rho:[0.5],tau:[0]}); B.nodeI=new Int32Array([0,-n]); B.nodeB=new Float32Array([-1e9,-1e9,-1e9,1e9,1e9,1e9]);
let bad=0;
for(let r=0;r<3000;r++){const o=[rng()*20,rng()*20,rng()*20];let d=[rng()-0.5,rng()-0.5,rng()-0.5];const l=Math.hypot(...d);d=d.map(x=>x/l);
 const a=intersect(S,...o,...d,1e30), ta=S.hitT, b=intersect(B,...o,...d,1e30), tb=B.hitT;
 if ((a<0)!==(b<0) || (a>=0 && Math.abs(ta-tb)>1e-4)) bad++;}
console.log('mismatches', bad);
