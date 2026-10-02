// Žulové balvany v popředí na okraji Úpské jámy jako skutečné 3D tvary (vzdálenostní funkce),
// ne výšková mapa: mrazem rozpukané bloky krkonošské žuly se zaoblenými hranami, lomovými
// plochami a hrbolatým povrchem, kolem nich menší kameny. Výšková mapa by měla v této vzdálenosti
// schody na obrysu a neuměla by strmé ani převislé boky.
//
// Kreslí se ve dvou krocích: balvan do obrazu scény (projde pak deštěm, sněžením, září
// a úpravou barev jako zbytek krajiny) a jeho odraz po posledním průchodu, přes hladinu
// (jako u loděk). Každý balvan je obdélník na obrazovce, v něm se hledá povrch paprskem.

import { createProgramAsync } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';

// Velké balvany: x, z (km), šířka, výška nad zemí, hloubka (m), natočení (rad).
// Leží na plošině před hranou jámy (hrana je asi 40 m před kamerou), po stranách výhledu,
// ať nezakryjí Sněžku.
const BIG = [
  [-0.0098, 0.023, 2.4, 1.1, 1.9, 0.4],
  [-0.0128, 0.029, 1.5, 0.8, 1.3, -0.6],
  [0.0108, 0.026, 2.0, 0.9, 1.6, 1.0],
  [0.0138, 0.035, 1.3, 0.7, 1.1, 0.2],
  [-0.0052, 0.041, 1.0, 0.5, 0.9, 0.9],
];
const FLOATS = 12;

// Náhodná čísla se semínkem: balvany mají při každém startu stejný tvar.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seznam balvanů: [x, z, šířka, výška, hloubka, natočení, semínko] (km a m). */
export function boulderList() {
  const random = seeded(0x9e3779b9);
  const list = BIG.map(([x, z, w, h, d, yaw]) => [x, z, w, h, d, yaw, random()]);
  // Kreslí se odzadu dopředu (bližší kámen překryje vzdálenější), kamera stojí v počátku.
  for (const [bx, bz, w] of BIG) {
    for (let k = 0; k < 6; k++) {
      const a = random() * Math.PI * 2, dist = (w * 0.5 + 1.5 + random() * w * 0.9) / 1000;
      const size = 0.6 + random() * 1.6;
      list.push([bx + Math.cos(a) * dist, bz + Math.sin(a) * dist * 0.8,
        size * (1 + random() * 0.5), size * (0.35 + random() * 0.35), size * (0.8 + random() * 0.4),
        random() * Math.PI, random()]);
    }
  }
  return list.sort((a, b) => Math.hypot(b[0], b[1]) - Math.hypot(a[0], a[1]));
}

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec4 aPlace;     // x, z (km), natočení, semínko
in vec4 aSize;      // šířka, výška, hloubka (m), zrcadlo (1 = odraz)
in float aGround;   // výška země pod balvanem (km n. m.)
uniform vec2 uPixels;
out vec4 vPlace;
out vec4 vSize;
out float vGround;
${NOISE}
${CAMERA}
const vec2 CORNERS[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, -1), vec2(1, 1), vec2(-1, 1));
void main() {
  vPlace = aPlace;
  vSize = aSize;
  vGround = aGround;
  vec2 c = CORNERS[gl_VertexID];
  float radius = length(aSize.xyz * vec3(0.5, 1.0, 0.5)) * 1.15 / 1000.0;   // km
  float mirror = aSize.w > 0.5 ? -1.0 : 1.0;
  vec3 center = vec3(aPlace.x, aGround + mirror * aSize.y * 0.45 / 1000.0, aPlace.y) - vec3(0.0, CAMERA_HEIGHT, 0.0);
  vec2 uv = screenOf(center);
  // Poloměr koule na obrazovce (s rezervou) v jednotkách výšky obrazu.
  float r = radius / max(center.z - radius, 1e-4) / uSpan * 1.2;
  vec2 offset = c * vec2(r * uPixels.y / uPixels.x, r);
  gl_Position = vec4((uv + offset) * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec4 vPlace;
in vec4 vSize;
in float vGround;
uniform vec2 uPixels;
uniform float uExposure;
uniform float uContrast;
uniform float uTonemap;       // 1 = rovnou do obrazovky (odraz), 0 = do obrazu scény (HDR)
uniform float uWinter;
uniform float uIce;
uniform float uRainWet;       // déšť: mokrý kámen
uniform sampler2D uShadow;
uniform sampler2D uRock;
uniform vec3 uRockMean;
uniform sampler2D uScene;     // obraz scény: alfa 0 = voda (jen tam se kreslí odraz)
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}

vec3 gSize;
float gSeed;

// Tvar: zaoblený blok (superelipsoid), lomové plochy, hrboly a mělké prohlubně.
// Souřadnice v metrech, y nahoru od hladiny, x podél delší strany balvanu.
float shape(vec3 p) {
  vec3 a = gSize * vec3(0.5, 1.0, 0.5);
  vec3 q = p - vec3(0.0, a.y * 0.42, 0.0);
  // Spodek širší než vršek (balvan sedí), vršek mírně zkosený.
  q.xz *= 1.0 + 0.18 * clamp(q.y / a.y, -1.0, 1.0);
  q.y -= 0.12 * q.x * (gSeed - 0.5);
  vec3 r = q / (a * vec3(1.0, 0.62, 1.0));
  float n = 3.2;
  vec3 k = pow(abs(r), vec3(n));
  float d = (pow(k.x + k.y + k.z, 1.0 / n) - 1.0) * min(a.x, min(a.y * 0.62, a.z));
  // Lomové plochy: tři náhodně natočené roviny ořízly blok (měkce, hrana zaoblená).
  for (int i = 0; i < 3; i++) {
    float t = gSeed * 17.0 + float(i) * 2.4;
    vec3 nrm = normalize(vec3(cos(t), 0.35 + 0.6 * fract(t * 3.7), sin(t)));
    float plane = dot(q, nrm) - dot(a * 0.62, abs(nrm)) * (0.78 + 0.1 * fract(t * 7.1));
    // Hrana mezi plochami zaoblená (poloměr úměrný balvanu), jinak by svítila jako linka.
    float k = 0.25 * min(a.x, a.z);
    float h = clamp(0.5 + 0.5 * (plane - d) / k, 0.0, 1.0);
    d = mix(d, plane, h) + k * h * (1.0 - h);
  }
  // Hrboly (desítky cm) a jemná zrnitost (centimetry, jen zblízka).
  vec3 w = p + gSeed * 40.0;
  d += (noise3(w * 0.55) * 0.2 + noise3(w * 1.7) * 0.035) * min(1.0, a.y);
  return d;
}

// Normála (4 body) a zastínění jednou smyčkou (shape() se vloží do shaderu jen jednou).
void surfaceInfo(vec3 p, float e, out vec3 n, out float ao) {
  vec2 k = vec2(1.0, -1.0);
  vec3 sum = vec3(0.0);
  n = vec3(0.0, 1.0, 0.0);
  ao = 1.0;
  for (int i = 0; i < 5 * uOne; i++) {
    vec3 o = i == 0 ? k.xyy : i == 1 ? k.yyx : i == 2 ? k.yxy : k.xxx;
    float d = shape(i < 4 ? p + o * e : p + n * 0.25);
    if (i < 4) sum += o * d;
    if (i == 3) n = normalize(sum);
    if (i == 4) ao = clamp(0.4 + 0.6 * d / 0.25, 0.0, 1.0);
  }
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  gSize = vSize.xyz;
  gSeed = vPlace.w;
  bool mirror = vSize.w > 0.5;
  if (mirror && uIce > 0.5) discard;
  // Odraz jen na vodě: ne přes bližší balvan, břeh ani loďku v obrazu scény.
  if (mirror && texelFetch(uScene, ivec2(gl_FragCoord.xy), 0).a > 0.5) discard;
  vec2 uv = gl_FragCoord.xy / uPixels;
  if (mirror) uv.x += sin(gl_FragCoord.y * 0.9 + uTime * 2.3) * 1.5 / uPixels.x;   // vlnky
  vec3 rd = rayDirection(uv);
  vec3 cam = vec3(0.0, CAMERA_HEIGHT, 0.0);
  if (mirror) { cam.y = -cam.y; rd.y = -rd.y; }
  // Do soustavy balvanu (metry).
  float yaw = vPlace.z;
  vec3 fwd = vec3(cos(yaw), 0.0, sin(yaw)), side = vec3(-sin(yaw), 0.0, cos(yaw));
  vec3 rel = (cam - vec3(vPlace.x, vGround, vPlace.y)) * 1000.0;
  vec3 ro = vec3(dot(rel, fwd), rel.y, dot(rel, side));
  vec3 dir = vec3(dot(rd, fwd), rd.y, dot(rd, side));

  float radius = length(gSize * vec3(0.5, 1.0, 0.5)) * 1.15;
  vec3 oc = ro - vec3(0.0, gSize.y * 0.45, 0.0);
  float b = dot(oc, dir);
  float disc = b * b - dot(oc, oc) + radius * radius;
  if (disc < 0.0) discard;
  float sq = sqrt(disc);
  float t = max(-b - sq, 0.0), tEnd = -b + sq;
  // Odraz: paprsek ze zrcadlené kamery pod hladinou začne až na hladině (jinak by ho
  // kontrola „pod hladinou už nic“ hned zastavila a u vody by zůstala světlá mezera).
  if (ro.y < 0.0 && dir.y > 0.0) t = max(t, -ro.y / dir.y);
  float pix = uSpan / uPixels.y;
  float best = 1e9, bestT = t;
  bool hit = false, ended = false;
  for (int i = 0; i < 110 * uOne; i++) {
    if (t >= tEnd) { ended = true; break; }
    vec3 p = ro + dir * t;
    if (p.y < -0.02) { ended = true; break; }        // pod hladinou už nic
    float d = shape(p);
    float e = pix * t;
    if (d / e < best) { best = d / e; bestT = t; }
    if (d < e * 0.3) { hit = true; break; }
    t += max(d * 0.7, e * 0.5);
  }
  // Paprsek, kterému došly kroky (klouže podél plochy), povrch skoro jistě zasáhl:
  // jinak by na boku prosvítala tenká linka pozadí.
  if (!hit && !ended && best < 3.0) { hit = true; bestT = t; }
  float cover = hit ? 1.0 : 1.0 - smoothstep(0.3, 1.0, best);
  if (cover <= 0.0) discard;
  vec3 p = ro + dir * (hit ? t : bestT);
  // Hladina ořízne spodek (obrys u vody jemně, přes pixel).
  cover *= smoothstep(-pix * bestT, pix * bestT, p.y);
  if (cover <= 0.0) discard;
  vec3 n;
  float aoShape;
  surfaceInfo(p, max(pix * bestT * 0.7, 0.01), n, aoShape);
  vec3 wn = fwd * n.x + vec3(0.0, n.y, 0.0) + side * n.z;   // normála ve světě

  // Žula: textura skutečné horniny, lišejníky, pata v trávě.
  vec3 tw = pow(abs(n), vec3(4.0));
  tw /= tw.x + tw.y + tw.z;
  vec3 wp = p + gSeed * 50.0;
  vec3 tex = (texture(uRock, wp.zy / 3.0).rgb * tw.x + texture(uRock, wp.xz / 3.0).rgb * tw.y + texture(uRock, wp.xy / 3.0).rgb * tw.z);
  tex = pow(tex, vec3(2.2)) / uRockMean;
  // Kontrast kresby textury zmírněný (tmavé důlky by vypadaly jako krátery).
  tex = mix(vec3(1.0), tex, 0.6);
  // Žula: šedá s narůžovělým nádechem živců, zvětralá do tmavších skvrn.
  vec3 tone = mix(vec3(0.12, 0.112, 0.105), vec3(0.09, 0.087, 0.083), noise3(wp * 0.25) * 0.5 + 0.5);
  vec3 stone = tone * tex * (0.85 + 0.25 * noise3(wp * 0.4));
  // Lišejníky: žlutozelené mapy (Rhizocarpon) a šedé až černé skvrny, víc na horních plochách.
  float lichen = smoothstep(0.55, 0.8, noise3(wp * 1.3 + 7.0) * 0.5 + 0.5);
  stone = mix(stone, vec3(0.17, 0.18, 0.07), lichen * 0.45 * smoothstep(-0.2, 0.6, n.y));
  float dark = smoothstep(0.6, 0.85, noise3(wp * 2.1 + 11.0) * 0.5 + 0.5);
  stone = mix(stone, vec3(0.05, 0.05, 0.045), dark * 0.4);
  // Pata kamene zarostlá trávou a vlhčí.
  float wet = 0.0;
  stone = mix(stone, stone * vec3(0.55, 0.6, 0.45), 1.0 - smoothstep(0.0, 0.25, p.y));
  // Mech a jehličí v úžlabinách nahoře, v zimě sníh na vodorovných plochách.
  float moss = smoothstep(0.55, 0.8, n.y) * smoothstep(0.6, 0.85, noise3(wp * 0.8 + 3.0) * 0.5 + 0.5);
  stone = mix(stone, vec3(0.05, 0.07, 0.03), moss * 0.5 * (1.0 - uWinter));
  float snow = uWinter * smoothstep(0.35, 0.75, n.y + 0.2 * noise3(wp * 1.5)) * smoothstep(0.3, 0.6, p.y);
  stone = mix(stone, vec3(0.82, 0.84, 0.88), snow);
  // Za deště je celý kámen mokrý: tmavší a lesklejší.
  stone *= 1.0 - 0.35 * uRainWet * (1.0 - snow);
  wet = max(wet, uRainWet * 0.6);

  // Světlo: slunce se stínem hor a vlastním stínem, obloha podle natočení, měsíc.
  float shade = texture(uShadow, screenOf(vec3(vPlace.x, vGround, vPlace.y) - vec3(0.0, CAMERA_HEIGHT, 0.0))).r;
  if (uSun.y < -0.03) shade = 1.0;
  vec3 sunL = vec3(dot(uSun, fwd), uSun.y, dot(uSun, side));
  float self = 1.0;
  if (dot(n, sunL) > 0.0 && uSun.y > 0.0) {
    float s = 0.03;
    for (int i = 0; i < 9; i++) {
      float h = shape(p + sunL * s);
      self = min(self, clamp(8.0 * h / s, 0.0, 1.0));
      s += max(h, 0.05 + 0.1 * s);
      if (s > 12.0) break;
    }
  }
  float ao = aoShape * mix(0.55, 1.0, smoothstep(0.0, 0.6, p.y));
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 sky = mix(horizon, zenith, 0.5 + 0.5 * wn.y) * (0.6 + 0.4 * wn.y);
  // Stín na kameni i sněhu je namodralý, ale ne sytě modrý (světlo odráží i okolí).
  sky = mix(sky, vec3(dot(sky, vec3(0.3, 0.5, 0.2))), 0.55);
  // V zimě prosvětluje stín světlo odražené od sněhu a ledu kolem.
  sky += vec3(dot(sunLight(), vec3(0.3, 0.5, 0.2))) * 0.12 * uWinter * max(uSun.y, 0.0) * (1.0 - 0.5 * wn.y);
  vec3 bounce = vec3(0.05, 0.07, 0.03) * max(-wn.y, 0.0);   // světlo od trávy zespodu
  // Měkký přechod do stínu: u rozhraní by jinak zářil tenký proužek.
  float diffuse = max(dot(n, sunL), 0.0) * smoothstep(0.0, 0.2, dot(n, sunL));
  vec3 c = stone * (sunLight() * diffuse * shade * self + (sky * 0.95 + bounce) * ao
                    + moonLight() * max(dot(wn, uMoon), 0.0) * 1.5);
  // Mokrý kámen (déšť) se leskne.
  vec3 refl = reflect(dir, n);
  c += sunLight() * shade * self * wet * 0.35 * pow(max(dot(refl, sunL), 0.0), 40.0);
  // Vzduch mezi kamenem a okem (stejně jako krajina).
  float dist = length(p) / 1000.0;
  vec3 transmit = exp(-vec3(0.020, 0.028, 0.042) * dist);
  c = c * transmit + skyColor(normalize(vec3(rd.x, 0.05, rd.z))) * 0.95 * (1.0 - transmit);
  if (mirror) {
    // Odraz: tmavší, u hladiny nejsilnější, s Fresnelem hladiny.
    cover *= 0.85 * mix(1.0, 0.6, smoothstep(0.0, gSize.y * 1.2, p.y));
    c *= 0.75;
  }
  if (uTonemap > 0.5) {
    c = aces(c * uExposure);
    c = pow(c, vec3(uContrast / 2.2));
  }
  outColor = vec4(c * cover, cover);
}`;

export async function createBoulders(gl, { map }) {
  const program = await createProgramAsync(gl, VS, FS, 'boulders');
  const list = boulderList();
  // Země pod balvanem: nejnižší bod pod jeho půdorysem (na svahu se nesmí vznášet).
  const ground = list.map(([x, z, w]) => {
    const r = (w * 0.5) / 1000;
    let low = Infinity;
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) low = Math.min(low, map.sampleFine(x + dx, z + dz));
    return low - 0.0002;
  });
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  const build = (mirror) => {
    const data = new Float32Array(list.length * 9);
    list.forEach(([x, z, w, h, d, yaw, seed], i) => data.set([x, z, yaw, seed, w, h, d, mirror, ground[i]], i * 9));
    return data;
  };
  const both = new Float32Array(list.length * 18);
  both.set(build(0), 0);
  both.set(build(1), list.length * 9);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, both, gl.STATIC_DRAW);
  for (const [name, offset, size] of [['aPlace', 0, 4], ['aSize', 4, 4], ['aGround', 8, 1]]) {
    const location = program.attributes[name];
    if (location === undefined || location < 0) continue;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 36, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);

  function draw(o, mirror) {
    const u = program.u;
    gl.useProgram(program.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, o.shadow || null);
    gl.uniform1i(u.uShadow, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, map.textures.rock.texture);
    gl.uniform1i(u.uRock, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, (mirror && o.scene) || null);
    gl.uniform1i(u.uScene, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(u.uRockMean, ...map.textures.rock.mean);
    const w = o.world;
    gl.uniform1f(u.uAspect, w.aspect);
    gl.uniform1f(u.uHorizon, w.horizon);
    gl.uniform1f(u.uSpan, w.span);
    gl.uniform1f(u.uMirror, w.mirror ? 1 : 0);
    gl.uniform2f(u.uSeed, ...w.seed);
    if (u.uOne) gl.uniform1i(u.uOne, 1);
    gl.uniform2f(u.uPixels, o.pixels[0], o.pixels[1]);
    gl.uniform1f(u.uTime, o.time);
    gl.uniform3f(u.uSun, ...o.sun);
    gl.uniform3f(u.uMoon, ...o.moon);
    gl.uniform1f(u.uMoonPhase, o.moonPhase);
    gl.uniform1f(u.uOvercast, o.overcast || 0);
    gl.uniform1f(u.uFlash, o.flash || 0);
    gl.uniform1f(u.uExposure, o.exposure);
    gl.uniform1f(u.uContrast, o.contrast);
    gl.uniform1f(u.uTonemap, mirror ? 1 : 0);
    gl.uniform1f(u.uWinter, o.season.winter);
    gl.uniform1f(u.uIce, o.ice || 0);
    gl.uniform1f(u.uRainWet, o.rain || 0);
    gl.enable(gl.BLEND);
    // Do obrazu scény: barva přes, alfa zůstane 1 (balvan je krajina, ne voda).
    if (mirror) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, list.length);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    // Textura obrazu scény nesmí zůstat navázaná (příští snímek do ní kreslí).
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  // Odraz a balvan kreslí stejné instance; zrcadlové jsou v druhé polovině bufferu.
  return {
    list,
    /** Balvany do obrazu scény (framebuffer scény je nastavený). */
    drawScene(o) { drawRange(o, false); },
    /** Odrazy přes hladinu, po posledním průchodu. */
    drawReflection(o) { drawRange(o, true); },
  };

  function drawRange(o, mirror) {
    // Instance pro odraz jsou za instancemi balvanů: posun začátku atributů.
    const location = [program.attributes.aPlace, program.attributes.aSize, program.attributes.aGround];
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const base = mirror ? list.length * 36 : 0;
    if (location[0] >= 0) gl.vertexAttribPointer(location[0], 4, gl.FLOAT, false, 36, base);
    if (location[1] >= 0) gl.vertexAttribPointer(location[1], 4, gl.FLOAT, false, 36, base + 16);
    if (location[2] >= 0) gl.vertexAttribPointer(location[2], 1, gl.FLOAT, false, 36, base + 32);
    gl.bindVertexArray(null);
    draw(o, mirror);
  }
}
