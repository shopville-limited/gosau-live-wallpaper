// Každý snímek: osvětlí materiál krajiny podle polohy slunce a měsíce a přidá, co se hýbe.
// Stíny hor a mraků, vítr v lese, rozsvícená okna, obloha s mraky, hvězdami a měsícem,
// zrcadlení v jezeře s vlnkami, zamrzlé jezero, mlha, sněžení,
// hloubková paralaxa, tónová křivka a dithering.
//
// Kreslí se ve dvou průchodech, aby se osvětlení nepočítalo dvakrát:
//   1. krajina a obloha do HDR textury (pixely jezera zůstanou prázdné),
//   2. jezero čte odraz z té textury, pak tónová křivka a sněžení na obrazovku.

import { FULLSCREEN_VS, createProgram, createTarget } from '../../shared/gl.js';
import { NOISE } from '../../shared/glsl.js';
import { CAMERA, ATMOSPHERE } from './world.js';
import { MAX_BOATS } from './boats.js';

const source = (pass) => /* glsl */ `#version 300 es
#define ${pass} 1
precision highp float;
precision highp int;
uniform sampler2D uAlbedo;       // plné rozlišení
uniform sampler2D uNormal;
uniform sampler2D uExtra;
uniform sampler2D uAlbedoLow;    // náhled
uniform sampler2D uNormalLow;
uniform sampler2D uExtraLow;
uniform sampler2D uDepth;        // táž textura jako uAlbedo, bez filtrování (vzdálenost)
uniform sampler2D uDepthLow;
uniform sampler2D uShadowFrom;
uniform sampler2D uShadowTo;
uniform sampler2D uNoise;
uniform sampler2D uScene;         // výsledek prvního průchodu
uniform sampler2D uClouds;        // mraky ve čtvrtinovém rozlišení
uniform vec2 uCloudRes;
uniform sampler2D uLakeMap;       // výšky okolí jezera po 5 m (hloubka vody)
uniform vec4 uLakeRect;
uniform float uShadowMix;
uniform float uFull;             // 0 = náhled, 1 = plné rozlišení
uniform vec2 uPixels;
uniform vec2 uParallax;          // posun nejbližšího terénu v souřadnicích obrazovky
uniform float uExposure;
uniform float uContrast;
uniform float uCover;            // pokrytí oblohy mraky
uniform float uCirrus;           // cirry (vysoká oblačnost)
uniform vec2 uCloudShift;        // posun mraků větrem
uniform float uRipple;           // zčeření hladiny
uniform float uGust;             // poryv větru 0..1
uniform float uMist;
uniform float uIce;              // zamrzlé jezero 0..1
uniform float uSnowfall;         // sněžení 0..1
uniform float uRain;             // déšť 0..1
uniform float uHour;             // místní čas v hodinách (0–24)
uniform float uMeteorSeed;       // pořadí padající hvězdy (mění se s každou novou)
uniform float uMeteorAge;        // s od začátku letu padající hvězdy (0..1,2 = letí)
uniform float uRealStars;        // 1 = hvězdy z katalogu (stars.js), vymyšlené se nekreslí
uniform mat3 uGalactic;          // svět → galaktické souřadnice (Mléčná dráha)
uniform vec2 uBolt[12];          // kanál blesku v souřadnicích obrazovky (0..1), 12 bodů
uniform float uBoltAlpha;        // jas kanálu blesku (0 = žádný)
uniform vec4 uBoats[${MAX_BOATS}];   // loďky pro brázdy: x, z (km), kurz, rychlost (km/s)
out vec4 outColor;

${NOISE}
${CAMERA}
${ATMOSPHERE}

struct Material {
  vec3 albedo;
  float depth;       // kódovaná alfa (viz terrain.js)
  vec3 normal;
  float forest;
  float occlusion;
  float lights;
  float snow;
};

Material materialAt(vec2 uv) {
  Material m;
  vec4 a, n, e;
  float depth;
  if (uFull >= 1.0) {
    // Plné rozlišení hotové: náhled už se nečte.
    a = texture(uAlbedo, uv);
    n = texture(uNormal, uv);
    e = texture(uExtra, uv);
    depth = texture(uDepth, uv).a;
  } else {
    a = texture(uAlbedoLow, uv);
    n = texture(uNormalLow, uv);
    e = texture(uExtraLow, uv);
    depth = texture(uDepthLow, uv).a;
    if (uFull > 0.0) {
      a = mix(a, texture(uAlbedo, uv), uFull);
      n = mix(n, texture(uNormal, uv), uFull);
      e = mix(e, texture(uExtra, uv), uFull);
      depth = texture(uDepth, uv).a;
    }
  }
  m.albedo = a.rgb;
  m.depth = depth;
  m.normal = normalize(n.xyz + vec3(0.0, 1e-4, 0.0));
  m.forest = n.w;
  m.occlusion = e.r;
  m.lights = e.g;
  m.snow = e.b;
  return m;
}

float depthAt(vec2 uv) {
  return uFull > 0.0 ? texture(uDepth, uv).a : texture(uDepthLow, uv).a;
}

// Terén: vzdálenost a podíl paprsků, které v pixelu šly do oblohy.
vec2 terrainDepth(float a) {
  float k = floor(a / 100.0);
  return vec2(a - 100.0 * k, k / 4.0);
}

// Kupovité mraky: vrstva 2,4–4,6 km nad jezerem. Kde je mraků víc, tam rostou výš
// (věže), základna je rovná. Hustota v prostoru se skládá z 2D šumu pro pokrytí
// a z šumu posunutého s výškou (napodobí 3D boule a cáry na okrajích).
const float CLOUD_BASE = 2.4;
const float CLOUD_TOP = 4.6;

float cloudCoverage(vec2 xz) {
  vec2 q = xz * 0.018 + uCloudShift;
  float shape = texture(uNoise, q).r;
  float billows = texture(uNoise, q * 2.7 + 0.31).r;
  float n = shape * 0.7 + billows * 0.3;
  float start = 0.64 - 0.30 * uCover;
  return smoothstep(start, start + 0.2, n);
}

// Pro stíny mraků na krajině (stačí pokrytí).
float cloudDensity(vec2 xz) {
  return cloudCoverage(xz);
}

float cloudAt(vec3 p) {
  float h = (p.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
  if (h < 0.0 || h > 1.0) return 0.0;
  float c = cloudCoverage(p.xz);
  if (c <= 0.0) return 0.0;
  // Boule v prostoru: šum posunutý s výškou (napodobí 3D kupy).
  vec2 q = p.xz * 0.11 + vec2(p.y * 0.23, -p.y * 0.17) + uCloudShift * 6.0;
  float puffs = texture(uNoise, q).r;
  float small = texture(uNoise, q * 2.6 + 0.41).r;
  // Věž: výška podle pokrytí i boulí, vršek „květákový“, spodek rovný.
  float top = (0.2 + 0.8 * c) * (0.55 + 0.6 * puffs + 0.2 * small);
  float body = smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(top * 0.7, top, h));
  float d = body * c - (1.0 - puffs) * 0.35 - (1.0 - small) * 0.12;
  return clamp(d * 3.0, 0.0, 1.0);
}

// Mraky podél paprsku: rgb = světlo mraků, a = kolik oblohy za nimi prosvítá.
// Počítá se ve čtvrtinovém rozlišení do textury (mraky jsou měkké), viz PASS_CLOUDS.
vec4 cloudMarch(vec3 rd) {
  if (rd.y <= 0.004) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = CLOUD_BASE / rd.y;
  float t1 = min(CLOUD_TOP / rd.y, t0 + 14.0);
  if (t0 > 90.0) return vec4(0.0, 0.0, 0.0, 1.0);
  // Pochod paprsku vrstvou mraků s náhodným posunem začátku (bez proužků).
  const int STEPS = 44;
  float dt = (t1 - t0) / float(STEPS);
  // Posun rozprostřený rovnoměrně mezi sousední pixely (interleaved gradient noise):
  // náhodný hash dělal po zvětšení z čtvrtinového rozlišení vatové chuchvalce.
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t = t0 + dt * jitter;
  vec3 toward = uSun.y > -0.05 ? uSun : uMoon;
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 lightColor = sunLight() * 0.55 + moonLight() * 0.18;   // měsíc mraky jen jemně stříbří
  float cosAngle = dot(rd, toward);
  // Rozptyl dopředu (stříbrné okraje proti slunci) i dozadu.
  float g1 = 0.6, g2 = -0.25;
  float phase = mix((1.0 - g1 * g1) / pow(1.0 + g1 * g1 - 2.0 * g1 * cosAngle, 1.5),
                    (1.0 - g2 * g2) / pow(1.0 + g2 * g2 - 2.0 * g2 * cosAngle, 1.5), 0.35) * 0.35;
  float transmit = 1.0;
  vec3 light = vec3(0.0);
  for (int i = 0; i < STEPS * uOne; i++) {
    vec3 p = rd * t + vec3(0.0, CAMERA_HEIGHT, 0.0);
    float d = cloudAt(p);
    if (d > 0.01) {
      // Kolik mraku je mezi tímto bodem a sluncem (tři kroky).
      float shade = 0.0;
      for (int k = 1; k <= 3 * uOne; k++) shade += cloudAt(p + toward * (0.18 * float(k * k)));
      float sun = exp(-shade * 3.0) * (1.0 - exp(-d * 4.0));
      float h = (p.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
      // Spodek kupy je v jejím vlastním stínu šedomodrý, vršek dostává světlo oblohy.
      vec3 ambient = mix(horizon * 0.22 + zenith * 0.2, zenith * 0.8 + horizon * 0.3, smoothstep(0.0, 0.8, h));
      vec3 afterglow = vec3(1.0, 0.38, 0.22) * exp(-pow((uSun.y + 0.03) / 0.05, 2.0)) * 1.1 * (0.4 + 0.6 * h);
      vec3 color = lightColor * sun * phase * 3.2 + ambient + afterglow;
      float absorb = exp(-d * dt * 7.0);
      light += transmit * (1.0 - absorb) * color;
      transmit *= absorb;
      if (transmit < 0.02) break;
    }
    t += dt;
  }
  // Vzdálené mraky splývají s oblohou.
  float haze = 1.0 - exp(-t0 / 45.0);
  vec3 clouds = mix(light, (1.0 - transmit) * skyColor(rd), haze);
  return vec4(clouds, transmit);
}

// Padající hvězda: krátká čára, která se rozsvítí, přeletí a zhasne (na obloze i v odrazu).
vec3 meteor(vec2 uv) {
  if (uMeteorAge < 0.0 || uMeteorAge > 1.2) return vec3(0.0);
  float night = 1.0 - smoothstep(-0.18, -0.08, uSun.y);
  if (night <= 0.0) return vec3(0.0);
  vec2 h = hash22(vec2(uMeteorSeed, 7.1));
  vec2 start = vec2(0.15 + 0.7 * h.x, uHorizon + 0.35 + 0.5 * (1.0 - uHorizon) * h.y);
  vec2 dir = normalize(vec2(h.x < 0.5 ? 1.0 : -1.0, -0.45 - 0.4 * h.y));
  float aspect = uPixels.x / uPixels.y;
  float speed = 0.45;
  float head = uMeteorAge * speed;
  vec2 q = (uv - start) * vec2(aspect, 1.0);
  float along = dot(q, dir);
  float side = abs(q.x * dir.y - q.y * dir.x);
  float tail = 0.12;
  float onTrail = step(head - tail, along) * step(along, head);
  float fade = smoothstep(0.0, 0.15, uMeteorAge) * (1.0 - smoothstep(0.7, 1.2, uMeteorAge));
  float glow = exp(-side * side * 3.0e6) * onTrail * smoothstep(head - tail, head, along);
  return vec3(0.9, 0.95, 1.0) * glow * fade * night * 1.6;
}

vec3 skyWithClouds(vec3 rd, vec2 uv) {
  vec3 sky = skyColor(rd) + moonDisk(rd) + meteor(uv) * (1.0 - uOvercast);
  if (rd.y <= 0.004) return sky;
  // Rozmazané čtení (9 bodů, Gauss): textura mraků má čtvrtinové rozlišení a posun kroků.
  vec2 px = 1.0 / vec2(textureSize(uClouds, 0));
  vec4 cl = texture(uClouds, uv) * 0.25
          + (texture(uClouds, uv + vec2(px.x, 0.0)) + texture(uClouds, uv - vec2(px.x, 0.0))
           + texture(uClouds, uv + vec2(0.0, px.y)) + texture(uClouds, uv - vec2(0.0, px.y))) * 0.125
          + (texture(uClouds, uv + px) + texture(uClouds, uv - px)
           + texture(uClouds, uv + vec2(px.x, -px.y)) + texture(uClouds, uv - vec2(px.x, -px.y))) * 0.0625;
  // Cirry: tenké vláknité mraky vysoko (8 km), protažené větrem; nasvícené i po západu.
  vec2 hi = rd.xz / rd.y * 8.0;
  vec2 base = hi * 0.012 + uCloudShift * 0.3;
  // Vlákna ohnutá prouděním a roztrhaná do chomáčů (ne rovné pruhy).
  vec2 warp = vec2(texture(uNoise, base * 0.7).r, texture(uNoise, base * 0.7 + 0.37).r) - 0.5;
  vec2 cq = base + warp * 0.35;
  cq = vec2(cq.x * 0.35 + cq.y * 0.15, cq.y * 2.2 - cq.x * 0.5);
  float streak = texture(uNoise, cq).g;
  float patches = smoothstep(0.28, 0.6, texture(uNoise, base * 0.5 + 0.61).r);
  float cirrus = smoothstep(0.38, 0.7, streak) * patches * 0.4 * smoothstep(0.02, 0.2, rd.y) * uCirrus;
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 cirrusColor = sunLight() * 0.35 + horizon * 0.6 + vec3(1.0, 0.45, 0.35) * exp(-pow((uSun.y + 0.05) / 0.06, 2.0)) * 0.9;
  cirrus *= 1.0 - uOvercast;   // nad souvislou vrstvou cirry nejsou vidět
  sky = mix(sky, cirrusColor, cirrus);
  sky += stars(rd) * (1.0 - cirrus) * (1.0 - uRealStars);
  // Mléčná dráha na skutečném místě: pás podél galaktického rovníku, jasnější ke středu
  // Galaxie (Střelec), s tmavou prachovou trhlinou a shluky. Jen za tmy bez měsíce.
  float darkSky = (1.0 - smoothstep(-0.3, -0.18, uSun.y)) * (1.0 - uOvercast) * (1.0 - cirrus)
                * (1.0 - 0.7 * smoothstep(-0.02, 0.1, uMoon.y) * sin(3.14159 * uMoonPhase));
  if (darkSky > 0.0 && rd.y > 0.0 && uRealStars > 0.5) {
    vec3 g = uGalactic * rd;
    float b = asin(clamp(g.z, -1.0, 1.0));
    float l = atan(g.y, g.x);
    // Pás: úzké jasné jádro a široké slabé halo (disk Galaxie).
    float band = exp(-pow(b / 0.11, 2.0)) + 0.18 * exp(-pow(b / 0.3, 2.0));
    float core = exp(-pow(l / 0.9, 2.0) - pow(b / 0.25, 2.0));
    // Oblaka hvězd bez pruhů: šum stejně jemný podél i napříč pásem.
    vec2 gq = vec2(l, b);
    // Hvězdná mračna: jemná zrnitá struktura (stupně), ne velké chuchvalce.
    float clumps = texture(uNoise, gq * 1.8 + 0.3).r * 0.5 + texture(uNoise, gq * 5.0 + 0.7).r * 0.35 + texture(uNoise, gq * 14.0 + 0.2).r * 0.15;
    float rift = smoothstep(0.45, 0.7, texture(uNoise, gq * 5.0 + 0.1).r) * exp(-pow(b / 0.07, 2.0)) * smoothstep(-1.8, 0.0, -abs(l));
    // Hvězdná mračna výrazná (kontrast oblaků a mezer), barva: teplejší u jádra, jinde
    // chladně bílá; tmavá trhlina a prachové pruhy.
    float clouds = smoothstep(0.4, 0.75, clumps);
    vec3 tint = mix(vec3(0.62, 0.68, 0.85), vec3(0.9, 0.78, 0.62), clamp(core * 1.5, 0.0, 1.0));
    vec3 mw = tint * (band * (0.2 + 1.1 * clouds) + core * 2.0) * (1.0 - 0.8 * rift);
    // Nízko u obzoru ji utlumí vzduch, ale ne úplně.
    float air = mix(0.35, 1.0, smoothstep(0.0, 0.2, rd.y));
    sky += mw * 0.04 * darkSky * air;
    // Zrno: tisíce drobných slabých hvězd, jejichž hustota sleduje pás a mračna.
    // Tím Mléčná dráha vypadá jako na fotce, ne jako mlha.
    float density = clamp(band * (0.15 + 0.9 * clouds) * (1.0 - 0.85 * rift) + core, 0.0, 1.0);
    vec3 cellPos = rd * 2200.0;
    vec3 cell = floor(cellPos);
    float h1 = hash12(cell.xy + cell.z * vec2(17.3, 5.1));
    float h2 = hash12(cell.yz + cell.x * vec2(3.7, 11.9));
    float speck = step(h1, density * density * 0.14) * (0.3 + 0.7 * h2 * h2 * h2);
    vec3 sub = fract(cellPos) - 0.5;
    speck *= exp(-dot(sub, sub) * 5.0);
    sky += tint * speck * 0.12 * darkSky * air;
  }
  // Souvislá vrstva (altostratus, při dešti nimbostratus): šedé nebe s mírnými vlnami
  // a tmavšími cáry, slunce jí prosvítá jako rozmazaná světlá skvrna, dokud není hustá.
  if (uOvercast > 0.0) {
    vec2 q = rd.xz / max(rd.y, 0.04) * 0.12 + uCloudShift * 0.4;
    float waves = texture(uNoise, q).r * 0.6 + texture(uNoise, q * 3.3 + 0.37).r * 0.4;
    float thick = clamp(uOvercast * 1.25 + (waves - 0.5) * 0.6, 0.0, 1.0);
    vec3 sheet = mix(horizon, zenith, 0.3) * (0.8 + 0.4 * waves) * (1.0 - 0.3 * uRain);
    float glowSun = pow(max(dot(rd, uSun), 0.0), 6.0) * (1.0 - smoothstep(0.6, 1.0, uOvercast));
    sheet += vec3(1.0, 0.95, 0.85) * glowSun * smoothstep(-0.02, 0.1, uSun.y) * 0.6;
    sky = mix(sky, sheet, thick * smoothstep(0.0, 0.06, rd.y + 0.02));
  }
  return sky * cl.a + cl.rgb;
}

vec3 mistColor() {
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  return horizon * 0.6 + sunLight() * 0.03 + moonLight() * 0.5;
}

// Osvětlení terénu v bodě obrazovky.
vec3 litTerrain(vec2 uv, Material m, vec3 rd, float t) {
  vec3 P = vec3(0.0, CAMERA_HEIGHT, 0.0) + rd * t;
  vec3 n = m.normal;
  // Vítr v lese: každá koruna se pohupuje po svém, přes les se přelévají poryvy.
  float near = 1.0 - smoothstep(1.5, 7.0, t);
  if (m.forest > 0.01 && near > 0.0) {
    vec2 cell = floor(P.xz * 140.0);
    float h = hash12(cell);
    float wave = texture(uNoise, P.xz * 0.9 - vec2(uTime * 0.05, uTime * 0.012)).r;
    float strength = (0.3 + 1.3 * smoothstep(0.45, 0.8, wave) + uGust * 1.6) * near * m.forest;
    float sway = sin(uTime * (1.3 + h * 1.2) + h * 40.0 + wave * 6.0);
    float nod = cos(uTime * (1.0 + h) + h * 17.0);
    n = normalize(n + vec3(sway * 0.2, 0.0, nod * 0.1) * strength);
  }
  float shade = mix(texture(uShadowFrom, uv).r, texture(uShadowTo, uv).r, uShadowMix);
  bool sunLights = uSun.y > -0.03;
  float sunShadow = sunLights ? shade : 1.0;
  float moonShadow = sunLights ? 1.0 : shade;
  // Stíny mraků plují po krajině.
  float cloudShade = 1.0;
  if (uSun.y > 0.0) {
    vec3 Q = P + uSun * ((CLOUD_BASE + 0.4 - P.y) / max(uSun.y, 0.06));
    cloudShade = 1.0 - 0.7 * cloudDensity(Q.xz);
  }
  vec3 sun = sunLight();
  float diffuse = max(dot(n, uSun), 0.0);
  vec3 direct = sun * diffuse * sunShadow * cloudShade + moonLight() * max(dot(n, uMoon), 0.0) * moonShadow;
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  // Světlo oblohy: ve dne slabší (převládá slunce), v šeru a v noci je to hlavní světlo.
  // Ve stínu hor je údolí pořád plné světla oblohy (jasná obloha ve dne svítí hodně).
  float skyShare = mix(1.1, 0.8, smoothstep(0.05, 0.35, uSun.y));
  // Při nízkém slunci svítí do stínu hlavně modrá klenba, ne růžový pás u obzoru.
  vec3 skyAmbient = mix(horizon, zenith, mix(0.88, 0.6, smoothstep(0.03, 0.2, uSun.y)));
  // Stín ve skutečnosti není tak modrý: část světla oblohy je bílá z oparu a mraků.
  skyAmbient = mix(skyAmbient, vec3(dot(skyAmbient, vec3(0.3, 0.5, 0.2))), 0.35 * smoothstep(0.05, 0.3, uSun.y));
  vec3 ambient = skyAmbient * (0.55 + 0.45 * n.y) * skyShare * m.occlusion;
  // Odražené světlo: osluněné protější svahy a údolí svítí do stínů teplým, lehce
  // nazelenalým světlem (průměrná barva krajiny). Nejvíc na svislé plochy a do údolí.
  float sunUp = smoothstep(-0.02, 0.25, uSun.y);
  vec3 bounce = sun * vec3(0.20, 0.20, 0.15) * sunUp * 0.28 * (0.7 - 0.45 * n.y);
  ambient += bounce * mix(0.6, 1.0, m.occlusion) * mix(1.0, cloudShade, 0.5);
  // Za deště je krajina mokrá: tmavší, sytější.
  vec3 albedo = m.albedo * (1.0 - 0.28 * uRain * (1.0 - m.snow));
  vec3 c = albedo * (direct + ambient);
  // Jehličí propouští trochu světla: proti slunci svítí okraje korun teple zeleně.
  float backlit = pow(max(dot(rd, uSun), 0.0), 3.0) * m.forest * sunShadow;
  c += m.albedo * vec3(0.8, 1.2, 0.5) * sun * backlit * 0.35;
  // Alpenglow: sníh na slunci kolem východu a západu růžoví.
  float glow = exp(-pow((uSun.y - 0.04) / 0.07, 2.0));
  c += vec3(0.45, 0.10, 0.16) * m.snow * diffuse * sunShadow * glow;
  // Okna vesnice se rozsvítí za soumraku.
  float evening = 1.0 - smoothstep(-0.02, 0.07, uSun.y);
  // Okno chaty: svítí za soumraku, kolem 22. hodiny zhasne (chata spí), před svítáním
  // se rozsvítí (horolezci vstávají brzy) a za světla zhasne.
  float awake = 1.0 - smoothstep(21.8, 22.2, uHour) * (1.0 - smoothstep(4.3, 4.6, uHour));
  c += vec3(1.0, 0.60, 0.26) * m.lights * evening * awake * 4.0;
  // Ranní rosa: na trávě a loukách blízko kamery se v nízkém ranním slunci třpytí kapky.
  float morning = smoothstep(5.0, 6.5, uHour) * (1.0 - smoothstep(9.0, 10.5, uHour));
  if (morning > 0.0 && t < 0.6 && m.snow < 0.5 && m.forest < 0.3 && n.y > 0.75) {
    vec2 cell = floor(gl_FragCoord.xy * 0.5);
    float h = hash12(cell + floor(uTime * 0.7) * 0.0 + 17.0);
    float twinkle = 0.5 + 0.5 * sin(uTime * (2.0 + 5.0 * hash12(cell + 3.0)) + h * 40.0);
    float dew = step(0.985, h) * twinkle * morning * (1.0 - smoothstep(0.2, 0.6, t));
    c += sunLight() * sunShadow * dew * 0.6 * smoothstep(0.0, 0.06, uSun.y);
  }

  // Vzdušná perspektiva: vzdálené hory modrají a mizí v oparu.
  // Dva druhy: modrý rozptyl (Rayleigh) roste se vzdáleností hodně, bílý opar (Mie)
  // hlavně u země a proti slunci. Hustota klesá s výškou.
  float density = exp(-max(P.y, 0.0) * 0.55);
  vec3 airColor = skyColor(normalize(vec3(rd.x, 0.05, rd.z)));
  vec3 extinction = vec3(0.020, 0.028, 0.042) * t * density;
  vec3 transmit = exp(-extinction);
  float mie = (1.0 - exp(-t * 0.012 * exp(-max(P.y, 0.0) * 1.5)));
  vec3 sunGlow = sunLight() * pow(max(dot(rd, uSun), 0.0), 6.0) * 0.08;
  c = c * transmit + airColor * (1.0 - transmit) * 0.95;
  c = mix(c, mix(horizon, vec3(0.8), 0.3) * 0.9 + sunGlow, mie * 0.35);
  // Mlha v údolí se pomalu převaluje.
  float low = exp(-max(P.y, 0.0) / 0.09);
  float drift = smoothstep(0.35, 0.75, texture(uNoise, P.xz * 0.12 + vec2(uTime * 0.0025, 0.0)).r);
  float mist = uMist * (1.0 - exp(-t * 0.35)) * low * drift;
  return mix(c, mistColor(), mist * 0.7);
}

float reflectionBlur = 0.0;

// Kluziště na ledu u kamery (střed x, z a poloosy v km); stejné místo jako v boats.js.
const vec4 RINK = vec4(0.0, 0.14, 0.042, 0.026);
// Kolik sněhu leží na ledu (víc, když zrovna sněží).
float uWinterSnow() { return clamp(0.5 + uSnowfall, 0.0, 1.0); }

// Barva scény z prvního průchodu, rozmazaná podle zčeření. Pixely vody mají alfu 0,
// dělením alfou se do rozmazání nepřimíchají (jinak by u břehu vznikl tmavý lem).
vec3 sceneColor(vec2 uv) {
  vec4 c = textureLod(uScene, uv, reflectionBlur);
  if (c.a < 0.02) c = textureLod(uScene, uv, reflectionBlur + 2.0);
  return c.rgb / max(c.a, 0.02);
}

// Barva krajiny nebo oblohy v bodě obrazovky (bez vody), pro odraz: z prvního průchodu.
vec3 sceneAt(vec2 uv) {
  // Odraz za bočním okrajem obrazu: vezme nejbližší sloupec, ne oblohu.
  uv.x = clamp(uv.x, 0.5 / uPixels.x, 1.0 - 0.5 / uPixels.x);
  if (uv.y > 1.0) {
    // Nad horním okrajem obrazu: levná obloha s mraky (plný výpočet by stál druhý průchod).
    vec3 rd = rayDirection(uv);
    vec3 zenith, horizon;
    palette(uSun.y, zenith, horizon);
    float c = cloudCoverage(rd.xz / max(rd.y, 0.02) * (CLOUD_BASE + 0.6));
    vec3 cloud = sunLight() * 0.35 + mix(horizon, zenith, 0.5) * 1.1;
    return mix(skyColor(rd) + moonDisk(rd), cloud, c * 0.8);
  }
  // Nad obzorem, ať odraz nikdy nevezme prázdný pixel jezera.
  uv.y = max(uv.y, uHorizon + 1.5 / uPixels.y);
  return sceneColor(uv);
}

// Odraz paprskem proti hloubce scény: blízké věci (balvany, břeh, stromy u vody) se
// zrcadlí správně přímo pod sebou. Co paprsek nenajde, je daleko (hory, obloha) a
// stačí pro to zrcadlení podle obzoru.
vec3 reflectionAt(vec3 P, vec3 r) {
  vec3 cam = vec3(0.0, CAMERA_HEIGHT, 0.0);
  // Jemnější kroky a náhodný posun začátku: pruhy se rozpadnou do šumu, rozmazání ho skryje.
  float s = 0.0015, prev = 0.0;
  for (int i = 0; i < 36 * uOne; i++) {
    vec3 v = P + r * s - cam;
    vec2 uv = screenOf(v);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float a = depthAt(uv);
    if (a > 0.0 && a < 900.0) {
      float surface = terrainDepth(a).x;
      float dq = length(v);
      // Kandidát: za povrchem nejvýš o délku kroku (jinak by kroky tenký balvan přeskočily).
      // Po zpřesnění se zásah ověří přísně (~3 m + 2 %), jinak by paprsek „trefil“
      // i předmět, za kterým jen prošel, a táhl by svislé pruhy.
      if (dq > surface && dq < surface * 1.02 + 0.003 + (s - prev)) {
        // Zpřesnit polohu zásahu půlením.
        float lo = prev, hi = s;
        for (int k = 0; k < 5 * uOne; k++) {
          float mid = 0.5 * (lo + hi);
          vec3 m = P + r * mid - cam;
          vec2 muv = screenOf(m);
          float ma = depthAt(muv);
          bool behind = ma > 0.0 && ma < 900.0 && length(m) > terrainDepth(ma).x;
          if (behind) hi = mid; else lo = mid;
        }
        vec3 hv = P + r * hi - cam;
        vec2 huv = screenOf(hv);
        float ha = depthAt(huv);
        float hs = terrainDepth(ha).x;
        if (!(ha > 0.0 && ha < 900.0) || length(hv) > hs * 1.02 + 0.003) { prev = s; s *= 1.22; continue; }
        vec3 hit = sceneColor(huv);
        // Kamera vidí povrch shora, hladina ale zrcadlí jeho boky a spodek ve stínu:
        // čím víc plocha míří vzhůru, tím tmavší je v odrazu (hlavně blízké kameny a břeh).
        vec3 hn = normalize(texture(uNormal, huv).xyz + vec3(0.0, 1e-4, 0.0));
        float underside = mix(0.22, 1.0, 1.0 - smoothstep(0.35, 0.95, hn.y));
        hit *= mix(underside, 1.0, smoothstep(0.3, 1.5, hi));
        // Vzdálené zásahy (hory) zrcadlí přesně i obyčejné zrcadlení podle obzoru a
        // paprsek by je mezi sousedními sloupci trefoval nahodile (schody). Plynule přejít.
        return mix(hit, sceneAt(screenOf(r)), smoothstep(0.25, 0.6, hi));
      }
    }
    prev = s;
    s *= 1.22;
  }
  return sceneAt(screenOf(r));
}

// Brázda za loďkou: dvě ramena pod Kelvinovým úhlem 19,5°, drobné vlnky asi 3 m.
float wakeHeight(vec2 xz) {
  float h = 0.0;
  for (int i = 0; i < ${MAX_BOATS}; i++) {
    vec4 b = uBoats[i];
    if (b.w <= 0.00002) continue;
    vec2 forward = vec2(sin(b.z), cos(b.z));
    vec2 d = xz - b.xy;
    float behind = -dot(d, forward);
    if (behind <= -0.002 || behind > 0.12) continue;
    float side = abs(d.x * forward.y - d.y * forward.x);
    float arm = side - max(behind, 0.0) * 0.354;
    float strength = b.w * 450.0 * exp(-max(behind, 0.0) / 0.035);
    // Nepravidelné vlnky, ne pruhy.
    float broken = 0.4 + 0.6 * texture(uNoise, xz * 40.0 + float(i) * 0.37).g;
    h += strength * broken * exp(-arm * arm / 0.000012) * sin(behind * 1500.0 + side * 700.0);
  }
  return h;
}

// Šum vlnek s hladkou interpolací (místo lineární): jeho náklon je spojitý, takže
// odraz u kamery, kde jeden bod textury pokryje několik pixelů, nemá hranaté bloky.
float rippleNoise(vec2 uv) {
  vec2 x = uv * 512.0 - 0.5;
  vec2 i = floor(x), f = x - i;
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 t = (i + 0.5) / 512.0, d = vec2(1.0 / 512.0, 0.0);
  float a = texture(uNoise, t).g, b = texture(uNoise, t + d.xy).g;
  float c = texture(uNoise, t + d.yx).g, e = texture(uNoise, t + d.xx).g;
  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);
}

vec3 waterColor(vec3 rd, float dist) {
  vec3 P = vec3(0.0, CAMERA_HEIGHT, 0.0) + rd * dist;
  // Vítr čeří hladinu ve dvou měřítkách; poryv přidá tmavé „kočičí tlapky“.
  vec2 w1 = P.xz * 5.0 + vec2(uTime * 0.010, uTime * 0.004);
  vec2 w2 = P.xz * 13.0 - vec2(uTime * 0.006, uTime * 0.013);
  float e = 1.5 / 512.0;
  float a0 = rippleNoise(w1), ax = rippleNoise(w1 + vec2(e, 0.0)), az = rippleNoise(w1 + vec2(0.0, e));
  float b0 = rippleNoise(w2), bx = rippleNoise(w2 + vec2(e, 0.0)), bz = rippleNoise(w2 + vec2(0.0, e));
  float paws = smoothstep(0.45, 0.75, texture(uNoise, P.xz * 0.9 - vec2(uTime * 0.03, 0.0)).r) * uGust;
  // Hladina není všude stejně zčeřená: klidné zrcadlové plochy (slicky) se pomalu
  // posouvají mezi zčeřenými pásy.
  float calm = smoothstep(0.42, 0.62, texture(uNoise, P.xz * 0.45 + vec2(uTime * 0.004, -uTime * 0.002)).r);
  float amount = (uRipple * mix(1.5, 0.15, calm) + paws * 2.5) * (1.0 - 0.95 * smoothstep(0.5, 0.85, uIce));  // led se nevlní
  vec2 slope = (vec2(ax - a0, az - a0) + 0.6 * vec2(bx - b0, bz - b0)) / e * 0.0011 * amount;
  // Brázdy loděk: blízko výrazné, dál splývají.
  if (dist < 2.5) {
    float k = 0.0004;
    float w0 = wakeHeight(P.xz);
    slope += vec2(wakeHeight(P.xz + vec2(k, 0.0)) - w0, wakeHeight(P.xz + vec2(0.0, k)) - w0) / k * 0.00009 / (1.0 + dist * 3.0);
  }
  // Zdálky jsou vlnky menší než pixel: jejich náklon se zprůměruje (slabší) a boční
  // složka skoro zmizí. Odraz se pak protahuje svisle, ne lámaný do schodů po řádcích.
  float far = smoothstep(0.2, 1.6, dist);
  slope *= mix(1.0, 0.55, far);
  slope.x *= mix(1.0, 0.2, far);
  // Kapky deště na hladině: kroužky, které se rozbíhají a slábnou (jen blízko).
  if (uRain > 0.0 && dist < 0.35 && uIce < 0.5) {
    vec2 rm = P.xz * 1000.0 / 0.7;           // buňky 0,7 m
    for (int k = 0; k < 2; k++) {
      vec2 mk = rm + float(k) * vec2(0.37, 0.61);
      vec2 id = floor(mk);
      vec2 f = mk - id - (0.25 + 0.5 * hash22(id + float(k) * 7.0));
      float age = fract(uTime * 0.8 + hash12(id + 3.1 + float(k)));
      float d = length(f);
      float ring = sin((d - age * 0.45) * 60.0) * exp(-pow((d - age * 0.45) * 9.0, 2.0)) * (1.0 - age);
      slope += f / max(d, 1e-3) * ring * 0.09 * uRain * (1.0 - smoothstep(0.1, 0.35, dist));
    }
  }
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  reflectionBlur = 0.8 + 1.6 * smoothstep(0.1, 1.5, dist) + 2.0 * paws;
  vec3 r = reflect(rd, n);
  r.y = max(r.y, 0.002);
  vec3 reflection = reflectionAt(P, r);
  float cosi = clamp(-dot(rd, n), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  // Průzračná voda: do mělčiny je vidět dno (světlé vápencové oblázky), hloubka se barví
  // do tyrkysu a dál do tmavě zelené. Světlo pod hladinou slábne s hloubkou.
  float depth = max(0.0, -texture(uLakeMap, (P.xz - uLakeRect.xy) / uLakeRect.zw).r) * 1000.0;  // m
  vec3 light = sunLight() * max(uSun.y, 0.0) * 0.6 + mix(horizon, zenith, 0.6) * 0.9 + moonLight();
  float pebbles = 0.7 + 0.3 * texture(uNoise, P.xz * 160.0).g;
  vec3 bottom = vec3(0.30, 0.29, 0.24) * pebbles * light;
  float path = depth * (1.0 + 1.0 / max(-rd.y, 0.05));   // dolů a zpátky k oku
  vec3 absorb = exp(-vec3(0.45, 0.09, 0.07) * path);
  vec3 turquoise = vec3(0.010, 0.060, 0.055) * light * 1.6;
  vec3 body = mix(turquoise, bottom, absorb);
  vec3 c = mix(body, reflection, clamp(fresnel * 1.15 + 0.08, 0.0, 1.0));
  // Hladina ve stínu hor není černá: odráží světlou oblohu nad údolím (jemná modř
  // navíc k odrazu tmavých svahů, víc u vzdálené hladiny, kde se odráží víc nebe).
  c += mix(horizon, zenith, 0.5) * 0.12 * fresnel * (0.5 + 0.5 * smoothstep(0.2, 2.0, dist));
  // Odlesky slunce na vlnkách (třpyt), jen když je slunce nad obzorem.
  float glint = pow(max(dot(r, uSun), 0.0), 900.0) * 60.0 + pow(max(dot(r, uSun), 0.0), 90.0) * 0.8;
  // Ve stínu hor se slunce na vodě netřpytí.
  vec2 suv = gl_FragCoord.xy / uPixels;
  float waterShade = mix(texture(uShadowFrom, suv).r, texture(uShadowTo, suv).r, uShadowMix);
  c += sunLight() * glint * smoothstep(0.0, 0.05, uSun.y) * (1.0 - 0.8 * uIce) * waterShade;
  // Zamrzlé jezero: nejdřív u břehů a daleko, v plné zimě celé. Tmavý průzračný led
  // (lesklý, zrcadlí hory) s poli a jazyky navátého sněhu, prasklinami a u kamery
  // uklizenou plochou, kde se bruslí, poškrábanou stopami bruslí.
  if (uIce > 0.0) {
    float patchy = texture(uNoise, P.xz * 0.35 + 3.0).r;
    float solid = smoothstep(0.7, 0.9, uIce);
    float frozen = smoothstep(0.0, 0.25, uIce * 1.3 - (1.0 - smoothstep(0.2, 3.0, dist)) * 0.4 * (1.0 - solid) + (patchy - 0.5) * 0.6);
    float cracks = smoothstep(0.03, 0.0, abs(texture(uNoise, P.xz * 2.0).g - 0.5));
    float drifts = smoothstep(0.42, 0.72, texture(uNoise, P.xz * vec2(1.2, 3.5) + 1.7).r);
    float fields = smoothstep(0.5, 0.75, texture(uNoise, P.xz * 0.25 + 5.3).r);
    // Na ledu většinou leží sníh; čistý tmavý led jen kde ho vítr odfoukal.
    float blown = smoothstep(0.55, 0.8, texture(uNoise, P.xz * vec2(0.6, 1.6) + 7.7).r);
    float snowy = clamp(0.35 + 0.5 * fields + 0.4 * drifts - 0.8 * blown, 0.0, 1.0) * (0.6 + 0.4 * uWinterSnow());
    // Kluziště: shrnutý sníh na okrajích (valy), uvnitř čistý led a stopy bruslí.
    vec2 rq = (P.xz - RINK.xy) / RINK.zw;
    float rinkR = length(rq) + 0.08 * (texture(uNoise, P.xz * 40.0).r - 0.5);
    float rink = (1.0 - smoothstep(0.85, 1.0, rinkR)) * solid;
    float bank = smoothstep(0.84, 0.97, rinkR) * solid;
    snowy = max(snowy * (1.0 - rink), bank);
    vec2 tq = P.xz * vec2(9.0, 14.0);
    float scratch = smoothstep(0.012, 0.0, abs(texture(uNoise, tq + texture(uNoise, tq * 0.3).rg * 0.4).g - 0.5));
    vec3 iceLight = sunLight() * max(uSun.y, 0.0) * 0.9 + mix(horizon, zenith, 0.6) * 0.8 + moonLight() * max(uMoon.y, 0.0);
    vec3 blackIce = mix(vec3(0.03, 0.045, 0.055), vec3(0.08, 0.11, 0.13), patchy) * iceLight;
    // Led odráží, ale mdle (poškrábaný, poprášený): odraz ztlumený a rozmazaný.
    blackIce = mix(blackIce, reflection * 0.8, 0.12 + 0.3 * fresnel);
    float dust = smoothstep(0.35, 0.8, texture(uNoise, P.xz * 22.0 + 3.1).r) * 0.35;
    blackIce = mix(blackIce, vec3(0.62, 0.66, 0.72) * iceLight, dust + 0.25 * scratch * rink);
    blackIce += iceLight * 0.12 * cracks;
    // Sníh na ledu: závěje a vlnky po větru (sastrugi), modravé ve stínu závějí,
    // místy tenčí (šedý led prosvítá), prošlapaná cestička od břehu ke kluzišti.
    float sast = texture(uNoise, P.xz * vec2(18.0, 45.0) + 0.9).r;
    float big = texture(uNoise, P.xz * 1.5 + 2.2).r;
    vec3 snowIce = mix(vec3(0.60, 0.66, 0.76), vec3(0.84, 0.85, 0.87), smoothstep(0.3, 0.75, sast * 0.6 + big * 0.4));
    snowIce = mix(snowIce, vec3(0.42, 0.47, 0.52), smoothstep(0.62, 0.8, 1.0 - big) * 0.5);
    float path = (1.0 - smoothstep(0.004, 0.009, abs(P.x - RINK.x - 0.012 * sin(P.z * 60.0)))) * step(P.z, RINK.y - RINK.w * 0.8) * solid;
    snowIce = mix(snowIce, vec3(0.55, 0.57, 0.6), path * 0.6);
    snowIce *= iceLight;
    vec3 ice = mix(blackIce, snowIce, snowy);
    c = mix(c, ice, frozen);
  }
  // Mlha nad vzdálenou hladinou.
  float mist = uMist * (1.0 - exp(-dist * 0.35)) * smoothstep(0.35, 0.75, texture(uNoise, P.xz * 0.12 + vec2(uTime * 0.0025, 0.0)).r);
  return mix(c, mistColor(), mist * 0.35);
}

// Sněžení v hloubce: sedm vrstev vloček ve skutečných vzdálenostech (4 m až 860 m).
// Každá vrstva padá (~1 m/s) a unáší ji vítr rychlostí podle vzdálenosti, takže blízké
// vločky prolétnou obrazem a vzdálené se skoro vznášejí (paralaxa). Vrstva za bližším
// terénem nebo hladinou se schová. Blízké vločky jsou velké a rozostřené jako mimo
// hloubku ostrosti objektivu, vzdálené drobné a husté. K tomu závoj: čím víc sněhu
// mezi okem a krajinou, tím bledší vzdálené hory.
vec3 snowScene(vec3 c, vec2 fragCoord, float sceneDist) {
  if (uSnowfall <= 0.0) return c;
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 tint = horizon * 1.3 + zenith + sunLight() * 0.08 + moonLight();
  float veil = 1.0 - exp(-min(sceneDist, 25.0) * 0.14 * uSnowfall);
  c = mix(c, tint * 0.5, veil * 0.85);
  float wind = 0.4 + 2.2 * uGust;                            // m/s do strany
  float total = 0.0;
  for (int i = 0; i < 7 * uOne; i++) {
    float layer = float(i);
    float dist = 0.004 * pow(2.45, layer);                    // km
    if (dist > sceneDist) break;                              // za terénem
    float scale = uPixels.y / (uSpan * dist * 1000.0);        // px na metr v té vzdálenosti
    float cell = max(0.35 * scale, 4.0);
    vec2 q = fragCoord / cell;
    q.y += uTime * 1.0 * scale / cell;
    q.x += uTime * wind * scale / cell + sin(uTime * 0.7 + q.y * 0.6 + layer * 1.7) * 0.12;
    vec2 id = floor(q);
    vec2 f = q - id;
    vec2 h = hash22(id + layer * 17.0);
    if (h.x > uSnowfall * 0.9) continue;
    vec2 center = 0.2 + 0.6 * h;
    float r = max(0.008 * scale * (0.6 + 0.8 * h.y), 0.6);    // px
    float coc = min(0.03 / dist, 14.0) * uPixels.y / 1440.0;  // rozostření blízkých
    float reach = r + coc;
    float d = length((f - center) * cell);
    float disk = 1.0 - smoothstep(reach * 0.35, reach, d);
    // Rozostřená vločka je větší, ale průsvitnější; subpixelová slabší podle plochy.
    float energy = clamp((r * r) / (reach * reach) * 1.6, 0.18, 1.0) * clamp(r * r, 0.25, 1.0);
    total += disk * energy * mix(1.0, 0.6, layer / 6.0);
  }
  return c + tint * total * 0.55;
}

// Déšť v hloubce: šest vrstev kapek (3 m až 250 m), každá padá ~7 m/s a vítr ji šikmo
// unáší; na snímku jsou kapky protažené do čárek (jako při času závěrky 1/30 s).
// Blízké čárky jsou delší, širší a rozostřené, vzdálené splývají v šedý závoj.
vec3 rainScene(vec3 c, vec2 fragCoord, float sceneDist) {
  if (uRain <= 0.0) return c;
  vec3 zenith, horizon;
  palette(uSun.y, zenith, horizon);
  vec3 tint = mix(horizon, zenith, 0.4) * 1.6 + sunLight() * 0.05 + moonLight();
  float veil = 1.0 - exp(-min(sceneDist, 25.0) * 0.07 * uRain);
  c = mix(c, tint * 0.45, veil * 0.8);
  float slant = 0.08 + 0.35 * uGust;                       // vodorovně / svisle
  float total = 0.0;
  for (int i = 0; i < 6 * uOne; i++) {
    float layer = float(i);
    float dist = 0.003 * pow(2.6, layer);                   // km
    if (dist > sceneDist) break;
    float scale = uPixels.y / (uSpan * dist * 1000.0);      // px na metr
    float cell = max(0.5 * scale, 4.0);
    float len = min(7.0 * 0.033 * scale, cell * 0.9);       // délka čárky v px
    vec2 q = fragCoord;
    q.x += q.y * slant;                                      // šikmo po větru
    q.y += uTime * 7.0 * scale;
    q.x += uTime * 7.0 * slant * scale;
    vec2 g = q / vec2(cell, cell);
    vec2 id = floor(g);
    vec2 h = hash22(id + layer * 23.0);
    if (h.x > uRain * 0.95) continue;
    vec2 f = (g - id) * cell - vec2(0.2 + 0.6 * h.x, 0.1 + 0.8 * h.y) * cell;
    float width = 0.5 + min(0.02 / dist, 3.0) * uPixels.y / 1440.0;   // blízké rozostřené
    float along = clamp(f.y, -len * 0.5, len * 0.5);
    float d = length(vec2(f.x, f.y - along));
    float streak = (1.0 - smoothstep(width * 0.3, width, d)) * (1.0 / (1.0 + width * 0.6));
    total += streak * mix(0.35, 0.18, layer / 5.0);
  }
  return c + tint * total * 0.5;
}

// Blesk: klikatý kanál s větví, zářící jádro a široká záře; schová se za horami.
vec3 lightningBolt(vec2 fragCoord, float sceneDist) {
  if (uBoltAlpha <= 0.0 || sceneDist < 3.0) return vec3(0.0);
  float scale = uPixels.y / 1440.0;
  // Jemné klikatění kanálu (menší než mezi body).
  vec2 p = fragCoord + vec2(gnoise(vec2(fragCoord.y * 0.06 / scale, uBolt[0].x * 91.0)) * 5.0 * scale, 0.0);
  float d = 1e9;
  for (int i = 0; i < 10; i++) {
    vec2 a = uBolt[i] * uPixels, b = uBolt[i + 1] * uPixels;
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    d = min(d, length(pa - ba * h));
  }
  // Větev z pátého bodu (uložená v posledním bodě pole).
  vec2 a = uBolt[4] * uPixels, b = uBolt[11] * uPixels;
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  // Větev tenčí a slabší, ke konci mizí.
  float branch = length(pa - ba * h) + (0.8 + 2.0 * h) * scale;
  d = min(d, branch);
  float core = exp(-pow(d / (1.3 * scale), 2.0));
  float glow = exp(-d / (28.0 * scale));
  return vec3(0.85, 0.88, 1.0) * (core * 6.0 + glow * 0.5) * uBoltAlpha;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

#ifdef PASS_CLOUDS
void main() {
  outColor = cloudMarch(rayDirection(gl_FragCoord.xy / uCloudRes));
}
#elif defined(PASS_SCENE)
void main() {
  vec2 uv = gl_FragCoord.xy / uPixels;
  vec3 rd = rayDirection(uv);
  // Hloubková paralaxa: blízký terén se posune víc, obloha vůbec.
  float depth = depthAt(uv);
  if (depth < 0.0 || (rd.y < 0.0 && depth > 900.0)) {
    outColor = vec4(0.0);      // jezero dokreslí druhý průchod
    return;
  }
  float near = depth < 900.0 ? clamp(0.35 / terrainDepth(depth).x, 0.0, 1.0) : 0.0;
  vec2 shifted = uv - uParallax * near;
  vec3 c;
  if (depth > 900.0) {
    c = skyWithClouds(rd, uv);
  } else {
    Material m = materialAt(shifted);
    // Paralaxa u břehu nesmí sáhnout do vody ani do oblohy (vznikl by pruh podél hladiny):
    // pak se vezme materiál z neposunutého místa.
    if (m.depth > 900.0 || m.depth < 0.0) {
      shifted = uv;
      m = materialAt(uv);
    }
    if (m.depth > 900.0 || m.depth < 0.0) {
      c = skyWithClouds(rd, uv);
    } else {
      vec2 td = terrainDepth(m.depth);
      c = litTerrain(shifted, m, rd, td.x);
      if (td.y > 0.0) c = mix(c, skyWithClouds(rd, uv), td.y);
    }
  }
  // Blesk patří do obrazu scény (ne až do posledního průchodu), aby se zrcadlil v jezeře.
  c += lightningBolt(gl_FragCoord.xy, depth > 900.0 ? 1000.0 : terrainDepth(depth).x);
  outColor = vec4(c, 1.0);
}
#else
void main() {
  vec2 uv = gl_FragCoord.xy / uPixels;
  vec4 scene = texelFetch(uScene, ivec2(gl_FragCoord.xy), 0);
  vec3 c = scene.rgb;
  vec3 rd = rayDirection(uv);
  float sceneDist = 1000.0;
  if (scene.a < 0.5) {
    sceneDist = rd.y < 0.0 ? CAMERA_HEIGHT / -rd.y : 10.0;
    c = waterColor(rd, sceneDist);
  } else {
    float a = depthAt(uv);
    if (a > 0.0 && a < 900.0) sceneDist = terrainDepth(a).x;
    // Balvan nad vodou (3D, v hloubkové mapě terénu je tam hladina): vzdálenost hladiny.
    else if (a < 0.0 && rd.y < 0.0) sceneDist = CAMERA_HEIGHT / -rd.y;
  }
  // Přízemní mlha nad jezerem: v noci tenká vrstva, která se pomalu převaluje nad
  // hladinou, za svítání zhoustne a s prvním sluncem stoupá a rozpouští se.
  float nightFog = 1.0 - smoothstep(-0.05, 0.02, uSun.y);
  float dawnFog = smoothstep(4.5, 6.0, uHour) * (1.0 - smoothstep(7.5, 9.5, uHour));
  float fogAmount = clamp(uMist, 0.0, 2.0) * max(nightFog * 0.7, dawnFog * 1.2);
  if (fogAmount > 0.01 && sceneDist > 0.15) {
    // Vrstva leží nízko nad hladinou (asi 15 m, za svítání stoupá), jen tam, kde bod
    // scény opravdu je nízko: ne přes stromy a skály na svazích.
    vec3 Pf = vec3(0.0, CAMERA_HEIGHT, 0.0) + rd * min(sceneDist, 12.0);
    float rise = dawnFog * smoothstep(-0.02, 0.15, uSun.y) * 0.02;
    float layer = exp(-max(Pf.y - rise, 0.0) / (0.012 + 0.015 * dawnFog));
    vec2 fq = Pf.xz * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
    float wisps = smoothstep(0.3, 0.8, texture(uNoise, fq).r * 0.65 + texture(uNoise, fq * 2.9 + 0.3).r * 0.35);
    vec3 zenith, horizon;
    palette(uSun.y, zenith, horizon);
    vec3 fogColor = horizon * 0.75 + mix(zenith, horizon, 0.5) * 0.25 + sunLight() * 0.08 + moonLight() * 0.6;
    float depthFade = 1.0 - exp(-max(sceneDist - 0.15, 0.0) * 0.9);
    c = mix(c, fogColor, clamp(layer * wisps * fogAmount * depthFade * 0.7, 0.0, 0.8));
  }
  c = snowScene(c, gl_FragCoord.xy, sceneDist);
  c = rainScene(c, gl_FragCoord.xy, sceneDist);
  // Záře kolem jasných míst (sníh na slunci, měsíc, lucerny, okna) jako v objektivu.
  vec3 glow = textureLod(uScene, uv, 3.0).rgb * 0.5 + textureLod(uScene, uv, 5.0).rgb * 0.3 + textureLod(uScene, uv, 7.0).rgb * 0.2;
  float brightness = dot(glow, vec3(0.3, 0.5, 0.2)) * uExposure;
  c += glow * smoothstep(0.9, 3.0, brightness) * 0.12;
  c = aces(c * uExposure);
  // Úprava barev jako u fotky z fotoaparátu: o něco méně sytosti (počítačová zeleň
  // a modř bývají křiklavé), teplejší světla a chladnější stíny, lehké ztmavení okrajů.
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, 0.86);
  c *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.95), smoothstep(0.05, 0.6, luma));
  vec2 centered = uv - 0.5;
  centered.x *= uPixels.x / uPixels.y * 0.55;
  c *= 1.0 - 0.28 * smoothstep(0.35, 1.1, length(centered));
  c = pow(c, vec3(uContrast / 2.2));
  // Jemné filmové zrno, v tmách o něco výraznější (jako na fotce v šeru).
  vec2 h = hash22(gl_FragCoord.xy + fract(uTime * 7.0) * 311.0);
  float grain = (h.x + h.y - 1.0) * mix(0.012, 0.004, dot(c, vec3(0.33)));
  c += grain + (hash22(gl_FragCoord.xy).x - 0.5) / 255.0;
  outColor = vec4(c, 1.0);
}
#endif
`;

// Textura s mipmapami (RGBA16F), do které jde kreslit.
function createMipTarget(gl, width, height) {
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    texture, framebuffer, width, height,
    dispose() {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
    },
  };
}

// Bez blesku: pole bodů kanálu samé nuly.
const ZERO_BOLT = new Float32Array(24);

export function createDisplay(gl) {
  const cloudPass = createProgram(gl, FULLSCREEN_VS, source('PASS_CLOUDS'), 'alpy-clouds');
  const scenePass = createProgram(gl, FULLSCREEN_VS, source('PASS_SCENE'), 'alpy-scene');
  let clouds = null;
  const finalPass = createProgram(gl, FULLSCREEN_VS, source('PASS_FINAL'), 'alpy-final');
  let scene = null;
  const vao = gl.createVertexArray();
  // Vzorkovač bez filtrování pro vzdálenost v alfě.
  const nearest = gl.createSampler();
  gl.samplerParameteri(nearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.samplerParameteri(nearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.samplerParameteri(nearest, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.samplerParameteri(nearest, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return {
    /** Obraz scény (alfa 0 = voda), pro odrazy kreslené po posledním průchodu. */
    get sceneTexture() { return scene ? scene.texture : null; },
    draw(o) {
      if (!scene || scene.width !== o.pixels[0] || scene.height !== o.pixels[1]) {
        scene?.dispose();
        scene = createMipTarget(gl, o.pixels[0], o.pixels[1]);
      }
      const cw = Math.max(1, Math.round(o.pixels[0] / 4)), ch = Math.max(1, Math.round(o.pixels[1] / 4));
      if (!clouds || clouds.width !== cw || clouds.height !== ch) {
        clouds?.dispose();
        clouds = createTarget(gl, cw, ch, { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR });
      }
      // Celoplošné průchody: bez blendingu, v bufferu je po minulém snímku smetí.
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, clouds.framebuffer);
      gl.viewport(0, 0, cw, ch);
      pass(cloudPass, o, null, null, [cw, ch]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.framebuffer);
      gl.viewport(0, 0, o.pixels[0], o.pixels[1]);
      pass(scenePass, o, null, clouds.texture);
      // Hvězdy a planety z katalogu do obrazu oblohy (schovají se za horami a mraky).
      if (o.stars && o.sky) {
        o.stars.draw({ ...o, depth: o.fullWeight >= 1 ? o.terrain.full.albedo : o.terrain.low.albedo, clouds: clouds.texture });
      }
      // Blízké stromy do obrazu scény (jen když je hotový terén v plném rozlišení,
      // podle jeho hloubky se schovávají za kopce).
      if (o.trees && o.fullWeight >= 1) {
        o.trees.draw({ ...o, depth: o.terrain.full.albedo, shadow: o.shadows.to });
      }
      // Padající listí a sníh z větví.
      if (o.particles) o.particles.draw(o);
      // Balvany v popředí (3D) do obrazu scény.
      if (o.boulders) o.boulders.drawScene({ ...o, shadow: o.shadows.to });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // Zmenšeniny pro rozmazaný odraz ve zčeřené hladině.
      gl.bindTexture(gl.TEXTURE_2D, scene.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.viewport(0, 0, o.pixels[0], o.pixels[1]);
      pass(finalPass, o, scene.texture, clouds.texture);
    },
  };

  function pass(program, o, sceneTexture, cloudTexture, cloudRes) {
      const u = program.u;
      gl.useProgram(program.program);
      const units = [
        [o.terrain.full.albedo, 'uAlbedo'], [o.terrain.full.normal, 'uNormal'], [o.terrain.full.extra, 'uExtra'],
        [o.terrain.low.albedo, 'uAlbedoLow'], [o.terrain.low.normal, 'uNormalLow'], [o.terrain.low.extra, 'uExtraLow'],
        [o.terrain.full.albedo, 'uDepth'], [o.terrain.low.albedo, 'uDepthLow'],
        [o.shadows.from, 'uShadowFrom'], [o.shadows.to, 'uShadowTo'], [o.terrain.noise.texture, 'uNoise'],
        [o.map.detail.texture, 'uLakeMap'],
        [sceneTexture, 'uScene'], [cloudTexture, 'uClouds'],
      ].filter(([texture, name]) => texture && u[name]);
      units.forEach(([texture, name], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        if (!u[name]) return;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(u[name], unit);
        gl.bindSampler(unit, name === 'uDepth' || name === 'uDepthLow' ? nearest : null);
      });
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(u.uShadowMix, o.shadows.mix);
      gl.uniform1f(u.uFull, o.fullWeight);
      gl.uniform2f(u.uPixels, o.pixels[0], o.pixels[1]);
      if (u.uCloudRes && cloudRes) gl.uniform2f(u.uCloudRes, cloudRes[0], cloudRes[1]);
      gl.uniform1f(u.uTime, o.time);
      gl.uniform2f(u.uParallax, o.parallax[0], o.parallax[1]);
      gl.uniform1f(u.uExposure, o.exposure);
      gl.uniform1f(u.uContrast, o.contrast);
      gl.uniform1f(u.uCover, o.cover);
      gl.uniform1f(u.uCirrus, o.cirrus ?? o.cover);
      gl.uniform2f(u.uCloudShift, o.cloudShift[0], o.cloudShift[1]);
      gl.uniform1f(u.uRipple, o.ripple);
      gl.uniform1f(u.uGust, o.gust);
      gl.uniform1f(u.uMist, o.mist);
      gl.uniform1f(u.uIce, o.ice);
      gl.uniform1f(u.uSnowfall, o.snowfall);
      gl.uniform1f(u.uRain, o.rain || 0);
      gl.uniform1f(u.uHour, o.hour ?? 12);
      gl.uniform1f(u.uMeteorSeed, o.meteor ? o.meteor.seed : 0);
      gl.uniform1f(u.uMeteorAge, o.meteor ? o.meteor.age : -1);
      gl.uniform1f(u.uRealStars, o.stars && o.stars.ready ? 1 : 0);
      if (u.uGalactic && o.sky) gl.uniformMatrix3fv(u.uGalactic, false, o.sky.worldToGalactic);
      gl.uniform1f(u.uOvercast, o.overcast || 0);
      gl.uniform1f(u.uFlash, o.flash || 0);
      if (u.uBolt) gl.uniform2fv(u.uBolt, o.bolt || ZERO_BOLT);
      gl.uniform1f(u.uBoltAlpha, o.boltAlpha || 0);
      if (u.uLakeRect) gl.uniform4f(u.uLakeRect, o.map.detail.left, o.map.detail.near, o.map.detail.width, o.map.detail.depth);
      if (u.uBoats) gl.uniform4fv(u.uBoats, o.wakes);
      gl.uniform3f(u.uSun, ...o.sun);
      gl.uniform3f(u.uMoon, ...o.moon);
      gl.uniform1f(u.uMoonPhase, o.moonPhase);
      const w = o.world;
      gl.uniform1f(u.uAspect, w.aspect);
      gl.uniform1f(u.uHorizon, w.horizon);
      gl.uniform1f(u.uSpan, w.span);
      gl.uniform1f(u.uMirror, w.mirror ? 1 : 0);
      gl.uniform2f(u.uSeed, ...w.seed);
      if (u.uOne) gl.uniform1i(u.uOne, 1);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      units.forEach((_, unit) => gl.bindSampler(unit, null));
  }
}
