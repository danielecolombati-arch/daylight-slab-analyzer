import { buildScene, daylightFactor, classifySensors, makeRng, sunAccumulate } from './engine.js';

let S = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    S = buildScene(m.positions, m.triMat, m.mats);
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'classify') {
    const cls = classifySensors(S, m.sensors);
    self.postMessage({ type: 'classified', cls }, [cls.buffer]);
  } else if (m.type === 'df') {
    const { x, y, z, opts, seed, jobId } = m;
    const rng = makeRng(seed);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = daylightFactor(S, x[i], y[i], z[i], 0, 0, 1, opts, rng);
    self.postMessage({ type: 'result', jobId, values: out }, [out.buffer]);
  } else if (m.type === 'sun') {
    const { x, y, z, dirs, w, binary, G, jobId } = m;
    const out = new Float32Array(x.length * G);
    for (let i = 0; i < x.length; i++) sunAccumulate(S, x[i], y[i], z[i], dirs, w, binary, G, out, i * G);
    self.postMessage({ type: 'sunresult', jobId, values: out }, [out.buffer]);
  }
};
