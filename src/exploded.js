// Exploded axonometric export: every floor sliced out of the model, stacked with a gap,
// with a smooth daylight map, threshold lines, level labels, legend and north arrow.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { contourSegments } from './contour.js';

// ---------------------------------------------------------------- geometry helpers
function clipPoly(poly, axis, value, keepAbove) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = keepAbove ? a[axis] - value : value - a[axis];
    const db = keepAbove ? b[axis] - value : value - b[axis];
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** Clip triangles to an axis-aligned box; returns flat positions. */
function clipToBox(pos, box) {
  const out = [];
  for (let i = 0; i < pos.length; i += 9) {
    const zmin = Math.min(pos[i + 2], pos[i + 5], pos[i + 8]), zmax = Math.max(pos[i + 2], pos[i + 5], pos[i + 8]);
    if (zmax < box.z0 || zmin >= box.z1) continue;
    const xmin = Math.min(pos[i], pos[i + 3], pos[i + 6]), xmax = Math.max(pos[i], pos[i + 3], pos[i + 6]);
    const ymin = Math.min(pos[i + 1], pos[i + 4], pos[i + 7]), ymax = Math.max(pos[i + 1], pos[i + 4], pos[i + 7]);
    if (xmax < box.x0 || xmin > box.x1 || ymax < box.y0 || ymin > box.y1) continue;
    let poly = [[pos[i], pos[i + 1], pos[i + 2]], [pos[i + 3], pos[i + 4], pos[i + 5]], [pos[i + 6], pos[i + 7], pos[i + 8]]];
    const inside = zmin >= box.z0 && zmax < box.z1 && xmin >= box.x0 && xmax <= box.x1 && ymin >= box.y0 && ymax <= box.y1;
    if (!inside) {
      poly = clipPoly(poly, 2, box.z0, true); if (poly.length < 3) continue;
      poly = clipPoly(poly, 2, box.z1, false); if (poly.length < 3) continue;
      poly = clipPoly(poly, 0, box.x0, true); if (poly.length < 3) continue;
      poly = clipPoly(poly, 0, box.x1, false); if (poly.length < 3) continue;
      poly = clipPoly(poly, 1, box.y0, true); if (poly.length < 3) continue;
      poly = clipPoly(poly, 1, box.y1, false); if (poly.length < 3) continue;
    }
    for (let k = 1; k < poly.length - 1; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1]);
  }
  return out;
}

function triNormalZ(p, i) {
  const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
  const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz);
  return { nz: l ? nz / l : 0, area: l / 2 };
}

/** z of the slab underside below level z (area-weighted most common down-facing horizontal face). */
function slabUnderside(allPos, foot, z) {
  const hist = new Map();
  for (const p of allPos) {
    for (let i = 0; i < p.length; i += 9) {
      const cz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3;
      if (cz < z - 1.2 || cz > z - 0.04) continue;
      const cx = (p[i] + p[i + 3] + p[i + 6]) / 3, cy = (p[i + 1] + p[i + 4] + p[i + 7]) / 3;
      if (cx < foot.x0 || cx > foot.x1 || cy < foot.y0 || cy > foot.y1) continue;
      const { nz, area } = triNormalZ(p, i);
      if (Math.abs(nz) < 0.98) continue;
      const k = Math.round(cz * 50);
      hist.set(k, (hist.get(k) || 0) + area);
    }
  }
  let best = null, ba = 0;
  for (const [k, a] of hist) if (a > ba) { ba = a; best = k; }
  return best === null ? z - 0.3 : best / 50;
}

function rampTexture(fn) {
  const N = 512, data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const [r, g, b] = fn((i + 0.5) / N);
    data[i * 4] = r * 255; data[i * 4 + 1] = g * 255; data[i * 4 + 2] = b * 255; data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter; t.needsUpdate = true;
  return t;
}

function heatMaterial(ramp, lo, hi) {
  return new THREE.ShaderMaterial({
    uniforms: { ramp: { value: rampTexture(ramp) }, lo: { value: lo }, hi: { value: hi } },
    vertexShader: 'attribute float val; varying float vV; void main(){ vV = val; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform sampler2D ramp; uniform float lo; uniform float hi; varying float vV; void main(){ float t = clamp((vV-lo)/(hi-lo),0.0,1.0); gl_FragColor = vec4(texture2D(ramp, vec2(t*0.998+0.001,0.5)).rgb,1.0); }',
    side: THREE.DoubleSide,
  });
}

/** Smooth heat-map mesh for one level: one quad per cell, corner values averaged from neighbours. */
function heatGeometry(S, df, idx, h, dz) {
  const map = new Map(), key = (i, j) => i * 100003 + j;
  for (const k of idx) map.set(key(Math.round(S.x[k] / h - 0.5), Math.round(S.y[k] / h - 0.5)), k);
  const corner = (ci, cj) => { // corner between cells (ci-1..ci, cj-1..cj)
    let s = 0, n = 0;
    for (const [a, b] of [[ci - 1, cj - 1], [ci, cj - 1], [ci - 1, cj], [ci, cj]]) { const k = map.get(key(a, b)); if (k !== undefined) { s += df[k]; n++; } }
    return s / n;
  };
  const pos = [], val = [];
  for (const k of idx) {
    const gi = Math.round(S.x[k] / h - 0.5), gj = Math.round(S.y[k] / h - 0.5), z = S.zs[k] + dz;
    const x0 = gi * h, x1 = x0 + h, y0 = gj * h, y1 = y0 + h;
    const v00 = corner(gi, gj), v10 = corner(gi + 1, gj), v11 = corner(gi + 1, gj + 1), v01 = corner(gi, gj + 1);
    pos.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z);
    val.push(v00, v10, v11, v00, v11, v01);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('val', new THREE.Float32BufferAttribute(val, 1));
  return g;
}

function fatLines(positions, color, width, W, H, opacity = 1) {
  const g = new LineSegmentsGeometry(); g.setPositions(positions);
  const m = new LineMaterial({ color, linewidth: width, worldUnits: false, transparent: opacity < 1, opacity });
  m.resolution.set(W, H);
  return new LineSegments2(g, m);
}

// ---------------------------------------------------------------- main
/**
 * @param {object} o
 *  layers: [{positions: Float32Array, kind: 'opaque'|'glass'}]
 *  sensors, df, levels, spacing
 *  names: string[] (per level), stats: string[][] (extra label lines per level)
 *  ramp: { lo, hi, fn(t)->[r,g,b] } in DF units
 *  lines: [{ df, color }]
 *  gap: separation factor × storey height, width: px, roof: bool
 *  viewDir: THREE.Vector3 (target -> camera)
 *  title, subtitle, legend: { title, items:[{type:'fill'|'line', color, label}] } | { title, gradient:[css stops], ticks:[str] }
 */
export async function renderExploded(o) {
  const S = o.sensors, levels = o.levels, h = o.spacing;
  // footprint from sensors
  let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
  for (let i = 0; i < S.count; i++) { fx0 = Math.min(fx0, S.x[i]); fx1 = Math.max(fx1, S.x[i]); fy0 = Math.min(fy0, S.y[i]); fy1 = Math.max(fy1, S.y[i]); }
  fx0 -= h / 2; fy0 -= h / 2; fx1 += h / 2; fy1 += h / 2;
  const M = 1.6; // margin for façades, balconies
  const foot = { x0: fx0 - M, x1: fx1 + M, y0: fy0 - M, y1: fy1 + M };
  const allPos = o.layers.map((l) => l.positions);

  const zl = levels.map((l) => l.z);
  const storey = zl.length > 1 ? (zl[zl.length - 1] - zl[0]) / (zl.length - 1) : 3.2;
  const cuts = zl.map((z) => slabUnderside(allPos, foot, z) - 0.002);
  // roof: lowest down-facing horizontal surface above the top level (its ceiling)
  const top = zl[zl.length - 1];
  let ceil = Infinity;
  for (const p of allPos) for (let i = 0; i < p.length; i += 9) {
    const cz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3;
    if (cz < top + 1.8 || cz >= ceil) continue;
    const cx = (p[i] + p[i + 3] + p[i + 6]) / 3, cy = (p[i + 1] + p[i + 4] + p[i + 7]) / 3;
    if (cx < fx0 || cx > fx1 || cy < fy0 || cy > fy1) continue;
    if (Math.abs(triNormalZ(p, i).nz) > 0.98) ceil = cz;
  }
  const slices = levels.map((l, i) => ({ z0: cuts[i], z1: i + 1 < levels.length ? cuts[i + 1] : (isFinite(ceil) ? ceil - 0.002 : Infinity), level: i }));
  if (o.roof && isFinite(ceil)) slices.push({ z0: ceil - 0.002, z1: Infinity, level: -1 });
  if (!o.roof && isFinite(ceil)) slices[slices.length - 1].z1 = ceil - 0.002;
  const gap = o.gap * storey;

  // --- scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d6cf, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(-1, -2, 3); scene.add(sun);
  const matFloor = new THREE.MeshLambertMaterial({ color: 0xf2f1ee, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const matWall = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.22, depthWrite: false });
  const matGlass = new THREE.MeshLambertMaterial({ color: 0xa8c8e4, side: THREE.DoubleSide, transparent: true, opacity: 0.28, depthWrite: false });
  const heatMat = heatMaterial(o.ramp.fn, o.ramp.lo, o.ramp.hi);

  const W = o.width, Wr = Math.round(W * 0.72);
  const pending = []; // fat line objects needing resolution
  const sliceBoxes = [];
  slices.forEach((sl, si) => {
    const off = si * gap;
    const box = { ...foot, z0: sl.z0, z1: sl.z1 };
    const floor = [], wall = [], glass = [];
    o.layers.forEach((L) => {
      const c = clipToBox(L.positions, box);
      if (L.kind === 'glass') { glass.push(...c); return; }
      for (let i = 0; i < c.length; i += 9) {
        const t = c.slice(i, i + 9);
        (Math.abs(triNormalZ(c, i).nz) > 0.7 ? floor : wall).push(...t);
      }
    });
    const bb = new THREE.Box3();
    const group = new THREE.Group(); group.position.z = off; scene.add(group);
    const edgeSrc = [];
    for (const [arr, mat] of [[floor, matFloor], [wall, matWall], [glass, matGlass]]) {
      if (!arr.length) continue;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeVertexNormals(); g.computeBoundingBox(); bb.union(g.boundingBox);
      const mesh = new THREE.Mesh(g, mat); mesh.renderOrder = mat === matFloor ? 0 : 3; group.add(mesh);
      if (mat !== matGlass) edgeSrc.push(g);
    }
    for (const g of edgeSrc) {
      const e = new THREE.EdgesGeometry(g, 28).attributes.position.array;
      if (e.length) { const l = fatLines(Array.from(e), 0x2b2b2b, W / 2400 * 1.1, Wr, 1); l.renderOrder = 4; group.add(l); pending.push(l); }
    }
    if (sl.level >= 0) {
      const lv = levels[sl.level];
      const hm = new THREE.Mesh(heatGeometry(S, o.df, lv.idx, h, 0.04), heatMat); hm.renderOrder = 1; group.add(hm);
      for (const ln of o.lines) {
        const pts = { gi: [], gj: [], v: [] };
        for (const k of lv.idx) { pts.gi.push(Math.round(S.x[k] / h - 0.5)); pts.gj.push(Math.round(S.y[k] / h - 0.5)); pts.v.push(o.df[k]); }
        const seg = contourSegments(pts, h, ln.df);
        if (!seg.length) continue;
        const z = lv.idx.reduce((s, k) => s + S.zs[k], 0) / lv.idx.length + 0.1;
        const p3 = []; for (let i = 0; i < seg.length; i += 4) p3.push(seg[i], seg[i + 1], z, seg[i + 2], seg[i + 3], z);
        const l = fatLines(p3, ln.color, W / 2400 * 3.2, Wr, 1); l.renderOrder = 5; group.add(l); pending.push(l);
      }
    }
    if (!bb.isEmpty()) { bb.min.z += off; bb.max.z += off; }
    sliceBoxes.push({ bb, off, slice: sl });
  });

  // --- camera
  let d = o.viewDir.clone().normalize();
  if (d.z < 0.25 || d.z > 0.92) d = new THREE.Vector3(0.75, -1, 0.9).normalize();
  const all = new THREE.Box3(); sliceBoxes.forEach((s) => all.union(s.bb));
  const centre = all.getCenter(new THREE.Vector3()), R = all.getSize(new THREE.Vector3()).length();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, R * 10);
  cam.up.set(0, 0, 1); cam.position.copy(centre).addScaledVector(d, R * 2); cam.lookAt(centre); cam.updateMatrixWorld();
  let vx0 = Infinity, vx1 = -Infinity, vy0 = Infinity, vy1 = -Infinity;
  const v = new THREE.Vector3();
  for (const s of sliceBoxes) for (let c = 0; c < 8; c++) {
    v.set(c & 1 ? s.bb.max.x : s.bb.min.x, c & 2 ? s.bb.max.y : s.bb.min.y, c & 4 ? s.bb.max.z : s.bb.min.z).applyMatrix4(cam.matrixWorldInverse);
    vx0 = Math.min(vx0, v.x); vx1 = Math.max(vx1, v.x); vy0 = Math.min(vy0, v.y); vy1 = Math.max(vy1, v.y);
  }
  const pad = 0.04 * Math.max(vx1 - vx0, vy1 - vy0);
  vx0 -= pad; vx1 += pad; vy0 -= pad; vy1 += pad;
  let Hr = Math.round(Wr * (vy1 - vy0) / (vx1 - vx0));
  const maxH = Math.round(W * 1.6);
  if (Hr > maxH) { // too tall: widen frustum horizontally
    const cx = (vx0 + vx1) / 2, half = (vy1 - vy0) * Wr / maxH / 2; vx0 = cx - half; vx1 = cx + half; Hr = maxH;
  }
  cam.left = vx0; cam.right = vx1; cam.top = vy1; cam.bottom = vy0; cam.updateProjectionMatrix();

  // --- render
  const canvas3d = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(Wr, Hr, false);
  pending.forEach((l) => l.material.resolution.set(Wr, Hr));
  renderer.render(scene, cam);

  // --- compose
  const u = W / 2400;
  const font = (px, w = 400) => `${w} ${Math.round(px)}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`;
  const lg = o.legend;
  const legCols = lg.items ? 2 : 1, legRows = lg.items ? Math.ceil(lg.items.length / legCols) : 2;
  const legH = 70 * u + legRows * 44 * u;
  const topPad = Math.round(W * 0.075), botPad = Math.round(legH + 70 * u);
  const Hc = Hr + topPad + botPad;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = Hc;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, Hc);
  ctx.drawImage(canvas3d, 0, topPad);
  const proj = (x, y, z) => { const p = new THREE.Vector3(x, y, z).project(cam); return [(p.x + 1) / 2 * Wr, (1 - p.y) / 2 * Hr + topPad]; };

  // dashed guides between stacked floors (footprint corners)
  ctx.save(); ctx.strokeStyle = 'rgba(60,60,60,0.55)'; ctx.lineWidth = Math.max(1, 1.2 * u); ctx.setLineDash([9 * u, 7 * u]);
  const corners = [[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]];
  for (let i = 0; i + 1 < sliceBoxes.length; i++) {
    const a = sliceBoxes[i], b = sliceBoxes[i + 1];
    const za = (a.slice.level >= 0 ? levels[a.slice.level].z : a.slice.z0) + a.off;
    const zb = (b.slice.level >= 0 ? levels[b.slice.level].z : b.slice.z0) + b.off;
    for (const [x, y] of corners) {
      const p = proj(x, y, za), q = proj(x, y, zb);
      ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke();
    }
  }
  ctx.restore();

  // brackets + labels
  const scr = sliceBoxes.map((s) => {
    let x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const [px, py] = proj(c & 1 ? s.bb.max.x : s.bb.min.x, c & 2 ? s.bb.max.y : s.bb.min.y, c & 4 ? s.bb.max.z : s.bb.min.z);
      x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    return { x1, y0, y1 };
  });
  const bx = Math.min(Wr + 30 * u, Math.max(...scr.map((s) => s.x1)) + 50 * u);
  ctx.strokeStyle = '#1d1f22'; ctx.lineWidth = 2.4 * u; ctx.fillStyle = '#1d1f22';
  sliceBoxes.forEach((s, i) => {
    const sc = scr[i], span = sc.y1 - sc.y0, y0 = sc.y0 + span * 0.12, y1 = sc.y1 - span * 0.12, tick = 22 * u;
    ctx.beginPath(); ctx.moveTo(bx - tick, y0); ctx.lineTo(bx, y0); ctx.lineTo(bx, y1); ctx.lineTo(bx - tick, y1); ctx.stroke();
    const name = s.slice.level >= 0 ? o.names[s.slice.level] : 'Roof';
    const extra = s.slice.level >= 0 ? (o.stats[s.slice.level] || []) : [];
    const lh = 34 * u, total = 46 * u + extra.length * lh;
    let ty = (y0 + y1) / 2 - total / 2 + 36 * u;
    ctx.fillStyle = '#1d1f22'; ctx.font = font(40 * u, 600); ctx.fillText(name, bx + 30 * u, ty);
    ctx.font = font(27 * u); ctx.fillStyle = '#55585d';
    for (const line of extra) {
      ty += lh;
      if (typeof line === 'string') ctx.fillText(line, bx + 30 * u, ty);
      else { // { color, text }
        ctx.fillStyle = line.color; ctx.fillRect(bx + 30 * u, ty - 11 * u, 26 * u, 6 * u);
        ctx.fillStyle = '#55585d'; ctx.fillText(line.text, bx + 66 * u, ty);
      }
    }
  });

  // title
  ctx.fillStyle = '#1d1f22'; ctx.font = font(50 * u, 600); ctx.fillText(o.title, 60 * u, 80 * u);
  ctx.fillStyle = '#6b6e73'; ctx.font = font(28 * u); ctx.fillText(o.subtitle, 60 * u, 124 * u);

  // north arrow (bottom-left)
  const nc = proj(centre.x, centre.y, all.min.z), nn = proj(centre.x, centre.y + 1, all.min.z);
  const ang = Math.atan2(nn[1] - nc[1], nn[0] - nc[0]);
  const ax = 120 * u, ay = Hc - botPad + 110 * u, L = 60 * u;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang + Math.PI / 2);
  ctx.fillStyle = '#1d1f22'; ctx.beginPath(); ctx.moveTo(0, -L); ctx.lineTo(L * 0.42, L * 0.55); ctx.lineTo(0, L * 0.25); ctx.lineTo(-L * 0.42, L * 0.55); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.font = font(30 * u, 600); ctx.fillStyle = '#1d1f22';
  ctx.fillText('N', ax + Math.cos(ang) * L * 1.45 - 10 * u, ay + Math.sin(ang) * L * 1.45 + 10 * u);

  // legend (bottom, right of the north arrow)
  const lx0 = 260 * u, colW = (W - lx0 - 60 * u) / legCols;
  let ly = Hc - botPad + 50 * u;
  ctx.fillStyle = '#1d1f22'; ctx.font = font(28 * u, 600); ctx.fillText(lg.title, lx0, ly);
  ctx.font = font(25 * u);
  const fit = (t, w) => { if (ctx.measureText(t).width <= w) return t; while (t.length > 3 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; };
  if (lg.items) {
    lg.items.forEach((it, i) => {
      const cx = lx0 + (i % legCols) * colW, cy = ly + 50 * u + Math.floor(i / legCols) * 44 * u;
      if (it.type === 'line') { ctx.fillStyle = it.color; ctx.fillRect(cx, cy - 13 * u, 34 * u, 6 * u); }
      else { ctx.fillStyle = it.color; ctx.fillRect(cx, cy - 24 * u, 34 * u, 28 * u); }
      ctx.fillStyle = '#3a3c40'; ctx.fillText(fit(it.label, colW - 70 * u), cx + 50 * u, cy);
    });
  } else {
    const gw = Math.min(W * 0.5, W - lx0 - 60 * u), gr = ctx.createLinearGradient(lx0, 0, lx0 + gw, 0);
    lg.gradient.forEach(([c, t]) => gr.addColorStop(t, c));
    ctx.fillStyle = gr; ctx.fillRect(lx0, ly + 22 * u, gw, 26 * u);
    ctx.fillStyle = '#3a3c40';
    lg.ticks.forEach((t, i) => { const tw = ctx.measureText(t).width; ctx.fillText(t, lx0 + gw * i / (lg.ticks.length - 1) - (i ? (i === lg.ticks.length - 1 ? tw : tw / 2) : 0), ly + 82 * u); });
  }

  renderer.dispose(); heatMat.uniforms.ramp.value.dispose();
  scene.traverse((x) => { x.geometry?.dispose(); });
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  return { blob, width: W, height: Hc };
}
