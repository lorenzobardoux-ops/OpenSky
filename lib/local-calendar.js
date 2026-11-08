/* OpenSky on-device calendar (server side) — a calendar that needs no account: events are kept on the Pi in
 * config/local-calendar.json. Used by MMM-OpenSky-Calendars (to show them) and MMM-OpenSky-EventEditor (to change them).
 * Both node helpers run in the same Node process and share this module, so a change is shown at once ("change" event).
 *
 * Stored event: { uid, calendar, title, start, end, allDay, description, location, updated }
 *   timed:   start/end = ISO datetimes;   all-day: start/end = "YYYY-MM-DD" with an INCLUSIVE end date
 * Writes are atomic (temp file + rename), so a power cut can't leave a half-written file.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { osT } = require("./client/i18n.js");   // texts in opensky.json's language

const MM_ROOT = global.root_path || process.cwd();
const FILE = process.env.OPENSKY_LOCAL_CALENDAR || path.join(MM_ROOT, "config", "local-calendar.json");
const bus = new EventEmitter();

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(data.events) ? data.events : [];
  } catch (e) {
    if (e.code !== "ENOENT") {
      // damaged file: keep a copy for recovery, start empty rather than crash
      try { fs.copyFileSync(FILE, `${FILE}.damaged-${Date.now()}`); } catch (x) { /* ignore */ }
      console.error(`[OpenSky] local-calendar.json unreadable (${e.message}); a copy was kept`);
    }
    return [];
  }
}

function writeAll(events) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, events }, null, 1));
  fs.renameSync(tmp, FILE);
  bus.emit("change");
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));

function validate(d) {
  const title = String(d.title || "").trim();
  if (!title) throw new Error(osT("Please add a title"));
  if (d.allDay) {
    const s = String(d.startDate || "").slice(0, 10), e = String(d.endDate || "").slice(0, 10);
    if (!isDate(s) || !isDate(e)) throw new Error(osT("Please pick a start and end date"));
    if (e < s) throw new Error(osT("End date must be on or after the start date"));
    return { title, allDay: true, start: s, end: e };
  }
  const s = new Date(d.startDate), e = new Date(d.endDate);
  if (isNaN(s) || isNaN(e)) throw new Error(osT("Please pick a start and end time"));
  if (e <= s) throw new Error(osT("End time must be after start time"));
  return { title, allDay: false, start: s.toISOString(), end: e.toISOString() };
}

// An event on screen is found by its calendar + original title + original start (what the month view knows)
function findIndex(events, calendar, ref) {
  const want = new Date(ref.originalStart).getTime();
  return events.findIndex((ev) => ev.calendar === calendar && ev.title === String(ref.originalTitle || "").trim() &&
    Math.abs(toMs(ev, "start") - want) < 60000);
}

function toMs(ev, which) {
  if (!ev.allDay) return new Date(ev[which]).getTime();
  const [y, m, d] = ev[which].split("-").map(Number);
  return which === "start" ? new Date(y, m - 1, d).getTime() : new Date(y, m - 1, d + 1).getTime();   // exclusive end
}

const api = {
  FILE,
  on: (ev, fn) => bus.on(ev, fn),

  create(calendar, data) {
    const v = validate(data);
    const events = readAll();
    events.push({ uid: crypto.randomUUID(), calendar, ...v, description: String(data.description || ""), location: String(data.location || ""), updated: new Date().toISOString() });
    writeAll(events);
  },

  update(calendar, ref, data) {
    const events = readAll();
    const i = findIndex(events, calendar, ref);
    if (i < 0) throw Object.assign(new Error(osT("Event not found (it may have just been changed)")), { status: 404 });
    events[i] = { ...events[i], ...validate(data), description: String(data.description ?? events[i].description ?? ""), updated: new Date().toISOString() };
    writeAll(events);
  },

  remove(calendar, ref) {
    const events = readAll();
    const i = findIndex(events, calendar, ref);
    if (i < 0) throw Object.assign(new Error(osT("Event not found (it may have just been changed)")), { status: 404 });
    events.splice(i, 1);
    writeAll(events);
  },

  /** Events of one calendar in MagicMirror's calendar format (what CALENDAR_EVENTS carries). */
  mmEvents(calendar) {
    return readAll().filter((ev) => ev.calendar === calendar).map((ev) => ({
      title: ev.title, startDate: String(toMs(ev, "start")), endDate: String(toMs(ev, "end")),
      fullDayEvent: !!ev.allDay, recurringEvent: false, class: "PUBLIC", firstYear: new Date(toMs(ev, "start")).getFullYear(),
      location: ev.location || false, geo: false, description: ev.description || false
    }));
  }
};

module.exports = api;
