// Společný GLSL pro výpočet krajiny i pro každý snímek: kamera, šum, obloha a světla.
//
// Kamera stojí 12 m nad hladinou jezera a dívá se na sever (+z), východ je vpravo (+x).
// Obrazovka je mimoosá projekce: obzor leží v řádku uHorizon, takže odraz vzdálených hor
// v hladině je přesně zrcadlo obrazu podle obzoru.
// Pozor: žádná proměnná se nesmí jmenovat jako vestavěná funkce nebo klíčové slovo (floor, step, flat…).

export const CAMERA = /* glsl */ `
uniform float uAspect;    // šířka / výška
uniform float uHorizon;   // výška obzoru na obrazovce 0..1
uniform float uSpan;      // 2·tan(zorný úhel / 2)
uniform float uMirror;    // 1 = zrcadlit krajinu (ikony vpravo)
uniform vec2 uSeed;
uniform int uOne;         // vždy 1: meze smyček z uniformu, ať je překladač nerozbalí

// Kamera stojí na Studniční hoře (1 546 m n. m.) ve výšce očí; výšky jsou v km nad mořem.
const float CAMERA_HEIGHT = 1.548;
const float SKY_DEPTH = 1000.0;

vec3 rayDirection(vec2 uv) {
  float x = (uv.x - 0.5) * uAspect * uSpan;
  if (uMirror > 0.5) x = -x;
  return normalize(vec3(x, (uv.y - uHorizon) * uSpan, 1.0));
}

vec2 screenOf(vec3 d) {
  vec2 t = d.xy / max(d.z, 1e-4);
  if (uMirror > 0.5) t.x = -t.x;
  return vec2(t.x / (uAspect * uSpan) + 0.5, t.y / uSpan + uHorizon);
}

// Hodnotový šum s derivacemi (pro erozní terén).
vec3 noised(vec2 x) {
  vec2 p = floor(x);
  vec2 f = x - p;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(p);
  float b = hash12(p + vec2(1.0, 0.0));
  float c = hash12(p + vec2(0.0, 1.0));
  float d = hash12(p + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(-1.0 + 2.0 * (a + k1 * u.x + k2 * u.y + k4 * u.x * u.y),
              2.0 * du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}

// Hodnotový šum ve 3D (pro detail skalních stěn, které výšková mapa neumí).
float hash13(vec3 cell) {
  return hash12(cell.xy + cell.z * vec2(37.17, 17.31));
}
float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x);
  float b = mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x);
  float c = mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x);
  float d = mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z) * 2.0 - 1.0;
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4 * uOne; i++) {
    s += a * noise3(p);
    p = p * 2.03 + vec3(3.1, 7.7, 1.3);
    a *= 0.5;
  }
  return s;
}

// Periodický gradientní šum (dlaždice o straně period), pro opakovatelné textury.
float pnoise(vec2 p, float period) {
  vec2 cell = floor(p);
  vec2 f = p - cell;
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 c00 = mod(cell, period);
  vec2 c10 = mod(cell + vec2(1.0, 0.0), period);
  vec2 c01 = mod(cell + vec2(0.0, 1.0), period);
  vec2 c11 = mod(cell + vec2(1.0, 1.0), period);
  float a = dot(gradientAt(c00), f);
  float b = dot(gradientAt(c10), f - vec2(1.0, 0.0));
  float c = dot(gradientAt(c01), f - vec2(0.0, 1.0));
  float d = dot(gradientAt(c11), f - vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y) * 1.414;
}
`;

// Obloha, slunce, měsíc a hvězdy pro každý snímek. Všechno se odvozuje z výšky slunce,
// takže jeden model pokryje den, zlatou hodinku, soumrak i noc.
export const ATMOSPHERE = /* glsl */ `
uniform vec3 uSun;        // směr ke slunci
uniform vec3 uMoon;       // směr k měsíci
uniform float uMoonPhase; // 0 nov, 0,5 úplněk, 1 nov
uniform float uTime;
uniform float uOvercast;  // souvislá oblačnost 0..1 (šedé nebe, slabé slunce)
uniform float uFlash;     // záblesk blesku 0..1 (rozsvítí nebe i krajinu)

// Barvy oblohy v zenitu a u obzoru podle sinu výšky slunce (klíčové body palety).
void palette(float s, out vec3 zenith, out vec3 horizon) {
  vec3 zn = vec3(0.0030, 0.0050, 0.0140), hn = vec3(0.0080, 0.0100, 0.0220);   // noc
  vec3 zt = vec3(0.012, 0.024, 0.080),    ht = vec3(0.16, 0.085, 0.13);        // soumrak
  vec3 zs = vec3(0.040, 0.090, 0.260),    hs = vec3(0.85, 0.42, 0.30);         // západ
  vec3 zg = vec3(0.070, 0.170, 0.460),    hg = vec3(0.80, 0.55, 0.48);         // zlatá hodinka
  vec3 zd = vec3(0.080, 0.210, 0.560),    hd = vec3(0.50, 0.66, 0.86);         // den
  float a = smoothstep(-0.25, -0.10, s);
  float b = smoothstep(-0.10, 0.00, s);
  float c = smoothstep(0.00, 0.09, s);
  float d = smoothstep(0.09, 0.40, s);
  zenith = mix(mix(mix(mix(zn, zt, a), zs, b), zg, c), zd, d);
  horizon = mix(mix(mix(mix(hn, ht, a), hs, b), hg, c), hd, d);
  // Zataženo: nebe šedé a tmavší, bez barev západu (světlo rozptýlí vrstva mraků).
  if (uOvercast > 0.0) {
    float level = dot(mix(zenith, horizon, 0.5), vec3(0.3, 0.5, 0.2)) * (1.0 - 0.35 * uOvercast);
    vec3 grey = vec3(0.94, 0.97, 1.04) * level;
    zenith = mix(zenith, grey * 0.9, uOvercast * 0.88);
    horizon = mix(horizon, grey * 1.08, uOvercast * 0.88);
  }
  // Blesk: na okamžik bílomodré světlo odevšad.
  zenith += vec3(0.55, 0.6, 0.85) * uFlash;
  horizon += vec3(0.5, 0.55, 0.8) * uFlash;
}

vec3 skyColor(vec3 rd) {
  float e = max(rd.y, 0.0);
  float s = uSun.y;
  vec3 zenith, horizon;
  palette(s, zenith, horizon);
  vec3 c = mix(horizon, zenith, pow(smoothstep(0.0, 0.45, e), 0.55));
  float cosSun = dot(rd, uSun);
  vec2 dirFlat = normalize(rd.xz + 1e-5);
  vec2 sunFlat = normalize(uSun.xz + 1e-5);
  float sameSide = dot(dirFlat, sunFlat) * 0.5 + 0.5;
  // Kolem východu a západu: teplá záře na straně slunce, na druhé růžový Venušin pás
  // nad šedomodrým stínem Země.
  float low = exp(-pow((s - 0.02) / 0.09, 2.0));
  float fade = mix(0.35, 1.0, smoothstep(-0.08, 0.02, s));
  float belt = exp(-pow((e - 0.10) / 0.06, 2.0)) * (1.0 - sameSide) * low;
  float earthShadow = exp(-pow((e - 0.012) / 0.035, 2.0)) * (1.0 - sameSide) * low;
  c = mix(c, vec3(1.0, 0.52, 0.50) * fade, belt * 0.6);
  c = mix(c, vec3(0.30, 0.34, 0.50) * fade, earthShadow * 0.5);
  c += vec3(1.0, 0.45, 0.18) * pow(sameSide, 4.0) * exp(-e * 6.0) * low * 0.9 * fade;
  // Ve dne jas kolem slunce a slunce samo, když je vidět.
  float day = smoothstep(-0.02, 0.2, s);
  float clear = 1.0 - smoothstep(0.3, 0.85, uOvercast);
  c += vec3(1.0, 0.85, 0.6) * pow(max(cosSun, 0.0), 12.0) * 0.5 * day * (1.0 - 0.7 * uOvercast);
  c += vec3(1.0, 0.9, 0.7) * 40.0 * smoothstep(0.99985, 0.99992, cosSun) * smoothstep(-0.01, 0.01, s) * clear;
  // Záře kolem měsíce v noci.
  float night = 1.0 - smoothstep(-0.12, 0.02, s);
  float moonUp = smoothstep(-0.02, 0.05, uMoon.y);
  float phaseLight = 0.2 + 0.8 * sin(3.14159 * uMoonPhase);
  c += vec3(0.25, 0.32, 0.5) * pow(max(dot(rd, uMoon), 0.0), 40.0) * 0.06 * night * moonUp * phaseLight;
  return c;
}

// Hvězdy (jen v noci), mírně se třpytí.
vec3 stars(vec3 rd) {
  // Hvězdy až v nautickém soumraku (slunce 6–12° pod obzorem), ne hned po západu.
  float night = (1.0 - smoothstep(-0.2, -0.1, uSun.y)) * (1.0 - uOvercast);
  if (night <= 0.0 || rd.y <= 0.0) return vec3(0.0);
  vec3 q = rd * 320.0;
  vec3 cell = floor(q);
  vec3 f = q - cell;
  uvec2 h = pcg2d(uvec2(ivec2(cell.xy) + 65536) ^ uvec2(uint(int(cell.z) + 65536) * 2654435761u));
  float pick = float(h.x) / 4294967295.0;
  if (pick > 0.34) return vec3(0.0);
  float bright = pow(float(h.y) / 4294967295.0, 6.0);
  vec3 center = vec3(fract(pick * 7.13), fract(pick * 13.7), fract(pick * 23.1)) * 0.6 + 0.2;
  float d = length(f - center);
  float twinkle = 0.75 + 0.25 * sin(uTime * (2.0 + 5.0 * fract(pick * 41.0)) + pick * 60.0);
  float star = exp(-d * d * 60.0) * (0.02 + 1.4 * bright) * twinkle;
  vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.85, 0.7), fract(pick * 91.0));
  // Nízko u obzoru je hvězd méně (vzduch).
  return tint * star * night * smoothstep(0.0, 0.2, rd.y);
}

// Měsíc ve skutečné fázi: kotouč se stínováním koule a tmavšími moři.
vec3 moonDisk(vec3 rd) {
  // Kolem novoluní je Měsíc blízko Slunce a v noci pod obzorem: nekreslí se.
  float nearNew = min(uMoonPhase, 1.0 - uMoonPhase);
  float visible = (1.0 - smoothstep(-0.10, 0.05, uSun.y)) * smoothstep(-0.01, 0.02, uMoon.y) * (1.0 - smoothstep(0.4, 0.9, uOvercast))
                * smoothstep(0.06, 0.12, nearNew);
  if (visible <= 0.0) return vec3(0.0);
  float radius = 0.0095;
  if (dot(rd, uMoon) < 0.9997) return vec3(0.0);   // daleko od měsíce: nic nepočítat
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), uMoon));
  vec3 up = cross(uMoon, right);
  vec2 local = vec2(dot(rd, right), dot(rd, up)) / radius;
  float r2 = dot(local, local);
  if (dot(rd, uMoon) < 0.0 || r2 > 1.6) return vec3(0.0);
  float disk = smoothstep(1.0, 0.94, r2);
  vec3 n = vec3(local, sqrt(max(0.0, 1.0 - r2)));
  float angle = uMoonPhase * 6.28318;
  vec3 light = vec3(sin(angle), 0.0, -cos(angle));
  float lit = smoothstep(-0.05, 0.12, dot(n, light));
  float maria = 0.75 + 0.25 * gnoise(local * 2.3 + 4.0) + 0.1 * gnoise(local * 7.0);
  vec3 surface = vec3(0.95, 0.93, 0.86) * maria * (lit + 0.025) * 1.6;
  float halo = exp(-max(r2 - 1.0, 0.0) * 6.0) * (1.0 - disk) * 0.08;
  return (surface * disk + vec3(0.6, 0.7, 0.9) * halo * sin(3.14159 * uMoonPhase)) * visible;
}

// Barva a síla přímého slunce podle jeho výšky.
vec3 sunLight() {
  float s = uSun.y;
  float visible = smoothstep(-0.012, 0.025, s);
  vec3 color = mix(vec3(1.0, 0.33, 0.09), vec3(1.0, 0.46, 0.18), smoothstep(0.0, 0.07, s));
  color = mix(color, vec3(1.0, 0.93, 0.85), smoothstep(0.08, 0.45, s));
  float power = mix(2.6, 4.3, smoothstep(0.0, 0.07, s));
  power = mix(power, 3.3, smoothstep(0.1, 0.5, s));
  // Pod souvislou vrstvou mraků přímé slunce skoro zmizí (měkké, bezstínové světlo).
  return color * power * visible * (1.0 - 0.88 * uOvercast);
}

vec3 moonLight() {
  float night = 1.0 - smoothstep(-0.10, 0.0, uSun.y);
  float nearNew = min(uMoonPhase, 1.0 - uMoonPhase);
  return vec3(0.40, 0.50, 0.80) * 0.11 * night * smoothstep(0.06, 0.12, nearNew) * smoothstep(-0.02, 0.08, uMoon.y) * (0.2 + 0.8 * sin(3.14159 * uMoonPhase)) * (1.0 - 0.85 * uOvercast);
}
`;
