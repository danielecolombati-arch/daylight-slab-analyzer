// "What if the slabs were thinner?" — thin every slab from below, keeping its top surface.
// Anything that ended against the old slab underside (façade glass, walls, ceilings of the
// floor below) is stretched up to the new underside, so no gap opens in the envelope.

function triInfo(p, i) {
  const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
  const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz);
  return { nz: l ? nz / l : 0, area: l / 2, cz: (p[i + 2] + p[i + 5] + p[i + 8]) / 3 };
}

/**
 * @param {{positions: Float32Array}[]} objects
 * @param {(index:number)=>boolean} isSlab
 * @param {number} t new slab thickness (m)
 * @returns {{positions: Float32Array[], levels: {top:number, bottom:number, newBottom:number}[]}}
 */
export function thinSlabs(objects, isSlab, t) {
  // 1. slab tops (upward horizontal faces), clustered by height, with their footprint
  const tops = new Map();
  objects.forEach((o, oi) => {
    if (!isSlab(oi)) return;
    const p = o.positions;
    for (let i = 0; i < p.length; i += 9) {
      const f = triInfo(p, i);
      if (f.nz < 0.98 || f.area < 1e-6) continue;
      const k = Math.round(f.cz * 50);
      let T = tops.get(k);
      if (!T) { T = { z: 0, a: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; tops.set(k, T); }
      T.z += f.cz * f.area; T.a += f.area;
      for (let v = 0; v < 3; v++) {
        T.x0 = Math.min(T.x0, p[i + v * 3]); T.x1 = Math.max(T.x1, p[i + v * 3]);
        T.y0 = Math.min(T.y0, p[i + v * 3 + 1]); T.y1 = Math.max(T.y1, p[i + v * 3 + 1]);
      }
    }
  });
  // 2. matching underside for each top (area-weighted most common down-facing face below it)
  const levels = [];
  for (const T of tops.values()) {
    const top = T.z / T.a, hist = new Map();
    objects.forEach((o, oi) => {
      if (!isSlab(oi)) return;
      const p = o.positions;
      for (let i = 0; i < p.length; i += 9) {
        const f = triInfo(p, i);
        if (f.nz > -0.98 || f.cz > top - 0.01 || f.cz < top - 1.5) continue;
        const cx = (p[i] + p[i + 3] + p[i + 6]) / 3, cy = (p[i + 1] + p[i + 4] + p[i + 7]) / 3;
        if (cx < T.x0 || cx > T.x1 || cy < T.y0 || cy > T.y1) continue;
        const k = Math.round(f.cz * 200);
        hist.set(k, (hist.get(k) || 0) + f.area);
      }
    });
    let best = null, ba = 0;
    for (const [k, a] of hist) if (a > ba) { ba = a; best = k; }
    if (best === null) continue;
    const bottom = best / 200, newBottom = top - t;
    if (newBottom <= bottom + 0.005) continue; // already thinner than requested
    levels.push({ top, bottom, newBottom, x0: T.x0 - 0.6, x1: T.x1 + 0.6, y0: T.y0 - 0.6, y1: T.y1 + 0.6 });
  }
  // 3. move every vertex lying in [old underside, new underside) up to the new underside
  const positions = objects.map((o) => {
    if (!levels.length) return o.positions;
    let out = null;
    const p = o.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      for (const L of levels) {
        if (z >= L.bottom - 0.003 && z < L.newBottom - 1e-6 && x >= L.x0 && x <= L.x1 && y >= L.y0 && y <= L.y1) {
          if (!out) out = Float32Array.from(p);
          out[i + 2] = L.newBottom;
          break;
        }
      }
    }
    return out || p;
  });
  return { positions, levels: levels.map(({ top, bottom, newBottom }) => ({ top, bottom, newBottom })) };
}
