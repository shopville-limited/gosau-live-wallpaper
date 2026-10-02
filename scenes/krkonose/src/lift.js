// Kabinková lanovka Pec pod Sněžkou – Růžová hora – Sněžka podle skutečné trasy
// z OpenStreetMap (assets/cesty.json, © přispěvatelé OSM): ocelové podpěry, dvě lana
// s průvěsem a čtyřmístné kabinky, které jezdí jako ve skutečnosti (úsek na Sněžku 8 min,
// kabinka asi každou minutu, tedy po ~250 m). Jezdí jen v provozní době (main.js);
// mimo ni jsou kabinky v garážích stanic, při silném větru visí nehybně na laně.
// Ze Studniční hory jsou vidět jen části horního úseku (zbytek schovává úbočí Sněžky):
// podpěry mají pár pixelů, kabinky jsou drobné tečky, lana tenké linky proti obloze.

import { createProgramAsync } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';

const TOWER = 0.015;        // výška podpěry (km)
const STATION = 0.007;      // výška lana ve stanici
const GAUGE = 0.0025;       // polovina rozchodu lan (km)
const HANG = 0.0035;        // kabinka visí pod lanem
const SPACING = 0.25;       // rozestup kabinek (km)
const SPEED = 0.0043;       // rychlost lana (km/s): úsek 2,1 km za 8 minut
const MAX = 96;

const COMMON = /* glsl */ `
vec4 projectWorld(vec3 q) {
  vec3 d = q - vec3(0.0, CAMERA_HEIGHT, 0.0);
  float x = d.x / d.z;
  if (uMirror > 0.5) x = -x;
  vec2 uv = vec2(x / (uAspect * uSpan) + 0.5, d.y / d.z / uSpan + uHorizon);
  return vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

// Podpěry a kabinky: obdélníky na obrazovce, aspoň pár pixelů velké.
const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec4 aItem;      // x, y (spodek), z (km), druh (0 podpěra, 1 kabinka)
in vec2 aSize;      // šířka, výška (km)
uniform vec2 uPixels;
out vec2 vLocal;
out float vKind;
out float vDistance;
${NOISE}
${CAMERA}
${COMMON}
const vec2 CORNERS[6] = vec2[6](vec2(-1, 0), vec2(1, 0), vec2(1, 1), vec2(-1, 0), vec2(1, 1), vec2(-1, 1));
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec3 base = aItem.xyz;
  vec3 d = base - vec3(0.0, CAMERA_HEIGHT, 0.0);
  vec4 p = projectWorld(base);
  vec2 uv = p.xy * 0.5 + 0.5;
  float px = 1.0 / uPixels.y;
  float minH = aItem.w > 0.5 ? 2.0 : 3.0;
  float tall = max(aSize.y / d.z / uSpan, minH * px);
  float wide = max(aSize.x / d.z / uSpan, (aItem.w > 0.5 ? 1.5 : 1.0) * px);
  vec2 pos = uv + vec2(c.x * wide * 0.5 * uPixels.y / uPixels.x, c.y * tall);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  vLocal = c;
  vKind = aItem.w;
  vDistance = length(d);
}`;

const QUAD_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vLocal;
in float vKind;
in float vDistance;
uniform sampler2D uDepth;
uniform float uWinter;
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}
void main() {
  float a = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).a;
  float terrain = a - 100.0 * floor(a / 100.0);
  if (a > 0.0 && a < 900.0 && terrain < vDistance - 0.004) discard;
  vec3 albedo;
  if (vKind < 0.5) {
    // Podpěra: příhradová ocel, nahoře širší hlava s kladkami.
    float x = abs(vLocal.x), y = vLocal.y;
    if (y < 0.85 && x > 0.35 + 0.25 * (1.0 - y)) discard;
    albedo = mix(vec3(0.09, 0.09, 0.09), vec3(0.75, 0.77, 0.8), uWinter * 0.5);
  } else {
    // Kabinka: červená, se světlým pásem oken nahoře.
    albedo = vLocal.y > 0.55 && vLocal.y < 0.85 ? vec3(0.35, 0.38, 0.4) : vec3(0.55, 0.06, 0.05);
  }
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 c = albedo * (sunLight() * 0.7 * max(uSun.y + 0.15, 0.0) + mix(horizon, zenith, 0.5) * 0.9 + moonLight() * 0.5);
  vec3 transmit = exp(-vec3(0.020, 0.028, 0.042) * vDistance);
  c = c * transmit + skyColor(normalize(vec3(0.0, 0.05, 1.0))) * 0.95 * (1.0 - transmit);
  outColor = vec4(c, 1.0);
}`;

// Lana: tenké linky (1 px), proti obloze tmavé, proti svahu skoro nevidět.
const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 aPoint;
out float vDistance;
${NOISE}
${CAMERA}
${COMMON}
void main() {
  gl_Position = projectWorld(aPoint);
  vDistance = length(aPoint - vec3(0.0, CAMERA_HEIGHT, 0.0));
}`;

const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in float vDistance;
uniform sampler2D uDepth;
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}
void main() {
  float a = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).a;
  float terrain = a - 100.0 * floor(a / 100.0);
  if (a > 0.0 && a < 900.0 && terrain < vDistance - 0.004) discard;
  // Lano je tenčí než pixel: jen ztmaví pozadí o kousek (víc proti světlé obloze).
  outColor = vec4(vec3(0.02), 0.35);
}`;

export async function createLift(gl, { map }) {
  const [quad, line] = await Promise.all([
    createProgramAsync(gl, QUAD_VS, QUAD_FS, 'lift'),
    createProgramAsync(gl, LINE_VS, LINE_FS, 'lift-cable'),
  ]);
  const data = await (await fetch(new URL('../assets/cesty.json', import.meta.url))).json();
  // Úseky lanovky: body (stanice na koncích, podpěry mezi nimi), výška lana v každém bodě.
  const sections = (data.lifts || []).map((l) => {
    // Body blíž než 15 m od sebe sloučit (OSM má u stanice dva skoro stejné body).
    const pts = [];
    for (const [x, z] of l.points) {
      if (pts.length && Math.hypot(x - pts[pts.length - 1][0], z - pts[pts.length - 1][1]) < 0.015) continue;
      pts.push([x, z]);
    }
    const tops = pts.map(([x, z], i) => [x, map.sampleFine(x, z) + (i === 0 || i === pts.length - 1 ? STATION : TOWER), z]);
    const lengths = [0];
    for (let i = 1; i < tops.length; i++) lengths.push(lengths[i - 1] + Math.hypot(tops[i][0] - tops[i - 1][0], tops[i][2] - tops[i - 1][2]));
    return { name: l.name, pts, tops, lengths, total: lengths[lengths.length - 1] };
  });
  // Bod lana ve vzdálenosti s (km) od dolní stanice, side = ±1 (lano nahoru / dolů).
  function cable(sec, s, side) {
    let i = 1;
    while (i < sec.lengths.length - 1 && sec.lengths[i] < s) i++;
    const a = sec.tops[i - 1], b = sec.tops[i];
    const seg = sec.lengths[i] - sec.lengths[i - 1] || 1e-6;
    const u = Math.min(1, Math.max(0, (s - sec.lengths[i - 1]) / seg));
    const sag = 0.025 * seg * 4 * u * (1 - u);
    const dx = (b[0] - a[0]) / seg, dz = (b[2] - a[2]) / seg;
    return [a[0] + (b[0] - a[0]) * u - dz * GAUGE * side, a[1] + (b[1] - a[1]) * u - sag, a[2] + (b[2] - a[2]) * u + dx * GAUGE * side];
  }

  // Statická geometrie: podpěry (obdélníky) a lana (úsečky po 20 m).
  const towers = [];
  const cablePoints = [];
  for (const sec of sections) {
    sec.pts.forEach(([x, z], i) => {
      if (i === 0 || i === sec.pts.length - 1) return;
      towers.push([x, map.sampleFine(x, z), z, 0, 0.0018, TOWER]);
    });
    for (const side of [-1, 1]) {
      const n = Math.ceil(sec.total / 0.02);
      for (let k = 0; k < n; k++) cablePoints.push(...cable(sec, (k / n) * sec.total, side), ...cable(sec, ((k + 1) / n) * sec.total, side));
    }
  }
  const items = new Float32Array((towers.length + MAX) * 6);
  towers.forEach((t, i) => items.set(t, i * 6));

  const quadVao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, items.byteLength, gl.DYNAMIC_DRAW);
  for (const [name, size, offset] of [['aItem', 4, 0], ['aSize', 2, 16]]) {
    const location = quad.attributes[name];
    if (location === undefined || location < 0) continue;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 24, offset);
    gl.vertexAttribDivisor(location, 1);
  }
  const lineVao = gl.createVertexArray();
  const lineBuffer = gl.createBuffer();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cablePoints), gl.STATIC_DRAW);
  const pointLocation = line.attributes.aPoint;
  if (pointLocation !== undefined && pointLocation >= 0) {
    gl.enableVertexAttribArray(pointLocation);
    gl.vertexAttribPointer(pointLocation, 3, gl.FLOAT, false, 12, 0);
  }
  gl.bindVertexArray(null);

  // Lano se rozjíždí a zastavuje plynule; phase = ujetá dráha (km).
  let phase = 0, speed = 0, present = false;

  function uniforms(program, o) {
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
    if (u.uPixels) gl.uniform2f(u.uPixels, o.pixels[0], o.pixels[1]);
    gl.uniform1f(u.uTime, o.time);
    gl.uniform3f(u.uSun, ...o.sun);
    gl.uniform3f(u.uMoon, ...o.moon);
    gl.uniform1f(u.uMoonPhase, o.moonPhase);
    gl.uniform1f(u.uOvercast, o.overcast || 0);
    gl.uniform1f(u.uFlash, o.flash || 0);
    if (u.uWinter) gl.uniform1f(u.uWinter, o.season.winter);
  }

  return {
    sections: sections.map((s) => ({ name: s.name, km: +s.total.toFixed(2), towers: s.pts.length - 2 })),
    /** running: lano jede; open: provozní den a hodina (kabinky jsou venku z garáží). */
    update(dt, { running, open }) {
      present = open;
      const target = running && open ? SPEED : 0;
      speed += (target - speed) * Math.min(1, dt / 4);
      phase += speed * dt;
    },
    get state() { return { present, speed: +(speed * 1000).toFixed(2) }; },
    draw(o) {
      // Kabinky: na každém úseku po laně nahoru i dolů, rozestup SPACING.
      let n = towers.length;
      if (present) {
        for (const sec of sections) {
          const count = Math.floor(sec.total / SPACING);
          for (let k = 0; k < count && n < towers.length + MAX; k++) {
            const s = (phase + k * SPACING) % (count * SPACING);
            for (const side of [1, -1]) {
              const at = side > 0 ? s : sec.total - s;
              if (at < 0.02 || at > sec.total - 0.02) continue;   // ve stanici
              const p = cable(sec, at, side);
              items.set([p[0], p[1] - HANG, p[2], 1, 0.0016, 0.0019], n * 6);
              n++;
            }
          }
        }
      }
      gl.enable(gl.BLEND);
      // Alfa obrazu scény nese značky (voda, blízký strom): zůstává beze změny.
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      uniforms(line, o);
      gl.bindVertexArray(lineVao);
      gl.drawArrays(gl.LINES, 0, cablePoints.length / 3);
      gl.disable(gl.BLEND);
      uniforms(quad, o);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, items.subarray(0, n * 6));
      gl.bindVertexArray(quadVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      gl.bindVertexArray(null);
    },
  };
}
