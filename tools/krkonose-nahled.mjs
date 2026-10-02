// Náhledy výhledů na Sněžku ze skutečného terénu (pro výběr budoucí scény Krkonoše).
// Stáhne výškové dlaždice terrarium (zoom 14, ~6 m), pro každý výhled spočítá jednoduchý
// obraz paprskem (stínovaný terén, hranice lesa a kleče, obloha, opar) a uloží PPM;
// převod do PNG dělá ffmpeg. Výstup: postup/krkonose/nahled-*.png
//
// Použití: node tools/krkonose-nahled.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(project, 'tools', '.cache', 'terrarium');
const out = join(project, 'postup', 'krkonose');
mkdirSync(cache, { recursive: true });
mkdirSync(out, { recursive: true });
const ZOOM = 14;

function tileOf(lat, lon, z) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}
async function fetchTile(x, y) {
  const file = join(cache, `${ZOOM}-${x}-${y}.png`);
  if (existsSync(file)) return readFileSync(file);
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url);
    if (r.ok) { const d = Buffer.from(await r.arrayBuffer()); writeFileSync(file, d); return d; }
  }
  throw new Error('nejde stáhnout ' + url);
}
function decodePng(buffer) {
  let pos = 8, width = 0, height = 0, channels = 3;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos), type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? px[y * stride + i - channels] : 0, up = y > 0 ? px[(y - 1) * stride + i] : 0;
      const ul = y > 0 && i >= channels ? px[(y - 1) * stride + i - channels] : 0;
      let v = line[i];
      if (f === 1) v += left; else if (f === 2) v += up; else if (f === 3) v += (left + up) >> 1;
      else if (f === 4) { const pp = left + up - ul, pa = Math.abs(pp - left), pb = Math.abs(pp - up), pc = Math.abs(pp - ul); v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
      px[y * stride + i] = v & 255;
    }
  }
  return { width, height, channels, px };
}

// Oblast Krkonoš: výšky do jedné mřížky (dlaždice zoom 14).
const AREA = { latMin: 50.62, latMax: 50.84, lonMin: 15.45, lonMax: 16.00 };
const a = tileOf(AREA.latMax, AREA.lonMin, ZOOM), b = tileOf(AREA.latMin, AREA.lonMax, ZOOM);
const tx0 = Math.floor(a.x), ty0 = Math.floor(a.y), tx1 = Math.floor(b.x), ty1 = Math.floor(b.y);
const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256;
const grid = new Float32Array(W * H);
console.log(`Stahuji ${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} dlaždic...`);
for (let tx = tx0; tx <= tx1; tx++) {
  await Promise.all(Array.from({ length: ty1 - ty0 + 1 }, async (_, k) => {
    const ty = ty0 + k;
    const t = decodePng(await fetchTile(tx, ty));
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * t.channels;
      grid[((ty - ty0) * 256 + y) * W + (tx - tx0) * 256 + x] = t.px[i] * 256 + t.px[i + 1] + t.px[i + 2] / 256 - 32768;
    }
  }));
}
// Přesný model ČR (ČÚZK DMR 5G, CC BY 4.0) přes jejich mapovou službu; v Polsku nic
// (tam zůstanou dlaždice terrarium).
const DMR_URL = 'https://ags.cuzk.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage';
const dmrFile = join(project, 'tools', '.cache', 'dmr5g-snezka.bin');
const dmrMeta = dmrFile + '.json';
if (!existsSync(dmrFile)) {
  console.log('Stahuji DMR 5G (ČÚZK)...');
  const q = 'bbox=15.60,50.68,15.85,50.79&bboxSR=4326&imageSR=4326&size=3500,2200&format=bsq&pixelType=F32&noData=-9999&interpolation=RSP_BilinearInterpolation';
  const meta = await (await fetch(`${DMR_URL}?${q}&f=json`)).json();
  const data = Buffer.from(await (await fetch(meta.href)).arrayBuffer());
  writeFileSync(dmrFile, data);
  writeFileSync(dmrMeta, JSON.stringify(meta));
}
const dmr = (() => {
  const meta = JSON.parse(readFileSync(dmrMeta, 'utf8'));
  const b = readFileSync(dmrFile);
  return { meta, data: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + meta.width * meta.height * 4)) };
})();
function dmrHeight(lat, lon) {
  const { meta, data } = dmr, e = meta.extent;
  const gx = (lon - e.xmin) / (e.xmax - e.xmin) * meta.width - 0.5, gy = (e.ymax - lat) / (e.ymax - e.ymin) * meta.height - 0.5;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  if (ix < 0 || iy < 0 || ix >= meta.width - 1 || iy >= meta.height - 1) return null;
  const fx = gx - ix, fy = gy - iy;
  const v = [data[iy * meta.width + ix], data[iy * meta.width + ix + 1], data[(iy + 1) * meta.width + ix], data[(iy + 1) * meta.width + ix + 1]];
  if (v.some((x) => !(x > -100 && x < 3000))) return null;
  return v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy) + v[2] * (1 - fx) * fy + v[3] * fx * fy;
}

// Místní souřadnice v metrech kolem Sněžky (x východ, z sever).
const REF = { lat: 50.7360, lon: 15.7399 };
const M_LAT = 111320, M_LON = 111320 * Math.cos((REF.lat * Math.PI) / 180);
const toLatLon = (x, z) => ({ lat: REF.lat + z / M_LAT, lon: REF.lon + x / M_LON });
const toXZ = (lat, lon) => ({ x: (lon - REF.lon) * M_LON, z: (lat - REF.lat) * M_LAT });
function height(x, z) {
  const { lat, lon } = toLatLon(x, z);
  const precise = dmrHeight(lat, lon);
  if (precise !== null) return precise;
  const t = tileOf(lat, lon, ZOOM);
  const gx = (t.x - tx0) * 256 - 0.5, gy = (t.y - ty0) * 256 - 0.5;
  const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
  if (ix < 0 || iy < 0 || ix >= W - 1 || iy >= H - 1) return -1000;
  const h = (i, j) => grid[(iy + j) * W + ix + i];
  return h(0, 0) * (1 - fx) * (1 - fy) + h(1, 0) * fx * (1 - fy) + h(0, 1) * (1 - fx) * fy + h(1, 1) * fx * fy;
}
// Vrchol Sněžky: nejvyšší bod do 500 m od odhadu.
let peak = { x: 0, z: 0, h: -1 };
for (let x = -500; x <= 500; x += 10) for (let z = -500; z <= 500; z += 10) {
  const h = height(x, z);
  if (h > peak.h) peak = { x, z, h };
}
console.log(`Sněžka: ${peak.h.toFixed(0)} m n. m.`);

function lowest(lat, lon, radius) {
  const c = toXZ(lat, lon);
  let best = { x: c.x, z: c.z, h: 1e9 };
  for (let x = -radius; x <= radius; x += 10) for (let z = -radius; z <= radius; z += 10) {
    const h = height(c.x + x, c.z + z);
    if (h < best.h) best = { x: c.x + x, z: c.z + z, h };
  }
  return best;
}

// Mapa okolí shora (stínovaný reliéf, mřížka po 1 km, Sněžka červeně) pro výběr výhledů.
if (process.argv.includes('--mapa')) {
  const R = 7000, N = 1400, img = Buffer.alloc(N * N * 3);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -R + (i / N) * 2 * R, z = R - (j / N) * 2 * R, h = height(x, z);
    const dx = height(x + 10, z) - h, dz = height(x, z + 10) - h;
    let shade = Math.max(0, Math.min(1, 0.6 + (-dx - dz) * 0.05));
    let c = h < 1000 ? [0.2, 0.45, 0.2] : h < 1250 ? [0.15, 0.35, 0.15] : h < 1450 ? [0.45, 0.5, 0.3] : [0.75, 0.72, 0.65];
    c = c.map((v) => v * (0.4 + 0.8 * shade));
    if (Math.abs(((x % 1000) + 1000) % 1000) < 12 || Math.abs(((z % 1000) + 1000) % 1000) < 12) c = [0.0, 0.0, 0.0];
    if (Math.hypot(x - peak.x, z - peak.z) < 60) c = [1, 0, 0];
    const k = (j * N + i) * 3;
    for (let q = 0; q < 3; q++) img[k + q] = Math.round(255 * Math.min(1, c[q]));
  }
  const ppm = join(out, 'mapa.ppm');
  writeFileSync(ppm, Buffer.concat([Buffer.from(`P6 ${N} ${N} 255
`), img]));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', ppm, join(out, 'mapa.png')]);
  console.log('mapa: ±7 km kolem Sněžky, sever nahoře, mřížka 1 km');
  process.exit(0);
}

// Tři výhledy: poloha kamery, výška nad zemí, zorný úhel (vodorovně, stupně).
const lake = lowest(50.7577, 15.7158, 350);   // hladina Malého Stawu
// Obří důl: nejnižší místo 1,5–3 km jižně od Sněžky, odkud je vrchol vidět.
function visible(from, eye) {
  const c = [from.x, height(from.x, from.z) + eye, from.z];
  const d = [peak.x - c[0], peak.h + 2 - c[1], peak.z - c[2]], L = Math.hypot(...d);
  for (let s = 30; s < L - 40; s += 15) {
    const k = s / L;
    if (c[1] + d[1] * k < height(c[0] + d[0] * k, c[2] + d[2] * k)) return false;
  }
  return true;
}
let valley = null;
for (let r = 1500; r <= 3500; r += 50) for (let a = 150; a <= 215; a += 1.5) {
  const x = peak.x + Math.sin(a * Math.PI / 180) * r, z = peak.z + Math.cos(a * Math.PI / 180) * r, h = height(x, z);
  if ((!valley || h < valley.h) && visible({ x, z }, 3)) valley = { x, z, h };
}
const vl = toLatLon(valley.x, valley.z);
console.log(`Obří důl: ${vl.lat.toFixed(4)}, ${vl.lon.toFixed(4)}, ${valley.h.toFixed(0)} m`);
// Studniční hora: nejvyšší místo 1,2–2,6 km západně od Sněžky (nad Úpskou jámou).
let rim = null;
for (let r = 1200; r <= 2600; r += 40) for (let a = 225; a <= 305; a += 1) {
  const x = peak.x + Math.sin(a * Math.PI / 180) * r, z = peak.z + Math.cos(a * Math.PI / 180) * r, h = height(x, z);
  if (!rim || h > rim.h) rim = { x, z, h };
}
// Okraj nad jámou: z vrcholu Studniční hory posun 250 m směrem ke Sněžce.
{ const dx = peak.x - rim.x, dz = peak.z - rim.z, L = Math.hypot(dx, dz); rim = { x: rim.x + dx / L * 250, z: rim.z + dz / L * 250 }; }
const rl = toLatLon(rim.x, rim.z);
console.log(`Studniční hora: ${rl.lat.toFixed(4)}, ${rl.lon.toFixed(4)}, ${height(rim.x, rim.z).toFixed(0)} m`);
const views = [
  { name: '1-lucni-bouda', title: 'Luční bouda → Sněžka', ...toXZ(50.7349, 15.6958), eye: 8, fov: 50 },
  { name: '2-obri-dul', title: 'Obří důl → Sněžka', x: valley.x, z: valley.z, eye: 3, fov: 62 },
  { name: '3-studnicni-hora', title: 'Studniční hora (nad Úpskou jámou) → Sněžka', x: rim.x, z: rim.z, eye: 2, fov: 62 },
];

const IW = 1400, IH = 560;
const sun = (() => { const el = 22 * Math.PI / 180, az = 235 * Math.PI / 180; return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]; })();
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

for (const v of views) {
  const ground = height(v.x, v.z);
  const cam = [v.x, ground + v.eye, v.z];
  const toPeak = [peak.x - cam[0], peak.h - cam[1], peak.z - cam[2]];
  const dist = Math.hypot(toPeak[0], toPeak[2]);
  const yaw = Math.atan2(toPeak[0], toPeak[2]);
  // Obzor na obrazovce: vrchol Sněžky asi ve třetině výšky nad středem.
  const pitch = Math.atan2(toPeak[1], dist) - 0.05;
  const fx = Math.tan((v.fov * Math.PI) / 360), fy = fx * IH / IW;
  const img = Buffer.alloc(IW * IH * 3);
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  for (let py = 0; py < IH; py++) {
    for (let px = 0; px < IW; px++) {
      const u = ((px + 0.5) / IW * 2 - 1) * fx, w = (1 - (py + 0.5) / IH * 2) * fy;
      // směr: dopředu (yaw, pitch), doprava, nahoru
      let d = [u, w, 1];
      // pitch kolem osy x
      d = [d[0], d[1] * cp + d[2] * sp, -d[1] * sp + d[2] * cp];
      d = [d[0] * cy + d[2] * sy, d[1], -d[0] * sy + d[2] * cy];
      const len = Math.hypot(...d); d = d.map((c) => c / len);
      let t = 2, hit = false, p = cam;
      while (t < 40000) {
        p = [cam[0] + d[0] * t, cam[1] + d[1] * t, cam[2] + d[2] * t];
        const h = height(p[0], p[2]);
        if (p[1] < h) { hit = true; break; }
        if (v.lakeLevel && p[1] < v.lakeLevel + 0.6 && Math.hypot(p[0] - lake.x, p[2] - lake.z) < 350 && h > v.lakeLevel - 40 && h < v.lakeLevel + 1.5) { hit = true; p.water = true; break; }
        t += Math.max(1, (p[1] - h) * 0.4, t * 0.002);
      }
      let col;
      const sky = mix([0.52, 0.66, 0.86], [0.85, 0.88, 0.92], Math.pow(1 - Math.max(d[1], 0), 6));
      if (!hit) col = sky;
      else if (p.water) col = mix([0.10, 0.17, 0.22], sky, 0.35);
      else {
        const e = 6, h0 = height(p[0], p[2]);
        const n = [h0 - height(p[0] + e, p[2]), e, h0 - height(p[0], p[2] + e)];
        const nl = Math.hypot(...n); const nn = n.map((c) => c / nl);
        const slope = nn[1];
        const alt = h0;
        // Smrkový les do ~1250 m, kleč do ~1450 m, nad tím tráva, kamení; strmé svahy skála.
        let base = alt < 1250 ? [0.05, 0.09, 0.05] : alt < 1450 ? [0.09, 0.13, 0.06] : [0.30, 0.30, 0.22];
        base = mix(base, [0.36, 0.34, 0.31], smooth(0.8, 0.6, slope));
        if (alt > 1500) base = mix(base, [0.42, 0.40, 0.36], smooth(1500, 1580, alt) * 0.7);
        const diff = Math.max(0, nn[0] * sun[0] + nn[1] * sun[1] + nn[2] * sun[2]);
        col = base.map((c) => c * (0.35 + 1.4 * diff));
        const fog = 1 - Math.exp(-t / 9000);
        col = mix(col, [0.66, 0.74, 0.86], fog);
      }
      const i = (py * IW + px) * 3;
      for (let k = 0; k < 3; k++) img[i + k] = Math.round(255 * Math.min(1, Math.pow(col[k], 1 / 2.2)));
    }
  }
  const ppm = join(out, `nahled-${v.name}.ppm`), png = join(out, `nahled-${v.name}.png`);
  writeFileSync(ppm, Buffer.concat([Buffer.from(`P6 ${IW} ${IH} 255\n`), img]));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', ppm, png]);
  console.log(`${v.title}: kamera ${ground.toFixed(0)} m n. m., Sněžka ${(dist / 1000).toFixed(1)} km, převýšení ${(peak.h - ground).toFixed(0)} m → ${png}`);
}
