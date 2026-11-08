// Unit test for config/config.js (the settings → MagicMirror config builder): every setting reaches the right
// module, private things never appear in the built config (which MagicMirror serves to the network).
const fs = require("fs"), os = require("os"), path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensky-cfg-"));
let passed = 0, failed = 0;
const ok = (n, c, i) => { c ? passed++ : failed++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };

function build(settings, secrets = {}) {
  fs.writeFileSync(path.join(tmp, "opensky.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(tmp, "secrets.json"), JSON.stringify(secrets));
  process.env.OPENSKY_SETTINGS = path.join(tmp, "opensky.json");
  process.env.OPENSKY_SECRETS = path.join(tmp, "secrets.json");
  global.root_path = path.join(__dirname, "..");
  const src = fs.readFileSync(path.join(__dirname, "..", "config", "config.js"), "utf8");
  const m = { exports: {} };
  new Function("module", "exports", "require", "__dirname", src)(m, m.exports, require, path.join(__dirname, "..", "config"));
  return m.exports;
}
const mod = (c, name) => c.modules.find((m) => m.module === name);
const errs = []; const origErr = console.error; console.error = (...a) => errs.push(a.join(" "));

const c = build({
  family: { name: "The Testers" }, locale: { timeFormat: 24, units: "metric", locale: "en-GB" },
  pages: ["home", "calendar", "lists", "smarthome", "money", "wordgame", "timer", "nope"],
  calendar: { holidays: "GB", holidaysRegion: "GB-SCT", sources: [
    { name: "Family", type: "local", color: "blue" }, { name: "Shared", type: "caldav", color: "green" },
    { name: "Work", type: "google", calendarId: "primary" }, { name: "Club", type: "google", calendarId: "c@group.calendar.google.com", readOnly: true },
    { name: "Mom" }, { name: "Holidays", url: "https://x/evil.ics" }], service: { port: 5099 } },
  lists: { lists: [{ name: "Shopping", provider: "homeassistant", entity: "todo.shopping" }, { name: "Chores" }], columns: 3 },
  pickup: { trashDay: "monday", url: "secret" },
  embeds: { smarthome: { title: "Smart Home", url: "http://ha.local:8123" }, money: { title: "Money" } },
  wordgame: { source: "opensky", extraWords: ["emoji"] }, look: { accent: "teal" }, keyboard: { enabled: false }, header: {}
}, { embeds: { money: { url: "http://192.168.1.9/private", pin: "246810" } }, calendar: { sources: { Mom: "https://calendar.google.com/private-xyz/basic.ics" } } });
console.error = origErr;

const cals = mod(c, "MMM-OpenSky-Calendars").config.sources;
const byName = (n) => cals.find((s) => s.name === n);
ok("1 CalDAV source → the local calendar service on the chosen port", byName("Shared").url === "http://127.0.0.1:5099/Shared/calendar.ics");
ok("2 Google sources keep their calendarId; read-only kept", byName("Work").calendarId === "primary" && byName("Club").readOnly === true);
ok("3 holidays by country (+ region), no US Google feed; a user calendar can't take the name Holidays",
  byName("Holidays").type === "holidays" && byName("Holidays").country === "GB" && byName("Holidays").region === "GB-SCT" && cals.filter((s) => s.name === "Holidays").length === 1);
ok("4 a private pickup link → a pickup-role source with no url in the config", byName("Pickup").role === "pickup" && byName("Pickup").url === null);
const ed = mod(c, "MMM-OpenSky-EventEditor").config;
ok("5 editable: on-screen, CalDAV, Google (not the read-only one, not links); service port", JSON.stringify(ed.editable.map((e) => e.name)) === '["Family","Shared","Work"]' && ed.servicePort === 5099, ed.editable);
ok("6 lists: Home Assistant entity passed on; Lists page columns", mod(c, "MMM-OpenSky-Lists").config.lists[0].entity === "todo.shopping" && mod(c, "MMM-OpenSky-ListsPage").config.columns === 3);
const pages = mod(c, "MMM-pages").config.modules;
ok("7 pages in order; embed pages told apart by class; an unknown page skipped with a message",
  JSON.stringify(pages) === JSON.stringify([["MMM-OpenSky-Home"], ["MMM-CalendarExt3", "MMM-OpenSky-Calendar"], ["MMM-OpenSky-ListsPage"], ["opensky-embed-smarthome"], ["opensky-embed-money"], ["MMM-OpenSky-WordGame"], ["MMM-OpenSky-Timer"]]) && errs.some((e) => /unknown page "nope"/.test(e)), pages);
const money = c.modules.find((m) => m.classes === "opensky-embed-money").config;
ok("8 a PIN page: locked, PIN length only, no address", money.locked === true && money.pinLength === 6 && money.url === null);
ok("9 word game source + extra words; accent; keyboard off; 24 h / metric", mod(c, "MMM-OpenSky-WordGame").config.source === "opensky" && mod(c, "MMM-OpenSky-WordGame").config.extraWords[0] === "emoji" &&
  mod(c, "MMM-OpenSky-Sidebar").config.accent === "teal" && !mod(c, "MMM-OpenSky-Keyboard") && c.timeFormat === 24 && c.units === "metric");
ok("10 header countdown follows the country's holiday calendar", mod(c, "MMM-OpenSky-Header").config.countdown.holidays === "calendar");
const served = JSON.stringify(c);
ok("11 nothing private in the built config (served to the network)", !/private|246810|192\.168\.1\.9|xyz/.test(served));
ok("12 security basics: localhost only, webview on", c.address === "localhost" && c.ipWhitelist.includes("127.0.0.1") && c.electronOptions.webPreferences.webviewTag === true);
const d = build({});
ok("13 empty settings → a working default (home + timer, no crash)", JSON.stringify(mod(d, "MMM-pages").config.modules) === JSON.stringify([["MMM-OpenSky-Home"], ["MMM-OpenSky-Timer"]]));

// Event names come from anyone who can send an invitation: the month view (CX3 draws them as HTML) gets plain text,
// and a tapped event reads back exactly as it was named
const cx3 = mod(c, "MMM-CalendarExt3").config;
const evil = { title: `Party <img src=x onerror="alert(1)"> & 'cake'`, location: "<b>Gym</b>", description: "<script>x()</script>", startDate: "1", endDate: "2" };
const shown = cx3.eventTransformer(evil);
ok("14 month view: event title, place and notes can't carry HTML", !/[<>"']/.test(shown.title + shown.location + shown.description) && evil.title.startsWith("Party <img"),
  shown.title);
let calModule = null;
global.Module = { register: (n, o) => { calModule = o; } };
require(path.join(__dirname, "..", "modules", "MMM-OpenSky-Calendar", "MMM-OpenSky-Calendar.js"));
const back = calModule.eventFromElement.call(calModule, { dataset: { ...shown, startDate: "1", endDate: "2", fullDayEvent: "false" } });
ok("15 tapping that event gives back the real title, place and notes (the editor finds it by title)",
  back.title === evil.title && back.location === evil.location && back.description === evil.description, back.title);

// Odd but plausible hand edits give a working screen, never a crash (MagicMirror can't start without its config)
const timerOf = (cfg) => mod(cfg, "MMM-OpenSky-Timer").config.quickAddButtons.map((b) => b.seconds / 60).join(",");
let odd = null;
try {
  odd = [build(null), build({ family: { name: 1990 }, pages: ["timer", "cams"], timer: { quickAddMinutes: 10 }, embeds: { cams: { title: 7, url: "http://x" } } }),
    build({ pages: ["timer"], timer: { quickAddMinutes: ["5", "soon", -3] } })];
} catch (e) { odd = e.message; }
ok("16 odd settings (a null file, a number for the family name / a page name, one timer minute) → no crash", Array.isArray(odd) &&
  mod(odd[1], "MMM-OpenSky-Header").config.title === "1990" && timerOf(odd[1]) === "10" && timerOf(odd[2]) === "5" &&
  mod(odd[1], "MMM-OpenSky-Embed").config.title === "7", typeof odd === "string" ? odd : undefined);

// accent color: a palette name or any color code; the config, the Pi (lib/accent.js) and the screen + phone
// (OpenSkyAccent in opensky-client.js) follow the same rule
const accentIn = (v) => mod(build({ look: { accent: v } }), "MMM-OpenSky-Sidebar").config.accent;
const cases = [["teal", "teal"], [" Teal ", "teal"], ["#3B82F6", "#3b82f6"], ["#abc", "#aabbcc"], ["3b82f6", null], ["#12345", null],
  ["red;background:url(x)", null], ["#3b82f6\"><b>", null], ["", null], [7, null]];
const got = cases.map(([v]) => accentIn(v));
ok("17 accent: names and color codes (#rrggbb, #rgb, any case) reach the screen; anything else → peach (null)",
  got.every((g, i) => g === cases[i][1]), got);
const libAccent = require(path.join(__dirname, "..", "lib", "accent.js"));
global.window = {}; global.document = { addEventListener() {} };   // (just enough of a page for opensky-client.js)
require(path.join(__dirname, "..", "lib", "client", "opensky-client.js"));
const SA = global.window.OpenSkyAccent;
const same = cases.filter(([v]) => typeof v === "string").every(([v, want]) => libAccent.normalize(v) === want && SA.normalize(v) === want);
ok("18 the Pi's rule (lib/accent.js) and the screen/phone's (OpenSkyAccent) agree; a typed code may leave out the #; light colors are flagged",
  same && SA.code("3B82F6") === "#3b82f6" && SA.code("teal") === null && SA.hex("teal") === "#11998e" && SA.hex("peach") === "#e8663f" &&
  SA.light("#fff4cc") && SA.light("#ffffff") && !SA.light("#e8663f") && !SA.light("#1d4ed8"));
delete global.window; delete global.document;

// German (locale.language "de"): page names, the header's fallback title and the timer buttons in German, a QWERTZ
// keyboard, dates as de-DE; English stays the default
const de = build({ locale: { language: "de", locale: "de-DE" }, pages: ["home", "calendar", "lists", "timer"] });
const sideDe = mod(de, "MMM-OpenSky-Sidebar").config.pages.map((p) => p.label);
ok("19 German: sidebar, header, timer buttons and keyboard in German; dates de-DE",
  JSON.stringify(sideDe) === JSON.stringify(["Start", "Kalender", "Listen", "Timer"]) && mod(de, "MMM-OpenSky-Header").config.title === "Unsere Familie" &&
  mod(de, "MMM-OpenSky-Timer").config.quickAddButtons[0].label === "+5 Min." && mod(de, "MMM-OpenSky-Keyboard").config.layout === "de" && de.locale === "de-DE" && de.language === "de",
  { sideDe, kb: mod(de, "MMM-OpenSky-Keyboard").config.layout });
const en = build({ pages: ["home", "calendar"], header: { f1: true } });
ok("21 header.f1 reaches the header (off unless true)", mod(en, "MMM-OpenSky-Header").config.f1 === true && mod(de, "MMM-OpenSky-Header").config.f1 === false);

ok("20 English stays the default", mod(en, "MMM-OpenSky-Sidebar").config.pages[0].label === "Home" && mod(en, "MMM-OpenSky-Keyboard").config.layout === "en" && en.language === "en");



fs.rmSync(tmp, { recursive: true, force: true });
console.log(`SUMMARY pass=${passed} fail=${failed}`);
