// Padající listí a sníh z větví u blízkých stromů (do 600 m od kamery).
// Na podzim se z buků a modřínů občas utrhne list a s kymácením se snáší k zemi, při
// poryvu větru jich je víc. V zimě poryv setřese ze smrků sníh: krátký obláček drobných
// vloček. Částice žijí v souřadnicích světa (km), kreslí se jako body do obrazu scény
// (projdou pak úpravou barev i odrazem v jezeře). V červnu a červenci se za tmy nad
// loukami u jezera vznášejí svatojánské mušky: drobná zelenožlutá světélka, která
// pomalu bloudí, rozsvěcují se a zhasínají.

import { createProgramAsync } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';

const MAX = 600;
const FLOATS = 6;   // x, y, z (km), velikost (m), druh (0 list, 1 sníh, 2 světluška), průhlednost

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 aPos;
in vec3 aLook;      // velikost (m), druh, průhlednost
uniform vec2 uPixels;
out float vKind;
out float vAlpha;
out float vSeed;
${NOISE}
${CAMERA}
void main() {
  vec3 d = aPos - vec3(0.0, CAMERA_HEIGHT, 0.0);
  vKind = aLook.y;
  vAlpha = aLook.z;
  vSeed = fract(aPos.x * 9137.0 + aPos.z * 3121.0);
  if (d.z < 0.01) { gl_Position = vec4(2.0); gl_PointSize = 0.0; return; }
  vec2 uv = screenOf(d);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  // Velikost na obrazovce podle vzdálenosti; drobné částice aspoň pixel, pak slabší.
  float px = aLook.x / (d.z * 1000.0 * uSpan) * uPixels.y;
  gl_PointSize = max(px, 1.0);
  vAlpha *= min(1.0, px * px);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in float vKind;
in float vAlpha;
in float vSeed;
uniform float uWinter;
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float shape;
  vec3 base;
  if (vKind > 1.5) {
    // Světluška: zářící bod s měkkou září (vlastní světlo, ne odražené).
    float glow = exp(-dot(p, p) * 6.0);
    if (glow * vAlpha < 0.01) discard;
    vec3 c = vec3(0.75, 1.0, 0.3) * glow * vAlpha * 2.5;
    outColor = vec4(c, 0.0);
    return;
  }
  if (vKind < 0.5) {
    // List: protáhlá elipsa natočená podle semínka, barva od žluté po rezavou.
    float a = vSeed * 6.28 + uTime * (1.0 + vSeed * 2.0);
    vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
    shape = 1.0 - smoothstep(0.7, 1.0, length(q / vec2(1.0, 0.45)));
    base = mix(vec3(0.20, 0.13, 0.02), vec3(0.18, 0.05, 0.015), fract(vSeed * 3.7));
  } else {
    shape = 1.0 - smoothstep(0.2, 1.0, length(p));
    base = vec3(0.8, 0.82, 0.86);
  }
  if (shape * vAlpha < 0.01) discard;
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 light = sunLight() * 0.5 + mix(horizon, zenith, 0.6) * 0.9 + moonLight();
  outColor = vec4(base * light * shape * vAlpha, shape * vAlpha);
}`;

export async function createParticles(gl, { random }) {
  const program = await createProgramAsync(gl, VS, FS, 'particles');
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  const data = new Float32Array(MAX * FLOATS);
  const parts = [];
  let leafClock = 0;
  let flyClock = 0;
  let lastGust = 0;

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  for (const [name, size, offset] of [['aPos', 3, 0], ['aLook', 3, 3]]) {
    const location = program.attributes[name];
    if (location === undefined || location < 0) continue;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, FLOATS * 4, offset * 4);
  }
  gl.bindVertexArray(null);

  function spawn(source, kind) {
    if (parts.length >= MAX) return;
    const [x, y, z, , wide] = source;
    const a = random() * Math.PI * 2, r = wide * 0.4 * random();
    parts.push({
      x: x + Math.cos(a) * r, y: y + (random() - 0.3) * wide, z: z + Math.sin(a) * r,
      vx: 0, vz: 0, kind, age: 0,
      life: kind === 0 ? 14 + random() * 10 : 2.5 + random() * 1.5,
      phase: random() * 6.28, size: kind === 0 ? 0.07 + random() * 0.04 : 0.03 + random() * 0.03,
    });
  }

  return {
    /** Simulace: dt s, sources z trees.sources, season, gust 0..1, směr větru (km/s). */
    step(dt, sources, season, gust, firefliesWanted = 0, meadows = []) {
      // Světlušky: v létě za tmy nad loukami blízko kamery, asi 40 najednou.
      const flies = parts.filter((p) => p.kind === 2).length;
      flyClock += dt * firefliesWanted * 4;
      while (flyClock > 1 && meadows.length) {
        flyClock -= 1;
        if (flies >= 40 * firefliesWanted) break;
        const m = meadows[Math.floor(random() * meadows.length)];
        parts.push({ x: m[0], y: m[1] + 0.0004 + random() * 0.0012, z: m[2], vx: 0, vz: 0, kind: 2, age: 0,
          life: 8 + random() * 10, phase: random() * 6.28, size: 0.35 });
      }
      const deciduous = sources.filter((s) => s[3] >= 1);
      // Listí: podzim (nejvíc v říjnu–listopadu), víc při poryvu.
      const leafRate = deciduous.length ? season.autumn * (0.6 + 6 * gust) : 0;
      leafClock += dt * leafRate;
      while (leafClock > 1) {
        leafClock -= 1;
        spawn(deciduous[Math.floor(random() * deciduous.length)], 0);
      }
      // Sníh z větví: na začátku poryvu se z několika smrků sesype obláček.
      if (season.winter > 0.5 && gust > 0.6 && lastGust <= 0.6 && sources.length) {
        for (let t = 0; t < 6; t++) {
          const tree = sources[Math.floor(random() * sources.length)];
          for (let k = 0; k < 18; k++) spawn(tree, 1);
        }
      }
      lastGust = gust;
      const wind = 0.0006 + 0.004 * gust;   // km/s vodorovně
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.age += dt;
        if (p.kind === 2) {
          // Bloudí pomalu sem a tam, kousek nad trávou.
          p.x += Math.sin(p.age * 0.7 + p.phase) * 0.0003 * dt;
          p.z += Math.cos(p.age * 0.5 + p.phase * 2.0) * 0.0003 * dt;
          p.y += Math.sin(p.age * 0.9 + p.phase * 3.0) * 0.0002 * dt;
        } else if (p.kind === 0) {
          // List se snáší pomalu (0,6 m/s) a kymácí se ze strany na stranu.
          p.y -= 0.0006 * dt;
          p.x += (wind + Math.sin(p.age * 2.2 + p.phase) * 0.0007) * dt;
          p.z += Math.cos(p.age * 1.7 + p.phase) * 0.0003 * dt;
        } else {
          // Sníh padá rychleji a rozptýlí se do obláčku.
          p.y -= 0.0018 * dt;
          p.x += (wind * 0.6 + (Math.sin(p.phase * 7.0) * 0.0012)) * dt;
          p.z += Math.cos(p.phase * 5.0) * 0.0008 * dt;
        }
        if (p.age > p.life) parts.splice(i, 1);
      }
    },
    draw(o) {
      if (!parts.length) return;
      let n = 0;
      for (const p of parts) {
        let fade = Math.min(1, p.age / 0.6, (p.life - p.age) / 1.2);
        // Světluška bliká: krátce se rozsvítí, pak chvíli tma.
        if (p.kind === 2) fade *= Math.max(0, Math.sin(p.age * 1.6 + p.phase)) ** 3;
        data.set([p.x, p.y, p.z, p.size, p.kind, Math.max(0, fade) * (p.kind === 1 ? 0.7 : 1)], n * FLOATS);
        n++;
      }
      const u = program.u;
      gl.useProgram(program.program);
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
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * FLOATS);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },
    get count() { return parts.length; },
  };
}
