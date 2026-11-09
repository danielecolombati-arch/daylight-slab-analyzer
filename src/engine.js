// Daylight engine — dependency-free BVH ray tracer + Monte Carlo Daylight Factor
// under the CIE standard overcast sky. Works in browsers, Web Workers and Node.
//
// Units: metres, Z up.
//
// Daylight Factor (DF) = E_inside / E_outside_unobstructed_horizontal * 100
// CIE overcast sky luminance: L(γ) = Lz · (1 + 2·sin γ) / 3   (γ = altitude)
// Unobstructed horizontal illuminance: E_h = 7π/9 · Lz
// With cosine-weighted sampling E = π·mean(L), therefore
//   DF = mean( L/Lz · 9/7 ) over sampled directions.
// Ground (below horizon) is a Lambertian plane of reflectance ρg lit by E_h:
//   L_ground / Lz · 9/7 = ρg.

export const MAT_OPAQUE = 0;
export const MAT_GLASS = 1;

// Auto reflectances by orientation of the visible face (when material rho < 0)
export const AUTO_RHO = { floor: 0.2, wall: 0.5, ceiling: 0.7 };

// ---------------------------------------------------------------- BVH build
/**
 * @param {Float32Array} positions  9 floats per triangle
 * @param {Int32Array|Uint16Array} triMat material index per triangle
 * @param {{type:Float32Array|number[], rho:number[], tau:number[]}} mats
 */
export function buildScene(positions, triMat, mats) {
  const n = (positions.length / 9) | 0;
  const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
  const bmin = new Float32Array(n * 3), bmax = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    let x0 = Math.min(positions[o], positions[o + 3], positions[o + 6]);
    let y0 = Math.min(positions[o + 1], positions[o + 4], positions[o + 7]);
    let z0 = Math.min(positions[o + 2], positions[o + 5], positions[o + 8]);
    let x1 = Math.max(positions[o], positions[o + 3], positions[o + 6]);
    let y1 = Math.max(positions[o + 1], positions[o + 4], positions[o + 7]);
    let z1 = Math.max(positions[o + 2], positions[o + 5], positions[o + 8]);
    bmin[i * 3] = x0; bmin[i * 3 + 1] = y0; bmin[i * 3 + 2] = z0;
    bmax[i * 3] = x1; bmax[i * 3 + 1] = y1; bmax[i * 3 + 2] = z1;
    cx[i] = (x0 + x1) * 0.5; cy[i] = (y0 + y1) * 0.5; cz[i] = (z0 + z1) * 0.5;
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const nb = [];   // node bounds (6 per node)
  const ni = [];   // node info (2 per node): leaf -> [start, -count]; inner -> [right, 0]
  const LEAF = 4;
  const cent = [cx, cy, cz];

  function build(start, end) {
    const node = ni.length / 2;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let c0x = Infinity, c0y = Infinity, c0z = Infinity, c1x = -Infinity, c1y = -Infinity, c1z = -Infinity;
    for (let k = start; k < end; k++) {
      const i = order[k];
      if (bmin[i * 3] < x0) x0 = bmin[i * 3];
      if (bmin[i * 3 + 1] < y0) y0 = bmin[i * 3 + 1];
      if (bmin[i * 3 + 2] < z0) z0 = bmin[i * 3 + 2];
      if (bmax[i * 3] > x1) x1 = bmax[i * 3];
      if (bmax[i * 3 + 1] > y1) y1 = bmax[i * 3 + 1];
      if (bmax[i * 3 + 2] > z1) z1 = bmax[i * 3 + 2];
      if (cx[i] < c0x) c0x = cx[i]; if (cx[i] > c1x) c1x = cx[i];
      if (cy[i] < c0y) c0y = cy[i]; if (cy[i] > c1y) c1y = cy[i];
      if (cz[i] < c0z) c0z = cz[i]; if (cz[i] > c1z) c1z = cz[i];
    }
    nb.push(x0, y0, z0, x1, y1, z1);
    ni.push(0, 0);
    const count = end - start;
    const ex = c1x - c0x, ey = c1y - c0y, ez = c1z - c0z;
    if (count <= LEAF || Math.max(ex, ey, ez) < 1e-9) {
      ni[node * 2] = start; ni[node * 2 + 1] = -count;
      return node;
    }
    const axis = ex > ey ? (ex > ez ? 0 : 2) : (ey > ez ? 1 : 2);
    const c = cent[axis];
    const sub = order.subarray(start, end);
    sub.sort((a, b) => c[a] - c[b]);
    const mid = start + (count >> 1);
    build(start, mid);
    const right = build(mid, end);
    ni[node * 2] = right; ni[node * 2 + 1] = 0;
    return node;
  }
  if (n > 0) build(0, n);

  // Re-pack triangles in BVH order: v0, e1, e2, geometric normal
  const tri = new Float32Array(n * 12);
  const tmat = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const i = order[k], o = i * 9, t = k * 12;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const e1x = positions[o + 3] - ax, e1y = positions[o + 4] - ay, e1z = positions[o + 5] - az;
    const e2x = positions[o + 6] - ax, e2y = positions[o + 7] - ay, e2z = positions[o + 8] - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    tri[t] = ax; tri[t + 1] = ay; tri[t + 2] = az;
    tri[t + 3] = e1x; tri[t + 4] = e1y; tri[t + 5] = e1z;
    tri[t + 6] = e2x; tri[t + 7] = e2y; tri[t + 8] = e2z;
    tri[t + 9] = nx / l; tri[t + 10] = ny / l; tri[t + 11] = nz / l;
    tmat[k] = triMat[i];
  }
  return {
    nTris: n,
    nodeB: new Float32Array(nb),
    nodeI: new Int32Array(ni),
    tri, tmat,
    matType: Int32Array.from(mats.type),
    matRho: Float32Array.from(mats.rho),
    matTau: Float32Array.from(mats.tau),
    matCore: Uint8Array.from(mats.core || mats.type.map(() => 0)),
    hasCore: (mats.core || []).some((c) => c),
    stack: new Int32Array(128),
    hitT: 0,
  };
}

// ---------------------------------------------------------------- traversal
/** Closest hit; returns triangle index (BVH order) or -1. Distance in scene.hitT */
export function intersect(S, ox, oy, oz, dx, dy, dz, tmax) {
  if (S.nTris === 0) return -1;
  const nodeB = S.nodeB, nodeI = S.nodeI, tri = S.tri, stack = S.stack;
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
  let best = -1, bt = tmax;
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp];
    const b = node * 6;
    // slab test
    let t0 = (nodeB[b] - ox) * idx, t1 = (nodeB[b + 3] - ox) * idx;
    let tmin = t0 < t1 ? t0 : t1, tmx = t0 < t1 ? t1 : t0;
    t0 = (nodeB[b + 1] - oy) * idy; t1 = (nodeB[b + 4] - oy) * idy;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tmin) tmin = t0; if (t1 < tmx) tmx = t1;
    t0 = (nodeB[b + 2] - oz) * idz; t1 = (nodeB[b + 5] - oz) * idz;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tmin) tmin = t0; if (t1 < tmx) tmx = t1;
    if (!(tmx >= tmin && tmx >= 0 && tmin <= bt)) continue; // also rejects NaN
    const info = nodeI[node * 2 + 1];
    if (info < 0) {
      const start = nodeI[node * 2], end = start - info;
      for (let k = start; k < end; k++) {
        const t = k * 12;
        const e1x = tri[t + 3], e1y = tri[t + 4], e1z = tri[t + 5];
        const e2x = tri[t + 6], e2y = tri[t + 7], e2z = tri[t + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - tri[t], sy = oy - tri[t + 1], sz = oz - tri[t + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d > 1e-6 && d < bt) { bt = d; best = k; }
      }
    } else {
      stack[sp++] = nodeI[node * 2];   // right
      stack[sp++] = node + 1;          // left (visited first)
    }
  }
  S.hitT = bt;
  return best;
}

/** True if any opaque triangle hit with t in [t0,t1] is seen from its back side (n·d > 0.5). */
export function backHitWithin(S, ox, oy, oz, dx, dy, dz, t0, t1) {
  const nodeB = S.nodeB, nodeI = S.nodeI, tri = S.tri, stack = S.stack;
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
  let sp = 0; stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp], b = node * 6;
    let a0 = (nodeB[b] - ox) * idx, a1 = (nodeB[b + 3] - ox) * idx;
    let tmin = a0 < a1 ? a0 : a1, tmx = a0 < a1 ? a1 : a0;
    a0 = (nodeB[b + 1] - oy) * idy; a1 = (nodeB[b + 4] - oy) * idy;
    if (a0 > a1) { const q = a0; a0 = a1; a1 = q; }
    if (a0 > tmin) tmin = a0; if (a1 < tmx) tmx = a1;
    a0 = (nodeB[b + 2] - oz) * idz; a1 = (nodeB[b + 5] - oz) * idz;
    if (a0 > a1) { const q = a0; a0 = a1; a1 = q; }
    if (a0 > tmin) tmin = a0; if (a1 < tmx) tmx = a1;
    if (!(tmx >= tmin && tmx >= t0 && tmin <= t1)) continue;
    const info = nodeI[node * 2 + 1];
    if (info < 0) {
      const start = nodeI[node * 2], end = start - info;
      for (let k = start; k < end; k++) {
        const t = k * 12;
        if (S.matType[S.tmat[k]] === MAT_GLASS) continue;
        if (tri[t + 9] * dx + tri[t + 10] * dy + tri[t + 11] * dz <= 0.5) continue;
        const e1x = tri[t + 3], e1y = tri[t + 4], e1z = tri[t + 5];
        const e2x = tri[t + 6], e2y = tri[t + 7], e2z = tri[t + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - tri[t], sy = oy - tri[t + 1], sz = oz - tri[t + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d >= t0 && d <= t1) return true;
      }
    } else { stack[sp++] = nodeI[node * 2]; stack[sp++] = node + 1; }
  }
  return false;
}

// ---------------------------------------------------------------- sampling
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const _d = new Float64Array(3);
function cosineDir(nx, ny, nz, r1, r2) {
  const sign = nz >= 0 ? 1 : -1;
  const a = -1 / (sign + nz);
  const b = nx * ny * a;
  const b1x = 1 + sign * nx * nx * a, b1y = sign * b, b1z = -sign * nx;
  const b2x = b, b2y = sign + ny * ny * a, b2z = -ny;
  const phi = 2 * Math.PI * r1, r = Math.sqrt(r2);
  const x = r * Math.cos(phi), y = r * Math.sin(phi), z = Math.sqrt(Math.max(0, 1 - r2));
  _d[0] = x * b1x + y * b2x + z * nx;
  _d[1] = x * b1y + y * b2y + z * ny;
  _d[2] = x * b1z + y * b2z + z * nz;
}

const SKY_K = 9 / 7 / 3;
/** Normalised radiance of whatever is seen in direction d when nothing is hit */
function environment(dz, groundRho) {
  return dz >= 0 ? SKY_K * (1 + 2 * dz) : groundRho;
}

/**
 * Daylight Factor (%) at one point with normal n.
 * opts: { samples, maxBounces, groundRho }
 */
export function daylightFactor(S, px, py, pz, nx, ny, nz, opts, rng) {
  const N = opts.samples, maxB = opts.maxBounces, rg = opts.groundRho;
  const k = Math.max(1, Math.round(Math.sqrt(N)));
  const total = k * k;
  let sum = 0;
  for (let s = 0; s < total; s++) {
    // stratified first direction
    const r1 = ((s % k) + rng()) / k;
    const r2 = (((s / k) | 0) + rng()) / k;
    cosineDir(nx, ny, nz, r1, r2);
    let dx = _d[0], dy = _d[1], dz = _d[2];
    let ox = px + nx * 1e-4, oy = py + ny * 1e-4, oz = pz + nz * 1e-4;
    let w = 1, bounces = 0, glassPasses = 0;
    for (;;) {
      const h = intersect(S, ox, oy, oz, dx, dy, dz, 1e30);
      if (h < 0) { sum += w * environment(dz, rg); break; }
      const t = S.hitT;
      const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
      const m = S.tmat[h];
      if (S.matType[m] === MAT_GLASS) {
        w *= S.matTau[m];
        if (++glassPasses > 8 || w < 1e-3) break;
        ox = hx + dx * 1e-4; oy = hy + dy * 1e-4; oz = hz + dz * 1e-4;
        continue;
      }
      // opaque diffuse surface
      const tb = h * 12;
      let gx = S.tri[tb + 9], gy = S.tri[tb + 10], gz = S.tri[tb + 11];
      if (gx * dx + gy * dy + gz * dz > 0) { gx = -gx; gy = -gy; gz = -gz; } // face the ray
      let rho = S.matRho[m];
      if (rho < 0) rho = gz > 0.7 ? AUTO_RHO.floor : gz < -0.7 ? AUTO_RHO.ceiling : AUTO_RHO.wall;
      if (bounces >= maxB || rng() >= rho) break; // russian roulette with p = rho (unbiased)
      bounces++;
      cosineDir(gx, gy, gz, rng(), rng());
      dx = _d[0]; dy = _d[1]; dz = _d[2];
      ox = hx + gx * 1e-4; oy = hy + gy * 1e-4; oz = hz + gz * 1e-4;
    }
  }
  return (sum / total) * 100;
}

// ---------------------------------------------------------------- sensors
/**
 * Build a sensor grid on the upward-facing triangles of the analysis surfaces.
 * @param {Float32Array} slabPos 9 floats per triangle
 * @param {Int32Array} slabId    id (e.g. object index) per triangle
 * @param {number} spacing grid size (m)
 * @param {number} height  work-plane height above the surface (m)
 * @returns {{x:Float32Array,y:Float32Array,z:Float32Array,zs:Float32Array,id:Int32Array,count:number}}
 *   z = work plane height, zs = surface height (for display)
 */
export function makeSensorGrid(slabPos, slabId, spacing, height) {
  const n = slabPos.length / 9;
  const seen = new Map();
  const X = [], Y = [], Z = [], ZS = [], ID = [];
  const h = spacing;
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const ax = slabPos[o], ay = slabPos[o + 1], az = slabPos[o + 2];
    const bx = slabPos[o + 3], by = slabPos[o + 4], bz = slabPos[o + 5];
    const cx = slabPos[o + 6], cy = slabPos[o + 7], cz = slabPos[o + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    if (Math.abs(nz / len) < 0.98) continue;  // near-horizontal only
    const det = e1x * e2y - e2x * e1y; // 2D determinant
    if (Math.abs(det) < 1e-12) continue;
    const minx = Math.min(ax, bx, cx), maxx = Math.max(ax, bx, cx);
    const miny = Math.min(ay, by, cy), maxy = Math.max(ay, by, cy);
    const i0 = Math.ceil(minx / h - 0.5), i1 = Math.floor(maxx / h - 0.5);
    const j0 = Math.ceil(miny / h - 0.5), j1 = Math.floor(maxy / h - 0.5);
    for (let gi = i0; gi <= i1; gi++) {
      const x = (gi + 0.5) * h;
      for (let gj = j0; gj <= j1; gj++) {
        const y = (gj + 0.5) * h;
        const px = x - ax, py = y - ay;
        const u = (px * e2y - e2x * py) / det;
        const v = (e1x * py - px * e1y) / det;
        if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
        const zsurf = az + u * e1z + v * e2z;
        const key = gi + ',' + gj + ',' + Math.round(zsurf * 20);
        if (seen.has(key)) continue;
        seen.set(key, 1);
        X.push(x); Y.push(y); Z.push(zsurf + height); ZS.push(zsurf); ID.push(slabId[i]);
      }
    }
  }
  return {
    x: Float32Array.from(X), y: Float32Array.from(Y), z: Float32Array.from(Z),
    zs: Float32Array.from(ZS), id: Int32Array.from(ID), count: X.length,
  };
}

/**
 * Classify sensors: 1 = indoor & free, 0 = outdoor (sky straight above),
 * 2 = inside a solid, 3 = core (stairs, lifts, shafts — see isCore). A point is inside a solid when most of 6 axis rays hit the
 * back side of a face (normal pointing away from the point), or when an opaque
 * object sits between the slab surface and the work plane.
 */
const DIRS = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
const H8 = Array.from({ length: 8 }, (_, k) => [Math.cos((k + 0.13) * Math.PI / 4), Math.sin((k + 0.13) * Math.PI / 4)]);

/** Number of core-flagged triangles crossed by the ray with t in (t0, t1]. */
export function countCoreHits(S, ox, oy, oz, dx, dy, dz, t0, t1) {
  const nodeB = S.nodeB, nodeI = S.nodeI, tri = S.tri, stack = S.stack;
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
  let sp = 0, count = 0; stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp], b = node * 6;
    let a0 = (nodeB[b] - ox) * idx, a1 = (nodeB[b + 3] - ox) * idx;
    let tmin = a0 < a1 ? a0 : a1, tmx = a0 < a1 ? a1 : a0;
    a0 = (nodeB[b + 1] - oy) * idy; a1 = (nodeB[b + 4] - oy) * idy;
    if (a0 > a1) { const q = a0; a0 = a1; a1 = q; }
    if (a0 > tmin) tmin = a0; if (a1 < tmx) tmx = a1;
    a0 = (nodeB[b + 2] - oz) * idz; a1 = (nodeB[b + 5] - oz) * idz;
    if (a0 > a1) { const q = a0; a0 = a1; a1 = q; }
    if (a0 > tmin) tmin = a0; if (a1 < tmx) tmx = a1;
    if (!(tmx >= tmin && tmx >= t0 && tmin <= t1)) continue;
    const info = nodeI[node * 2 + 1];
    if (info < 0) {
      const start = nodeI[node * 2], end = start - info;
      for (let k = start; k < end; k++) {
        if (!S.matCore[S.tmat[k]]) continue;
        const t = k * 12;
        const e1x = tri[t + 3], e1y = tri[t + 4], e1z = tri[t + 5];
        const e2x = tri[t + 6], e2y = tri[t + 7], e2z = tri[t + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - tri[t], sy = oy - tri[t + 1], sz = oz - tri[t + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d > t0 && d <= t1) count++;
      }
    } else { stack[sp++] = nodeI[node * 2]; stack[sp++] = node + 1; }
  }
  return count;
}

/**
 * Is this point part of a core (stairs, lifts, shafts)? True when it is
 *  - inside a closed core volume (odd number of crossings both up and down), or
 *  - standing on a flat core patch drawn on the slab (core surface just below), or
 *  - enclosed by core walls (most horizontal rays hit core geometry first, within 12 m).
 */
export function isCore(S, x, y, z, zs) {
  const up = countCoreHits(S, x, y, z, 1e-7, 1e-7, 1, 1e-6, 1e30);
  const down = countCoreHits(S, x, y, z, 1e-7, 1e-7, -1, 1e-6, 1e30);
  if (up % 2 === 1 && down % 2 === 1) return true;
  if (countCoreHits(S, x, y, z, 1e-7, 1e-7, -1, 1e-6, z - zs + 0.05) > 0) return true;
  let walls = 0;
  for (let k = 0; k < 8; k++) {
    const h = intersect(S, x, y, z, H8[k][0], H8[k][1], 1e-7, 12);
    if (h >= 0 && S.matCore[S.tmat[h]]) walls++;
  }
  return walls >= 6;
}
export function classifySensors(S, sensors) {
  const out = new Uint8Array(sensors.count);
  for (let i = 0; i < sensors.count; i++) {
    const x = sensors.x[i], y = sensors.y[i], z = sensors.z[i];
    if (S.hasCore && isCore(S, x, y, z, sensors.zs[i])) { out[i] = 3; continue; }
    const zs = sensors.zs[i] + 0.02;
    const span = z - zs;
    if (span > 0.01) {
      const h = intersect(S, x, y, zs, 1e-7, 1e-7, 1, span);
      if (h >= 0 && S.matType[S.tmat[h]] !== MAT_GLASS) { out[i] = 2; continue; }
    }
    let back = 0, up = -1;
    for (let k = 0; k < 6; k++) {
      const d = DIRS[k];
      const dx = d[0] || 1e-7, dy = d[1] || 1e-7, dz = d[2] || 1e-7;
      const h = intersect(S, x, y, z, dx, dy, dz, 1e30);
      if (k === 0) up = h;
      if (h < 0) continue;
      const th = S.hitT;
      if (backHitWithin(S, x, y, z, dx, dy, dz, th - 2e-3, th + 2e-3)) back++;
    }
    if (back >= 4) { out[i] = 2; continue; }
    out[i] = up < 0 ? 0 : 1;
  }
  return out;
}
