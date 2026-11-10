// Climate data for daylight targets.
// EN 17037 method 1 converts illuminance targets to daylight factor targets with the
// median external diffuse horizontal illuminance during daylight hours (Ev,d,med):
//   D_target = E_target / Ev,d,med · 100

// EN 17037:2018 Table A.3 — Ev,d,med for the capitals of CEN member countries
export const EN17037_CAPITALS = [
  ['Nicosia', 'Cyprus', 34.88, 18100], ['Valletta', 'Malta', 35.54, 16500], ['Athens', 'Greece', 37.90, 19400],
  ['Lisbon', 'Portugal', 38.73, 18220], ['Ankara', 'Turkey', 40.12, 19000], ['Madrid', 'Spain', 40.45, 16900],
  ['Rome', 'Italy', 41.80, 19200], ['Skopje', 'North Macedonia', 42.00, 15400], ['Sofia', 'Bulgaria', 42.73, 18700],
  ['Bucharest', 'Romania', 44.50, 18200], ['Zagreb', 'Croatia', 45.48, 17000], ['Ljubljana', 'Slovenia', 46.22, 17000],
  ['Bern', 'Switzerland', 46.25, 16000], ['Budapest', 'Hungary', 47.48, 18100], ['Vienna', 'Austria', 48.12, 16000],
  ['Bratislava', 'Slovakia', 48.20, 16300], ['Paris', 'France', 48.73, 15900], ['Luxembourg', 'Luxembourg', 49.36, 16000],
  ['Prague', 'Czech Republic', 50.10, 14900], ['Brussels', 'Belgium', 50.90, 15000], ['London', 'United Kingdom', 51.51, 14100],
  ['Warsaw', 'Poland', 52.17, 14700], ['Amsterdam', 'Netherlands', 52.30, 14400], ['Berlin', 'Germany', 52.47, 13900],
  ['Dublin', 'Ireland', 53.43, 14900], ['Vilnius', 'Lithuania', 54.88, 15300], ['Copenhagen', 'Denmark', 55.63, 14200],
  ['Riga', 'Latvia', 56.57, 13600], ['Tallinn', 'Estonia', 59.25, 13600], ['Stockholm', 'Sweden', 59.65, 12100],
  ['Oslo', 'Norway', 59.90, 12400], ['Helsinki', 'Finland', 60.32, 13500], ['Reykjavik', 'Iceland', 64.13, 11500],
].map(([city, country, lat, E]) => ({ city, country, lat, E }));

const DIFFUSE_EFFICACY = 120; // lm/W, used only when the EPW has no illuminance data

/** Solar altitude (radians) — simple NOAA-style approximation. */
export function solarAltitude(latDeg, lonDeg, tzHours, dayOfYear, localStdHour) {
  const rad = Math.PI / 180;
  const B = (360 / 365) * (dayOfYear - 81) * rad;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutes
  const solarTime = localStdHour + (4 * (lonDeg - 15 * tzHours) + eot) / 60;
  const omega = (15 * (solarTime - 12)) * rad;
  const decl = 23.45 * Math.sin((360 / 365) * (284 + dayOfYear) * rad) * rad;
  const lat = latDeg * rad;
  return Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(omega));
}

export const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/**
 * Sun position. hour = local standard time (decimal); when lon/tz are unknown pass lon = 15·tz
 * (solar time). Returns altitude and azimuth in degrees (azimuth clockwise from north).
 */
export function sunPosition(latDeg, lonDeg, tzHours, dayOfYear, hour) {
  const rad = Math.PI / 180;
  const B = (360 / 365) * (dayOfYear - 81) * rad;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const solarTime = hour + (4 * (lonDeg - 15 * tzHours) + eot) / 60;
  const w = 15 * (solarTime - 12) * rad;
  const d = 23.45 * Math.sin((360 / 365) * (284 + dayOfYear) * rad) * rad;
  const f = latDeg * rad;
  const alt = Math.asin(Math.sin(f) * Math.sin(d) + Math.cos(f) * Math.cos(d) * Math.cos(w));
  const azS = Math.atan2(Math.sin(w), Math.cos(w) * Math.sin(f) - Math.tan(d) * Math.cos(f)); // from south, west +
  return { alt: alt / rad, az: ((azS / rad + 180) % 360 + 360) % 360 };
}

/** Unit vector towards the sun in model coordinates. north = angle of True North, counter-clockwise from +Y (Ladybug convention). */
export function sunVector(altDeg, azDeg, northDeg) {
  const rad = Math.PI / 180, a = (azDeg - northDeg) * rad, h = altDeg * rad;
  return [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
}

/**
 * Parse an EnergyPlus weather file and compute the median diffuse horizontal illuminance
 * during daylight hours (sun above the horizon), as defined in EN 17037.
 */
export function parseEPW(text) {
  const lines = text.split(/\r?\n/);
  const head = (lines[0] || '').split(',');
  if (head[0].trim().toUpperCase() !== 'LOCATION') throw new Error('This does not look like an EPW file (missing LOCATION line).');
  const city = head[1] || '', region = head[2] || '', country = head[3] || '';
  const lat = parseFloat(head[6]), lon = parseFloat(head[7]), tz = parseFloat(head[8]);
  if (!isFinite(lat) || !isFinite(lon) || !isFinite(tz)) throw new Error('Invalid coordinates in the LOCATION line.');
  const illum = [], rad = [], hourly = [];
  for (let i = 8; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length < 20) continue;
    const month = +f[1], day = +f[2], hour = +f[3];
    if (!(month >= 1 && month <= 12)) continue;
    const doy = CUM_DAYS[month - 1] + day;
    const alt = solarAltitude(lat, lon, tz, doy, hour - 0.5); // EPW hour h covers (h-1, h]
    if (alt <= 0) continue;
    const ill = +f[18], dhr = +f[15], dnr = +f[14];
    hourly.push({ month, doy, hour: hour - 0.5, dni: isFinite(dnr) && dnr < 9999 ? Math.max(0, dnr) : 0, dhi: isFinite(dhr) && dhr < 9999 ? Math.max(0, dhr) : 0 });
    if (isFinite(ill) && ill > 0 && ill < 999900) illum.push(ill);
    if (isFinite(dhr) && dhr >= 0 && dhr < 9999) rad.push(dhr * DIFFUSE_EFFICACY);
  }
  let data = illum, source = 'illuminance data';
  if (illum.length < rad.length * 0.8) { data = rad; source = 'diffuse radiation × ' + DIFFUSE_EFFICACY + ' lm/W'; }
  if (data.length < 500) throw new Error('Not enough hourly data in the EPW file.');
  data.sort((a, b) => a - b);
  const median = data[data.length >> 1];
  return { city: city.replace(/[._]/g, ' ').trim(), region, country, lat, lon, tz, E: Math.round(median / 100) * 100, hours: data.length, source, hourly };
}
