// OpenSky off-screen test harness: launches the REAL MagicMirror/Electron app on a headless Wayland compositor
// and runs a scenario against it with Playwright. It never touches a physical screen.
//
//   1. start a headless compositor once:   tools/headless.sh start      (creates WAYLAND_DISPLAY=wayland-1)
//   2. run a scenario:                     node tools/harness.js tools/scenarios/<name>.js
//   3. stop the compositor:                tools/headless.sh stop
//
// Options (environment): OPENSKY_MM = MagicMirror folder (default ~/opensky-dev/MagicMirror),
// OPENSKY_PORT = server port (default 8083, so it never clashes with a MagicMirror already running on 8080/8081),
// OPENSKY_SETTINGS = settings file (default tools/fixtures/opensky.test.json — a fictional family in Boston),
// OPENSKY_SECRETS = secrets file (default tools/fixtures/secrets.test.json — fictional values only).
// A scenario exports `async (page, h, app) => {}`; screenshots go to tools/out/.
const { _electron } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const MM = process.env.OPENSKY_MM || path.join(os.homedir(), "opensky-dev", "MagicMirror");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
// every run starts with an empty on-device calendar
const LOCAL_CAL = path.join(OUT, "local-calendar.test.json");
fs.rmSync(LOCAL_CAL, { force: true });
// screen settings (brightness, schedule), fresh each run
const DEVICE = path.join(OUT, "device.test.json");
fs.rmSync(DEVICE, { force: true });
// phone setup: the first-run welcome card was already seen (the setup scenario shows it on purpose)
const WELCOME = path.join(OUT, "welcomed.test");
fs.writeFileSync(WELCOME, "test\n");
// word game board + stats, fresh each run
const WORDGAME = path.join(OUT, "wordgame.test.json");
fs.rmSync(WORDGAME, { force: true });
// on-device lists, seeded fresh each run (Groceries: Milk, Apples · Chores: empty)
const LOCAL_LISTS = path.join(OUT, "lists.test.json");
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOCAL_LISTS, JSON.stringify({ version: 1, lists: { Groceries: [{ id: "g1", text: "Milk" }, { id: "g2", text: "Apples" }] } }));
// tools/opensky-start sets LANGUAGE from opensky.json → locale.locale; the harness does the same
function settingsLanguage() {
  try {
    const f = process.env.OPENSKY_SETTINGS || path.join(__dirname, "fixtures", "opensky.test.json");
    const loc = (JSON.parse(fs.readFileSync(f, "utf8")).locale || {}).locale || "";
    return /^[a-z]{2}(-[A-Z]{2})?$/.test(loc) ? loc.replace("-", "_") : process.env.LANGUAGE || "";
  } catch (e) { return process.env.LANGUAGE || ""; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const scenario = require(path.resolve(process.argv[2]));
  // A scenario that changes the settings (phone setup) gets writable copies in tools/out — never the fixtures
  let SETTINGS_FILE = process.env.OPENSKY_SETTINGS || path.join(__dirname, "fixtures", "opensky.test.json");
  let SECRETS_FILE = process.env.OPENSKY_SECRETS || path.join(__dirname, "fixtures", "secrets.test.json");
  if (scenario.writableSettings || scenario.patchSettings || scenario.patchSecrets) {
    const st = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (scenario.patchSettings) scenario.patchSettings(st);
    if (st.photos && st.photos.folder && !path.isAbsolute(st.photos.folder) && !st.photos.folder.startsWith("~")) st.photos.folder = path.join(path.dirname(SETTINGS_FILE), st.photos.folder);
    fs.writeFileSync(path.join(OUT, "opensky.test.json"), JSON.stringify(st, null, 2));
    const sec = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
    if (scenario.patchSecrets) scenario.patchSecrets(sec);
    fs.writeFileSync(path.join(OUT, "secrets.test.json"), JSON.stringify(sec, null, 2));
    SETTINGS_FILE = path.join(OUT, "opensky.test.json");
    SECRETS_FILE = path.join(OUT, "secrets.test.json");
  }
  const app = await _electron.launch({
    executablePath: path.join(MM, "node_modules/electron/dist/electron"),
    // --mute-audio: tests ring the timer chime and Settings' Test sound — never out of this Pi's real speakers
    // (they ran in the family's home at night). The checks look at the page, not the sound.
    args: ["js/electron.js", "--ozone-platform=wayland", "--mute-audio"],
    cwd: MM,
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
      WAYLAND_DISPLAY: process.env.OPENSKY_TEST_DISPLAY || "wayland-1",   // the headless compositor, NOT a real screen
      DISPLAY: "",
      OPENSKY_PORT: process.env.OPENSKY_PORT || "8083",
      OPENSKY_SETTINGS: SETTINGS_FILE,
      OPENSKY_SECRETS: SECRETS_FILE,
      OPENSKY_LOCAL_CALENDAR: LOCAL_CAL,
      OPENSKY_LOCAL_LISTS: LOCAL_LISTS,
      OPENSKY_DEVICE_SETTINGS: DEVICE,
      OPENSKY_WORDGAME: WORDGAME,
      OPENSKY_SETUP_PORT: "8091",
      OPENSKY_WELCOME_FILE: WELCOME,
      OPENSKY_NYT_URL: "http://127.0.0.1:9/nyt", OPENSKY_F1_URL: "http://127.0.0.1:9/f1",   // never the real NYT from tests: unreachable → OpenSky's own word
      OPENSKY_MUSIC_INSTALLED: "",                 // the Music add-on: not installed, whatever this computer has (a scenario may say otherwise)
      OPENSKY_SPOTIFY_API: "http://127.0.0.1:9", OPENSKY_BUSCTL: "/bin/false",   // never this computer's real speakers
      // Settings: never touch the real screen, audio, updates or power — except in an approved real-screen session
      // (OPENSKY_HARNESS_REAL=1, run by hand on the real display, never from test-all.sh)
      ...(process.env.OPENSKY_HARNESS_REAL === "1" ? {} : { OPENSKY_DRY_RUN: "1" }),
      LANGUAGE: settingsLanguage(),     // as tools/opensky-start does: the screen's language from the settings
      ELECTRON_ENABLE_LOGGING: "1",
      ...(scenario.env || {})          // a scenario's own stand-ins (e.g. a fake Google)
    },
    timeout: 90000
  });
  // MagicMirror's own output (node helpers): kept to check that no private value from secrets.json is ever logged
  let serverLog = "";
  app.process().stdout.on("data", (d) => { serverLog += d; });
  app.process().stderr.on("data", (d) => { serverLog += d; });
  const page = await app.firstWindow({ timeout: 90000 });
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || "").split("\n").slice(1, 4).join("\n")}`));
  const h = {
    sleep,
    shot: (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) }),
    log: (...a) => console.log(...a),
    serverLog: () => serverLog,   // MagicMirror's own output (node helpers)
    box: async (sel) => (await page.$(sel))?.boundingBox(),
    tap: async (sel) => { const b = await h.box(sel); if (!b) throw new Error("no element " + sel); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
  };
  try {
    await sleep(8000);   // let modules load
    await scenario(page, h, app);
  } catch (e) {
    console.log("SCENARIO ERROR:", e.message.split("\n")[0]);
    await h.shot("error-state").catch(() => {});
  } finally {
    const noise = /gbm|dma_buf|Autofill|DevTools|Electron Security Warning/;
    console.log("---- page errors/warnings ----\n" + logs.filter((l) => !noise.test(l)).slice(0, 30).join("\n"));
    await app.close().catch(() => {});
    // every run: private values (secrets.json) must never reach the log
    const secretsFile = SECRETS_FILE;
    const values = [];
    const collect = (v, key) => { if (typeof v === "string" && v.length >= 8 && !key.startsWith("_")) values.push(v); else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => collect(x, k)); };
    try { collect(JSON.parse(fs.readFileSync(secretsFile, "utf8")), ""); } catch (e) { /* no secrets file */ }
    const leaked = values.filter((v) => serverLog.includes(v));
    if (leaked.length) console.log(`SCENARIO ERROR: ${leaked.length} private value(s) from secrets.json appeared in MagicMirror's log`);
  }
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
