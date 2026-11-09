import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';
import { makeSensorGrid, MAT_OPAQUE, MAT_GLASS } from './engine.js';
import { makeDemo } from './demo.js';

const $ = (id) => document.getElementById(id);
const ROLES = { slab: 'Solaio', opaque: 'Opaco', glass: 'Vetro', ignore: 'Ignora' };

// ------------------------------------------------------------------ viewer
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
renderer.setClearColor(0xeceae5);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
camera.position.set(30, -40, 30);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b3a8, 2.2));
const dir = new THREE.DirectionalLight(0xffffff, 1.3); dir.position.set(-30, -50, 80); scene.add(dir);
const modelGroup = new THREE.Group(); scene.add(modelGroup);
const resultGroup = new THREE.Group(); scene.add(resultGroup);
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e9);

function resize() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
  camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view); resize();
(function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();

// ------------------------------------------------------------------ state
let model = null;    // { name, layers:[{name,color,role,rho,tau,tris}], objects:[{layer, positions}] , bbox }
let result = null;   // { sensors, df: Float32Array, levels, spacing, eext }
let displayMode = 'zone';
let ghost = false;

// ------------------------------------------------------------------ loading
const drop = $('drop'), fileInput = $('file');
drop.onclick = () => fileInput.click();
fileInput.onchange = () => fileInput.files[0] && loadFile(fileInput.files[0]);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); };
$('demo').onclick = () => setModel(makeDemo(), 1);
$('units').onchange = () => { if (lastRaw) setModel(lastRaw.model, lastRaw.autoScale); };

let lastRaw = null;
const LIB = new URL("../vendor/rhino3dm/", import.meta.url).href;

const UNIT_SCALE = { 0: 1, 1: 1e-6, 2: 0.001, 3: 0.01, 4: 1, 5: 1000, 8: 0.0254, 9: 0.3048, 12: 0.1,
  none: 1, microns: 1e-6, millimeters: 0.001, centimeters: 0.01, meters: 1, kilometers: 1000, inches: 0.0254, feet: 0.3048, decimeters: 0.1 };
function unitScaleFrom(settings) {
  let u = settings && settings.modelUnitSystem;
  if (u && typeof u === 'object') u = u.value ?? u.name;
  if (typeof u === 'string') { const k = u.toLowerCase().replace('unitsystem.', ''); return UNIT_SCALE[k] ?? 1; }
  if (typeof u === 'number') return UNIT_SCALE[u] ?? 1;
  return 1;
}

async function loadFile(file) {
  setStatus('lettura di ' + file.name + '…');
  $('modelInfo').textContent = 'Caricamento in corso…';
  try {
    const buf = await file.arrayBuffer();
    const loader = new Rhino3dmLoader(); loader.setLibraryPath(LIB);
    const obj = await new Promise((res, rej) => loader.parse(buf, res, rej));
    loader.dispose();
    const layersSrc = obj.userData.layers || [];
    const layers = layersSrc.map((l) => ({
      name: l.fullPath || l.name || 'Layer',
      color: l.color ? `rgb(${l.color.r},${l.color.g},${l.color.b})` : '#cccccc',
    }));
    if (!layers.length) layers.push({ name: 'Default', color: '#cccccc' });
    const objects = [];
    obj.updateMatrixWorld(true);
    let skipped = 0;
    obj.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
      const pos = g.attributes.position;
      if (!pos || pos.count < 3) return;
      const p = new Float32Array(pos.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        p[i * 3] = v.x; p[i * 3 + 1] = v.y; p[i * 3 + 2] = v.z;
      }
      const li = o.userData?.attributes?.layerIndex ?? 0;
      objects.push({ layer: li >= 0 && li < layers.length ? li : 0, positions: p });
    });
    // count Brep/Extrusion without render meshes (loader emits empty objects for them)
    skipped = new Set((obj.userData.warnings || []).filter((w) => w.type === 'missing mesh').map((w) => w.guid)).size;
    const m = { name: file.name, layers, objects, skipped };
    setModel(m, unitScaleFrom(obj.userData.settings));
  } catch (err) {
    console.error(err);
    $('modelInfo').innerHTML = `<div class="warn">Impossibile leggere il file: ${escapeHtml(err.message || String(err))}</div>`;
    setStatus('errore');
  }
}

function guessRole(name) {
  const n = name.toLowerCase();
  if (/vetr|glass|glaz|window|finestr|serrament|vitr|lucernar|skylight/.test(n)) return 'glass';
  if (/slab|solai|solet|floor|pavim|impalcat|deck/.test(n)) return 'slab';
  if (/(^|[^a-z])(dim|dimensions?|quot[ae]|annot\w*|text|testi?|testo|hatch|tratteggi|curve|linee|lines|grid|griglia|assi|axes|camera|lights?|luci)([^a-z]|$)/.test(n)) return 'ignore';
  return 'opaque';
}

function setModel(raw, autoScale) {
  lastRaw = { model: raw, autoScale };
  const sel = $('units').value;
  const scale = sel === 'auto' ? autoScale : parseFloat(sel);
  const layers = raw.layers.map((l, i) => ({ ...l, role: guessRole(l.name), rho: '', tau: 0.7, tris: 0, index: i }));
  const objects = raw.objects.map((o) => {
    const p = scale === 1 ? o.positions : o.positions.map((x) => x * scale);
    layers[o.layer].tris += p.length / 9;
    return { layer: o.layer, positions: p };
  });
  // If nothing looks like a slab, pick the layer with most horizontal area
  if (!layers.some((l) => l.role === 'slab' && l.tris > 0)) {
    let best = -1, bestA = 0;
    const area = new Float64Array(layers.length);
    for (const o of objects) area[o.layer] += horizontalArea(o.positions);
    area.forEach((a, i) => { if (a > bestA && layers[i].role === 'opaque') { bestA = a; best = i; } });
    if (best >= 0) layers[best].role = 'slab';
  }
  model = { name: raw.name, layers, objects, skipped: raw.skipped || 0, scale };
  result = null;
  clearResults();
  buildModelMeshes();
  renderLayerTable();
  const tris = objects.reduce((s, o) => s + o.positions.length / 9, 0);
  const bb = model.bbox, sz = bb.getSize(new THREE.Vector3());
  let info = `<b>${escapeHtml(raw.name)}</b> · ${objects.length} oggetti · ${fmtInt(tris)} triangoli · ${sz.x.toFixed(1)} × ${sz.y.toFixed(1)} × ${sz.z.toFixed(1)} m`;
  if (model.skipped) info += `<div class="warn">${model.skipped} oggetti (polisuperfici/estrusioni) non hanno una mesh di rendering salvata e sono stati ignorati. In Rhino salva il file da una vista <i>Shaded</i> senza "Save Small", oppure converti in mesh con il comando <code>_Mesh</code>.</div>`;
  if (!tris) info += `<div class="warn">Nessuna geometria trovata nel file.</div>`;
  if (Math.max(sz.x, sz.y, sz.z) > 2000) info += `<div class="warn">Il modello sembra enorme: controlla le unità (menu "Unità").</div>`;
  $('modelInfo').innerHTML = info;
  $('empty').style.display = tris ? 'none' : '';
  for (const s of ['s-layers', 's-params', 's-run']) $(s).classList.toggle('disabled', !tris);
  $('s-results').classList.add('disabled');
  updateEstimate();
  setStatus('pronto');
}

function horizontalArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i += 9) {
    const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
    const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0 && nz / l > 0.98) a += l / 2;
  }
  return a;
}

// ------------------------------------------------------------------ model display
function buildModelMeshes() {
  disposeGroup(modelGroup);
  const bbox = new THREE.Box3();
  const byLayer = new Map();
  for (const o of model.objects) {
    if (!byLayer.has(o.layer)) byLayer.set(o.layer, []);
    byLayer.get(o.layer).push(o.positions);
  }
  for (const [li, arrs] of byLayer) {
    const n = arrs.reduce((s, a) => s + a.length, 0);
    const p = new Float32Array(n); let off = 0;
    for (const a of arrs) { p.set(a, off); off += a.length; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.computeVertexNormals();
    g.computeBoundingBox(); bbox.union(g.boundingBox);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.9, metalness: 0, clippingPlanes: [clipPlane], polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    mesh.userData.layer = li;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x55524c, transparent: true, opacity: 0.35, clippingPlanes: [clipPlane] }));
    edges.userData.layer = li;
    modelGroup.add(mesh, edges);
  }
  model.bbox = bbox;
  styleModel();
  fitCamera('3d');
}

function styleModel() {
  if (!model) return;
  for (const m of modelGroup.children) {
    const L = model.layers[m.userData.layer];
    m.visible = L.role !== 'ignore';
    if (m.isMesh) {
      const mat = m.material;
      const c = new THREE.Color(L.color);
      if (L.role === 'glass') { mat.color.set(0x7fb2dd); mat.transparent = true; mat.opacity = 0.28; mat.depthWrite = false; }
      else {
        mat.color.copy(c).lerp(new THREE.Color(0xffffff), 0.45);
        mat.transparent = ghost; mat.opacity = ghost ? 0.18 : 1; mat.depthWrite = !ghost;
      }
      mat.needsUpdate = true;
    } else {
      m.material.opacity = ghost ? 0.2 : 0.35;
    }
  }
}

function fitCamera(mode) {
  if (!model || model.bbox.isEmpty()) return;
  let bb = model.bbox;
  if (result) { // frame the analysed slabs, not the context
    bb = new THREE.Box3(); const S = result.sensors, lv = currentLevel(), v = new THREE.Vector3();
    const ids = lv ? lv.idx : null, n = ids ? ids.length : S.count;
    for (let j = 0; j < n; j++) { const i = ids ? ids[j] : j; bb.expandByPoint(v.set(S.x[i], S.y[i], S.zs[i])); bb.expandByPoint(v.set(S.x[i], S.y[i], S.z[i] + 1)); }
  }
  const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z * 1.5) || 10;
  const lv = currentLevel();
  if (lv && !result) c.z = lv.z;
  controls.target.copy(c);
  const fov = THREE.MathUtils.degToRad(camera.fov), fitR = Math.max(s.y, s.x / camera.aspect) / 2 / Math.tan(fov / 2);
  if (mode === 'plan') camera.position.set(c.x, c.y - 0.001, c.z + fitR * 1.15 + s.z);
  else camera.position.set(c.x + r * 0.9, c.y - r * 1.25, c.z + r * 0.85);
  camera.near = r / 500; camera.far = r * 50; camera.updateProjectionMatrix();
  controls.update();
}

$('v3d').onclick = () => { setSeg('v3d', 'vPlan'); fitCamera('3d'); };
$('vPlan').onclick = () => { setSeg('vPlan', 'v3d'); fitCamera('plan'); };
const MODES = { zone: 'mZone', df: 'mDF', lux: 'mLux' };
function setMode(m) { displayMode = m; for (const [k, id] of Object.entries(MODES)) $(id).classList.toggle('on', k === m); syncLegendRange(); recolor(); }
$('mZone').onclick = () => setMode('zone');
$('mDF').onclick = () => setMode('df');
$('mLux').onclick = () => setMode('lux');
$('ghost').onclick = () => { ghost = !ghost; $('ghost').textContent = 'Modello: ' + (ghost ? 'trasparente' : 'pieno'); styleModel(); };
$('level').onchange = () => { applyLevel(); fitCamera($('vPlan').classList.contains('on') ? 'plan' : '3d'); };
function setSeg(on, off) { $(on).classList.add('on'); $(off).classList.remove('on'); }

// ------------------------------------------------------------------ layer table
function renderLayerTable() {
  const tb = $('layerRows'); tb.innerHTML = '';
  model.layers.forEach((L, i) => {
    if (!L.tris) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="name" title="${escapeHtml(L.name)}"><span class="sw" style="background:${L.color}"></span>${escapeHtml(L.name)}</td>
      <td><select>${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === L.role ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><input type="number" min="0" max="1" step="0.05" placeholder="auto" value="${L.rho}"></td>
      <td><input type="number" min="0" max="1" step="0.05" value="${L.tau}"></td>`;
    const [sel, rho, tau] = tr.querySelectorAll('select,input');
    const sync = () => { tau.disabled = L.role !== 'glass'; rho.disabled = L.role === 'glass' || L.role === 'ignore'; };
    sel.onchange = () => { L.role = sel.value; sync(); styleModel(); updateEstimate(); };
    rho.onchange = () => { L.rho = rho.value; };
    tau.onchange = () => { L.tau = parseFloat(tau.value) || 0; };
    sync();
    tb.appendChild(tr);
  });
}

// ------------------------------------------------------------------ sensors & scene assembly
function getOpts() {
  const [samples, maxBounces] = $('quality').value.split(',').map(Number);
  return {
    spacing: Math.max(0.05, parseFloat($('spacing').value) || 0.5),
    height: Math.max(0, parseFloat($('height').value) || 0),
    groundRho: clamp(parseFloat($('ground').value), 0, 1, 0.2),
    eext: parseFloat($('eext').value) || 19200,
    samples, maxBounces,
    indoorOnly: $('indoorOnly').checked,
    solidFilter: $('solidFilter').checked,
  };
}

function buildSlabTriangles() {
  // Upward-facing horizontal triangles of slab objects. If an object only has downward ones
  // (single surface with flipped normal), flip them.
  const out = [], ids = [];
  model.objects.forEach((o, oi) => {
    if (model.layers[o.layer].role !== 'slab') return;
    const p = o.positions, up = [], down = [];
    for (let i = 0; i < p.length; i += 9) {
      const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
      const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz); if (!l) continue;
      if (nz / l > 0.98) up.push(i); else if (nz / l < -0.98) down.push(i);
    }
    if (up.length) for (const i of up) { out.push(...p.subarray(i, i + 9)); ids.push(oi); }
    else for (const i of down) { out.push(p[i], p[i + 1], p[i + 2], p[i + 6], p[i + 7], p[i + 8], p[i + 3], p[i + 4], p[i + 5]); ids.push(oi); }
  });
  return { pos: new Float32Array(out), ids: new Int32Array(ids) };
}

function buildTraceScene() {
  const mats = { type: [], rho: [], tau: [] }, matOf = new Map();
  model.layers.forEach((L, i) => {
    if (L.role === 'ignore') return;
    matOf.set(i, mats.type.length);
    mats.type.push(L.role === 'glass' ? MAT_GLASS : MAT_OPAQUE);
    const r = parseFloat(L.rho);
    mats.rho.push(L.role === 'glass' ? 0 : (isFinite(r) ? clamp(r, 0, 0.98, 0.5) : -1));
    mats.tau.push(L.role === 'glass' ? clamp(L.tau, 0, 1, 0.7) : 0);
  });
  let n = 0;
  for (const o of model.objects) if (matOf.has(o.layer)) n += o.positions.length;
  const positions = new Float32Array(n), triMat = new Int32Array(n / 9);
  let off = 0;
  for (const o of model.objects) {
    if (!matOf.has(o.layer)) continue;
    positions.set(o.positions, off);
    triMat.fill(matOf.get(o.layer), off / 9, (off + o.positions.length) / 9);
    off += o.positions.length;
  }
  return { positions, triMat, mats };
}

function updateEstimate() {
  if (!model) return;
  const o = getOpts();
  const slab = buildSlabTriangles();
  let area = 0;
  for (let i = 0; i < slab.pos.length; i += 9) area += horizontalArea(slab.pos.subarray(i, i + 9));
  const pts = area / (o.spacing * o.spacing);
  const cores = navigator.hardwareConcurrency || 4;
  const sec = (pts * o.samples * (1.6 + o.maxBounces * 0.12)) / (1.2e6 * cores);
  $('estimate').innerHTML = slab.pos.length
    ? `≈ ${fmtInt(pts)} punti di calcolo su ${fmtNum(area, 0)} m² di solai · tempo stimato ${sec < 60 ? Math.max(1, Math.round(sec)) + ' s' : Math.round(sec / 60) + ' min'} (${cores} core)`
    : `<span class="warn" style="display:block">Nessun layer impostato come <b>Solaio</b> con superfici orizzontali.</span>`;
}
for (const id of ['spacing', 'quality']) $(id).addEventListener('input', updateEstimate);

// ------------------------------------------------------------------ run
let workers = [], running = false;
$('run').onclick = () => (running ? cancel() : run());

function cancel() {
  workers.forEach((w) => w.terminate()); workers = [];
  running = false; $('run').textContent = 'Calcola Daylight Factor'; setStatus('annullato'); setBar(0);
}

async function run() {
  const o = getOpts();
  const slab = buildSlabTriangles();
  if (!slab.pos.length) { setStatus('nessun solaio da analizzare'); return; }
  const sensors = makeSensorGrid(slab.pos, slab.ids, o.spacing, o.height);
  if (!sensors.count) { setStatus('griglia vuota: riduci il passo'); return; }
  if (sensors.count > 400000) { setStatus(`troppi punti (${fmtInt(sensors.count)}): aumenta il passo griglia`); return; }
  running = true; $('run').textContent = 'Annulla'; clearResults();
  const t0 = performance.now();
  const sc = buildTraceScene();
  const nW = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4)));
  setStatus(`preparazione scena (${fmtInt(sc.triMat.length)} triangoli, ${nW} thread)…`);
  workers = Array.from({ length: nW }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
  try {
    await Promise.all(workers.map((w) => call(w, { type: 'init', ...sc }, 'ready')));
    // classify on worker 0
    const { cls } = await call(workers[0], { type: 'classify', sensors }, 'classified');
    const keep = [];
    let outdoor = 0, solid = 0;
    for (let i = 0; i < sensors.count; i++) {
      if (cls[i] === 0 && o.indoorOnly) { outdoor++; continue; }
      if (cls[i] === 2 && o.solidFilter) { solid++; continue; }
      keep.push(i);
    }
    if (!keep.length) throw new Error('Tutti i punti sono stati scartati dai filtri. Prova a disattivare "Scarta i punti dentro muri e solidi".');
    const S = subsetSensors(sensors, keep);
    // job queue
    const CH = Math.max(16, Math.min(256, Math.ceil(S.count / (nW * 12))));
    const df = new Float32Array(S.count);
    let next = 0, done = 0, seed = 12345;
    setStatus(`calcolo ${fmtInt(S.count)} punti…`);
    await Promise.all(workers.map(async (w) => {
      while (running && next < S.count) {
        const a = next, b = Math.min(S.count, next + CH); next = b;
        const r = await call(w, { type: 'df', jobId: a, x: S.x.slice(a, b), y: S.y.slice(a, b), z: S.z.slice(a, b), opts: o, seed: seed++ }, 'result');
        df.set(r.values, a);
        done += b - a;
        setBar(done / S.count);
        const el = (performance.now() - t0) / 1000, eta = el / done * (S.count - done);
        setStatus(`calcolo ${fmtInt(done)} / ${fmtInt(S.count)} punti · ${eta > 1 ? 'mancano ~' + fmtDur(eta) : 'quasi finito'}`);
      }
    }));
    if (!running) return;
    result = { sensors: S, df, spacing: o.spacing, eext: o.eext, ref: parseFloat($('use').value) || 2, outdoor, solid, opts: o };
    result.levels = makeLevels(S);
    result.raw = df; result.df = smooth(S, df, o.spacing);
    const secs = (performance.now() - t0) / 1000;
    let msg = `fatto in ${fmtDur(secs)} · ${fmtInt(S.count)} punti`;
    if (outdoor) msg += ` · ${fmtInt(outdoor)} esterni esclusi`;
    if (solid) msg += ` · ${fmtInt(solid)} dentro solidi esclusi`;
    setStatus(msg);
    if (solid > 0.4 * sensors.count) setStatus(msg + ' ⚠ molti punti scartati: le normali del modello potrebbero essere invertite');
    showResults();
  } catch (err) {
    console.error(err);
    setStatus('errore: ' + (err.message || err));
  } finally {
    workers.forEach((w) => w.terminate()); workers = [];
    running = false; $('run').textContent = 'Calcola Daylight Factor';
  }
}

function call(w, msg, expect) {
  return new Promise((res, rej) => {
    w.onmessage = (e) => { if (e.data.type === expect) res(e.data); };
    w.onerror = (e) => rej(new Error(e.message || 'errore nel worker'));
    w.postMessage(msg);
  });
}

function subsetSensors(s, keep) {
  const pick = (a) => { const o = new a.constructor(keep.length); keep.forEach((k, i) => (o[i] = a[k])); return o; };
  return { x: pick(s.x), y: pick(s.y), z: pick(s.z), zs: pick(s.zs), id: pick(s.id), count: keep.length };
}

// Light 3x3 smoothing on the grid (same surface height) to reduce Monte Carlo noise.
function smooth(S, df, h) {
  const key = (gi, gj, z) => gi + ',' + gj + ',' + z;
  const map = new Map(), gi = new Int32Array(S.count), gj = new Int32Array(S.count), gz = new Int32Array(S.count);
  for (let i = 0; i < S.count; i++) {
    gi[i] = Math.round(S.x[i] / h - 0.5); gj[i] = Math.round(S.y[i] / h - 0.5); gz[i] = Math.round(S.zs[i] * 20);
    map.set(key(gi[i], gj[i], gz[i]), i);
  }
  const out = new Float32Array(S.count);
  for (let i = 0; i < S.count; i++) {
    let sum = df[i] * 4, w = 4;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      if (!a && !b) continue;
      const k = map.get(key(gi[i] + a, gj[i] + b, gz[i]));
      if (k !== undefined) { const wt = a && b ? 1 : 2; sum += df[k] * wt; w += wt; }
    }
    out[i] = sum / w;
  }
  return out;
}

function makeLevels(S) {
  const zs = Array.from(new Set(Array.from(S.zs, (z) => Math.round(z * 20) / 20))).sort((a, b) => a - b);
  const clusters = [];
  for (const z of zs) {
    const c = clusters[clusters.length - 1];
    if (c && z - c.max < 0.6) c.max = z; else clusters.push({ min: z, max: z });
  }
  const levels = clusters.map((c, i) => ({ i, z: c.min, max: c.max, idx: [] }));
  for (let k = 0; k < S.count; k++) {
    const z = S.zs[k];
    let li = levels.findIndex((l) => z >= l.z - 0.03 && z <= l.max + 0.03);
    if (li < 0) li = 0;
    levels[li].idx.push(k);
  }
  return levels.filter((l) => l.idx.length);
}

// ------------------------------------------------------------------ results display
let cells = null;
function clearResults() {
  disposeGroup(resultGroup); cells = null;
  $('legend').style.display = 'none';
  $('level').innerHTML = '<option value="all">Tutti i livelli</option>';
  clipPlane.constant = 1e9;
}

function showResults() {
  const { sensors: S, spacing } = result;
  const geo = new THREE.PlaneGeometry(spacing * 0.94, spacing * 0.94);
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
  cells = new THREE.InstancedMesh(geo, mat, S.count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < S.count; i++) { m.makeTranslation(S.x[i], S.y[i], S.zs[i] + 0.03); cells.setMatrixAt(i, m); }
  cells.instanceMatrix.needsUpdate = true;
  resultGroup.add(cells);
  const sel = $('level');
  sel.innerHTML = '<option value="all">Tutti i livelli</option>' + result.levels.map((l, i) => `<option value="${i}">Livello ${fmtZ(l.z)}</option>`).join('');
  if (result.levels.length > 1) sel.value = '0';
  // default scale
  const sorted = Float32Array.from(result.df).sort();
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 5;
  result.dfMax = Math.max(1, niceCeil(Math.min(p95, 10)));
  syncLegendRange();
  ghost = true; $('ghost').textContent = 'Modello: trasparente'; styleModel();
  $('legend').style.display = 'block';
  $('s-results').classList.remove('disabled');
  applyLevel();
  renderStats();
  setSeg('vPlan', 'v3d'); fitCamera('plan');
}

function syncLegendRange() {
  if (!result) return;
  const k = displayMode === 'lux' ? result.eext / 100 : 1;
  $('lgMin').value = 0; $('lgMax').value = +(result.dfMax * k).toFixed(displayMode === 'lux' ? 0 : 1);
  $('lgMin').step = $('lgMax').step = displayMode === 'lux' ? 50 : 0.5;
}
$('lgMin').onchange = $('lgMax').onchange = () => recolor();
$('use').onchange = () => { if (result) { result.ref = parseFloat($('use').value) || 2; renderStats(); } };
$('eext').onchange = () => { if (result) { result.eext = parseFloat($('eext').value) || 19200; syncLegendRange(); recolor(); renderStats(); } };

function currentLevel() {
  const v = $('level').value;
  return result && v !== 'all' ? result.levels[+v] : null;
}

function applyLevel() {
  if (!result || !cells) return;
  const lv = currentLevel();
  clipPlane.constant = lv ? lv.max + Math.max(1.2, result.opts.height + 0.5) : 1e9;
  const vis = new Uint8Array(result.sensors.count);
  if (lv) for (const k of lv.idx) vis[k] = 1; else vis.fill(1);
  const m = new THREE.Matrix4(), S = result.sensors, zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < S.count; i++) { if (vis[i]) m.makeTranslation(S.x[i], S.y[i], S.zs[i] + 0.03); cells.setMatrixAt(i, vis[i] ? m : zero); }
  cells.instanceMatrix.needsUpdate = true;
  cells.computeBoundingSphere();
  result.visible = vis;
  recolor();
  renderStats();
}

function recolor() {
  if (!result || !cells) return;
  const c = new THREE.Color();
  const zoneMode = displayMode === 'zone';
  $('lgZones').style.display = zoneMode ? '' : 'none';
  $('lgRng').style.display = $('lgBar').style.display = $('lgTicks').style.display = zoneMode ? 'none' : '';
  if (zoneMode) {
    const th = thresholds();
    for (let i = 0; i < result.sensors.count; i++) cells.setColorAt(i, c.set(ZONES[zoneOf(result.df[i], th)].color));
    cells.instanceColor.needsUpdate = true;
    $('lgTitle').textContent = 'Zone di luce naturale (EN 17037)';
    renderZoneLegend();
    return;
  }
  const lo = parseFloat($('lgMin').value) || 0, hi = Math.max(lo + 1e-6, parseFloat($('lgMax').value) || 1);
  const k = displayMode === 'lux' ? result.eext / 100 : 1;
  for (let i = 0; i < result.sensors.count; i++) {
    const t = (result.df[i] * k - lo) / (hi - lo);
    colormap(t, c); cells.setColorAt(i, c);
  }
  cells.instanceColor.needsUpdate = true;
  // legend
  const stops = [];
  for (let i = 0; i <= 10; i++) { colormap(i / 10, c); stops.push(`#${c.getHexString()} ${i * 10}%`); }
  $('lgBar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  const ticks = [];
  for (let i = 0; i <= 4; i++) ticks.push(`<span>${fmtNum(lo + (hi - lo) * i / 4, displayMode === 'lux' ? 0 : 1)}${i === 4 ? '+' : ''}</span>`);
  $('lgTicks').innerHTML = ticks.join('');
  $('lgTitle').textContent = displayMode === 'lux' ? `Illuminamento (lux superati per metà delle ore di luce)` : 'Daylight Factor (%)';
}

// Viridis-like perceptual colormap
const CMAP = [[0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530], [0.207, 0.372, 0.553], [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441], [0.478, 0.821, 0.318], [0.741, 0.873, 0.150], [0.993, 0.906, 0.144]];
function colormap(t, out) {
  t = Math.min(1, Math.max(0, t)) * (CMAP.length - 1);
  const i = Math.min(CMAP.length - 2, Math.floor(t)), f = t - i, a = CMAP[i], b = CMAP[i + 1];
  return out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, THREE.SRGBColorSpace);
}

// ------------------------------------------------------------------ evaluation
// Zones by illuminance exceeded for 50% of daylight hours (EN 17037 method 1)
const ZONES = [
  { key: 'buio', label: 'Buio', desc: '< 100 lx · serve quasi sempre luce artificiale', color: '#3b2a63' },
  { key: 'scarso', label: 'Scarso', desc: '100–300 lx · ok per passaggio, poco per leggere', color: '#d8743a' },
  { key: 'suff', label: 'Sufficiente', desc: '300–500 lx · si legge e si lavora', color: '#e8c547' },
  { key: 'buono', label: 'Buono', desc: '500–750 lx · ben illuminato', color: '#8cc265' },
  { key: 'ottimo', label: 'Molto luminoso', desc: '> 750 lx · molto luminoso', color: '#2e9b72' },
];
const GRADES = {
  critico: { label: 'Critico', color: '#a8322d', icon: '!' },
  insuff: { label: 'Insufficiente', color: '#d0662b', icon: '✗' },
  suff: { label: 'Sufficiente', color: '#b99412', icon: '~' },
  buono: { label: 'Buono', color: '#5b9b3c', icon: '✓' },
  ottimo: { label: 'Ottimo', color: '#24835e', icon: '★' },
};
function thresholds() {
  const E = result.eext;
  return { d100: 100 / E * 100, d300: 300 / E * 100, d500: 500 / E * 100, d750: 750 / E * 100 };
}
function zoneOf(v, th) { return v < th.d100 ? 0 : v < th.d300 ? 1 : v < th.d500 ? 2 : v < th.d750 ? 3 : 4; }
function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]; }

function evaluate(idx) {
  const { df, spacing, eext, ref } = result;
  if (!idx.length) return null;
  const th = thresholds();
  const v = Float32Array.from(idx, (k) => df[k]).sort();
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const med = pct(v, 0.5), p5 = pct(v, 0.05);
  const zones = [0, 0, 0, 0, 0];
  for (const x of v) zones[zoneOf(x, th)]++;
  const zf = zones.map((z) => z / n);
  const en = med >= th.d750 && p5 >= th.d500 ? 3 : med >= th.d500 && p5 >= th.d300 ? 2 : med >= th.d300 && p5 >= th.d100 ? 1 : 0;
  const nat = mean >= ref;
  let grade;
  if (med < th.d100 || mean < ref / 2) grade = 'critico';
  else if (!nat || en === 0) grade = 'insuff';
  else grade = en === 1 ? 'suff' : en === 2 ? 'buono' : 'ottimo';
  return { n, area: n * spacing * spacing, mean, med, p5, min: v[0], max: v[n - 1], uni: mean > 0 ? pct(v, 0.01) / mean : 0,
    zf, en, nat, grade, th, lux: mean / 100 * eext, luxMed: med / 100 * eext };
}

const EN_LABEL = ['non raggiunto', 'minimo', 'medio', 'alto'];
function renderStats() {
  if (!result) return;
  const lv = currentLevel();
  const all = Array.from({ length: result.sensors.count }, (_, i) => i);
  const ev = evaluate(lv ? lv.idx : all);
  const th = ev.th, G = GRADES[ev.grade];
  const where = lv ? `Livello ${fmtZ(lv.z)}` : (result.levels.length > 1 ? 'Tutti i livelli' : 'Solaio analizzato');
  const lit = ev.zf[2] + ev.zf[3] + ev.zf[4], dark = ev.zf[0];
  $('verdict').innerHTML = `<div class="verdict" style="background:${G.color}"><div class="dot">${G.icon}</div><div>
    <div class="g">${G.label}</div><div class="s">${where} · ${verdictSentence(ev)}</div></div></div>`;
  $('kMean').textContent = fmtNum(ev.mean, 2) + '%';
  $('kThr').textContent = Math.round(lit * 100) + '%';
  $('kThrL').textContent = 'area con ≥ 300 lx';
  $('kLux').textContent = fmtInt(ev.luxMed);
  document.querySelector('#kLux + .l').textContent = 'lux (mediana)';
  $('lgCount').textContent = `${fmtInt(ev.n)} punti · ${fmtNum(ev.area, 0)} m²`;

  const ck = (ok, txt) => `<li><span class="ic ${ok === true ? 'ok' : ok === false ? 'ko' : 'mid'}">${ok === true ? '✓' : ok === false ? '✗' : '!'}</span><span>${txt}</span></li>`;
  const useName = $('use').selectedOptions[0].textContent.split('·')[0].trim();
  const checks = [
    ck(ev.nat, `<b>DF medio ${fmtNum(ev.mean, 2)}%</b> ${ev.nat ? '≥' : '<'} ${fmtNum(result.ref, 0)}% richiesto per ${useName.toLowerCase()} (${result.ref >= 3 ? 'D.M. 18/12/1975' : 'D.M. 5/7/1975'}).`),
    ck(ev.en > 0, `<b>EN 17037: livello ${EN_LABEL[ev.en]}</b>. Metà della superficie riceve almeno ${fmtInt(ev.luxMed)} lx (mediana DF ${fmtNum(ev.med, 2)}%, obiettivo ≥ ${fmtNum(th.d300, 1)}%), il 95% almeno ${fmtInt(ev.p5 / 100 * result.eext)} lx (DF ${fmtNum(ev.p5, 2)}%, obiettivo ≥ ${fmtNum(th.d100, 1)}%).`),
    ck(ev.uni >= 0.3 ? true : ev.uni >= 0.15 ? null : false, `<b>Uniformità ${fmtNum(ev.uni, 2)}</b> (min/medio). ${ev.uni >= 0.3 ? 'Luce ben distribuita.' : ev.uni >= 0.15 ? 'Forte differenza tra zone vicine e lontane dalle finestre.' : 'Luce molto concentrata: alcune zone sono quasi al buio.'}`),
  ];
  const zbar = ZONES.map((z, i) => `<div style="width:${ev.zf[i] * 100}%;background:${z.color}" title="${z.label} ${Math.round(ev.zf[i] * 100)}%"></div>`).join('');
  const zrows = ZONES.map((z, i) => `<div class="zrow"><i style="background:${z.color}"></i><span><b>${z.label}</b> <span style="color:var(--muted)">${z.desc}</span></span><span style="font-family:var(--mono)">${Math.round(ev.zf[i] * 100)}%</span></div>`).reverse().join('');
  const tips = suggestions(ev);
  $('evalDetail').innerHTML = `<div class="zbar">${zbar}</div>${zrows}<ul class="checks">${checks.join('')}</ul>` +
    (tips.length ? `<div style="margin-top:12px;font-weight:600;font-size:12.5px">Cosa si può migliorare</div><ul class="tips">${tips.map((t) => `<li>${t}</li>`).join('')}</ul>` : '') +
    `<p class="note">Soglie EN 17037 per E esterna mediana ${fmtInt(result.eext)} lx (Roma: 19.200 lx). Le verifiche di legge vanno fatte locale per locale: qui il calcolo è sull'intera superficie del piano, quindi è un'indicazione.</p>`;

  const rows = result.levels.map((l) => [`Livello ${fmtZ(l.z)}`, evaluate(l.idx)]);
  if (rows.length > 1) rows.push(['Totale', evaluate(all)]);
  $('stats').innerHTML = `<tr><th></th><th>m²</th><th>DF medio</th><th>DF min</th><th>≥300 lx</th><th>giudizio</th></tr>` +
    rows.map(([nm, e]) => `<tr><td>${nm}</td><td>${fmtNum(e.area, 0)}</td><td>${fmtNum(e.mean, 2)}</td><td>${fmtNum(e.min, 2)}</td><td>${Math.round((e.zf[2] + e.zf[3] + e.zf[4]) * 100)}%</td><td><span class="pill" style="background:${GRADES[e.grade].color}">${GRADES[e.grade].label}</span></td></tr>`).join('');
}

function verdictSentence(ev) {
  const lit = Math.round((ev.zf[2] + ev.zf[3] + ev.zf[4]) * 100), dark = Math.round(ev.zf[0] * 100);
  switch (ev.grade) {
    case 'critico': return `Poca luce naturale: solo il ${lit}% della superficie arriva a 300 lx e il ${dark}% resta sotto i 100 lx. Servirà luce artificiale quasi sempre.`;
    case 'insuff': return `Luce naturale non sufficiente: il ${lit}% della superficie è ben illuminato, ma ${!ev.nat ? 'il DF medio è sotto il minimo di legge' : 'le zone lontane dalle finestre restano troppo buie'}.`;
    case 'suff': return `Luce sufficiente: il ${lit}% della superficie supera i 300 lx per metà delle ore di luce. Requisiti minimi rispettati.`;
    case 'buono': return `Buona luce naturale: il ${lit}% della superficie supera i 300 lx e quasi tutto il piano supera i 100 lx.`;
    default: return `Luce naturale abbondante su quasi tutta la superficie. Verifica abbagliamento e surriscaldamento estivo.`;
  }
}

function suggestions(ev) {
  const t = [];
  if (ev.grade === 'ottimo' || ev.zf[4] > 0.35) t.push('Molte zone sono molto luminose: valuta schermature regolabili (frangisole, tende) contro abbagliamento e surriscaldamento.');
  if (ev.grade === 'ottimo' || ev.grade === 'buono') return t;
  if (ev.uni < 0.2) t.push('La luce si ferma vicino alle finestre: alza l\'architrave o porta le finestre fino al soffitto (la luce entra più in profondità), oppure riduci la profondità degli ambienti (regola pratica: ≤ 2,5 volte l\'altezza della finestra).');
  if (ev.zf[0] > 0.2) t.push('Per le zone buie lontane dalle facciate: lucernari, pozzi di luce o tubi solari all\'ultimo piano; partizioni vetrate o sopraluce verso gli ambienti illuminati.');
  if (ev.med < ev.th.d300) t.push('Aumenta la superficie vetrata (indicativamente oltre 1/8 della superficie del pavimento) o usa vetri con trasmittanza luminosa più alta (τ 0,70–0,80).');
  t.push('Riduci le ostruzioni davanti alle finestre (balconi profondi, aggetti, imbotti spesse) o svasa gli imbotti.');
  t.push('Usa finiture interne chiare: soffitto bianco (ρ ≈ 0,8) e pareti chiare aumentano la luce riflessa in profondità. Puoi provarlo cambiando ρ nella tabella dei layer.');
  return t;
}

function renderZoneLegend() {
  const lv = currentLevel();
  const all = Array.from({ length: result.sensors.count }, (_, i) => i);
  const ev = evaluate(lv ? lv.idx : all);
  $('lgZones').innerHTML = ZONES.map((z, i) => `<div class="zrow"><i style="background:${z.color}"></i><span>${z.label} <span style="color:var(--muted)">${z.desc.split('·')[0]}</span></span><span style="font-family:var(--mono)">${Math.round(ev.zf[i] * 100)}%</span></div>`).reverse().join('');
}

// hover tooltip
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tip = $('tip');
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!cells) { tip.style.display = 'none'; return; }
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(cells)[0];
  if (hit && hit.instanceId != null && result.visible[hit.instanceId]) {
    const v = result.df[hit.instanceId];
    tip.textContent = `DF ${fmtNum(v, 2)}%  ·  ${fmtInt(v / 100 * result.eext)} lx`;
    tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px'; tip.style.display = 'block';
  } else tip.style.display = 'none';
});
renderer.domElement.addEventListener('pointerleave', () => (tip.style.display = 'none'));

// ------------------------------------------------------------------ export
function csvText() {
  const S = result.sensors, th = thresholds(), lines = ['x_m,y_m,z_lavoro_m,z_solaio_m,livello,DF_pct,lux,zona'];
  const lvOf = new Int32Array(S.count);
  result.levels.forEach((l, i) => l.idx.forEach((k) => (lvOf[k] = i)));
  for (let i = 0; i < S.count; i++)
    lines.push([S.x[i].toFixed(3), S.y[i].toFixed(3), S.z[i].toFixed(3), S.zs[i].toFixed(3), fmtZ(result.levels[lvOf[i]].z), result.df[i].toFixed(3), Math.round(result.df[i] / 100 * result.eext), ZONES[zoneOf(result.df[i], th)].label].join(','));
  return lines.join('\n');
}
function download(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const baseName = () => (model?.name || 'modello').replace(/\.3dm$/i, '');
$('csv').onclick = () => download(baseName() + '_daylight.csv', new Blob([csvText()], { type: 'text/csv' }));
$('csvCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(csvText()); setStatus('CSV copiato negli appunti'); }
  catch { setStatus('copia non consentita da questo browser'); }
};
$('png').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob((b) => download(baseName() + '_daylight.png', b)); };

// ------------------------------------------------------------------ utils
function disposeGroup(g) {
  for (const c of [...g.children]) { c.geometry?.dispose(); c.material?.dispose?.(); g.remove(c); }
}
function setStatus(t) { $('status').textContent = t; }
function setBar(f) { $('bar').style.width = (f * 100).toFixed(1) + '%'; }
function clamp(v, a, b, d) { return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; }
function niceCeil(v) { const s = [1, 2, 2.5, 3, 4, 5, 6, 8, 10]; return s.find((x) => x >= v) || 10; }
function fmtNum(v, d) { return Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtInt(v) { return Math.round(v).toLocaleString('it-IT'); }
function fmtZ(z) { return (z >= 0 ? '+' : '−') + Math.abs(z).toFixed(2); }
function fmtDur(s) { return s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s'; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// expose for automated tests
window.__daylight = { evaluate: (i) => evaluate(i), run, loadFile, get result() { return result; }, get model() { return model; }, setModel, makeDemo };
