// Stáhne skutečný terén kolem Gosausee a Dachsteinu a připraví z něj výškovou mapu pro scénu Alpy.
//
// Zdroj: veřejné výškové dlaždice „terrarium“ (AWS Open Data, Mapzen). Pro Rakousko vycházejí
// z digitálního modelu terénu Rakouska 10 m (© data.gv.at / geoland.at, CC BY 4.0).
//
// Použití:  node tools/terrain.mjs
// Výstup:   scenes/alpy/assets/dachstein.bin  (Uint16, výška v decimetrech nad 900 m n. m.)
//           scenes/alpy/assets/dachstein-les.bin (Uint8, hustota lesa 0–255)
//           scenes/alpy/assets/dachstein-detail.bin (Uint16, okolí jezera po 5 m)
//           scenes/alpy/assets/dachstein.json (rozměry, poloha kamery, směr pohledu, zdroje)
// Bez knihoven: PNG se dekóduje ručně (zlib je součástí Node).

import { inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const out = join(project, 'scenes', 'alpy', 'assets');
const cache = join(project, 'tools', '.cache', 'terrarium');
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

const ZOOM = 13;
const LAKE_GUESS = { lat: 47.5288, lon: 13.5098 };      // Vorderer Gosausee
const DACHSTEIN = { lat: 47.4753, lon: 13.6062, name: 'Hoher Dachstein' };
const SPACING = 25;                                     // m mezi body výškové mapy
const EXTENT = { left: -20000, right: 20000, near: -2000, far: 26000 };
const BASE = 900;                                       // m n. m. = nula v souboru

// ---- Dlaždice ----

function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  };
}

async function fetchTile(x, y, zoom = ZOOM) {
  const file = join(cache, `${zoom}-${x}-${y}.png`);
  if (existsSync(file)) return readFileSync(file);
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      const data = Buffer.from(await response.arrayBuffer());
      writeFileSync(file, data);
      return data;
    }
  }
  throw new Error(`Dlaždici ${url} nejde stáhnout.`);
}

// Minimální dekodér PNG: 8bitové RGB/RGBA bez prokládání.
function decodePng(buffer) {
  let pos = 8;
  let width = 0, height = 0, channels = 3;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6))
        throw new Error('Nečekaný formát PNG.');
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + i] = value & 255;
    }
  }
  return { width, height, channels, pixels };
}

// ---- Výšky v zeměpisných souřadnicích ----

const tiles = new Map();
async function loadArea(latMin, latMax, lonMin, lonMax, zoom = ZOOM) {
  const a = tileOf(latMax, lonMin, zoom), b = tileOf(latMin, lonMax, zoom);
  const jobs = [];
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) {
    for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
      jobs.push([x, y]);
    }
  }
  console.log(`Stahuji ${jobs.length} dlaždic (zoom ${zoom})…`);
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(jobs.slice(i, i + 8).map(async ([x, y]) => {
      tiles.set(`${zoom},${x},${y}`, decodePng(await fetchTile(x, y, zoom)));
    }));
  }
}

function elevation(lat, lon, zoom = ZOOM) {
  const t = tileOf(lat, lon, zoom);
  const fx = t.x * 256 - 0.5, fy = t.y * 256 - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const sample = (px, py) => {
    const tile = tiles.get(`${zoom},${Math.floor(px / 256)},${Math.floor(py / 256)}`);
    if (!tile) return NaN;
    const i = ((py & 255) * 256 + (px & 255)) * tile.channels;
    return tile.pixels[i] * 256 + tile.pixels[i + 1] + tile.pixels[i + 2] / 256 - 32768;
  };
  const u = fx - x0, v = fy - y0;
  return (sample(x0, y0) * (1 - u) + sample(x0 + 1, y0) * u) * (1 - v)
       + (sample(x0, y0 + 1) * (1 - u) + sample(x0 + 1, y0 + 1) * u) * v;
}

const M_PER_DEG_LAT = 111132;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// ---- Hlavní běh ----

await loadArea(47.22, 47.72, 13.10, 14.00);

// Jezero: plochá oblast kolem odhadu. Najdi hladinu a body jezera.
const lakeLevel = elevation(LAKE_GUESS.lat, LAKE_GUESS.lon);
const lake = [];
for (let dlat = -0.02; dlat <= 0.02; dlat += 0.0002) {
  for (let dlon = -0.03; dlon <= 0.03; dlon += 0.0003) {
    const lat = LAKE_GUESS.lat + dlat, lon = LAKE_GUESS.lon + dlon;
    if (Math.abs(elevation(lat, lon) - lakeLevel) < 0.6) lake.push({ lat, lon });
  }
}
// Jen souvislá část kolem odhadu (zahodit náhodně stejně vysoká místa jinde).
const near = lake.filter((p) => Math.hypot((p.lat - LAKE_GUESS.lat) * M_PER_DEG_LAT, (p.lon - LAKE_GUESS.lon) * mPerDegLon(p.lat)) < 1500);
const centroid = near.reduce((a, p) => ({ lat: a.lat + p.lat / near.length, lon: a.lon + p.lon / near.length }), { lat: 0, lon: 0 });
// Směr pohledu na Dachstein ze středu jezera; kamera na opačném konci jezera.
const toPeak = {
  east: (DACHSTEIN.lon - centroid.lon) * mPerDegLon(centroid.lat),
  north: (DACHSTEIN.lat - centroid.lat) * M_PER_DEG_LAT,
};
const len = Math.hypot(toPeak.east, toPeak.north);
const dir = { east: toPeak.east / len, north: toPeak.north / len };
let far = centroid, farDistance = 0;
for (const p of near) {
  const along = -((p.lon - centroid.lon) * mPerDegLon(centroid.lat) * dir.east + (p.lat - centroid.lat) * M_PER_DEG_LAT * dir.north);
  if (along > farDistance) { farDistance = along; far = p; }
}
// Kamera na vodě asi 350 m od severozápadního konce, uprostřed šířky jezera
// (jezero neleží přesně v ose pohledu, rovný posun by mohl skončit na břehu).
const offsets = near.map((p) => {
  const e = (p.lon - far.lon) * mPerDegLon(far.lat);
  const n = (p.lat - far.lat) * M_PER_DEG_LAT;
  return { p, along: e * dir.east + n * dir.north, side: e * dir.north - n * dir.east };
});
// První místo od konce jezera, kde je voda aspoň asi 180 m široká.
let back = 250, slice = [];
for (; back < 1500; back += 50) {
  slice = offsets.filter((o) => Math.abs(o.along - back) < 25);
  if (slice.length >= 8) break;
}
const sides = slice.map((o) => o.side).sort((a, b) => a - b);
const middle = sides.length ? (sides[0] + sides[sides.length - 1]) / 2 : 0;
const cameraEast = dir.east * back + dir.north * middle;
const cameraNorth = dir.north * back - dir.east * middle;
const camera = {
  lat: far.lat + cameraNorth / M_PER_DEG_LAT,
  lon: far.lon + cameraEast / mPerDegLon(far.lat),
};
if (Math.abs(elevation(camera.lat, camera.lon) - lakeLevel) > 1) throw new Error('Kamera nestojí nad jezerem.');
console.log(`Kamera ${back} m od konce jezera, šířka jezera tam ${sides.length ? (sides[sides.length - 1] - sides[0]).toFixed(0) : '?'} m`);
const azimuth = (Math.atan2(dir.east, dir.north) * 180) / Math.PI;
console.log(`Hladina ${lakeLevel.toFixed(1)} m n. m., bodů jezera ${near.length}, kamera ${camera.lat.toFixed(5)}, ${camera.lon.toFixed(5)}, azimut ${azimuth.toFixed(1)}°`);

// Výšková mapa v souřadnicích scény: z dopředu (na Dachstein), x doprava.
const cols = Math.round((EXTENT.right - EXTENT.left) / SPACING) + 1;
const rows = Math.round((EXTENT.far - EXTENT.near) / SPACING) + 1;
const heights = new Uint16Array(cols * rows);
const right = { east: dir.north, north: -dir.east };
let missing = 0;
for (let r = 0; r < rows; r++) {
  const z = EXTENT.near + r * SPACING;
  for (let c = 0; c < cols; c++) {
    const x = EXTENT.left + c * SPACING;
    const east = dir.east * z + right.east * x;
    const north = dir.north * z + right.north * x;
    const lat = camera.lat + north / M_PER_DEG_LAT;
    const lon = camera.lon + east / mPerDegLon(camera.lat);
    let h = elevation(lat, lon);
    if (!Number.isFinite(h)) { h = lakeLevel + 200; missing++; }
    // Dno jezera o kus níž, ať hladina a terén neblikají přes sebe.
    if (Math.abs(h - lakeLevel) < 0.6) h = NaN;   // jezero: dno se dopočítá podle vzdálenosti od břehu
    heights[r * cols + c] = Number.isNaN(h) ? 0 : Math.max(1, Math.min(65535, Math.round((h - BASE) * 10)));
  }
}
if (missing) console.warn(`Bez dat: ${missing} bodů.`);

shapeLakeBed(heights, cols, rows, SPACING);

// Dno jezera: od břehu plynule klesá (0,3 m na metr, nejvýš 40 m). Hodnota 0 v mřížce
// značí jezero; vzdálenost od břehu se spočítá dvouprůchodovou chamferovou transformací.
function shapeLakeBed(grid, w, h, spacing) {
  const far = 1e9;
  const d = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = grid[i] === 0 ? far : 0;
  const diag = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
    if (y > 0) d[i] = Math.min(d[i], d[i - w] + 1);
    if (x > 0 && y > 0) d[i] = Math.min(d[i], d[i - w - 1] + diag);
    if (x < w - 1 && y > 0) d[i] = Math.min(d[i], d[i - w + 1] + diag);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
    if (y < h - 1) d[i] = Math.min(d[i], d[i + w] + 1);
    if (x < w - 1 && y < h - 1) d[i] = Math.min(d[i], d[i + w + 1] + diag);
    if (x > 0 && y < h - 1) d[i] = Math.min(d[i], d[i + w - 1] + diag);
  }
  for (let i = 0; i < w * h; i++) {
    if (grid[i] !== 0) continue;
    const depth = Math.min(40, 0.4 + d[i] * spacing * 0.3);
    grid[i] = Math.max(1, Math.round((lakeLevel - depth - BASE) * 10));
  }
}

// ---- Jemná mapa blízkého okolí ----
// Kolem jezera po 5 m z dlaždic zoom 15 (zdrojová data mají 10 m): blízké stěny a břehy
// pak mají skutečné žlaby a pilíře, ne jen rozmazaný tvar z 25m mřížky.
const FINE = { spacing: 5, left: -3000, right: 3000, near: -500, far: 4500, zoom: 15 };
const fineCols = Math.round((FINE.right - FINE.left) / FINE.spacing) + 1;
const fineRows = Math.round((FINE.far - FINE.near) / FINE.spacing) + 1;
{
  const corners = [[FINE.left, FINE.near], [FINE.right, FINE.near], [FINE.left, FINE.far], [FINE.right, FINE.far]].map(([x, z]) => {
    const east = dir.east * z + right.east * x, north = dir.north * z + right.north * x;
    return { lat: camera.lat + north / M_PER_DEG_LAT, lon: camera.lon + east / mPerDegLon(camera.lat) };
  });
  const lats = corners.map((c) => c.lat), lons = corners.map((c) => c.lon);
  await loadArea(Math.min(...lats) - 0.002, Math.max(...lats) + 0.002, Math.min(...lons) - 0.003, Math.max(...lons) + 0.003, FINE.zoom);
}
const fine = new Uint16Array(fineCols * fineRows);
for (let r = 0; r < fineRows; r++) {
  const z = FINE.near + r * FINE.spacing;
  for (let c = 0; c < fineCols; c++) {
    const x = FINE.left + c * FINE.spacing;
    const east = dir.east * z + right.east * x;
    const north = dir.north * z + right.north * x;
    let h = elevation(camera.lat + north / M_PER_DEG_LAT, camera.lon + east / mPerDegLon(camera.lat), FINE.zoom);
    if (!Number.isFinite(h)) h = elevation(camera.lat + north / M_PER_DEG_LAT, camera.lon + east / mPerDegLon(camera.lat));
    if (Math.abs(h - lakeLevel) < 0.6) h = NaN;   // jezero: dno se dopočítá podle vzdálenosti od břehu
    fine[r * fineCols + c] = Number.isNaN(h) ? 0 : Math.max(1, Math.min(65535, Math.round((h - BASE) * 10)));
  }
}
// Vyhlazení šumu dat (dlaždice mají rozlišení ~10 m a zaokrouhlovací šum): dvakrát
// průměr 3×3 bodů mimo jezero. Jinak by nízké slunce ukázalo zrnitost jako tmavé skvrny.
for (let pass = 0; pass < 2; pass++) {
  const copy = Float64Array.from(fine);
  for (let r = 1; r < fineRows - 1; r++) {
    for (let c = 1; c < fineCols - 1; c++) {
      const i = r * fineCols + c;
      if (copy[i] === 0) continue;
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const v = copy[i + dr * fineCols + dc];
        if (v === 0) continue;
        sum += v; n++;
      }
      fine[i] = Math.round(sum / n);
    }
  }
}
shapeLakeBed(fine, fineCols, fineRows, FINE.spacing);
writeFileSync(join(out, 'dachstein-detail.bin'), Buffer.from(fine.buffer));

// ---- Kde roste les ----
// Hustota lesa 0–255 podle pravidel: jen pod horní hranicí lesa (kolem 1700 m n. m.,
// nad ní řídne v kosodřevinu do 1950 m), jen na svazích do zhruba 48°, ne ve žlabech,
// kudy chodí laviny a sutě, a ne ve vodě. Výsledek se trochu rozmaže, ať okraje nejsou ostré.
const meters = (r, c) => heights[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))] / 10 + BASE;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rawForest = new Float32Array(cols * rows);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const h = meters(r, c);
    if (h < lakeLevel + 0.5) continue;
    const gx = (meters(r, c + 1) - meters(r, c - 1)) / (2 * SPACING);
    const gz = (meters(r + 1, c) - meters(r - 1, c)) / (2 * SPACING);
    const slope = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
    // Zakřivení na 75 m: kladné = žlab (terén kolem je výš).
    const around = (meters(r, c + 3) + meters(r, c - 3) + meters(r + 3, c) + meters(r - 3, c)) / 4;
    const gully = smooth(3, 12, around - h);
    const altitude = 1 - smooth(1650, 1950, h);
    rawForest[r * cols + c] = altitude * (1 - smooth(40, 52, slope)) * (1 - 0.85 * gully);
  }
}
const forest = new Uint8Array(cols * rows);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    let sum = 0, n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      sum += rawForest[rr * cols + cc];
      n++;
    }
    forest[r * cols + c] = Math.round((sum / n) * 255);
  }
}
writeFileSync(join(out, 'dachstein-les.bin'), Buffer.from(forest.buffer));

// Místa na mapě v souřadnicích scény (km).
function local(lat, lon) {
  const east = (lon - camera.lon) * mPerDegLon(camera.lat);
  const north = (lat - camera.lat) * M_PER_DEG_LAT;
  return [+(east * right.east + north * right.north).toFixed(1) / 1000, +(east * dir.east + north * dir.north).toFixed(1) / 1000];
}

writeFileSync(join(out, 'dachstein.bin'), Buffer.from(heights.buffer));
writeFileSync(join(out, 'dachstein.json'), JSON.stringify({
  columns: cols,
  rows,
  detail: { columns: fineCols, rows: fineRows, spacing: FINE.spacing / 1000, left: FINE.left / 1000, near: FINE.near / 1000 },
  spacing: SPACING / 1000,
  left: EXTENT.left / 1000,
  near: EXTENT.near / 1000,
  lakeLevel: +lakeLevel.toFixed(1),
  base: BASE,
  scale: 0.1,
  camera: { lat: +camera.lat.toFixed(6), lon: +camera.lon.toFixed(6), azimuth: +azimuth.toFixed(2) },
  places: {
    dachstein: local(DACHSTEIN.lat, DACHSTEIN.lon),
    gosaugletscher: local(47.4865, 13.5935),
    bischofsmuetze: local(47.4958, 13.4906),
    gablonzerHuette: local(47.5198, 13.4611),
    adamekHuette: local(47.4870, 13.5733),
    lakeCenter: local(centroid.lat, centroid.lon),
  },
  source: 'Mapzen Terrain Tiles (AWS Open Data), pro Rakousko z DGM Österreich 10 m © data.gv.at / geoland.at, CC BY 4.0',
}, null, 2));
console.log(`Hotovo: ${cols}×${rows} bodů po ${SPACING} m → scenes/alpy/assets/dachstein.bin a dachstein-les.bin`);
