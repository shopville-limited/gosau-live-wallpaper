// Hejna ptáků: až čtyři najednou v různé vzdálenosti, každé v jiné formaci (klín,
// dvojitý klín, J, šikmá řada, šňůra, volné hejno kavek, kroužící káně) s náhodným
// počtem, rozestupy a úhlem ramen. Každý pták drží své místo ve formaci pružinou.
// Před kurzorem se ptáci rozprchnou a pak se zase srazí dohromady; občas jeden vyplašený
// prolétne těsně kolem kamery. Za soumraku se kavky stahují na nocoviště do lesa.
// Kreslí se jako tmavé siluety s mávajícími křídly, simulace běží s pevným krokem 1/60 s.

import { createProgram } from '../../shared/gl.js';

const FLOATS = 6; // x, y, velikost, mávnutí, náklon, průhlednost

const VS = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPos;
in vec4 aShape;   // velikost, mávnutí -1..1, náklon, průhlednost
uniform vec2 uView;
out vec2 vLocal;
out float vFlap;
out float vAlpha;
out float vPixel;
const vec2 CORNERS[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, -1), vec2(1, 1), vec2(-1, 1));
void main() {
  vec2 corner = CORNERS[gl_VertexID];
  float c = cos(aShape.z), s = sin(aShape.z);
  vec2 local = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
  vLocal = corner;
  vFlap = aShape.y;
  vAlpha = aShape.w;
  vPixel = 1.0 / aShape.x;
  gl_Position = vec4((aPos + local * aShape.x) / uView * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vFlap;
in float vAlpha;
in float vPixel;
out vec4 outColor;

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 p = vec2(abs(vLocal.x), vLocal.y);
  // Křídlo: od těla přes loket ke špičce, při mávání se zvedá a klesá.
  vec2 elbow = vec2(0.42, 0.18 + 0.22 * vFlap);
  vec2 tip = vec2(0.95, -0.02 + 0.55 * vFlap);
  float d = min(segment(p, vec2(0.0, 0.0), elbow), segment(p, elbow, tip));
  float along = clamp(p.x, 0.0, 1.0);
  float thickness = max(mix(0.13, 0.04, along), vPixel * 0.9);   // aspoň pixel
  float body = length((vLocal - vec2(0.0, -0.02)) / vec2(0.16, 0.09));
  float aa = vPixel * 1.2;
  float wing = 1.0 - smoothstep(thickness - aa, thickness + aa, d);
  float shape = max(wing, 1.0 - smoothstep(1.0 - aa * 6.0, 1.0 + aa * 6.0, body));
  float alpha = shape * vAlpha;
  if (alpha < 0.004) discard;
  outColor = vec4(vec3(0.045, 0.038, 0.05) * alpha, alpha);
}`;

const MAX_BIRDS = 160;
const MAX_FLOCKS = 4;

// Druhy hejn a jak často přiletí. Formace, jak je létají skuteční ptáci.
const KINDS = [
  ['klin', 0.28],       // husy, jeřábi: V, jedno rameno bývá delší
  ['dvojklin', 0.08],   // dva klíny za sebou
  ['jcko', 0.08],       // J: jedno rameno dlouhé, druhé krátké
  ['rada', 0.14],       // šikmá řada (echelon): kormoráni, kachny
  ['snura', 0.12],      // vlnící se šňůra jeden za druhým
  ['volne', 0.2],       // volné hejno kavek, pořád se přeskupuje
  ['dravec', 0.1],      // osamělá káně, krouží a plachtí
];

export function createBirds(gl, { config, random }) {
  const program = createProgram(gl, VS, FS, 'birds');
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  const data = new Float32Array(MAX_BIRDS * FLOATS);
  const birds = [];
  const flocks = [];
  let view = [1, 1];
  let next = config.ptaci.prvni;
  let closeCooldown = 0;   // pták u oka nejvýš jednou za čas

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  const attribute = (name, size, offset) => {
    const location = program.attributes[name];
    if (location === undefined || location < 0) return;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, FLOATS * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  };
  attribute('aPos', 2, 0);
  attribute('aShape', 4, 2);
  gl.bindVertexArray(null);

  const pick = () => {
    let roll = random() * KINDS.reduce((sum, [, w]) => sum + w, 0);
    for (const [kind, w] of KINDS) { roll -= w; if (roll <= 0) return kind; }
    return 'klin';
  };

  // Místo ptáka ve formaci (v rozestupech, x dozadu za vůdcem, y nahoru).
  function slotFor(f, index) {
    const jitter = () => (random() - 0.5) * f.jitter;
    if (f.kind === 'dravec') return [0, 0];
    if (index === 0) return [0, 0];
    if (f.kind === 'klin' || f.kind === 'jcko' || f.kind === 'dvojklin') {
      let i = index, back = 0;
      if (f.kind === 'dvojklin' && index >= f.count / 2) {
        // Druhý klín kousek za prvním a trochu stranou.
        i = index - Math.floor(f.count / 2);
        back = f.count * 0.28;
        if (i === 0) { f.left = 0; f.right = 0; return [-back, f.spread * 1.5]; }
      }
      // Rameno: podle poměru víc ptáků na jedné straně (J = skoro všichni).
      const side = random() < f.bias ? 1 : -1;
      const counter = side > 0 ? 'right' : 'left';
      f[counter] = (f[counter] || 0) + 1;
      const rank = f[counter];
      return [-back - rank * 1.0 + jitter(), side * rank * f.spread + (back ? f.spread * 1.5 : 0) + jitter()];
    }
    if (f.kind === 'rada') return [-index * 0.9 + jitter(), -index * f.spread * 0.8 + jitter()];
    if (f.kind === 'snura') return [-index * 1.05 + jitter(), Math.sin(index * 0.7) * 0.5 + jitter()];
    // Volné hejno: náhodně v protáhlém oblaku.
    const a = random() * Math.PI * 2, r = Math.sqrt(random());
    return [Math.cos(a) * r * f.count * 0.18, Math.sin(a) * r * f.count * 0.09];
  }

  function flock(forced = false, roosting = false) {
    if (flocks.length >= MAX_FLOCKS) return;
    const [w, h] = view;
    const kind = roosting ? 'volne' : pick();
    // Vzdálenost: vzdálená hejna jsou menší, pomalejší, níž nad obzorem a bledší.
    const depth = forced ? 0.8 + random() * 0.2 : 0.4 + random() * 0.6;
    let heading = random() < 0.5 ? 1 : -1;
    // Nocoviště v lese na jedné ze stran údolí; hejno přiletí z opačné strany.
    const roost = roosting ? { x: w * (heading > 0 ? 0.72 + random() * 0.2 : 0.08 + random() * 0.2), y: h * (0.38 + random() * 0.1) } : null;
    const base = config.ptaci.pocet;
    let count;
    if (kind === 'dravec') count = 1;
    else if (kind === 'volne') count = Math.round(base * (roosting ? 1.2 + random() * 0.8 : 0.6 + random() * 1.1));
    else if (kind === 'snura' || kind === 'rada') count = Math.round(base * (0.25 + random() * 0.5));
    else count = Math.round(base * (0.35 + random() * 0.8));
    count = Math.max(1, Math.min(count, MAX_BIRDS - birds.length));
    if (count < 1) return;
    const small = kind === 'volne';
    const f = {
      kind, heading, depth, count,
      x: heading > 0 ? -60 : w + 60,
      y: h * (0.6 + 0.12 * depth + random() * 0.22 * depth),
      speed: (kind === 'dravec' ? 14 : small ? 70 : 55) * (0.6 + 0.4 * depth) * (0.85 + random() * 0.3),
      spacing: (small ? 14 : 20 + random() * 10) * depth,
      // Úhel ramen; velká hejna mají klín užší, jinak by zabrala půl oblohy.
      spread: (0.25 + random() * 0.35) * (count > 16 ? 0.75 : 1),
      bias: kind === 'jcko' ? 0.85 : 0.35 + random() * 0.3,
      jitter: kind === 'volne' ? 0 : 0.1 + random() * 0.25,
      drift: random() * 10,
      climb: (random() - 0.5) * 6 * depth,
      circle: (40 + random() * 50) * depth,
      roost, startY: 0, arrived: 0,
    };
    f.startY = f.y;
    flocks.push(f);
    for (let i = 0; i < count; i++) {
      const [sx, sy] = slotFor(f, i);
      const size = (kind === 'dravec' ? 15 + random() * 3 : small ? 5 + random() * 1.5 : 9 + random() * 3) * depth;
      birds.push({
        flock: f,
        slot: [sx, sy],
        wander: random() * 10,
        x: f.x + heading * sx * f.spacing + (random() - 0.5) * 6,
        y: f.y + sy * f.spacing + (random() - 0.5) * 6,
        vx: heading * f.speed,
        vy: 0,
        // Křídla mávají skoro souběžně, s malým zpožděním dozadu ve formaci; kavky rychle.
        phase: -i * 0.35 + random() * (small ? 6 : 0.4),
        rate: small ? 8.5 + random() * 2 : kind === 'dravec' ? 3.5 : 5.5 + random() * 0.8,
        size: Math.max(3, size),
        alpha: 0.55 + 0.35 * depth,
        age: 0,
        scared: 0,
      });
    }
  }

  function step(dt, pointer, allowNew = true, dusk = false) {
    next -= dt;
    closeCooldown -= dt;
    if (next <= 0 && allowNew) {
      // Za soumraku hlavně kavky na cestě na nocoviště.
      flock(false, dusk && random() < 0.7);
      // Další hejno za náhodnou dobu (exponenciálně), víc hejn může letět najednou.
      next = -Math.log(1 - random() * 0.999) * config.ptaci.kazdych * (dusk ? 0.5 : 1) + 6;
    }
    const [w, h] = view;
    const shy = config.ptaci.plachost;
    for (const b of birds) {
      b.px = b.x;
      b.py = b.y;
      b.pphase = b.phase;
    }
    for (const f of flocks) {
      // Formace letí skoro rovně, pomalu stoupá a klesá; úhel ramen se pozvolna mění.
      f.drift += dt;
      if (f.kind === 'blizko') continue;
      if (f.roost) {
        // Na nocoviště: klesá k lesu, nad ním chvíli krouží a pak zapadne do korun.
        const left = (f.roost.x - f.x) * f.heading;
        if (left > 0 && f.arrived === 0) {
          f.x += f.heading * Math.min(f.speed * dt, left);
          const total = Math.abs(f.roost.x - (f.heading > 0 ? -60 : w + 60));
          const done = 1 - left / total;
          f.y = f.startY + (f.roost.y - f.startY) * done * done;
        } else {
          f.arrived += dt;
          f.x = f.roost.x + Math.sin(f.arrived * 0.8) * 30 * f.depth;
          f.y = f.roost.y - f.arrived * 4;
        }
        continue;
      }
      f.x += f.heading * f.speed * dt;
      f.y += (Math.sin(f.drift * 0.25) * 4 + f.climb) * dt;
      if (f.y < h * 0.55) f.y += (h * 0.55 - f.y) * dt;
      if (f.y > h * 0.97) f.y += (h * 0.97 - f.y) * dt;
    }
    for (const b of birds) {
      let ax = 0, ay = 0;
      const f = b.flock;
      if (f.kind === 'blizko') {
        // Pták u oka letí rovně pryč, jen mírně stoupá.
        b.vy += 20 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.age += dt;
        b.phase += dt * b.rate;
        continue;
      }
      let tx, ty;
      if (f.kind === 'dravec') {
        // Káně krouží v termice a pomalu se posouvá.
        const a = f.drift * 0.35;
        tx = f.x + Math.cos(a) * f.circle;
        ty = f.y + Math.sin(a) * f.circle * 0.3;
      } else if (f.kind === 'volne' && f.arrived > 0) {
        // Nad nocovištěm: zmatené kroužení, ptáci postupně mizí v korunách.
        const t = f.drift + b.wander;
        tx = f.x + (b.slot[0] * 0.6 + Math.sin(t * 1.3) * 1.5) * f.spacing;
        ty = f.y + (b.slot[1] * 0.6 + Math.cos(t * 1.1) * 0.8) * f.spacing - f.arrived * b.wander * 2;
        b.vanish = Math.min(1, Math.max(0, (f.arrived - 3 - b.wander * 0.7) / 2));
      } else if (f.kind === 'volne') {
        // Volné hejno: každý pták bloudí kolem svého místa, oblak se vlní.
        const t = f.drift + b.wander;
        tx = f.x + f.heading * (b.slot[0] + Math.sin(t * 0.7) * 1.2) * f.spacing;
        ty = f.y + (b.slot[1] + Math.cos(t * 0.9) * 0.8 + Math.sin(f.drift * 0.3 + b.slot[0] * 0.2) * 1.5) * f.spacing;
      } else {
        const breathe = 1 + 0.06 * Math.sin(f.drift * 0.5 + b.slot[0]);
        const open = 1 + 0.12 * Math.sin(f.drift * 0.13);   // ramena se rozevírají a svírají
        tx = f.x + f.heading * b.slot[0] * f.spacing * breathe;
        ty = f.y + b.slot[1] * f.spacing * breathe * open + Math.sin(f.drift * 1.3 + b.slot[0]) * 1.5;
      }
      // Pružina k vlastnímu místu; vystrašený pták se vrací pomaleji.
      const pull = b.scared > 0 ? 0.6 : f.kind === 'volne' ? 2.0 : 3.0;
      ax += (tx - b.x) * pull + (f.heading * f.speed - b.vx) * (f.kind === 'dravec' ? 0.3 : 1.6);
      ay += (ty - b.y) * pull + (0 - b.vy) * 1.6;
      let fleeing = false;
      if (pointer.present) {
        const dx = b.x - pointer.x, dy = b.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < shy && d > 0.1) {
          const push = (1 - d / shy) * 1400;
          ax += (dx / d) * push;
          ay += (dy / d) * push;
          fleeing = true;
          // Občas jeden vyplašený pták prolétne těsně kolem kamery.
          if (b.scared <= 0 && closeCooldown <= 0 && random() < 0.25) closeBird(b, dx, dy);
          b.scared = 2.5;
        }
      }
      b.scared = Math.max(0, b.scared - dt);
      b.vx += ax * dt;
      b.vy += ay * dt;
      const speed = Math.hypot(b.vx, b.vy);
      const top = fleeing ? 260 : 150;
      if (speed > top) { b.vx *= top / speed; b.vy *= top / speed; }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.age += dt;
      b.phase += dt * b.rate * (fleeing || b.scared > 0 ? 1.8 : 1);
    }
    for (let i = birds.length - 1; i >= 0; i--) {
      const b = birds[i];
      const out = b.x < -200 || b.x > w + 200 || b.y > h + 160;
      if ((b.age > 3 && out) || (b.vanish || 0) >= 1) birds.splice(i, 1);
    }
    for (let i = flocks.length - 1; i >= 0; i--) {
      if (!birds.some((b) => b.flock === flocks[i])) flocks.splice(i, 1);
    }
  }

  // Pták u oka: velký, blízko, rychle mává a uletí z obrazovky.
  function closeBird(from, dx, dy) {
    if (birds.length >= MAX_BIRDS) return;
    closeCooldown = 20;
    const f = { kind: 'blizko', heading: Math.sign(dx) || 1, depth: 1, count: 1, drift: 0, x: from.x, y: from.y };
    flocks.push(f);
    const d = Math.hypot(dx, dy) || 1;
    birds.push({
      flock: f, slot: [0, 0], wander: 0,
      x: from.x, y: from.y,
      vx: (dx / d) * 320 + Math.sign(dx || 1) * 80, vy: Math.max(40, (dy / d) * 200),
      phase: 0, rate: 9, size: 42 + random() * 18, alpha: 0.95, age: 0, scared: 0,
    });
  }

  return {
    setView(width, height) { view = [width, height]; },
    flock() { flock(true); },
    roost() { flock(true, true); },
    step,
    draw({ dpr, blend = 1 }) {
      if (!birds.length) return;
      let n = 0;
      for (const b of birds) {
        if (n >= MAX_BIRDS) break;
        // Mávání: klouzání střídá rychlé údery křídel. Formace občas společně plachtí,
        // dravec plachtí skoro pořád.
        const soar = b.flock.kind === 'dravec';
        const glide = b.scared > 0 ? 0 : soar
          ? Math.min(1, Math.max(0, (Math.sin(b.age * 0.3) + 0.7) * 3))
          : Math.min(1, Math.max(0, (Math.sin(b.age * 0.45 + b.flock.drift) - 0.55) * 3));
        const phase = b.pphase === undefined ? b.phase : b.pphase + (b.phase - b.pphase) * blend;
        const flap = Math.sin(phase) * (1 - glide) + (soar ? 0.15 : 0.3) * glide;
        const x = b.px === undefined ? b.x : b.px + (b.x - b.px) * blend;
        const y = b.py === undefined ? b.y : b.py + (b.y - b.py) * blend;
        const tilt = Math.max(-0.5, Math.min(0.5, Math.atan2(b.vy, Math.abs(b.vx)) * 0.5 * Math.sign(b.vx)));
        const fade = Math.min(1, b.age / 0.5) * (1 - (b.vanish || 0));
        data.set([x * dpr, y * dpr, b.size * dpr, flap, tilt, b.alpha * fade], n * FLOATS);
        n++;
      }
      gl.useProgram(program.program);
      gl.uniform2f(program.u.uView, view[0] * dpr, view[1] * dpr);
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
    get count() { return birds.length; },
    get points() { return birds.map((b) => [Math.round(b.x), Math.round(b.y), +b.size.toFixed(1)]); },
    get flocks() { return flocks.map((f) => ({ kind: f.kind, count: f.count, depth: +f.depth.toFixed(2) })); },
    // Pro samotest: poslední přivolané hejno (výřez kolem něj).
    get debug() {
      const formation = flocks[flocks.length - 1] || null;
      return { formation, first: birds.slice(0, 3).map((b) => [Math.round(b.x), Math.round(b.y)]) };
    },
  };
}
