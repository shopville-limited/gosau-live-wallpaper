// Stavby na vrcholu Sněžky jako malé 3D modely (vzdálenostní funkce):
//  - polská meteorologická observatoř: tři nad sebou položené „talíře“ na sloupu (1976),
//  - kaple sv. Vavřince: kruhová dřevěná stavba s kuželovou střechou a lucernou (1681),
//  - Česká poštovna: nízká dřevěná stavba se šikmou střechou (2007).
// Kreslí se do obrazu scény po terénu; schovají se za bližší terén podle hloubky G-bufferu.
// Ze Studniční hory (2,1 km) mají jen desítky pixelů, proto jednoduché tvary a světla.

import { createProgramAsync } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec3 uCenter;       // střed vrcholu (km, y = zem)
uniform vec2 uPixels;
${NOISE}
${CAMERA}
const vec2 CORNERS[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, -1), vec2(1, 1), vec2(-1, 1));
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec3 center = uCenter + vec3(0.0, 0.012, 0.0) - vec3(0.0, CAMERA_HEIGHT, 0.0);
  float radius = 0.075;
  vec2 uv = screenOf(center);
  float r = radius / max(center.z - radius, 1e-4) / uSpan;
  gl_Position = vec4((uv + c * vec2(r * uPixels.y / uPixels.x, r)) * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec3 uCenter;
uniform vec2 uPixels;
uniform vec4 uRot;          // směry východ a sever v souřadnicích scény (x, z)
uniform sampler2D uDepth;   // G-buffer: alfa = vzdálenost terénu (km)
uniform sampler2D uShadow;
uniform float uWinter;
uniform float uRime;
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}

float sdCyl(vec3 p, float r, float h) {      // svislý válec, spodek v y = 0
  vec2 d = vec2(length(p.xz) - r, abs(p.y - h * 0.5) - h * 0.5);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
float sdCone(vec3 p, float r, float h) {      // kužel: podstava r v y = 0, špička v y = h
  float k = clamp(p.y / h, 0.0, 1.0);
  float d = length(p.xz) - r * (1.0 - k);
  return max(d * h / length(vec2(r, h)), max(-p.y, p.y - h));
}

// Materiál: 1 bílý plech observatoře, 2 okna, 3 šindel / tmavé dřevo, 4 světlé dřevo, 5 kámen
vec2 U(vec2 a, vec2 b) { return a.x < b.x ? a : b; }
vec2 scene(vec3 p) {
  // Polská observatoř (počátek): sloup a tři talíře, spodní největší.
  vec2 r = vec2(sdCyl(p, 4.0, 13.0), 5.0);
  float discs = min(min(sdCyl(p - vec3(0, 3.0, 0), 11.0, 3.2), sdCyl(p - vec3(0, 7.5, 0), 9.0, 3.0)), sdCyl(p - vec3(0, 11.5, 0), 6.5, 2.8));
  r = U(r, vec2(discs, 1.0));
  // pás oken na obvodu talířů
  float band = min(min(abs(p.y - 4.6), abs(p.y - 9.0)), abs(p.y - 12.9));
  if (discs < 0.3 && band < 0.5) r.y = 2.0;
  r = U(r, vec2(sdCyl(p - vec3(0, 14.3, 0), 0.25, 4.0), 5.0));   // anténa
  // Kaple sv. Vavřince: 28 m západně, kruhová, šindelová kuželová střecha a lucerna.
  vec3 q = p - vec3(-28.0, 0.0, -6.0);
  r = U(r, vec2(sdCyl(q - vec3(0, -8.0, 0), 5.2, 12.2), 5.0));   // zdi sahají pod zem (svah)
  r = U(r, vec2(sdCone(q - vec3(0, 4.2, 0), 6.0, 4.0), 3.0));
  r = U(r, vec2(sdCyl(q - vec3(0, 7.2, 0), 1.0, 1.8), 4.0));
  r = U(r, vec2(sdCone(q - vec3(0, 9.0, 0), 1.3, 1.6), 3.0));
  // Česká poštovna: 45 m jižně, dřevěná, šikmá střecha.
  vec3 s = p - vec3(-10.0, 0.0, -45.0);
  // Poštovna stojí na svahu asi 6 m pod vrcholem.
  s.y += 6.0;
  float roof = sdBox(s - vec3(0, 4.6 + s.x * 0.08, 0), vec3(9.0, 0.3, 5.0));
  r = U(r, vec2(sdBox(s - vec3(0, -2.5, 0), vec3(8.0, 7.1, 4.2)), 4.0));
  r = U(r, vec2(roof, 3.0));
  return r;
}

vec3 albedo(float m, vec3 p) {
  vec3 c = m == 1.0 ? vec3(0.62, 0.64, 0.66) : m == 2.0 ? vec3(0.05, 0.06, 0.07)
         : m == 3.0 ? vec3(0.10, 0.08, 0.06) : m == 4.0 ? vec3(0.26, 0.18, 0.11) : vec3(0.22, 0.21, 0.20);
  // V zimě námraza a sníh: všechno bělavé, střechy bílé.
  float frost = max(uWinter, uRime) * (m == 3.0 ? 1.0 : 0.6);
  return mix(c, vec3(0.78, 0.80, 0.84), frost);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uPixels;
  vec3 rd = rayDirection(uv);
  vec3 cam = vec3(0.0, CAMERA_HEIGHT, 0.0);
  // Do soustavy vrcholu: metry, x na východ, z na sever, y od země vrcholu.
  vec3 rel = (cam - uCenter) * 1000.0;
  vec3 east = vec3(uRot.x, 0.0, uRot.y), north = vec3(uRot.z, 0.0, uRot.w);
  vec3 ro = vec3(dot(rel, east), rel.y, dot(rel, north));
  vec3 dir = vec3(dot(rd, east), rd.y, dot(rd, north));
  // Obalová koule (poloměr 75 m), v ní hledání povrchu.
  vec3 oc = ro - vec3(-10.0, 8.0, -15.0);
  float b = dot(oc, dir), disc = b * b - dot(oc, oc) + 75.0 * 75.0;
  if (disc < 0.0) discard;
  float t = max(-b - sqrt(disc), 0.0), tEnd = -b + sqrt(disc);
  float pix = uSpan / uPixels.y;
  bool hit = false;
  float best = 1e9;
  for (int i = 0; i < 96 * uOne; i++) {
    if (t > tEnd) break;
    vec3 p = ro + dir * t;
    float d = scene(p).x;
    best = min(best, d / (pix * t));
    if (d < pix * t * 0.4) { hit = true; break; }
    t += max(d * 0.9, pix * t * 0.5);
  }
  if (!hit) discard;
  vec3 p = ro + dir * t;
  if (p.y < -16.0) discard;
  // Za bližším terénem (svah před vrcholem) se nekreslí.
  float a = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).a;
  float terrain = a - 100.0 * floor(a / 100.0);
  if (a > 0.0 && a < 900.0 && terrain < t / 1000.0 - 0.004) discard;
  float m = scene(p).y;
  vec2 e = vec2(0.15, 0.0);
  vec3 n = normalize(vec3(scene(p + e.xyy).x - scene(p - e.xyy).x, scene(p + e.yxy).x - scene(p - e.yxy).x, scene(p + e.yyx).x - scene(p - e.yyx).x));
  vec3 sunL = vec3(dot(uSun, east), uSun.y, dot(uSun, north));
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 sky = mix(horizon, zenith, 0.5 + 0.5 * n.y) * (0.6 + 0.4 * n.y);
  vec3 c = albedo(m, p) * (sunLight() * max(dot(n, sunL), 0.0) + sky * 0.9 + moonLight() * 0.6);
  // Plech observatoře se na slunci leskne.
  if (m == 1.0) c += sunLight() * 0.25 * pow(max(dot(reflect(dir, n), sunL), 0.0), 20.0);
  // Okna observatoře a poštovny v noci svítí.
  float night = 1.0 - smoothstep(-0.06, 0.04, uSun.y);
  if (m == 2.0) c += vec3(1.0, 0.75, 0.45) * night * 1.5;
  // Vzduch mezi vrcholem a kamerou.
  float dist = t / 1000.0;
  vec3 transmit = exp(-vec3(0.020, 0.028, 0.042) * dist);
  c = c * transmit + skyColor(normalize(vec3(rd.x, 0.05, rd.z))) * 0.95 * (1.0 - transmit);
  outColor = vec4(c, 1.0);
}`;

export async function createSummit(gl, { map }) {
  const program = await createProgramAsync(gl, VS, FS, 'summit');
  const vao = gl.createVertexArray();
  // Vrchol: místo z mapy, zem podle jemné mapy; směry východ/sever podle azimutu kamery.
  const [px, pz] = map.places.snezka;
  const ground = map.sampleFine(px, pz);
  const az = (map.azimuth * Math.PI) / 180;
  // Svět scény: z = dopředu (azimut), x = doprava. Východ a sever v těchto osách:
  const east = [Math.cos(az), Math.sin(az)], north = [-Math.sin(az), Math.cos(az)];
  return {
    draw(o) {
      const u = program.u;
      gl.useProgram(program.program);
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
      gl.uniform3f(u.uCenter, px, ground, pz);
      gl.uniform4f(u.uRot, east[0], east[1], north[0], north[1]);
      gl.uniform1f(u.uTime, o.time);
      gl.uniform3f(u.uSun, ...o.sun);
      gl.uniform3f(u.uMoon, ...o.moon);
      gl.uniform1f(u.uMoonPhase, o.moonPhase);
      gl.uniform1f(u.uOvercast, o.overcast || 0);
      gl.uniform1f(u.uFlash, o.flash || 0);
      gl.uniform1f(u.uWinter, o.season.winter);
      gl.uniform1f(u.uRime, o.rime || 0);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    },
  };
}
