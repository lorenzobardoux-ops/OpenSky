/* OpenSky event templates (server side) — standard events the family drags onto a day on the Home page.
 * Kept on the Pi in config/templates.json (OPENSKY_TEMPLATES); used by MMM-OpenSky-Templates' node helper.
 *
 *   { "templates": [ { id, title, description, allDay, start: "HH:MM", end: "HH:MM", color, calendars: [names] } ],
 *     "colors":    [ { calendar, title, day: "YYYY-MM-DD", color } ] }
 *
 * A template can be used any number of times. Placing one creates an ordinary event (by MMM-OpenSky-Templates through
 * the event editor) in the template's calendars, or — with none chosen — in OpenSky's own on-device calendar "OpenSky".
 * The color is never put into a calendar: "colors" remembers which events came from which template's color, and the
 * screen paints them with it (window.OpenSkyEventColors overrides).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { osT } = require("./client/i18n.js");

const MM_ROOT = global.root_path || process.cwd();
const FILE = () => process.env.OPENSKY_TEMPLATES || path.join(path.dirname(process.env.OPENSKY_SETTINGS || path.join(MM_ROOT, "config", "opensky.json")), "templates.json");
const OWN = "OpenSky";   // OpenSky's own calendar for template events that go to no other calendar
const KEEP_DAYS = 400;   // colors of events older than this are forgotten

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return { templates: Array.isArray(d.templates) ? d.templates : [], colors: Array.isArray(d.colors) ? d.colors : [] };
  } catch (e) {
    if (e.code !== "ENOENT") {
      try { fs.copyFileSync(FILE(), `${FILE()}.damaged-${Date.now()}`); } catch (x) { /* ignore */ }
      console.error(`[OpenSky] templates.json unreadable (${e.message}); a copy was kept`);
    }
    return { templates: [], colors: [] };
  }
}

function write(d) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(d, null, 1));
  fs.renameSync(`${FILE()}.tmp`, FILE());   // atomic: a power cut can't leave half a file
}

const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ""));
const isDay = (d) => /^\d{4}-\d\d-\d\d$/.test(String(d || ""));
// a palette name (letters) or a color code (#rgb / #rrggbb → #rrggbb)
function colorOf(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (/^[a-z]{3,12}$/.test(s)) return s;
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  return m ? `#${m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1]}` : null;
}

// a template as the screen sent it → a clean one (or a plain error)
function clean(t, calendars) {
  const title = String((t && t.title) || "").replace(/\s+/g, " ").trim();
  if (!title) throw new Error(osT("Please give it a name"));
  if (title.length > 80) throw new Error(osT("That's a bit long — keep it under 80 characters"));
  const allDay = !!t.allDay;
  const start = allDay ? null : String(t.start || "");
  const end = allDay ? null : String(t.end || "");
  if (!allDay && (!isTime(start) || !isTime(end))) throw new Error(osT("Please pick a start and end time"));
  if (!allDay && end <= start) throw new Error(osT("End time must be after start time"));
  const known = new Set((calendars || []).map(String));
  return {
    title, allDay, start, end,
    description: String(t.description || "").trim().slice(0, 2000),
    color: colorOf(t.color) || "blue",
    // (a calendar that's gone from the settings is dropped, so a template never points at nothing)
    calendars: [...new Set((Array.isArray(t.calendars) ? t.calendars : []).map(String))].filter((c) => !known.size || known.has(c))
  };
}

const key = (calendar, title, day) => `${calendar}|${String(title).toLowerCase().replace(/\s+/g, " ").trim()}|${day}`;

module.exports = {
  OWN,
  FILE,
  colorOf,

  list() { return read().templates; },

  /** Add a template (no id) or change one (id); calendars = the names it may go to (from the settings). */
  save(t, calendars) {
    const d = read();
    const c = clean(t, calendars);
    if (t && t.id) {
      const i = d.templates.findIndex((x) => x.id === t.id);
      if (i < 0) throw new Error(osT("That template is gone (it may have just been changed)"));
      d.templates[i] = { id: t.id, ...c };
    } else {
      if (d.templates.length >= 60) throw new Error(osT("That's a lot of templates — remove one first"));
      d.templates.push({ id: crypto.randomUUID(), ...c });
    }
    write(d);
    return d.templates;
  },

  remove(id) {
    const d = read();
    d.templates = d.templates.filter((x) => x.id !== id);
    write(d);
    return d.templates;
  },

  /** What placing template `id` on `day` creates: [{ calendar, data }] for the event editor (data as its form sends). */
  plan(id, day) {
    const t = read().templates.find((x) => x.id === id);
    if (!t) throw new Error(osT("That template is gone (it may have just been changed)"));
    if (!isDay(day)) throw new Error(osT("Please pick a start and end date"));
    let data;
    if (t.allDay) data = { title: t.title, allDay: true, startDate: day, endDate: day, description: t.description };
    else {
      const [y, m, dd] = day.split("-").map(Number);
      const at = (hhmm) => { const [h, mi] = hhmm.split(":").map(Number); return new Date(y, m - 1, dd, h, mi).toISOString(); };
      data = { title: t.title, allDay: false, startDate: at(t.start), endDate: at(t.end), description: t.description };
    }
    return { template: t, creates: (t.calendars.length ? t.calendars : [OWN]).map((calendar) => ({ calendar, data })) };
  },

  /** Remember the color of an event placed from a template (calendar + title + day). */
  placed(calendar, title, day, color, now = Date.now()) {
    if (!isDay(day)) return;
    const d = read();
    const k = key(calendar, title, day);
    const oldest = new Date(now - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
    d.colors = d.colors.filter((c) => key(c.calendar, c.title, c.day) !== k && c.day >= oldest);
    if (day >= oldest) d.colors.push({ calendar, title, day, color: colorOf(color) || "blue" });

    write(d);
  },

  /** An event from a template was changed on the screen (title and/or day): its color goes with it, in each calendar. */
  moved(calendars, fromTitle, fromDay, toTitle, toDay) {
    if (!isDay(fromDay) || !isDay(toDay)) return;
    const d = read();
    const cals = new Set((calendars || []).map(String));
    let changed = false;
    for (const c of d.colors) {
      if (cals.has(c.calendar) && key(c.calendar, c.title, c.day) === key(c.calendar, fromTitle, fromDay)) {
        c.title = String(toTitle); c.day = toDay; changed = true;
      }
    }
    if (changed) write(d);
  },

  /** An event from a template was deleted: forget its color (a later event with that name that day isn't painted). */
  forget(calendars, title, day) {
    const d = read();
    const ks = new Set((calendars || []).map((c) => key(String(c), title, day)));
    const kept = d.colors.filter((c) => !ks.has(key(c.calendar, c.title, c.day)));
    if (kept.length !== d.colors.length) { d.colors = kept; write(d); }
  },

  /** For the screen: { "<calendar>|<title>|<day>": color } */


  colors() {
    const out = {};
    for (const c of read().colors) out[key(c.calendar, c.title, c.day)] = c.color;
    return out;
  },
  key
};
