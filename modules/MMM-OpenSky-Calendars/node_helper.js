/* MMM-OpenSky-Calendars node helper — fetches every calendar source on the Pi and hands the events to the page.
 * Uses MagicMirror's own calendar fetcher (recurring events, time zones, iCloud/Google/Outlook quirks).
 * Private calendar links (Google "secret address", iCloud sharing links, the local CalDAV feed) come from
 * secrets.json → calendar.sources.<name>, so they never appear in the config MagicMirror serves to the network.
 * Sources of type "local" are the on-device calendar (lib/local-calendar.js): no account, shown again on every change.
 *   OS_CAL_START {sources: [{name, type, url|null, fetchMinutes, country?, region?, calendarId?}], days} → OS_CAL_EVENTS {name, events} | OS_CAL_ERROR {name, message}
 */
const NodeHelper = require("node_helper");
const path = require("path");
const { osT } = require(path.join(__dirname, "..", "..", "lib", "client", "i18n.js"));   // texts in opensky.json's language
const CalendarFetcher = require(path.join(global.root_path, "defaultmodules", "calendar", "calendarfetcher.js"));
const { secret } = require(path.join(global.root_path, "modules", "opensky-lib", "secrets.js"));
const local = require(path.join(global.root_path, "modules", "opensky-lib", "local-calendar.js"));
const holidays = require(path.join(global.root_path, "modules", "opensky-lib", "holidays.js"));
const google = require(path.join(global.root_path, "modules", "opensky-lib", "google-calendar.js"));
const Log = require("logger");

// MagicMirror's fetcher writes each calendar's link into the log ("Broadcasting 12 events from <url>"). A private link
// IS the password to that calendar, so every log line and error message shows the calendar's name instead.
const privateLinks = new Map();   // link → 'calendar "Mom"'
const redact = (v) => {
  if (typeof v !== "string") return v;
  for (const [link, label] of privateLinks) v = v.split(link).join(label);
  return v;
};
for (const level of ["debug", "log", "info", "warn", "error"]) {
  const orig = Log[level];
  if (typeof orig === "function" && !orig.__openskyRedacted) {
    Log[level] = Object.assign((...args) => orig(...args.map(redact)), { __openskyRedacted: true });
  }
}

module.exports = NodeHelper.create({
  start() {
    this.fetchers = new Map();
    this.localNames = new Set();
    // the on-device calendar changed (event editor) → show it at once
    local.on("change", () => this.localNames.forEach((name) => this.sendLocal(name)));
  },

  // to the page (calendar status) and, once per new problem, to the log (`opensky logs`)
  error(name, message) {
    this.lastError = this.lastError || new Map();
    if (this.lastError.get(name) !== message) Log.error(`[OpenSky] calendar "${name}": ${message}`);
    this.lastError.set(name, message);
    this.sendSocketNotification("OS_CAL_ERROR", { name, message });
  },

  // Public holidays (lib/holidays.js): now, then twice a day; a page reload gets the last list at once
  startHolidays(src) {
    this.holidayLists = this.holidayLists || new Map();
    if (this.holidayLists.has(src.name)) return this.sendSocketNotification("OS_CAL_EVENTS", { name: src.name, events: this.holidayLists.get(src.name) });
    const load = () => holidays.events(src.country, src.region).then(
      (events) => { this.holidayLists.set(src.name, events); if (this.lastError) this.lastError.delete(src.name); this.sendSocketNotification("OS_CAL_EVENTS", { name: src.name, events }); },
      (e) => this.error(src.name, e.message));
    load();
    setInterval(load, 12 * 60 * 60 * 1000);
  },

  // Google calendars (lib/google-calendar.js): 30 days back to `days` ahead, every fetchMinutes
  startGoogle(src, days) {
    this.googleLoads = this.googleLoads || new Map();
    this.googleLists = this.googleLists || new Map();
    if (this.googleLoads.has(src.name)) {
      if (this.googleLists.has(src.name)) this.sendSocketNotification("OS_CAL_EVENTS", { name: src.name, events: this.googleLists.get(src.name) });
      return;
    }
    const load = () => {
      const now = Date.now();
      return google.mmEvents(src.calendarId || "primary", now - 30 * 86400e3, now + (days || 400) * 86400e3).then(
        (events) => { this.googleLists.set(src.name, events); if (this.lastError) this.lastError.delete(src.name); this.sendSocketNotification("OS_CAL_EVENTS", { name: src.name, events }); },
        (e) => this.error(src.name, e.message));
    };
    this.googleLoads.set(src.name, load);
    load();
    setInterval(load, Math.max(2, src.fetchMinutes || 5) * 60 * 1000);
  },

  sendLocal(name) { this.sendSocketNotification("OS_CAL_EVENTS", { name, events: local.mmEvents(name) }); },

  socketNotificationReceived(n, p) {
    if (n === "OS_CAL_REFETCH") {
      if (p && this.googleLoads && this.googleLoads.has(p.name)) return this.googleLoads.get(p.name)();
      const f = p && this.fetchers.get(p.name);
      if (f) f.fetchCalendar();
      return;
    }
    if (n !== "OS_CAL_START" || !p || !Array.isArray(p.sources)) return;
    for (const src of p.sources) {
      if (src.type === "local") { this.localNames.add(src.name); this.sendLocal(src.name); continue; }   // on this Pi
      if (src.type === "holidays") { this.startHolidays(src); continue; }                                // any country
      if (src.type === "google") { this.startGoogle(src, p.days); continue; }                             // Google Calendar API
      if (this.fetchers.has(src.name)) { this.fetchers.get(src.name).broadcastEvents(); continue; }   // page reload
      let url = src.url || secret(`calendar.sources.${src.name}`);
      if (!url) { this.error(src.name, osT("no link for \"{name}\" (set calendar.sources in opensky.json or secrets.json)", { name: src.name })); continue; }
      url = String(url).replace(/^webcal:\/\//i, "https://");
      if (!src.url) privateLinks.set(url, `calendar "${src.name}"`);   // from secrets.json (or the CalDAV feed)
      try { new URL(url); } catch (e) { this.error(src.name, osT("\"{name}\" link isn't a valid URL", { name: src.name }));
 continue; }
      const f = new CalendarFetcher(url, Math.max(1, src.fetchMinutes || 5) * 60 * 1000, [], 1000, p.days || 400, undefined, true, false);
      f.onReceive((fetcher) => {
        if (this.lastError) this.lastError.delete(src.name);
        this.sendSocketNotification("OS_CAL_EVENTS", { name: src.name, events: fetcher.events });
      });
      f.onError((fetcher, err) => this.error(src.name, redact((err && err.message) || String(err))));
      this.fetchers.set(src.name, f);
      f.fetchCalendar();
    }
  }
});
