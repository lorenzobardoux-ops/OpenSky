#!/usr/bin/env node
// Formula 1 calendar (lib/f1.js) against a local stand-in for Jolpica: asked once, then kept until the next Monday;
// after the season's last race next season is asked too; without internet the last copy is used; German race names.
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensky-f1-"));
let pass = 0, fail = 0;
const ok = (n, c, i) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };

const SEASONS = {
  2026: [
    { round: "1", raceName: "Australian Grand Prix", date: "2026-03-08", time: "04:00:00Z", Circuit: { Location: { locality: "Melbourne" } } },
    { round: "2", raceName: "British Grand Prix", date: "2026-07-05", time: "14:00:00Z", Qualifying: { date: "2026-07-04", time: "14:00:00Z" }, Circuit: { Location: { locality: "Silverstone" } } },
    { round: "3", raceName: "United States Grand Prix", date: "2026-10-25", Circuit: { Location: { locality: "Austin" } } }
  ],
  2027: [{ round: "1", raceName: "Bahrain Grand Prix", date: "2027-03-07", time: "15:00:00Z", Circuit: { Location: { locality: "Sakhir" } } }]
};
let asked = [], down = false;
const server = http.createServer((req, res) => {
  const m = req.url.match(/\/(\d{4})\.json$/);
  asked.push(m && m[1]);
  if (down) { res.writeHead(503); return res.end(); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ MRData: { RaceTable: { season: m && m[1], Races: (m && SEASONS[m[1]]) || [] } } }));
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.OPENSKY_F1_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENSKY_CALENDAR_CACHE = tmp;
  process.env.OPENSKY_SETTINGS = path.join(tmp, "opensky.json");
  fs.writeFileSync(process.env.OPENSKY_SETTINGS, JSON.stringify({ locale: { language: "en" } }));
  const f1 = require(path.join(__dirname, "..", "lib", "f1.js"));
  const at = (s) => new Date(s);   // local time

  // Wednesday 2026-07-01
  let r = await f1.races(at("2026-07-01T10:00:00"));
  ok("1 the season's races, in order, with a start time (none given → noon UTC)", r.length === 3 && r[1].name === "British Grand Prix" && r[1].start === Date.parse("2026-07-05T14:00:00Z") && r[2].start === Date.parse("2026-10-25T12:00:00Z") && asked.join() === "2026", { asked, r: r.map((x) => x.name) });
  ok("1b qualifying's start too (none in the calendar → null)", r[1].quali === Date.parse("2026-07-04T14:00:00Z") && r[0].quali === null, r.map((x) => x.quali));

  asked = [];
  await f1.races(at("2026-07-04T10:00:00"));   // Saturday, same week
  ok("2 later the same week: from the copy on disk, nothing asked", asked.length === 0, asked);
  await f1.races(at("2026-07-06T08:00:00"));   // the next Monday
  ok("3 on Monday it's asked again", asked.join() === "2026", asked);
  asked = [];
  down = true;
  r = await f1.races(at("2026-07-13T08:00:00"));   // Monday, but no internet
  ok("4 no internet: the last copy", r.length === 3 && asked.length === 1, asked);
  down = false; asked = [];
  r = await f1.races(at("2026-11-02T08:00:00"));   // after the last race
  ok("5 after the season's last race next season is asked too", asked.join() === "2026,2027" && r.some((x) => x.season === 2027), asked);
  fs.writeFileSync(process.env.OPENSKY_SETTINGS, JSON.stringify({ locale: { language: "de" } }));
  ok("6 German names", f1.localName("British Grand Prix") === "Großer Preis von Großbritannien" && f1.localName("United States Grand Prix") === "Großer Preis der USA" && f1.localName("Bahrain Grand Prix in Malaysia") === "Großer Preis von Bahrain (in Malaysia)" && f1.localName("Sprint") === "Sprint");
  ok("7 Monday rule: a Sunday's copy is old on Monday", f1.lastMonday(at("2026-07-06T08:00:00")) === at("2026-07-06T00:00:00").getTime() && f1.lastMonday(at("2026-07-05T23:00:00")) === at("2026-06-29T00:00:00").getTime());
  down = true;
  fs.rmSync(path.join(tmp, "f1-schedule.json"));
  let err = null;
  try { await f1.races(at("2026-07-13T08:00:00")); } catch (e) { err = e.message; }
  ok("8 no internet and no copy: a plain error", /Formel-1-Kalender|Formula 1 calendar/.test(err || ""), err);
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`SUMMARY pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
