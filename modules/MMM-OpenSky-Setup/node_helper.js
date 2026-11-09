/* MMM-OpenSky-Setup node helper — set OpenSky up from a phone.
 *
 * Runs a small web server on the Pi's network address (port 8090, opensky.json → setup.port) ONLY while setup is
 * open on the screen (or a paired phone is still busy with it); it stops by itself after 30 quiet minutes. The phone pairs with the 6-digit code shown on the
 * screen (good for 10 minutes; 5 wrong tries → a 1-minute pause) and gets a session cookie that dies with the server.
 *   - opensky.json is read and written whole (a copy of the previous one is kept as opensky.json.bak).
 *   - secrets.json is WRITE-ONLY from the phone: it learns which secrets are set, never their values.
 *   - "Done" restarts OpenSky (when it runs as the opensky service) so the screen shows the new settings.
 * OPENSKY_DRY_RUN=1 (tests): nothing is restarted.
 *
 * Screen ↔ helper:  OS_SETUP_INIT → OS_SETUP_WELCOME {show}   OS_SETUP_START → OS_SETUP_READY {urls, code, expiresAt}
 *   OS_SETUP_NEWCODE → OS_SETUP_READY   OS_SETUP_STOP   → events OS_SETUP_PAIRED, OS_SETUP_SAVED, OS_SETUP_STOPPED {reason, failed?}
 * Phone ↔ server (JSON; POSTs need the header "X-OpenSky: 1"):
 *   POST /api/pair {code} · GET /api/state · POST /api/save {settings, secrets} · GET /api/geocode?q= · POST /api/done
 *   Google Calendar sign-in: GET /api/google · POST /api/google/start {clientId?, clientSecret?} → {url}
 *     · POST /api/google/finish {address} → {calendars} · GET /api/google/calendars
 *   Apple Reminders sign-in (lists): GET /api/icloud · POST /api/icloud/signin {appleId, password} → {state: ok | 2fa}
 *     · POST /api/icloud/code {code} · GET /api/icloud/lists · POST /api/icloud/signout — handed to the calendar
 *     service on this Pi (services/calendar-service/reminders.py); the password only passes through, it's never kept
 *   GET /api/music/speakers → {speakers: [{id, name, state}]} (Home Assistant media players, for the Music page)
 *   GET /api/backup[?secrets=1] (a download: settings + on-device data, passwords only when asked) · POST /api/restore {backup}
 */
const NodeHelper = require("node_helper");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { osT } = require(path.join(__dirname, "..", "..", "lib", "client", "i18n.js"));   // texts in opensky.json's language
const crypto = require("crypto");
const { execFile } = require("child_process");
const google = require(path.join(global.root_path || process.cwd(), "modules", "opensky-lib", "google-calendar.js"));
const backup = require(path.join(global.root_path || process.cwd(), "modules", "opensky-lib", "backup.js"));
const music = require(path.join(global.root_path || process.cwd(), "modules", "opensky-lib", "music.js"));

const DRY = process.env.OPENSKY_DRY_RUN === "1";
const MM_CONFIG = path.join(global.root_path || process.cwd(), "config");
const SETTINGS = process.env.OPENSKY_SETTINGS || path.join(MM_CONFIG, "opensky.json");
const SECRETS = process.env.OPENSKY_SECRETS || path.join(path.dirname(SETTINGS), "secrets.json");
const WELCOMED = process.env.OPENSKY_WELCOME_FILE || path.join(path.dirname(SETTINGS), ".welcomed");
const EXAMPLE = path.join(__dirname, "..", "..", "config", "opensky.example.json");
const PHONE = path.join(__dirname, "phone");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/opensky-client.js": [path.join("..", "..", "..", "lib", "client", "opensky-client.js"), "text/javascript; charset=utf-8"],
  "/i18n.js": [path.join("..", "..", "..", "lib", "client", "i18n.js"), "text/javascript; charset=utf-8"],
  "/icon.png": [path.join("..", "..", "..", "lib", "client", "assets", "opensky-icon.png"), "image/png"],
  "/apple-touch-icon.png": [path.join("..", "..", "..", "lib", "client", "assets", "opensky-touch-icon.png"), "image/png"]
};
const CODE_MINUTES = 10, IDLE_MINUTES = 30;
// secrets the phone may set (dotted paths under these)
const SECRET_ROOTS = ["weather.openweathermap.", "lists.todoist.", "homeassistant.", "photos.immich.", "calendar.sources.", "calendar.caldav.", "embeds."];

// the Music add-on's speakers, installed by `opensky addon music` (tests: OPENSKY_MUSIC_INSTALLED=spotify,airplay)
function musicInstalled() {
  if (process.env.OPENSKY_MUSIC_INSTALLED != null) { const on = process.env.OPENSKY_MUSIC_INSTALLED.split(","); return { spotify: on.includes("spotify"), airplay: on.includes("airplay") }; }
  const units = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
  return { spotify: fs.existsSync(path.join(units, "opensky-spotify.service")), airplay: fs.existsSync(path.join(units, "opensky-airplay.service")) };
}
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; } };
// secrets.json before a change: a damaged file (a typo from editing it by hand) is never replaced, or every other
// password in it would be lost
function secretsForChange() {
  try { return JSON.parse(fs.readFileSync(SECRETS, "utf8")); } catch (e) {
    if (e.code === "ENOENT") return {};
    throw Object.assign(new Error(osT("secrets.json on the Pi has a mistake, so nothing was saved — fix it first (opensky check shows where)")), { status: 409 });
  }
}
function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n", mode ? { mode } : undefined);
  fs.renameSync(`${file}.tmp`, file);
  if (mode) fs.chmodSync(file, mode);
}

// which secrets are set: their dotted paths only (values never leave the Pi)
function secretPaths(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith("_")) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) secretPaths(v, `${prefix}${k}.`, out);
    else if (v !== "" && v != null) out.push(`${prefix}${k}`);
  }
  return out;
}

// set (string), merge (object; empty fields left as they were) or remove (null / "") a secret by dotted path
function applySecret(root, dotted, value) {
  const keys = dotted.split(".");
  let o = root;
  for (const k of keys.slice(0, -1)) { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
  const last = keys[keys.length - 1];
  if (value === null || value === "") delete o[last];
  else if (typeof value === "object") {
    const cur = o[last] && typeof o[last] === "object" ? o[last] : {};
    for (const [k, v] of Object.entries(value)) if (v !== "" && v != null) cur[k] = String(v).trim();
    o[last] = cur;
  } else o[last] = String(value).trim();
}

module.exports = NodeHelper.create({
  start() {
    this.server = null;
    this.sessions = new Set();
  },

  socketNotificationReceived(n) {
    if (n === "OS_SETUP_INIT") this.sendSocketNotification("OS_SETUP_WELCOME", { show: !fs.existsSync(WELCOMED) });
    else if (n === "OS_SETUP_START") this.startServer();
    else if (n === "OS_SETUP_NEWCODE") { this.newCode(); this.ready(); }
    else if (n === "OS_SETUP_STOP") {
      this.markWelcomed();
      // a phone that is still connected keeps working (closing the card on the screen mid-edit made its next Save
      // fail); it stops with the phone's Finish or after 30 quiet minutes
      if (this.server && this.sessions.size) return console.log("[OpenSky] phone setup: card closed on the screen; the connected phone can still finish");
      this.stopServer("closed on the screen");
    }
  },

  /* ---------------- pairing ---------------- */
  newCode() {
    this.code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    this.codeUntil = Date.now() + CODE_MINUTES * 60 * 1000;
    this.wrong = 0;
    this.lockedUntil = 0;
  },

  addresses() {
    const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
    return { ips, host: `${os.hostname()}.local` };
  },

  ready() {
    const { ips, host } = this.addresses();
    this.sendSocketNotification("OS_SETUP_READY", {
      urls: [...ips.map((ip) => `http://${ip}:${this.port}`), `http://${host}:${this.port}`],
      code: this.code, expiresAt: this.codeUntil
    });
  },

  markWelcomed() { try { if (!fs.existsSync(WELCOMED)) fs.writeFileSync(WELCOMED, new Date().toISOString() + "\n"); } catch (e) { /* not important */ } },

  startServer() {
    this.markWelcomed();
    this.newCode();
    if (this.server) { this.touch(); return this.ready(); }
    const s = readJson(SETTINGS, {});
    this.port = Number(process.env.OPENSKY_SETUP_PORT) || (s.setup && Number(s.setup.port)) || 8090;
    this.sessions = new Set();
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      console.error(`[OpenSky] setup: ${e.message}`);
      this.send(res, 500, { error: osT("Something went wrong on the Pi") });
    }));
    this.server.on("error", (e) => {
      console.error(`[OpenSky] setup server: ${e.message}`);
      this.server = null;
      this.sendSocketNotification("OS_SETUP_STOPPED", { failed: true, reason: e.code === "EADDRINUSE" ? osT("Port {port} is busy", { port: this.port }) : osT("Couldn't start") });

    });
    this.server.listen(this.port, "0.0.0.0", () => { console.log(`[OpenSky] phone setup open on port ${this.port}`); this.touch(); this.ready(); });
  },

  stopServer(reason) {
    clearTimeout(this.idleTimer);
    if (!this.server) return;
    this.server.close();
    if (this.server.closeAllConnections) this.server.closeAllConnections();
    this.server = null;
    this.sessions = new Set();
    console.log(`[OpenSky] phone setup closed (${reason})`);
    this.sendSocketNotification("OS_SETUP_STOPPED", { reason });
  },

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopServer("no activity for 30 minutes"), IDLE_MINUTES * 60 * 1000);
  },

  /* ---------------- HTTP ---------------- */
  send(res, status, body, headers = {}) {
    const base = {
      "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
    };
    if (Buffer.isBuffer(body) || typeof body === "string") {
      res.writeHead(status, { ...base, ...headers });
      return res.end(body);
    }
    res.writeHead(status, { ...base, "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  },

  // only names that point at this Pi (a web page elsewhere can't use DNS tricks to reach this server)
  hostOk(req) {
    const h = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    const { ips, host } = this.addresses();
    return [...ips, host.toLowerCase(), "localhost", "127.0.0.1", os.hostname().toLowerCase()].includes(h);
  },

  authed(req) {
    const m = String(req.headers.cookie || "").match(/(?:^|;\s*)os_setup=([a-f0-9]{64})/);
    return !!(m && this.sessions.has(m[1]));
  },

  body(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error(osT("That's too big"))); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new Error("bad JSON")); } });
      req.on("error", reject);
    });
  },

  async handle(req, res) {
    if (!this.hostOk(req)) return this.send(res, 421, { error: osT("Wrong address") });
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      let body = fs.readFileSync(path.join(PHONE, file));
      // the translations, already set to opensky.json's language (so even the pairing page is in it)
      if (url.pathname === "/i18n.js") body = `${body}\nwindow.OpenSkyI18n.setLanguage(${JSON.stringify(require(path.join(PHONE, file)).language())});\n`;
      return this.send(res, 200, body, { "Content-Type": type });

    }
    if (!url.pathname.startsWith("/api/")) return this.send(res, 404, { error: osT("Not found") });
    if (req.method === "POST" && req.headers["x-opensky"] !== "1") return this.send(res, 403, { error: osT("Refused") });

    if (url.pathname === "/api/pair" && req.method === "POST") {
      const { code } = await this.body(req);
      // checked once the code has arrived: many requests can be waiting for their bodies at the same moment
      const now = Date.now();
      if (this.lockedUntil > now) return this.send(res, 429, { error: osT("Too many tries — wait {n} s", { n: Math.ceil((this.lockedUntil - now) / 1000) }) });

      if (now > this.codeUntil) return this.send(res, 410, { error: osT("That code has expired — tap \"New code\" on the screen") });
      const a = Buffer.from(String(code || "").replace(/\D/g, "")), b = Buffer.from(this.code);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        const token = crypto.randomBytes(32).toString("hex");
        this.sessions.add(token);
        this.touch();
        this.sendSocketNotification("OS_SETUP_PAIRED", { phones: this.sessions.size });
        return this.send(res, 200, { ok: true }, { "Set-Cookie": `os_setup=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      this.wrong += 1;
      if (this.wrong % 5 === 0) this.lockedUntil = now + 60 * 1000;
      if (this.wrong >= 15) {   // a new code, and the pause still holds
        this.newCode(); this.lockedUntil = now + 60 * 1000; this.ready();
        return this.send(res, 401, { error: osT("Too many wrong codes — the screen shows a new one") });
      }
      return this.send(res, 401, { error: osT("That's not the code on the screen") });
    }

    if (!this.authed(req)) return this.send(res, 401, { error: osT("Not paired"), pair: true });
    this.touch();   // only a paired phone keeps setup open (anyone else on the Wi-Fi can't hold it open forever)

    if (url.pathname === "/api/state" && req.method === "GET") {
      const settings = readJson(SETTINGS, null);
      // a damaged opensky.json: showing the example instead would let Save replace the family's settings with it
      if (!settings && fs.existsSync(SETTINGS)) return this.send(res, 409, { error: osT("opensky.json on the Pi has a mistake — fix it first (opensky check shows where)") });
      let presets = [];
      try { presets = fs.readdirSync(path.join(__dirname, "..", "..", "lib", "pickup-presets")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch (e) { /* none */ }
      return this.send(res, 200, {
        settings: settings || readJson(EXAMPLE, {}), secretsSet: secretPaths(readJson(SECRETS, {})), presets,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, service: !!process.env.INVOCATION_ID || DRY,
        addons: { music: musicInstalled() }
      });
    }

    if (url.pathname === "/api/save" && req.method === "POST") {
      const { settings, secrets } = await this.body(req);
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) return this.send(res, 400, { error: osT("Nothing to save") });
      if (settings.pages && !Array.isArray(settings.pages)) return this.send(res, 400, { error: osT("Pages must be a list") });
      const changes = secrets && typeof secrets === "object" ? Object.entries(secrets) : [];
      let cur = null;
      if (changes.length) { try { cur = secretsForChange(); } catch (e) { return this.send(res, e.status, { error: e.message }); } }
      if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak`);
      writeJson(SETTINGS, settings);
      if (cur) {
        for (const [k, v] of changes) {
          if (!SECRET_ROOTS.some((r) => k.startsWith(r)) || !/^[\w .'&()-]+(\.[\w .'&()-]+)*$/.test(k)) continue;
          if (k.split(".").some((p) => ["__proto__", "constructor", "prototype"].includes(p.trim()))) continue;   // (would change every object on the Pi)
          applySecret(cur, k, v);
        }
        writeJson(SECRETS, cur, 0o600);
      }
      console.log("[OpenSky] phone setup: settings saved");
      this.sendSocketNotification("OS_SETUP_SAVED", {});
      return this.send(res, 200, { ok: true, secretsSet: secretPaths(readJson(SECRETS, {})) });
    }

    if (url.pathname === "/api/geocode" && req.method === "GET") {
      const q = String(url.searchParams.get("q") || "").slice(0, 80);
      if (!q.trim()) return this.send(res, 200, { results: [] });
      try {
        const base = process.env.OPENSKY_GEOCODE_URL || "https://geocoding-api.open-meteo.com/v1/search";
        const r = await fetch(`${base}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`, { signal: AbortSignal.timeout(10000) });
        const d = await r.json();
        return this.send(res, 200, { results: (d.results || []).map((x) => ({ name: x.name, admin1: x.admin1 || "", country: x.country || "", country_code: x.country_code || "", latitude: x.latitude, longitude: x.longitude, timezone: x.timezone || "" })) });
      } catch (e) {
        return this.send(res, 502, { error: osT("Couldn't look that up — is the Pi online?") });
      }
    }

    // Apple Reminders: the calendar service does the signing in and keeps the session (never the password)
    const ICLOUD = { "GET /api/icloud": "status", "POST /api/icloud/signin": "signin", "POST /api/icloud/code": "code", "GET /api/icloud/lists": "lists", "POST /api/icloud/signout": "signout" };
    const icloudOp = ICLOUD[`${req.method} ${url.pathname}`];
    if (icloudOp) {
      const body = req.method === "POST" ? await this.body(req) : undefined;
      const port = Number(process.env.OPENSKY_CALENDAR_PORT) || Number(((readJson(SETTINGS, {}).calendar || {}).service || {}).port) || 5747;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/_reminders/${icloudOp}`, body === undefined ? { signal: AbortSignal.timeout(60000) }
          : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        const d = await r.json().catch(() => ({}));
        if (icloudOp === "code" && r.ok) console.log("[OpenSky] phone setup: signed in to Apple Reminders");
        return this.send(res, r.status, d);
      } catch (e) {
        return this.send(res, 502, { error: osT("Can't reach the calendar service. Try again in a minute.") });
      }
    }
    if (url.pathname === "/api/google" && req.method === "GET") {

      const g = readJson(SECRETS, {}).google || {};
      return this.send(res, 200, { clientSet: !!(g.clientId && g.clientSecret), signedIn: !!g.refreshToken, redirect: google.REDIRECT });
    }
    if (url.pathname === "/api/google/start" && req.method === "POST") {
      const { clientId, clientSecret } = await this.body(req);
      let cur;
      try { cur = secretsForChange(); } catch (e) { return this.send(res, e.status, { error: e.message }); }
      if (clientId || clientSecret) {
        applySecret(cur, "google", { clientId: String(clientId || "").trim(), clientSecret: String(clientSecret || "").trim() });
        writeJson(SECRETS, cur, 0o600);
      }
      const g = cur.google || {};
      if (!g.clientId || !g.clientSecret) return this.send(res, 400, { error: osT("Paste the Client ID and Client secret first") });
      try { this.googlePending = google.authUrl(g.clientId); } catch (e) { return this.send(res, e.status || 400, { error: e.message }); }
      return this.send(res, 200, { url: this.googlePending.url });
    }
    if (url.pathname === "/api/google/finish" && req.method === "POST") {
      const { address } = await this.body(req);
      let cur;
      try { cur = secretsForChange(); } catch (e) { return this.send(res, e.status, { error: e.message }); }
      const g = cur.google || {};
      try {
        const { refreshToken } = await google.finishSignIn(address, this.googlePending, g.clientId, g.clientSecret);
        applySecret(cur, "google", { refreshToken });
        writeJson(SECRETS, cur, 0o600);
        this.googlePending = null;
        console.log("[OpenSky] phone setup: signed in to Google Calendar");
        return this.send(res, 200, { calendars: await google.listCalendars() });
      } catch (e) { return this.send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message }); }
    }
    if (url.pathname === "/api/google/calendars" && req.method === "GET") {
      try { return this.send(res, 200, { calendars: await google.listCalendars() }); }
      catch (e) { return this.send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message }); }
    }

    if (url.pathname === "/api/backup" && req.method === "GET") {
      const withSecrets = url.searchParams.get("secrets") === "1";
      console.log(`[OpenSky] phone setup: backup downloaded${withSecrets ? " (with passwords)" : ""}`);
      const n = new Date(), day = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
      return this.send(res, 200, JSON.stringify(backup.make(withSecrets), null, 2), { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="opensky-backup-${day}.json"` });
    }

    if (url.pathname === "/api/restore" && req.method === "POST") {
      const { backup: b } = await this.body(req, 20 * 1024 * 1024);
      let restored;
      try { restored = backup.restore(b); } catch (e) { return this.send(res, e.status || 500, { error: e.message }); }
      console.log(`[OpenSky] phone setup: restored a backup (${restored.join(", ")})`);
      this.sendSocketNotification("OS_SETUP_SAVED", {});
      return this.send(res, 200, { ok: true, restored });
    }

    // the Music page's other speakers: every media player Home Assistant has (address + token from secrets.json)
    if (url.pathname === "/api/music/speakers" && req.method === "GET") {
      try { return this.send(res, 200, { speakers: await music.listSpeakers() }); }
      catch (e) { return this.send(res, 502, { error: e.message }); }
    }

    // automatic backups: where they can go, how the last one went, and "back up now"
    if (url.pathname === "/api/backup/places" && req.method === "GET") {
      return this.send(res, 200, { places: backup.destinations(), status: backup.status() });
    }
    if (url.pathname === "/api/backup/run" && req.method === "POST") {
      const st = backup.run();
      return this.send(res, st.ok ? 200 : 400, st.ok ? { ok: true, status: st } : { error: st.error, status: st });
    }

    if (url.pathname === "/api/done" && req.method === "POST") {
      this.send(res, 200, { ok: true, restarting: !!process.env.INVOCATION_ID && !DRY });
      setTimeout(() => {
        this.stopServer("setup finished");
        if (DRY) return console.log("[OpenSky] phone setup: restart (dry run — nothing done)");
        if (process.env.INVOCATION_ID) {
          const restart = () => execFile("systemctl", ["--user", "--no-block", "restart", "opensky-calendar.service", "opensky.service"], () => {});
          // the Music add-on's speakers first, and only what changed (a new name; AirPlay / Spotify switched on or off)
          const m = musicInstalled();
          if (m.airplay || m.spotify) execFile(path.join(__dirname, "..", "..", "tools", "addons", "music.sh"), ["apply"], { timeout: 30000 }, restart);
          else restart();
        }
      }, 300);
      return;
    }
    return this.send(res, 404, { error: osT("Not found") });
  }
});
