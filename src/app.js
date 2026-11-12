import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';
import { makeSensorGrid, MAT_OPAQUE, MAT_GLASS } from './engine.js';
import { makeDemo } from './demo.js';
import { EN17037_CAPITALS, parseEPW } from './climate.js';
import { contourSegments } from './contour.js';
import { renderExploded } from './exploded.js';
import { buildSunSamples } from './sun.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const $ = (id) => document.getElementById(id);
const ROLES = { slab: 'Slab', opaque: 'Opaque', core: 'Core (excluded)', glass: 'Glass', ignore: 'Ignore' };

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
(function loop() { requestAnimationFrame(loop); controls.update(); updateCompass(); renderer.render(scene, camera); })();

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
  if (/core|nucleo|stair|scal[ae]|lift|elevator|ascensor|shaft|cavedi|vano.?scala/.test(n)) return 'core';
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
  buildNorthArrow();
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
const MODES = { zone: 'mZone', df: 'mDF', lux: 'mLux', sun: 'mSun', rad: 'mRad' };
const SUBS = {
  sun: [['mar', '21 March'], ['jun', '21 June'], ['dec', '21 December'], ['year', 'Whole year']],
  rad: [['year', 'Year'], ['summer', 'Summer (Jun–Aug)'], ['winter', 'Winter (Dec–Feb)']],
};
let subKey = { sun: 'mar', rad: 'year' };
function setMode(m) {
  if (result && !metricAvailable(m)) return;
  displayMode = m;
  for (const [k, id] of Object.entries(MODES)) $(id).classList.toggle('on', k === m);
  const sub = $('sub');
  sub.hidden = !SUBS[m];
  if (SUBS[m]) { sub.innerHTML = SUBS[m].map(([k, l]) => `<option value="${k}">${l}</option>`).join(''); sub.value = subKey[m]; }
  syncLegendRange(); recolor(); buildContours(); renderStats();
}
$('sub').onchange = () => { subKey[displayMode] = $('sub').value; syncLegendRange(); recolor(); renderStats(); };
$('mSun').onclick = () => setMode('sun');
$('mRad').onclick = () => setMode('rad');

/** Values and display info for the current map mode. */
function metric(mode = displayMode) {
  if (mode === 'sun') {
    const k = subKey.sun, lbl = SUBS.sun.find((x) => x[0] === k)[1];
    return { values: result.sun[k], title: `Direct sun hours · ${lbl}`, unit: ' h', dec: k === 'year' ? 0 : 1, pal: CMAP_SUN, key: 'sun-' + k };
  }
  if (mode === 'rad') {
    const k = subKey.rad, lbl = SUBS.rad.find((x) => x[0] === k)[1];
    return { values: result.rad[k], title: `Solar radiation on the floor · ${lbl} (kWh/m²)`, unit: ' kWh/m²', dec: 0, pal: CMAP_RAD, key: 'rad-' + k };
  }
  if (mode === 'lux') {
    const kx = result.eext / 100, v = Float32Array.from(result.df, (x) => x * kx);
    return { values: v, title: 'Illuminance (lux exceeded for half of daylight hours)', unit: ' lx', dec: 0, pal: CMAP, key: 'lux' };
  }
  return { values: result.df, title: 'Daylight Factor (%)', unit: '%', dec: 1, pal: CMAP, key: 'df' };
}
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
    sel.onchange = () => { L.role = sel.value; renderLayerTable(); styleModel(); updateEstimate(); buildNorthArrow(); };
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
    north: parseFloat($('north').value) || 0,
    minAlt: clamp(parseFloat($('minAlt').value), 0, 40, 0),
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
  const mats = { type: [], rho: [], tau: [], core: [] }, matOf = new Map();
  model.layers.forEach((L, i) => {
    if (L.role === 'ignore') return;
    matOf.set(i, mats.type.length);
    mats.type.push(L.role === 'glass' ? MAT_GLASS : MAT_OPAQUE);
    const r = parseFloat(L.rho);
    mats.rho.push(L.role === 'glass' ? 0 : (isFinite(r) ? clamp(r, 0, 0.98, 0.5) : -1));
    mats.tau.push(L.role === 'glass' ? clamp(L.tau, 0, 1, 0.7) : 0);
    mats.core.push(L.role === 'core' ? 1 : 0);
  });
  const objs = model.objects;
  let n = 0;
  for (const o of objs) if (matOf.has(o.layer)) n += o.positions.length;
  const positions = new Float32Array(n), triMat = new Int32Array(n / 9);
  let off = 0;
  for (const o of objs) {
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
    ? `≈ ${fmtInt(pts)} points on ${fmtNum(area, 0)} m² of slabs · Daylight Factor ≈ ${sec < 60 ? Math.max(1, Math.round(sec)) + ' s' : Math.round(sec / 60) + ' min'} (${cores} cores); sun hours and radiation take about as long again each`
    : `<span class="warn" style="display:block">No layer set as <b>Slab</b> with horizontal surfaces.</span>`;
}
for (const id of ['spacing', 'quality']) $(id).addEventListener('input', updateEstimate);

// ------------------------------------------------------------------ run
let workers = [], running = false, runningKind = null;
const RUN_LABEL = { df: 'Daylight Factor', sun: 'Sun hours', rad: 'Radiation' };
for (const k of Object.keys(RUN_LABEL)) $('run-' + k).onclick = () => (running ? (runningKind === k && cancel()) : run(k));
function setRunButtons() {
  for (const k of Object.keys(RUN_LABEL)) {
    const b = $('run-' + k);
    b.textContent = running && runningKind === k ? 'Cancel' : RUN_LABEL[k] + (result && result[k === 'sun' ? 'sun' : k === 'rad' ? 'rad' : 'df'] ? ' ✓' : '');
    b.classList.toggle('busy', running && runningKind === k);
    b.disabled = running && runningKind !== k;
  }
}

function cancel() {
  workers.forEach((w) => w.terminate()); workers = [];
  running = false; runningKind = null; setRunButtons(); setStatus('cancelled'); setBar(0);
}

/** Everything that changes the grid or the geometry: if it changes, earlier results are discarded. */
function gridKey(o) {
  return JSON.stringify([model.name, model.scale, o.spacing, o.height, o.indoorOnly, o.solidFilter,
    model.layers.map((l) => [l.role, l.rho, l.tau])]);
}

async function run(kind) {
  const o = getOpts();
  if (kind !== 'df' && site.lat == null) { setStatus('set a location first (step 3)'); return; }
  if (kind === 'rad' && !(site.hourly && site.hourly.length)) { setStatus('radiation needs an EPW weather file: upload it in step 3'); return; }
  const key = gridKey(o), fresh = !result || result.key !== key;
  prevHadResults = fresh && !!result;
  let sensors = null;
  if (fresh) {
    const slab = buildSlabTriangles();
    if (!slab.pos.length) { setStatus('no slab to analyse'); return; }
    sensors = makeSensorGrid(slab.pos, slab.ids, o.spacing, o.height);
    if (!sensors.count) { setStatus('empty grid: reduce the grid spacing'); return; }
    if (sensors.count > 400000) { setStatus(`too many points (${fmtInt(sensors.count)}): increase the grid spacing`); return; }
  }
  running = true; runningKind = kind; setRunButtons();
  const t0 = performance.now();
  const sc = buildTraceScene();
  const nW = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4)));
  setStatus(`preparing scene (${fmtInt(sc.triMat.length)} triangles, ${nW} threads)…`);
  workers = Array.from({ length: nW }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
  try {
    await Promise.all(workers.map((w) => call(w, { type: 'init', ...sc }, 'ready')));
    let base = result;
    if (fresh) {
      const { cls } = await call(workers[0], { type: 'classify', sensors }, 'classified');
      const keep = [], coreZs = [];
      let outdoor = 0, solid = 0;
      for (let i = 0; i < sensors.count; i++) {
        if (cls[i] === 3) { coreZs.push(sensors.zs[i]); continue; }
        if (cls[i] === 0 && o.indoorOnly) { outdoor++; continue; }
        if (cls[i] === 2 && o.solidFilter) { solid++; continue; }
        keep.push(i);
      }
      if (!keep.length) throw new Error('All points were removed by the filters. Try turning off "Skip points inside walls and solids".');
      const S = subsetSensors(sensors, keep);
      base = { key, sensors: S, spacing: o.spacing, eext: o.eext, outdoor, solid, opts: o };
      base.levels = makeLevels(S);
      base.coreZs = coreZs.filter((z) => base.levels.some((l) => z >= l.z - 0.05 && z <= l.max + 0.05));
    }
    const S = base.sensors;
    base.opts = { ...base.opts, north: o.north, minAlt: o.minAlt, samples: o.samples, maxBounces: o.maxBounces, groundRho: o.groundRho };

    // generic chunked job runner
    const runJobs = async (label, make, expect, G, onChunk) => {
      const CH = Math.max(8, Math.min(256, Math.ceil(S.count / (nW * 14))));
      let next = 0, done = 0; const t1 = performance.now();
      await Promise.all(workers.map(async (w) => {
        while (running && next < S.count) {
          const a = next, b = Math.min(S.count, next + CH); next = b;
          const r = await call(w, make(a, b), expect);
          onChunk(a, r.values);
          done += b - a; setBar(done / S.count);
          const el = (performance.now() - t1) / 1000, eta = el / done * (S.count - done);
          setStatus(`${label} ${fmtInt(done)} / ${fmtInt(S.count)} points · ${eta > 1 ? '~' + fmtDur(eta) + ' left' : 'almost done'}`);
        }
      }));
      return running;
    };
    const dfJob = (opts) => (a, b) => ({ type: 'df', jobId: a, x: S.x.slice(a, b), y: S.y.slice(a, b), z: S.z.slice(a, b), opts, seed: 12345 + a });

    if (kind === 'df') {
      const df = new Float32Array(S.count);
      if (!(await runJobs('Daylight Factor', dfJob(o), 'result', 1, (a, v) => df.set(v, a)))) return;
      base.raw = df; base.df = smooth(S, df, o.spacing); base.eext = o.eext;
      const sorted = Float32Array.from(base.df).sort();
      base.dfMax = Math.max(1, niceCeil(Math.min(sorted[Math.floor(sorted.length * 0.95)] || 5, 10)));
    } else {
      const smp = buildSunSamples({ lat: site.lat, lon: site.lon, tz: site.tz, hourly: kind === 'rad' ? site.hourly : null, north: o.north, minAlt: o.minAlt });
      const G = smp.G;
      // keep only the directions this analysis needs
      const want = kind === 'sun' ? [0, 1, 2, 3] : [4, 5, 6];
      const di = [], wi = [];
      for (let k = 0; k < smp.dirs.length / 3; k++) {
        if (!want.some((g) => smp.w[k * G + g] > 0)) continue;
        di.push(smp.dirs[k * 3], smp.dirs[k * 3 + 1], smp.dirs[k * 3 + 2]);
        for (let g = 0; g < G; g++) wi.push(want.includes(g) ? smp.w[k * G + g] : 0);
      }
      const dirs = Float32Array.from(di), w = Float32Array.from(wi);
      const raw = new Float32Array(S.count * G);
      const label = kind === 'sun' ? `Sun hours (${fmtInt(dirs.length / 3)} sun positions)` : `Radiation (${fmtInt(dirs.length / 3)} sun positions)`;
      if (!(await runJobs(label, (a, b) => ({ type: 'sun', jobId: a, x: S.x.slice(a, b), y: S.y.slice(a, b), z: S.z.slice(a, b), dirs, w, binary: smp.binary, G }), 'sunresult', G, (a, v) => raw.set(v, a * G)))) return;
      const col = (g) => { const arr = new Float32Array(S.count); for (let i = 0; i < S.count; i++) arr[i] = raw[i * G + g]; return arr; };
      const meta = { site: site.label, lat: site.lat, north: o.north, minAlt: o.minAlt };
      if (kind === 'sun') {
        base.sun = { mar: smooth(S, col(0), o.spacing), jun: smooth(S, col(1), o.spacing), dec: smooth(S, col(2), o.spacing), year: smooth(S, col(3), o.spacing) };
        base.sunMeta = meta;
      } else {
        // diffuse part: Daylight Factor × diffuse horizontal radiation; quick sky calculation if DF was not run
        let sky = base.raw;
        if (!sky) {
          sky = new Float32Array(S.count);
          if (!(await runJobs('Radiation · diffuse sky', dfJob({ ...o, samples: 64, maxBounces: 3 }), 'result', 1, (a, v) => sky.set(v, a)))) return;
        }
        const rad = (g, dif) => { const d = col(g); for (let i = 0; i < S.count; i++) d[i] = (d[i] + sky[i] / 100 * dif) / 1000; return smooth(S, d, o.spacing); };
        base.rad = { year: rad(4, smp.diffuse.year), summer: rad(5, smp.diffuse.summer), winter: rad(6, smp.diffuse.winter) };
        base.radMeta = meta;
      }
    }
    const secs = (performance.now() - t0) / 1000;
    let msg = `${RUN_LABEL[kind]} done in ${fmtDur(secs)} · ${fmtInt(S.count)} points`;
    if (fresh) {
      if (base.outdoor) msg += ` · ${fmtInt(base.outdoor)} outdoor skipped`;
      if (base.solid) msg += ` · ${fmtInt(base.solid)} inside solids skipped`;
      if (base.coreZs.length) msg += ` · ${fmtNum(base.coreZs.length * o.spacing * o.spacing, 0)} m² of core excluded`;
      if (prevHadResults) msg += ' · settings changed, earlier results cleared';
    }
    result = base;
    if (fresh) showResults(); else refreshAfterRun();
    setMode(kind === 'df' ? 'zone' : kind);
    setStatus(msg);
  } catch (err) {
    console.error(err);
    setStatus('error: ' + (err.message || err));
  } finally {
    workers.forEach((w) => w.terminate()); workers = [];
    running = false; runningKind = null; setRunButtons();
  }
}
let prevHadResults = false;

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
  syncLegendRange();
  ghost = true; $('ghost').textContent = 'Model: transparent'; styleModel();
  $('legend').style.display = 'block';
  $('s-results').classList.remove('disabled'); $('s-export').classList.remove('disabled');
  levelNames = result.levels.map(() => '');
  updateModeButtons();
  renderLevelNames();
  applyLevel();
  setSeg('vPlan', 'v3d'); fitCamera('plan');
}

function metricAvailable(m) { return m === 'sun' ? !!result.sun : m === 'rad' ? !!result.rad : !!result.df; }
function updateModeButtons() {
  for (const id of ['mZone', 'mDF', 'mLux']) $(id).disabled = !result.df;
  $('mSun').disabled = !result.sun; $('mRad').disabled = !result.rad;
  $('sunBox').hidden = !(result.sun || result.rad);
}
function refreshAfterRun() { updateModeButtons(); applyLevel(); }

function syncLegendRange() {
  if (!result || displayMode === 'zone') return;
  let hi;
  if (displayMode === 'df' || displayMode === 'lux') hi = result.dfMax * (displayMode === 'lux' ? result.eext / 100 : 1);
  else {
    const m = metric(), sorted = Float32Array.from(m.values).sort();
    const p98 = sorted[Math.floor(sorted.length * 0.98)] || 1;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(p98, 1e-6))));
    hi = Math.ceil(p98 / mag) * mag;
    if (displayMode === 'sun' && subKey.sun !== 'year') hi = Math.min(Math.max(hi, 2), 16);
  }
  $('lgMin').value = 0; $('lgMax').value = +hi.toFixed(displayMode === 'df' ? 1 : 0);
  $('lgMin').step = $('lgMax').step = displayMode === 'df' || displayMode === 'sun' ? 0.5 : 50;
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
  if (!metricAvailable(displayMode)) return;
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
  const M = metric();
  for (let i = 0; i < result.sensors.count; i++) {
    colormap((M.values[i] - lo) / (hi - lo), c, M.pal); cells.setColorAt(i, c);
  }
  cells.instanceColor.needsUpdate = true;
  // legend
  const stops = [];
  for (let i = 0; i <= 10; i++) { colormap(i / 10, c, M.pal); stops.push(`#${c.getHexString()} ${i * 10}%`); }
  $('lgBar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  const ticks = [];
  for (let i = 0; i <= 4; i++) ticks.push(`<span>${fmtNum(lo + (hi - lo) * i / 4, hi - lo >= 20 ? 0 : 1)}${i === 4 ? '+' : ''}</span>`);
  $('lgTicks').innerHTML = ticks.join('');
  $('lgTitle').textContent = M.title;
}

const CMAP = [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]; // Daylight Factor / lux: black → white
// Sun hours: blue → red; radiation: light → yellow → red
const CMAP_SUN = [[0.294, 0.420, 0.663], [0.451, 0.576, 0.792], [0.667, 0.784, 0.969], [0.757, 0.835, 0.816], [0.961, 0.937, 0.404], [0.988, 0.902, 0.290], [0.937, 0.612, 0.082], [0.918, 0.482, 0.000], [0.918, 0.290, 0.000], [0.918, 0.149, 0.000]]; // blue → red (Ladybug-style)
const CMAP_RAD = [[0.95, 0.94, 0.91], [1.0, 0.93, 0.63], [1.0, 0.82, 0.42], [0.99, 0.64, 0.29], [0.97, 0.43, 0.20], [0.89, 0.20, 0.13], [0.72, 0.03, 0.15], [0.45, 0.0, 0.17]];
function colormap(t, out, pal = CMAP) {
  const P = pal;
  t = Math.min(1, Math.max(0, t)) * (P.length - 1);
  const i = Math.min(P.length - 2, Math.floor(t)), f = t - i, a = P[i], b = P[i + 1];
  return out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, THREE.SRGBColorSpace);
}

// ------------------------------------------------------------------ site & use
const USES = {
  res: {
    name: 'Residential', height: 0.85, rest: 'bathrooms, storage, corridors, stairs and shafts',
    note: 'Daylight Factor bands used as a design guideline (not legal thresholds). The lux each room needs, from the UK National Annex to EN 17037, is listed with the results.',
    lines: [
      { df: 0.5, label: 'Poor', color: '#8a5aa8' },
      { df: 1, label: 'Moderate', color: '#2f6fb0' },
      { df: 2, label: 'Generally acceptable', color: '#2e9b72' },
      { df: 3, label: 'Good', color: '#e0892b' },
    ],
    bands: [
      ['Very dark', 'likely to need artificial lighting'],
      ['Poor', 'poor natural daylight'],
      ['Moderate', 'moderate daylight'],
      ['Generally acceptable', 'generally acceptable daylight'],
      ['Good', 'good natural daylight'],
    ],
    needs: [['Kitchen', 200], ['Living room', 150], ['Bedroom', 100], ['Services (bathrooms, storage, corridors)', null]],
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
let site = { label: 'Rome, Italy', country: 'Italy', E: 19200, source: 'EN 17037, table A.3', lat: 41.8, lon: null, tz: null, hourly: null };

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
      setSite({ label: `${c.city}, ${c.country}`, country: c.country, E: c.E, source: 'EN 17037, table A.3 · upload an EPW for radiation', lat: c.lat, lon: null, tz: null, hourly: null });
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
    setSite({ ...site, label: 'Manual value', E, source: 'manual' });
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
    setSite({ label: `${r.city}, ${r.country}`, country: r.country, E: r.E, lat: r.lat, lon: r.lon, tz: r.tz, hourly: r.hourly,
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
      <td style="text-align:right"><input type="number" min="${l.df != null ? 0.1 : 10}" step="${l.df != null ? 0.1 : 10}" value="${l.df != null ? l.df : l.lux}" title="${l.df != null ? 'Daylight Factor %' : 'lux'}"> <span class="hint" style="margin:0">${l.df != null ? '%' : 'lx'}</span></td>`;
    const [cb, inp] = tr.querySelectorAll('input');
    cb.onchange = () => { l.on = cb.checked; if (result) refreshResults(); };
    inp.onchange = () => {
      if (l.df != null) l.df = Math.max(0.05, parseFloat(inp.value) || l.df); else l.lux = Math.max(1, parseFloat(inp.value) || l.lux);
      if (result) refreshResults();
    };
    tb.appendChild(tr);
  });
}

function refreshResults() { recolor(); renderStats(); buildContours(); }

function lineDF(l) { return l.df != null ? l.df : dfOf(l.lux); }
function thrText(l) { return l.df != null ? `DF ${fmtNum(l.df, l.df % 1 ? 1 : 0)}%` : `${fmtInt(l.lux)} lx`; }
function activeLines() { return useLines.filter((l) => l.on).sort((a, b) => lineDF(a) - lineDF(b)); }
const dfOf = (lux) => lux / result.eext * 100;

// Bands between consecutive thresholds, for the zone map
function useBands() {
  const L = activeLines(), U = USES[useKey];
  if (U.bands && L.length === U.lines.length) {
    const vals = L.map(lineDF), fmt = (v) => fmtNum(v, v % 1 ? 1 : 0);
    return U.bands.map(([name, desc], i) => ({
      min: i === 0 ? -Infinity : vals[i - 1], fill: i === 0 ? '#cfcac1' : mix(L[i - 1].color, 0.45), color: i === 0 ? '#9e978c' : L[i - 1].color,
      label: i === 0 ? `DF < ${fmt(vals[0])}%` : i === vals.length ? `DF > ${fmt(vals[i - 1])}%` : `DF ${fmt(vals[i - 1])}–${fmt(vals[i])}%`,
      desc, short: name,
    }));
  }
  const bands = [{ min: -Infinity, fill: '#cfcac1', label: `Below ${L.length ? thrText(L[0]) : '–'}`, desc: U.rest, short: 'services / core' }];
  L.forEach((l, i) => {
    const fits = L.slice(0, i + 1).map((x) => x.label.split(' (')[0].toLowerCase());
    bands.push({ min: lineDF(l), fill: mix(l.color, 0.45), color: l.color, label: `≥ ${thrText(l)}`, desc: 'suits ' + fits.reverse().join(', '), short: l.label.split(' (')[0] });
  });
  return bands;
}
function bandOf(v, bands) { let k = 0; for (let i = 1; i < bands.length; i++) if (v >= bands[i].min) k = i; return k; }
function mix(hex, t) { const c = new THREE.Color(hex); c.lerp(new THREE.Color(0xffffff), t); return '#' + c.getHexString(); }

function coreArea(lv) {
  if (!result.coreZs || !result.coreZs.length) return 0;
  const h2 = result.spacing * result.spacing;
  if (!lv) return result.coreZs.length * h2;
  return result.coreZs.filter((z) => z >= lv.z - 0.05 && z <= lv.max + 0.05).length * h2;
}

/** Daylight rating of a floor: band of its median DF (residential) or share meeting the first use line. */
function floorRating(st) {
  const U = USES[useKey], B = useBands(), L = activeLines();
  if (U.bands && B.length === U.bands.length) {
    const k = bandOf(st.med, B);
    return { label: B[k].short, cls: k >= 3 ? 'ok' : k === 2 ? 'mid' : 'ko', pass: k >= 3, why: `median DF ${fmtNum(st.med, 2)}% → ${B[k].label}` };
  }
  if (!L.length) return { label: '–', cls: 'mid', pass: false, why: '' };
  const f = st.frac(lineDF(L[0])), name = L[0].label.split(' (')[0];
  return { label: f >= 0.5 ? 'Good' : f >= 0.4 ? 'Borderline' : 'Not enough', cls: f >= 0.5 ? 'ok' : f >= 0.4 ? 'mid' : 'ko', pass: f >= 0.5,
    why: `${Math.round(f * 100)}% of the floor ≥ ${thrText(L[0])} (${name}); 50% needed` };
}

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
  if (!result.df) {
    $('summary').innerHTML = '<div class="sumhead"><div class="t">Daylight Factor not calculated yet</div><div class="m">Press “Daylight Factor” to add it; it reuses the same grid.</div></div>';
    $('stats').innerHTML = '';
    renderSunStats();
    return;
  }
  const lv = currentLevel(), U = USES[useKey], L = activeLines();
  const all = Array.from({ length: result.sensors.count }, (_, i) => i);
  const st = areaStats(lv ? lv.idx : all);
  const where = lv ? levelName(result.levels.indexOf(lv)) : (result.levels.length > 1 ? 'All levels' : 'Analysed slab');
  const rt = floorRating(st);
  let html = `<div class="sumhead"><div class="t">${where} · ${U.name} <span class="pill ${rt.cls}" title="${escapeHtml(rt.why)}" style="margin-left:6px">${rt.pass ? '✓' : rt.cls === 'mid' ? '~' : '✗'} ${rt.label}</span></div><div class="m">${fmtNum(st.area, 0)} m² analysed${coreArea(lv) ? ` (+ ${fmtNum(coreArea(lv), 0)} m² core excluded)` : ''} · ${escapeHtml(site.label)} · median diffuse E ${fmtInt(result.eext)} lx</div></div>`;
  const bandsNow = useBands();
  if (U.bands && bandsNow.length === U.bands.length) {
    // exclusive ranges between the DF lines
    for (let i = bandsNow.length - 1; i >= 0; i--) {
      const B = bandsNow[i], f = st.frac(B.min) - (i + 1 < bandsNow.length ? st.frac(bandsNow[i + 1].min) : 0);
      html += `<div class="usebar"><div class="top"><span><span class="lsw" style="border-color:${B.color}"></span><b>${B.short}</b> · ${B.label}</span><span style="font-family:var(--mono)">${fmtNum(f * st.area, 0)} m² · ${Math.round(f * 100)}%</span></div>
        <div class="track"><div style="width:${f * 100}%;background:${B.color}"></div></div></div>`;
    }
    if (U.needs) {
      html += `<table class="needs"><thead><tr><th>Daylight needed</th><th>lux</th><th>DF here</th><th>floor meeting it</th></tr></thead><tbody>` +
        U.needs.map(([room, lux]) => lux
          ? `<tr><td>${room}</td><td>${fmtInt(lux)} lx</td><td>${fmtNum(dfOf(lux), 1)}%</td><td>${Math.round(st.frac(dfOf(lux)) * 100)}%</td></tr>`
          : `<tr><td>${room}</td><td colspan="3" style="text-align:left;color:var(--muted)">no daylight requirement</td></tr>`).join('') +
        `</tbody></table><p class="hint" style="margin-top:4px">lux exceeded for half of the daylight hours over at least half of the room (UK National Annex to EN 17037); DF converted with ${fmtInt(result.eext)} lx at ${escapeHtml(site.label)}.</p>`;
    }
  } else {
  for (const l of [...L].reverse()) {
    const f = st.frac(lineDF(l));
    html += `<div class="usebar"><div class="top"><span><span class="lsw" style="border-color:${l.color}"></span><b>${escapeHtml(l.label.split(' (')[0])}</b> · ≥ ${thrText(l)}</span><span style="font-family:var(--mono)">${fmtNum(f * st.area, 0)} m² · ${Math.round(f * 100)}%</span></div>
      <div class="track"><div style="width:${f * 100}%;background:${l.color}"></div></div></div>`;
  }
  if (L.length) {
    const below = 1 - st.frac(lineDF(L[0]));
    html += `<div class="usebar"><div class="top"><span><span class="lsw" style="border-color:#bdb7ad"></span><b>Below ${thrText(L[0])}</b> · ${U.rest}</span><span style="font-family:var(--mono)">${fmtNum(below * st.area, 0)} m² · ${Math.round(below * 100)}%</span></div>
      <div class="track"><div style="width:${below * 100}%;background:#bdb7ad"></div></div></div>`;
  }
  }
  if (U.bands && bandsNow.length === U.bands.length) {
    const nd = (U.needs || []).filter((n) => n[1]).map(([r, lux]) => `${r.toLowerCase()} where DF ≥ ${fmtNum(dfOf(lux), 1)}%`).join(', ');
    html += `<p class="hint" style="margin-top:10px">Coloured lines mark DF ${activeLines().map((l) => fmtNum(l.df, l.df % 1 ? 1 : 0) + '%').join(' / ')}; the fills show the band between them. To meet the room targets here, place ${nd}, with at least half of each room inside that zone; ${U.rest} can go in the darkest areas.</p>`;
  } else
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
  const hasCore = result.coreZs && result.coreZs.length;
  $('stats').innerHTML = `<tr><th></th><th>m²</th>${hasCore ? '<th title="Core area excluded">core</th>' : ''}<th>mean DF</th><th title="Daylight rating of the floor">rating</th>${L.map((l) => `<th title="${escapeHtml(l.label)}"><span class="lsw" style="border-color:${l.color};width:10px"></span>≥${l.df != null ? fmtNum(l.df, l.df % 1 ? 1 : 0) + '%' : fmtInt(l.lux)}</th>`).join('')}</tr>` +
    rows.map(([nm, e], i) => `<tr><td>${nm}</td><td>${fmtNum(e.area, 0)}</td>${hasCore ? `<td>${fmtNum(coreArea(i < result.levels.length ? result.levels[i] : null), 0)}</td>` : ''}<td>${fmtNum(e.mean, 2)}</td><td>${(() => { const r = floorRating(e); return `<span class="pill ${r.cls}" title="${escapeHtml(r.why)}">${r.pass ? '✓' : r.cls === 'mid' ? '~' : '✗'} ${r.label}</span>`; })()}</td>${L.map((l) => `<td>${Math.round(e.frac(lineDF(l)) * 100)}%</td>`).join('')}</tr>`).join('') +
    `<tr><td colspan="${4 + (hasCore ? 1 : 0) + L.length}" style="text-align:left;font-family:inherit;color:var(--muted);font-size:11px;border-top:none;padding-top:6px">${USES[useKey].bands ? 'Rating = band of the floor’s median DF (half of the floor is at least that bright): ✓ generally acceptable or good, ~ moderate, ✗ poor or very dark.' : 'Rating: ✓ when at least half of the floor reaches the first line.'}</td></tr>`;
  if (displayMode === 'zone') renderZoneLegend();
  renderSunStats();
}

// ------------------------------------------------------------------ sun & radiation summary
function meanOf(arr, idx) { let s = 0; for (const k of idx) s += arr[k]; return idx.length ? s / idx.length : 0; }
function fracAbove(arr, idx, t) { let n = 0; for (const k of idx) if (arr[k] >= t) n++; return idx.length ? n / idx.length : 0; }
function renderSunStats() {
  if (!result || !(result.sun || result.rad)) return;
  const lv = currentLevel(), all = Array.from({ length: result.sensors.count }, (_, i) => i), idx = lv ? lv.idx : all;
  const S = result.sun, R = result.rad, M = result.sunMeta || result.radMeta;
  const where = lv ? levelName(result.levels.indexOf(lv)) : 'All levels';
  let h = `<div class="hint" style="margin:0">${escapeHtml(where)} · ${escapeHtml(M.site)} · True North ${fmtNum(M.north, 0)}° · direct sun through glazing, ${fmtInt(result.sensors.count)} points</div>`;
  const stale = [result.sunMeta, result.radMeta].some((m) => m && Math.abs(angleDiff(m.north, getNorth())) > 0.05);
  if (stale) h = `<div class="warn" style="margin:0 0 8px">True North is now ${fmtNum(getNorth(), 0)}°, but these results were calculated with ${fmtNum(M.north, 0)}°. Press <b>Sun hours</b> / <b>Radiation</b> again to update them.</div>` + h;
  h += '<ul class="checks">';
  if (S) {
    h = h.replace('<ul class="checks">', '') + `<div class="mini"><div><b>${fmtNum(meanOf(S.mar, idx), 1)} h</b><span>21 March</span></div><div><b>${fmtNum(meanOf(S.jun, idx), 1)} h</b><span>21 June</span></div><div><b>${fmtNum(meanOf(S.dec, idx), 1)} h</b><span>21 December</span></div><div><b>${fmtInt(meanOf(S.year, idx))} h</b><span>whole year</span></div></div><ul class="checks">`;
    const f15 = fracAbove(S.mar, idx, 1.5), f3 = fracAbove(S.mar, idx, 3), f4 = fracAbove(S.mar, idx, 4), fdec0 = 1 - fracAbove(S.dec, idx, 0.05);
    h += `<li><span class="ic mid">i</span><span><b>EN 17037 sunlight (21 March${result.sunMeta.minAlt ? `, sun above ${fmtNum(result.sunMeta.minAlt, 0)}°` : ''}):</b> ${Math.round(f15 * 100)}% of the floor gets ≥ 1.5 h (minimum), ${Math.round(f3 * 100)}% ≥ 3 h (medium), ${Math.round(f4 * 100)}% ≥ 4 h (high). The standard checks one point per dwelling at the window; here every floor point is shown.</span></li>
      <li><span class="ic mid">i</span><span><b>No direct sun on 21 December:</b> ${Math.round(fdec0 * 100)}% of the floor.</span></li>`;
  } else h += `<li><span class="ic mid">i</span><span><b>Sun hours:</b> not calculated yet — press “Sun hours”.</span></li>`;
  if (R) h += `<li><span class="ic mid">i</span><span><b>Solar radiation on the floor:</b> ${fmtInt(meanOf(R.year, idx))} kWh/m² per year on average (summer ${fmtInt(meanOf(R.summer, idx))}, winter ${fmtInt(meanOf(R.winter, idx))}). Direct sun through glazing plus diffuse sky light; high summer values flag overheating risk, winter values useful solar gains.</span></li>`;
  else h += `<li><span class="ic mid">i</span><span><b>Solar radiation:</b> not calculated yet — press “Radiation” (needs an EPW file).</span></li>`;
  h += '</ul>';
  $('sunSummary').innerHTML = h;
  const rows = result.levels.map((l, i) => [escapeHtml(levelName(i)), l.idx]);
  if (rows.length > 1) rows.push(['Total', all]);
  $('stats2').innerHTML = `<tr><th></th>${S ? '<th title="mean direct sun hours on 21 March">Mar h</th><th title="share of floor with ≥ 1.5 h on 21 March">≥1.5h</th><th title="mean direct sun hours on 21 December">Dec h</th><th title="mean annual direct sun hours">Year h</th>' : ''}${R ? '<th title="kWh/m² per year">kWh yr</th><th title="kWh/m² in summer">summer</th><th title="kWh/m² in winter">winter</th>' : ''}</tr>` +
    rows.map(([nm, ix]) => `<tr><td>${nm}</td>${S ? `<td>${fmtNum(meanOf(S.mar, ix), 1)}</td><td>${Math.round(fracAbove(S.mar, ix, 1.5) * 100)}%</td><td>${fmtNum(meanOf(S.dec, ix), 1)}</td><td>${fmtInt(meanOf(S.year, ix))}</td>` : ''}${R ? `<td>${fmtInt(meanOf(R.year, ix))}</td><td>${fmtInt(meanOf(R.summer, ix))}</td><td>${fmtInt(meanOf(R.winter, ix))}</td>` : ''}</tr>`).join('');
}

function suggestions(st, L) {
  const t = [];
  if (st.frac(dfOf(750)) > 0.35) t.push('Large areas exceed 750 lx: plan adjustable shading against glare and summer overheating.');
  if (!L.length || st.frac(lineDF(L[L.length - 1])) >= 0.6) return t;
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
    + (showLines ? activeLines().map((l) => `<div class="zrow"><i style="background:none;border-top:3px solid ${l.color};height:0;margin-top:5px"></i><span>line ${thrText(l)} · ${escapeHtml(l.label.split(' (')[0])}</span><span></span></div>`).reverse().join('') : '');
}

// iso-lines per level
function buildContours() {
  for (const c of [...contourGroup.children]) { c.geometry.dispose(); c.material.dispose(); contourGroup.remove(c); }
  if (!result || !result.df || !showLines || displayMode === 'sun' || displayMode === 'rad') return;
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
      const seg = contourSegments(pts, h, lineDF(L));
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
    const id = hit.instanceId;
    let t = '';
    if (result.df) {
      const v = result.df[id], bands = useBands(), b = bands[bandOf(v, bands)];
      t = `DF ${fmtNum(v, 2)}%  ·  ${fmtInt(v / 100 * result.eext)} lx  ·  ${b.short}`;
    }
    if (result.sun) t += `${t ? '  ·  ' : ''}sun ${fmtNum(result.sun.mar[id], 1)} h Mar / ${fmtNum(result.sun.dec[id], 1)} h Dec`;
    if (result.rad) t += `${t ? '  ·  ' : ''}${fmtInt(result.rad.year[id])} kWh/m²·yr`;
    tip.textContent = t;
    tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px'; tip.style.display = 'block';
  } else tip.style.display = 'none';
});
renderer.domElement.addEventListener('pointerleave', () => (tip.style.display = 'none'));

// ------------------------------------------------------------------ export
function csvText() {
  const S = result.sensors, bands = useBands();
  const head = ['x_m,y_m,z_workplane_m,z_slab_m,level' + (result.df ? ',DF_pct,lux,zone' : '')];
  if (result.sun) head.push('sun_21mar_h,sun_21jun_h,sun_21dec_h,sun_year_h');
  if (result.rad) head.push('rad_year_kWh_m2,rad_summer_kWh_m2,rad_winter_kWh_m2');
  const lines = [head.join(',')];
  const lvOf = new Int32Array(S.count);
  result.levels.forEach((l, i) => l.idx.forEach((k) => (lvOf[k] = i)));
  for (let i = 0; i < S.count; i++)
    lines.push([S.x[i].toFixed(3), S.y[i].toFixed(3), S.z[i].toFixed(3), S.zs[i].toFixed(3), '"' + levelName(lvOf[i]) + '"',
      ...(result.df ? [result.df[i].toFixed(3), Math.round(result.df[i] / 100 * result.eext), '"' + bands[bandOf(result.df[i], bands)].short + '"'] : []),
      ...(result.sun ? [result.sun.mar[i].toFixed(2), result.sun.jun[i].toFixed(2), result.sun.dec[i].toFixed(2), result.sun.year[i].toFixed(0)] : []),
      ...(result.rad ? [result.rad.year[i].toFixed(1), result.rad.summer[i].toFixed(1), result.rad.winter[i].toFixed(1)] : [])].join(','));
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
    const hi = Math.max(1, (L.length ? lineDF(L[L.length - 1]) : 2) * 2);
    const c = new THREE.Color();
    return { lo: 0, hi, fn: (t) => { c.set(bands[bandOf(t * hi, bands)].fill); const o = c.getRGB({}, THREE.SRGBColorSpace); return [o.r, o.g, o.b]; } };
  }
  const lo = parseFloat($('lgMin').value) || 0, hi = Math.max(lo + 1e-6, parseFloat($('lgMax').value) || 1);
  const c = new THREE.Color(), pal = metric().pal;
  return { lo, hi, fn: (t) => { colormap(t, c, pal); const o = c.getRGB({}, THREE.SRGBColorSpace); return [o.r, o.g, o.b]; } };
}

function exportLegend() {
  const L = activeLines(), lineItems = $('exLines').checked ? L.map((l) => ({ type: 'line', color: l.color, label: `${thrText(l)} line · ${l.label.split(' (')[0]}` })).reverse() : [];
  if (displayMode === 'zone') {
    const bands = exportBands();
    return { title: 'Daylight · lux exceeded for 50% of daylight hours',
      items: [...bands.map((b) => ({ type: 'fill', color: b.fill, label: `${b.label} · ${b.desc}` })).reverse(), ...lineItems] };
  }
  const c = new THREE.Color(), stops = [], M = metric();
  for (let i = 0; i <= 10; i++) { colormap(i / 10, c, M.pal); stops.push(['#' + c.getHexString(), i / 10]); }
  const lo = parseFloat($('lgMin').value) || 0, hi = parseFloat($('lgMax').value) || 1;
  const items = (displayMode === 'df' || displayMode === 'lux') ? lineItems : [];
  return { title: M.title, gradient: stops, items2: items,
    ticks: [0, 1, 2, 3, 4].map((i) => fmtNum(lo + (hi - lo) * i / 4, hi - lo >= 20 ? 0 : 1) + M.unit + (i === 4 ? '+' : '')) };
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
    const sunMode = displayMode === 'sun' || displayMode === 'rad';
    const M = displayMode === 'zone' ? null : metric();
    const stats = result.levels.map((lv) => {
      if (!$('exStats').checked) return [];
      const st = areaStats(lv.idx);
      if (displayMode === 'sun') {
        const arr = M.values, mean = meanOf(arr, lv.idx);
        const extra = subKey.sun === 'mar' ? [`${Math.round(fracAbove(arr, lv.idx, 1.5) * 100)}% ≥ 1.5 h (EN 17037 minimum)`] : [];
        return [`${fmtNum(st.area, 0)} m² analysed`, `mean ${fmtNum(mean, M.dec)} h of direct sun`, ...extra];
      }
      if (displayMode === 'rad') {
        let mx = 0; for (const k of lv.idx) mx = Math.max(mx, M.values[k]);
        return [`${fmtNum(st.area, 0)} m² analysed`, `mean ${fmtInt(meanOf(M.values, lv.idx))} kWh/m²`, `peak ${fmtInt(mx)} kWh/m²`];
      }
      const BB = useBands(), rt = floorRating(st);
      if (USES[useKey].bands && BB.length === USES[useKey].bands.length)
        return [`${fmtNum(st.area, 0)} m² analysed · daylight: ${rt.label.toLowerCase()} ${rt.pass ? '✓' : rt.cls === 'mid' ? '~' : '✗'}`, ...BB.map((B, i) => ({ color: B.color, text: `${Math.round((st.frac(B.min) - (i + 1 < BB.length ? st.frac(BB[i + 1].min) : 0)) * 100)}% ${B.short.toLowerCase()} · ${B.label}` })).reverse()];
      return [`${fmtNum(st.area, 0)} m² analysed`, ...[...L].reverse().map((l) => ({ color: l.color, text: `${Math.round(st.frac(lineDF(l)) * 100)}% ≥ ${thrText(l)} · ${l.label.split(' (')[0]}` }))];
    });
    const viewDir = camera.position.clone().sub(controls.target);
    const out = await renderExploded({
      layers, sensors: result.sensors, df: M ? M.values : result.df, levels: result.levels, spacing: result.spacing, north: getNorth(),
      names: result.levels.map((_, i) => levelName(i)), stats,
      ramp: exportRamp(), lines: $('exLines').checked && !sunMode ? L.map((l) => ({ df: displayMode === 'lux' ? lineDF(l) * result.eext / 100 : lineDF(l), color: l.color })) : [],
      gap: Math.max(0, parseFloat($('exGap').value) || 0), width: parseInt($('exWidth').value, 10), roof: $('exRoof').checked, slabs: $('exSlabs').checked,
      viewDir, legend: exportLegend(),
      title: baseName(), subtitle: sunMode ? `${(result.sunMeta || result.radMeta).site} · ${U.name} · ${M.title} · True North ${fmtNum(getNorth(), 0)}°` : `${site.label} · ${U.name} · CIE overcast sky, median diffuse illuminance ${fmtInt(result.eext)} lx (EN 17037)`,
    });
    const url = URL.createObjectURL(out.blob);
    $('mImg').src = url; $('mInfo').textContent = `${out.width} × ${out.height} px`;
    $('modal').hidden = false;
    $('mDownload').onclick = () => download(baseName() + `_exploded_${M ? M.key : 'zones'}.png`, out.blob);
    $('mClose').onclick = () => { $('modal').hidden = true; URL.revokeObjectURL(url); };
  } catch (err) {
    console.error(err); setStatus('export error: ' + (err.message || err));
  } finally { btn.disabled = false; btn.textContent = 'Create exploded view'; }
};

// ------------------------------------------------------------------ north arrow
// True North = angle counter-clockwise from the model +Y axis (Ladybug convention).
function getNorth() { return parseFloat($('north').value) || 0; }
function angleDiff(a, b) { return ((a - b) % 360 + 540) % 360 - 180; }
function setNorth(v) {
  v = Math.round((((v % 360) + 540) % 360 - 180) * 10) / 10;
  $('north').value = v;
  onNorthChange();
}
function onNorthChange() {
  buildNorthArrow();
  $('compVal').textContent = `${fmtNum(getNorth(), getNorth() % 1 ? 1 : 0)}°`;
  if (result && (result.sun || result.rad)) renderSunStats();
}
$('north').addEventListener('input', onNorthChange);
$('compL').onclick = () => setNorth(getNorth() + 15);
$('compR').onclick = () => setNorth(getNorth() - 15);

// ticks every 30°
$('compTicks').innerHTML = Array.from({ length: 12 }, (_, i) => { const a = i * Math.PI / 6, r0 = i % 3 ? 49 : 45; return `<line class="tick" x1="${Math.sin(a) * r0}" y1="${-Math.cos(a) * r0}" x2="${Math.sin(a) * 54}" y2="${-Math.cos(a) * 54}"/>`; }).join('');

const northGroup = new THREE.Group(); scene.add(northGroup);
function buildNorthArrow() {
  for (const c of [...northGroup.children]) { c.geometry?.dispose(); c.material?.map?.dispose(); c.material?.dispose(); northGroup.remove(c); }
  if (!model || model.bbox.isEmpty()) { $('compass').hidden = true; return; }
  $('compass').hidden = false;
  // anchor to the analysed building (slab layers), not to the whole context
  let bb = new THREE.Box3();
  for (const o of model.objects) {
    if (model.layers[o.layer].role !== 'slab') continue;
    const p = o.positions;
    for (let i = 0; i < p.length; i += 3) bb.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
  }
  if (bb.isEmpty()) bb = model.bbox;
  const sz = bb.getSize(new THREE.Vector3()), span = Math.max(sz.x, sz.y, 5);
  const L = Math.min(Math.max(span * 0.12, 2), 30);
  const sh = new THREE.Shape();
  sh.moveTo(0, L); sh.lineTo(L * 0.32, -L * 0.25); sh.lineTo(0, -L * 0.05); sh.lineTo(-L * 0.32, -L * 0.25); sh.closePath();
  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshBasicMaterial({ color: 0xe0892b, side: THREE.DoubleSide, depthTest: false, transparent: true }));
  arrow.renderOrder = 10;
  const ring = new THREE.Mesh(new THREE.RingGeometry(L * 1.05, L * 1.12, 64), new THREE.MeshBasicMaterial({ color: 0x1d1f22, side: THREE.DoubleSide, depthTest: false, transparent: true }));
  ring.renderOrder = 10;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#7a3f00'; ctx.font = '600 96px "IBM Plex Sans", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', 64, 70);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.7, L * 0.7), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthTest: false, transparent: true }));
  label.position.set(0, L * 1.45, 0); label.renderOrder = 11;
  const rot = new THREE.Group(); rot.add(arrow, label); rot.rotation.z = getNorth() * Math.PI / 180;
  northGroup.add(ring, rot);
  // pick a free corner around the building (no other volume standing on it)
  const z0 = bb.min.z, off = L * 1.7;
  const cands = [[bb.min.x - off, bb.min.y - off], [bb.max.x + off, bb.min.y - off], [bb.min.x - off, bb.max.y + off], [bb.max.x + off, bb.max.y + off]];
  const occupied = (x, y) => model.objects.some((o) => {
    if (model.layers[o.layer].role === 'ignore') return false;
    const p = o.positions;
    for (let i = 0; i < p.length; i += 9) {
      const zmax = Math.max(p[i + 2], p[i + 5], p[i + 8]);
      if (zmax < z0 + 1) continue;
      if (x < Math.min(p[i], p[i + 3], p[i + 6]) - L || x > Math.max(p[i], p[i + 3], p[i + 6]) + L) continue;
      if (y < Math.min(p[i + 1], p[i + 4], p[i + 7]) - L || y > Math.max(p[i + 1], p[i + 4], p[i + 7]) + L) continue;
      return true;
    }
    return false;
  });
  const free = cands.find(([x, y]) => !occupied(x, y)) || cands[0];
  northGroup.position.set(free[0], free[1], z0 + 0.05);
}

// on-screen compass: shows north for the current view, drag to set it
const _c0 = new THREE.Vector3(), _c1 = new THREE.Vector3();
function screenDir(world) { // pixel vector of a unit world vector at the orbit target
  _c0.copy(controls.target).project(camera); _c1.copy(controls.target).add(world).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return [(_c1.x - _c0.x) * r.width / 2, -(_c1.y - _c0.y) * r.height / 2];
}
let lastCompass = '';
function updateCompass() {
  if ($('compass').hidden) return;
  const th = getNorth() * Math.PI / 180;
  const [dx, dy] = screenDir(new THREE.Vector3(-Math.sin(th), Math.cos(th), 0));
  const ang = Math.atan2(dx, -dy) * 180 / Math.PI;
  const key = ang.toFixed(1);
  if (key !== lastCompass) { $('compArrow').setAttribute('transform', `rotate(${key})`); lastCompass = key; }
}
(function compassDrag() {
  const svg = $('compSvg');
  let dragging = false;
  const fromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < 6) return;
    // solve a·ex + b·ey = d for the horizontal world direction shown at this screen direction
    const ex = screenDir(new THREE.Vector3(1, 0, 0)), ey = screenDir(new THREE.Vector3(0, 1, 0));
    const det = ex[0] * ey[1] - ey[0] * ex[1];
    if (Math.abs(det) < 1e-9) return;
    const a = (dx * ey[1] - ey[0] * dy) / det, b = (ex[0] * dy - dx * ex[1]) / det;
    let deg = Math.atan2(-a, b) * 180 / Math.PI;
    deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
    setNorth(deg);
  };
  svg.addEventListener('pointerdown', (e) => { dragging = true; svg.classList.add('drag'); svg.setPointerCapture(e.pointerId); fromEvent(e); e.preventDefault(); });
  svg.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  const end = () => { dragging = false; svg.classList.remove('drag'); };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
})();

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
window.__daylight = { setNorth, getNorth, get levelNames() { return levelNames; }, setUse, loadEPW, run, loadFile, get result() { return result; }, get model() { return model; }, setModel, makeDemo };
