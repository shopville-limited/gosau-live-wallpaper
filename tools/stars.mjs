// Katalog hvězd pro noční oblohu Alp: Yale Bright Star Catalogue (5. vydání, volné dílo),
// JSON převod z https://github.com/brettonw/YaleBrightStarCatalog. Vezme hvězdy do 6. magnitudy
// (co je vidět pouhým okem) a uloží je do scenes/alpy/assets/hvezdy.bin jako Float32:
// rektascenze (rad), deklinace (rad), magnituda V, barevná teplota (K). Epocha J2000.
//
// Použití: node tools/stars.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://brettonw.github.io/YaleBrightStarCatalog/bsc5-short.json';
const cache = join(root, 'tools', '.cache', 'bsc5-short.json');
const out = join(root, 'scenes', 'alpy', 'assets', 'hvezdy.bin');

let text;
try {
  text = await readFile(cache, 'utf8');
} catch {
  console.log(`Stahuji ${SOURCE}`);
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  text = await response.text();
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, text);
}

const ra = (s) => {
  const m = /(\d+)h\s*(\d+)m\s*([\d.]+)s/.exec(s);
  return m ? ((+m[1] + +m[2] / 60 + +m[3] / 3600) * 15 * Math.PI) / 180 : NaN;
};
const dec = (s) => {
  const m = /([+-])(\d+)°\s*(\d+)′\s*([\d.]+)″/.exec(s);
  if (!m) return NaN;
  const v = +m[2] + +m[3] / 60 + +m[4] / 3600;
  return ((m[1] === '-' ? -v : v) * Math.PI) / 180;
};

const stars = JSON.parse(text)
  .map((s) => [ra(s.RA), dec(s.Dec), parseFloat(s.V), parseFloat(s.K) || 6000])
  .filter(([a, d, v]) => Number.isFinite(a) && Number.isFinite(d) && Number.isFinite(v) && v <= 6.0)
  .sort((a, b) => a[2] - b[2]);   // nejjasnější první

const data = new Float32Array(stars.length * 4);
stars.forEach((s, i) => data.set(s, i * 4));
await writeFile(out, Buffer.from(data.buffer));
console.log(`Uloženo ${stars.length} hvězd do ${out} (${data.byteLength} B), nejjasnější V = ${stars[0][2]}`);
