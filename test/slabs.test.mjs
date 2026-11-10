import { thinSlabs } from '../src/slabs.js';
import { makeDemo } from '../src/demo.js';
const d = makeDemo();
const r = thinSlabs(d.objects, (i) => d.objects[i].layer === 0, 0.15);
console.log('levels', r.levels.map((l) => `top ${l.top.toFixed(2)} bottom ${l.bottom.toFixed(2)} -> ${l.newBottom.toFixed(2)}`).join(' | '));
// check: walls/glass that ended at 2.9 now end at 3.05 ; no vertex left in (2.9, 3.05)
let moved = 0, left = 0;
r.positions.forEach((p, oi) => { const o = d.objects[oi].positions; for (let i = 2; i < p.length; i += 3) { if (p[i] !== o[i]) moved++; if (p[i] > 2.9 + 1e-4 && p[i] < 3.05 - 1e-4) left++; } });
const wallTop = Math.max(...Array.from(r.positions[1]).filter((_, i) => i % 3 === 2 && _ < 3.1));
console.log('vertices moved', moved, 'vertices left inside removed band', left, 'ground-floor wall top now', wallTop.toFixed(2));
