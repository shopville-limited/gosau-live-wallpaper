// Skutečná noční obloha: 5 080 hvězd do 6. magnitudy z Yale Bright Star Catalogue
// (assets/hvezdy.bin, viz tools/stars.mjs) a planety na místech podle data a hodiny.
// Kreslí se jako malé body do obrazu oblohy: schovají se za horami (hloubka terénu)
// i za mraky (propustnost vrstvy mraků), a protože jsou v obrazu scény, zrcadlí se
// v jezeře. Jas podle magnitudy, barva podle teploty hvězdy, nízko u obzoru slábnou
// a víc se třpytí. Za svítání a při měsíci zmizí nejdřív ty nejslabší.

import { createProgram } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';
import { planets } from './sky-clock.js';

const PLANETS = 5;

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec4 aStar;              // rektascenze, deklinace (rad), magnituda, teplota (K)
uniform mat3 uEqToWorld;
uniform vec2 uPixels;
uniform float uLimit;       // nejslabší viditelná magnituda (tma: 6, soumrak/měsíc méně)
out vec2 vLocal;
out vec3 vColor;
out float vFlux;
out float vAlt;
out float vSeed;
${NOISE}
${CAMERA}
const vec2 CORNERS[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, -1), vec2(1, 1), vec2(-1, 1));

// Barva hvězdy podle teploty (přibližně záření černého tělesa, vnímané okem).
vec3 starColor(float t) {
  t = clamp(t, 2500.0, 30000.0);
  vec3 cool = vec3(1.0, 0.62, 0.38), sun = vec3(1.0, 0.93, 0.84), hot = vec3(0.66, 0.76, 1.0);
  return t < 5800.0 ? mix(cool, sun, smoothstep(2500.0, 5800.0, t)) : mix(sun, hot, smoothstep(5800.0, 15000.0, t));
}

void main() {
  float ra = aStar.x, dec = aStar.y, mag = aStar.z;
  vec3 w = uEqToWorld * vec3(cos(dec) * cos(ra), cos(dec) * sin(ra), sin(dec));
  vFlux = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  if (w.y < -0.02 || w.z < 0.05 || mag > uLimit + 0.5) return;
  vec2 uv = screenOf(w);
  if (uv.x < -0.02 || uv.x > 1.02 || uv.y > 1.02 || uv.y < uHorizon - 0.02) return;
  float scale = uPixels.y / 1440.0;
  // Jasné hvězdy a planety jsou na snímku větší (rozptyl v objektivu), slabé jen bod.
  float size = clamp(1.4 + (3.0 - mag) * 0.55, 1.2, 6.0) * max(scale, 0.6);
  // Tok vůči hvězdě 1. velikosti; slabé u limitu plynule mizí.
  // Rozsah jasů zmírněný (jako ho vnímá oko), jinak by slabé hvězdy po tónové křivce zmizely.
  vFlux = min(pow(10.0, -0.24 * (mag - 1.0)), 5.0) * (1.0 - smoothstep(uLimit - 0.8, uLimit + 0.5, mag));
  vColor = starColor(aStar.w);
  vAlt = w.y;
  vSeed = fract(ra * 13.7 + dec * 7.1);
  vLocal = CORNERS[gl_VertexID];
  gl_Position = vec4((uv + vLocal * (size + 1.0) / uPixels) * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vLocal;
in vec3 vColor;
in float vFlux;
in float vAlt;
in float vSeed;
uniform sampler2D uDepth;     // alfa = vzdálenost terénu (> 900 = obloha)
uniform sampler2D uClouds;    // alfa = kolik oblohy prosvítá mraky
uniform vec2 uPixels;
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}
void main() {
  if (vFlux <= 0.0) discard;
  vec2 uv = gl_FragCoord.xy / uPixels;
  float a = texture(uDepth, uv).a;
  if (a > 0.0 && a < 900.0) discard;                       // za horou
  float clear = texture(uClouds, uv).a * (1.0 - uOvercast);
  float night = 1.0 - smoothstep(-0.2, -0.1, uSun.y);
  // U obzoru víc vzduchu: slabší, načervenalé a víc se třpytí.
  float air = smoothstep(-0.01, 0.06, vAlt);
  float twinkle = 1.0 + (0.15 + 0.35 * (1.0 - air)) * sin(uTime * (3.0 + 9.0 * vSeed) + vSeed * 50.0);
  float r2 = dot(vLocal, vLocal);
  float shape = exp(-r2 * 5.0) + 0.15 * exp(-r2 * 1.2);
  vec3 c = mix(vColor * vec3(1.0, 0.8, 0.65), vColor, air) * vFlux * shape * twinkle * night * clear * (0.3 + 0.7 * air) * 3.0;
  if (max(c.r, max(c.g, c.b)) < 0.0005) discard;
  outColor = vec4(c, 0.0);
}`;

export function createStars(gl, { url }) {
  const program = createProgram(gl, VS, FS, 'stars');
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  let count = 0;
  let planetData = new Float32Array(PLANETS * 4);
  let planetsAt = -Infinity;

  fetch(url)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((bytes) => {
      const stars = new Float32Array(bytes);
      const data = new Float32Array(stars.length + PLANETS * 4);
      data.set(stars);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      count = stars.length / 4 + PLANETS;
      planetsAt = -Infinity;
    })
    .catch((error) => console.warn(`Katalog hvězd se nenačetl (${error.message}), hvězdy zůstanou vymyšlené.`));

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const location = program.attributes.aStar;
  if (location !== undefined && location >= 0) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);

  return {
    get ready() { return count > 0; },
    /** Kreslí se do obrazu oblohy (framebuffer scény je nastavený). */
    draw(o) {
      if (!count || o.sun[1] > -0.08) return;
      // Planety se po obloze posouvají pomalu: stačí přepočítat jednou za minutu.
      if (Math.abs(o.date.getTime() - planetsAt) > 60000) {
        planetsAt = o.date.getTime();
        planets(o.date).forEach((p, i) => {
          planetData.set([Math.atan2(p.eq[1], p.eq[0]), Math.asin(p.eq[2]), p.mag, p.temp], i * 4);
        });
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, (count - PLANETS) * 16, planetData);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
      const u = program.u;
      gl.useProgram(program.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, o.depth);
      gl.uniform1i(u.uDepth, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, o.clouds);
      gl.uniform1i(u.uClouds, 1);
      gl.activeTexture(gl.TEXTURE0);
      const w = o.world;
      gl.uniform1f(u.uAspect, w.aspect);
      gl.uniform1f(u.uHorizon, w.horizon);
      gl.uniform1f(u.uSpan, w.span);
      gl.uniform1f(u.uMirror, w.mirror ? 1 : 0);
      gl.uniform2f(u.uSeed, ...w.seed);
      if (u.uOne) gl.uniform1i(u.uOne, 1);
      gl.uniform2f(u.uPixels, o.pixels[0], o.pixels[1]);
      gl.uniformMatrix3fv(u.uEqToWorld, false, o.sky.eqToWorld);
      // Mezní magnituda: za tmy 6, za soumraku a při jasném měsíci jen jasnější hvězdy.
      const dark = Math.min(1, Math.max(0, (-o.sun[1] - 0.08) / 0.15));
      const moon = Math.max(0, o.moon[1]) > 0 ? Math.sin(Math.PI * o.moonPhase) : 0;
      gl.uniform1f(u.uLimit, 2.0 + 4.0 * dark - 0.8 * moon);
      gl.uniform1f(u.uTime, o.time);
      gl.uniform3f(u.uSun, ...o.sun);
      gl.uniform3f(u.uMoon, ...o.moon);
      gl.uniform1f(u.uMoonPhase, o.moonPhase);
      gl.uniform1f(u.uOvercast, o.overcast || 0);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },
  };
}
