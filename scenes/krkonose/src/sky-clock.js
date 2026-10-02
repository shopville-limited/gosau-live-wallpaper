// Čas nad Alpami: poloha slunce pro dané datum a místo, fáze měsíce a roční období.
// Svět: x = východ, y = nahoru, z = sever (kamera se dívá na sever).

const RAD = Math.PI / 180;

/** Poloha slunce (výška a azimut od severu po směru hodin, ve stupních). */
export function solarPosition(date, latitude, longitude) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;   // dny od J2000
  const meanLongitude = (280.460 + 0.9856474 * n) % 360;
  const anomaly = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (meanLongitude + 1.915 * Math.sin(anomaly) + 0.020 * Math.sin(2 * anomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(lambda));
  const gmst = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const hourAngle = (gmst * 15 + longitude) * RAD - ra;
  const lat = latitude * RAD;
  const elevation = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle));
  const azimuth = Math.atan2(-Math.sin(hourAngle), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(hourAngle));
  return { elevation: elevation / RAD, azimuth: ((azimuth / RAD) + 360) % 360 };
}

/** Jednotkový vektor ve světě z výšky a azimutu (stupně). */
export function direction(elevation, azimuth) {
  const e = elevation * RAD, a = azimuth * RAD;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** Fáze měsíce: 0 nov, 0,5 úplněk. */
export function moonPhase(date) {
  const days = date.getTime() / 86400000 + 2440587.5 - 2451550.1;
  return ((days / 29.530588853) % 1 + 1) % 1;
}

/**
 * Měsíc na obloze. Skutečná poloha by byla většinou za zády kamery, proto je
 * umělecky na severní obloze: v noci putuje zprava doleva nízko nad hřebeny.
 */
export function moonDirection(date) {
  const hours = date.getHours() + date.getMinutes() / 60;
  const night = (((hours - 18) % 24) + 24) % 24 / 12;       // 0 v 18:00, 1 v 6:00
  const t = Math.min(1, Math.max(0, night));
  return direction(4 + 11 * Math.sin(Math.PI * t), 45 - 70 * t);
}

// Lineární interpolace přes body po měsících (střed měsíce), cyklicky přes rok.
function yearly(dayOfYear, values) {
  const pos = ((dayOfYear - 15) / 365.25) * 12;
  const i = Math.floor(pos);
  const f = pos - i;
  const a = values[((i % 12) + 12) % 12];
  const b = values[(((i + 1) % 12) + 12) % 12];
  return a + (b - a) * f;
}

export function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return (date - start) / 86400000;
}

/** Roční období pro datum: sněžná čára, zima, podzim, jaro, led na jezeře, mlha, mraky. */
export function seasonFor(date) {
  const d = dayOfYear(date);
  //                led   úno   bře   dub   kvě   čer   čvc   srp   zář   říj   lis   pro
  // Krkonoše: sněžná čára v km n. m.; sníh na hřebenech od listopadu do května.
  const snowLine = yearly(d, [0.3, 0.3, 0.75, 1.25, 1.65, 2.6, 2.8, 2.8, 2.6, 1.7, 1.05, 0.5]);
  const ice = 0;   // jezero tu není
  // Modříny zlátnou a buky rudnou od října, vrchol na přelomu října a listopadu.
  const autumn = yearly(d, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.8, 0]);
  const spring = yearly(d, [0, 0, 0, 0.45, 1.0, 0.5, 0, 0, 0, 0, 0, 0]);
  const cloudiness = yearly(d, [0.6, 0.55, 0.55, 0.5, 0.45, 0.4, 0.35, 0.35, 0.35, 0.45, 0.6, 0.65]);
  const mist = yearly(d, [0.4, 0.4, 0.45, 0.4, 0.35, 0.3, 0.3, 0.35, 0.5, 0.75, 0.8, 0.5]);
  const winter = 1 - Math.min(1, Math.max(0, (snowLine - 0.5) / 0.7));
  return { snowLine, winter, autumn, spring, ice, cloudiness, mist };
}

export const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

// ---- Noční obloha: hvězdy, Mléčná dráha a planety na skutečných místech ----

/** Místní hvězdný čas (rad) pro datum a zeměpisnou délku. */
export function siderealTime(date, longitude) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const gmst = 280.46061837 + 360.98564736629 * n;
  return ((((gmst + longitude) % 360) + 360) % 360) * RAD;
}

// Směr ve světě (x východ, y nahoru, z sever) na jednotkový vektor v rovníkových
// souřadnicích J2000 (x k jarnímu bodu, z k severnímu nebeskému pólu).
function worldToEquatorial([x, y, z], lat, lst) {
  const alt = Math.asin(Math.max(-1, Math.min(1, y)));
  const az = Math.atan2(x, z);
  const dec = Math.asin(Math.sin(lat) * Math.sin(alt) + Math.cos(lat) * Math.cos(alt) * Math.cos(az));
  const hour = Math.atan2(-Math.sin(az) * Math.cos(alt), Math.cos(lat) * Math.sin(alt) - Math.sin(lat) * Math.cos(alt) * Math.cos(az));
  const ra = lst - hour;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}

// Rovníkové J2000 → galaktické souřadnice (řádky matice).
const GALACTIC = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.4448296300, 0.7469822445],
  [-0.8676661490, -0.1980763734, 0.4559837762],
];

/**
 * Natočení oblohy pro datum a místo: matice (po sloupcích, pro WebGL) z rovníkových
 * souřadnic do světa a ze světa do galaktických.
 */
export function skyFrame(date, latitude, longitude) {
  const lat = latitude * RAD, lst = siderealTime(date, longitude);
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => worldToEquatorial(v, lat, lst));
  const eqToWorld = new Float32Array(9);
  const worldToGalactic = new Float32Array(9);
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      eqToWorld[j * 3 + i] = cols[i][j];                     // transpozice (ortonormální)
      worldToGalactic[j * 3 + i] = GALACTIC[i][0] * cols[j][0] + GALACTIC[i][1] * cols[j][1] + GALACTIC[i][2] * cols[j][2];
    }
  }
  return { eqToWorld, worldToGalactic };
}

// Přibližné dráhy planet (JPL, Standish: platí 1800–2050): a, e, I, L, ϖ, Ω a změny za století.
const ORBITS = {
  merkur: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
    0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venuse: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
    0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  zeme: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  mars: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
    -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
    -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
};
// Jasnost: absolutní magnituda (pro r = Δ = 1 AU) a barevná teplota kotoučku.
const LOOKS = {
  merkur: [-0.4, 5200], venuse: [-4.4, 6300], mars: [-1.5, 3400], jupiter: [-9.4, 5600], saturn: [-8.9, 4900],
};

function heliocentric(name, T) {
  const o = ORBITS[name];
  const a = o[0] + o[6] * T, e = o[1] + o[7] * T, I = (o[2] + o[8] * T) * RAD;
  const L = o[3] + o[9] * T, peri = o[4] + o[10] * T, node = (o[5] + o[11] * T) * RAD;
  const M = ((((L - peri) % 360) + 540) % 360 - 180) * RAD;
  const w = (peri * RAD) - node;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(I), si = Math.sin(I);
  return [
    (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
    (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

/** Planety viditelné okem: směr v rovníkových souřadnicích J2000, magnituda, teplota barvy. */
export function planets(date) {
  const T = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
  const earth = heliocentric('zeme', T);
  const eps = 23.43928 * RAD;
  return Object.keys(LOOKS).map((name) => {
    const p = heliocentric(name, T);
    const g = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
    const delta = Math.hypot(...g), r = Math.hypot(...p);
    const eq = [g[0], g[1] * Math.cos(eps) - g[2] * Math.sin(eps), g[1] * Math.sin(eps) + g[2] * Math.cos(eps)].map((v) => v / delta);
    // Fázový úhel (u Merkuru a Venuše podstatný): planeta „v novu“ je slabší.
    const cosPhase = (r * r + delta * delta - Math.hypot(...earth) ** 2) / (2 * r * delta);
    const phaseDeg = Math.acos(Math.max(-1, Math.min(1, cosPhase))) / RAD;
    const a = phaseDeg;
    // Fázové opravy podle Mallamy (2018), u vnějších planet jen malé.
    const phase = name === 'venuse' ? -1.044e-3 * a + 3.687e-4 * a * a - 2.814e-6 * a ** 3 + 8.938e-9 * a ** 4
      : name === 'merkur' ? 0.0217 * a : name === 'mars' ? 0.016 * a : 0.005 * a;
    const mag = LOOKS[name][0] + 5 * Math.log10(r * delta) + phase;
    return { name, eq, mag, temp: LOOKS[name][1] };
  });
}
