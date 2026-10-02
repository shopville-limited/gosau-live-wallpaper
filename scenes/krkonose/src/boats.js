// Loďky na jezeře: tradiční Plätte s rybářem, kánoe, kajak, labutě a hejnko kachen u břehu.
// V zimě jezero zamrzne: loďky a ptáci zmizí a na kluzišti u kamery bruslí lidé.
// Plují jen po vodě (výšková mapa říká, kde je jezero), vyhýbají se břehům a rybář
// občas zastaví. Za soumraku se kánoe a kajak vrátí na břeh, na Plätte se rozsvítí lucerna.
// Kreslí se jako 3D modely (vzdálenostní funkce) v obdélníku kolem loďky, i s odrazem.
// Brázdu ve tvaru V (Kelvinův úhel) kreslí vodní shader podle poloh z wakes().

import { createProgramAsync } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';

export const MAX_BOATS = 8;          // brázdy (vodní shader)
const MAX_DRAWN = 32;                 // kreslených modelů (i s kachnami)

// Rozměry v km, rychlost v km/s, barvy lineárně.
const TYPES = {
  platte: { id: 0, length: 0.0078, beam: 0.0017, speed: 0.00055, hull: [0.16, 0.10, 0.06], turn: 0.18 },
  kanoe: { id: 1, length: 0.0052, beam: 0.0009, speed: 0.0011, hull: [0.45, 0.08, 0.05], turn: 0.3 },
  kajak: { id: 2, length: 0.0046, beam: 0.0007, speed: 0.0014, hull: [0.75, 0.50, 0.06], turn: 0.35 },
  labut: { id: 3, length: 0.0014, beam: 0.0006, speed: 0.0002, hull: [0.80, 0.80, 0.78], turn: 0.5 },
  kachna: { id: 4, length: 0.0006, beam: 0.0003, speed: 0.00012, hull: [0.30, 0.28, 0.25], turn: 0.9 },
  bruslar: { id: 5, length: 0.0008, beam: 0.0006, speed: 0.0035, hull: [0.5, 0.1, 0.08], turn: 1.4 },
};

const FLOATS = 20;

const VS = /* glsl */ `#version 300 es
precision highp float;
in vec4 aScreen;    // střed na hladině (px), px na metr, zrcadlení (1 = odraz)
in vec4 aShape;     // délka v pohledu (m), šířka (m), typ, kurz (rad)
in vec4 aMotion;    // fáze pádlování, průhlednost, lucerna, vzdálenost (km)
in vec4 aColor;     // barva trupu, rybář chytá (0/1) / pták se potápí (0..1)
in vec4 aWorld;     // poloha x, z (km), náhodné číslo, 0
uniform vec2 uPixels;
out vec4 vShape;
out vec4 vMotion;
out vec3 vHull;
out float vFishing;
out float vMirror;
out vec3 vWorld;
out vec2 vWaterUv;
const vec2 CORNERS[6] = vec2[6](vec2(-1, 0), vec2(1, 0), vec2(1, 1), vec2(-1, 0), vec2(1, 1), vec2(-1, 1));
void main() {
  vec2 c = CORNERS[gl_VertexID];
  // Obdélník kolem loďky: délka v pohledu + rezerva na pádla, vesla a prut.
  float halfWidth = aShape.x * 0.5 + 2.2;
  // Odraz rozsvícené lucerny se táhne po vodě daleko k oku: delší obdélník.
  float y = mix(-0.5, aScreen.w > 0.5 && aMotion.z > 0.0 ? 10.0 : 3.0, c.y);
  vShape = aShape;
  vMotion = aMotion;
  vHull = aColor.rgb;
  vFishing = aColor.w;
  vMirror = aScreen.w;
  vWorld = aWorld.xyz;
  vWaterUv = aScreen.xy / uPixels;
  vec2 offset = vec2(c.x * halfWidth, (aScreen.w > 0.5 ? -1.0 : 1.0) * y) * aScreen.z;
  // Aspoň pár pixelů, ať vzdálená loďka nezmizí úplně.
  offset = sign(offset) * max(abs(offset), vec2(c.x != 0.0 ? 3.0 : 0.0, c.y > 0.0 ? 3.0 : 0.0));
  vec2 pos = aScreen.xy + offset;
  gl_Position = vec4(pos / uPixels * 2.0 - 1.0, 0.0, 1.0);
}`;

// Loďky a labutě jako 3D modely ze vzdálenostních funkcí (v metrech, příď +x, nahoru +y,
// pravobok +z). Každý pixel obdélníku pošle paprsek z kamery (u odrazu ze zrcadlené
// kamery pod hladinou), najde povrch a nasvítí ho sluncem, oblohou a stínem hor.
// Tenké věci (pádla, prut) menší než pixel se vykreslí jako částečné pokrytí.
const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec4 vShape;
in vec4 vMotion;
in vec3 vHull;
in float vFishing;
in float vMirror;
in vec3 vWorld;
in vec2 vWaterUv;
uniform vec2 uPixels;
uniform float uExposure;
uniform float uContrast;
uniform sampler2D uShadow;
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}

const float M_HULL = 1.0, M_INSIDE = 2.0, M_SKIN = 3.0, M_JACKET = 4.0, M_WOOD = 5.0, M_WHITE = 6.0;
const float M_BEAK = 7.0, M_BLACK = 8.0, M_VEST = 9.0, M_DARK = 10.0, M_JACKET2 = 11.0, M_HAT = 12.0;
const float M_DUCK = 13.0, M_DUCKHEAD = 14.0, M_BILL = 15.0, M_CHEST = 16.0, M_COLLAR = 17.0;
const float M_BLADE = 18.0, M_CAP = 19.0;

float gType, gPhase, gFish, gTime, gSeed;

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
vec2 U(vec2 a, vec2 b) { return a.x < b.x ? a : b; }

// Sedící člověk: trup, hlava, paže k rukám. lean = náklon dopředu (m).
vec2 person(vec3 p, vec3 hip, float lean, vec3 handL, vec3 handR, float jacket, float vest) {
  vec3 neck = hip + vec3(0.06 + lean, 0.56, 0.0);
  float torso = sdCapsule(p, hip + vec3(0.0, 0.05, 0.0), neck - vec3(0.0, 0.05, 0.0), 0.16);
  vec2 r = vec2(torso, vest > 0.5 ? M_VEST : jacket);
  r = U(r, vec2(length(p - neck - vec3(0.03, 0.2, 0.0)) - 0.105, M_SKIN));
  vec3 shL = neck + vec3(-0.02, -0.07, -0.19), shR = neck + vec3(-0.02, -0.07, 0.19);
  float arms = min(sdCapsule(p, shL, handL, 0.05), sdCapsule(p, shR, handR, 0.05));
  return U(r, vec2(arms, jacket));
}

// Pádlo kánoe: horní ruka na rukojeti, dolní na žerdi, list pod ní.
vec2 canoePaddle(vec3 p, float x0, float side, float cycle, float jacket) {
  // Ve vodě (sin < 0) jde list zepředu dozadu (reach 1 → -1) a loď tlačí dopředu,
  // nad vodou (sin > 0) se vrací dopředu.
  float reach = -cos(cycle);                // 1 = vpředu (záběr), -1 = vzadu
  float lift = max(0.0, sin(cycle));        // návrat nad vodou
  vec3 hip = vec3(x0, 0.1, 0.0);
  vec3 top = vec3(x0 + 0.15 + 0.3 * reach, 1.0 + 0.12 * lift, side * 0.1);
  vec3 low = vec3(x0 + 0.25 + 0.55 * reach, 0.5 + 0.28 * lift, side * 0.45);
  vec3 dir = normalize(low - top);
  vec3 bladeA = low + dir * 0.35, bladeB = low + dir * 0.85;
  vec2 r = vec2(sdCapsule(p, top, bladeA, 0.016), M_WOOD);
  r = U(r, vec2(sdCapsule(p, bladeA, bladeB, 0.065), M_WOOD));
  return U(r, person(p, hip, 0.08 * reach, side > 0.0 ? top : low, side > 0.0 ? low : top, jacket, 0.0));
}

vec2 platte(vec3 p) {
  // Plätte ze Solné komory: ploché dno, boky z prken, dlouhá zdvižená špičatá příď,
  // rovná záď.
  float hl = 3.9, hb = 0.8;
  float u = clamp(p.x / hl, -1.0, 1.0);
  float bowU = max(u, 0.0);
  float bottom = -0.14 + 0.8 * pow(bowU, 2.2);
  float gunwale = 0.4 + 0.7 * pow(bowU, 2.6);
  float width = max(hb * (1.0 - pow(bowU, 1.7)), 0.015) + max(p.y - bottom, 0.0) * 0.22;
  float outer = max(max(abs(p.z) - width, bottom - p.y), max(p.y - gunwale, abs(p.x) - hl));
  float inner = max(max(abs(p.z) - (width - 0.05), bottom + 0.06 - p.y), abs(p.x) - (hl - 0.1));
  float hull = max(outer, -inner) * 0.75;
  float mat = p.y > gunwale - 0.045 ? M_WOOD : (inner < 0.02 && abs(p.z) < width - 0.03 ? M_INSIDE : M_HULL);
  vec2 r = vec2(hull, mat);
  // Lavička.
  r = U(r, vec2(sdBox(p - vec3(-1.1, 0.25, 0.0), vec3(0.14, 0.025, 0.7)), M_WOOD));
  if (gFish > 0.5) {
    // Rybář sedí a drží prut nad vodou.
    vec3 hand = vec3(-0.85, 0.7, 0.2);
    r = U(r, person(p, vec3(-1.1, 0.3, 0.0), 0.12, hand, hand + vec3(0.08, -0.12, 0.0), M_JACKET, 0.0));
    r = U(r, vec2(sdEllipsoid(p - vec3(-0.98, 1.08, 0.0), vec3(0.17, 0.035, 0.17)), M_HAT));
    float bend = sin(gTime * 1.3) * 0.04;
    r = U(r, vec2(sdCapsule(p, hand, vec3(1.9, 2.1 + bend, 1.1), 0.014), M_DARK));
  } else {
    // Veslař stojí na zádi s dlouhým veslem (Stehruder) na boku.
    float sw = sin(gPhase);
    float x0 = -3.0;
    vec3 hip = vec3(x0, 0.85, 0.0);
    float legs = min(sdCapsule(p, vec3(x0 - 0.05, -0.08, -0.12), hip + vec3(0.0, 0.0, -0.1), 0.075),
                     sdCapsule(p, vec3(x0 + 0.1, -0.08, 0.12), hip + vec3(0.0, 0.0, 0.1), 0.075));
    r = U(r, vec2(legs, M_DARK));
    vec3 handle = vec3(x0 + 0.45 + 0.35 * sw, 1.25, 0.28);
    r = U(r, person(p, hip, 0.1 + 0.08 * sw, handle + vec3(0.0, 0.0, -0.12), handle, M_JACKET, 0.0));
    r = U(r, vec2(sdEllipsoid(p - vec3(x0 + 0.1 + 0.08 * sw, 1.68, 0.0), vec3(0.17, 0.035, 0.17)), M_HAT));
    vec3 pivot = vec3(x0 + 0.15, 0.44, 0.85);
    vec3 dir = normalize(pivot - handle);
    vec3 blade = pivot + dir * 2.4;
    r = U(r, vec2(sdCapsule(p, handle, blade, 0.022), M_WOOD));
    r = U(r, vec2(sdCapsule(p, blade - dir * 0.6, blade, 0.07), M_WOOD));
  }
  return r;
}

vec2 canoe(vec3 p) {
  float hl = 2.6;
  vec3 q = p;
  q.y -= 0.24 * pow(abs(q.x / hl), 4.0);    // konce se zvedají
  float outer = sdEllipsoid(q - vec3(0.0, 0.06, 0.0), vec3(hl, 0.38, 0.45));
  float gun = 0.27;
  float shell = max(abs(outer) - 0.022, q.y - gun);
  float mat = q.y > gun - 0.035 ? M_WOOD : (outer < 0.0 ? M_INSIDE : M_HULL);
  vec2 r = vec2(shell, mat);
  // Sedačky.
  r = U(r, vec2(sdBox(p - vec3(1.55, 0.14, 0.0), vec3(0.1, 0.02, 0.36)), M_WOOD));
  r = U(r, vec2(sdBox(p - vec3(-1.9, 0.16, 0.0), vec3(0.1, 0.02, 0.33)), M_WOOD));
  // Dva pádlující: háček vpředu vpravo, zadák vzadu vlevo o chvilku později.
  r = U(r, canoePaddle(p, 1.5, 1.0, gPhase, M_JACKET));
  return U(r, canoePaddle(p, -1.95, -1.0, gPhase - 0.35, M_JACKET2));
}

vec2 kayak(vec3 p) {
  float hl = 2.3;
  vec3 q = p;
  q.y -= 0.12 * pow(abs(q.x / hl), 3.0);
  vec2 r = vec2(sdEllipsoid(q - vec3(0.0, -0.03, 0.0), vec3(hl, 0.25, 0.33)), M_HULL);
  // Obruba otvoru pro jezdce.
  vec2 e = (p.xz - vec2(0.05, 0.0)) / vec2(0.42, 0.24);
  float ring = length(vec2((length(e) - 1.0) * 0.24, p.y - 0.21)) - 0.025;
  r = U(r, vec2(ring, M_BLACK));
  // Dvoulisté pádlo: střídavě zabírá vlevo a vpravo.
  vec3 hip = vec3(0.0, 0.02, 0.0);
  vec3 c = hip + vec3(0.42, 0.52, 0.0);
  // List, který je dole ve vodě, se posouvá zepředu dozadu (záběr táhne loď vpřed).
  vec3 d = normalize(vec3(-0.3 * cos(gPhase), 0.55 * sin(gPhase), 1.0));
  r = U(r, vec2(sdCapsule(p, c - d * 1.1, c + d * 1.1, 0.015), M_BLACK));
  r = U(r, vec2(min(sdCapsule(p, c + d * 0.82, c + d * 1.1, 0.07), sdCapsule(p, c - d * 1.1, c - d * 0.82, 0.07)), M_HULL));
  return U(r, person(p, hip, 0.06, c - d * 0.33, c + d * 0.33, M_JACKET, 1.0));
}

// Potápění (gFish 0..1): pták se nakloní přídí dolů, hlava a krk pod vodou, ocas nahoru.
vec3 dabble(vec3 p, float angle, vec2 pivot) {
  float c = cos(angle), s = sin(angle);
  vec2 q = p.xy - pivot;
  return vec3(vec2(q.x * c - q.y * s, q.x * s + q.y * c) + pivot, p.z);
}

vec2 swan(vec3 p) {
  // Labuť velká: tělo s mírně zdviženými křídly, špičatý ocas, esovitý krk,
  // oranžový zobák s černým hrbolem.
  float dip = gFish;
  p = dabble(p, 0.6 * dip, vec2(0.2, 0.05));
  float nod = sin(gTime * 0.7 + gPhase) * 0.02 * (1.0 - dip);
  float body = sdEllipsoid(p - vec3(0.0, 0.1, 0.0), vec3(0.56, 0.2, 0.27));
  body = smin(body, sdEllipsoid(p - vec3(-0.08, 0.22, 0.0), vec3(0.42, 0.14, 0.23)), 0.08);
  body = smin(body, sdEllipsoid(p - vec3(-0.5, 0.2, 0.0), vec3(0.18, 0.07, 0.1)), 0.06);
  vec3 n0 = vec3(0.4, 0.2, 0.0);
  vec3 n1 = mix(vec3(0.54, 0.42, 0.0), vec3(0.62, 0.08, 0.0), dip);
  vec3 n2 = mix(vec3(0.49, 0.66, 0.0), vec3(0.74, -0.18, 0.0), dip);
  vec3 n3 = mix(vec3(0.56 + nod, 0.84, 0.0), vec3(0.78, -0.45, 0.0), dip);
  float neck = min(min(sdCapsule(p, n0, n1, 0.062), sdCapsule(p, n1, n2, 0.045)), sdCapsule(p, n2, n3, 0.037));
  body = smin(body, neck, 0.05);
  vec3 h = n3 + vec3(0.05, 0.02, 0.0);
  body = smin(body, sdEllipsoid(p - h, vec3(0.09, 0.05, 0.045)), 0.03);
  vec2 r = vec2(body, M_WHITE);
  r = U(r, vec2(sdCapsule(p, h + vec3(0.06, -0.005, 0.0), h + vec3(0.17, -0.04, 0.0), 0.022), M_BEAK));
  return U(r, vec2(length(p - h - vec3(0.07, 0.025, 0.0)) - 0.022, M_BLACK));
}

vec2 duck(vec3 p) {
  // Kachna divoká: kačer s lesklou zelenou hlavou, bílým obojkem a kaštanovou hrudí,
  // kachna hnědě kropenatá. Při hledání potravy ocas kolmo vzhůru.
  float dip = gFish;
  p = dabble(p, 1.25 * dip, vec2(0.08, 0.04));
  float bob = sin(gTime * 2.1 + gPhase) * 0.01 * (1.0 - dip);
  float body = sdEllipsoid(p - vec3(0.0, 0.08, 0.0), vec3(0.26, 0.1, 0.13));
  body = smin(body, sdEllipsoid(p - vec3(-0.22, 0.13, 0.0), vec3(0.09, 0.035, 0.055)), 0.04);
  vec3 head = vec3(0.19, 0.24 + bob, 0.0);
  float neck = sdCapsule(p, vec3(0.13, 0.12, 0.0), head - vec3(0.01, 0.03, 0.0), 0.045);
  float skull = sdEllipsoid(p - head, vec3(0.07, 0.055, 0.05));
  float mat = p.x > 0.1 && p.y < 0.17 ? M_CHEST : M_DUCK;
  vec2 r = vec2(body, mat);
  float hd = smin(neck, skull, 0.03);
  float ring = abs(p.y - 0.165) < 0.012 && p.x > 0.1 ? 1.0 : 0.0;
  r = U(r, vec2(hd, ring > 0.5 ? M_COLLAR : M_DUCKHEAD));
  r = U(r, vec2(sdEllipsoid(p - head - vec3(0.085, -0.015, 0.0), vec3(0.055, 0.014, 0.026)), M_BILL));
  return r;
}

vec2 skaterBody(vec3 p) {
  // Bruslař: předklon, odraz nohou do stran a dozadu střídavě, paže kmitají proti nohám.
  float s = sin(gPhase);
  float glide = gFish;                     // 1 = stojí (povídá si), 0 = jede
  s *= 1.0 - glide;
  float lean = mix(0.28, 0.04, glide);
  vec3 hip = vec3(0.0, mix(0.88, 0.95, glide) - 0.04 * abs(s), 0.0);
  vec3 footL = vec3(-0.05 - 0.3 * max(s, 0.0), 0.06, -0.13 - 0.38 * max(s, 0.0));
  vec3 footR = vec3(-0.05 - 0.3 * max(-s, 0.0), 0.06, 0.13 + 0.38 * max(-s, 0.0));
  vec3 kneeL = mix(hip, footL, 0.5) + vec3(0.14 * (1.0 - glide), 0.0, 0.0);
  vec3 kneeR = mix(hip, footR, 0.5) + vec3(0.14 * (1.0 - glide), 0.0, 0.0);
  float legs = min(min(sdCapsule(p, hip + vec3(0.0, 0.0, -0.1), kneeL, 0.075), sdCapsule(p, kneeL, footL, 0.065)),
                   min(sdCapsule(p, hip + vec3(0.0, 0.0, 0.1), kneeR, 0.075), sdCapsule(p, kneeR, footR, 0.065)));
  vec2 r = vec2(legs, M_DARK);
  // Boty s nožem.
  float boots = min(sdCapsule(p, footL, footL + vec3(0.18, -0.02, 0.0), 0.06), sdCapsule(p, footR, footR + vec3(0.18, -0.02, 0.0), 0.06));
  r = U(r, vec2(boots, M_BLACK));
  float blades = min(sdBox(p - footL - vec3(0.08, -0.07, 0.0), vec3(0.2, 0.012, 0.006)),
                     sdBox(p - footR - vec3(0.08, -0.07, 0.0), vec3(0.2, 0.012, 0.006)));
  r = U(r, vec2(blades, M_BLADE));
  vec3 neck = hip + vec3(lean, 0.55, 0.0);
  r = U(r, vec2(sdCapsule(p, hip + vec3(0.0, 0.05, 0.0), neck - vec3(0.0, 0.04, 0.0), 0.165), M_JACKET));
  vec3 head = neck + vec3(0.04, 0.2, 0.0);
  r = U(r, vec2(length(p - head) - 0.105, M_SKIN));
  r = U(r, vec2(sdEllipsoid(p - head - vec3(-0.01, 0.06, 0.0), vec3(0.11, 0.07, 0.11)), M_CAP));
  vec3 shL = neck + vec3(-0.02, -0.07, -0.19), shR = neck + vec3(-0.02, -0.07, 0.19);
  vec3 handL = shL + mix(vec3(0.35 * s, -0.42, -0.12), vec3(0.05, -0.5, -0.05), glide);
  vec3 handR = shR + mix(vec3(-0.35 * s, -0.42, 0.12), vec3(0.05, -0.5, 0.05), glide);
  r = U(r, vec2(min(sdCapsule(p, shL, handL, 0.05), sdCapsule(p, shR, handR, 0.05)), M_JACKET));
  return r;
}

vec2 skater(vec3 p) {
  // Děti jsou menší (gSeed < 0.25).
  float size = gSeed < 0.25 ? 0.65 : 0.92 + 0.16 * gSeed;
  vec2 r = skaterBody(p / size);
  r.x *= size;
  return r;
}

vec2 model(vec3 p) {
  if (gType < 0.5) return platte(p);
  if (gType < 1.5) return canoe(p);
  if (gType < 2.5) return kayak(p);
  if (gType < 3.5) return swan(p);
  if (gType < 4.5) return duck(p);
  return skater(p);
}

// Pohupování na vlnách; pod hladinou nic (voda je nakreslená dřív).
vec2 scene(vec3 p) {
  float bob = sin(gTime * 1.7 + gPhase * 0.3) * 0.025;
  float roll = sin(gTime * 1.3 + 1.0) * 0.03;
  vec3 q = p;
  q.y -= bob + q.z * roll;
  vec2 r = model(q);
  r.x = max(r.x, -p.y);
  return r;
}

// Normála (4 body), materiál a zastínění jednou smyčkou: scene() se tak do shaderu
// vloží jen jednou (každé další volání by překlad prodloužilo o sekundy).
void surfaceInfo(vec3 p, float e, out vec3 n, out float material, out float ao) {
  vec2 k = vec2(1.0, -1.0);
  vec3 sum = vec3(0.0);
  n = vec3(0.0, 1.0, 0.0);
  material = 0.0;
  ao = 1.0;
  for (int i = 0; i < 6 * uOne; i++) {
    vec3 o = i == 0 ? k.xyy : i == 1 ? k.yyx : i == 2 ? k.yxy : k.xxx;
    vec3 q = i < 4 ? p + o * e : i == 4 ? p : p + n * 0.12;
    vec2 r = scene(q);
    if (i < 4) sum += o * r.x;
    if (i == 3) n = normalize(sum);
    if (i == 4) material = r.y;
    if (i == 5) ao = clamp(0.35 + 0.65 * r.x / 0.12, 0.0, 1.0);
  }
}

vec3 albedo(float m, vec3 p) {
  if (m == M_HULL) {
    // Plätte: prkna s tmavými spárami.
    return gType < 0.5 ? vHull * (0.8 + 0.2 * step(0.12, fract(p.y / 0.14 + 0.3))) : vHull;
  }
  if (m == M_INSIDE) return gType < 0.5 ? vec3(0.20, 0.13, 0.07) : vHull * 0.55;
  if (m == M_WOOD) return vec3(0.30, 0.19, 0.10);
  if (m == M_SKIN) return vec3(0.42, 0.26, 0.18);
  if (m == M_JACKET) return gType > 4.5 ? vHull : gType < 0.5 ? vec3(0.07, 0.13, 0.09) : vec3(0.05, 0.10, 0.28);
  if (m == M_BLADE) return vec3(0.6, 0.62, 0.65);
  if (m == M_CAP) return vHull.bgr * 0.8 + 0.05;
  if (m == M_JACKET2) return vec3(0.30, 0.28, 0.24);
  if (m == M_WHITE) return vec3(0.82, 0.82, 0.79);
  if (m == M_BEAK) return vec3(0.75, 0.22, 0.03);
  if (m == M_VEST) return vec3(0.80, 0.16, 0.03);
  if (m == M_HAT) return vec3(0.10, 0.12, 0.08);
  if (m == M_DARK) return vec3(0.05, 0.05, 0.06);
  // Kachny: kačer (gSeed > 0.45) a kachna.
  bool drake = gSeed > 0.45;
  float mottle = 0.75 + 0.5 * hash12(floor(p.xz * 60.0) + floor(p.y * 60.0));
  if (m == M_DUCK) return drake ? vec3(0.34, 0.32, 0.29) : vec3(0.26, 0.17, 0.09) * mottle;
  if (m == M_CHEST) return drake ? vec3(0.22, 0.08, 0.04) : vec3(0.28, 0.19, 0.10) * mottle;
  if (m == M_DUCKHEAD) return drake ? vec3(0.01, 0.10, 0.04) : vec3(0.24, 0.16, 0.09) * mottle;
  if (m == M_COLLAR) return drake ? vec3(0.8) : vec3(0.24, 0.16, 0.09);
  if (m == M_BILL) return drake ? vec3(0.65, 0.55, 0.05) : vec3(0.45, 0.25, 0.08);
  return vec3(0.02);
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  gType = vShape.z;
  gPhase = vMotion.x;
  gFish = vFishing;
  gTime = uTime;
  gSeed = vWorld.z;
  vec2 uv = gl_FragCoord.xy / uPixels;
  bool mirror = vMirror > 0.5;
  // Odraz se na vlnkách mírně vlní.
  if (mirror) uv.x += sin(gl_FragCoord.y * 0.9 + uTime * 2.3) * 1.2 / uPixels.x;
  vec3 rd = rayDirection(uv);
  vec3 cam = vec3(0.0, CAMERA_HEIGHT, 0.0);
  if (mirror) { cam.y = -cam.y; rd.y = -rd.y; }
  // Do soustavy loďky (metry): příď +x, pravobok +z.
  float heading = vShape.w;
  vec3 fwd = vec3(sin(heading), 0.0, cos(heading));
  vec3 side = vec3(cos(heading), 0.0, -sin(heading));
  vec3 rel = (cam - vec3(vWorld.x, 0.0, vWorld.y)) * 1000.0;
  vec3 ro = vec3(dot(rel, fwd), rel.y, dot(rel, side));
  vec3 dir = vec3(dot(rd, fwd), rd.y, dot(rd, side));

  // Obalová koule, v ní hledání povrchu.
  float radius = (gType < 0.5 ? 4.3 : gType < 1.5 ? 3.1 : gType < 2.5 ? 2.6 : gType < 3.5 ? 1.0 : gType < 4.5 ? 0.45 : 1.1) + 0.8;
  vec3 center = vec3(0.0, gType > 2.5 ? 0.4 : 0.9, 0.0);
  vec3 oc = ro - center;
  float b = dot(oc, dir);
  float disc = b * b - dot(oc, oc) + radius * radius;
  float lantern = gType < 0.5 ? vMotion.z : 0.0;
  if (disc < 0.0 && lantern <= 0.0) discard;
  float sq = sqrt(max(disc, 0.0));
  float t = max(-b - sq, 0.0), tEnd = disc < 0.0 ? t : -b + sq;
  float pix = uSpan / uPixels.y;
  float best = 1e9, bestT = t;
  bool hit = false;
  for (int i = 0; i < 90 * uOne; i++) {
    if (t >= tEnd) break;
    float d = scene(ro + dir * t).x;
    float e = pix * t;
    float ratio = d / e;
    if (ratio < best) { best = ratio; bestT = t; }
    if (d < e * 0.25) { hit = true; break; }
    t += max(d * 0.8, e * 0.4);
  }
  // Pokrytí pixelu: zásah celý, těsné minutí (tenké pádlo) částečně.
  float cover = hit ? 1.0 : 1.0 - smoothstep(0.25, 1.0, best);
  vec3 p = ro + dir * (hit ? t : bestT);
  vec3 c = vec3(0.0);
  if (cover > 0.0) {
    vec3 n;
    float m, ao;
    surfaceInfo(p, max(pix * bestT * 0.5, 0.004), n, m, ao);
    vec3 base = albedo(m, p);
    // Světlo v soustavě loďky: slunce se stínem hor, obloha, odraz od vody, měsíc.
    vec3 sunL = vec3(dot(uSun, fwd), uSun.y, dot(uSun, side));
    vec3 moonL = vec3(dot(uMoon, fwd), uMoon.y, dot(uMoon, side));
    float shade = texture(uShadow, vWaterUv).r;
    if (uSun.y < -0.03) shade = 1.0;
    vec3 zenith, horizon;
    palette(uSun.y, zenith, horizon);
    vec3 sky = mix(horizon, zenith, 0.5 + 0.5 * n.y) * (0.55 + 0.45 * n.y);
    vec3 bounce = mix(horizon, zenith, 0.4) * 0.25 * max(-n.y, 0.0);
    float diffuse = max(dot(n, sunL), 0.0);
    c = base * (sunLight() * diffuse * shade + (sky * 0.9 + bounce) * ao + moonLight() * max(dot(n, moonL), 0.0) * 1.5);
    // Lesk laku na trupu a na pádlech, slabší na peří.
    float gloss = (m == M_HULL || m == M_WOOD || m == M_DUCKHEAD || m == M_BLADE) ? 0.25 : (m == M_WHITE ? 0.08 : 0.04);
    c += sunLight() * shade * gloss * pow(max(dot(reflect(dir, n), sunL), 0.0), 30.0);
    // U hladiny tmavší (vlhko, stín trupu).
    c *= mix(0.6, 1.0, smoothstep(0.0, 0.12, p.y));
  }
  // Lucerna na přídi Plätte za soumraku a v noci.
  float lanternLight = 0.0;
  vec3 lanternColor = vec3(0.0);
  if (lantern > 0.0) {
    vec3 L = vec3(3.55, 1.25, 0.0);
    float along = max(dot(L - ro, dir), 0.0);
    vec3 off = ro + dir * along - L;
    if (mirror) {
      // Na vlnkách se světlo protáhne do svislého třpytivého sloupce až k loďce.
      off.y *= 0.12;
      off.x *= 0.7 + 0.3 * sin(gl_FragCoord.y * 1.7 + uTime * 6.0);
    }
    float dl = length(off);
    float core = 1.0 - smoothstep(0.08, 0.14, dl);
    float glow = exp(-dl * dl * 2.5) * lantern;
    if (mirror) {
      float sparkle = 0.55 + 0.45 * sin(gl_FragCoord.y * 2.3 + uTime * 9.0) * sin(gl_FragCoord.y * 0.7 - uTime * 4.0);
      lanternLight = (core * 0.8 + glow * 0.5) * lantern * sparkle;
      lanternColor = vec3(1.0, 0.6, 0.25) * 2.2;
    } else {
      c = mix(c, vec3(4.0, 2.4, 1.0), core * lantern);
      c += vec3(1.0, 0.6, 0.25) * glow * 0.8;
      cover = max(cover, max(core * lantern, glow * 0.6));
    }
  }
  // Vzduch: vzdálené loďky splývají s oparem.
  float haze = 1.0 - exp(-vMotion.w * 0.2);
  c = mix(c, skyColor(vec3(0.0, 0.02, 1.0)) * 0.9, haze);
  float alpha = cover * vMotion.y;
  if (mirror) {
    // Odraz: tmavší, u hladiny nejsilnější; odlesk lucerny zvlášť (sahá dál).
    alpha *= 0.55 * (1.0 - smoothstep(0.0, 2.2, p.y));
    c *= 0.65;
    c = (c * alpha + lanternColor * lanternLight) / max(alpha + lanternLight * 0.5, 1e-4);
    alpha = min(1.0, alpha + lanternLight * 0.5);
  }
  if (alpha < 0.003) discard;
  c = aces(c * uExposure);
  c = pow(c, vec3(uContrast / 2.2));
  outColor = vec4(c * alpha, alpha);
}`;

export async function createBoats(gl, { map, random, config }) {
  const program = await createProgramAsync(gl, VS, FS, 'boats');
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  const data = new Float32Array(MAX_DRAWN * 2 * FLOATS);
  const wakes = new Float32Array(MAX_BOATS * 4);
  const boats = [];

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  const attribute = (name, offset) => {
    const location = program.attributes[name];
    if (location === undefined || location < 0) return;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, FLOATS * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  };
  attribute('aScreen', 0);
  attribute('aShape', 4);
  attribute('aMotion', 8);
  attribute('aColor', 12);
  attribute('aWorld', 16);
  gl.bindVertexArray(null);

  // Voda s odstupem od břehu (km).
  const water = (x, z, clearance = 0.02) => {
    if (map.sample(x, z) > -0.003) return false;
    for (let a = 0; a < 6; a++) {
      const angle = (a / 6) * Math.PI * 2;
      if (map.sample(x + Math.cos(angle) * clearance, z + Math.sin(angle) * clearance) > -0.001) return false;
    }
    return true;
  };

  // Místo u břehu (10–30 m od něj), kde se drží kachny.
  function shoreSpot() {
    for (let i = 0; i < 600; i++) {
      const z = 0.1 + random() * 0.3;
      const x = (random() - 0.5) * 1.2 * z;
      if (water(x, z, 0.01) && !water(x, z, 0.03)) return [x, z];
    }
    return randomSpot();
  }

  // Kluziště na ledu u kamery (stejné jako RINK ve vodním shaderu, km).
  const RINK = [0.0, 0.14, 0.042, 0.026];
  function rinkSpot() {
    for (let i = 0; i < 200; i++) {
      const a = random() * Math.PI * 2, r = Math.sqrt(random()) * 0.8;
      const x = RINK[0] + Math.cos(a) * r * RINK[2], z = RINK[1] + Math.sin(a) * r * RINK[3];
      if (water(x, z, 0.005)) return [x, z];
    }
    return [RINK[0], RINK[1]];
  }

  // Náhodné místo na jezeře v zorném poli kamery.
  function randomSpot() {
    for (let i = 0; i < 400; i++) {
      // Blíž ke kameře, ať jsou loďky vidět (dál než 500 m by byly pár pixelů).
      const z = 0.1 + random() * 0.38;
      const x = (random() - 0.5) * 1.2 * z;
      if (water(x, z, 0.03)) return [x, z];
    }
    return [0, 0.5];
  }

  // Barvy bund bruslařů (lineárně).
  const JACKETS = [[0.45, 0.04, 0.04], [0.03, 0.12, 0.35], [0.5, 0.35, 0.02], [0.04, 0.25, 0.12],
    [0.35, 0.05, 0.25], [0.6, 0.6, 0.62], [0.06, 0.06, 0.07], [0.02, 0.3, 0.4]];

  function add(kind, flock) {
    const type = TYPES[kind];
    const skater = kind === 'bruslar';
    const [x, z] = skater ? rinkSpot() : flock ? near(flock) : randomSpot();
    boats.push({
      kind, type, x, z, heading: random() * Math.PI * 2, speed: 0, flock,
      target: skater ? rinkSpot() : flock ? near(flock) : randomSpot(), rest: 0, phase: random() * 10, fade: 1, seed: random(),
      dip: 0, dipClock: random() * 20,
      hull: skater ? JACKETS[Math.floor(random() * JACKETS.length)] : null,
      pace: skater ? 0.45 + random() * 0.7 : 1,
    });
  }

  // Místo kousek od středu hejna (do 12 m), na vodě.
  function near(flock) {
    for (let i = 0; i < 40; i++) {
      const x = flock.x + (random() - 0.5) * 0.024, z = flock.z + (random() - 0.5) * 0.024;
      if (water(x, z, 0.004)) return [x, z];
    }
    return [flock.x, flock.z];
  }

  const fleet = config.lodky;
  for (let i = 0; i < fleet.platte; i++) add('platte');
  for (let i = 0; i < fleet.kanoe; i++) add('kanoe');
  for (let i = 0; i < fleet.kajak; i++) add('kajak');
  for (let i = 0; i < fleet.labute; i++) add('labut');
  for (let i = 0; i < Math.min(fleet.bruslari ?? 0, MAX_DRAWN - boats.length); i++) add('bruslar');
  const ducks = Math.min(fleet.kachny ?? 0, MAX_DRAWN - boats.length);
  if (ducks > 0) {
    const [fx, fz] = shoreSpot();
    const flock = { x: fx, z: fz };
    for (let i = 0; i < ducks; i++) add('kachna', flock);
  }

  let started = false;
  function step(dt, sun, ice = 0, rain = 0) {
    const evening = sun[1] < 0.02;
    // Po startu hned ve správném stavu (v zimě žádné loďky na ledu, večer žádné kánoe).
    const first = !started;
    started = true;
    for (const b of boats) {
      const t = b.type;
      // Kánoe a kajak jezdí jen ve dne, večer odplují (zmizí v dálce u břehu).
      const daytimeOnly = b.kind === 'kanoe' || b.kind === 'kajak';
      // Na zamrzající jezero loďky nevyjíždějí; labutě a kachny zůstávají na volné vodě.
      // Bruslaři jen na zamrzlém jezeře a za světla, ptáci jen na volné vodě.
      const bird = b.kind === 'labut' || b.kind === 'kachna';
      const skater = b.kind === 'bruslar';
      // Za deště a v bouřce kánoe a kajak odplují (Plätte s rybářem vydrží přeháňku).
      const wanted = skater ? (ice > 0.7 && sun[1] > -0.03 && rain < 0.3 ? 1 : 0)
        : (daytimeOnly && (evening || rain > 0.35)) || (bird ? ice > 0.5 : ice > 0.25) || (b.kind === 'platte' && rain > 0.8) ? 0 : 1;
      b.fade = first ? wanted : b.fade + (wanted - b.fade) * (1 - Math.exp(-dt / 8));
      if (b.rest > 0) {
        b.rest -= dt;
        b.speed *= Math.exp(-dt / 2);
      } else {
        const dx = b.target[0] - b.x, dz = b.target[1] - b.z;
        const distance = Math.hypot(dx, dz);
        if (distance < (b.flock ? 0.002 : 0.02)) {
          if (b.flock && random() < 0.03) {
            // Hejno se občas přesune jinam podél břehu.
            [b.flock.x, b.flock.z] = shoreSpot();
          }
          b.target = b.flock ? near(b.flock) : randomSpot();
          if (b.kind === 'kachna') b.rest = 5 + random() * 25;
          if (b.kind === 'bruslar') {
            b.target = rinkSpot();
            if (random() < 0.2) b.rest = 5 + random() * 20;   // zastaví a povídá si
          }
          // Rybář na Plätte zastaví a chytá.
          if (b.kind === 'platte' && random() < 0.6) b.rest = 30 + random() * 60;
          if (b.kind === 'labut' && random() < 0.5) b.rest = 10 + random() * 30;
        }
        const want = Math.atan2(dx, dz);
        let turn = want - b.heading;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        b.heading += Math.max(-t.turn * dt, Math.min(t.turn * dt, turn));
        const cruise = t.speed * b.pace * (Math.abs(turn) > 1 ? 0.4 : 1);
        b.speed += (cruise - b.speed) * (1 - Math.exp(-dt / 3));
      }
      const nx = b.x + Math.sin(b.heading) * b.speed * dt;
      const nz = b.z + Math.cos(b.heading) * b.speed * dt;
      if (water(nx, nz, b.flock ? 0.004 : 0.012)) {
        b.x = nx;
        b.z = nz;
      } else {
        b.target = b.kind === 'bruslar' ? rinkSpot() : b.flock ? near(b.flock) : randomSpot();
        b.speed *= 0.5;
      }
      // Labutě a kachny při odpočinku občas strčí hlavu pod vodu (ocas nahoru).
      if ((b.kind === 'labut' || b.kind === 'kachna') && b.rest > 0) {
        b.dipClock += dt;
        const wave = 0.5 + 0.5 * Math.sin(b.dipClock * (b.kind === 'kachna' ? 0.7 : 0.4) - 1.5);
        const want = Math.min(1, Math.max(0, (wave - 0.6) / 0.25));
        b.dip += (want - b.dip) * (1 - Math.exp(-dt * 3));
      } else {
        b.dip *= Math.exp(-dt * 3);
      }
      // Záběry pádlem, u stojící loďky pomalé pohupování.
      b.phase += dt * (b.rest > 0 ? 0.6 : 2.4 + 400 * b.speed);
    }
  }

  function project(x, z, world, pixels) {
    let sx = x / z;
    if (world.mirror) sx = -sx;
    const u = sx / (world.aspect * world.span) + 0.5;
    const v = -0.012 / z / world.span + world.horizon;
    return [u * pixels[0], v * pixels[1]];
  }

  return {
    step,
    /** Brázdy pro vodní shader: x, z (km), kurz, rychlost (km/s). */
    wakes() {
      wakes.fill(0);
      // Brázdu dělá jen to, co pluje po vodě (bruslaři na ledu ne), viditelné na hladině.
      boats.filter((b) => b.kind !== 'bruslar' && b.fade > 0.01).slice(0, MAX_BOATS)
        .forEach((b, i) => wakes.set([b.x, b.z, b.heading, b.speed * b.fade], i * 4));
      return wakes;
    },
    draw({ world, pixels, exposure, contrast, sun, moon, moonPhase, time, shadow, overcast = 0, flash = 0 }) {
      let n = 0;
      const lanternOn = Math.max(0, Math.min(1, (0.06 - sun[1]) / 0.08));
      for (const b of boats) {
        if (b.fade < 0.01 || b.z < 0.05) continue;
        const [px, py] = project(b.x, b.z, world, pixels);
        if (px < -50 || px > pixels[0] + 50) continue;
        const pxPerM = pixels[1] / (b.z * 1000 * world.span);
        // Délka na obrazovce podle úhlu mezi kurzem a směrem pohledu.
        const view = Math.atan2(b.x, b.z);
        const rel = b.heading - view;
        const length = Math.abs(Math.sin(rel)) * b.type.length * 1000 + Math.abs(Math.cos(rel)) * b.type.beam * 1000;
        const fishing = b.kind === 'platte' || b.kind === 'bruslar' ? (b.rest > 0 ? 1 : 0) : b.dip;
        const lantern = b.kind === 'platte' ? lanternOn : 0;
        if (n + 2 > MAX_DRAWN * 2) break;
        for (const mirror of [1, 0]) {
          data.set([px, py, pxPerM, mirror, length, b.type.beam * 1000, b.type.id, b.heading,
            b.phase, b.fade, lantern, b.z, ...(b.hull || b.type.hull), fishing, b.x, b.z, b.seed, 0], n * FLOATS);
          n++;
        }
      }
      if (!n) return;
      gl.useProgram(program.program);
      const u = program.u;
      gl.uniform2f(u.uPixels, pixels[0], pixels[1]);
      gl.uniform1f(u.uExposure, exposure);
      gl.uniform1f(u.uContrast, contrast);
      gl.uniform3f(u.uSun, ...sun);
      gl.uniform3f(u.uMoon, ...moon);
      gl.uniform1f(u.uMoonPhase, moonPhase);
      gl.uniform1f(u.uOvercast, overcast);
      gl.uniform1f(u.uFlash, flash);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uAspect, world.aspect);
      gl.uniform1f(u.uSpan, world.span);
      gl.uniform1f(u.uHorizon, world.horizon);
      gl.uniform1f(u.uMirror, world.mirror ? 1 : 0);
      gl.uniform1i(u.uOne, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shadow || null);
      gl.uniform1i(u.uShadow, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * FLOATS);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },
    get count() { return boats.filter((b) => b.fade > 0.5).length; },
    get list() { return boats.map((b) => ({ kind: b.kind, x: +b.x.toFixed(3), z: +b.z.toFixed(3), speed: +(b.speed * 1000).toFixed(2), rest: b.rest > 0 })); },
  };
}
