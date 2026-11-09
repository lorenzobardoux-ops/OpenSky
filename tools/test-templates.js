#!/usr/bin/env node
// Event templates (lib/templates.js): add / change / remove, what placing one creates (OpenSky's own calendar or the
// chosen ones; time or all day; any number of times), and the colors kept apart from the calendars.
const fs = require("fs"), os = require("os"), path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensky-tpl-"));
process.env.OPENSKY_TEMPLATES = path.join(tmp, "templates.json");
process.env.OPENSKY_SETTINGS = path.join(tmp, "opensky.json");
fs.writeFileSync(process.env.OPENSKY_SETTINGS, JSON.stringify({ locale: { language: "en" } }));
const tpl = require(path.join(__dirname, "..", "lib", "templates.js"));
let pass = 0, fail = 0;
const ok = (n, c, i) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
const fails = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const CALS = ["Family", "Testers"];

ok("1 none at first", tpl.list().length === 0);
let list = tpl.save({ title: "  Football   practice ", description: "Pitch 2", start: "17:30", end: "19:00", color: "GREEN", calendars: [] }, CALS);
ok("2 a new template: cleaned up, with an id", list.length === 1 && list[0].title === "Football practice" && list[0].color === "green" && /^[0-9a-f-]{36}$/.test(list[0].id), list[0]);
list = tpl.save({ title: "Visit Grandma", allDay: true, start: "10:00", color: "#8B5CF6", calendars: ["Testers", "Gone", "Testers"] }, CALS);
ok("3 all day; a color code; calendars once each, unknown ones dropped", list[1].allDay && list[1].start === null && list[1].color === "#8b5cf6" && JSON.stringify(list[1].calendars) === '["Testers"]', list[1]);
ok("4 a name is needed; times must make sense",
  /name/.test(fails(() => tpl.save({ title: " " }, CALS))) && /start and end time/.test(fails(() => tpl.save({ title: "x", start: "25:00", end: "10:00" }, CALS))) && /after start/.test(fails(() => tpl.save({ title: "x", start: "10:00", end: "09:00" }, CALS))));
const id = list[0].id;
tpl.save({ id, title: "Football training", start: "17:00", end: "18:30", color: "teal", calendars: [] }, CALS);
ok("5 change one (same id)", tpl.list().find((t) => t.id === id).title === "Football training" && tpl.list().length === 2);

let p = tpl.plan(id, "2026-11-10");
const local = (iso) => { const d = new Date(iso); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
ok("6 placing it: one event in OpenSky's own calendar, that day at its times", p.creates.length === 1 && p.creates[0].calendar === "OpenSky" && local(p.creates[0].data.startDate) === "17:00" && local(p.creates[0].data.endDate) === "18:30" && new Date(p.creates[0].data.startDate).getDate() === 10, p.creates);
const p2 = tpl.plan(id, "2026-11-14");
ok("7 the same template again, another day (any number of times)", p2.creates[0].data.startDate !== p.creates[0].data.startDate && tpl.list().length === 2);
p = tpl.plan(list[1].id, "2026-11-14");
ok("8 all day, into the chosen calendar (no color in the event)", p.creates.length === 1 && p.creates[0].calendar === "Testers" && p.creates[0].data.allDay && p.creates[0].data.startDate === "2026-11-14" && p.creates[0].data.endDate === "2026-11-14" && !("color" in p.creates[0].data), p.creates[0]);
ok("9 a day must be a date; a removed template is explained", /date/.test(fails(() => tpl.plan(id, "tomorrow"))) && /gone/.test(fails(() => tpl.plan("nope", "2026-11-10"))));

tpl.placed("OpenSky", "Football training", "2026-11-10", "teal");
tpl.placed("Testers", "Visit Grandma", "2026-11-14", "#8b5cf6");
tpl.placed("OpenSky", "Football training", "2026-11-10", "green");   // the same event again → one entry, the new color
let colors = tpl.colors();
ok("10 colors by calendar + title + day, kept apart from the calendars", colors["OpenSky|football training|2026-11-10"] === "green" && colors["Testers|visit grandma|2026-11-14"] === "#8b5cf6" && Object.keys(colors).length === 2, colors);
tpl.placed("OpenSky", "Old", "2024-01-01", "red", Date.parse("2026-11-10"));
ok("11 colors of events long past are forgotten", !tpl.colors()["OpenSky|old|2024-01-01"]);
tpl.moved(["OpenSky"], "Football training", "2026-11-10", "Football match", "2026-11-12");
colors = tpl.colors();
ok("11b an edited event (new title / day) keeps its template color", colors["OpenSky|football match|2026-11-12"] === "green" && !colors["OpenSky|football training|2026-11-10"], colors);
tpl.placed("Lena", "Football match", "2026-11-12", "green");
tpl.forget(["OpenSky", "Lena"], "Football match", "2026-11-12");
ok("11c a deleted event's color is forgotten in every calendar it was in", !tpl.colors()["OpenSky|football match|2026-11-12"] && !tpl.colors()["Lena|football match|2026-11-12"] && tpl.colors()["Testers|visit grandma|2026-11-14"]);
tpl.placed("OpenSky", "Football training", "2026-11-10", "green");
tpl.remove(id);

ok("12 remove a template (its events stay — they're ordinary events)", tpl.list().length === 1 && tpl.colors()["OpenSky|football training|2026-11-10"] === "green");
fs.writeFileSync(process.env.OPENSKY_TEMPLATES, "{ broken");
const errs = []; const orig = console.error; console.error = (m) => errs.push(m);
ok("13 a damaged file: empty, a copy kept", tpl.list().length === 0 && fs.readdirSync(tmp).some((f) => f.includes(".damaged-")));
console.error = orig;

// the screen's side: the template color wins (OpenSkyEventColors in lib/client/opensky-client.js)
global.window = {}; global.document = { addEventListener() {}, querySelector() { return null; } };
require(path.join(__dirname, "..", "lib", "client", "opensky-client.js"));
const EC = window.OpenSkyEventColors;
EC.configure({ calendars: { OpenSky: "gray" } });
EC.setOverrides({ "OpenSky|football training|2026-11-10": "green", "Testers|visit grandma|2026-11-14": "#8b5cf6" });
const at = (y, m, d, h = 0) => String(new Date(y, m - 1, d, h).getTime());
ok("14 screen: an event from a template gets its color; the same title another day doesn't",
  EC.name({ calendarName: "OpenSky", title: "Football Training", startDate: at(2026, 11, 10, 17) }) === "green" &&
  EC.name({ calendarName: "Testers", title: "Visit Grandma", startDate: String(Date.UTC(2026, 10, 14)) }) === "#8b5cf6" &&
  EC.name({ calendarName: "OpenSky", title: "Football Training", startDate: at(2026, 11, 11, 17) }) === "gray");
// the same template event in two calendars (yours and your partner's) is one event on the screen
const evs = [
  { calendarName: "OpenSky", title: "Football Training", startDate: at(2026, 11, 10, 17), endDate: at(2026, 11, 10, 18) },
  { calendarName: "Lena", title: "Football training", startDate: at(2026, 11, 10, 17), endDate: at(2026, 11, 10, 18) },
  { calendarName: "Lena", title: "Football training", startDate: at(2026, 11, 11, 17), endDate: at(2026, 11, 11, 18) },   // another day: not a template event
  { calendarName: "Testers", title: "Visit Grandma", startDate: String(Date.UTC(2026, 10, 14)), endDate: String(Date.UTC(2026, 10, 15)), fullDayEvent: true },
  { calendarName: "Lena", title: "Visit Grandma", startDate: at(2026, 11, 14), endDate: at(2026, 11, 15), fullDayEvent: true }   // all day at local midnight
];
EC.setOverrides({ "OpenSky|football training|2026-11-10": "green", "Lena|football training|2026-11-10": "green", "Testers|visit grandma|2026-11-14": "#8b5cf6", "Lena|visit grandma|2026-11-14": "#8b5cf6" });
const mod = {}; global.Module = { register: (n, d) => Object.assign(mod, d) };
require(path.join(__dirname, "..", "modules", "MMM-OpenSky-Calendars", "MMM-OpenSky-Calendars.js"));
const shown = mod.oneOfEach(evs);
ok("15 a template event in several calendars is shown once (also all day, kept at UTC or local midnight); the calendars are known",
  shown.length === 3 && shown.filter((e) => /football/i.test(e.title)).length === 2 &&
  JSON.stringify(window.OpenSkyEventCopies[window.OpenSkyEventKey(evs[0])]) === '["OpenSky","Lena"]' &&
  JSON.stringify(window.OpenSkyEventCopies[window.OpenSkyEventKey(evs[3])]) === '["Testers","Lena"]', shown.map((e) => `${e.calendarName}:${e.title}`));
delete global.Module;
delete global.window; delete global.document;


fs.rmSync(tmp, { recursive: true, force: true });
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
