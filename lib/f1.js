/* OpenSky Formula 1 calendar (server side), from Jolpica (https://api.jolpi.ca — the free successor of the Ergast API;
 * no key). Used by MMM-OpenSky-Header for opensky.json → header.f1: true (the next race + a countdown).
 *   races(now?) → [{ round, name, start (ms), quali, sprintQuali, sprint (ms | null), place, season }] — this season's
 *   races (start = the race; the other sessions' starts, null when the weekend has none), and next season's once this
 *   one is over
 * Asked once a week: the answer is kept on disk and only asked again on Mondays (when the last copy is from before this
 * Monday) — so a race moved during the season shows up within the week. Without internet the last copy is used.
 * OPENSKY_F1_URL replaces the address (the tests use a local file).
 */
const fs = require("fs");
const path = require("path");
const i18n = require("./client/i18n.js");
const { osT } = i18n;

const API = process.env.OPENSKY_F1_URL || "https://api.jolpi.ca/ergast/f1";
const MM_ROOT = global.root_path || process.cwd();
const CACHE_DIR = () => process.env.OPENSKY_CALENDAR_CACHE || path.join(path.dirname(process.env.OPENSKY_SETTINGS || path.join(MM_ROOT, "config", "opensky.json")), "calendar-cache");

// this week's Monday, 00:00 (local time): a copy older than this is asked again
function lastMonday(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// a session's start {date, time}: ms; without a time yet, noon UTC on its day; no date → null
function when(s) {
  if (!s || !/^\d{4}-\d\d-\d\d$/.test(s.date || "")) return null;
  const t = Date.parse(`${s.date}T${/^\d\d:\d\d(:\d\d)?Z?$/.test(s.time || "") ? s.time.replace(/Z?$/, "Z") : "12:00:00Z"}`);
  return Number.isFinite(t) ? t : null;
}

async function season(year) {
  const r = await fetch(`${API}/${year}.json`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const races = (((await r.json()).MRData || {}).RaceTable || {}).Races;
  if (!Array.isArray(races)) throw new Error("unexpected reply");
  return races.filter((x) => x && /^\d{4}-\d\d-\d\d$/.test(x.date || "")).map((x) => ({
    round: Number(x.round) || null,
    raceName: String(x.raceName || ""),
    // a race without a time yet: noon UTC on its day
    start: when(x),
    quali: x.Qualifying ? when(x.Qualifying) : null,
    sprintQuali: x.SprintQualifying ? when(x.SprintQualifying) : null,
    sprint: x.Sprint ? when(x.Sprint) : null,
    place: ((x.Circuit || {}).Location || {}).locality || "",
    season: Number(year)
  })).filter((x) => Number.isFinite(x.start));
}

// "British Grand Prix" → "Großer Preis von Großbritannien" (German; the usual German names); other languages: as the API says
const DE = {
  Australian: "von Australien", Chinese: "von China", Japanese: "von Japan", Bahrain: "von Bahrain", "Saudi Arabian": "von Saudi-Arabien",
  Miami: "von Miami", "Emilia Romagna": "der Emilia-Romagna", Monaco: "von Monaco", Spanish: "von Spanien", Barcelona: "von Barcelona",
  Canadian: "von Kanada", Austrian: "von Österreich", British: "von Großbritannien", Belgian: "von Belgien", Hungarian: "von Ungarn",
  Dutch: "der Niederlande", Italian: "von Italien", Madrid: "von Madrid", Azerbaijan: "von Aserbaidschan", Singapore: "von Singapur",
  "United States": "der USA", "Mexico City": "von Mexiko", Mexican: "von Mexiko", Brazilian: "von Brasilien", "São Paulo": "von São Paulo",
  "Las Vegas": "von Las Vegas", Qatar: "von Katar", "Abu Dhabi": "von Abu Dhabi", French: "von Frankreich", German: "von Deutschland",
  Portuguese: "von Portugal", Russian: "von Russland", Turkish: "der Türkei", Malaysian: "von Malaysia", Korean: "von Korea", Indian: "von Indien"
};
function localName(raceName) {
  if (i18n.language() !== "de") return raceName;
  const m = raceName.match(/^(.+?) Grand Prix(?: in (.+))?$/);
  if (!m) return raceName;
  return `Großer Preis ${DE[m[1]] || "von " + m[1]}${m[2] ? ` (in ${m[2]})` : ""}`;
}

async function races(now = new Date()) {
  const year = now.getFullYear();
  const file = path.join(CACHE_DIR(), "f1-schedule.json");
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* none yet */ }
  // (v: what's kept; an older copy without the qualifying / sprint times is asked again)
  const fresh = cached && cached.v === 3 && cached.year === year && cached.fetchedAt >= lastMonday(now) && Array.isArray(cached.races);
  let list = fresh ? cached.races : null;
  if (!list) {
    try {
      list = await season(year);
      // after the last race of the year: next season too (empty until it's published)
      if (!list.some((r) => r.start > now.getTime() - 30 * 60e3)) list = list.concat(await season(year + 1).catch(() => []));
      try { fs.mkdirSync(CACHE_DIR(), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify({ v: 3, year, fetchedAt: now.getTime(), races: list })); fs.renameSync(`${file}.tmp`, file); } catch (e) { /* cache is optional */ }
    } catch (e) {
      if (cached && Array.isArray(cached.races)) list = cached.races;
      else throw new Error(osT("Couldn't load the Formula 1 calendar ({error})", { error: e.message }));
    }
  }
  return list.map((r) => ({ round: r.round, name: localName(r.raceName), start: r.start, quali: r.quali || null, sprintQuali: r.sprintQuali || null, sprint: r.sprint || null, place:
 r.place, season: r.season }));

}

module.exports = { races, lastMonday, localName };
