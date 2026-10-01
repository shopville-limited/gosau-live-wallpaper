// Scéna „Rakouské Alpy“: jezero pod vápencovým masivem s ledovcem.
// Slunce jde podle skutečného času, krajina se mění s ročním obdobím. Čisté WebGL2, bez knihoven.
//
// V aplikaci tapety stránku řídí window.wallpaperHost (rate, power, action) a kurzor
// chodí jako pointermove / pointerleave. V prohlížeči se ukáže malé ovládání.

import config from './config.js';
import { createFrameLoop } from '../../shared/frame-loop.js';
import { setupControls } from '../../shared/controls.js';
import { rendererInfo, showSoftwareNotice, compileTimes } from '../../shared/gl.js';
import { createTerrain, loadHeightMap } from './terrain.js';
import { createDisplay } from './display.js';
import { createBirds } from './birds.js';
import { createBoats } from './boats.js';
import { createTrees } from './trees.js';
import { createWeather } from './weather.js';
import { createStars } from './stars.js';
import { createBoulders } from './boulders.js';
import { createSnapshotCache } from './snapshot-cache.js';
import { createParticles } from './particles.js';
import { solarPosition, direction, moonPhase, moonDirection, seasonFor, skyFrame, MONTHS } from './sky-clock.js';

const STEP = 1 / 60;
const MAX_PIXELS = 16e6;

const canvas = document.querySelector('#scene');
const errorBox = document.querySelector('#error');
const host = window.wallpaperHost;
const inApp = Boolean(host);
document.documentElement.classList.toggle('in-app', inApp);

const params = new URLSearchParams(location.search);
const screenIndex = Math.max(0, Number.parseInt(params.get('screen') || '0', 10) || 0);
// Obrázek z minula, dokud se scéna nepřipraví (jen v tapetě, ne v náhledu s parametry).
// Verze v klíči: po opravě chyby obrazu se staré (možná rozbité) snímky nepoužijí.
const snapshotCache = createSnapshotCache(`v2-obrazovka-${screenIndex}-${innerWidth}x${innerHeight}`);
const cacheAllowed = [...params.keys()].every((k) => k === 'screen');

function randomGenerator(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let n = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

function showError(error) {
  console.error(error);
  errorBox.textContent = `Scénu se nepodařilo spustit: ${error?.message || error}`;
  errorBox.hidden = false;
}

const gl = canvas.getContext('webgl2', {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'low-power',
});
if (!gl) {
  showError(new Error('prohlížeč nepodporuje WebGL2'));
  throw new Error('WebGL2 není k dispozici');
}
if (!gl.getExtension('EXT_color_buffer_float')) {
  showError(new Error('grafická karta neumí kreslit do float textur (EXT_color_buffer_float)'));
  throw new Error('EXT_color_buffer_float chybí');
}

// Kreslí-li prohlížeč procesorem místo grafické karty, poběží scéna ve snížené kvalitě.
const gpu = rendererInfo(gl);
if (gpu.software) {
  console.warn(`Prohlížeč kreslí bez grafické karty (${gpu.name}), scéna běží ve snížené kvalitě.`);
  if (!inApp) showSoftwareNotice(gpu.name);
}
const renderScale = gpu.software ? 0.5 : Math.min(1, Math.max(0.25, config.rozliseni || 1));
const fpsCap = gpu.software ? Math.min(30, config.fps) : config.fps;

const seed = (config.seed + screenIndex * 7919) >>> 0;
const random = randomGenerator(seed ^ 0x2c1b3c6d);
// Skutečný terén Gosausee a Dachsteinu (viz tools/terrain.mjs).
let heightMap;
try {
  heightMap = await loadHeightMap(gl, new URL('../assets', import.meta.url).href);
} catch (error) {
  showError(new Error(`chybí výšková mapa terénu (scenes/alpy/assets): ${error.message}`));
  throw error;
}
// Všechny shadery se překládají najednou na pozadí (grafický proces), stránka mezitím
// odpovídá a ukazuje obrázek z minula. Synchronní překlad by ji zablokoval i na 20 s.
const [terrain, display, boats, trees, boulders, particles, stars] = await Promise.all([
  createTerrain(gl, heightMap),
  createDisplay(gl),
  createBoats(gl, { map: heightMap, random, config }),
  createTrees(gl, { map: heightMap, random: randomGenerator(seed ^ 0x7f4a7c15) }),
  createBoulders(gl, { map: heightMap }),
  createParticles(gl, { random }),
  createStars(gl, { url: new URL('../assets/hvezdy.bin', import.meta.url).href }),
]);
const birds = createBirds(gl, { config, random });
console.warn(`Překlad shaderů terénu: ${createTerrain.compileMs} ms`);
console.warn('Překlad programů (ms): ' + compileTimes.map(([l, ms, how]) => `${l} ${ms} ${how}`).join(', '));

const state = {
  view: [1, 1],
  dpr: 1,
  pixels: [1, 1],
  time: 0,
  accumulator: 0,
  hostRate: inApp ? 0 : 60,
  battery: false,
  paused: false,
  frames: 0,
  doneAt: null,
  gust: 0,
  nextGust: config.vitr.kazdych * (0.6 + random()),
  cloudShift: [random() * 10, random() * 10],
  snowfall: 0,
  snowUntil: -1,
  // Počasí po plynulém přechodu (skutečné z Open-Meteo, nebo vymyšlené podle období).
  wx: null,
  // Blesk: čas výboje, body kanálu, další výboj.
  strikeAt: -100,
  // Padající hvězda: kdy začala, pořadí, kdy přiletí další.
  meteorAt: -100,
  meteorSeed: 0,
  nextMeteor: 20,
  bolt: new Float32Array(24),
  nextStrike: 3,
  stormUntil: -1,
  seasonKey: '',
  shadowLight: null,
};
let world = null;

// ---- Čas: skutečný, pevná hodina, zvolený měsíc, nebo přehrávání celého dne ----

// Parametry adresy pro náhled: ?hodina=13.5&mesic=10&den=17&akce=ptaci (akce oddělené čárkou;
// den v měsíci jen s parametrem mesic, bez něj 15.).
const urlHour = params.has('hodina') ? Number(params.get('hodina')) : null;
const urlMonth = params.has('mesic') ? Number(params.get('mesic')) : null;
const urlDay = params.has('den') ? Math.min(31, Math.max(1, Math.round(Number(params.get('den'))) || 15)) : 15;
const clock = {
  hour: Number.isFinite(urlHour) ? urlHour : config.cas.rezim === 'pevny' ? config.cas.hodina : null,
  month: Number.isFinite(urlMonth) ? Math.min(12, Math.max(1, urlMonth))
    : config.cas.mesic === 'skutecny' ? null : Math.min(12, Math.max(1, Number(config.cas.mesic) || 1)),
  play: null,   // { from: Date, start: čas scény }
  speed: 1,     // zrychlení času (jen náhled): 1 = skutečný čas
  anchor: null, // { real, virtual } pro zrychlený čas
};

function currentDate() {
  if (clock.play) {
    const progress = (state.time - clock.play.start) / Math.max(10, config.cas.prehratDenZa);
    if (progress >= 1) clock.play = null;
    else return new Date(clock.play.from.getTime() + progress * 86400000);
  }
  let date = new Date();
  if (clock.speed !== 1 && clock.anchor) {
    date = new Date(clock.anchor.virtual + (Date.now() - clock.anchor.real) * clock.speed);
    if (clock.month !== null) date.setMonth(clock.month - 1, urlDay);
    return date;
  }
  if (clock.month !== null) date.setMonth(clock.month - 1, urlDay);
  if (clock.hour !== null) date.setHours(Math.floor(clock.hour), Math.round((clock.hour % 1) * 60), 0, 0);
  return date;
}

function sky(date) {
  const sun = solarPosition(date, config.cas.sirka, config.cas.delka);
  return {
    date,
    sun: direction(sun.elevation, sun.azimuth),
    sunElevation: sun.elevation,
    moon: moonDirection(date),
    moonPhase: moonPhase(date),
    season: seasonFor(date),
  };
}

// Expozice podle výšky slunce: v noci víc, aby krajina nebyla úplně černá.
function exposureFor(s) {
  const points = [[-0.25, 6.0], [-0.12, 3.4], [-0.04, 1.9], [0.0, 1.25], [0.06, 1.0], [0.2, 0.74], [1.0, 0.66]];
  if (s <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (s <= points[i][0]) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      return y0 + ((s - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

const pointer = { present: false, x: 0, y: 0 };
const parallax = [0, 0];   // krajina se s kurzorem nehýbe (posun zůstává nulový)

canvas.addEventListener('pointermove', (event) => {
  pointer.x = event.clientX;
  pointer.y = state.view[1] - event.clientY;
  pointer.present = true;
});
canvas.addEventListener('pointerleave', () => { pointer.present = false; });

function shadowLight(now) {
  if (!config.stiny) return [0, -1, 0];
  return now.sun[1] > -0.03 ? now.sun : now.moon;
}

function build() {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  let dpr = (window.devicePixelRatio || 1) * renderScale;
  // Strop pro velké monitory: víc pixelů než config.megapixely se kreslí zmenšeně a obraz se
  // roztáhne (krajina je měkká, rozdíl je malý, grafika má o polovinu méně práce).
  const budget = Math.min(MAX_PIXELS, (Number(config.megapixely) || 2.5) * 1e6);
  dpr = Math.min(dpr, Math.sqrt(budget / (width * height)));
  state.view = [width, height];
  state.dpr = dpr;
  state.pixels = [Math.max(1, Math.round(width * dpr)), Math.max(1, Math.round(height * dpr))];
  canvas.width = state.pixels[0];
  canvas.height = state.pixels[1];
  const r = randomGenerator(seed);
  world = {
    width: state.pixels[0],
    height: state.pixels[1],
    aspect: width / height,
    horizon: config.obzor,
    span: 2 * Math.tan((config.zornyUhel * Math.PI) / 360),
    mirror: config.ikony === 'vpravo',
    seed: [r() * 40 - 20, r() * 40 - 20],
    samples: gpu.software ? 1 : config.kvalita,
  };
  const now = sky(currentDate());
  terrain.start(world, now.season, shadowLight(now));
  trees.plant(world);
  state.seasonKey = seasonKey(now.season);
  state.shadowLight = null;
  state.doneAt = null;
  birds.setView(width, height);
}

function seasonKey(season) {
  return [season.snowLine, season.winter, season.autumn, season.spring].map((v) => v.toFixed(2)).join(',');
}

// Sněží v zimě jen občas: okna po dvaceti minutách, v každém se rozhodne náhodně.
// Skutečné počasí v Gosau (config.pocasi = 'skutecne'); jen když scéna ukazuje
// skutečný okamžik, ne pevnou hodinu, jiný měsíc nebo přehrávání dne.
// Náhled: ?pocasi=nizka:80,stredni:90,vysoka:20,vitr:12,smer:270,naraz:20,srazky:2,snih:0,
// teplota:10,kod:95,viditelnost:5000 nasimuluje počasí (nic se nestahuje).
function weatherFromUrl(text) {
  if (!text) return null;
  const v = {};
  for (const part of text.split(',')) {
    const [key, value] = part.split(':');
    if (key && Number.isFinite(Number(value))) v[key.trim()] = Number(value);
  }
  const pct = (x) => Math.min(1, Math.max(0, (x ?? 0) / 100));
  const low = pct(v.nizka ?? v.oblacnost), mid = pct(v.stredni), high = pct(v.vysoka);
  const wind = v.vitr ?? 2;
  return {
    time: 'náhled', temperature: v.teplota ?? 10, precipitation: v.srazky ?? 0,
    rain: (v.teplota ?? 10) > 1.5 ? v.srazky ?? 0 : 0, snowfall: v.snih ?? 0, code: v.kod ?? 0,
    cover: Math.max(low, mid, high), low, mid, high, visibility: v.viditelnost ?? 30000,
    wind, direction: v.smer ?? 250, gusts: v.naraz ?? wind * 1.5,
  };
}
const weather = createWeather({
  latitude: config.cas.sirka, longitude: config.cas.delka, enabled: config.pocasi === 'skutecne',
  override: weatherFromUrl(params.get('pocasi')),
});
const showsNow = () => weather.simulated || (!clock.play && clock.hour === null && clock.month === null && clock.speed === 1);

function weatherTarget(now) {
  const w = showsNow() ? weather.current : null;
  if (!w) {
    const invented = Math.min(1, Math.max(0, config.mraky.pokryti + (now.season.cloudiness - 0.45)));
    return { real: 0, low: invented, mid: 0, high: invented, wind: 3, direction: 250, gustiness: 0,
      snow: snowWanted(now), mist: 1, overcast: 0, rain: 0, storm: 0 };
  }
  const cold = w.temperature < 1.5;
  const falling = w.snowfall > 0 || (cold && w.precipitation > 0);
  const fog = w.code === 45 || w.code === 48 ? 1 : 0;
  const wet = !cold && (w.rain > 0 || (w.precipitation > 0 && w.snowfall === 0));
  const rain = wet ? Math.min(1, 0.25 + Math.max(w.rain, w.precipitation) * 0.35) : 0;
  const storm = w.code >= 95 ? 1 : 0;
  // Souvislá vrstva: střední oblačnost, a když je nízká skoro všude, také ona; při srážkách
  // je nebe vždy zatažené.
  const overcast = Math.max(Math.min(1, w.mid * 0.95 + Math.max(0, w.low - 0.75) * 2.4),
    rain > 0 || falling ? 0.75 : 0, storm * 0.85);
  return {
    overcast, rain, storm,
    real: 1, low: w.low, mid: w.mid, high: w.high, wind: w.wind, direction: w.direction,
    gustiness: Math.min(0.7, Math.max(0, (w.gusts - 6) / 14)),
    snow: state.time < state.snowUntil ? 1 : falling ? Math.min(1, 0.35 + w.snowfall * 0.9 + w.precipitation * 0.3) : 0,
    mist: 0.6 + 1.6 * fog + 1.2 * (1 - Math.min(1, w.visibility / 20000)) + rain * 0.8,
  };
}

// Nový kanál blesku: z mraku nad obrazovkou klikatě dolů k hřebenům, s jednou větví.
function strike() {
  state.strikeAt = state.time;
  let x = 0.2 + random() * 0.6, y = 1.02;
  const bottom = config.obzor + 0.04 + random() * 0.12;
  const drift = (random() - 0.5) * 0.25;
  for (let i = 0; i <= 10; i++) {
    state.bolt[i * 2] = x;
    state.bolt[i * 2 + 1] = y;
    y -= (1.02 - bottom) / 10;
    x += drift / 10 + (random() - 0.5) * 0.07;
  }
  // Větev z pátého bodu šikmo stranou.
  state.bolt[22] = state.bolt[8] + (random() < 0.5 ? -1 : 1) * (0.02 + random() * 0.04);
  state.bolt[23] = state.bolt[9] - 0.04 - random() * 0.07;
}

// Jas záblesku v čase po výboji: hlavní záblesk a dva slabší dozvuky.
function flashAt(t) {
  if (t < 0 || t > 1.2) return 0;
  const pulse = (at, width, power) => (t >= at ? power * Math.exp(-(t - at) / width) : 0);
  return Math.min(1, pulse(0, 0.07, 1) + pulse(0.16, 0.06, 0.6) + pulse(0.42, 0.1, 0.45));
}

function snowWanted(now) {
  if (state.time < state.snowUntil) return 1;
  const slot = Math.floor(now.date.getTime() / 1200000);
  const chance = randomGenerator(slot ^ 0x51ed27)();
  return now.season.winter > 0.5 && chance < config.snezeni ? 0.8 : 0;
}

let current = null;

function simulate(dt) {
  state.time += dt;
  state.nextGust -= dt;
  if (state.nextGust <= 0) {
    state.gust = 1;
    // Silný poryv ve dne občas vyplaší kavky z lesa.
    if (current.sun[1] > 0.05 && random() < 0.4) birds.takeoff();
    state.nextGust = -Math.log(1 - random() * 0.999) * config.vitr.kazdych + 20;
  }
  state.gust *= Math.exp(-dt / 5);
  weather.tick();
  const target = weatherTarget(current);
  // První skutečné údaje hned po startu platí rovnou (bez přechodu z vymyšleného počasí).
  if (!state.wx || (target.real && state.wx.real < 0.01 && state.time < 20)) state.wx = { ...target };
  const blend = 1 - Math.exp(-dt / 40);
  for (const key of Object.keys(target)) {
    if (key === 'direction') {
      // Směr větru po kratší cestě kolem kruhu.
      const turn = ((target.direction - state.wx.direction + 540) % 360) - 180;
      state.wx.direction = (state.wx.direction + turn * blend + 360) % 360;
    } else state.wx[key] += (target[key] - state.wx[key]) * blend;
  }
  // Silný vítr drží stromy v pohybu i mezi poryvy.
  state.gust = Math.max(state.gust, state.wx.gustiness);
  // Mraky táhnou po větru (směr odkud fouká + 180°), rychleji při silném větru.
  const wind = config.mraky.rychlost * 0.0012 * (0.4 + state.wx.wind / 5) * (1 + state.gust * 3);
  const toward = (state.wx.direction + 180) * Math.PI / 180;
  state.cloudShift[0] -= Math.sin(toward) * wind * dt;
  state.cloudShift[1] -= Math.cos(toward) * wind * dt;
  const snow = state.wx.snow;
  // Padající hvězdy za jasné noci: průměrně jednou za půldruhé minuty.
  state.nextMeteor -= dt;
  if (state.nextMeteor <= 0) {
    state.meteorAt = state.time;
    state.meteorSeed = (state.meteorSeed + 1) % 997;
    state.nextMeteor = 30 + random() * 120;
  }
  // Bouřka: výboje v náhodných odstupech, každý dva až tři záblesky za sebou.
  state.nextStrike -= dt;
  if (state.nextStrike <= 0 && (state.wx.storm > 0.5 || state.time < state.stormUntil)) {
    strike();
    state.nextStrike = 5 + random() * 20;
  }
  // Mimo zimu sněžení doběhne rychle (třeba po přepnutí měsíce v náhledu).
  const tau = snow === 0 && current.season.winter < 0.5 && state.time >= state.snowUntil ? 1 : 6;
  state.snowfall += (snow - state.snowfall) * (1 - Math.exp(-dt / tau));

  // Světlušky: červen a červenec, za tmy (slunce pod obzorem), jen za jasna a bez deště.
  const month = current.date.getMonth() + 1;
  const firefly = (month === 6 || month === 7) && current.sun[1] < -0.04 ? (1 - state.wx.rain) * (1 - 0.7 * state.wx.overcast) : 0;
  particles.step(dt, trees.sources, current.season, state.gust, firefly, trees.meadows);
  boats.step(dt, current.sun, current.season.ice, state.wx ? state.wx.rain + state.wx.storm : 0);

  // Ptáci létají jen ve dne.
  // Soumrak (slunce nízko na západě): kavky letí na nocoviště do lesa.
  const dusk = current.sun[1] < 0.15 && current.sun[0] < 0;
  birds.step(dt, pointer, current.sun[1] > 0.02, dusk, current.sun[1] < -0.12);

  // Krajina se s kurzorem nehýbe; na kurzor reagují jen ptáci.
}

function angleBetween(a, b) {
  return Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
}

function render() {
  // Roční období se změnilo (nový měsíc nebo posuvník): přepočítat materiál.
  const key = seasonKey(current.season);
  if (key !== state.seasonKey) {
    state.seasonKey = key;
    terrain.setSeason(current.season);
  }
  // Stíny: přepočítat, když se světlo pohnulo o víc než třetinu stupně.
  const light = shadowLight(current);
  if (terrain.materialDone && !terrain.busy && config.stiny) {
    const moved = !state.shadowLight || angleBetween(light, state.shadowLight) > 0.35;
    if (moved && terrain.requestShadows(light)) state.shadowLight = [...light];
  }
  terrain.work(light, state.time);
  if (terrain.materialDone && state.doneAt === null) state.doneAt = state.time;

  const fullWeight = state.doneAt === null ? 0 : Math.min(1, (state.time - state.doneAt) / 0.8 + 0.001);
  // Mezi kroky simulace se kreslí plynule: čas i ptáci se dopočítají podle zbytku kroku.
  const blend = Math.min(1, state.accumulator / STEP);
  const time = state.time + state.accumulator;
  if (!state.wx) state.wx = { ...weatherTarget(current) };
  const s = current.sun[1];
  const east = current.sun[0] > 0 ? 1 : 0.3;
  const dawn = Math.exp(-(((current.sunElevation - 3) / 7) ** 2)) * east;
  display.draw({
    terrain, fullWeight, world, pixels: state.pixels, time, parallax,
    shadows: terrain.shadowState(state.time),
    exposure: config.jas * exposureFor(s), contrast: config.kontrast,
    cover: Math.min(1, state.wx.low * 0.95 + state.wx.mid * 0.35 + state.snowfall * 0.5),
    cirrus: state.wx.high,
    cloudShift: state.cloudShift, gust: state.gust,
    ripple: config.jezero.vlnky * Math.min(2.5, Math.max(0.2, 0.25 + state.wx.wind / 4)),
    // Mlha hlavně ráno a večer, v poledne se rozpustí.
    mist: config.mlha * state.wx.mist * (current.season.mist / 0.45) * (1 - 0.8 * Math.min(1, Math.max(0, (s - 0.05) / 0.3)) + 1.3 * dawn),
    ice: current.season.ice, snowfall: state.snowfall,
    overcast: state.wx.overcast, rain: state.wx.rain * (current.season.ice > 0.7 ? 0 : 1),
    hour: current.date.getHours() + current.date.getMinutes() / 60,
    // Vlhko pro cáry mraků na svazích: déšť a krátce po něm, zataženo, podzimní ráno.
    humid: Math.min(1, Math.max(state.wx.rain * 1.2, state.wx.overcast * 0.6,
      current.season.autumn * Math.max(0, 1 - Math.abs(current.date.getHours() + current.date.getMinutes() / 60 - 8) / 3) * (1 - state.wx.high * 0.3)) * (current.season.ice > 0.7 ? 0.3 : 1)),
    meteor: { seed: state.meteorSeed, age: time - state.meteorAt },
    flash: flashAt(time - state.strikeAt) * (0.5 + 0.5 * (1 - Math.max(0, current.sun[1]) * 2)),
    bolt: state.bolt, boltAlpha: flashAt(time - state.strikeAt) > 0.05 ? Math.min(1, flashAt(time - state.strikeAt) * 1.5) : 0,
    sun: current.sun, moon: current.moon, moonPhase: current.moonPhase,
    wakes: boats.wakes(),
    trees, season: current.season,
    stars, boulders, particles, date: current.date, sky: skyFrame(current.date, config.cas.sirka, config.cas.delka),
    map: heightMap,
  });
  // Odrazy blízkých stromů a rákosí (vzdálenější odraz už je v obrazu vody), pak balvanů.
  if (fullWeight >= 1) {
    trees.drawReflection({
      world, pixels: state.pixels, time, gust: state.gust, sun: current.sun, moon: current.moon,
      moonPhase: current.moonPhase, overcast: state.wx.overcast, season: current.season,
      exposure: config.jas * exposureFor(s), contrast: config.kontrast,
      shadow: terrain.shadowState(state.time).to, depth: terrain.full.albedo, scene: display.sceneTexture,
    });
  }
  boulders.drawReflection({
    world, pixels: state.pixels, time, sun: current.sun, moon: current.moon, moonPhase: current.moonPhase,
    overcast: state.wx.overcast, flash: 0, exposure: config.jas * exposureFor(s), contrast: config.kontrast,
    season: current.season, ice: current.season.ice, shadow: terrain.shadowState(state.time).to,
    scene: display.sceneTexture,
    rain: state.wx.rain * (current.season.ice > 0.7 ? 0 : 1),
  });
  boats.draw({
    world, pixels: state.pixels, exposure: config.jas * exposureFor(s), contrast: config.kontrast,
    sun: current.sun, moon: current.moon, moonPhase: current.moonPhase, time,
    shadow: terrain.shadowState(state.time).to,
    overcast: state.wx.overcast, flash: flashAt(time - state.strikeAt) * 0.6,
  });
  birds.draw({ dpr: state.dpr, blend });
  state.frames++;
  // Hotová scéna: obrázek z minula zmizí a jednou za čas se uloží nový.
  // Hotová scéna (nebo nejpozději po minutě): obrázek z minula zmizí. Nový se uloží
  // jednou za čas, jen když je krajina dopočítaná i se stíny.
  if (fullWeight >= 1 || state.time > 60) snapshotCache.hide();
  if (fullWeight >= 1 && !terrain.busy && !trees.planting && cacheAllowed && state.time - state.doneAt > 20) snapshotCache.maybeSave(canvas, state.time);
  if (state.frames === 1) document.documentElement.dataset.ready = 'true';
}

function frame(dt) {
  trees.pump(6);
  current = sky(currentDate());
  state.accumulator += dt;
  let steps = 0;
  while (state.accumulator >= STEP && steps < 8) {
    simulate(STEP);
    state.accumulator -= STEP;
    steps++;
  }
  if (steps === 8) state.accumulator = 0;
  render();
  updateReadout();
}

const loop = createFrameLoop((dt) => frame(dt), { fps: fpsCap });

function applyRate() {
  const cap = Math.min(fpsCap, state.battery ? config.fpsNaBaterii : config.fps);
  loop.setRate(Math.min(cap, state.hostRate));
  loop.setPaused(state.paused);
}

const actions = {
  ptaci: () => birds.flock(),
  // Jen pro náhled z adresy (?akce=kavky): hejno kavek na nocoviště.
  kavky: () => birds.roost(),
  // Jen pro náhled (?akce=listi): podzimní poryv, aby bylo listí vidět hned.
  listi: () => { state.gust = 1; },
  // Jen pro náhled (?akce=boure): minuta bouřky s blesky.
  boure: () => { state.stormUntil = state.time + 60; state.nextStrike = 0.5; },
  vitr: () => { state.gust = 1; if (current && current.sun[1] > 0.05) birds.takeoff(); },
  // Celý den od půlnoci za pár minut, pak zpátky ke skutečnému času.
  den: () => {
    const from = currentDate();
    from.setHours(0, 0, 0, 0);
    clock.play = { from, start: state.time };
  },
  sneh: () => { state.snowUntil = state.time + 90; },
};

// ---- Ovládání náhledu: tlačítka a posuvníky hodiny a měsíce ----

let readout = () => {};
function updateReadout() { readout(); }

function slider(label, min, max, stepSize, value, onInput) {
  const wrap = document.createElement('label');
  const input = document.createElement('input');
  const output = document.createElement('output');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = stepSize;
  input.value = value;
  input.addEventListener('input', () => onInput(Number(input.value)));
  wrap.append(label, input, output);
  return { wrap, input, output };
}

try {
  build();
  current = sky(currentDate());
} catch (error) {
  showError(error);
  throw error;
}

if (inApp) {
  host.on('rate', (rate) => {
    state.hostRate = Number(rate) || 0;
    if (state.hostRate === 0) pointer.present = false;
    applyRate();
  });
  host.on('power', (onBattery) => {
    state.battery = Boolean(onBattery);
    applyRate();
  });
  host.on('action', (id) => {
    actions[id]?.();
    loop.invalidate();
  });
} else {
  const start = currentDate();
  const hour = slider('Hodina', 0, 23.9, 0.1, start.getHours() + start.getMinutes() / 60, (v) => {
    clock.hour = v;
    clock.play = null;
    if (clock.speed !== 1) {
      const d = new Date(currentDate());
      d.setHours(Math.floor(v), Math.round((v % 1) * 60), 0, 0);
      clock.anchor = { real: Date.now(), virtual: d.getTime() };
    }
    loop.invalidate();
  });
  const month = slider('Měsíc', 1, 12, 1, start.getMonth() + 1, (v) => {
    clock.month = v;
    loop.invalidate();
  });
  // Panel Nastavení: posuvníky mění nastavení scény za běhu (jen v náhledu, neukládá se;
  // trvale se nastavuje v config.js).
  const settings = document.createElement('details');
  settings.id = 'settings';
  const summary = document.createElement('summary');
  summary.textContent = 'Nastavení';
  settings.append(summary);
  const grid = document.createElement('div');
  settings.append(grid);
  const format = (v, digits) => Number(v).toFixed(digits).replace('.', ',');
  const rows = [];
  const setting = (label, min, max, stepSize, get, set, digits = 2, unit = '') => {
    const row = slider(label, min, max, stepSize, get(), (v) => {
      set(v);
      row.output.value = format(v, digits) + unit;
      loop.invalidate();
    });
    row.output.value = format(get(), digits) + unit;
    grid.append(row.wrap);
    rows.push(row);
    return row;
  };
  setting('Mraky', 0, 1, 0.01, () => config.mraky.pokryti, (v) => { config.mraky.pokryti = v; });
  setting('Vítr v mracích', 0, 4, 0.1, () => config.mraky.rychlost, (v) => { config.mraky.rychlost = v; }, 1, '×');
  setting('Mlha', 0, 1.5, 0.01, () => config.mlha, (v) => { config.mlha = v; });
  setting('Vlnky na jezeře', 0, 1.5, 0.01, () => config.jezero.vlnky, (v) => { config.jezero.vlnky = v; });
  setting('Jas', 0.4, 2, 0.01, () => config.jas, (v) => { config.jas = v; });
  setting('Kontrast', 0.8, 1.6, 0.01, () => config.kontrast, (v) => { config.kontrast = v; });
  const speed = setting('Zrychlení času', 0, 3, 0.01, () => 0, (v) => {
    // Posuvník je logaritmický: 0 = skutečný čas, 3 = 1000× rychleji (den za 1,5 minuty).
    const factor = Math.round(10 ** v);
    const now = currentDate().getTime();
    clock.speed = factor;
    clock.hour = null;
    clock.anchor = factor === 1 ? null : { real: Date.now(), virtual: now };
    speed.output.value = factor === 1 ? 'skutečný' : `${factor}×`;
  });
  speed.output.value = 'skutečný';
  const shadowWrap = document.createElement('label');
  const shadowBox = document.createElement('input');
  shadowBox.type = 'checkbox';
  shadowBox.checked = config.stiny;
  shadowBox.addEventListener('change', () => {
    config.stiny = shadowBox.checked;
    state.shadowLight = null;
    loop.invalidate();
  });
  shadowWrap.append(shadowBox, ' Stíny hor');
  grid.append(shadowWrap);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Výchozí hodnoty';
  reset.addEventListener('click', () => location.reload());
  grid.append(reset);

  readout = () => {
    const d = current.date;
    hour.output.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    month.output.value = MONTHS[d.getMonth()];
    if (clock.play || clock.speed !== 1) hour.input.value = d.getHours() + d.getMinutes() / 60;
  };
  setupControls({
    buttons: [
      { label: 'Hejno ptáků', key: 'P', action: actions.ptaci },
      { label: 'Poryv větru', key: 'V', action: actions.vitr },
      { label: 'Přehrát den', key: 'D', action: actions.den },
      { label: 'Sněžení', key: 'S', action: actions.sneh },
    ],
    extras: [hour.wrap, month.wrap, settings],
    onPause: (paused) => { state.paused = paused; applyRate(); },
  });
}
applyRate();
for (const id of (params.get('akce') || '').split(',').filter(Boolean)) actions[id]?.();

document.addEventListener('visibilitychange', () => loop.setHidden(document.hidden));
loop.setHidden(document.hidden);

let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    try {
      build();
      loop.invalidate();
    } catch (error) {
      showError(error);
    }
  }, 250);
});

// Ztráta WebGL (třeba když hra nebo ovladač restartuje grafiku): počkat na obnovení,
// a když nepřijde do 5 s, načíst stránku znovu.
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  loop.dispose();
  setTimeout(() => location.reload(), 5000);
});
canvas.addEventListener('webglcontextrestored', () => location.reload());

// Pro testy a ladění.
window.alpy = {
  ...actions,
  loop,
  clock,
  set rayBudget(value) { terrain.rayBudget = value; },
  // Měření: kolik ms stojí jeden snímek včetně práce grafiky (pro ladění výkonu).
  bench(count = 10) {
    // Přečtení pixelu počká, až grafika všechno dokreslí (finish v prohlížeči nečeká).
    const pixel = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    sync();
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      frame(STEP);
      sync();
    }
    return (performance.now() - t0) / count;
  },
  // Výřez kolem hejna jako PNG (data URL), pro kontrolu formace v samotestu.
  birdShot() {
    frame(STEP);
    const f = birds.debug.formation;
    if (!f) return '';
    const w = 700, h = 360;
    const cx = Math.round(f.x * state.dpr - w / 2), cy = Math.round((state.view[1] - f.y) * state.dpr - h / 2);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(canvas, cx, cy, w, h, 0, 0, w, h);
    return out.toDataURL('image/png');
  },
  // Počasí: skutečné údaje z Open-Meteo (nebo null) a hodnoty, které scéna právě používá.
  get weather() { return { data: weather.current, used: state.wx }; },
  get stats() {
    return {
      birds: birds.count, boats: boats.list, gust: state.gust, frames: state.frames,
      time: state.time, baked: terrain.progress, view: state.view, pixels: state.pixels,
      date: current?.date.toString(), sunElevation: current?.sunElevation, snowfall: state.snowfall,
      shadowsBusy: terrain.busy, season: current?.season, gpu: gpu.name, software: gpu.software,
    };
  },
};

// Kontrola pro samotest aplikace: co musí po falešném kurzoru a akcích z menu platit.
window.sceneCheck = (phase) => {
  if (phase === 'snimky') return state.frames;
  // Krajina dopočítaná v plném rozlišení, stíny hotové a prolnuté (pro snímky testu).
  if (phase === 'hotovo') return terrain.materialDone && !terrain.busy && !trees.planting && state.doneAt !== null && state.time - state.doneAt > 1.5;
  if (phase === 'kurzor') {
    // Cena běžného snímku: měří se, až je krajina dopočítaná a stíny hotové
    // (dopočítávání na pozadí je rozložené do snímků záměrně a sem nepatří).
    const settled = terrain.materialDone && !terrain.busy;
    const ms = window.alpy.bench(10);
    console.warn(`Snímek Alp: ${ms.toFixed(1)} ms, blízkých stromů ${trees.count}, padajících listů a vloček ${particles.count}${settled ? '' : ' (krajina se ještě dopočítává)'}`);
    const result = { 'Krajina se s kurzorem nehýbe': parallax[0] === 0 && parallax[1] === 0 };
    if (settled) result['Snímek do 16 ms'] = ms < 16;
    return result;
  }
  if (phase === 'kurzor-stare') {

    return { 'Krajina se s kurzorem nehýbe': parallax[0] === 0 && parallax[1] === 0 };
  }
  if (phase === 'akce') {
    console.warn(`Po akcích: padajících listů a vloček ${particles.count}`);
    return {
      'Krajina je dopočítaná': terrain.materialDone,
      'Na jezeře plují loďky': boats.count > 0,
      'Kreslí grafická karta, ne procesor': !gpu.software,
      'Hejno ptáků letí (nebo je noc)': birds.count > 0 || current.sun[1] <= 0.02,
      'Fouká vítr': state.gust > 0.1,
      'Přehrává se den': clock.play !== null,
      'Sněží': state.snowUntil > state.time,
    };
  }
  return {};
};
