// Sun samples for direct-sun hours and solar radiation.
import { sunPosition, sunVector } from './climate.js';

// Result groups (columns of the weight matrix)
export const SUN_GROUPS = ['mar', 'jun', 'dec', 'year', 'radYear', 'radSummer', 'radWinter'];
const BINARY = [1, 1, 1, 1, 0, 0, 0];
export const KEY_DAYS = { mar: 80, jun: 172, dec: 355 };

/**
 * @param {object} p
 *  lat, lon, tz        site (lon/tz may be null → solar time)
 *  hourly              EPW hourly records [{month, doy, hour, dni, dhi}] or null
 *  north               True North, degrees counter-clockwise from +Y
 *  minAlt              minimum sun altitude for the 21 March (EN 17037) count, degrees
 * @returns {{dirs:Float32Array, w:Float32Array, binary:Uint8Array, G:number, diffuse:{year:number,summer:number,winter:number}, hasRad:boolean}}
 *  weights: hours for sun groups, Wh/m² on a horizontal plane for radiation groups
 */
export function buildSunSamples(p) {
  const G = SUN_GROUPS.length;
  const lon = p.lon ?? 0, tz = p.lon == null ? 0 : p.tz ?? Math.round(p.lon / 15);
  const dirs = [], w = [];
  const push = (alt, az, row) => { dirs.push(...sunVector(alt, az, p.north || 0)); w.push(...row); };

  // key days, every 10 minutes (solar time when longitude is unknown)
  for (const [g, doy] of [[0, KEY_DAYS.mar], [1, KEY_DAYS.jun], [2, KEY_DAYS.dec]]) {
    for (let t = 1 / 12; t < 24; t += 1 / 6) {
      const s = sunPosition(p.lat, lon, tz, doy, t);
      const min = g === 0 ? Math.max(0, p.minAlt || 0) : 0;
      if (s.alt <= min) continue;
      const row = new Array(G).fill(0); row[g] = 1 / 6;
      push(s.alt, s.az, row);
    }
  }

  // whole year: hourly sun positions, grouped into 1.5° bins (sum of weights, mean direction)
  const south = p.lat < 0;
  const isSummer = (m) => (south ? m === 12 || m <= 2 : m >= 6 && m <= 8);
  const isWinter = (m) => (south ? m >= 6 && m <= 8 : m === 12 || m <= 2);
  const bins = new Map();
  const diffuse = { year: 0, summer: 0, winter: 0 };
  const addHour = (month, doy, hour, dni, dhi) => {
    if (dhi > 0) { diffuse.year += dhi; if (isSummer(month)) diffuse.summer += dhi; if (isWinter(month)) diffuse.winter += dhi; }
    const s = sunPosition(p.lat, lon, tz, doy, hour);
    if (s.alt <= 0) return;
    const key = Math.round(s.alt / 1.5) + ':' + Math.round(s.az / 1.5);
    let b = bins.get(key);
    if (!b) { b = { v: [0, 0, 0], n: 0, w: [0, 0, 0, 0] }; bins.set(key, b); }
    const v = sunVector(s.alt, s.az, p.north || 0);
    b.v[0] += v[0]; b.v[1] += v[1]; b.v[2] += v[2]; b.n++;
    const direct = dni * Math.sin(s.alt * Math.PI / 180); // Wh/m² on horizontal for this hour
    b.w[0] += 1; b.w[1] += direct;
    if (isSummer(month)) b.w[2] += direct;
    if (isWinter(month)) b.w[3] += direct;
  };
  const hasRad = !!(p.hourly && p.hourly.length);
  if (hasRad) for (const h of p.hourly) addHour(h.month, h.doy, h.hour, h.dni, h.dhi);
  else {
    const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
    for (let doy = 1; doy <= 365; doy++) {
      const month = CUM.findIndex((c) => c >= doy);
      for (let hr = 0.5; hr < 24; hr += 1) addHour(month, doy, hr, 0, 0);
    }
  }
  for (const b of bins.values()) {
    const l = Math.hypot(...b.v);
    const row = new Array(G).fill(0);
    row[3] = b.w[0]; row[4] = b.w[1]; row[5] = b.w[2]; row[6] = b.w[3];
    dirs.push(b.v[0] / l, b.v[1] / l, b.v[2] / l); w.push(...row);
  }
  return { dirs: Float32Array.from(dirs), w: Float32Array.from(w), binary: Uint8Array.from(BINARY), G, diffuse, hasRad };
}
