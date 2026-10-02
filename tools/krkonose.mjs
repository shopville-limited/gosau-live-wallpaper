// Terén scény Krkonoše: výhled ze Studniční hory (okraj Úpské jámy) na Sněžku.
// Česká část z ČÚZK DMR 5G (CC BY 4.0, přes mapovou službu ags.cuzk.cz), polská část
// a dálka z dlaždic terrarium (Mapzen, AWS Open Data). Výstup ve formátu scény:
//   scenes/krkonose/assets/teren.json, teren.bin (50 m), teren-detail.bin (5 m), teren-les.bin
// Výšky jsou v metrech nad mořem (base 0, „hladina“ 0): ve výhledu není žádná voda.
//
// Použití: node tools/krkonose.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(project, 'scenes', 'krkonose', 'assets');
const cache = join(project, 'tools', '.cache');
mkdirSync(out, { recursive: true });
mkdirSync(join(cache, 'terrarium'), { recursive: true });

const CAMERA = { lat: 50.72855, lon: 15.71171 };        // 35 m za hranou Úpské jámy pod Studniční horou: okraj jámy s klečí v popředí
const SNEZKA = { lat: 50.7360, lon: 15.7399 };
const MAIN = { spacing: 50, left: -30000, right: 30000, near: -4000, far: 60000 };
const FINE = { spacing: 5, left: -3000, right: 3000, near: -500, far: 3500 };

const M_LAT = 111132;
const mLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// ---- ČÚZK DMR 5G ----
const DMR = 'https://ags.cuzk.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage';
async function dmrGrid(name, bbox, width, height) {
  const file = join(cache, `dmr5g-${name}.bin`), metaFile = file + '.json';
  if (!existsSync(file)) {
    console.log(`Stahuji DMR 5G (${name}, ${width}×${height})…`);
    const q = `bbox=${bbox.join(',')}&bboxSR=4326&imageSR=4326&size=${width},${height}&format=bsq&pixelType=F32&noData=-9999&interpolation=RSP_BilinearInterpolation`;
    const meta = await (await fetch(`${DMR}?${q}&f=json`)).json();
    if (!meta.href) throw new Error('DMR: ' + JSON.stringify(meta));
    writeFileSync(file, Buffer.from(await (await fetch(meta.href)).arrayBuffer()));
    writeFileSync(metaFile, JSON.stringify(meta));
  }
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const b = readFileSync(file);
  const data = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + meta.width * meta.height * 4));
  return (lat, lon) => {
    const e = meta.extent;
    const gx = (lon - e.xmin) / (e.xmax - e.xmin) * meta.width - 0.5, gy = (e.ymax - lat) / (e.ymax - e.ymin) * meta.height - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    if (ix < 0 || iy < 0 || ix >= meta.width - 1 || iy >= meta.height - 1) return NaN;
    const fx = gx - ix, fy = gy - iy, w = meta.width;
    const v = [data[iy * w + ix], data[iy * w + ix + 1], data[(iy + 1) * w + ix], data[(iy + 1) * w + ix + 1]];
    if (v.some((x) => !(x > -100 && x < 3000))) return NaN;
    return v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy) + v[2] * (1 - fx) * fy + v[3] * fx * fy;
  };
}

// ---- Dlaždice terrarium ----
function tileOf(lat, lon, z) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
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
      else if (f === 4) { const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
      px[y * stride + i] = v & 255;
    }
  }
  return { channels, px };
}
const tiles = new Map();
async function loadTiles(lat0, lat1, lon0, lon1, zoom) {
  const a = tileOf(lat1, lon0, zoom), b = tileOf(lat0, lon1, zoom);
  const jobs = [];
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) jobs.push([x, y]);
  console.log(`Dlaždice zoom ${zoom}: ${jobs.length}`);
  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(jobs.slice(i, i + 8).map(async ([x, y]) => {
      const file = join(cache, 'terrarium', `${zoom}-${x}-${y}.png`);
      let buf;
      if (existsSync(file)) buf = readFileSync(file);
      else {
        const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`);
        buf = Buffer.from(await r.arrayBuffer());
        writeFileSync(file, buf);
      }
      tiles.set(`${zoom},${x},${y}`, decodePng(buf));
    }));
  }
}
function terrarium(lat, lon, zoom) {
  const t = tileOf(lat, lon, zoom), fx = t.x * 256 - 0.5, fy = t.y * 256 - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
  const s = (px, py) => {
    const tile = tiles.get(`${zoom},${Math.floor(px / 256)},${Math.floor(py / 256)}`);
    if (!tile) return NaN;
    const i = ((py & 255) * 256 + (px & 255)) * tile.channels;
    return tile.px[i] * 256 + tile.px[i + 1] + tile.px[i + 2] / 256 - 32768;
  };
  return (s(x0, y0) * (1 - u) + s(x0 + 1, y0) * u) * (1 - v) + (s(x0, y0 + 1) * (1 - u) + s(x0 + 1, y0 + 1) * u) * v;
}

// ---- Souřadnice scény: z dopředu (na Sněžku), x doprava ----
const toPeak = { east: (SNEZKA.lon - CAMERA.lon) * mLon(CAMERA.lat), north: (SNEZKA.lat - CAMERA.lat) * M_LAT };
const L = Math.hypot(toPeak.east, toPeak.north);
const dir = { east: toPeak.east / L, north: toPeak.north / L };
const right = { east: dir.north, north: -dir.east };
const azimuth = (Math.atan2(dir.east, dir.north) * 180) / Math.PI;
const latLon = (x, z) => {
  const east = dir.east * z + right.east * x, north = dir.north * z + right.north * x;
  return { lat: CAMERA.lat + north / M_LAT, lon: CAMERA.lon + east / mLon(CAMERA.lat) };
};
const bounds = (e) => {
  const c = [[e.left, e.near], [e.right, e.near], [e.left, e.far], [e.right, e.far]].map(([x, z]) => latLon(x, z));
  return { lat0: Math.min(...c.map((p) => p.lat)) - 0.003, lat1: Math.max(...c.map((p) => p.lat)) + 0.003,
    lon0: Math.min(...c.map((p) => p.lon)) - 0.005, lon1: Math.max(...c.map((p) => p.lon)) + 0.005 };
}
const bm = bounds(MAIN), bf = bounds(FINE);

const dmrFar = await dmrGrid('krkonose-50m', [bm.lon0, bm.lat0, bm.lon1, bm.lat1], 4000, 4000);
const dmrNear = await dmrGrid('krkonose-5m', [bf.lon0, bf.lat0, bf.lon1, bf.lat1], 3600, 2000);
await loadTiles(bm.lat0, bm.lat1, bm.lon0, bm.lon1, 11);
await loadTiles(bf.lat0, bf.lat1, bf.lon0, bf.lon1, 14);

function build(e, fine) {
  const cols = Math.round((e.right - e.left) / e.spacing) + 1, rows = Math.round((e.far - e.near) / e.spacing) + 1;
  const grid = new Float32Array(cols * rows);
  let fromDmr = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const { lat, lon } = latLon(e.left + c * e.spacing, e.near + r * e.spacing);
    let h = fine ? dmrNear(lat, lon) : dmrFar(lat, lon);
    if (Number.isFinite(h)) fromDmr++;
    else h = terrarium(lat, lon, fine ? 14 : 11);
    if (!Number.isFinite(h)) h = 400;
    grid[r * cols + c] = h;
  }
  console.log(`${fine ? 'Jemná' : 'Hlavní'} mapa ${cols}×${rows}, z DMR 5G ${(100 * fromDmr / (cols * rows)).toFixed(0)} %`);
  return { grid, cols, rows };
}
const main = build(MAIN, false);
const fine = build(FINE, true);
// Napojení: hranice ČR (DMR) a Polska (hrubší dlaždice) je v jemné mapě skoková; dvakrát
// vyhladit 3×3, v hlavní jednou.
function blur(g, cols, rows, passes) {
  for (let p = 0; p < passes; p++) {
    const copy = Float32Array.from(g.grid);
    for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
      let s = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) s += copy[(r + dr) * cols + c + dc];
      g.grid[r * cols + c] = s / 9;
    }
  }
}
blur(main, main.cols, main.rows, 1);
blur(fine, fine.cols, fine.rows, 2);
const toU16 = (g) => { const u = new Uint16Array(g.length); for (let i = 0; i < g.length; i++) u[i] = Math.max(1, Math.min(65535, Math.round(g[i] * 10))); return u; };

// ---- Les: smrčiny do ~1250 m, nad tím řídnou (kleč dokreslí scéna), ne na strmých
// stěnách karů a v lavinových žlabech ----
// Hladký hodnotový šum 0..1 (pro ostrůvky kleče).
const hash = (x, y) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const at = (r, c) => main.grid[Math.min(main.rows - 1, Math.max(0, r)) * main.cols + Math.min(main.cols - 1, Math.max(0, c))];
const rawForest = new Float32Array(main.cols * main.rows);
for (let r = 0; r < main.rows; r++) for (let c = 0; c < main.cols; c++) {
  const h = at(r, c);
  const gx = (at(r, c + 1) - at(r, c - 1)) / (2 * MAIN.spacing), gz = (at(r + 1, c) - at(r - 1, c)) / (2 * MAIN.spacing);
  const slope = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
  const around = (at(r, c + 2) + at(r, c - 2) + at(r + 2, c) + at(r - 2, c)) / 4;
  const gully = smooth(3, 10, around - h);
  const trees = (1 - smooth(1060, 1190, h)) * (1 - smooth(38, 50, slope)) * (1 - 0.8 * gully);
  // Kleč (kosodřevina) nad hranicí lesa do ~1450 m: husté porosty v ostrůvcích a pásech,
  // ne v lavinových drahách, na strmých skalách a na rovné tundře hřebene.
  const patch = vnoise(c * 0.35, r * 0.35) * 0.65 + vnoise(c * 1.1 + 17, r * 1.1 + 5) * 0.35;
  const klec = smooth(1120, 1200, h) * (1 - smooth(1400, 1470, h)) * smooth(0.42, 0.62, patch)
    * (1 - smooth(35, 48, slope)) * (1 - 0.9 * gully) * 0.85;
  rawForest[r * main.cols + c] = Math.max(trees, klec);
}
const forest = new Uint8Array(main.cols * main.rows);
for (let r = 0; r < main.rows; r++) for (let c = 0; c < main.cols; c++) {
  let s = 0, n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= main.rows || cc >= main.cols) continue;
    s += rawForest[rr * main.cols + cc]; n++;
  }
  forest[r * main.cols + c] = Math.round((s / n) * 255);
}

const local = (lat, lon) => {
  const east = (lon - CAMERA.lon) * mLon(CAMERA.lat), north = (lat - CAMERA.lat) * M_LAT;
  return [+((east * right.east + north * right.north) / 1000).toFixed(4), +((east * dir.east + north * dir.north) / 1000).toFixed(4)];
};
writeFileSync(join(out, 'teren.bin'), Buffer.from(toU16(main.grid).buffer));
writeFileSync(join(out, 'teren-detail.bin'), Buffer.from(toU16(fine.grid).buffer));
writeFileSync(join(out, 'teren-les.bin'), Buffer.from(forest.buffer));
const cameraGround = fine.grid[Math.round(-FINE.near / FINE.spacing) * fine.cols + Math.round(-FINE.left / FINE.spacing)];
writeFileSync(join(out, 'teren.json'), JSON.stringify({
  columns: main.cols, rows: main.rows,
  detail: { columns: fine.cols, rows: fine.rows, spacing: FINE.spacing / 1000, left: FINE.left / 1000, near: FINE.near / 1000 },
  spacing: MAIN.spacing / 1000, left: MAIN.left / 1000, near: MAIN.near / 1000,
  lakeLevel: 0, base: 0, scale: 0.1,
  cameraGround: +cameraGround.toFixed(1),
  camera: { lat: CAMERA.lat, lon: CAMERA.lon, azimuth: +azimuth.toFixed(2) },
  places: {
    snezka: local(SNEZKA.lat, SNEZKA.lon),
    lucniBouda: local(50.7349, 15.6958),
    obriBouda: local(50.7195, 15.7356),
    peceSnezka: local(50.6920, 15.7300),
    karpacz: local(50.7760, 15.7570),
  },
  source: 'ČÚZK DMR 5G (CC BY 4.0, ags.cuzk.cz); polská strana a dálka Mapzen Terrain Tiles (AWS Open Data)',
}, null, 2));
console.log(`Kamera ${cameraGround.toFixed(0)} m n. m., azimut ${azimuth.toFixed(1)}°, Sněžka ${local(SNEZKA.lat, SNEZKA.lon)} km`);
