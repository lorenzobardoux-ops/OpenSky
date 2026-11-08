/* MMM-OpenSky-Sidebar — the full-height navigation strip on the left.
 *
 * - One tile per page, in the order of `pages` in opensky.json (config.js builds `config.pages`).
 *   The Home tile shows the family's initial as a badge.
 * - Sleep: asks the OpenSky screen service to turn the screen off when one is configured (`screenServiceUrl`);
 *   otherwise it shows a black "soft sleep" cover that the next touch removes. Works on any screen.
 * - Auto-return: after `idleReturnMinutes` without a touch, popups close, views reset and it goes back to the
 *   first page (not while a timer is running or ringing on the Timer page). 0 = off.
 *
 * Notifications sent: PAGE_CHANGED (MMM-pages), OPENSKY_IDLE_RESET, OPENSKY_SCREEN_SLEEP (true/false),
 * OPENSKY_SETTINGS_OPEN, HIDE_KEYBOARD.   Received: PAGE_CHANGED, OPENSKY_WAKE (e.g. a timer finished),
 * OPENSKY_SLEEP (e.g. the Settings sleep schedule), OPENSKY_ACTIVITY (a touch inside an embedded page),
 * OPENSKY_TOAST { message, type: "error" | "success" | "info" } (the shared toast; the sidebar is always on screen).
 */
Module.register("MMM-OpenSky-Sidebar", {
  defaults: {
    pages: [],                   // [{ key, label, icon, index }] — built by config.js from opensky.json
    familyInitial: "H",
    screenServiceUrl: null,      // e.g. "http://127.0.0.1:5000" when the OpenSky screen service is installed
    idleReturnMinutes: 5,
    showSettings: false,         // true once a settings page/module is installed
    accent: null,                // opensky.json → look.accent: a palette color name ("teal") or "#rrggbb"; null = peach
    scale: "auto",               // opensky.json → look.scale: "auto" fits the 1920×1080 design to the screen; or a number (e.g. 1.2)
    ui: { width: 92, gap: 8, tile: 76, icon: 28, font: 12 }
  },

  getStyles() { return ["MMM-OpenSky-Sidebar.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js"]; },

  start() {
    this.activeIndex = 0;        // MMM-pages starts on its first page
    this.lastActivity = Date.now();
    this.idleHandled = false;
    const touch = () => { this.lastActivity = Date.now(); this.idleHandled = false; };
    ["pointerdown", "touchstart", "keydown", "wheel"].forEach((ev) => document.addEventListener(ev, touch, { capture: true, passive: true }));
    if (this.config.idleReturnMinutes > 0) setInterval(() => this.checkIdle(), 10 * 1000);
    document.documentElement.style.setProperty("--os-side-width", `${this.config.ui.width}px`);
    this.applyAccent(this.config.accent);
    this.applyScale();
    window.addEventListener("resize", () => this.applyScale());
  },

  // OpenSky is laid out for 1920×1080; other screens get the same layout scaled to fit (a 1280×720 screen at 2/3,
  // a 4K screen at 2×), so nothing is cut off or tiny. look.scale overrides it.
  applyScale() {
    const fixed = Number(this.config.scale);
    const auto = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    const z = fixed > 0 ? fixed : Math.max(0.5, Math.min(2.5, auto));
    document.body.style.zoom = Math.abs(z - 1) < 0.01 ? "" : String(z);
    document.documentElement.style.setProperty("--os-zoom", String(z));
  },

  // The accent color for every module (css/opensky.css defines the default peach tones)
  applyAccent(accent) {
    const pal = window.OpenSkyEventColors && window.OpenSkyEventColors.PALETTE;
    const a = /^#[0-9a-f]{6}$/i.test(accent || "") ? accent : (pal && pal[accent] ? pal[accent][1] : null);
    if (!a) return;
    const root = document.documentElement.style, mix = (pct, other) => `color-mix(in srgb, ${a} ${pct}%, ${other})`;
    root.setProperty("--os-accent", a);
    root.setProperty("--os-accent-mid", mix(70, "white"));
    root.setProperty("--os-accent-light", mix(60, "white"));
    root.setProperty("--os-accent-soft", mix(28, "white"));
    root.setProperty("--os-accent-tint", mix(9, "white"));
    root.setProperty("--os-accent-dark", mix(78, "black"));
  },

  notificationReceived(n, payload) {
    if (n === "PAGE_CHANGED" && Number.isInteger(payload)) {
      this.activeIndex = payload;
      this.syncActive();
    } else if (n === "OPENSKY_WAKE") {
      this.wake();
    } else if (n === "OPENSKY_ACTIVITY") {   // a touch inside an embedded page (MMM-OpenSky-Embed)
      this.lastActivity = Date.now(); this.idleHandled = false;
    } else if (n === "OPENSKY_SLEEP") {
      if (!this.isAsleep()) this.sleep();
    } else if (n === "OPENSKY_TOAST" && payload && payload.message) {
      window.OpenSkyToast(payload.message, payload.type || "info");
    }
  },

  /* ---------------- auto-return ---------------- */
  timerBusy() {
    const t = MM.getModules().withClass("MMM-OpenSky-Timer")[0];
    return !!(t && Array.isArray(t.timers) && t.timers.length);
  },

  async checkIdle() {
    const limit = this.config.idleReturnMinutes * 60 * 1000;
    if (this.idleHandled || Date.now() - this.lastActivity < limit) return;
    // Touches inside embedded pages (<webview>) never reach this page; the screen service sees every input device
    if (this.config.screenServiceUrl) {
      try {
        const r = await fetch(`${this.config.screenServiceUrl}/idle`, { signal: AbortSignal.timeout(3000) });
        const secs = (await r.json()).idle_seconds;
        if (typeof secs === "number") this.lastActivity = Math.max(this.lastActivity, Date.now() - secs * 1000);
      } catch (e) { /* not available: page events only */ }
    }
    if (this.idleHandled || Date.now() - this.lastActivity < limit) return;
    this.idleHandled = true;
    const timerPage = this.config.pages.find((p) => p.key === "timer");
    if (timerPage && this.activeIndex === timerPage.index && this.timerBusy()) return;
    Log.info(`${this.name}: idle, returning to the first page`);
    this.sendNotification("OPENSKY_IDLE_RESET");
    this.sendNotification("HIDE_KEYBOARD");
    if (this.activeIndex !== 0) this.goPage(0);
  },

  /* ---------------- DOM ---------------- */
  getDom() {
    const ui = this.config.ui;
    const wrap = document.createElement("div");
    wrap.className = "os-side-wrap";
    wrap.style.setProperty("--tile-gap", `${ui.gap}px`);
    wrap.style.setProperty("--tile-size", `${ui.tile}px`);
    wrap.style.setProperty("--icon-size", `${ui.icon}px`);
    wrap.style.setProperty("--label-size", `${ui.font}px`);
    wrap.innerHTML = `<div class="os-side-track"></div><div class="os-side-col"></div>`;
    const col = wrap.querySelector(".os-side-col");

    this.config.pages.forEach((p) => {
      const icon = p.key === "home" ? `<span class="os-badge">${this.escape(this.config.familyInitial)}</span>` : this.icon(p.icon || p.key);
      col.appendChild(this.tile(`page-${p.key}`, icon, p.label, () => this.goPage(p.index)));
    });
    const spacer = document.createElement("div");
    spacer.className = "os-side-spacer";
    col.appendChild(spacer);
    col.appendChild(this.tile("sleep", this.icon("sleep"), osT("Sleep"), () => this.sleep(), true));
    if (this.config.showSettings) col.appendChild(this.tile("settings", this.icon("settings"), osT("Settings"),
 () => this.sendNotification("OPENSKY_SETTINGS_OPEN"), true));
    this.col = col;
    this.syncActive();
    return wrap;
  },

  tile(key, iconHtml, label, handler, utility = false) {
    const b = document.createElement("button");
    b.className = `os-tile os-${key}` + (utility ? " os-utility" : "");
    b.dataset.key = key;
    b.innerHTML = `<div class="os-icon">${iconHtml}</div><div class="os-label">${this.escape(label)}</div>`;
    b.onclick = handler;
    return b;
  },

  syncActive() {
    if (!this.col) return;
    const page = this.config.pages.find((p) => p.index === this.activeIndex);
    this.col.querySelectorAll(".os-tile").forEach((el) => el.classList.toggle("active", !!page && el.dataset.key === `page-${page.key}`));
  },

  goPage(index) {
    this.activeIndex = index;
    this.sendNotification("PAGE_CHANGED", index);
    this.syncActive();
  },

  /* ---------------- sleep / wake ---------------- */
  async sleep() {
    this.sendNotification("HIDE_KEYBOARD");
    if (this.config.screenServiceUrl) {
      try {
        // the screen service has no CORS headers; a no-cors request still runs it
        await fetch(`${this.config.screenServiceUrl}/monitor/off`, { mode: "no-cors", signal: AbortSignal.timeout(3000) });
        this.sendNotification("OPENSKY_SCREEN_SLEEP", true);
        return;
      } catch (e) { /* fall back to the soft-sleep cover */ }
    }
    this.softSleep(true);
  },

  // Black cover over everything; the waking touch is swallowed so it doesn't also press a button
  softSleep(on) {
    if (!this.cover) {
      const c = document.createElement("div");
      c.className = "os-sleep-cover";
      c.hidden = true;
      const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
      ["pointerdown", "pointerup", "click", "touchstart", "touchend", "mousedown", "mouseup"].forEach((ev) => c.addEventListener(ev, swallow, true));
      c.addEventListener("pointerup", () => this.wake(), true);
      document.addEventListener("keydown", () => { if (!c.hidden) this.wake(); }, true);
      document.body.appendChild(c);
      this.cover = c;
    }
    if (on) { this.cover.hidden = false; this.sendNotification("OPENSKY_SCREEN_SLEEP", true); }
  },

  isAsleep() { return !!(this.cover && !this.cover.hidden); },
  idleSeconds() { return (Date.now() - this.lastActivity) / 1000; },

  wake() {
    if (!this.cover || this.cover.hidden) return;
    // keep the cover a moment so the tail of the waking touch is swallowed too
    setTimeout(() => { this.cover.hidden = true; }, 400);
    this.lastActivity = Date.now();
    this.sendNotification("OPENSKY_SCREEN_SLEEP", false);
  },

  /* ---------------- helpers ---------------- */
  escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); },

  // One consistent icon set: 24×24, 2 px round strokes (Lucide-style), colored by CSS
  // the shared icon set (lib/client/opensky-client.js → OpenSkyIcons): pages, web pages, Sleep, Settings
  icon(name) { return window.OpenSkyIcons.svg(name); }
});
