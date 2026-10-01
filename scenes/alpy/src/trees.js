// Blízké stromy (do TREE_NEAR od kamery) kreslené jednotlivě. Výšková mapa by je při
// pohledu z hladiny slila do svislých pruhů; tady má každý smrk vlastní siluetu s patry
// převislých větví, kmen, světlou stranu ke slunci, stín a pohupování ve větru.
// Kreslí se do HDR obrazu scény po terénu; za terénem se schovají podle hloubky G-bufferu.
// Dál od kamery zůstává les jako součást výškové mapy (terrain.js, uTreeNear).

import { createProgram } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';

export const TREE_NEAR = 1.2;   // km
const FLOATS = 8;               // x, y (země), z, výška, šířka, semínko, druh, rezerva

const VS = /* glsl */ `#version 300 es
precision highp float;
in vec4 aBase;      // x, y, z země (km), výška stromu (km)
in vec4 aShape;     // šířka (km), semínko, druh (0 smrk, 1 modřín, 2 buk), 1 = ve strmém svahu
uniform float uTime;
uniform float uGust;
out vec2 vLocal;    // -1..1 napříč, 0..1 odspodu
out vec3 vWorld;
out float vSeed;
out float vKind;
out vec2 vBaseUv;
out float vDistance;
${NOISE}
${CAMERA}
const vec2 CORNERS[6] = vec2[6](vec2(-1, 0), vec2(1, 0), vec2(1, 1), vec2(-1, 0), vec2(1, 1), vec2(-1, 1));
vec4 project(vec3 q) {
  vec3 d = q - vec3(0.0, CAMERA_HEIGHT, 0.0);
  float x = d.x / d.z;
  if (uMirror > 0.5) x = -x;
  vec2 uv = vec2(x / (uAspect * uSpan) + 0.5, d.y / d.z / uSpan + uHorizon);
  return vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec3 base = aBase.xyz;
  float tall = aBase.w, wide = aShape.x;
  vec3 view = normalize(base - vec3(0.0, CAMERA_HEIGHT, 0.0));
  vec3 across = normalize(vec3(view.z, 0.0, -view.x));
  // Vítr: špička se pohupuje víc než spodek.
  float sway = sin(uTime * (0.9 + aShape.y * 0.6) + aShape.y * 40.0) * (0.02 + 0.05 * uGust) * c.y * c.y;
  vec3 q = base + across * (c.x * wide * 0.5 + sway * wide) + vec3(0.0, c.y * tall, 0.0);
  vLocal = c;
  vWorld = q;
  vSeed = aShape.y;
  vKind = aShape.z;
  vec4 b = project(base);
  vBaseUv = b.xy * 0.5 + 0.5;
  vDistance = length(q - vec3(0.0, CAMERA_HEIGHT, 0.0));
  gl_Position = project(q);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vLocal;
in vec3 vWorld;
in float vSeed;
in float vKind;
in vec2 vBaseUv;
in float vDistance;
uniform sampler2D uDepth;       // G-buffer (alfa = vzdálenost terénu), bez filtrování
uniform sampler2D uShadow;
uniform vec2 uPixels;
uniform float uWinter;
uniform float uAutumn;
uniform float uSpring;
out vec4 outColor;
${NOISE}
${CAMERA}
${ATMOSPHERE}

void main() {
  // Schovat za terénem, který je blíž.
  float a = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).a;
  if (a > 0.0 && a < 900.0) {
    float k = floor(a / 100.0);
    float terrain = a - 100.0 * k;
    if (terrain < vDistance - 0.004) discard;
  }
  float y = vLocal.y;
  float x = vLocal.x;
  float width;
  vec3 color;
  float lit;
  bool broadleaf = vKind > 1.5;
  if (!broadleaf) {
    // Smrk (a modřín): kužel z pater převislých větví, každé patro zubaté do stran.
    float tiers = 9.0 + floor(vSeed * 6.0);
    float t = y * tiers + vSeed * 3.0;
    float tier = fract(t);
    float index = floor(t);
    float side = x > 0.0 ? 1.0 : -1.0;
    float jag = hash12(vec2(index, side + vSeed * 17.0));
    float cone = pow(max(0.0, 1.0 - y), 0.95);
    // Větev se od kmene táhne ven a dolů: dole v patře nejširší, nahoře úzká.
    width = cone * (0.35 + 0.65 * (1.0 - tier)) * (0.8 + 0.35 * jag);
    width *= 1.0 - 0.15 * smoothstep(0.92, 1.0, y);
    // Drobné zuby jehličí na obrysu.
    width *= 0.92 + 0.08 * gnoise(vec2(y * 90.0 + vSeed * 13.0, side));
    // Kmen dole mezi větvemi.
    float trunk = step(abs(x), 0.035) * step(y, 0.12);
    if (abs(x) > width && trunk < 0.5) discard;
    if (y < 0.06 && trunk < 0.5) discard;
    // Světlo: horní strana větve a strana ke slunci světlejší, spodek patra ve stínu.
    vec3 view = normalize(vWorld - vec3(0.0, CAMERA_HEIGHT, 0.0));
    vec3 across = normalize(vec3(view.z, 0.0, -view.x));
    float sunSide = dot(across, normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-5)) * (uMirror > 0.5 ? -1.0 : 1.0);
    lit = (0.35 + 0.65 * (1.0 - tier)) * (0.75 + 0.45 * sunSide * x / max(width, 0.05));
    // Spodní větve v hustém lese stíní sousední stromy.
    lit *= mix(0.45, 1.0, smoothstep(0.0, 0.7, y));
    float needles = 0.7 + 0.6 * hash12(floor(gl_FragCoord.xy * 0.5) + vSeed * 91.0);
    lit *= needles;
    float hue = fract(vSeed * 7.3);
    color = mix(vec3(0.014, 0.032, 0.024), vec3(0.026, 0.040, 0.016), hue);
    if (vKind > 0.5) {
      vec3 larch = mix(vec3(0.035, 0.065, 0.025), vec3(0.055, 0.10, 0.030), uSpring);
      larch = mix(larch, vec3(0.13, 0.115, 0.035), uAutumn);
      color = mix(larch, vec3(0.075, 0.065, 0.055), uWinter);
    }
    if (trunk > 0.5 && abs(x) <= width * 0.2 + 0.035) { color = vec3(0.05, 0.035, 0.025); lit = 0.6; }
    // V zimě sníh na horní straně větví.
    // Sníh na větvích: nepravidelné chomáče na horní straně pater, ne souvislý pás.
    // Každý strom nese jinak (z některých vítr sníh setřásl), konce větví a spodní patra
    // pod hustými horními mají méně, spodek chomáče je ve stínu namodralý.
    if (uWinter > 0.0) {
      float lump = gnoise(vec2(x * 6.0 + index * 3.1, index * 1.7 + vSeed * 20.0)) * 0.5 + 0.5;
      float load = uWinter * mix(0.3, 1.0, hash12(vec2(vSeed * 71.0, 3.0)));
      float top = smoothstep(0.45 + 0.3 * lump, 0.95, 1.0 - tier);
      float tips = 1.0 - 0.6 * smoothstep(0.65, 1.0, abs(x) / max(width, 0.05));
      float sheltered = mix(0.55, 1.0, smoothstep(0.1, 0.6, y));
      float snow = clamp(load * top * smoothstep(0.3, 0.65, lump + 0.15 * y) * tips * sheltered * 1.4, 0.0, 1.0);
      vec3 snowColor = mix(vec3(0.42, 0.47, 0.56), vec3(0.64, 0.66, 0.70), smoothstep(0.6, 0.95, 1.0 - tier));
      color = mix(color, snowColor, snow);
    }
  } else {
    // Buk: koruna z osmi shluků listí (rozložených jako semínka slunečnice), každý chomáč
    // má světlou stranu ke slunci a stinnou spodní, obrys roztřepený do listů. Mezi
    // shluky prosvítají větve od rozvětveného kmene; v zimě zůstanou jen holé větve.
    vec3 view = normalize(vWorld - vec3(0.0, CAMERA_HEIGHT, 0.0));
    vec3 across = normalize(vec3(view.z, 0.0, -view.x));
    float sunSide = dot(across, normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-5)) * (uMirror > 0.5 ? -1.0 : 1.0);
    vec2 sunDir = normalize(vec2(sunSide, max(uSun.y, 0.0) * 2.0 + 0.3));
    vec2 p = vec2(x, (y - 0.6) / 0.4);            // koruna zhruba jednotkový kruh
    float best = 9.0, bestShade = 1.0;
    vec2 bestN = vec2(0.0, 1.0);
    vec2 centers[8];
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      vec2 h = vec2(hash12(vec2(fi, vSeed * 37.0)), hash12(vec2(fi + 11.0, vSeed * 53.0)));
      float ang = fi * 2.39996 + vSeed * 6.0;
      vec2 c = vec2(cos(ang), sin(ang)) * sqrt((fi + 0.5) / 8.0) * 0.62 + (h - 0.5) * 0.15;
      centers[i] = c;
      float r = 0.36 + 0.14 * h.x;
      vec2 dp = (p - c) / r;
      float d = length(dp) + 0.16 * gnoise(p * 9.0 + fi * 7.0 + vSeed * 13.0);
      if (d < best) { best = d; bestN = dp; bestShade = 0.75 + 0.35 * h.y; }
    }
    float leafNoise = gnoise(p * 34.0 + vSeed * 19.0) * 0.5 + 0.5;
    // Obrys chomáče roztřepený do listů; v zimě bez listí.
    bool leaf = uWinter < 0.6 && best < 1.0 - 0.3 * smoothstep(0.5, 1.0, best) * leafNoise;
    // Kmen se nahoře větví ke shlukům (větve se ztenčují).
    vec2 lp = vec2(x, y);
    float wood = y < 0.42 ? abs(x) - 0.065 * (1.0 - 0.4 * y) : 1.0;
    for (int i = 0; i < 8; i++) {
      vec2 c = vec2(centers[i].x, centers[i].y * 0.4 + 0.6);
      vec2 pa = lp - vec2(0.0, 0.38), ba = c - vec2(0.0, 0.38);
      float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      wood = min(wood, length(pa - ba * t) - mix(0.04, 0.012, t));
    }
    if (!leaf && wood > 0.0) discard;
    width = 1.0;
    if (leaf) {
      vec3 beech = mix(vec3(0.025, 0.050, 0.018), vec3(0.045, 0.085, 0.025), uSpring);
      // Buky barví postupně: každý strom jinak daleko, listy od zelené přes žlutou do rezavé.
      float turn = clamp(uAutumn * (0.4 + 1.2 * fract(vSeed * 13.7)) + 0.25 * gnoise(vec2(x, y) * 7.0 + vSeed), 0.0, 1.0);
      vec3 autumnLeaf = mix(vec3(0.12, 0.10, 0.02), vec3(0.20, 0.07, 0.018), fract(vSeed * 5.3));
      color = mix(beech, autumnLeaf, turn) * (0.85 + 0.3 * leafNoise);
      float toward = dot(normalize(bestN + vec2(0.0, 1e-3)), sunDir);
      // Světlá strana chomáče ke slunci, vnitřek a spodek ve stínu listí nad ním.
      lit = (0.3 + 0.7 * smoothstep(-0.5, 0.9, toward)) * bestShade * mix(0.65, 1.05, smoothstep(0.2, 0.95, best));
      lit *= mix(0.6, 1.0, smoothstep(-0.9, 0.2, p.y));
    } else {
      color = vec3(0.07, 0.06, 0.05);
      lit = 0.45 + 0.3 * step(0.0, sunSide * x);
    }
  }
  // Osvětlení jako terén: slunce se stínem hor, obloha, noc.
  float shade = texture(uShadow, vBaseUv).r;
  if (uSun.y < -0.03) shade = 1.0;
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 sky = mix(horizon, zenith, 0.6) * 0.8;
  vec3 c = color * (sunLight() * 0.55 * shade * max(lit, 0.0) + sky * (0.6 + 0.4 * lit) + moonLight() * 0.5);
  // Protisvětlo: okraje větví proti slunci prosvítají.
  vec3 view = normalize(vWorld - vec3(0.0, CAMERA_HEIGHT, 0.0));
  float edge = smoothstep(0.6, 1.0, abs(x) / max(width, 0.05));
  c += color * vec3(0.8, 1.2, 0.5) * sunLight() * pow(max(dot(view, uSun), 0.0), 3.0) * edge * shade * 0.6;
  // Vzduch mezi stromem a kamerou.
  vec3 transmit = exp(-vec3(0.020, 0.028, 0.042) * vDistance);
  c = c * transmit + skyColor(normalize(vec3(view.x, 0.05, view.z))) * 0.95 * (1.0 - transmit);
  outColor = vec4(c, 1.0);
}`;

// Stín stromu na zemi: protáhlý klín od paty stromu ve směru od slunce.
const SHADOW_VS = /* glsl */ `#version 300 es
precision highp float;
in vec4 aBase;
in vec4 aShape;
out vec2 vLocal;
out float vDistance;
out vec2 vBaseUv;
${NOISE}
${CAMERA}
uniform vec3 uSun;
const vec2 CORNERS[6] = vec2[6](vec2(-1, 0), vec2(1, 0), vec2(1, 1), vec2(-1, 0), vec2(1, 1), vec2(-1, 1));
vec4 project(vec3 q) {
  vec3 d = q - vec3(0.0, CAMERA_HEIGHT, 0.0);
  float x = d.x / d.z;
  if (uMirror > 0.5) x = -x;
  return vec4(vec2(x / (uAspect * uSpan) + 0.5, d.y / d.z / uSpan + uHorizon) * 2.0 - 1.0, 0.0, 1.0);
}
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec3 base = aBase.xyz + vec3(0.0, 0.0008, 0.0);
  vec2 away = -normalize(uSun.xz + 1e-5);
  float elevation = max(uSun.y, 0.08);
  float len = min(aBase.w / elevation * sqrt(1.0 - elevation * elevation), aBase.w * 6.0);
  vec2 side = vec2(-away.y, away.x);
  vec3 q = vec3(base.x + side.x * c.x * aShape.x * 0.5 + away.x * c.y * len, base.y,
           base.z + side.y * c.x * aShape.x * 0.5 + away.y * c.y * len);
  vLocal = c;
  vDistance = length(q - vec3(0.0, CAMERA_HEIGHT, 0.0));
  vBaseUv = project(aBase.xyz).xy * 0.5 + 0.5;
  gl_Position = project(q);
  // Klín stínu počítá s rovnou zemí; ve strmém svahu by se protáhl do dlouhých čar.
  if (aShape.w > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vDistance;
in vec2 vBaseUv;
uniform sampler2D uDepth;
uniform sampler2D uShadow;
uniform float uStrength;
out vec4 outColor;
void main() {
  // Jen na viditelné zemi (ne na kopci před ní ani na obloze).
  float a = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).a;
  if (a <= 0.0 || a > 900.0) discard;
  float terrain = a - 100.0 * floor(a / 100.0);
  if (abs(terrain - vDistance) > 0.006 + 0.02 * vDistance) discard;
  // Kuželovitý stín smrku: u paty široký, ke špičce se zužuje.
  float w = (1.0 - vLocal.y) * 0.9 + 0.1;
  float inside = 1.0 - smoothstep(w * 0.8, w, abs(vLocal.x));
  inside *= smoothstep(0.0, 0.05, vLocal.y) * (1.0 - smoothstep(0.85, 1.0, vLocal.y));
  float mountain = texture(uShadow, vBaseUv).r;
  float k = 1.0 - uStrength * inside * mountain;
  outColor = vec4(k, k, k, 1.0);
}`;

export function createTrees(gl, { map, random }) {
  const shadowProgram = createProgram(gl, SHADOW_VS, SHADOW_FS, 'tree-shadows');
  const shadowVao = gl.createVertexArray();
  const program = createProgram(gl, VS, FS, 'trees');
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  let count = 0;

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const attribute = (name, offset) => {
    const location = program.attributes[name];
    if (location === undefined || location < 0) return;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, FLOATS * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  };
  attribute('aBase', 0);
  attribute('aShape', 4);
  gl.bindVertexArray(null);
  gl.bindVertexArray(shadowVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const [name, offset] of [['aBase', 0], ['aShape', 4]]) {
    const location = shadowProgram.attributes[name];
    if (location === undefined || location < 0) continue;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, FLOATS * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);

  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  // Hladký hodnotový šum 0..1 (neperiodický, na rozdíl od součinu sinusovek).
  const hash = (ix, iy) => { const v = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453; return v - Math.floor(v); };
  const vnoise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };

  /** Rozmístí stromy v zorném poli (jednou, pro daný výhled). */
  function plant(world) {
    const list = [];
    const step = 0.0072;
    const halfWidth = (world.aspect * world.span) / 2 + 0.05;
    for (let z = 0.06; z < TREE_NEAR; z += step) {
      for (let x = -halfWidth * z - 0.02; x < halfWidth * z + 0.02; x += step) {
        const px = x + (random() - 0.5) * step, pz = z + (random() - 0.5) * step;
        if (Math.hypot(px, pz) >= TREE_NEAR) continue;
        const ground = map.sampleFine(px, pz);
        if (ground < 0.0045) continue;                       // pláž a voda
        // Řídký les ve skupinkách (stejná myšlenka jako v terrain.js).
        // Skupinky (~30 m) a mýtiny (~150 m): les není vysázený v řádcích.
        const groups = 0.65 * vnoise(px * 33, pz * 33) + 0.35 * vnoise(px * 90 + 7, pz * 90 + 3);
        const clearing = smooth(0.62, 0.78, vnoise(px * 7 + 11, pz * 7 + 5));
        const raw = smooth(0.12, 0.55, map.sampleForest(px, pz));
        const density = smooth(0.35, 0.65, raw + 0.9 * (groups - 0.5)) * 0.95 * (1 - clearing);
        // Na strmých svazích nad jezerem (40–70°), kam les podle masky nesahá, se smrky
        // drží ve skupinkách na římsách.
        let cling = 0;
        if (density < 0.3 && ground < 0.6) {
          const e = 0.004;
          const gx = (map.sampleFine(px + e, pz) - map.sampleFine(px - e, pz)) / (2 * e);
          const gz = (map.sampleFine(px, pz + e) - map.sampleFine(px, pz - e)) / (2 * e);
          const tan = Math.hypot(gx, gz);
          if (tan > 0.8 && tan < 3.2) cling = 0.75 * smooth(0.4, 0.62, vnoise(px * 30 + 3, pz * 30 + 9) * 0.7 + vnoise(px * 120, pz * 120) * 0.3);
        }
        if (random() > Math.max(density, cling)) continue;
        const onSlope = cling > density ? 1 : 0;
        // Listnáče (buk, javor) hlavně níž u jezera ve skupinách, modříny roztroušeně.
        const low = ground < 0.25 ? 1 - ground / 0.25 : 0;
        const broad = low * (0.04 + 0.25 * smooth(0.5, 0.8, vnoise(px * 20 + 17, pz * 20 + 23)));
        const kindRoll = random();
        const kind = kindRoll < broad ? 2 : kindRoll < broad + 0.08 ? 1 : 0;
        const age = random();
        const tall = (0.013 + 0.017 * age * age * (3 - 2 * age)) * (kind === 2 ? 0.9 : 1);
        const wide = tall * (kind === 2 ? 0.6 : 0.36 + random() * 0.08);
        list.push([px, ground - 0.0008, pz, tall, wide, random(), kind, onSlope]);
      }
    }
    // Odzadu dopředu, ať bližší strom překryje vzdálenější.
    list.sort((a, b) => Math.hypot(b[0], b[2]) - Math.hypot(a[0], a[2]));
    const data = new Float32Array(list.length * FLOATS);
    list.forEach((t, i) => data.set(t, i * FLOATS));
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    count = list.length;
  }

  const nearest = gl.createSampler();
  gl.samplerParameteri(nearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.samplerParameteri(nearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  return {
    plant,
    get count() { return count; },
    /** Kreslí do právě nastaveného framebufferu (HDR obraz scény). */
    draw(o) {
      if (!count) return;
      const u = program.u;
      gl.useProgram(program.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, o.depth);
      gl.bindSampler(0, nearest);
      gl.uniform1i(u.uDepth, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, o.shadow);
      gl.uniform1i(u.uShadow, 1);
      gl.activeTexture(gl.TEXTURE0);
      const w = o.world;
      gl.uniform1f(u.uAspect, w.aspect);
      gl.uniform1f(u.uHorizon, w.horizon);
      gl.uniform1f(u.uSpan, w.span);
      gl.uniform1f(u.uMirror, w.mirror ? 1 : 0);
      gl.uniform2f(u.uSeed, ...w.seed);
      if (u.uOne) gl.uniform1i(u.uOne, 1);
      gl.uniform2f(u.uPixels, o.pixels[0], o.pixels[1]);
      gl.uniform1f(u.uTime, o.time);
      gl.uniform1f(u.uGust, o.gust);
      gl.uniform3f(u.uSun, ...o.sun);
      gl.uniform3f(u.uMoon, ...o.moon);
      gl.uniform1f(u.uMoonPhase, o.moonPhase);
      gl.uniform1f(u.uOvercast, o.overcast || 0);
      gl.uniform1f(u.uFlash, o.flash || 0);
      gl.uniform1f(u.uWinter, o.season.winter);
      gl.uniform1f(u.uAutumn, o.season.autumn);
      gl.uniform1f(u.uSpring, o.season.spring);
      // Nejdřív stíny na zem (násobení barvy), pak stromy.
      const sunUp = Math.min(1, Math.max(0, (o.sun[1] - 0.01) / 0.08));
      if (sunUp > 0) {
        const su = shadowProgram.u;
        gl.useProgram(shadowProgram.program);
        gl.uniform1i(su.uDepth, 0);
        gl.uniform1i(su.uShadow, 1);
        gl.uniform1f(su.uAspect, w.aspect);
        gl.uniform1f(su.uHorizon, w.horizon);
        gl.uniform1f(su.uSpan, w.span);
        gl.uniform1f(su.uMirror, w.mirror ? 1 : 0);
        gl.uniform3f(su.uSun, ...o.sun);
        gl.uniform1f(su.uStrength, 0.5 * sunUp);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
        gl.bindVertexArray(shadowVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
        gl.useProgram(program.program);
      }
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.bindVertexArray(null);
      gl.bindSampler(0, null);
    },
  };
}
