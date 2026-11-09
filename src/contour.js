// Iso-lines on the sensor grid (marching squares on cell centres).

/**
 * @param {{gi:number[],gj:number[],v:number[]}} pts grid indices and values of one level
 * @param {number} h grid spacing
 * @param {number} level threshold value
 * @returns {number[]} segments as flat [x0,y0,x1,y1, ...]
 */
export function contourSegments(pts, h, level) {
  const n = pts.gi.length;
  if (!n) return [];
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (let k = 0; k < n; k++) {
    if (pts.gi[k] < i0) i0 = pts.gi[k]; if (pts.gi[k] > i1) i1 = pts.gi[k];
    if (pts.gj[k] < j0) j0 = pts.gj[k]; if (pts.gj[k] > j1) j1 = pts.gj[k];
  }
  i0--; j0--; i1++; j1++;
  const W = i1 - i0 + 1, H = j1 - j0 + 1;
  const NONE = -1e9;
  const g = new Float64Array(W * H).fill(NONE);
  for (let k = 0; k < n; k++) g[(pts.gj[k] - j0) * W + (pts.gi[k] - i0)] = pts.v[k];
  // fill thin holes (walls, columns) from opposite neighbours so lines don't loop around them
  const f = Float64Array.from(g);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const id = y * W + x;
    if (g[id] !== NONE) continue;
    const l = g[id - 1], r = g[id + 1], d = g[id - W], u = g[id + W];
    let s = 0, c = 0;
    if (l !== NONE && r !== NONE) { s += l + r; c += 2; }
    if (d !== NONE && u !== NONE) { s += d + u; c += 2; }
    if (c) f[id] = s / c;
  }
  const val = (x, y) => f[y * W + x];
  const X = (x) => (x + i0 + 0.5) * h, Y = (y) => (y + j0 + 0.5) * h;
  const out = [];
  const lerp = (a, b) => (a === b ? 0.5 : Math.min(1, Math.max(0, (level - a) / (b - a))));
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a = val(x, y), b = val(x + 1, y), c = val(x + 1, y + 1), d = val(x, y + 1);
    if (a === NONE || b === NONE || c === NONE || d === NONE) continue; // walls / slab edge already bound the area
    const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
    if (code === 0 || code === 15) continue;
    // edge points: bottom (a-b), right (b-c), top (d-c), left (a-d)
    const pB = () => [X(x) + lerp(a, b) * h, Y(y)];
    const pR = () => [X(x + 1), Y(y) + lerp(b, c) * h];
    const pT = () => [X(x) + lerp(d, c) * h, Y(y + 1)];
    const pL = () => [X(x), Y(y) + lerp(a, d) * h];
    const seg = (p, q) => out.push(p[0], p[1], q[0], q[1]);
    const centre = (a + b + c + d) / 4 >= level;
    switch (code) {
      case 1: case 14: seg(pL(), pB()); break;
      case 2: case 13: seg(pB(), pR()); break;
      case 3: case 12: seg(pL(), pR()); break;
      case 4: case 11: seg(pR(), pT()); break;
      case 6: case 9: seg(pB(), pT()); break;
      case 7: case 8: seg(pL(), pT()); break;
      case 5: if (centre) { seg(pL(), pT()); seg(pB(), pR()); } else { seg(pL(), pB()); seg(pR(), pT()); } break;
      case 10: if (centre) { seg(pL(), pB()); seg(pR(), pT()); } else { seg(pL(), pT()); seg(pB(), pR()); } break;
    }
  }
  return out;
}
