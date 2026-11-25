/* MMM-OpenSky-Meals node helper — the meal planner's data (lib/meals.js) for the screen, the kitchen page for phones,
 * and "send to Bring!" (lib/bring.js).
 *
^ * Screen:  OS_MEALS_INIT → OS_MEALS_STATE {state, kitchen: {urls}, bring: bool}
 *          OS_MEALS_CALL {id, op, body} → OS_MEALS_RESULT {id, ok, error?, state?, sent?}   (op "bring" {weekStart, keys?} sends; keys = only those)
 * Kitchen page (always on, home Wi-Fi, NO pairing code — by the family's choice): http://<pi>:8092
 *   It can only see and change dishes and plans (lib/meals.js) and send the shopping list to Bring!: never settings,
 *   passwords or calendars. Same guards as the setup page: only this Pi's own addresses (no DNS tricks), changes need
 *   the X-OpenSky header (a web page elsewhere can't send them), small bodies, strict content security policy.
 *   GET /api/state · POST /api/change {op, body} · POST /api/bring {weekStart, keys?}
 */
const NodeHelper = require("node_helper");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const LIB = path.join(__dirname, "..", "..", "lib");
const meals = require(path.join(LIB, "meals.js"));
const bring = require(path.join(LIB, "bring.js"));
const { osT } = require(path.join(LIB, "client", "i18n.js"));

const PAGE = path.join(__dirname, "kitchen");
const STATIC = {
  "/": [path.join(PAGE, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [path.join(PAGE, "app.js"), "text/javascript; charset=utf-8"],
  "/app.css": [path.join(PAGE, "app.css"), "text/css; charset=utf-8"],
  // (the look of the phone setup page, so both feel the same)
  "/base.css": [path.join(__dirname, "..", "MMM-OpenSky-Setup", "phone", "app.css"), "text/css; charset=utf-8"],
  "/meals-shared.js": [path.join(LIB, "client", "meals-shared.js"), "text/javascript; charset=utf-8"],

  "/i18n.js": [path.join(LIB, "client", "i18n.js"), "text/javascript; charset=utf-8"],
  "/icon.png": [path.join(LIB, "client", "assets", "opensky-icon.png"), "image/png"],
  "/apple-touch-icon.png": [path.join(LIB, "client", "assets", "opensky-touch-icon.png"), "image/png"]
};

module.exports = NodeHelper.create({
  start() {
    // opensky.json → meals.bringList / meals.kitchenPort (read here too: the kitchen page runs even while the screen
    // is still loading or reloading)
    let m = {};
    try { m = (JSON.parse(fs.readFileSync(process.env.OPENSKY_SETTINGS || path.join(global.root_path || process.cwd(), "config", "opensky.json"), "utf8")).meals) || {}; } catch (e) { /* defaults */ }
    this.bringList = m.bringList || null;
    this.port = Number(process.env.OPENSKY_KITCHEN_PORT) || Number(m.kitchenPort) || 8092;
    this.startKitchen();
    // a change from anywhere (kitchen page, screen) → the screen shows it
    meals.on("change", () => this.pushState());
    // what was put on the Bring! list and bought there gets ticked here: checked every 2 minutes while anything waits
    setInterval(() => this.syncBring(), Number(process.env.OPENSKY_BRING_SYNC_MS) || 2 * 60 * 1000);
    setTimeout(() => this.syncBring(), 15 * 1000);
  },

  async syncBring() {
    if (this.syncing || !bring.configured()) return;
    if (!Object.keys(meals.waitingOnBring()).length) return;
    this.syncing = true;
    try {
      const n = meals.syncBought(await bring.toBuyNames(this.bringList));
      if (n) console.log(`[OpenSky] meals: ${n} items bought in Bring! — ticked`);
    } catch (e) {
      // (quietly: the next check tries again; sending shows a problem with Bring! to whoever sends)
      if (e.message !== this.lastSyncError) console.error(`[OpenSky] meals: Bring! check: ${e.message}`);
      this.lastSyncError = e.message;
    } finally { this.syncing = false; }
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_MEALS_INIT") {
      if (p && p.bringList) this.bringList = p.bringList;
      if (!this.server) this.startKitchen();
      this.pushState();
      return;
    }
    if (n === "OS_MEALS_LOOK") { if (Date.now() - (this.lastLook || 0) > 30000) { this.lastLook = Date.now(); this.syncBring(); } return; }


    if (n === "OS_MEALS_CALL" && p && p.id) {
      this.run(p.op, p.body || {}).then(
        (r) => this.sendSocketNotification("OS_MEALS_RESULT", { id: p.id, ok: true, ...r }),
        (e) => this.sendSocketNotification("OS_MEALS_RESULT", { id: p.id, ok: false, error: e.message })
      );
    }
  },

  async run(op, body) {
    if (op === "bring") {
      let items = meals.toBuy(body.weekStart);
      // only the ones picked (keys); none given = everything still to buy
      if (Array.isArray(body.keys)) { const want = new Set(body.keys.map(String)); items = items.filter((it) => want.has(it.key)); }
      if (!items.length) throw new Error(osT("Pick at least one item"));
      const r = await bring.add(items, this.bringList);
      meals.markSent(body.weekStart, items);   // bought there → ticked here (syncBring)
      console.log(`[OpenSky] meals: ${r.count} items sent to Bring!`);
      return { sent: r };

    }
    return { state: meals.change(op, body) };
  },

  addresses() {
    const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
    return { ips, host: `${os.hostname()}.local` };
  },
  kitchenUrls() { const { ips, host } = this.addresses(); return [...ips.map((ip) => `http://${ip}:${this.port}`), `http://${host}:${this.port}`]; },

  pushState() {
    let state;
    try { state = meals.state(); } catch (e) { return; }
    this.sendSocketNotification("OS_MEALS_STATE", { state, kitchen: { urls: this.server ? this.kitchenUrls() : [] }, bring: bring.configured() });
  },

  /* ---------------- the kitchen page ---------------- */
  startKitchen() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      console.error(`[OpenSky] kitchen page: ${e.message}`);
      this.send(res, 500, { error: osT("Something went wrong on the Pi") });
    }));
    this.server.on("error", (e) => {
      console.error(`[OpenSky] kitchen page: ${e.code === "EADDRINUSE" ? `port ${this.port} is busy — set another in opensky.json → meals.kitchenPort` : e.message}`);
      this.server = null;
      this.pushState();
    });
    this.server.listen(this.port, "0.0.0.0", () => { console.log(`[OpenSky] kitchen page on port ${this.port}`); this.pushState(); });
  },

  send(res, status, body, headers = {}) {
    const base = {
      "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
    };
    if (Buffer.isBuffer(body) || typeof body === "string") { res.writeHead(status, { ...base, ...headers }); return res.end(body); }
    res.writeHead(status, { ...base, "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  },

  hostOk(req) {
    const h = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    const { ips, host } = this.addresses();
    return [...ips, host.toLowerCase(), "localhost", "127.0.0.1", os.hostname().toLowerCase()].includes(h);
  },

  body(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error(osT("That's too big"))); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { resolve({}); } });
      req.on("error", reject);
    });
  },

  async handle(req, res) {
    if (!this.hostOk(req)) return this.send(res, 421, { error: osT("Wrong address") });
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      let body = fs.readFileSync(file);
      // the translations, set to opensky.json's language
      if (url.pathname === "/i18n.js") body = `${body}\nwindow.OpenSkyI18n.setLanguage(${JSON.stringify(require(file).language())});\n`;
      return this.send(res, 200, body, { "Content-Type": type });
    }
    if (!url.pathname.startsWith("/api/")) return this.send(res, 404, { error: osT("Not found") });
    if (req.method === "POST" && req.headers["x-opensky"] !== "1") return this.send(res, 403, { error: osT("Refused") });
    if (url.pathname === "/api/state" && req.method === "GET") {
      // someone looks at the list: a fresh look at Bring! too (at most every 30 s)
      if (Date.now() - (this.lastLook || 0) > 30000) { this.lastLook = Date.now(); this.syncBring(); }
      return this.send(res, 200, { ...meals.state(), bring: bring.configured() });
    }

    if (url.pathname === "/api/change" && req.method === "POST") {
      const { op, body } = await this.body(req);
      if (op === "bring") return this.send(res, 400, { error: osT("Unknown change") });
      try { return this.send(res, 200, await this.run(String(op || ""), body || {})); }
      catch (e) { return this.send(res, 400, { error: e.message }); }
    }
    if (url.pathname === "/api/bring" && req.method === "POST") {
      const { weekStart, keys } = await this.body(req);
      try { return this.send(res, 200, await this.run("bring", { weekStart, keys: Array.isArray(keys) ? keys.slice(0, 300) : undefined })); }
      catch (e) { return this.send(res, 502, { error: e.message }); }
    }
    return this.send(res, 404, { error: osT("Not found") });
  },

  stop() { if (this.server) this.server.close(); }
});
