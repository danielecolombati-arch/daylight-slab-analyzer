import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';
import { makeSensorGrid, MAT_OPAQUE, MAT_GLASS } from './engine.js';
import { makeDemo } from './demo.js';
import { EN17037_CAPITALS, parseEPW } from './climate.js';
import { contourSegments } from './contour.js';
import { renderExploded } from './exploded.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const $ = (id) => document.getElementById(id);
const ROLES = { slab: 'Slab', opaque: 'Opaque', glass: 'Glass', ignore: 'Ignore' };

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
const contourGroup = new THREE.Group(); scene.add(contourGroup);
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e9);

function resize() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
  camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
  contourGroup.children.forEach((l) => l.material.resolution.set(r.width, r.height));
}
new ResizeObserver(resize).observe(view); resize();
(function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();

// ------------------------------------------------------------------ state
let model = null;    // { name, layers:[{name,color,role,rho,tau,tris}], objects:[{layer, positions}] , bbox }
let result = null;   // { sensors, df: Float32Array, levels, spacing, eext }
let displayMode = 'zone';
let levelNames = [];
function levelName(i) { return (levelNames[i] && levelNames[i].trim()) || (result && result.levels[i] ? 'Level ' + fmtZ(result.levels[i].z) : 'Level'); }
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
  setStatus('reading ' + file.name + '…');
  $('modelInfo').textContent = 'Loading…';
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
    $('modelInfo').innerHTML = `<div class="warn">Could not read the file: ${escapeHtml(err.message || String(err))}</div>`;
    setStatus('error');
  }
}

function guessRole(name) {
  const n = name.toLowerCase();
  if (/vetr|glass|glaz|window|finestr|serrament|vitr|lucernar|skylight/.test(n)) return 'glass';
  if (/slab|solai|solet|floor|pavim|impalcat|deck/.test(n)) return 'slab';
  if (/(^|[^a-z])(dim|dimensions?|quot[ae]|annot\w*|text|testi?|testo|hatch|tratteggi|curve|linee|lines|grid|griglia|assi|axes|camera|lights?|luci)([^a-z]|$)/.test(n)) return 'ignore';
  return 'opaque';
}

// Typical reflectances by layer name; '' = automatic by orientation
function guessRho(name) {
  const n = name.toLowerCase();
  if (/grass|erba|lawn|prato|veget|tree|alber|landscape|verde/.test(n)) return '0.15';
  if (/terrain|terreno|ground|suolo|soil|topo|asphalt|asfalto|road|strad/.test(n)) return '0.15';
  if (/context|contesto|neighbo|surround|adjacent|edifici|existing|esistent/.test(n)) return '0.3';
  return '';
}

function setModel(raw, autoScale) {
  lastRaw = { model: raw, autoScale };
  const sel = $('units').value;
  const scale = sel === 'auto' ? autoScale : parseFloat(sel);
  const layers = raw.layers.map((l, i) => ({ ...l, role: guessRole(l.name), rho: guessRho(l.name), tau: 0.7, tris: 0, index: i }));
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
  let info = `<b>${escapeHtml(raw.name)}</b> · ${objects.length} objects · ${fmtInt(tris)} triangles · ${sz.x.toFixed(1)} × ${sz.y.toFixed(1)} × ${sz.z.toFixed(1)} m`;
  if (model.skipped) info += `<div class="warn">${model.skipped} objects (polysurfaces/extrusions) have no saved render mesh and were skipped. In Rhino, save the file from a <i>Shaded</i> viewport without "Save Small", or convert them with the <code>_Mesh</code> command.</div>`;
  if (!tris) info += `<div class="warn">No geometry found in the file.</div>`;
  if (Math.max(sz.x, sz.y, sz.z) > 2000) info += `<div class="warn">The model looks huge: check the units ("Units" menu).</div>`;
  $('modelInfo').innerHTML = info;
  $('empty').style.display = tris ? 'none' : '';
  for (const s of ['s-layers', 's-site', 's-params', 's-run']) $(s).classList.toggle('disabled', !tris);
  $('s-results').classList.add('disabled'); $('s-export').classList.add('disabled');
  updateEstimate();
  setStatus('ready');
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
$('ghost').onclick = () => { ghost = !ghost; $('ghost').textContent = 'Model: ' + (ghost ? 'transparent' : 'solid'); styleModel(); };
$('level').onchange = () => { applyLevel(); fitCamera($('vPlan').classList.contains('on') ? 'plan' : '3d'); };
function setSeg(on, off) { $(on).classList.add('on'); $(off).classList.remove('on'); }

// ------------------------------------------------------------------ layer table
function renderLayerTable() {
  const tb = $('layerRows'); tb.innerHTML = '';
  model.layers.forEach((L) => {
    if (!L.tris) return;
    const tr = document.createElement('tr');
    const rhoCell = L.role === 'glass' || L.role === 'ignore' ? '<span class="na">–</span>'
      : `<input type="number" min="0" max="0.98" step="0.05" placeholder="auto" value="${L.rho}" title="Empty = auto by orientation: floors 0.2, walls 0.5, ceilings 0.7">`;
    const tauCell = L.role === 'glass' ? `<input type="number" min="0" max="1" step="0.05" value="${L.tau}" title="Visible light transmittance of the glazing">` : '<span class="na">–</span>';
    tr.innerHTML = `<td class="name" title="${escapeHtml(L.name)}"><span class="sw" style="background:${L.color}"></span>${escapeHtml(L.name)}</td>
      <td><select>${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === L.role ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td>${rhoCell}</td><td>${tauCell}</td>`;
    const sel = tr.querySelector('select');
    const [rho, tau] = [tr.children[2].querySelector('input'), tr.children[3].querySelector('input')];
    sel.onchange = () => { L.role = sel.value; renderLayerTable(); styleModel(); updateEstimate(); };
    if (rho) rho.onchange = () => { L.rho = rho.value; };
    if (tau) tau.onchange = () => { L.tau = parseFloat(tau.value) || 0; };
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
    ? `≈ ${fmtInt(pts)} points on ${fmtNum(area, 0)} m² of slabs · estimated time ${sec < 60 ? Math.max(1, Math.round(sec)) + ' s' : Math.round(sec / 60) + ' min'} (${cores} cores)`
    : `<span class="warn" style="display:block">No layer set as <b>Slab</b> with horizontal surfaces.</span>`;
}
for (const id of ['spacing', 'quality']) $(id).addEventListener('input', updateEstimate);

// ------------------------------------------------------------------ run
let workers = [], running = false;
$('run').onclick = () => (running ? cancel() : run());

function cancel() {
  workers.forEach((w) => w.terminate()); workers = [];
  running = false; $('run').textContent = 'Run Daylight Factor'; setStatus('cancelled'); setBar(0);
}

async function run() {
  const o = getOpts();
  const slab = buildSlabTriangles();
  if (!slab.pos.length) { setStatus('no slab to analyse'); return; }
  const sensors = makeSensorGrid(slab.pos, slab.ids, o.spacing, o.height);
  if (!sensors.count) { setStatus('empty grid: reduce the grid spacing'); return; }
  if (sensors.count > 400000) { setStatus(`too many points (${fmtInt(sensors.count)}): increase the grid spacing`); return; }
  running = true; $('run').textContent = 'Cancel'; clearResults();
  const t0 = performance.now();
  const sc = buildTraceScene();
  const nW = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4)));
  setStatus(`preparing scene (${fmtInt(sc.triMat.length)} triangles, ${nW} threads)…`);
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
    if (!keep.length) throw new Error('All points were removed by the filters. Try turning off "Skip points inside walls and solids".');
    const S = subsetSensors(sensors, keep);
    // job queue
    const CH = Math.max(16, Math.min(256, Math.ceil(S.count / (nW * 12))));
    const df = new Float32Array(S.count);
    let next = 0, done = 0, seed = 12345;
    setStatus(`computing ${fmtInt(S.count)} points…`);
    await Promise.all(workers.map(async (w) => {
      while (running && next < S.count) {
        const a = next, b = Math.min(S.count, next + CH); next = b;
        const r = await call(w, { type: 'df', jobId: a, x: S.x.slice(a, b), y: S.y.slice(a, b), z: S.z.slice(a, b), opts: o, seed: seed++ }, 'result');
        df.set(r.values, a);
        done += b - a;
        setBar(done / S.count);
        const el = (performance.now() - t0) / 1000, eta = el / done * (S.count - done);
        setStatus(`computing ${fmtInt(done)} / ${fmtInt(S.count)} points · ${eta > 1 ? '~' + fmtDur(eta) + ' left' : 'almost done'}`);
      }
    }));
    if (!running) return;
    result = { sensors: S, df, spacing: o.spacing, eext: o.eext, outdoor, solid, opts: o };
    result.levels = makeLevels(S);
    result.raw = df; result.df = smooth(S, df, o.spacing);
    const secs = (performance.now() - t0) / 1000;
    let msg = `done in ${fmtDur(secs)} · ${fmtInt(S.count)} points`;
    if (outdoor) msg += ` · ${fmtInt(outdoor)} outdoor skipped`;
    if (solid) msg += ` · ${fmtInt(solid)} inside solids skipped`;
    setStatus(msg);
    if (solid > 0.4 * sensors.count) setStatus(msg + ' ⚠ many points skipped: the model normals may be flipped');
    showResults();
  } catch (err) {
    console.error(err);
    setStatus('error: ' + (err.message || err));
  } finally {
    workers.forEach((w) => w.terminate()); workers = [];
    running = false; $('run').textContent = 'Run Daylight Factor';
  }
}

function call(w, msg, expect) {
  return new Promise((res, rej) => {
    w.onmessage = (e) => { if (e.data.type === expect) res(e.data); };
    w.onerror = (e) => rej(new Error(e.message || 'worker error'));
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
  for (const c of [...contourGroup.children]) { c.geometry.dispose(); c.material.dispose(); contourGroup.remove(c); }
  $('legend').style.display = 'none';
  $('level').innerHTML = '<option value="all">All levels</option>';
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
  sel.innerHTML = '<option value="all">All levels</option>' + result.levels.map((l, i) => `<option value="${i}">${levelName(i)}</option>`).join('');
  if (result.levels.length > 1) sel.value = '0';
  // default scale
  const sorted = Float32Array.from(result.df).sort();
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 5;
  result.dfMax = Math.max(1, niceCeil(Math.min(p95, 10)));
  syncLegendRange();
  ghost = true; $('ghost').textContent = 'Model: transparent'; styleModel();
  $('legend').style.display = 'block';
  $('s-results').classList.remove('disabled'); $('s-export').classList.remove('disabled');
  levelNames = result.levels.map(() => '');
  renderLevelNames();
  applyLevel();
  setSeg('vPlan', 'v3d'); fitCamera('plan');
}

function syncLegendRange() {
  if (!result) return;
  const k = displayMode === 'lux' ? result.eext / 100 : 1;
  $('lgMin').value = 0; $('lgMax').value = +(result.dfMax * k).toFixed(displayMode === 'lux' ? 0 : 1);
  $('lgMin').step = $('lgMax').step = displayMode === 'lux' ? 50 : 0.5;
}
$('lgMin').onchange = $('lgMax').onchange = () => recolor();


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
  buildContours();
}

function recolor() {
  if (!result || !cells) return;
  const c = new THREE.Color();
  const zoneMode = displayMode === 'zone';
  $('lgZones').style.display = zoneMode ? '' : 'none';
  $('lgRng').style.display = $('lgBar').style.display = $('lgTicks').style.display = zoneMode ? 'none' : '';
  if (zoneMode) {
    const bands = useBands();
    for (let i = 0; i < result.sensors.count; i++) cells.setColorAt(i, c.set(bands[bandOf(result.df[i], bands)].fill));
    cells.instanceColor.needsUpdate = true;
    $('lgTitle').textContent = `Zones by use · ${USES[useKey].name}`;
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
  $('lgTitle').textContent = displayMode === 'lux' ? `Illuminance (lux exceeded for half of daylight hours)` : 'Daylight Factor (%)';
}

// Viridis-like perceptual colormap
const CMAP = [[0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530], [0.207, 0.372, 0.553], [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441], [0.478, 0.821, 0.318], [0.741, 0.873, 0.150], [0.993, 0.906, 0.144]];
function colormap(t, out) {
  t = Math.min(1, Math.max(0, t)) * (CMAP.length - 1);
  const i = Math.min(CMAP.length - 2, Math.floor(t)), f = t - i, a = CMAP[i], b = CMAP[i + 1];
  return out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, THREE.SRGBColorSpace);
}

// ------------------------------------------------------------------ site & use
const USES = {
  res: {
    name: 'Residential', height: 0.85, rest: 'bathrooms, storage, corridors, stairs and shafts',
    note: 'Targets for dwellings from the UK National Annex to EN 17037 (BRE 209:2022). A room complies when at least half of its floor area is inside its line.',
    lines: [
      { lux: 100, label: 'Bedroom', color: '#2f6fb0' },
      { lux: 200, label: 'Kitchen / Living room', color: '#b8336a' },
    ],
  },
  off: {
    name: 'Office', height: 0.75, rest: 'cores, toilets, archives, plant rooms and storage',
    note: 'EN 17037 levels: a space meets them when at least half of its floor area is inside the line.',
    lines: [
      { lux: 300, label: 'Office (EN 17037 minimum)', color: '#d07a1f' },
      { lux: 500, label: 'Continuous desk work (EN 17037 medium)', color: '#b8336a' },
    ],
  },
  ind: {
    name: 'Industrial', height: 0.85, rest: 'warehouse, storage, plant and services',
    note: 'EN 17037 levels applied to work areas: an area meets them when at least half of its floor area is inside the line.',
    lines: [
      { lux: 300, label: 'Production (EN 17037 minimum)', color: '#d07a1f' },
      { lux: 500, label: 'Fine work (EN 17037 medium)', color: '#b8336a' },
      { lux: 750, label: 'Quality control (EN 17037 high)', color: '#5b2a86' },
    ],
  },
};
let useKey = 'res';
let useLines = USES.res.lines.map((l) => ({ ...l, on: true }));
let showLines = true;
let site = { label: 'Rome, Italy', country: 'Italy', E: 19200, source: 'EN 17037, table A.3' };

function initSite() {
  const sel = $('loc');
  const caps = [...EN17037_CAPITALS].sort((a, b) => a.city.localeCompare(b.city, 'en'));
  sel.innerHTML = `<optgroup label="EN 17037 values (European capitals)">${caps.map((c) => `<option value="cap:${c.city}">${c.city}, ${c.country} · ${fmtInt(c.E)} lx</option>`).join('')}</optgroup>
    <optgroup label="Other"><option value="epw" disabled>From EPW file (upload below)</option><option value="manual">Manual value</option></optgroup>`;
  sel.value = 'cap:Rome';
  sel.onchange = () => {
    const v = sel.value;
    if (v.startsWith('cap:')) {
      const c = EN17037_CAPITALS.find((x) => x.city === v.slice(4));
      setSite({ label: `${c.city}, ${c.country}`, country: c.country, E: c.E, source: 'EN 17037, table A.3' });
    } else if (v === 'manual') setSite({ ...site, label: 'Manual value', country: '', source: 'manual' });
  };
  const drop = $('epwDrop'), input = $('epwFile');
  drop.onclick = (e) => { if (e.target.tagName !== 'A') input.click(); };
  input.onchange = () => input.files[0] && loadEPW(input.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadEPW(f); };
  $('eext').onchange = () => {
    const E = parseFloat($('eext').value);
    if (!(E > 0)) return;
    sel.value = 'manual';
    setSite({ label: 'Manual value', country: site.country, E, source: 'manual' });
  };
  $('use').onchange = () => setUse($('use').value);
  $('lines').onclick = () => { showLines = !showLines; $('lines').textContent = 'Lines: ' + (showLines ? 'on' : 'off'); buildContours(); };
  setUse('res'); setSite(site);
}

async function loadEPW(file) {
  try {
    const r = parseEPW(await file.text());
    const opt = $('loc').querySelector('option[value="epw"]');
    opt.disabled = false; opt.textContent = `${r.city}, ${r.country} (EPW) · ${fmtInt(r.E)} lx`;
    $('loc').value = 'epw';
    setSite({ label: `${r.city}, ${r.country}`, country: r.country, E: r.E,
      source: `EPW · ${fmtNum(Math.abs(r.lat), 1)}°${r.lat >= 0 ? 'N' : 'S'} ${fmtNum(Math.abs(r.lon), 1)}°${r.lon >= 0 ? 'E' : 'W'} · ${fmtInt(r.hours)} daylight hours · from ${r.source}` });
  } catch (err) {
    $('locInfo').innerHTML = `<span style="color:var(--warn)">${escapeHtml(err.message)}</span>`;
  }
}

function setSite(s) {
  site = s;
  $('eext').value = s.E;
  $('locInfo').textContent = s.source;
  if (result) { result.eext = s.E; refreshResults(); }
}

function setUse(key) {
  useKey = key;
  const U = USES[key];
  useLines = U.lines.map((l) => ({ ...l, on: true }));
  $('use').value = key;
  $('height').value = U.height;
  $('useNote').textContent = U.note;
  renderThrTable();
  if (result) refreshResults();
}

function renderThrTable() {
  const tb = $('thrRows'); tb.innerHTML = '';
  useLines.forEach((l) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="width:22px"><input type="checkbox" ${l.on ? 'checked' : ''} style="accent-color:${l.color}"></td>
      <td><span class="lsw" style="border-color:${l.color}"></span>${escapeHtml(l.label)}</td>
      <td style="text-align:right"><input type="number" min="10" step="10" value="${l.lux}"></td>`;
    const [cb, inp] = tr.querySelectorAll('input');
    cb.onchange = () => { l.on = cb.checked; if (result) refreshResults(); };
    inp.onchange = () => { l.lux = Math.max(1, parseFloat(inp.value) || l.lux); if (result) refreshResults(); };
    tb.appendChild(tr);
  });
}

function refreshResults() { recolor(); renderStats(); buildContours(); }

function activeLines() { return useLines.filter((l) => l.on).sort((a, b) => a.lux - b.lux); }
const dfOf = (lux) => lux / result.eext * 100;

// Bands between consecutive thresholds, for the zone map
function useBands() {
  const L = activeLines(), U = USES[useKey];
  const bands = [{ min: -Infinity, fill: '#cfcac1', label: `Below ${L.length ? fmtInt(L[0].lux) : '–'} lx`, desc: U.rest, short: 'services / core' }];
  L.forEach((l, i) => {
    const fits = L.slice(0, i + 1).map((x) => x.label.split(' (')[0].toLowerCase());
    bands.push({ min: dfOf(l.lux), fill: mix(l.color, 0.45), label: `≥ ${fmtInt(l.lux)} lx`, desc: 'suits ' + fits.reverse().join(', '), short: l.label.split(' (')[0] });
  });
  return bands;
}
function bandOf(v, bands) { let k = 0; for (let i = 1; i < bands.length; i++) if (v >= bands[i].min) k = i; return k; }
function mix(hex, t) { const c = new THREE.Color(hex); c.lerp(new THREE.Color(0xffffff), t); return '#' + c.getHexString(); }

function areaStats(idx) {
  const { df, spacing } = result;
  const n = idx.length; if (!n) return null;
  const v = Float32Array.from(idx, (k) => df[k]).sort();
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const pct = (p) => v[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  const frac = (dfT) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < dfT) lo = m + 1; else hi = m; } return (n - lo) / n; };
  return { n, area: n * spacing * spacing, mean, med: pct(0.5), p5: pct(0.05), frac };
}

function renderStats() {
  if (!result) return;
  const lv = currentLevel(), U = USES[useKey], L = activeLines();
  const all = Array.from({ length: result.sensors.count }, (_, i) => i);
  const st = areaStats(lv ? lv.idx : all);
  const where = lv ? levelName(result.levels.indexOf(lv)) : (result.levels.length > 1 ? 'All levels' : 'Analysed slab');
  let html = `<div class="sumhead"><div class="t">${where} · ${U.name}</div><div class="m">${fmtNum(st.area, 0)} m² analysed · ${escapeHtml(site.label)} · median diffuse E ${fmtInt(result.eext)} lx</div></div>`;
  for (const l of [...L].reverse()) {
    const f = st.frac(dfOf(l.lux));
    html += `<div class="usebar"><div class="top"><span><span class="lsw" style="border-color:${l.color}"></span><b>${escapeHtml(l.label.split(' (')[0])}</b> · ≥ ${fmtInt(l.lux)} lx</span><span style="font-family:var(--mono)">${fmtNum(f * st.area, 0)} m² · ${Math.round(f * 100)}%</span></div>
      <div class="track"><div style="width:${f * 100}%;background:${l.color}"></div></div></div>`;
  }
  if (L.length) {
    const below = 1 - st.frac(dfOf(L[0].lux));
    html += `<div class="usebar"><div class="top"><span><span class="lsw" style="border-color:#bdb7ad"></span><b>Below ${fmtInt(L[0].lux)} lx</b> · ${U.rest}</span><span style="font-family:var(--mono)">${fmtNum(below * st.area, 0)} m² · ${Math.round(below * 100)}%</span></div>
      <div class="track"><div style="width:${below * 100}%;background:#bdb7ad"></div></div></div>`;
  }
  html += `<p class="hint" style="margin-top:10px">Each line encloses the area that receives at least that illuminance for half of the daylight hours in a year. Lay out rooms so that at least half of their floor area is inside the right line; areas outside the lines suit ${U.rest}.</p>`;

  // informative checks
  const th = { d100: dfOf(100), d300: dfOf(300), d500: dfOf(500), d750: dfOf(750) };
  const en = st.med >= th.d750 && st.p5 >= th.d500 ? 'high' : st.med >= th.d500 && st.p5 >= th.d300 ? 'medium' : st.med >= th.d300 && st.p5 >= th.d100 ? 'minimum' : null;
  const checks = [`<li><span class="ic mid">i</span><span><b>Mean DF ${fmtNum(st.mean, 2)}%</b> · median DF ${fmtNum(st.med, 2)}% (≈ ${fmtInt(st.med / 100 * result.eext)} lx on half of the area)</span></li>`,
    `<li><span class="ic ${en ? 'ok' : 'mid'}">${en ? '✓' : 'i'}</span><span><b>EN 17037 over the whole ${lv ? 'floor' : 'building'}:</b> ${en ? en + ' level' : 'minimum level not met over the whole area'} (targets for ${escapeHtml(site.label)}: 300 lx = DF ${fmtNum(th.d300, 1)}%, 100 lx = DF ${fmtNum(th.d100, 1)}%).</span></li>`];
  if (/^(ita|italia|italy)$/i.test(site.country) && useKey !== 'ind')
    checks.push(`<li><span class="ic mid">i</span><span><b>Italy, D.M. 5/7/1975:</b> mean DF ≥ 2% in every habitable room${useKey === 'off' ? ' (often adopted by local building codes for offices)' : ''}. To be checked room by room; over the whole floor the mean DF is ${fmtNum(st.mean, 2)}%.</span></li>`);
  html += `<ul class="checks">${checks.join('')}</ul>`;
  const tips = suggestions(st, L);
  if (tips.length) html += `<div style="margin-top:12px;font-weight:600;font-size:12.5px">To enlarge the usable area</div><ul class="tips">${tips.map((t) => `<li>${t}</li>`).join('')}</ul>`;
  $('summary').innerHTML = html;
  $('lgCount').textContent = `${fmtInt(st.n)} points · ${fmtNum(st.area, 0)} m²`;

  const rows = result.levels.map((l, i) => [escapeHtml(levelName(i)), areaStats(l.idx)]);
  if (rows.length > 1) rows.push(['Total', areaStats(all)]);
  $('stats').innerHTML = `<tr><th></th><th>m²</th><th>mean DF</th>${L.map((l) => `<th title="${escapeHtml(l.label)}"><span class="lsw" style="border-color:${l.color};width:10px"></span>≥${fmtInt(l.lux)}</th>`).join('')}</tr>` +
    rows.map(([nm, e]) => `<tr><td>${nm}</td><td>${fmtNum(e.area, 0)}</td><td>${fmtNum(e.mean, 2)}</td>${L.map((l) => `<td>${Math.round(e.frac(dfOf(l.lux)) * 100)}%</td>`).join('')}</tr>`).join('');
  if (displayMode === 'zone') renderZoneLegend();
}

function suggestions(st, L) {
  const t = [];
  if (st.frac(dfOf(750)) > 0.35) t.push('Large areas exceed 750 lx: plan adjustable shading against glare and summer overheating.');
  if (!L.length || st.frac(dfOf(L[L.length - 1].lux)) >= 0.6) return t;
  t.push('To bring light deeper, raise the window heads or take windows up to the ceiling (rule of thumb: daylit depth ≈ 2–2.5 × window head height).');
  t.push('Deep areas far from the façades can host services; on the top floor, rooflights or light wells make them usable.');
  t.push('Reduce deep overhangs and balconies in front of main windows and use light interior finishes. You can test this by changing the reflectance in the layer table.');
  return t;
}

function renderZoneLegend() {
  const lv = currentLevel();
  const all = Array.from({ length: result.sensors.count }, (_, i) => i);
  const st = areaStats(lv ? lv.idx : all), bands = useBands();
  const fr = bands.map((b, i) => (i + 1 < bands.length ? st.frac(b.min) - st.frac(bands[i + 1].min) : st.frac(b.min)));
  fr[0] = 1 - (bands.length > 1 ? st.frac(bands[1].min) : 0);
  $('lgZones').innerHTML = bands.map((b, i) => `<div class="zrow"><i style="background:${b.fill}"></i><span><b>${b.label}</b> <span style="color:var(--muted)">${b.desc}</span></span><span style="font-family:var(--mono)">${Math.round(fr[i] * 100)}%</span></div>`).reverse().join('')
    + (showLines ? activeLines().map((l) => `<div class="zrow"><i style="background:none;border-top:3px solid ${l.color};height:0;margin-top:5px"></i><span>line ${fmtInt(l.lux)} lx · ${escapeHtml(l.label.split(' (')[0])}</span><span></span></div>`).reverse().join('') : '');
}

// iso-lines per level
function buildContours() {
  for (const c of [...contourGroup.children]) { c.geometry.dispose(); c.material.dispose(); contourGroup.remove(c); }
  if (!result || !showLines) return;
  const S = result.sensors, h = result.spacing, lv = currentLevel();
  const levels = lv ? [lv] : result.levels;
  const r = renderer.domElement.getBoundingClientRect();
  for (const L of activeLines()) {
    const pos = [];
    for (const level of levels) {
      const pts = { gi: [], gj: [], v: [] };
      let zsum = 0;
      for (const k of level.idx) { pts.gi.push(Math.round(S.x[k] / h - 0.5)); pts.gj.push(Math.round(S.y[k] / h - 0.5)); pts.v.push(result.df[k]); zsum += S.zs[k]; }
      const z = zsum / level.idx.length + 0.07;
      const seg = contourSegments(pts, h, dfOf(L.lux));
      for (let i = 0; i < seg.length; i += 4) pos.push(seg[i], seg[i + 1], z, seg[i + 2], seg[i + 3], z);
    }
    if (!pos.length) continue;
    const g = new LineSegmentsGeometry(); g.setPositions(pos);
    const m = new LineMaterial({ color: L.color, linewidth: 3.5, worldUnits: false });
    m.resolution.set(r.width, r.height);
    const line = new LineSegments2(g, m); line.renderOrder = 2;
    contourGroup.add(line);
  }
}

initSite();

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
    const bands = useBands(), b = bands[bandOf(v, bands)];
    tip.textContent = `DF ${fmtNum(v, 2)}%  ·  ${fmtInt(v / 100 * result.eext)} lx  ·  ${b.short}`;
    tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px'; tip.style.display = 'block';
  } else tip.style.display = 'none';
});
renderer.domElement.addEventListener('pointerleave', () => (tip.style.display = 'none'));

// ------------------------------------------------------------------ export
function csvText() {
  const S = result.sensors, bands = useBands(), lines = ['x_m,y_m,z_workplane_m,z_slab_m,level,DF_pct,lux,zone'];
  const lvOf = new Int32Array(S.count);
  result.levels.forEach((l, i) => l.idx.forEach((k) => (lvOf[k] = i)));
  for (let i = 0; i < S.count; i++)
    lines.push([S.x[i].toFixed(3), S.y[i].toFixed(3), S.z[i].toFixed(3), S.zs[i].toFixed(3), '"' + levelName(lvOf[i]) + '"', result.df[i].toFixed(3), Math.round(result.df[i] / 100 * result.eext), '"' + bands[bandOf(result.df[i], bands)].short + '"'].join(','));
  return lines.join('\n');
}
function download(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const baseName = () => (model?.name || 'model').replace(/\.3dm$/i, '');
$('csv').onclick = () => download(baseName() + '_daylight.csv', new Blob([csvText()], { type: 'text/csv' }));
$('csvCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(csvText()); setStatus('CSV copied to clipboard'); }
  catch { setStatus('copy not allowed by this browser'); }
};
$('png').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob((b) => download(baseName() + '_daylight.png', b)); };

// ------------------------------------------------------------------ exploded axonometric
function renderLevelNames() {
  const box = $('lvNames'); box.innerHTML = '';
  result.levels.forEach((l, i) => {
    const row = document.createElement('label'); row.className = 'lvrow';
    row.innerHTML = `<span>${fmtZ(l.z)}</span><input type="text" placeholder="Level ${fmtZ(l.z)}" value="${escapeHtml(levelNames[i] || '')}">`;
    const inp = row.querySelector('input');
    inp.oninput = () => {
      levelNames[i] = inp.value;
      const opt = $('level').querySelector(`option[value="${i}"]`); if (opt) opt.textContent = levelName(i);
      renderStats();
    };
    box.appendChild(row);
  });
}

function exportBands() { return useBands().map((b, i) => ({ ...b, fill: i === 0 ? '#c9c4bb' : mix(activeLines()[i - 1].color, 0.25) })); }

function exportRamp() {
  // colours of the current map mode, as a function of DF
  if (displayMode === 'zone') {
    const bands = exportBands(), L = activeLines();
    const hi = Math.max(1, (L.length ? dfOf(L[L.length - 1].lux) : 2) * 2);
    const c = new THREE.Color();
    return { lo: 0, hi, fn: (t) => { c.set(bands[bandOf(t * hi, bands)].fill); const o = c.getRGB({}, THREE.SRGBColorSpace); return [o.r, o.g, o.b]; } };
  }
  const k = displayMode === 'lux' ? result.eext / 100 : 1;
  const lo = (parseFloat($('lgMin').value) || 0) / k, hi = Math.max(lo + 1e-6, (parseFloat($('lgMax').value) || 1) / k);
  const c = new THREE.Color();
  return { lo, hi, fn: (t) => { colormap(t, c); const o = c.getRGB({}, THREE.SRGBColorSpace); return [o.r, o.g, o.b]; } };
}

function exportLegend() {
  const L = activeLines(), lineItems = $('exLines').checked ? L.map((l) => ({ type: 'line', color: l.color, label: `${fmtInt(l.lux)} lx line · ${l.label.split(' (')[0]}` })).reverse() : [];
  if (displayMode === 'zone') {
    const bands = exportBands();
    return { title: 'Daylight · lux exceeded for 50% of daylight hours',
      items: [...bands.map((b) => ({ type: 'fill', color: b.fill, label: `${b.label} · ${b.desc}` })).reverse(), ...lineItems] };
  }
  const c = new THREE.Color(), stops = [];
  for (let i = 0; i <= 10; i++) { colormap(i / 10, c); stops.push(['#' + c.getHexString(), i / 10]); }
  const lo = parseFloat($('lgMin').value) || 0, hi = parseFloat($('lgMax').value) || 1;
  const unit = displayMode === 'lux' ? ' lx' : '%';
  return { title: displayMode === 'lux' ? 'Illuminance exceeded for 50% of daylight hours' : 'Daylight Factor',
    gradient: stops, ticks: [0, 1, 2, 3, 4].map((i) => fmtNum(lo + (hi - lo) * i / 4, displayMode === 'lux' ? 0 : 1) + unit + (i === 4 ? '+' : '')) };
}

$('exRun').onclick = async () => {
  if (!result) return;
  const btn = $('exRun'); btn.disabled = true; btn.textContent = 'Rendering…';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const L = activeLines(), U = USES[useKey];
    const layers = [];
    model.objects.forEach((o) => {
      const role = model.layers[o.layer].role;
      if (role !== 'ignore') layers.push({ positions: o.positions, kind: role === 'glass' ? 'glass' : 'opaque' });
    });
    const stats = result.levels.map((lv) => {
      if (!$('exStats').checked) return [];
      const st = areaStats(lv.idx);
      return [`${fmtNum(st.area, 0)} m² analysed`, ...[...L].reverse().map((l) => ({ color: l.color, text: `${Math.round(st.frac(dfOf(l.lux)) * 100)}% ≥ ${fmtInt(l.lux)} lx · ${l.label.split(' (')[0]}` }))];
    });
    const viewDir = camera.position.clone().sub(controls.target);
    const out = await renderExploded({
      layers, sensors: result.sensors, df: result.df, levels: result.levels, spacing: result.spacing,
      names: result.levels.map((_, i) => levelName(i)), stats,
      ramp: exportRamp(), lines: $('exLines').checked ? L.map((l) => ({ df: dfOf(l.lux), color: l.color })) : [],
      gap: Math.max(0, parseFloat($('exGap').value) || 0), width: parseInt($('exWidth').value, 10), roof: $('exRoof').checked,
      viewDir, legend: exportLegend(),
      title: baseName(), subtitle: `${site.label} · ${U.name} · CIE overcast sky, median diffuse illuminance ${fmtInt(result.eext)} lx (EN 17037)`,
    });
    const url = URL.createObjectURL(out.blob);
    $('mImg').src = url; $('mInfo').textContent = `${out.width} × ${out.height} px`;
    $('modal').hidden = false;
    $('mDownload').onclick = () => download(baseName() + '_exploded_axo.png', out.blob);
    $('mClose').onclick = () => { $('modal').hidden = true; URL.revokeObjectURL(url); };
  } catch (err) {
    console.error(err); setStatus('export error: ' + (err.message || err));
  } finally { btn.disabled = false; btn.textContent = 'Create exploded view'; }
};

// ------------------------------------------------------------------ utils
function disposeGroup(g) {
  for (const c of [...g.children]) { c.geometry?.dispose(); c.material?.dispose?.(); g.remove(c); }
}
function setStatus(t) { $('status').textContent = t; }
function setBar(f) { $('bar').style.width = (f * 100).toFixed(1) + '%'; }
function clamp(v, a, b, d) { return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; }
function niceCeil(v) { const s = [1, 2, 2.5, 3, 4, 5, 6, 8, 10]; return s.find((x) => x >= v) || 10; }
function fmtNum(v, d) { return Number(v).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtInt(v) { return Math.round(v).toLocaleString('en-GB'); }
function fmtZ(z) { return (z >= 0 ? '+' : '−') + Math.abs(z).toFixed(2); }
function fmtDur(s) { return s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s'; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// expose for automated tests
window.__daylight = { get levelNames() { return levelNames; }, setUse, loadEPW, run, loadFile, get result() { return result; }, get model() { return model; }, setModel, makeDemo };
