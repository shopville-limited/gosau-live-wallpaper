// Společné kousky GLSL: hash, gradientní šum, fbm a ridged šum.
// Pozor: žádná proměnná se nesmí jmenovat jako vestavěná funkce (floor, step, …).

export const NOISE = /* glsl */ `
uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v;
}

// Náhodné číslo 0..1 pro celočíselnou buňku.
float hash12(vec2 cell) {
  uvec2 h = pcg2d(uvec2(ivec2(floor(cell)) + 65536));
  return float(h.x) * (1.0 / 4294967295.0);
}

vec2 hash22(vec2 cell) {
  uvec2 h = pcg2d(uvec2(ivec2(floor(cell)) + 65536));
  return vec2(h) * (1.0 / 4294967295.0);
}

vec2 gradientAt(vec2 cell) {
  uvec2 h = pcg2d(uvec2(ivec2(cell) + 65536));
  float angle = float(h.x) * (6.28318530718 / 4294967295.0);
  return vec2(cos(angle), sin(angle));
}

// Gradientní šum, zhruba -1..1.
float gnoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = p - cell;
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(gradientAt(cell), f);
  float b = dot(gradientAt(cell + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(gradientAt(cell + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(gradientAt(cell + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y) * 1.414;
}

const mat2 OCTAVE_TURN = mat2(0.8, 0.6, -0.6, 0.8);

// Fraktální šum: součet oktáv, výsledek zhruba -1..1 (typicky -0,5..0,5).
float fbm(vec2 p, int octaves) {
  float sum = 0.0, amplitude = 0.5, norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    sum += amplitude * gnoise(p);
    norm += amplitude;
    p = OCTAVE_TURN * p * 2.03 + vec2(17.13, 3.71);
    amplitude *= 0.5;
  }
  return sum / norm;
}

// Ridged šum: ostré hřbety tam, kde šum prochází nulou. Výsledek 0..1.
float ridged(vec2 p, int octaves) {
  float sum = 0.0, amplitude = 0.5, norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    float r = 1.0 - abs(gnoise(p));
    sum += amplitude * r * r;
    norm += amplitude;
    p = OCTAVE_TURN * p * 2.07 + vec2(5.31, 11.9);
    amplitude *= 0.5;
  }
  return sum / norm;
}
`;
