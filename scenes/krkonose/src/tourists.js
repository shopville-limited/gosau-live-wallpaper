// Turisté na pěšinách ke Sněžce: drobné postavy (1,7 m) chodí po skutečných trasách
// z OpenStreetMap (assets/cesty.json, © přispěvatelé OSM). Ze Studniční hory mají jen
// pár pixelů: barevné tečky bund, které se pomalu posouvají po cestě, do kopce pomaleji.
// Kolik jich je, záleží na denní době, ročním období, počasí a dni v týdnu; v noci nikdo.
// Kreslí se do obrazu scény po terénu a schovají se za bližší terén podle G-bufferu.

import { createProgramAsync } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';

const MAX = 64;

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec4 aWalker;    // x, y (zem), z (km), barva bundy (0..1)
in vec2 aStep;      // fáze kroku, sklon postavy do kopce
uniform vec2 uPixels;
out vec2 vLocal;
out float vColor;
out float vDistance;
out vec3 vWorld;
${NOISE}
${CAMERA}
const vec2 CORNERS[6] = vec2[6](vec2(-1, 0), vec2(1, 0), vec2(1, 1), vec2(-1, 0), vec2(1, 1), vec2(-1, 1));
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec3 base = aWalker.xyz;
  vec3 d = base - vec3(0.0, CAMERA_HEIGHT, 0.0);
  float x = d.x / d.z;
  if (uMirror > 0.5) x = -x;
  vec2 uv = vec2(x / (uAspect * uSpan) + 0.5, d.y / d.z / uSpan + uHorizon);
  // Výška 1,7 m, šířka 0,55 m; aspoň 3 px na výšku, ať postava zdálky nezmizí.
  float px = 1.0 / uPixels.y;
  float tall = max(0.0017 / d.z / uSpan, 3.0 * px);
  float wide = max(tall * 0.32, 1.5 * px);
  vec2 pos = uv + vec2(c.x * wide * 0.5 * uPixels.y / uPixels.x, c.y * tall);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  vLocal = c;
  vColor = aWalker.w;
  vDistance = length(d);
  vWorld = base;
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vLocal;
in float vColor;
in float vDistance;
in vec3 vWorld;
uniform vec2 uPixels;
uniform sampler2D uDepth;   // G-buffer: alfa = vzdálenost terénu (km)
uniform float uWinter;
uniform float uLamp;        // tma: z postavy je vidět jen čelovka
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}
void main() {
  float a = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).a;
  float terrain = a - 100.0 * floor(a / 100.0);
  if (a > 0.0 && a < 900.0 && terrain < vDistance - 0.003) discard;
  float y = vLocal.y, x = abs(vLocal.x);
  // Za tmy: jen světlo čelovky (bílé až nažloutlé), kulatá tečka u hlavy.
  if (uLamp > 0.5) {
    if (y < 0.7) discard;
    outColor = vec4(vec3(2.6, 2.45, 2.1) * (0.7 + 0.3 * vColor), 1.0);
    return;
  }
  // Silueta: hlava, trup s batohem, nohy.
  if (y > 0.88 && x > 0.45) discard;
  // Bunda: červená, modrá, žlutá, zelená, oranžová, šedá (v zimě víc tmavých).
  vec3 jackets[6] = vec3[6](vec3(0.55, 0.06, 0.05), vec3(0.06, 0.16, 0.5), vec3(0.6, 0.45, 0.04),
                            vec3(0.1, 0.32, 0.12), vec3(0.65, 0.22, 0.04), vec3(0.18, 0.18, 0.2));
  vec3 jacket = jackets[int(vColor * 5.99)];
  vec3 albedo = y > 0.88 ? vec3(0.35, 0.24, 0.18) : y > 0.45 ? jacket : vec3(0.06, 0.06, 0.07);
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 c = albedo * (sunLight() * 0.75 * max(uSun.y + 0.2, 0.0) + mix(horizon, zenith, 0.5) * 0.9);
  float dist = vDistance;
  vec3 transmit = exp(-vec3(0.020, 0.028, 0.042) * dist);
  c = c * transmit + skyColor(normalize(vec3(0.0, 0.05, 1.0))) * 0.95 * (1.0 - transmit);
  outColor = vec4(c, 1.0);
}`;

export async function createTourists(gl, { map, random, cameraHeight = 1.5088, view = 0.62 }) {
  const program = await createProgramAsync(gl, VS, FS, 'tourists');
  const data = await (await fetch(new URL('../assets/cesty.json', import.meta.url))).json();
  // Úseky tras s délkami (km) a výškou každého bodu.
  const trails = data.trails.map((t) => {
    const pts = t.points.map(([x, z]) => [x, map.sampleFine(x, z), z]);
    const lengths = [0];
    for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
    return { pts, lengths, total: lengths[lengths.length - 1] };
  }).filter((t) => t.total > 0.05);
  // Je bod vidět z kamery? Přímka od oka k hlavě turisty nesmí projít terénem a bod musí
  // být v zorném poli (|x/z| < view).
  const visible = ([x, y, z]) => {
    if (z < 0.05 || Math.abs(x / z) > view) return false;
    for (let k = 1; k < 40; k++) {
      const f = k / 40, h = cameraHeight + (y + 0.0017 - cameraHeight) * f;
      if (map.sampleFine(x * f, z * f) > h + 0.0005) return false;
    }
    return true;
  };
  // Váha trasy: délka úseků, které kamera vidí (jen tam má smysl posílat lidi).
  const seenParts = trails.map((t) => {
    const parts = [];
    for (let i = 1; i < t.pts.length; i++) if (visible(t.pts[i]) && visible(t.pts[i - 1])) parts.push(i);
    return parts;
  });
  const weights = trails.map((t, k) => seenParts[k].reduce((a, i) => a + t.lengths[i] - t.lengths[i - 1], 0));
  // Místo na viditelném úseku trasy (km od začátku).
  const placeOn = (k) => {
    const parts = seenParts[k], t = trails[k];
    if (!parts.length) return random() * t.total;
    const i = parts[Math.floor(random() * parts.length)];
    return t.lengths[i - 1] + random() * (t.lengths[i] - t.lengths[i - 1]);
  };
  const sum = weights.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = random() * sum;
    for (let i = 0; i < trails.length; i++) { r -= weights[i]; if (r <= 0) return i; }
    return trails.length - 1;
  };
  const walkers = Array.from({ length: MAX }, () => {
    const trail = pick();
    return { trail, s: placeOn(trail), dir: random() < 0.5 ? 1 : -1,
      speed: 0.0009 + random() * 0.0005, color: random(), rest: 0, rank: random() };
  });

  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  const values = new Float32Array(MAX * 6);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, values.byteLength, gl.DYNAMIC_DRAW);
  for (const [name, size, offset] of [['aWalker', 4, 0], ['aStep', 2, 16]]) {
    const location = program.attributes[name];
    if (location === undefined || location < 0) continue;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 24, offset);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);

  // Bod na trase ve vzdálenosti s (km) od začátku: [x, y, z, stoupání].
  function at(t, s) {
    let i = 1;
    while (i < t.lengths.length - 1 && t.lengths[i] < s) i++;
    const a = t.pts[i - 1], b = t.pts[i];
    const seg = t.lengths[i] - t.lengths[i - 1] || 1e-6;
    const u = Math.min(1, Math.max(0, (s - t.lengths[i - 1]) / seg));
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, (b[1] - a[1]) / seg];
  }

  let count = 0;
  return {
    /** Posune turisty o dt sekund; share = kolik z nich je na horách (0..1). */
    update(dt, share) {
      count = Math.round(MAX * Math.min(1, Math.max(0, share)));
      for (const w of walkers) {
        if (w.rest > 0) { w.rest -= dt; continue; }
        const t = trails[w.trail];
        const here = at(t, w.s);
        // Do kopce pomaleji (stoupání ve směru chůze), z kopce o něco rychleji.
        const climb = here[3] * w.dir;
        const speed = w.speed / (1 + Math.max(0, climb) * 6) * (climb < 0 ? 1.15 : 1);
        w.s += w.dir * speed * dt;
        if (w.s <= 0 || w.s >= t.total) {
          // Na konci úseku: chvíli postojí (výhled, svačina) a jde zpátky nebo jinou trasou.
          w.s = Math.min(t.total, Math.max(0, w.s));
          w.dir = -w.dir;
          w.rest = 20 + random() * 120;
          if (random() < 0.3) { w.trail = pick(); w.s = placeOn(w.trail); }
        } else if (random() < dt / 600) w.rest = 10 + random() * 40;   // občas zastaví
      }
    },
    draw(o) {
      if (count === 0) return;
      let n = 0;
      // Viditelní jen ti, kdo jsou před kamerou; pořadí podle rank, ať při malém počtu zůstanou stejní lidé.
      for (const w of walkers) {
        if (w.rank * MAX >= count) continue;
        const p = at(trails[w.trail], w.s);
        if (p[2] < 0.05) continue;
        values.set([p[0], p[1], p[2], w.color, 0, 0], n * 6);
        n++;
      }
      if (n === 0) return;
      const u = program.u;
      gl.useProgram(program.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, values.subarray(0, n * 6));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, o.depth);
      gl.uniform1i(u.uDepth, 0);
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
      gl.uniform1f(u.uWinter, o.season.winter);
      gl.uniform1f(u.uLamp, o.sun[1] < -0.06 ? 1 : 0);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      gl.bindVertexArray(null);
    },
  };
}
