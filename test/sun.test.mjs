import fs from 'fs';
import { parseEPW } from '../src/climate.js';
import { buildSunSamples } from '../src/sun.js';
import { buildScene, sunAccumulate } from '../src/engine.js';
const r = parseEPW(fs.readFileSync(process.argv[2] || 'test/sample.epw', 'utf8'));
const s = buildSunSamples({ lat: r.lat, lon: r.lon, tz: r.tz, hourly: r.hourly, north: 0, minAlt: 0 });
console.log('directions', s.dirs.length / 3, 'diffuse kWh/yr', (s.diffuse.year / 1000).toFixed(0));
// unobstructed horizontal point: expected sun hours ~12.1 on 21 Mar, ~15.2 on 21 Jun (Chicago 42N), ~9.1 Dec; year ~4380 h
const S = buildScene(new Float32Array(0), new Int32Array(0), { type: [0], rho: [0.5], tau: [0] });
const out = new Float32Array(s.G);
sunAccumulate(S, 0, 0, 1, s.dirs, s.w, s.binary, s.G, out, 0);
console.log('open point: h Mar/Jun/Dec/Year', [0, 1, 2, 3].map((g) => out[g].toFixed(1)).join(' / '));
console.log('open point: direct horiz kWh year/summer/winter', [4, 5, 6].map((g) => (out[g] / 1000).toFixed(0)).join(' / '), '+ diffuse', (s.diffuse.year / 1000).toFixed(0), '= global', ((out[4] + s.diffuse.year) / 1000).toFixed(0));
// glass pane over the point (tau 0.6): hours unchanged, radiation x0.6
const quad = [-50, -50, 2, 50, -50, 2, 50, 50, 2, -50, -50, 2, 50, 50, 2, -50, 50, 2];
const S2 = buildScene(new Float32Array(quad), new Int32Array(2), { type: [1], rho: [0], tau: [0.6] });
sunAccumulate(S2, 0, 0, 1, s.dirs, s.w, s.binary, s.G, out, 0);
console.log('under glass τ0.6: h Mar', out[0].toFixed(1), ' direct year kWh', (out[4] / 1000).toFixed(0));
// south-facing wall north of point: point at y=-1 with tall opaque wall at y=0 facing it? -> put wall SOUTH of point to block sun
const wall = [-50, 1, 0, 50, 1, 0, 50, 1, 100, -50, 1, 0, 50, 1, 100, -50, 1, 100];
const S3 = buildScene(new Float32Array(wall), new Int32Array(2), { type: [0], rho: [0.5], tau: [0] });
sunAccumulate(S3, 0, 2, 1, s.dirs, s.w, s.binary, s.G, out, 0); // point north of a huge wall
console.log('north of huge wall: h Mar/Jun/Dec', [0, 1, 2].map((g) => out[g].toFixed(1)).join(' / '));
