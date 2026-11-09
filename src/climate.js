// Climate data for daylight targets.
// EN 17037 method 1 converts illuminance targets to daylight factor targets with the
// median external diffuse horizontal illuminance during daylight hours (Ev,d,med):
//   D_target = E_target / Ev,d,med · 100

// EN 17037:2018 Table A.3 — Ev,d,med for the capitals of CEN member countries
export const EN17037_CAPITALS = [
  ['Nicosia', 'Cipro', 34.88, 18100], ['La Valletta', 'Malta', 35.54, 16500], ['Atene', 'Grecia', 37.90, 19400],
  ['Lisbona', 'Portogallo', 38.73, 18220], ['Ankara', 'Turchia', 40.12, 19000], ['Madrid', 'Spagna', 40.45, 16900],
  ['Roma', 'Italia', 41.80, 19200], ['Skopje', 'Macedonia del Nord', 42.00, 15400], ['Sofia', 'Bulgaria', 42.73, 18700],
  ['Bucarest', 'Romania', 44.50, 18200], ['Zagabria', 'Croazia', 45.48, 17000], ['Lubiana', 'Slovenia', 46.22, 17000],
  ['Berna', 'Svizzera', 46.25, 16000], ['Budapest', 'Ungheria', 47.48, 18100], ['Vienna', 'Austria', 48.12, 16000],
  ['Bratislava', 'Slovacchia', 48.20, 16300], ['Parigi', 'Francia', 48.73, 15900], ['Lussemburgo', 'Lussemburgo', 49.36, 16000],
  ['Praga', 'Repubblica Ceca', 50.10, 14900], ['Bruxelles', 'Belgio', 50.90, 15000], ['Londra', 'Regno Unito', 51.51, 14100],
  ['Varsavia', 'Polonia', 52.17, 14700], ['Amsterdam', 'Paesi Bassi', 52.30, 14400], ['Berlino', 'Germania', 52.47, 13900],
  ['Dublino', 'Irlanda', 53.43, 14900], ['Vilnius', 'Lituania', 54.88, 15300], ['Copenaghen', 'Danimarca', 55.63, 14200],
  ['Riga', 'Lettonia', 56.57, 13600], ['Tallinn', 'Estonia', 59.25, 13600], ['Stoccolma', 'Svezia', 59.65, 12100],
  ['Oslo', 'Norvegia', 59.90, 12400], ['Helsinki', 'Finlandia', 60.32, 13500], ['Reykjavik', 'Islanda', 64.13, 11500],
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

const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/**
 * Parse an EnergyPlus weather file and compute the median diffuse horizontal illuminance
 * during daylight hours (sun above the horizon), as defined in EN 17037.
 */
export function parseEPW(text) {
  const lines = text.split(/\r?\n/);
  const head = (lines[0] || '').split(',');
  if (head[0].trim().toUpperCase() !== 'LOCATION') throw new Error('Il file non sembra un EPW (manca la riga LOCATION).');
  const city = head[1] || '', region = head[2] || '', country = head[3] || '';
  const lat = parseFloat(head[6]), lon = parseFloat(head[7]), tz = parseFloat(head[8]);
  if (!isFinite(lat) || !isFinite(lon) || !isFinite(tz)) throw new Error('Coordinate non valide nella riga LOCATION.');
  const illum = [], rad = [];
  for (let i = 8; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length < 20) continue;
    const month = +f[1], day = +f[2], hour = +f[3];
    if (!(month >= 1 && month <= 12)) continue;
    const doy = CUM_DAYS[month - 1] + day;
    const alt = solarAltitude(lat, lon, tz, doy, hour - 0.5); // EPW hour h covers (h-1, h]
    if (alt <= 0) continue;
    const ill = +f[18], dhr = +f[15];
    if (isFinite(ill) && ill > 0 && ill < 999900) illum.push(ill);
    if (isFinite(dhr) && dhr >= 0 && dhr < 9999) rad.push(dhr * DIFFUSE_EFFICACY);
  }
  let data = illum, source = 'illuminamento';
  if (illum.length < rad.length * 0.8) { data = rad; source = 'radiazione diffusa × ' + DIFFUSE_EFFICACY + ' lm/W'; }
  if (data.length < 500) throw new Error('Dati orari insufficienti nel file EPW.');
  data.sort((a, b) => a - b);
  const median = data[data.length >> 1];
  return { city: city.replace(/[._]/g, ' ').trim(), region, country, lat, lon, tz, E: Math.round(median / 100) * 100, hours: data.length, source };
}
