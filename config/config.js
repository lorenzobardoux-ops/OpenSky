/* OpenSky — MagicMirror configuration builder.
 *
 * Don't edit this file to set up your family's screen: edit config/opensky.json (see opensky.example.json).
 * This file reads those settings and builds the module list MagicMirror needs.
 *
 * Secrets (API keys, tokens, PINs) are NEVER placed here: MagicMirror sends this whole config to every device on
 * the network (http://<pi>:8080/config). Modules read secrets from config/secrets.json on the Pi itself.
 */
const fs = require("fs");
const path = require("path");

// MagicMirror ≥ 2.38 evaluates this file from a string, so __dirname isn't the config folder: use its root path
const CONFIG_DIR = path.join(global.root_path || path.resolve(__dirname, ".."), "config");

function readSettings() {
  // OPENSKY_SETTINGS = another settings file (the test harness uses tools/fixtures/opensky.test.json)
  for (const file of [process.env.OPENSKY_SETTINGS, "opensky.json", "opensky.example.json"].filter(Boolean)) {
    const p = path.isAbsolute(file) ? file : path.join(CONFIG_DIR, file);
    if (!fs.existsSync(p)) continue;
    try {
      const settings = JSON.parse(fs.readFileSync(p, "utf8"));
      // (a file holding just null, a list or a number still gives a working screen)
      return { file, dir: path.dirname(p), settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {} };
    } catch (e) {
      console.error(`[OpenSky] ${file} is not valid JSON (${e.message}) — fix it or delete it to use the example settings`);
    }
  }
  return { file: null, settings: {} };
}

// look.accent: a palette color name, or a color code (#rgb / #rrggbb → "#rrggbb"); anything else → null (peach).
// The same rule as lib/accent.js (the Settings panel) and OpenSkyAccent (the screen and the phone page).
function accentOf(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (/^[a-z]+$/.test(s)) return s;
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  return m ? `#${m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1]}` : null;
}

const { file: settingsFile, dir: settingsDir, settings: s } = readSettings();
const locale = s.locale || {};
// texts this file puts on the screen, in opensky.json's language (lib/client/i18n.js; in MagicMirror it's
// modules/opensky-lib, in a checkout of the repo lib/)
const i18n = (() => {
  const root = global.root_path || path.resolve(__dirname, "..");
  for (const p of [path.join(root, "modules", "opensky-lib", "client", "i18n.js"), path.join(root, "lib", "client", "i18n.js")]) {
    try { return require(p); } catch (e) { /* the next place */ }
  }
  return { tFor: (l, text) => text };
})();
const osT = (text, vars) => i18n.tFor(locale.language, text, vars);

// Sidebar label + icon for every page OpenSky knows (order of `pages` in opensky.json = order in the sidebar)
const PAGE_INFO = {
  home: { label: osT("Home") },
  calendar: { label: osT("Calendar") },
  lists: { label: osT("Lists") },
  smarthome: { label: osT("Smart Home") },
  wordgame: { label: osT("Word Game") },
  timer: { label: osT("Timer") },
  music: { label: osT("Music") }
};

// Curbside pickup: trash day + an optional city preset (lib/pickup-presets/<name>.json) + the family's own overrides
const DAYS = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };
function pickupSchedule(p) {
  if (!p || !p.trashDay) return null;
  const trashDay = DAYS[String(p.trashDay).toLowerCase()] || Number(p.trashDay);
  if (!(trashDay >= 1 && trashDay <= 5)) { console.error(`[OpenSky] pickup.trashDay "${p.trashDay}" isn't a weekday — pickup icons off`); return null; }
  let preset = {};
  if (p.preset) {
    const f = path.join(global.root_path || path.resolve(__dirname, ".."), "modules", "opensky-lib", "pickup-presets", `${String(p.preset).replace(/[^a-z0-9-]/gi, "")}.json`);
    try { preset = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { console.error(`[OpenSky] pickup preset "${p.preset}" not found (${f})`); }
  }
  const { _about, ...presetData } = preset;
  const own = { ...p }; delete own.preset; delete own.trashDay;
  return { ...presetData, ...own, trashDay };
}

// A folder setting may be relative to the settings file (e.g. the test fixture's "photos")
const folderPath = (f) => (!f ? null : /^[~/]/.test(f) ? f : path.join(settingsDir || CONFIG_DIR, f));

// Calendar sources (a module with no screen of its own; any page can use the events)
const cal = s.calendar || {};
const calendarSources = (Array.isArray(cal.sources) ? cal.sources : []).filter((c) => c && c.name)
  .filter((c) => c.name !== "Pickup" && c.name !== "Holidays")   // (names OpenSky uses itself)
  .map((c) => ({ name: String(c.name), type: ["local", "caldav", "google"].includes(c.type) ? c.type : "link", url: c.url || null, color: c.color || null, fetchMinutes: c.fetchMinutes || 5,
    ...(c.type === "google" ? { calendarId: String(c.calendarId || "primary"), readOnly: !!c.readOnly } : {}) }));
// CalDAV calendars are read through OpenSky's calendar service on this Pi (the account stays in secrets.json)
const servicePort = (cal.service && cal.service.port) || 5747;
calendarSources.filter((c) => c.type === "caldav").forEach((c) => { c.url = `http://127.0.0.1:${servicePort}/${encodeURIComponent(c.name)}/calendar.ics`; });
if (cal.holidays === "US") calendarSources.push({ name: "Holidays", url: "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics", color: "tan", fetchMinutes: 720 });
else if (/^[A-Za-z]{2}$/.test(cal.holidays || "")) calendarSources.push({ name: "Holidays", type: "holidays", url: null, country: cal.holidays.toUpperCase(), region: cal.holidaysRegion || null, color: "tan", fetchMinutes: 720 });

// Calendars that can be changed from the screen: the on-device calendar(s) and CalDAV accounts
// Lists (groceries, to-dos…): on-device by default; Todoist with a token in secrets.json
const listSettings = s.lists || {};
const familyLists = (Array.isArray(listSettings.lists) ? listSettings.lists : []).filter((l) => l && l.name)
  .map((l) => ({ name: String(l.name), color: l.color || null, provider: ["todoist", "homeassistant"].includes(l.provider) ? l.provider : "local",
    ...(l.project ? { project: String(l.project) } : {}), ...(l.projectId ? { projectId: String(l.projectId) } : {}),
    ...(l.entity ? { entity: String(l.entity) } : {}) }));
// Trash / recycling days from a calendar link (many cities and ReCollect publish one): opensky.json → pickup.url,
// or a private one in secrets.json → calendar.sources.Pickup (with pickup.url: "secret")
const pk = s.pickup || {};
if (pk.url) calendarSources.push({ name: "Pickup", type: "link", role: "pickup", url: pk.url === "secret" ? null : pk.url, color: "gray", fetchMinutes: 720 });
const editableCalendars = calendarSources.filter((c) => c.type === "local" || c.type === "caldav" || (c.type === "google" && !c.readOnly))
  .map((c) => ({ name: c.name, type: c.type, ...(c.type === "google" ? { calendarId: c.calendarId } : {}) }));
const canAddEvents = editableCalendars.length > 0;

// Timer buttons: whole minutes; anything else (one number instead of a list, words) → the usual buttons
function quickMinutes(v) {
  const list = (Array.isArray(v) ? v : [v]).map(Number).filter((m) => Number.isInteger(m) && m > 0 && m <= 24 * 60);
  return list.length ? list : [5, 10, 15, 30, 45, 60];
}

// Each page = the modules that appear on it.
const PAGES = {
  calendar: () => [
    {
      module: "MMM-CalendarExt3",          // month view (community module, MIT, pinned + OpenSky patch)
      position: "fullscreen_above",
      config: {
        mode: "month", instanceId: "OPENSKY", animationSpeed: 0,
        firstDayOfWeek: locale.firstDayOfWeek === 1 ? 1 : 0,
        showHeader: true, customHeader: true, headerTitleOptions: { month: "long", year: "numeric" },
        maxEventLines: 3, showMore: true, fontSize: "20px", eventHeight: "38px",
        eventTimeOptions: { hour: "numeric", minute: "2-digit", hour12: locale.timeFormat !== 24 },
        cellDateOptions: { day: "numeric" }, displayEndTime: false, useSymbol: false, calendars: [],
        // CX3 puts an event's title, place and notes into the page as HTML. Anyone who can name an event (a Google
        // invitation, a shared calendar link) must not be able to run code on the screen, so they go in as plain
        // text (MMM-OpenSky-Calendar decodes them again). A copy: CX3 hands the same event objects in on every redraw.
        // Plus a color class from the shared palette (window.OpenSkyEventColors, loaded by MMM-OpenSky-Calendar).
        eventTransformer: (ev) => {
          const esc = (v) => (typeof v === "string" ? v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`) : v);
          const out = { ...ev, title: esc(ev.title), description: esc(ev.description), location: esc(ev.location) };
          if (typeof window !== "undefined" && window.OpenSkyEventColors) {
            const c = window.OpenSkyEventColors.name(ev);
            // a palette name → its class; a color code → evc-custom, colored through CX3's --calendarColor (= out.color)
            if (c.startsWith("#")) { out.class = "evc-custom"; out.color = c; } else out.class = `evc-${c}`;
          }
          return out;
        }
      }
    },
    {
      module: "MMM-OpenSky-Calendar",
      position: "fullscreen_above",
      config: { instanceId: "OPENSKY", canAddEvents, eventColors: (s.calendar && s.calendar.colors) || null }
    }
  ],
  home: () => [{
    module: "MMM-OpenSky-Home",
    position: "fullscreen_above",
    config: {
      listsPage: pages.indexOf("lists") >= 0 ? pages.indexOf("lists") : null,
      canAddEvents,
      maxEventsPerDay: 4,
      eventColors: (s.calendar && s.calendar.colors) || null,
      photos: {
        enabled: !(s.photos && s.photos.enabled === false),
        provider: (s.photos && s.photos.provider) || "folder",
        folder: folderPath(s.photos && s.photos.folder) || "~/Pictures",
        usb: !(s.photos && s.photos.usb === false),
        url: (s.photos && s.photos.url) || null,
        intervalSeconds: (s.photos && s.photos.intervalSeconds) || 30
      },
      pickup: pickupSchedule(s.pickup)
    }
  }],
  lists: () => [{
    module: "MMM-OpenSky-ListsPage",
    position: "fullscreen_above",
    config: { columns: (s.lists && s.lists.columns) || 4 }
  }],
  wordgame: () => [{
    module: "MMM-OpenSky-WordGame",
    position: "fullscreen_above",
    config: {
      source: (s.wordgame && s.wordgame.source === "opensky") ? "opensky" : "nyt",
      extraWords: (s.wordgame && Array.isArray(s.wordgame.extraWords)) ? s.wordgame.extraWords : []
    }
  }],
  timer: () => [{
    module: "MMM-OpenSky-Timer",
    position: "fullscreen_below",
    config: {
      quickAddButtons: quickMinutes(s.timer && s.timer.quickAddMinutes)
        .map((m) => ({ label: m % 60 === 0 && m >= 60 ? osT("+{n} hr", { n: m / 60 }) : osT("+{n} min", { n: m }), seconds: m * 60 })),
      alarm: { volume: (s.timer && s.timer.chimeVolume) ?? 0.6, repeatEverySeconds: 2.5, maxRingSeconds: 180 }
    }
  }],
  // the Music add-on (opensky addon music): the speaker name phones show — same rule as services/music/render.js
  music: () => [{
    module: "MMM-OpenSky-Music",
    position: "fullscreen_above",
    config: {
      name: String((s.music && s.music.name) || (s.family && s.family.name) || "OpenSky").replace(/[\u0000-\u001f"\\]/g, "").trim().slice(0, 40) || "OpenSky",
      spotify: !(s.music && s.music.spotify === false),
      airplay: !(s.music && s.music.airplay === false),
      // other speakers to control: Home Assistant media players (address + token stay in secrets.json)
      speakers: (s.music && Array.isArray(s.music.speakers) ? s.music.speakers : []).filter((e) => /^media_player\.[a-z0-9_]+$/.test(e)).slice(0, 8)
    }
  }]
};

// Embed pages (a web page on the screen: Home Assistant, a camera…): any key in opensky.json → embeds, listed in pages.
// A PIN (secrets.json → embeds.<key>.pin) locks the page; only whether one is set (and its length) is used here.
const embeds = (s.embeds && typeof s.embeds === "object") ? s.embeds : {};
function embedPin(key) {
  try {
    const sec = JSON.parse(fs.readFileSync(process.env.OPENSKY_SECRETS || path.join(settingsDir || CONFIG_DIR, "secrets.json"), "utf8"));
    const pin = sec && sec.embeds && sec.embeds[key] && sec.embeds[key].pin;
    return pin != null && /^\d{4,8}$/.test(String(pin)) ? String(pin).length : 0;
  } catch (e) { return 0; }
}
for (const [key, e] of Object.entries(embeds)) {
  if (PAGES[key] || !/^[a-z][a-z0-9-]{0,30}$/.test(key) || !e) continue;
  const pinLength = embedPin(key);
  PAGE_INFO[key] = { label: String(e.title || (PAGE_INFO[key] || {}).label || key), icon: e.icon || (key === "smarthome" ? "smarthome" : "embed") };
  PAGES[key] = () => [{
    module: "MMM-OpenSky-Embed",
    classes: `opensky-embed-${key}`,   // MMM-pages tells embed pages apart by this class
    position: "fullscreen_above",
    config: { key, title: PAGE_INFO[key].label, url: pinLength ? null : (e.url || null), locked: pinLength > 0, pinLength: pinLength || 4, zoom: Number(e.zoom) || 1 }
  }];
}

const pages = (Array.isArray(s.pages) && s.pages.length ? s.pages : ["home", "timer"]).filter((p) => {
  if (PAGES[p]) return true;
  console.error(`[OpenSky] unknown page "${p}" in ${settingsFile} — skipped`);
  return false;
});
const pageModules = pages.map((p) => PAGES[p]());
const familyName = String((s.family && s.family.name) || "").trim();

const loc = s.location || {};
const units = locale.units === "metric" ? "metric" : "imperial";
const header = s.header || {};


// Modules shown on every page
const fixed = [
  { module: "MMM-OpenSky-Settings", config: {} },
  { module: "MMM-OpenSky-Setup", config: {} },
  ...(s.keyboard && s.keyboard.enabled === false ? [] : [{ module: "MMM-OpenSky-Keyboard", config: { layout: (s.keyboard && s.keyboard.layout) || (/^de\b/i.test(locale.language || "") ? "de" : "en")
 } }]),

  ...(familyLists.length ? [{ module: "MMM-OpenSky-Lists", config: { lists: familyLists, refreshMinutes: listSettings.refreshMinutes || 2 } }] : []),
  ...(calendarSources.length ? [{ module: "MMM-OpenSky-EventEditor", config: { editable: editableCalendars, servicePort } }] : []),
  ...(calendarSources.length ? [{ module: "MMM-OpenSky-Calendars", config: { sources: calendarSources } }] : []),
  {
    module: "MMM-OpenSky-Header",
    position: "top_bar",
    config: {
      title: familyName || osT("Our Family"),

      time: { format12: locale.timeFormat !== 24, showSeconds: false, updateInterval: 1000 },
      weather: {
        provider: (s.weather && s.weather.provider) || "open-meteo",
        latitude: Number.isFinite(loc.latitude) ? loc.latitude : null,
        longitude: Number.isFinite(loc.longitude) ? loc.longitude : null,
        units, refreshMinutes: 15
      },
      countdown: {
        // US: built-in list (with Mother's Day, Halloween…); other countries: from the Holidays calendar
        holidays: header.holidays === "none" ? "none" : (!cal.holidays || cal.holidays === "US") ? "US" : (cal.holidays === "none" ? "none" : "calendar"),
        custom: Array.isArray(header.occasions) ? header.occasions : [],
        birthdays: header.birthdaysFromCalendar !== false
      },
      sports: header.sports && header.sports.team ? { league: header.sports.league || "nfl", team: header.sports.team } : null,
      f1: header.f1 === true,
      // F1 start times: German time (MEZ / MESZ) on a German screen, else the Pi's own; header.f1TimeZone overrides
      f1TimeZone: (typeof header.f1TimeZone === "string" && header.f1TimeZone) || (/^de\b/i.test(locale.language || "") ? "Europe/Berlin" : null)


    }
  },
  {
    module: "MMM-OpenSky-Sidebar",
    position: "fullscreen_above",
    config: {
      pages: pages.map((key, index) => ({ key, index, label: (PAGE_INFO[key] || {}).label || key, icon: (PAGE_INFO[key] || {}).icon || key })),
      familyInitial: (familyName.replace(/^the\s+/i, "")[0] || "H").toUpperCase(),
      idleReturnMinutes: (s.sidebar && Number.isFinite(s.sidebar.idleReturnMinutes)) ? s.sidebar.idleReturnMinutes : 5,
      screenServiceUrl: (s.screen && s.screen.serviceUrl) || null,
      showSettings: true,
      accent: accentOf(s.look && s.look.accent),
      scale: (s.look && s.look.scale) || "auto"
    }
  }
];

let config = {
  address: process.env.OPENSKY_ADDRESS || "localhost",
  port: Number(process.env.OPENSKY_PORT) || 8080,
  basePath: "/",
  ipWhitelist: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],
  language: locale.language || "en",
  locale: locale.locale || "en-US",
  timeFormat: locale.timeFormat === 24 ? 24 : 12,
  units,
  customCss: "css/opensky.css",
  // embed pages show web pages in a <webview> (it can show sites that refuse to be framed, like Home Assistant)
  electronOptions: { webPreferences: { webviewTag: true } },

  modules: [
    {
      module: "MMM-pages",
      config: {
        timings: { default: 0 },
        animationTime: 0,
        modules: pageModules.map((mods) => mods.map((m) => m.classes || m.module)),
        fixed: fixed.map((m) => m.module)
      }
    },
    ...fixed,
    ...pageModules.flat()
  ]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
