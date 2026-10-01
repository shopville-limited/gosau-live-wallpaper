// Krajina: výškové pole s erozí, spočítané raymarchingem jednou do G-bufferu.
//
// Světlo se do textur nepeče, aby se mohlo měnit s denní dobou. Uloží se jen materiál:
//   albedo  (RGBA16F): barva povrchu, v alfě vzdálenost (+100 × paprsky do oblohy),
//                      záporná = hladina jezera, 1000 = obloha,
//   normála (RGBA16F): xyz normála s detailem korun a skal, w = podíl lesa,
//   extra   (RGBA8):   r = zastínění okolím (AO), g = okna vesnice, b = sníh.
// Materiál závisí na ročním období (sněžná čára, barvy lesa), při změně měsíce se přepočítá.
// Nejdřív se rychle spočítá náhled ve čtvrtinovém rozlišení, plné rozlišení se dopočítává
// po pruzích během dalších snímků, aby slabý stroj nezamrzl.
//
// Stíny se počítají zvlášť pro aktuální směr slunce (v noci měsíce), taky po pruzích.

import { FULLSCREEN_VS, createProgramAsync, createTarget } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA } from './world.js';
import { TREE_NEAR } from './trees.js';
import { boulderList as boulders3d } from './boulders.js';

// Tvar terénu, sdílený výpočtem materiálu a stínů. Velký tvar je skutečný terén kolem
// Gosausee a Dachsteinu (výšková mapa po 25 m, viz tools/terrain.mjs), drobný detail
// do něj přidá šum: data mají jen 25 m, skály by bez něj byly hladké.
const TERRAIN = /* glsl */ `
uniform sampler2D uHeightMap;   // výška v km nad hladinou jezera
uniform vec4 uMapRect;          // levý okraj, bližší okraj, šířka, hloubka mapy (km)
uniform vec2 uMapSize;          // počet bodů mapy
uniform vec2 uGlacier;          // Gosauský ledovec (km)
uniform vec2 uHut;              // Adamekhütte: jediné okno, které v noci svítí (km)
uniform sampler2D uBoulderMap;  // balvany v popředí (km nad hladinou, -1 = nic)
uniform sampler2D uForestMap;   // hustota lesa 0..1 (pravidla v tools/terrain.mjs)
uniform float uTreeNear;        // blíž než tohle kreslí stromy trees.js, ne výšková mapa
uniform sampler2D uDetailMap;   // okolí jezera po 5 m
uniform vec4 uDetailRect;
uniform vec2 uDetailSize;

const mat2 TURN = mat2(0.8, -0.6, 0.6, 0.8);

float bump(vec2 p, vec2 center, vec2 size) {
  vec2 q = (p - center) / size;
  return exp(-dot(q, q));
}

float glacierAt(vec2 p) { return bump(p, uGlacier, vec2(1.7, 1.1)); }

// Bikubický B-spline ze čtyř bilineárních čtení: hladké svahy bez fazet mřížky.
float bicubic(sampler2D map, vec2 p, vec4 rect, vec2 size) {
  vec2 st = (p - rect.xy) / rect.zw * size - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / size;
  vec2 h1 = (i + 1.5 + w3 / g1) / size;
  float a = texture(map, vec2(h0.x, h0.y)).r;
  float b = texture(map, vec2(h1.x, h0.y)).r;
  float c = texture(map, vec2(h0.x, h1.y)).r;
  float d = texture(map, vec2(h1.x, h1.y)).r;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

// Blízko jezera jemná mapa po 5 m, dál hrubá po 25 m, na okraji plynulý přechod.
float mapHeight(vec2 p) {
  vec2 local = (p - uDetailRect.xy) / uDetailRect.zw;
  vec2 edge = min(local, 1.0 - local) * uDetailRect.zw;
  float inside = smoothstep(0.0, 0.25, min(edge.x, edge.y));
  if (inside >= 1.0) return bicubic(uDetailMap, p, uDetailRect, uDetailSize);
  float coarse = bicubic(uHeightMap, p, uMapRect, uMapSize);
  if (inside <= 0.0) return coarse;
  return mix(coarse, bicubic(uDetailMap, p, uDetailRect, uDetailSize), inside);
}

float forestAt(vec2 p) {
  return texture(uForestMap, (p - uMapRect.xy) / uMapRect.zw).r;
}

// Hustota lesa s roztřepeným okrajem: maska (25 m) by dala ostrou hranu proti skále,
// šum ve dvou měřítkách (~60 m a ~15 m) z ní udělá jazyky, skupinky a osamělé stromy.
float forestDensity(vec2 p) {
  float f = forestAt(p);
  float edge = 1.0 - abs(f - 0.33) / 0.33;          // jen kolem okraje
  f += max(edge, 0.0) * (0.22 * gnoise(p * 16.0 + uSeed * 3.1) + 0.12 * gnoise(p * 65.0 + uSeed));
  return smoothstep(0.12, 0.55, f);
}

// Koruny stromů v buňkách asi 7 m. Vrací výšku koruny (km), vzdálenost od středu kmene
// (0 střed, 1 okraj koruny) a náhodné číslo stromu. Hustota lesa rozhoduje, kolik buněk
// má strom; nad hranicí lesa jsou stromy nižší (kosodřevina).
vec4 canopy(vec2 p, float density, float ground) {
  // Překryv s blízkými stromy (trees.js): koruny začínají od 85 % jejich dosahu.
  if (dot(p, p) < 0.7225 * uTreeNear * uTreeNear) return vec4(0.0, 1.0, 0.5, 0.0);
  vec2 q = p * 140.0;
  vec2 cell = floor(q);
  vec2 f = q - cell;
  float best = 9.0;
  vec2 id = vec2(0.0), toCenter = vec2(0.0);
  for (int j = -uOne; j <= uOne; j++) {
    for (int i = -uOne; i <= uOne; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 r = o + 0.15 + 0.7 * hash22(cell + o) - f;
      float d = dot(r, r);
      if (d < best) { best = d; id = cell + o; toCenter = r; }
    }
  }
  float pick = hash12(id + 5.3);
  // Porost není souvislý: mýtiny a řidší místa (šum v půdorysu, desítky metrů),
  // hustota zapojení kolem 70 %.
  vec2 cellCenter = (id + 0.5) / 140.0;
  float clearing = smoothstep(0.25, 0.55, gnoise(cellCenter * 16.0 + uSeed * 3.0) * 0.5 + 0.5 + 0.12);
  // Kleč nad hranicí lesa roste v souvislých skupinách a pásech, ne jako jednotlivé keře.
  float dwarfZone = smoothstep(0.66, 0.85, ground);
  float patches = smoothstep(0.52, 0.66, gnoise(cellCenter * 28.0 + uSeed * 5.0 + 3.7) * 0.5 + 0.5);
  clearing = mix(clearing, patches * 1.4, dwarfZone);
  // Řídký les roste ve skupinkách: kde je hustota nízká, rozhoduje šum shluků,
  // ne náhoda u každého stromu (jinak by svah byl posetý jednotlivými tečkami).
  float groups = gnoise(cellCenter * 55.0 + uSeed * 7.0 + 1.3) * 0.5 + 0.5;
  float grouped = smoothstep(0.35, 0.65, density + 0.6 * (groups - 0.5));
  if (pick > grouped * 0.85 * clearing) return vec4(0.0, 1.0, pick, 0.0);
  float radius = mix(0.46 + 0.22 * hash12(id + 7.3), 0.8, dwarfZone);   // kleč se rozrůstá do šířky
  // Větve nejsou kruh: v některých směrech trčí dál (nepravidelný obrys koruny).
  float angle = atan(toCenter.y, toCenter.x);
  float seedAngle = hash12(id + 9.1) * 40.0;
  float jag = 1.0 + 0.10 * sin(angle * 5.0 + seedAngle) + 0.07 * sin(angle * 11.0 + seedAngle * 1.7)
                  + 0.05 * sin(angle * 23.0 + seedAngle * 2.3);
  float along = sqrt(best) / (radius * jag);
  if (along >= 1.0) return vec4(0.0, 1.0, pick, 0.0);
  float dwarf = smoothstep(0.72, 0.95, ground);
  // Různě staré stromy: hodně středních, pár vysokých, mezi nimi mladé.
  float age = hash12(id + 1.7);
  float tall = mix(0.026, 0.005, dwarf) * (0.45 + 0.75 * age * age * (3.0 - 2.0 * age));
  // Smrk: úzký kužel s patry větví. Každé patro na konci spadne dolů (převislé větve),
  // pod ním je stín. u = výška na povrchu kužele 0 (kraj) .. 1 (špička).
  float u = pow(1.0 - along, 0.9);
  float tiers = 7.0 + floor(hash12(id + 2.9) * 5.0);
  float tierPos = u * tiers + hash12(id + 4.4);
  float tierIndex = floor(tierPos);
  // Větve: v každém patře trčí do několika stran různě daleko (hvězdicovitý obrys),
  // mezi nimi mezery. Silueta smrku je pak zubatá, ne hladký kužel.
  float branchCount = 5.0 + mod(tierIndex, 3.0);
  float branchAngle = angle * branchCount + seedAngle + tierIndex * 2.39;
  float spikes = pow(abs(sin(branchAngle)), 5.0);
  float reach = 0.8 + 0.32 * spikes + 0.08 * hash12(id + tierIndex);
  float topZone = smoothstep(0.8, 1.0, u);
  along = along / mix(reach, 1.0, topZone * 0.7);
  if (along >= 1.0) return vec4(0.0, 1.0, pick, 0.0);
  u = pow(1.0 - along, 0.9);
  tierPos = u * tiers + hash12(id + 4.4);
  float tier = fract(tierPos);
  // Konce větví převislé, pod patrem hluboký zářez.
  float droop = (1.0 - tier) * (1.0 - tier) * 0.95 / tiers;
  float top = smoothstep(0.82, 1.0, u);                 // špička bez pater
  float h = tall * max(0.0, u - droop * (1.0 - top));
  // Kleč: nízká, zakulacená (keře do sebe prorůstají), bez pater.
  float dome = tall * sqrt(max(0.0, 1.0 - along * along));
  h = mix(h, dome, dwarf);
  tier = mix(tier, 0.6 + 0.4 * (1.0 - along), dwarf);
  return vec4(h, along, pick, tier);
}

// Výška terénu v km nad hladinou jezera. Oktávy: 5 = jen data, víc = skály a stromy.
// Balvany v popředí: předpočítaná výšková mapa (JS, 25 cm), jedno čtení textury.
// Shader musí zůstat malý, height() se vkládá do desítek míst.
const vec4 BOULDER_RECT = vec4(-0.085, 0.085, 0.17, 0.06);
// Balvany jsou teď 3D tvary v boulders.js; výšková mapa balvanů zůstává prázdná.
float boulders(vec2 p) {
  return -1.0;
  vec2 uv = (p - BOULDER_RECT.xy) / BOULDER_RECT.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1.0;
  // Bikubicky: lineární čtení by mělo plošky a při pohledu naplocho pruhy.
  return bicubic(uBoulderMap, p, BOULDER_RECT, vec2(680.0, 240.0));
}

float boulderMask(vec2 p) {
  return smoothstep(-0.0015, 0.0, boulders(p));
}

float height(vec2 p, int octaves) {
  float h = max(mapHeight(p), boulders(p));
  float base = h;   // = height(p, 5); podle ní se rozhoduje o stromech i při barvení
  if (octaves > 5) {
    // Skály nad lesem: pilíře a žebra (desítky metrů) a škrapy, níž jen jemné zvlnění.
    float rocky = smoothstep(0.55, 0.95, h);
    float crags = 0.0, a = 0.5;
    vec2 q = p * 7.0 + uSeed * 2.3;
    for (int i = 0; i < 7 * uOne; i++) {
      if (i >= octaves - 4) break;
      crags += a * (1.0 - abs(gnoise(q)));
      q = TURN * q * 2.1;
      a *= 0.5;
    }
    // Výstupky slabší: velké vrhaly v nízkém slunci „leopardí“ skvrny stínů po svazích.
    // Vysoko (nad ~2200 m n. m.) je holý vápenec: výrazná žebra, hřebeny a žlaby, které
    // výšková data (25 m) vyhladí. Zde nevadí stíny, svahy jsou daleko.
    float alpine = smoothstep(1.2, 1.7, h);
    h += rocky * mix(0.02, 0.075, alpine) * (crags - 0.5) + 0.0015 * gnoise(p * 45.0 + uSeed);
    // Na okrajích lesa (u stěn a žlabů) jen řídce, ne osamělé šmouhy na skále.
    // U samé vody je štěrková pláž, stromy začínají až za ní.
    float density = forestDensity(p) * smoothstep(0.0035, 0.007, base);
    // V pásmu překryvu koruny postupně vyrůstají (blízkých stromů naopak ubývá).
    if (density > 0.0) h += canopy(p, density, base).x * smoothstep(0.85, 1.0, length(p) / uTreeNear);
  }
  return h;
}
`;

const GBUFFER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform int uSamples;      // paprsků na pixel (1–4)
uniform float uFootprint;  // úhlová velikost pixelu
// Roční období
uniform float uSnowLine;   // sněžná čára v km nad jezerem
uniform float uWinter;     // 0..1 zima: sníh na stromech, holé listnáče
uniform float uAutumn;     // 0..1 podzim: zlaté modříny, oranžové buky
uniform float uSpring;     // 0..1 jaro: svěží zeleň
uniform sampler2D uRockColor;   // vápenec (CC0, ambientCG Rock026)
uniform sampler2D uRockNormal;
uniform sampler2D uMossColor;   // mechem porostlý kámen (CC0, Rock063)
uniform sampler2D uMossNormal;
uniform vec3 uRockMean;         // průměrná barva textur (lineárně), kvůli poměru
uniform vec3 uMossMean;
uniform sampler2D uGrassColor;  // tráva (CC0, Grass004)
uniform sampler2D uFloorColor;  // lesní půda (CC0, Ground037)
uniform sampler2D uGravelColor; // oblázková pláž (CC0, Gravel041)
uniform vec3 uGrassMean;
uniform vec3 uFloorMean;
uniform vec3 uGravelMean;
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outExtra;

${NOISE}
${CAMERA}
${TERRAIN}

// Výšky ve třech bodech (střed, +x, +z) jednou smyčkou: výpočet výšky je velký a vložil
// by se do shaderu pro každé volání zvlášť.
vec3 tripleHeight(vec2 p, float eps, int octaves) {
  vec3 h = vec3(0.0);
  for (int i = 0; i < 3 * uOne; i++) {
    vec2 o = i == 1 ? vec2(eps, 0.0) : (i == 2 ? vec2(0.0, eps) : vec2(0.0));
    float v = height(p + o, octaves);
    if (i == 0) h.x = v; else if (i == 1) h.y = v; else h.z = v;
  }
  return h;
}

vec3 normalAt(vec2 p, float t) {
  float eps = max(0.00015, 0.0006 * t);
  vec3 h = tripleHeight(p, eps, 13);
  return normalize(vec3(h.x - h.y, eps, h.x - h.z));
}

float march(vec3 ro, vec3 rd) {
  float t = 0.03;
  for (int i = 0; i < 360 * uOne; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - height(p.xz, 10);
    if (h < 0.0003 * t) return t;
    if (t > 45.0) return -1.0;
    // U korun stromů (strmé kužely) jemnější krok, jinak paprsek kužel přeskočí.
    float factor = h < 0.04 && forestAt(p.xz) > 0.06 ? 0.15 : 0.42;
    t += max(factor * h, 0.0008 * t);
  }
  return t;
}

// Jemný reliéf skály: gradient fbm pro bump mapping.
vec2 rockBump(vec2 p) {
  float e = 0.0008;
  vec2 q = p * 90.0 + uSeed;
  float a = fbm(q, 4);
  return vec2(fbm(q + vec2(e * 90.0, 0.0), 4) - a, fbm(q + vec2(0.0, e * 90.0), 4) - a) / e;
}

// Textura promítnutá ze tří os podle polohy v metrech (bez natahování na stěnách).
vec3 triplanar(sampler2D t, vec3 wp, vec3 w, float scale) {
  return texture(t, wp.zy * scale).rgb * w.x + texture(t, wp.xz * scale).rgb * w.y + texture(t, wp.xy * scale).rgb * w.z;
}

// Poměr barvy textury k jejímu průměru ve dvou měřítkách (detail zblízka i skvrny zdálky):
// barevný tón dál určuje scéna, textura dodá kresbu skutečné horniny.
// fp: velikost pixelu v kilometrech (v měřítku wp). Zdálky by se jemná kresba (13 m)
// opakovala jako pravidelné tečky, proto přejde do hrubého měřítka se slabším kontrastem.
vec3 textureDetail(sampler2D t, vec3 mean, vec3 wp, vec3 w, float fp) {
  vec3 far = pow(triplanar(t, wp + 311.0, w, 1.0 / 97.0), vec3(2.2)) / mean;
  float nearW = 1.0 - smoothstep(0.00006, 0.0004, fp);
  vec3 farOnly = mix(vec3(1.0), far, 0.45 - 0.25 * smoothstep(0.001, 0.004, fp));
  if (nearW <= 0.0) return farOnly;
  vec3 near = pow(triplanar(t, wp, w, 1.0 / 13.0), vec3(2.2)) / mean;
  return mix(farOnly, near * mix(vec3(1.0), far, 0.15), nearW);
}

// Reliéf z normálové mapy, triplanárně.
vec3 textureBump(sampler2D t, vec3 wp, vec3 w) {
  vec3 x = texture(t, wp.zy / 13.0).xyz * 2.0 - 1.0;
  vec3 y = texture(t, wp.xz / 13.0).xyz * 2.0 - 1.0;
  vec3 z = texture(t, wp.xy / 13.0).xyz * 2.0 - 1.0;
  return vec3(0.0, x.y, x.x) * w.x + vec3(y.x, 0.0, y.y) * w.y + vec3(z.x, z.y, 0.0) * w.z;
}

// Stejný hodnotový šum jako vnoise() v trees.js: skupinky stromů ve strmých svazích
// a lesní půda pod nimi se tak kryjí.
float hashJ(vec2 i) { return fract(sin(i.x * 127.1 + i.y * 311.7) * 43758.5453); }
float vnoiseJ(vec2 x) {
  vec2 i = floor(x), f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hashJ(i), b = hashJ(i + vec2(1.0, 0.0)), c = hashJ(i + vec2(0.0, 1.0)), d = hashJ(i + vec2(1.0, 1.0));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}

struct Surface {
  vec3 albedo;
  vec3 normal;
  float forest;
  float occlusion;
  float lights;
  float snow;
};

Surface surfaceAt(vec3 p, float t) {
  Surface s;
  vec3 n = normalAt(p.xz, t);
  // Hrubá normála pro rozhodování o sněhu a lese, ať hranice nejsou tečkované.
  // Na strmých stěnách je normála z blízkých bodů plná schodů mřížky výškové mapy (5 m),
  // ve svahu z nich byly „rybí kosti“. Tam se hrubá normála měří na 6 m a nahradí jemnou;
  // drobný reliéf stěn přidává 3D detail níž. (Další volání tripleHeight by se vložilo
  // do shaderu znovu a překlad by trval desítky sekund.)
  float wallW = (1.0 - smoothstep(0.45, 0.8, n.y)) * (1.0 - smoothstep(1.5, 3.0, t));
  float eps = wallW > 0.5 ? 0.006 : max(0.02, 0.004 * t);
  vec3 hs = tripleHeight(p.xz, eps, 5);
  float hc = hs.x;
  vec3 coarse = normalize(vec3(hs.x - hs.y, eps, hs.x - hs.z));
  float slope = coarse.y;
  if (wallW > 0.5) n = normalize(mix(n, coarse, smoothstep(0.5, 1.0, wallW)));
  float alt = p.y;
  float footprint = t * uFootprint;
  // Šum ve 3D podle polohy v metrech: 2D šum by se na strmých svazích a na kmenech
  // stromů roztáhl do svislých pruhů.
  vec3 wp = p * 1000.0 + vec3(uSeed * 50.0, 0.0);
  float detail = noise3(wp * 0.009) * 0.5 + 0.5;
  float fine = noise3(wp * 0.06 + 13.0) * 0.5 + 0.5;

  // Zastínění okolím: jak vysoko se kolem zvedá terén (žlaby a údolí jsou tmavší).
  float occ = 0.0;
  for (int i = 0; i < 12 * uOne; i++) {
    float a = float(i / 2) * 1.0472;
    float r = (i % 2 == 0) ? 0.06 : 0.3;
    vec2 dir = vec2(cos(a), sin(a));
    occ += clamp((height(p.xz + dir * r, 5) - hc) / r, 0.0, 1.0) * ((i % 2 == 0) ? 1.0 : 0.7);
  }
  float occlusion = 1.0 - clamp(occ / 10.2, 0.0, 0.8);

  // Vápenec: šedobéžový, místy tmavší, s jemným reliéfem.
  float grey = noise3(wp * 0.0025 + 7.0) * 0.5 + 0.5;
  // Dachsteinský vápenec: světle šedý, zvětralý do tmavších skvrn, místy lišejníky a řasy.
  vec3 rock = mix(vec3(0.26, 0.25, 0.23), vec3(0.17, 0.17, 0.18), grey) * (0.85 + 0.25 * detail);
  // Kresba skutečného vápence (a mechu u lesa a u vody), váhy os podle hrubé normály.
  vec3 triW = pow(abs(coarse), vec3(4.0));
  triW /= triW.x + triW.y + triW.z;
  // Mech jen u paty stěn nad lesem a u vody, ne po celém svahu.
  float mossy = smoothstep(0.18, 0.04, alt) * smoothstep(0.3, 0.65, noise3(wp * 0.02 + 9.0) * 0.5 + 0.5);
  vec3 rockTex = textureDetail(uRockColor, uRockMean, wp, triW, footprint);
  vec3 mossTex = textureDetail(uMossColor, uMossMean, wp, triW, footprint);
  rock *= mix(rockTex, mossTex * vec3(0.8, 1.0, 0.7), mossy * 0.6);
  float lichen = smoothstep(0.55, 0.8, noise3(wp * 0.18 + 3.0) * 0.5 + 0.5);
  rock = mix(rock, vec3(0.10, 0.10, 0.09), lichen * 0.18);
  // Sutě: kužely a proudy světlejší drti pod stěnami (sklon kolem 35°), protažené dolů
  // po spádnici; mezi nimi pruhy skály a tmavší kleče.
  vec3 scree = vec3(0.34, 0.32, 0.29) * textureDetail(uGravelColor, uGravelMean, wp * 0.6, triW, footprint * 0.6);
  float screeBand = smoothstep(0.55, 0.72, slope) * (1.0 - smoothstep(0.82, 0.9, slope));
  float fans = smoothstep(0.35, 0.65, noise3(vec3(wp.x * 0.006, wp.y * 0.0015, wp.z * 0.006) + 5.0) * 0.5 + 0.5);
  vec3 albedo;
  float bumpFade = 1.0 - smoothstep(0.002, 0.006, footprint);
  // Reliéf v půdorysu jen na mírných svazích: na strmých stěnách by šikmý pohled i slunce
  // udělaly z jeho nerovností tmavé skvrny (stěny mají 3D detail níž).
  vec2 bumpSlope = rockBump(p.xz) * 0.004 * bumpFade * smoothstep(0.55, 0.85, slope);

  // Strmé stěny: výšková mapa tu detail jen natáhne, proto 3D detail podle polohy v metrech.
  // Vodorovné lavice vápence, svislé tmavé pruhy od vody a nerovnosti, které lámou světlo.
  // I svahy kolem 45–55° (mezi loukou a stěnou) mají skalní detail, jinak jsou jako omítka.
  float steep = 1.0 - smoothstep(0.3, 0.8, slope);
  if (steep > 0.0) {
    float benches = 0.5 + 0.5 * sin(wp.y * 0.33 + 4.0 * fbm3(wp * 0.015));
    float streaks = smoothstep(0.1, 0.6, noise3(vec3(wp.x * 0.09, wp.y * 0.006, wp.z * 0.09)));
    float blotches = fbm3(wp * 0.04);
    // Spáry a pukliny: ostré tmavé hrany ridged šumu ve dvou měřítkách (bloky ~30 m a ~6 m).
    // Spáry a pukliny jsou vidět jen zblízka; zdálky by dělaly „špinavé“ skvrny.
    float near = 1.0 - smoothstep(0.0008, 0.004, footprint);
    // Vápenec je vrstvený: široké šikmé pásy světlejší a tmavší horniny (Dachsteinkalk).
    float bedding = 0.5 + 0.5 * sin((wp.y + wp.x * 0.18 - wp.z * 0.1) * 0.045 + 2.0 * gnoise(p.xz * 3.0));
    // Pukliny vápence jsou převážně svislé a rovné, ne zvlněné jako žilky v mramoru.
    float joints = 1.0 - abs(noise3(vec3(wp.x * 0.05, wp.y * 0.008, wp.z * 0.05)));
    joints = smoothstep(0.84, 0.97, joints) * 0.7;
    float cracks = smoothstep(0.9, 0.99, 1.0 - abs(noise3(vec3(wp.x * 0.2, wp.y * 0.05, wp.z * 0.2) + 7.0))) * 0.5;
    // Dutiny zůstávají ve stínu, výstupky jsou světlejší.
    float cavity = smoothstep(-0.35, 0.35, fbm3(wp * 0.05) + 0.5 * fbm3(wp * 0.2));
    vec3 cliff = rock * (0.92 + 0.12 * benches) * (0.9 + 0.2 * blotches) * (1.0 - 0.12 * streaks);
    // Zdálky jen velké dutiny a žebra (~40 m); jemné spáry by tu dělaly pravidelné tečky.
    float cavityFar = smoothstep(-0.4, 0.4, fbm3(wp * 0.012 + 3.0));
    cliff *= mix(0.7 + 0.45 * cavityFar, (0.55 + 0.6 * cavity) * (1.0 - 0.55 * joints) * (1.0 - 0.4 * cracks), near);
    cliff *= 0.85 + 0.25 * bedding;
    // Tintenstriche: černé pruhy od stékající vody (sinice), široké metry až desítky metrů,
    // dlouhé stovky metrů, ve skupinách pod převisy. Mezi nimi okrové zvětrání.
    float drip = noise3(vec3(wp.x * 0.03, wp.y * 0.0018, wp.z * 0.03) + 21.0);
    float dripZone = smoothstep(-0.15, 0.35, noise3(vec3(wp.x * 0.006, wp.y * 0.003, wp.z * 0.006) + 17.0));
    float ink = smoothstep(0.05, 0.45, drip) * dripZone;
    cliff *= 1.0 - 0.55 * ink;
    float ochre = smoothstep(0.2, 0.6, noise3(vec3(wp.x * 0.012, wp.y * 0.004, wp.z * 0.012) + 29.0)) * (1.0 - ink);
    cliff *= mix(vec3(1.0), vec3(1.08, 0.97, 0.82), ochre * 0.7);
    // Žlaby a kouty stěn: méně oblohy, víc vlhka, tmavší.
    cliff *= mix(1.0, 0.72, smoothstep(1.0, 5.0, occ));
    rock = mix(rock, cliff, steep);
    // Normála: bloky, výstupky a hrany lavic ve dvou měřítkách.
    float e = 1.5;
    float fineW = 0.5 * near;
    float f0 = fbm3(wp * 0.05) + fineW * fbm3(wp * 0.2);
    vec3 grad = vec3(fbm3((wp + vec3(e, 0.0, 0.0)) * 0.05) + fineW * fbm3((wp + vec3(e, 0.0, 0.0)) * 0.2) - f0,
                     fbm3((wp + vec3(0.0, e, 0.0)) * 0.05) + fineW * fbm3((wp + vec3(0.0, e, 0.0)) * 0.2) - f0,
                     fbm3((wp + vec3(0.0, 0.0, e)) * 0.05) + fineW * fbm3((wp + vec3(0.0, 0.0, e)) * 0.2) - f0) / e;
    vec3 tangent = grad - dot(grad, n) * n;
    n = normalize(n - tangent * 0.8 * steep * mix(0.4, 1.0, bumpFade));
  }
  // Sutě pod stěnami a drť na plošinách krasu.
  albedo = mix(rock, scree, max(screeBand * mix(0.35, 0.95, fans), smoothstep(0.8, 0.9, slope) * 0.55));

  // Alpské louky a kleč: na mírnějších svazích nad lesem roste tráva (do asi 2200 m n. m.),
  // na římsách ve stěnách jen trsy. Skalní svah tak není holý jako omítka.
  float grassy = smoothstep(0.62, 0.8, slope + 0.08 * (detail - 0.5)) * (1.0 - smoothstep(1.05, 1.35, alt));
  grassy *= smoothstep(0.35, 0.6, noise3(wp * 0.014 + 5.0) * 0.5 + 0.5 + 0.25);
  vec3 alpine = mix(vec3(0.040, 0.060, 0.026), vec3(0.06, 0.07, 0.035), smoothstep(0.9, 1.3, alt));
  alpine = mix(alpine, vec3(0.13, 0.09, 0.045), uAutumn * 0.7);
  alpine *= (0.85 + 0.3 * fine) * textureDetail(uGrassColor, uGrassMean, wp * 3.0, triW, footprint * 3.0);
  // Horská tráva není trávník: vlhčí a sušší plochy, keře a kleč, trsy suché trávy.
  alpine *= mix(0.7, 1.05, noise3(wp * 0.04 + 53.0) * 0.5 + 0.5);
  float aShrub = smoothstep(0.6, 0.8, noise3(wp * 0.1 + 59.0) * 0.5 + 0.5);
  alpine = mix(alpine, vec3(0.02, 0.032, 0.016) * (0.7 + 0.6 * fine), aShrub * 0.7);
  float aDry = smoothstep(0.6, 0.85, noise3(wp * 0.03 + 61.0) * 0.5 + 0.5) * (1.0 - uSpring);
  alpine = mix(alpine, vec3(0.09, 0.075, 0.045) * (0.8 + 0.4 * fine), aDry * 0.5);
  // Na balvanech v popředí jen holý vápenec.
  float onBoulder = boulderMask(p.xz);
  grassy *= 1.0 - onBoulder;
  albedo = mix(albedo, alpine, grassy);
  // Pod skupinkami smrků ve strmém svahu (trees.js, do 1,2 km) tmavá lesní půda s jehličím.
  float slopeTan = sqrt(max(1.0 - slope * slope, 0.0)) / max(slope, 0.05);
  float clingZone = step(0.8, slopeTan) * step(slopeTan, 3.2) * (1.0 - smoothstep(0.5, 0.6, alt))
                  * (1.0 - smoothstep(1.05, 1.2, length(p.xz)));
  if (clingZone > 0.0) {
    float groups = vnoiseJ(p.xz * 30.0 + vec2(3.0, 9.0)) * 0.7 + vnoiseJ(p.xz * 120.0) * 0.3;
    float under = smoothstep(0.36, 0.6, groups) * clingZone;
    vec3 needleFloor = vec3(0.032, 0.034, 0.022) * textureDetail(uFloorColor, uFloorMean, wp * 2.0, triW, footprint * 2.0);
    albedo = mix(albedo, needleFloor, under * 0.85);
  }

  // Louky podle ročního období.
  vec3 meadow = vec3(0.070, 0.100, 0.030);
  meadow = mix(meadow, vec3(0.085, 0.135, 0.032), uSpring);
  meadow = mix(meadow, vec3(0.120, 0.095, 0.040), uAutumn);
  meadow *= (0.85 + 0.3 * fine) * textureDetail(uGrassColor, uGrassMean, wp * 3.0, triW, footprint * 3.0);
  // Louka u jezera není trávník: tmavší vlhké trsy, plochy suché trávy a prošlapaná hlína.
  float lush = noise3(wp * 0.05 + 31.0) * 0.5 + 0.5;
  float dry = smoothstep(0.55, 0.8, noise3(wp * 0.02 + 37.0) * 0.5 + 0.5);
  float soil = smoothstep(0.72, 0.9, noise3(wp * 0.07 + 41.0) * 0.5 + 0.5);
  meadow *= mix(0.62, 1.05, lush);
  meadow = mix(meadow, vec3(0.12, 0.10, 0.055) * (0.8 + 0.4 * fine), dry * (0.5 - 0.3 * uSpring));
  meadow = mix(meadow, vec3(0.07, 0.055, 0.04) * (0.8 + 0.4 * fine), soil * 0.6);
  // Louky a mýtiny ve svahu: vyšší tráva, kapradí a keře, tmavší a olivové (ne trávník).
  // Zdálky tráva ztrácí jas stínem mezi stébly; ve svahu ještě víc.
  float hillside = 1.0 - smoothstep(0.9, 0.99, slope);
  meadow *= mix(vec3(0.82), vec3(0.6, 0.56, 0.46), hillside);
  float shrubs = smoothstep(0.58, 0.78, noise3(wp * 0.12 + 47.0) * 0.5 + 0.5) * (0.4 + 0.6 * hillside);
  meadow = mix(meadow, vec3(0.022, 0.036, 0.018) * (0.7 + 0.6 * fine), shrubs * 0.75);

  // Okno chaty pod ledovcem v noci svítí (jediné světlo daleko v horách).
  float lights = 1.0 - smoothstep(0.004, 0.009, distance(p.xz, uHut));
  float house = 0.0;
  float village = 0.0;

  // Na rovinkách u jezera je místo holé skály tráva.
  // Tráva u jezera nepravidelně: louka střídá kamenité a lesní úseky.
  float lakeMeadow = (1.0 - smoothstep(0.02, 0.1, alt)) * smoothstep(0.25, 0.6, noise3(wp * 0.008 + 7.0) * 0.5 + 0.5 + 0.2);
  albedo = mix(albedo, meadow, lakeMeadow * (1.0 - onBoulder));
  // Balvan: světle šedý vápenec, u vody tmavý mokrý pruh a zelenavé řasy.
  if (onBoulder > 0.0) {
    vec3 stone = vec3(0.13, 0.125, 0.115) * textureDetail(uMossColor, uMossMean, wp * 1.8, triW, footprint * 1.8);
    stone *= 0.7 + 0.45 * smoothstep(-0.3, 0.4, gnoise(p.xz * 2500.0));
    // Spodní část mokrá a porostlá řasou, nahoře suchý vápenec.
    stone = mix(vec3(0.035, 0.045, 0.03), stone, smoothstep(0.0, 0.0012, alt));
    albedo = mix(albedo, stone, onBoulder);
  }

  // Les podle masky (tools/terrain.mjs): koruny jsou skutečná výška terénu, tady jen barva.
  float forestRaw = forestDensity(p.xz);
  float forest = forestRaw * smoothstep(0.0035, 0.007, hc);
  float meadowShare = smoothstep(0.78, 0.92, detail) * 0.5 * (1.0 - smoothstep(0.15, 0.5, alt));
  float gaps = 1.0;
  // Podmínka i hustota stejné jako u tvaru stromů v height(), jinak by kužel stromu dostal barvu louky.
  if (forestRaw > 0.0) {
    float ground = hc;
    vec4 tree = canopy(p.xz, forest, ground);
    float onTree = step(0.0001, tree.x);
    float crownFade = 1.0 - smoothstep(0.002, 0.006, footprint);
    // Každý strom má trochu jiný odstín: od modrozeleného po žlutozelený.
    float hue = hash12(floor(p.xz * 140.0) + 11.0);
    vec3 spruce = mix(vec3(0.014, 0.032, 0.024), vec3(0.026, 0.040, 0.016), hue) * (0.8 + 0.4 * hash12(floor(p.xz * 140.0) + 3.0));
    // Modříny a buky: na jaře světle zelené, v létě zelené, na podzim zlaté a oranžové, v zimě holé.
    vec3 larch = mix(vec3(0.035, 0.065, 0.025), vec3(0.055, 0.10, 0.030), uSpring);
    larch = mix(larch, vec3(0.13, 0.115, 0.035), uAutumn);   // zlatožlutá, ne oranžová
    larch = mix(larch, vec3(0.075, 0.065, 0.055), uWinter);
    vec3 beech = mix(vec3(0.035, 0.070, 0.025), vec3(0.06, 0.11, 0.03), uSpring);
    beech = mix(beech, vec3(0.22, 0.08, 0.020), uAutumn);
    beech = mix(beech, vec3(0.085, 0.07, 0.06), uWinter);
    float larchShare = mix(0.04, 0.10, uAutumn) * smoothstep(0.35, 0.8, ground);
    float beechShare = mix(0.03, 0.08, uAutumn) * (1.0 - smoothstep(0.25, 0.5, ground));
    vec3 crownColor = spruce;
    if (tree.z < larchShare) crownColor = larch;
    else if (tree.z > 1.0 - beechShare) crownColor = beech;
    // Konce větví (horní část patra) jsou světlejší, v hloubi patra a u kmene stín.
    float needles = 0.75 + 0.5 * noise3(wp * 9.0 + tree.z * 50.0) * (1.0 - smoothstep(0.0003, 0.0012, footprint));
    // Koruna není souvislá plocha: shluky větví a mezery mezi nimi (skvrnité světlo),
    // dole u země tmavá (kmen a suché spodní větve).
    // Shluky větví (3D, ať nejsou svislé pruhy) a patra: spodní část každého patra
    // je ve stínu větví nad ní, konce větví nahoře jsou na světle.
    float clumps = smoothstep(-0.3, 0.4, noise3(wp * 1.6 + tree.z * 31.0));
    float tierLight = mix(0.3, 1.15, smoothstep(0.1, 0.9, tree.w));
    crownColor *= tierLight * (0.75 + 0.35 * (1.0 - tree.y)) * needles * (0.5 + 0.7 * clumps);
    crownColor = mix(crownColor, vec3(0.018, 0.014, 0.010), smoothstep(0.82, 0.98, tree.y) * 0.8);
    // Pod stromy mech, borůvčí a jehličí; v mýtinách tráva.
    vec3 floorColor = mix(vec3(0.030, 0.036, 0.020), meadow * 0.7, 0.12)   // stín pod smrky
                    * textureDetail(uFloorColor, uFloorMean, wp * 2.0, triW, footprint * 2.0);
    vec3 farForest = spruce * (0.8 + 0.4 * fine) + (larch - spruce) * larchShare + (beech - spruce) * beechShare;
    // Zdálky kresba korun: shluky stromů (20 m) a jednotlivé špičky (5 m) střídají světlo a stín.
    farForest *= (0.7 + 0.6 * (noise3(wp * 0.05) * 0.5 + 0.5)) * (0.75 + 0.5 * (noise3(wp * 0.2 + 4.0) * 0.5 + 0.5));
    // Zdálky je les o něco světlejší a zelenější (mezi korunami prosvítá světlo, špičky
    // se lesknou); tmavě modrou mu dodá až vzduch. Partie se liší odstínem po stovkách metrů.
    float stand = noise3(wp * 0.006 + 21.0) * 0.5 + 0.5;
    farForest *= mix(vec3(1.45, 1.55, 1.0), vec3(1.75, 1.8, 1.05), stand);
    // Řídký okraj: mezi stromy prosvítá zem (kamení, tráva), ne tmavá plocha.
    farForest = mix(albedo * 0.7, farForest, smoothstep(0.15, 0.7, forest));
    vec3 trees = mix(farForest, mix(floorColor, crownColor, onTree), crownFade);
    // V zimě sníh na větvích a na zemi mezi stromy.
    trees = mix(trees, vec3(0.62, 0.64, 0.68), uWinter * mix(0.2, mix(0.8, 0.3, onTree), crownFade));
    // Stín pod každým patrem větví a mezi stromy.
    gaps = mix(1.0, mix(0.8, mix(0.45, 1.0, tree.w), onTree), crownFade * forest);
    bumpSlope *= 1.0 - forest;
    // Jehličí: drobná nerovnost normály, jen zblízka (jinak by třpytila).
    // Normála koruny se nakloní ven a nahoru, ať má kužel světlou a stinnou stranu.
    // (Dřívější 2D nerovnost jehličí dělala svislé pruhy.)
    // Strom má barvu stromu i zdálky (jinak by na okraji lesa přebral barvu louky).
    // Barvu lesa má jen místo, kde strom opravdu stojí; zdálky (strom menší než pixel)
    // průměr podle hustoty. Jinak by řídký okraj lesa pokryl skálu tmavými skvrnami.
    float treeShare = mix(forest * 0.85, onTree, crownFade);
    albedo = mix(albedo, mix(trees, meadow, meadowShare * (1.0 - onTree)), treeShare);
  }

  // Břeh: pás světlého vápencového štěrku těsně nad vodou, s většími kameny a naplaveným
  // dřevem. Les začíná až za ním. Hranice je nepravidelná, jak voda kolísá.
  // Šířka pláže se mění: místy široký štěrkový jazyk, jinde tráva a les až k vodě.
  float beachWidth = smoothstep(-0.2, 0.5, noise3(wp * 0.012 + 2.0));
  float waterline = (0.0005 + 0.0022 * beachWidth) * (0.8 + 0.4 * (gnoise(p.xz * 60.0 + uSeed) * 0.5 + 0.5));
  // Hranice pláže roztřepená: štěrk prorůstá do trávy jazyky a ostrůvky.
  float fray = noise3(wp * 0.09 + 43.0) * 0.5 + 0.5;
  float beach = (1.0 - smoothstep(waterline * 0.6, waterline * (0.9 + 1.6 * fray * fray), alt)) * smoothstep(0.55, 0.8, slope) * (1.0 - onBoulder);
  if (beach > 0.0) {
    vec2 sq = p.xz * 2500.0;
    vec2 stoneCell = floor(sq);
    float stone = hash12(stoneCell + 3.0);
    float round = 1.0 - smoothstep(0.25, 0.45, length(fract(sq) - 0.5));
    vec3 gravel = vec3(0.22, 0.215, 0.19) * (0.85 + 0.3 * fine) * textureDetail(uGravelColor, uGravelMean, wp * 5.0, triW, footprint * 5.0);
    vec3 boulder = vec3(0.24, 0.24, 0.22) * (0.7 + 0.5 * stone);
    gravel = mix(gravel, boulder, round * step(0.8, stone));
    // Mokrý pruh u samé vody je tmavší.
    gravel *= mix(0.6, 1.0, smoothstep(0.0, waterline * 0.5, alt));
    albedo = mix(albedo, gravel, beach);
    forest *= 1.0 - beach;
  }

  // Sníh: nad sněžnou čarou na mírnějších svazích, v zimě až k jezeru.
  float glacier = glacierAt(p.xz);
  // V zimě sníh až k hladině (sněžná čára pod ní, jinak by louky u jezera zůstaly zelené).
  float snowLine = uSnowLine + 0.25 * detail - 0.55 * glacier - 0.14 * uWinter;
  float threshold = mix(0.7, 0.45, uWinter);
  float snow = smoothstep(snowLine, snowLine + 0.12, alt) * smoothstep(threshold, threshold + 0.16, slope + 0.08 * detail - 0.1 * glacier);
  // V zimě sněhová čepice i na balvanech u vody (jen na vodorovných plochách).
  // Sklon z výškové mapy balvanů (hrubá normála by zahrnula i sráz ke dnu jezera).
  if (onBoulder > 0.0 && uWinter > 0.0) {
    float e = 0.0006;
    float b0 = boulders(p.xz);
    float boulderUp = e / length(vec3(b0 - boulders(p.xz + vec2(e, 0.0)), e, b0 - boulders(p.xz + vec2(0.0, e))));
    snow = max(snow, uWinter * onBoulder * smoothstep(0.6, 0.85, boulderUp) * smoothstep(0.0005, 0.0012, alt));
  }
  if (snow > 0.0 && uWinter < 0.5) {
    // Na vypouklých hranách hřebenů vítr sníh odfoukne; drží se v žlabech a na plošinách.
    float r = 0.06;
    float around = 0.0;
    for (int i = 0; i < 4 * uOne; i++) {
      float a = float(i) * 1.5708;
      around += 0.25 * height(p.xz + vec2(cos(a), sin(a)) * r, 6);
    }
    snow *= mix(smoothstep(0.012, -0.004, hc - around), 1.0, glacier * 0.7);
  }
  snow *= 1.0 - forest * (1.0 - uWinter);
  albedo = mix(albedo, vec3(0.86, 0.88, 0.92), snow);
  bumpSlope *= 1.0 - 0.8 * snow;

  s.albedo = albedo;
  float bare = (1.0 - smoothstep(0.02, 0.35, forest)) * (1.0 - snow) * (1.0 - grassy);
  if (bare > 0.01) {
    vec3 bump = mix(textureBump(uRockNormal, wp, triW), textureBump(uMossNormal, wp, triW), mossy * 0.6);
    // Slabě a zdálky ještě slaběji: opakující se reliéf by na velkém svahu dělal pravidelný vzor.
    n = normalize(n + bump * 0.18 * (1.0 - smoothstep(0.00006, 0.0004, footprint)) * bare);
  }
  s.normal = normalize(n + vec3(-bumpSlope.x, 0.0, -bumpSlope.y));
  s.forest = forest * (1.0 - uWinter * 0.5);
  s.occlusion = occlusion * gaps;
  s.lights = lights;
  s.snow = snow;
  return s;
}

const vec2 SAMPLES[4] = vec2[4](vec2(-0.125, -0.375), vec2(0.375, -0.125), vec2(-0.375, 0.125), vec2(0.125, 0.375));

void main() {
  vec3 ro = vec3(0.0, CAMERA_HEIGHT, 0.0);
  int terrainHits = 0, skyHits = 0, waterHits = 0;
  float nearest = 1e9, waterDistance = 0.0;
  vec3 hitRay = vec3(0.0);
  // Více paprsků na pixel jen kvůli hranám (hřebeny proti obloze, břeh proti vodě).
  // Povrch se nasvítí jednou, v nejbližším zásahu: shader tak zůstane malý (stínování
  // by se jinak vložilo čtyřikrát a překlad v ovladači grafiky by trval příliš dlouho).
  for (int i = 0; i < uSamples; i++) {
    vec2 offset = uSamples == 1 ? vec2(0.0) : SAMPLES[i];
    vec3 rd = rayDirection((gl_FragCoord.xy + offset) / uRes);
    float t = march(ro, rd);
    float water = rd.y < 0.0 ? CAMERA_HEIGHT / -rd.y : 1e9;
    if (water < t || (t < 0.0 && rd.y < 0.0)) {
      waterHits++;
      waterDistance += water;
    } else if (t < 0.0) {
      skyHits++;
    } else {
      terrainHits++;
      if (t < nearest) { nearest = t; hitRay = rd; }
    }
  }
  if (waterHits * 2 > uSamples) {
    outAlbedo = vec4(0.0, 0.0, 0.0, -waterDistance / float(waterHits));
    outNormal = vec4(0.0, 1.0, 0.0, 0.0);
    outExtra = vec4(1.0, 0.0, 0.0, 1.0);
  } else if (terrainHits == 0) {
    outAlbedo = vec4(0.0, 0.0, 0.0, SKY_DEPTH);
    outNormal = vec4(0.0, 1.0, 0.0, 0.0);
    outExtra = vec4(1.0, 0.0, 0.0, 1.0);
  } else {
    Surface s = surfaceAt(ro + hitRay * nearest, nearest);
    float skyShare = float(skyHits) / float(uSamples);
    outAlbedo = vec4(s.albedo, nearest + 100.0 * floor(skyShare * 4.0 + 0.5));
    outNormal = vec4(s.normal, s.forest);
    outExtra = vec4(s.occlusion, s.lights, s.snow, 1.0);
  }
}`;

// Stíny pro daný směr světla: z každého pixelu terénu se jde paprskem ke slunci.
const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform vec3 uLight;
out vec4 outShadow;

${NOISE}
${CAMERA}
${TERRAIN}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // Stín má stejné rozlišení jako materiál; vzdálenost se nesmí filtrovat.
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  float a = texelFetch(uAlbedo, pixel, 0).a;
  vec3 rd = rayDirection(uv);
  // Hladina jezera dostane stín hor taky (balvany a třpyt slunce na vodě podle něj).
  bool water = a < 0.0 && rd.y < 0.0;
  if ((!water && (a < 0.0 || a > 900.0)) || uLight.y < -0.05) {
    outShadow = vec4(1.0);
    return;
  }
  float t = water ? CAMERA_HEIGHT / -rd.y : a - 100.0 * floor(a / 100.0);
  vec3 n = water ? vec3(0.0, 1.0, 0.0) : normalize(texelFetch(uNormal, pixel, 0).xyz);
  vec3 ro = vec3(0.0, CAMERA_HEIGHT, 0.0) + rd * t + n * 0.004;
  if (dot(n, uLight) < -0.25) {
    outShadow = vec4(0.0);
    return;
  }
  float res = 1.0;
  float s = 0.02;
  vec3 light = normalize(vec3(uLight.x, max(uLight.y, 0.004), uLight.z));
  for (int i = 0; i < 110 * uOne; i++) {
    vec3 p = ro + light * s;
    float h = p.y - height(p.xz, 8);
    res = min(res, 9.0 * h / s);
    if (res < 0.002 || p.y > 3.3 || s > 30.0) break;
    s += clamp(h * 0.5, 0.005, 0.4);
  }
  outShadow = vec4(clamp(res, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// Opakovatelná textura šumu pro mraky, vlnky, mlhu a vítr v lese (R: velké tvary, G: detail).
const NOISE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
out vec4 outColor;
${NOISE}
${CAMERA}
float pfbm(vec2 p, float period, int octaves) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * pnoise(p, period);
    n += a;
    p *= 2.0;
    period *= 2.0;
    a *= 0.5;
  }
  return s / n;
}
void main() {
  vec2 p = gl_FragCoord.xy / uRes * 8.0;
  outColor = vec4(pfbm(p + uSeed, 8.0, 6) * 0.5 + 0.5, pfbm(p * 2.0 + 17.0, 16.0, 4) * 0.5 + 0.5, 0.0, 1.0);
}`;

const HALF = { internal: 'RGBA16F', format: 'RGBA', type: 'HALF_FLOAT' };
const BYTE = { internal: 'RGBA8', format: 'RGBA', type: 'UNSIGNED_BYTE' };

/** G-buffer: tři textury v jednom framebufferu. */
function createGBuffer(gl, width, height) {
  const textures = [HALF, HALF, BYTE].map((f) => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl[f.internal], width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  });
  gl.bindTexture(gl.TEXTURE_2D, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const dispose = () => {
    gl.deleteFramebuffer(framebuffer);
    textures.forEach((t) => gl.deleteTexture(t));
  };
  if (!ok) {
    dispose();
    return null;
  }
  return { framebuffer, width, height, albedo: textures[0], normal: textures[1], extra: textures[2], dispose };
}

/**
 * Načte skutečný terén (tools/terrain.mjs) a nahraje ho do textury.
 * Výšky jsou v souboru v decimetrech nad `base` m n. m.; v textuře v km nad hladinou jezera.
 */
export async function loadHeightMap(gl, folder) {
  const meta = await (await fetch(`${folder}/dachstein.json`)).json();
  const raw = new Uint16Array(await (await fetch(`${folder}/dachstein.bin`)).arrayBuffer());
  const data = new Float32Array(raw.length);
  const offset = meta.base - meta.lakeLevel;
  for (let i = 0; i < raw.length; i++) data[i] = (raw[i] * meta.scale + offset) / 1000;
  const linearFloat = Boolean(gl.getExtension('OES_texture_float_linear'));
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (linearFloat) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, meta.columns, meta.rows, 0, gl.RED, gl.FLOAT, data);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, meta.columns, meta.rows, 0, gl.RED, gl.FLOAT, data);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // Maska lesa: stejná mřížka, hustota 0–255.
  const forestBytes = new Uint8Array(await (await fetch(`${folder}/dachstein-les.bin`)).arrayBuffer());
  const forest = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, forest);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, meta.columns, meta.rows, 0, gl.RED, gl.UNSIGNED_BYTE, forestBytes);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  // Výška v bodě (km nad hladinou), pro loďky, ať plují jen po vodě.
  const sample = (x, z) => {
    const fx = (x - meta.left) / meta.spacing, fz = (z - meta.near) / meta.spacing;
    const c = Math.max(0, Math.min(meta.columns - 2, Math.floor(fx)));
    const r = Math.max(0, Math.min(meta.rows - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - c)), v = Math.min(1, Math.max(0, fz - r));
    const at = (rr, cc) => data[rr * meta.columns + cc];
    return (at(r, c) * (1 - u) + at(r, c + 1) * u) * (1 - v) + (at(r + 1, c) * (1 - u) + at(r + 1, c + 1) * u) * v;
  };
  // Jemná mapa okolí jezera.
  const d = meta.detail;
  const detailRaw = new Uint16Array(await (await fetch(`${folder}/dachstein-detail.bin`)).arrayBuffer());
  const detailData = new Float32Array(detailRaw.length);
  for (let i = 0; i < detailRaw.length; i++) detailData[i] = (detailRaw[i] * meta.scale + offset) / 1000;
  const detailTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, detailTexture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, linearFloat ? gl.R32F : gl.R16F, d.columns, d.rows, 0, gl.RED, gl.FLOAT, detailData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const detail = {
    texture: detailTexture, columns: d.columns, rows: d.rows, left: d.left, near: d.near,
    width: (d.columns - 1) * d.spacing, depth: (d.rows - 1) * d.spacing,
  };
  // Bilineární čtení mřížky v JS (km).
  const gridSample = (values, cols, rows, left, near, spacing, x, z) => {
    const fx = (x - left) / spacing, fz = (z - near) / spacing;
    const c = Math.max(0, Math.min(cols - 2, Math.floor(fx)));
    const r = Math.max(0, Math.min(rows - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - c)), v = Math.min(1, Math.max(0, fz - r));
    const at = (rr, cc) => values[rr * cols + cc];
    return (at(r, c) * (1 - u) + at(r, c + 1) * u) * (1 - v) + (at(r + 1, c) * (1 - u) + at(r + 1, c + 1) * u) * v;
  };
  const inDetail = (x, z) => x > d.left && z > d.near && x < d.left + detail.width && z < d.near + detail.depth;
  const sampleFine = (x, z) => (inDetail(x, z)
    ? gridSample(detailData, d.columns, d.rows, d.left, d.near, d.spacing, x, z)
    : gridSample(data, meta.columns, meta.rows, meta.left, meta.near, meta.spacing, x, z));
  const sampleForest = (x, z) => gridSample(forestBytes, meta.columns, meta.rows, meta.left, meta.near, meta.spacing, x, z) / 255;
  // Balvany v popředí (km): x, z, poloměr, výška nad vodou. Kamera vidí hladinu od 80 m.
  const boulderList = [
    [-0.050, 0.108, 0.0060, 0.0034],
    [-0.037, 0.121, 0.0036, 0.0021],
    [-0.064, 0.097, 0.0028, 0.0015],
    [0.047, 0.124, 0.0065, 0.0033],
    [0.061, 0.114, 0.0032, 0.0018],
  ];
  // Výšková mapa balvanů: 680 × 240 bodů po 25 cm přes obdélník x −85…85 m, z 85…145 m.
  const BW = 680, BH = 240, rect = [-0.085, 0.085, 0.17, 0.06];
  const hashNoise = (x, y, seed) => {
    const h = (ix, iy) => {
      let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 982451653);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    };
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
    return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
  };
  const boulderData = new Float32Array(BW * BH).fill(-1);
  // Náhodná čísla se semínkem, ať mají balvany při každém startu stejný tvar.
  let state = 0x9e3779b9;
  const rnd = () => {
    state = (state + 0x6d2b79f5) | 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  // Bludný balvan obroušený ledovcem: zaoblená kopule, jen boky seříznuté šikmými
  // rovinami (lomové plochy s hranami), vrch zůstává oblý. Pukliny a drobné nerovnosti.
  // Kolem menší kameny.
  const rocks = boulderList.map(([bx, bz, radius, tall]) => ({
    bx, bz, radius, depth: radius * 0.8, tall,
    planes: Array.from({ length: 7 }, () => {
      const a = rnd() * Math.PI * 2;
      return { dx: Math.cos(a), dz: Math.sin(a), lift: 1.0 + rnd() * 0.3, tilt: 0.6 + rnd() * 0.7 };
    }),
    crack: { a: rnd() * Math.PI, offset: (rnd() - 0.5) * 0.6 },
  }));
  for (const [bx, bz, radius] of boulderList) {
    for (let k = 0; k < 7; k++) {
      const a = rnd() * Math.PI * 2, d = radius * (1.1 + rnd() * 1.1);
      const r = 0.0005 + rnd() * 0.0011;
      rocks.push({
        bx: bx + Math.cos(a) * d, bz: bz + Math.sin(a) * d * 0.8, radius: r, depth: r * (0.7 + rnd() * 0.4),
        tall: r * (0.25 + rnd() * 0.3),
        planes: Array.from({ length: 5 }, () => {
          const b = rnd() * Math.PI * 2;
          return { dx: Math.cos(b), dz: Math.sin(b), lift: 0.8 + rnd() * 0.3, tilt: 0.8 + rnd() * 0.8 };
        }),
        crack: null,
      });
    }
  }
  for (let r = 0; r < BH; r++) {
    for (let c = 0; c < BW; c++) {
      const x = rect[0] + ((c + 0.5) / BW) * rect[2];
      const z = rect[1] + ((r + 0.5) / BH) * rect[3];
      let best = -1;
      rocks.forEach((rock, i) => {
        const qx = (x - rock.bx) / rock.radius, qz = (z - rock.bz) / rock.depth;
        const d2 = qx * qx + qz * qz;
        if (d2 > 1.6) return;
        // Balvan sedí ve vodě: boky strmé až k hladině (polovina elipsoidu), ne plochý vor.
        let h = rock.tall * Math.sqrt(Math.max(0, 1 - d2)) - rock.tall * 0.15;
        for (const p of rock.planes) h = Math.min(h, rock.tall * (p.lift - p.tilt * (qx * p.dx + qz * p.dz)));
        const mx = x * 1000, mz = z * 1000;
        h += rock.tall * (0.06 * hashNoise(mx * 1.3, mz * 1.3, i) + 0.03 * hashNoise(mx * 5, mz * 5, i + 9));
        if (rock.crack) {
          // Puklina: úzká rýha napříč balvanem.
          const across = qx * Math.cos(rock.crack.a) + qz * Math.sin(rock.crack.a) - rock.crack.offset;
          h -= rock.tall * 0.12 * Math.max(0, 1 - Math.abs(across) * 22);
        }
        best = Math.max(best, h);
      });
      boulderData[r * BW + c] = best;
    }
  }
  const boulderTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, boulderTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, linearFloat ? gl.R32F : gl.R16F, BW, BH, 0, gl.RED, gl.FLOAT, boulderData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const baseSample = sample;
  // Loďky a ptáci se vyhýbají 3D balvanům (boulders.js).
  const rocks3d = boulders3d();
  const onBoulders = (x, z) => rocks3d.some(([bx, bz, w]) => Math.hypot(x - bx, z - bz) < (w * 0.7 + 1.5) / 1000);
  // Textury skal (CC0): mipmapy, opakování, anizotropní filtr, průměrná barva lineárně.
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const loadImage = async (name) => {
    const blob = await (await fetch(`${folder}/textury/${name}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    gl.bindTexture(gl.TEXTURE_2D, null);
    const small = new OffscreenCanvas(32, 32).getContext('2d');
    small.drawImage(bitmap, 0, 0, 32, 32);
    const px = small.getImageData(0, 0, 32, 32).data;
    const mean = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) mean[k] += Math.pow(px[i + k] / 255, 2.2) / 1024;
    return { texture, mean };
  };
  const [rockTex, rockNormal, mossTex, mossNormal, grass, floor, gravel] = await Promise.all(
    ['vapenec-barva.jpg', 'vapenec-normala.jpg', 'mech-barva.jpg', 'mech-normala.jpg',
     'trava-barva.jpg', 'lesni-puda-barva.jpg', 'sterk-barva.jpg'].map(loadImage));
  const textures = { rock: rockTex, rockNormal, moss: mossTex, mossNormal, grass, floor, gravel };
  return {
    texture,
    forest,
    detail,
    textures,
    boulderTexture,
    sample: (x, z) => (onBoulders(x, z) ? 0.001 : baseSample(x, z)),
    sampleFine,
    sampleForest,
    meta,
    columns: meta.columns,
    rows: meta.rows,
    left: meta.left,
    near: meta.near,
    width: (meta.columns - 1) * meta.spacing,
    depth: (meta.rows - 1) * meta.spacing,
    glacier: meta.places.gosaugletscher,
    hut: meta.places.adamekHuette,
  };
}

export async function createTerrain(gl, map) {
  // Shadery terénu jsou velké: překládají se na pozadí, stránka mezitím nezamrzne.
  const t0 = performance.now();
  const [bake, shade, noise] = await Promise.all([
    createProgramAsync(gl, FULLSCREEN_VS, GBUFFER_FS, 'terrain'),
    createProgramAsync(gl, FULLSCREEN_VS, SHADOW_FS, 'shadow'),
    createProgramAsync(gl, FULLSCREEN_VS, NOISE_FS, 'noise'),
  ]);
  createTerrain.compileMs = Math.round(performance.now() - t0);
  const vao = gl.createVertexArray();
  let low = null, full = null, row = 0;
  let world = null, season = null, samples = 4;
  let noiseTexture = null;
  // Stíny: náhled, dvě plné textury (zobrazená a počítaná) a stav výpočtu.
  let shadowLow = null;
  const shadows = [null, null];
  let shown = -1;            // index zobrazené plné textury (-1 = zatím jen náhled)
  let job = null;            // { index, light, row }
  let fadeFrom = null;       // textura, ze které se stíny prolínají
  let fadeStart = 0;

  // Kolik práce na jeden snímek: menší kousky, ať žádný snímek nepřesáhne rozpočet.
  // Rozpočet: asi 60 tisíc paprsků terénu na snímek (na RTX 5060 Ti zhruba 4 ms).
  let rayBudget = 60000;
  const strip = () => Math.max(1, Math.round(rayBudget / (Math.max(1, full ? full.width : 1) * samples)));
  const shadowStrip = () => Math.max(4, Math.round(50000 / Math.max(1, full ? full.width : 1)));

  function cameraUniforms(program, width, height) {
    gl.useProgram(program.program);
    const u = program.u;
    if (u.uHeightMap) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, map.texture);
      gl.uniform1i(u.uHeightMap, 3);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, map.forest);
      gl.uniform1i(u.uForestMap, 4);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, map.detail.texture);
      gl.uniform1i(u.uDetailMap, 5);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform4f(u.uDetailRect, map.detail.left, map.detail.near, map.detail.width, map.detail.depth);
      gl.uniform2f(u.uDetailSize, map.detail.columns, map.detail.rows);
      gl.uniform4f(u.uMapRect, map.left, map.near, map.width, map.depth);
      gl.uniform2f(u.uMapSize, map.columns, map.rows);
      gl.uniform2f(u.uGlacier, ...map.glacier);
      gl.uniform2f(u.uHut, ...map.hut);
      gl.uniform1f(u.uTreeNear, TREE_NEAR);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, map.boulderTexture);
      gl.uniform1i(u.uBoulderMap, 6);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform2f(u.uRes, width, height);
    gl.uniform1f(u.uAspect, world.aspect);
    gl.uniform1f(u.uHorizon, world.horizon);
    gl.uniform1f(u.uSpan, world.span);
    gl.uniform1f(u.uMirror, world.mirror ? 1 : 0);
    gl.uniform2f(u.uSeed, ...world.seed);
    if (u.uOne) gl.uniform1i(u.uOne, 1);
  }

  function bakeUniforms(width, height, rays) {
    cameraUniforms(bake, width, height);
    const u = bake.u;
    [[map.textures.rock, 'uRockColor', 7], [map.textures.rockNormal, 'uRockNormal', 8],
     [map.textures.moss, 'uMossColor', 9], [map.textures.mossNormal, 'uMossNormal', 10],
     [map.textures.grass, 'uGrassColor', 11], [map.textures.floor, 'uFloorColor', 12],
     [map.textures.gravel, 'uGravelColor', 13]].forEach(([t, name, unit]) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.texture);
      gl.uniform1i(u[name], unit);
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(u.uRockMean, ...map.textures.rock.mean);
    gl.uniform3f(u.uMossMean, ...map.textures.moss.mean);
    gl.uniform3f(u.uGrassMean, ...map.textures.grass.mean);
    gl.uniform3f(u.uFloorMean, ...map.textures.floor.mean);
    gl.uniform3f(u.uGravelMean, ...map.textures.gravel.mean);
    gl.uniform1i(u.uSamples, rays);
    gl.uniform1f(u.uFootprint, world.span / height);
    gl.uniform1f(u.uSnowLine, season.snowLine);
    gl.uniform1f(u.uWinter, season.winter);
    gl.uniform1f(u.uAutumn, season.autumn);
    gl.uniform1f(u.uSpring, season.spring);
  }

  function run(framebuffer, width, height, y0, y1) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, y0, width, y1 - y0);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Náhled materiálu po krátkých pruzích: jeden dlouhý příkaz by Windows po dvou
  // sekundách násilně ukončily (ztráta kontextu WebGL).
  function bakeLow() {
    bakeUniforms(low.width, low.height, 1);
    for (let y = 0; y < low.height; y += 12) {
      run(low.framebuffer, low.width, low.height, y, Math.min(low.height, y + 12));
      gl.flush();
    }
  }

  function shadowPass(target, gbuffer, light, y0, y1) {
    cameraUniforms(shade, target.width, target.height);
    gl.uniform3f(shade.u.uLight, ...light);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gbuffer.albedo);
    gl.uniform1i(shade.u.uAlbedo, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, gbuffer.normal);
    gl.uniform1i(shade.u.uNormal, 1);
    gl.activeTexture(gl.TEXTURE0);
    run(target.framebuffer, target.width, target.height, y0, y1);
  }

  const shadowFormat = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };

  return {
    /** Začne novou krajinu: rychlý náhled hned, plné rozlišení postupně. */
    start(options, seasonNow, light) {
      world = options;
      season = seasonNow;
      samples = Math.max(1, Math.min(4, Math.round(options.samples || 4)));
      low?.dispose();
      full?.dispose();
      noiseTexture?.dispose();
      shadowLow?.dispose();
      shadows.forEach((s) => s?.dispose());
      const { width, height } = options;
      const lw = Math.max(1, Math.round(width / 4)), lh = Math.max(1, Math.round(height / 4));
      low = createGBuffer(gl, lw, lh);
      full = createGBuffer(gl, width, height);
      noiseTexture = createTarget(gl, 512, 512, {
        internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR,
      });
      shadowLow = createTarget(gl, lw, lh, shadowFormat);
      shadows[0] = createTarget(gl, width, height, shadowFormat);
      shadows[1] = createTarget(gl, width, height, shadowFormat);
      if (!low || !full || !noiseTexture || !shadowLow || !shadows[0] || !shadows[1])
        throw new Error('Krajina: float textury nejdou použít jako cíl kreslení.');
      gl.bindTexture(gl.TEXTURE_2D, noiseTexture.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.bindTexture(gl.TEXTURE_2D, null);

      cameraUniforms(noise, 512, 512);
      run(noiseTexture.framebuffer, 512, 512, 0, 512);
      bakeLow();
      for (let y = 0; y < lh; y += 24) {
        shadowPass(shadowLow, low, light, y, Math.min(lh, y + 24));
        gl.flush();
      }
      row = 0;
      shown = -1;
      job = null;
      fadeFrom = null;
    },

    /** Kus práce na jeden snímek: nejdřív plné rozlišení materiálu, pak stíny. */
    work(light, now) {
      if (row < full.height) {
        bakeUniforms(full.width, full.height, samples);
        run(full.framebuffer, full.width, full.height, row, Math.min(full.height, row + strip()));
        row += strip();
        return;
      }
      if (!job) return;
      const target = shadows[job.index];
      if (!target) { job = null; return; }
      const rows = shadowStrip();
      shadowPass(target, full, job.light, job.row, Math.min(target.height, job.row + rows));
      job.row += rows;
      if (job.row >= target.height) {
        fadeFrom = shown >= 0 ? shadows[shown].texture : shadowLow.texture;
        fadeStart = now;
        shown = job.index;
        job = null;
      }
    },

    /** Začne počítat stíny pro nový směr světla (když už se nepočítají). */
    requestShadows(light) {
      // Nový výpočet až po dokončení prolnutí, jinak by se přepisovala textura, ze které se prolíná.
      if (job || row < full.height || fadeFrom) return false;
      job = { index: shown === 0 ? 1 : 0, light: [...light], row: 0 };
      return true;
    },

    /** Přepočítá materiál pro jiné roční období (stíny zůstanou). */
    setSeason(seasonNow) {
      season = seasonNow;
      bakeLow();
      row = 0;
    },

    /** Pro ladění výkonu: kolik paprsků terénu se smí spočítat za snímek. */
    set rayBudget(value) { rayBudget = value; },
    get materialDone() { return Boolean(full) && row >= full.height; },
    get progress() { return full ? Math.min(1, row / full.height) : 0; },
    get busy() { return Boolean(job); },
    get low() { return low; },
    get full() { return full; },
    get noise() { return noiseTexture; },
    /** Stíny k zobrazení: odkud, kam a jak daleko je prolnutí (0..1). */
    shadowState(now) {
      const to = shown >= 0 ? shadows[shown].texture : shadowLow.texture;
      const from = fadeFrom || to;
      const mix = fadeFrom ? Math.min(1, (now - fadeStart) / 1.2) : 1;
      if (mix >= 1) fadeFrom = null;
      return { from, to, mix };
    },
  };
}
