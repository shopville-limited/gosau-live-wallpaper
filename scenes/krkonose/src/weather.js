// Skutečné počasí na hřebeni Krkonoš z Open-Meteo (zdarma, bez registrace a klíče). Posílají se
// jen souřadnice místa scény a údolí, nic o počítači ani uživateli.
// Inverze (moře mlhy pod hřebenem): jedním dotazem i počasí v údolí (Pec pod Sněžkou). Když je
// nahoře tepleji, než odpovídá výšce, a v údolí je mlha nebo nízká oblačnost, leží pod hřebenem
// souvislá vrstva oblačnosti. Stahuje se jednou za 15 minut;
// bez sítě (nebo po chybě) zůstane počasí vymyšlené podle ročního období.

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const FIELDS = [
  'temperature_2m', 'precipitation', 'rain', 'showers', 'snowfall', 'weather_code',
  'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
];
const EVERY = 15 * 60 * 1000;
const STALE = 3 * 60 * 60 * 1000;   // starší data než 3 hodiny se nepoužijí

/** override: pevné údaje (simulace v náhledu), pak se nic nestahuje. */
export function createWeather({ latitude, longitude, elevation = null, valley = null, enabled, override = null }) {
  let data = null;
  let fetchedAt = 0;
  let lastTry = -Infinity;
  let failures = 0;
  let pending = false;

  async function refresh() {
    pending = true;
    lastTry = Date.now();
    const places = [{ latitude, longitude, elevation }, ...(valley ? [valley] : [])];
    const list = (key, digits) => places.map((p) => p[key].toFixed(digits)).join(',');
    const url = `${ENDPOINT}?latitude=${list('latitude', 3)}&longitude=${list('longitude', 3)}` +
      (elevation !== null ? `&elevation=${list('elevation', 0)}` : '') +
      `&current=${FIELDS.join(',')}&wind_speed_unit=ms&timezone=GMT`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const [top, low] = Array.isArray(json) ? json.map((j) => j.current) : [json.current, null];
      const c = top;
      if (!c || typeof c.cloud_cover !== 'number') throw new Error('odpověď bez údajů');
      const pct = (v) => Math.min(1, Math.max(0, (Number(v) || 0) / 100));
      const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
      // Inverze: teplotní gradient mezi údolím a hřebenem (normálně −0,65 °C na 100 m).
      let inversion = 0;
      if (low && typeof low.temperature_2m === 'number' && valley) {
        const lapse = (c.temperature_2m - low.temperature_2m) / ((elevation - valley.elevation) / 100);
        const warmAloft = smooth((lapse + 0.35) / 0.5);
        const foggy = Math.max(low.weather_code === 45 || low.weather_code === 48 ? 1 : 0,
          smooth((pct(low.cloud_cover_low) - 0.5) / 0.4), 1 - smooth(((Number(low.visibility) || 24000) - 1000) / 4000));
        const clearTop = c.weather_code === 45 || c.weather_code === 48 || (Number(c.precipitation) || 0) > 0 ? 0 : 1;
        inversion = warmAloft * foggy * clearTop;
      }
      data = {
        time: c.time,
        temperature: Number(c.temperature_2m) || 0,             // °C
        precipitation: Math.max(0, Number(c.precipitation) || 0), // mm
        rain: Math.max(0, (Number(c.rain) || 0) + (Number(c.showers) || 0)),
        snowfall: Math.max(0, Number(c.snowfall) || 0),          // cm
        code: Number(c.weather_code) || 0,                        // WMO kód počasí
        cover: pct(c.cloud_cover),
        low: pct(c.cloud_cover_low),
        mid: pct(c.cloud_cover_mid),
        high: pct(c.cloud_cover_high),
        visibility: Number(c.visibility) || 24000,                // m
        wind: Math.max(0, Number(c.wind_speed_10m) || 0),         // m/s
        direction: Number(c.wind_direction_10m) || 0,             // odkud fouká, stupně
        gusts: Math.max(0, Number(c.wind_gusts_10m) || 0),        // m/s
        inversion,                                                // 0–1: moře mlhy pod hřebenem
      };
      fetchedAt = Date.now();
      failures = 0;
      console.warn(`Počasí na hřebeni (${data.time} UTC): oblačnost ${Math.round(data.cover * 100)} % ` +
        `(nízká ${Math.round(data.low * 100)}, střední ${Math.round(data.mid * 100)}, vysoká ${Math.round(data.high * 100)}), ` +
        `${data.temperature.toFixed(1)} °C, srážky ${data.precipitation} mm, sníh ${data.snowfall} cm, ` +
        `vítr ${data.wind.toFixed(1)} m/s z ${Math.round(data.direction)}°, kód ${data.code}, viditelnost ${Math.round(data.visibility / 1000)} km` +
        (low ? `; údolí ${Number(low.temperature_2m).toFixed(1)} °C, nízká oblačnost ${Math.round(pct(low.cloud_cover_low) * 100)} %, inverze ${inversion.toFixed(2)}` : ''));
    } catch (error) {
      failures++;
      if (failures <= 2) console.warn(`Počasí se nepodařilo stáhnout (${error.message}), zůstává vymyšlené.`);
    } finally {
      clearTimeout(timer);
      pending = false;
    }
  }

  return {
    /** Volá se průběžně; stahuje, jen když je čas (po chybě s rostoucím odstupem). */
    tick() {
      if (!enabled || pending || override) return;
      const wait = data && failures === 0 ? EVERY : Math.min(EVERY, 30000 * 2 ** Math.min(failures, 5));
      if (Date.now() - lastTry >= wait) refresh();
    },
    /** Poslední platné údaje, nebo null (vypnuto, bez sítě, staré). */
    get current() {
      if (override) return override;
      return data && Date.now() - fetchedAt < STALE ? data : null;
    },
    get simulated() { return Boolean(override); },
    /** Náhled: přepnout na simulované počasí (údaje jako z Open-Meteo), nebo null = skutečné. */
    setOverride(value) { override = value; },
  };
}
