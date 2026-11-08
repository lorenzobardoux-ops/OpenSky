/* MMM-OpenSky-Settings node helper — the hardware side of the Settings page.
 * - Device settings (brightness, evening dim, sleep schedule) in config/device.json (next to opensky.json):
 *   changed from the screen, so they're kept apart from the hand-edited opensky.json.
 * - Brightness, whichever this Pi has (detected at start): the official Pi touch display's backlight (sysfs),
 *   a monitor over HDMI (DDC/CI with ddcutil), or "software" (the page dims itself).
 * - Volume: PipeWire (wpctl), when present.
 * - System: restart OpenSky (systemd user service), check for / install updates, restart / shut down the Pi.
 * OPENSKY_DRY_RUN=1 (the tests): nothing real is touched — no backlight, monitor, audio, updates or power.
 *
 *   OS_SET_INIT → OS_SET_STATE {settings, brightness: {method}, audio, canRestart}
 *   OS_SET_CHANGE {brightness?, eveningDim?, sleep?, volume?} → OS_SET_STATE
 *   OS_SET_ASLEEP true|false (the screen slept / woke) · OS_SET_STATUS → OS_SET_STATUS {…}
 *   OS_SET_SYSTEM {action: restart-app|update|reboot|shutdown} → OS_SET_SYSTEM_RESULT {action, ok, message}
 *   → OS_SET_SOFT_DIM level (software brightness for the page)
 *   OS_SET_PREFS → OS_SET_PREFS {prefs, pages, places, backup}   (the core opensky.json settings the phone also edits)
 *   OS_SET_PREFS_SAVE {patch} → OS_SET_PREFS {…, restartNeeded}   · OS_SET_BACKUP_RUN → OS_SET_BACKUP {status}
 * Also runs the nightly automatic backup (lib/backup.js; opensky.json → backup).
 */
const NodeHelper = require("node_helper");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { osT } = require(path.join(__dirname, "..", "..", "lib", "client", "i18n.js"));   // texts in opensky.json's language
const dns = require("dns").promises;
const backup = require(path.join(global.root_path || process.cwd(), "modules", "opensky-lib", "backup.js"));
const screen = require(path.join(global.root_path || process.cwd(), "modules", "opensky-lib", "screen.js"));
const accent = require(path.join(global.root_path || process.cwd(), "modules", "opensky-lib", "accent.js"));

const DRY = process.env.OPENSKY_DRY_RUN === "1";
// the icons a web page can have (same list as OpenSkyIcons.webPage in lib/client/opensky-client.js)
const WEB_ICONS = ["embed", "smarthome", "globe", "camera", "play", "music", "cart", "food", "school", "briefcase", "heart", "chart", "cloud", "car", "paw", "book"];
const REPO = path.resolve(__dirname, "..", "..");   // (MagicMirror links the module in; Node resolves the real folder)
const SETTINGS_DIR = path.dirname(process.env.OPENSKY_SETTINGS || path.join(global.root_path || process.cwd(), "config", "opensky.json"));
const FILE = process.env.OPENSKY_DEVICE_SETTINGS || path.join(SETTINGS_DIR, "device.json");
const DEFAULTS = {
  brightness: 100,
  eveningDim: { enabled: false, from: "19:00", level: 50 },
  sleep: { enabled: false, off: "22:00", on: "06:30" },
  screenOff: "auto"       // how Sleep turns the screen off (lib/screen.js)
};

const run = (cmd, args, timeout = 15000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") }));
});
const has = (cmd) => run("sh", ["-c", `command -v ${cmd}`], 3000).then((r) => r.ok);
const clamp = (v, lo, hi) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : hi; };
const isTime = (t) => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const inWindow = (mins, from, until) => (from > until ? mins >= from || mins < until : mins >= from && mins < until);

module.exports = NodeHelper.create({
  start() {
    this.settings = this.load();
    this.asleep = false;
    this.applied = null;
    this.queue = Promise.resolve();
    this.ready = this.detect();
    setInterval(() => this.applyBrightness(), 60 * 1000);   // evening dim starts / ends on time
    // the nightly automatic backup (checked every 10 minutes; a failed one is retried hourly)
    setInterval(() => this.backupIfDue(), 10 * 60 * 1000);
    setTimeout(() => this.backupIfDue(), 60 * 1000);
  },

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
      return { ...DEFAULTS, ...s, eveningDim: { ...DEFAULTS.eveningDim, ...(s.eveningDim || {}) }, sleep: { ...DEFAULTS.sleep, ...(s.sleep || {}) } };
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  },

  save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(this.settings, null, 2));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (e) { console.error(`[OpenSky] can't save device settings: ${e.message}`); }
  },

  /* ---------- what this Pi can do ---------- */
  async detect() {
    this.method = "software";
    this.audio = null;
    await screen.restoreAfterRestart();   // first: a screen left off by the last run is on again before we look at it
    this.screenAvail = await screen.detect();
    if (DRY) { this.method = process.env.OPENSKY_FAKE_BRIGHTNESS || "software"; this.audio = { name: "Test speaker", volume: 50 }; this.fake = { level: null, volume: 50 }; return; }
    // 1. a display with a backlight the system exposes (official Pi touch displays, some DSI panels)
    try {
      for (const dev of fs.readdirSync("/sys/class/backlight")) {
        const dir = path.join("/sys/class/backlight", dev);
        const max = Number(fs.readFileSync(path.join(dir, "max_brightness"), "utf8"));
        fs.accessSync(path.join(dir, "brightness"), fs.constants.W_OK);
        if (max > 0) { this.method = "backlight"; this.backlight = { file: path.join(dir, "brightness"), max }; break; }
      }
    } catch (e) { /* none, or not writable */ }
    // 2. a monitor that takes brightness over HDMI (DDC/CI)
    if (this.method === "software" && await has("ddcutil")) {
      const r = await run("ddcutil", ["--brief", "getvcp", "10"], 20000);
      if (r.ok && /VCP 10 C \d+/.test(r.out)) this.method = "ddc";
    }
    // volume
    if (await has("wpctl")) {
      const v = await run("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"], 5000);
      const i = await run("wpctl", ["inspect", "@DEFAULT_AUDIO_SINK@"], 5000);
      const m = v.out.match(/Volume:\s*([\d.]+)/);
      const name = (i.out.match(/node\.description = "([^"]+)"/) || [])[1] || "";
      if (m && !/dummy/i.test(name)) this.audio = { name, volume: Math.round(Number(m[1]) * 100) };
    }
    console.log(`[OpenSky] settings: brightness by ${this.method}${this.audio ? `, sound: ${this.audio.name}` : ", no sound output"}`);
  },

  async socketNotificationReceived(n, p) {
    await this.ready;
    if (n === "OS_SET_INIT") {
      this.applied = null;
      this.applyBrightness();
      this.sendState();
    } else if (n === "OS_SET_CHANGE") {
      await this.change(p || {});
    } else if (n === "OS_SET_ASLEEP") {
      this.asleep = !!p;
      this.applyBrightness();
      if (p) this.screenOff(); else this.screenOn();
    } else if (n === "OS_SET_FAKE_INPUT" && DRY) {   // tests only: stands in for a touch seen by the input watcher
      if (screen.fakeInput) screen.fakeInput();
    } else if (n === "OS_SET_SCREEN_TEST") {
      // turn the screen off the chosen way for 10 seconds (a touch wakes it sooner)
      this.testMethod = screen.resolve((p && p.method) || this.settings.screenOff, this.screenAvail);
      this.sendSocketNotification("OS_SET_SLEEP_NOW");
      clearTimeout(this.testTimer);
      this.testTimer = setTimeout(() => { if (this.testMethod) this.wake(); }, 10000);
    } else if (n === "OS_SET_STATUS") {
      this.sendSocketNotification("OS_SET_STATUS", await this.status());
    } else if (n === "OS_SET_PREFS") {
      this.sendPrefs();
    } else if (n === "OS_SET_PREFS_SAVE") {
      this.savePrefs((p && p.patch) || {});
    } else if (n === "OS_SET_BACKUP_RUN") {
      const st = backup.run();
      console.log(`[OpenSky] backup now: ${st.ok ? st.file : st.error}`);
      this.sendSocketNotification("OS_SET_BACKUP", { status: st });
    } else if (n === "OS_SET_SYSTEM") {
      const r = await this.system(p && p.action);
      this.sendSocketNotification("OS_SET_SYSTEM_RESULT", { action: p && p.action, ...r });
    }
  },

  sendState() {
    this.sendSocketNotification("OS_SET_STATE", {
      settings: this.settings, brightness: { method: this.method }, audio: this.audio,
      canRestart: DRY || !!process.env.INVOCATION_ID,   // running as the systemd service
      screen: { method: this.settings.screenOff, resolved: screen.resolve(this.settings.screenOff, this.screenAvail || {}), labels: screen.LABELS,
        available: Object.fromEntries(screen.METHODS.map((m) => [m, m === "auto" || m === "soft" || !!(this.screenAvail || {})[m]])) }
    });
  },

  async change(c) {
    const s = this.settings;
    if ("brightness" in c) s.brightness = clamp(c.brightness, 10, 100);
    if (c.eveningDim) {
      const e = c.eveningDim;
      s.eveningDim = { enabled: "enabled" in e ? !!e.enabled : s.eveningDim.enabled, from: isTime(e.from) ? e.from : s.eveningDim.from, level: "level" in e ? clamp(e.level, 10, 100) : s.eveningDim.level };
    }
    if (c.sleep) {
      const z = c.sleep;
      s.sleep = { enabled: "enabled" in z ? !!z.enabled : s.sleep.enabled, off: isTime(z.off) ? z.off : s.sleep.off, on: isTime(z.on) ? z.on : s.sleep.on };
    }
    if (screen.METHODS.includes(c.screenOff)) s.screenOff = c.screenOff;
    if ("volume" in c && this.audio) {
      this.audio.volume = clamp(c.volume, 0, 100);
      if (DRY) this.fake.volume = this.audio.volume;
      else await run("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", (this.audio.volume / 100).toFixed(2)], 5000);
    }
    this.save();
    if ("brightness" in c || c.eveningDim) this.applyBrightness();
    this.sendState();
  },

  /* ---------- brightness ---------- */
  target(now = new Date()) {
    const { brightness, eveningDim, sleep } = this.settings;
    if (!eveningDim.enabled) return brightness;
    const mins = now.getHours() * 60 + now.getMinutes();
    // evening dim lasts until the morning wake-up time (or 6:00 without a sleep schedule)
    const until = toMin(sleep.enabled ? sleep.on : "06:00");
    return inWindow(mins, toMin(eveningDim.from), until) ? Math.min(brightness, eveningDim.level) : brightness;
  },

  applyBrightness() {
    const level = this.asleep ? 0 : this.target();
    if (level === this.applied) return;
    this.applied = level;
    // the page dims itself only in software mode (a sleeping screen is black anyway)
    this.sendSocketNotification("OS_SET_SOFT_DIM", this.method === "software" && !this.asleep ? level : 100);
    if (this.method === "software") return;
    this.pending = level;
    this.queue = this.queue.then(async () => {   // one change at a time; the newest wins
      if (this.pending !== level) return;
      if (DRY) { this.fake.level = level; return; }
      if (this.method === "backlight") {
        try { fs.writeFileSync(this.backlight.file, String(Math.round(level / 100 * this.backlight.max))); } catch (e) { console.error(`[OpenSky] backlight: ${e.message}`); }
      } else if (this.method === "ddc") {
        const r = await run("ddcutil", ["--noverify", "--sleep-multiplier", ".5", "setvcp", "10", String(level)], 20000);
        if (!r.ok) console.error(`[OpenSky] ddcutil: ${r.err.trim()}`);
      }
    });
  },

  /* ---------- screen off / on (lib/screen.js) ---------- */
  async screenOff() {
    const avail = this.screenAvail || {};
    const m = this.testMethod || screen.resolve(this.settings.screenOff, avail);
    this.offMethod = m;
    if (m === "soft") return;   // the page's black cover + brightness 0 (applyBrightness) is all it takes
    await screen.off(m, avail);
    // the page can't see touches now: watch the input devices (after a moment, so the Sleep tap itself doesn't wake it)
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => { if (this.offMethod === m) this.stopWatch = screen.watchInput(() => this.wake()); }, 2500);
    if (m === "output") {
      clearTimeout(this.backTimer);
      this.backTimer = setTimeout(async () => {
        if (this.offMethod !== "output" || !(await screen.cameBack(avail))) return;
        // this monitor reconnects by itself when the signal stops: use the black screen instead
        console.log("[OpenSky] screen: the monitor came back on by itself — switching to Black screen + dim");
        this.stopWatching();
        this.offMethod = "soft";
        if (!this.testMethod) { this.settings.screenOff = "soft"; this.save(); this.sendState(); }
        this.sendSocketNotification("OS_SET_NOTICE", { type: "info", message: osT("This screen turns itself back on when the signal stops, so OpenSky uses Black screen + dim instead.") });
      }, 25000);
    }
  },

  async screenOn() {
    const m = this.offMethod;
    this.offMethod = null;
    this.testMethod = null;
    this.stopWatching();
    clearTimeout(this.backTimer);
    if (m && m !== "soft") {
      const avail = this.screenAvail || {};
      await screen.on(m, avail);
      // make sure it really came back (retry once); if not, say so plainly and stop using this way
      setTimeout(async () => {
        if (await screen.isBack(m, avail)) return;
        await screen.on(m, avail);
        await new Promise((r) => setTimeout(r, 3000));
        if (await screen.isBack(m, avail)) return;
        console.error(`[OpenSky] screen: didn't come back on after "${m}" — switching to Black screen + dim`);
        this.settings.screenOff = "soft"; this.save(); this.sendState();
        this.sendSocketNotification("OS_SET_NOTICE", { type: "error", message: osT("The screen didn't come back on by itself. If it's dark, press its power button. OpenSky now uses Black screen + dim, which always comes back.") });
      }, 3000);
    }
  },

  stopWatching() { clearTimeout(this.watchTimer); if (this.stopWatch) { this.stopWatch(); this.stopWatch = null; } },

  // a touch while the screen was really off, or the end of a Test: screen on, page awake
  async wake() {
    await this.screenOn();
    this.sendSocketNotification("OS_SET_WAKE");
  },

  /* ---------- automatic backups ---------- */
  backupIfDue() {
    if (!backup.due()) return;
    const st = backup.run();
    console.log(`[OpenSky] nightly backup: ${st.ok ? st.file : `failed — ${st.error}`}`);
  },

  /* ---------- core settings (the same ones the phone page edits) ---------- */
  // forChange: a damaged opensky.json (a typo from editing it by hand) throws, or the change would replace it with
  // little more than that one setting
  readSettings(forChange) {
    try { return JSON.parse(fs.readFileSync(backup.SETTINGS, "utf8")); } catch (e) {
      if (forChange && e.code !== "ENOENT") throw new Error(osT("opensky.json has a mistake, so nothing was changed — fix it first (opensky check shows where)"));
      return {};
    }
  },

  sendPrefs(extra = {}) {
    const s = this.readSettings();
    const names = { home: osT("Home"), calendar: osT("Calendar"), lists: osT("Lists"), wordgame: osT("Word Game"), timer: osT("Timer"), music: osT("Music") };
    for (const [k, e] of Object.entries(s.embeds || {})) names[k] = (e && e.title) || k;
    const pages = Array.isArray(s.pages) ? s.pages.filter((p) => names[p]) : ["home", "timer"];
    this.sendSocketNotification("OS_SET_PREFS", {
      pages, names,
      prefs: {
        accent: accent.normalize(s.look && s.look.accent) || "peach",   // (checked: it goes into the panel's HTML)
        wordgame: (s.wordgame && s.wordgame.source) === "opensky" ? "opensky" : "nyt",
        photos: !(s.photos && s.photos.enabled === false),
        trashDay: (s.pickup && s.pickup.trashDay) || ""
      },
      // web pages: what the screen needs to list / edit them (a PIN page's address and PIN stay in secrets.json)
      embeds: Object.entries(s.embeds || {}).map(([key, e]) => ({ key, title: (e && e.title) || key, icon: (e && e.icon) || (key === "smarthome" ? "smarthome" : "embed"), url: (e && e.url) || null, locked: this.embedLocked(key) })),
      backup: backup.settings(), places: backup.destinations(), status: backup.status(), ...extra
    });
  },

  // a damaged secrets.json (a typo from editing it by hand) throws: writing it back would lose every other password
  readSecrets() {
    try { return JSON.parse(fs.readFileSync(backup.SECRETS, "utf8")); } catch (e) {
      if (e.code === "ENOENT") return {};
      throw new Error(osT("secrets.json has a mistake, so nothing was changed — fix it first (opensky check shows where)"));
    }
  },
  writeSecrets(sec) {
    fs.writeFileSync(`${backup.SECRETS}.tmp`, JSON.stringify(sec, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(`${backup.SECRETS}.tmp`, backup.SECRETS);
    fs.chmodSync(backup.SECRETS, 0o600);
  },
  embedLocked(key) {
    let sec; try { sec = this.readSecrets(); } catch (e) { return false; }
    const e = (sec.embeds || {})[key]; return !!(e && /^\d{4,8}$/.test(String(e.pin || "")));
  },

  // Add / change / remove a web page (a page of its own in the sidebar, like Smart Home)
  webPage(s, w) {
    const err = (m) => { throw new Error(m); };
    s.embeds = s.embeds || {};
    s.pages = Array.isArray(s.pages) ? s.pages : ["home"];
    const sec = this.readSecrets();
    sec.embeds = sec.embeds || {};
    if (w.remove) {
      delete s.embeds[w.remove]; delete sec.embeds[w.remove];
      s.pages = s.pages.filter((p) => p !== w.remove);
      this.writeSecrets(sec);
      return;
    }
    const title = String(w.title || "").trim().slice(0, 24);
    const url = String(w.url || "").trim();
    const icon = (WEB_ICONS.includes(w.icon) ? w.icon : "embed");
    if (!title) err(osT("Please give it a name"));
    if (url && !/^https?:\/\/\S+$/i.test(url)) err(osT("The address starts with http:// or https://"));
    const pin = w.pin == null ? null : String(w.pin).replace(/\D/g, "");
    if (pin && !/^\d{4,8}$/.test(pin)) err(osT("A PIN is 4 to 8 digits"));
    let key = w.key;
    if (!key) {   // a new page
      if (!url) err(osT("Please type the page's address"));
      key = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "web";
      if (/^[^a-z]/.test(key)) key = `web-${key}`;
      const taken = ["home", "calendar", "lists", "wordgame", "timer", "settings"];
      while (s.embeds[key] || taken.includes(key)) key += "-2";
      s.pages.splice(Math.max(1, s.pages.length - (s.pages[s.pages.length - 1] === "timer" ? 1 : 0)), 0, key);
    }
    const old = s.embeds[key] || {}, oldSec = sec.embeds[key] || {};
    const address = url || old.url || oldSec.url || "";
    const locked = pin === "" ? false : (pin ? true : !!oldSec.pin);   // "" = take the PIN off
    if (locked) {   // the address goes with the PIN into secrets.json, never into opensky.json
      sec.embeds[key] = { url: address, pin: pin || oldSec.pin };
      s.embeds[key] = { title, icon };
    } else {
      delete sec.embeds[key];
      s.embeds[key] = { title, icon, url: address };
    }
    if (old.zoom) s.embeds[key].zoom = old.zoom;
    this.writeSecrets(sec);
  },

  savePrefs(patch) {
    let s;
    try { s = this.readSettings(true); } catch (e) { return this.sendSocketNotification("OS_SET_NOTICE", { type: "error", message: e.message }); }
    let restartNeeded = false;
    if (patch.webPage) {
      try { this.webPage(s, patch.webPage); restartNeeded = true; }
      catch (e) { return this.sendSocketNotification("OS_SET_NOTICE", { type: "error", message: e.message }); }
    }
    if (Array.isArray(patch.pages) && patch.pages.length) { s.pages = patch.pages.map(String).filter((p) => /^[a-z][a-z0-9-]{0,30}$/.test(p)); restartNeeded = true; }
    if ("accent" in patch) {
      // a palette color or a color code (#rgb / #rrggbb, stored as #rrggbb); peach is the default, so it's left out
      const a = accent.normalize(patch.accent);
      if (!a) return this.sendSocketNotification("OS_SET_NOTICE", { type: "error", message: osT("That isn't a color — type a code like #3b82f6") });
      s.look = s.look || {};
      if (a === "peach") delete s.look.accent; else s.look.accent = a;
    }
    if ("wordgame" in patch) { s.wordgame = s.wordgame || {}; s.wordgame.source = patch.wordgame === "opensky" ? "opensky" : "nyt"; restartNeeded = true; }
    if ("photos" in patch) { s.photos = s.photos || {}; s.photos.enabled = !!patch.photos; restartNeeded = true; }
    if ("trashDay" in patch) { s.pickup = s.pickup || {}; s.pickup.trashDay = String(patch.trashDay || ""); restartNeeded = true; }
    if (patch.backup && typeof patch.backup === "object") {
      const b = { ...(s.backup || {}), ...patch.backup };
      if (!b.destination) delete b.destination;
      s.backup = b;
    }
    try {
      if (fs.existsSync(backup.SETTINGS)) fs.copyFileSync(backup.SETTINGS, `${backup.SETTINGS}.bak`);
      fs.writeFileSync(`${backup.SETTINGS}.tmp`, JSON.stringify(s, null, 2) + "\n");
      fs.renameSync(`${backup.SETTINGS}.tmp`, backup.SETTINGS);
    } catch (e) { return this.sendSocketNotification("OS_SET_SYSTEM_RESULT", { ok: false, message: osT("Couldn't save: {error}", { error: e.message }) });
 }
    this.sendPrefs(restartNeeded ? { restartNeeded: true } : {});
  },

  /* ---------- status + system ---------- */
  async status() {
    const out = { version: null, updates: null, ip: "", internet: false, brightness: this.method, audio: this.audio && this.audio.name };
    try { await dns.lookup("github.com"); out.internet = true; } catch (e) { /* offline */ }
    const ip = await run("hostname", ["-I"], 3000);
    out.ip = ip.out.trim().split(/\s+/)[0] || "";
    const v = await run("git", ["-C", REPO, "describe", "--tags", "--always", "--dirty"], 5000);
    out.version = v.ok ? v.out.trim() : null;
    // a Pi on its own branch (a fork) gets changes with `git pull`, and `opensky update` leaves it alone: no count
    const branch = (await run("git", ["-C", REPO, "symbolic-ref", "-q", "--short", "HEAD"], 5000)).out.trim();
    const ownBranch = branch !== "" && branch !== "main";
    if (ownBranch) out.updates = 0;
    if (out.internet && !DRY && !ownBranch) {
      // how many updates are waiting (only fetches; nothing changes until "Update" is pressed)
      // the same rule as `opensky update`: the newest release tag, or origin/main when update.channel is "main"
      if ((await run("git", ["-C", REPO, "fetch", "--quiet", "--tags", "origin"], 30000)).ok) {
        const channel = ((this.readSettings().update || {}).channel) === "main" ? "main" : "releases";
        const tag = channel === "releases" ? (await run("git", ["-C", REPO, "-c", "versionsort.suffix=-", "tag", "-l", "v[0-9]*", "--sort=-v:refname"], 5000)).out.split("\n")[0].trim() : "";
        const target = tag || "origin/main";
        const ahead = await run("git", ["-C", REPO, "merge-base", "--is-ancestor", target, "HEAD"], 5000);
        out.updates = ahead.ok ? 0 : 1;
        out.updateTo = ahead.ok ? null : (tag || osT("the newest version"));
      }
    }
    if (DRY) out.updates = 0;
    return out;
  },

  async system(action) {
    const say = (ok, message) => ({ ok, message });
    console.log(`[OpenSky] settings: ${action}${DRY ? " (dry run — nothing done)" : ""}`);
    if (DRY) return say(true, "Done (test mode)");
    if (action === "restart-app") {
      if (!process.env.INVOCATION_ID) return say(false, osT("OpenSky isn't running as a service here — use Reload instead"));
      // --no-block: systemd restarts us after this returns
      const r = await run("systemctl", ["--user", "--no-block", "restart", "opensky.service"], 5000);
      return say(r.ok, r.ok ? osT("Restarting…") : osT("Couldn't restart OpenSky"));
    }
    if (action === "update") {
      // runs outside OpenSky's own service, so it survives the restart at its end
      const r = await run("systemd-run", ["--user", "--unit=opensky-update", "--collect", path.join(REPO, "tools", "opensky"), "update"], 10000);
      return say(r.ok, r.ok ? osT("Updating — the screen restarts by itself when it's done (a few minutes)") : osT("Couldn't start the update (is one already running?)"));
    }
    if (action === "reboot" || action === "shutdown") {
      const r = await run("sudo", ["-n", "systemctl", action === "reboot" ? "reboot" : "poweroff"], 10000);
      return say(r.ok, r.ok ? (action === "reboot" ? osT("Restarting the Pi…") : osT("Shutting down — wait for the green light to stop before unplugging")) : osT("This Pi doesn't allow that without a password"));
    }
    return say(false, osT("Unknown action"));
  }
});
