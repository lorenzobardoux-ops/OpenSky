/* OpenSky public holidays for any country (server side), from Nager.Date (https://date.nager.at — free, no key).
 * Used by MMM-OpenSky-Calendars for opensky.json → calendar.holidays = "<country code>" (e.g. "GB", "CA", "DE").
 * (The US uses Google's holiday calendar instead: it also has Halloween, Mother's Day and other observances.)
 *   events(country, region?) → MagicMirror calendar events (all-day) for this year and next.
 * region (e.g. "GB-SCT", "CA-ON", "DE-BY"): also that region's holidays; without it, the whole country's (global) ones.
 * The last good answer is kept on disk, so holidays still show without internet.
 */
const fs = require("fs");
const path = require("path");
const i18n = require("./client/i18n.js");
const { osT } = i18n;

const API = process.env.OPENSKY_HOLIDAYS_URL || "https://date.nager.at/api/v3";
const MM_ROOT = global.root_path || process.cwd();
const CACHE = process.env.OPENSKY_CALENDAR_CACHE || path.join(path.dirname(process.env.OPENSKY_SETTINGS || path.join(MM_ROOT, "config", "opensky.json")), "calendar-cache");

async function year(country, y) {
  const file = path.join(CACHE, `holidays-${country}-${y}.json`);
  try {
    const r = await fetch(`${API}/PublicHolidays/${y}/${country}`, { signal: AbortSignal.timeout(15000) });
    if (r.status === 404) throw Object.assign(new Error(osT("No holiday list for country \"{country}\" — use a two-letter code like GB, CA, DE", { country })), { final: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json();
    if (!Array.isArray(list)) throw new Error("unexpected reply");
    try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(list)); fs.renameSync(`${file}.tmp`, file); } catch (e) { /* cache is optional */ }
    return list;
  } catch (e) {
    if (e.final) throw e;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (x) { throw new Error(osT("Couldn't load {country} holidays ({error})", { country, error: e.message })); }
  }
}

async function events(country, region) {
  const cc = String(country || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw new Error(osT("calendar.holidays should be a two-letter country code (got \"{country}\")", { country }));

  const reg = region ? String(region).toUpperCase() : null;
  const now = new Date().getFullYear();
  const all = [...await year(cc, now), ...await year(cc, now + 1)];
  const seen = new Set();
  return all
    .filter((h) => h && /^\d{4}-\d\d-\d\d$/.test(h.date) && (h.global || (reg && Array.isArray(h.counties) && h.counties.includes(reg))))
    .filter((h) => { const k = `${h.date}|${h.name}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((h) => {
      const [y, m, d] = h.date.split("-").map(Number);
      const start = new Date(y, m - 1, d).getTime(), end = new Date(y, m - 1, d + 1).getTime();
      // the screen's language: English names, or the country's own (localName, e.g. German for DE) when it isn't English
      const local = i18n.language() !== "en";
      return { title: (local ? h.localName || h.name : h.name || h.localName), startDate: String(start), endDate: String(end), fullDayEvent: true, recurringEvent: false, class: "PUBLIC", firstYear: y, location: false, geo: false, description: false };
    });
}

module.exports = { events };
