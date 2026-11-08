/* MMM-OpenSky-Embed — a page that shows a web page: a Home Assistant dashboard, a camera, a family website…
 * One instance per embed page (config.js makes them from opensky.json → embeds and pages).
 * - Without a PIN: the page loads the first time it's shown and stays loaded (logins and live views keep going).
 * - With a PIN (secrets.json): a keypad first, EVERY time. Leaving the page, the auto-return to Home or the screen
 *   going to sleep lock it again and remove the page from the screen and memory. The address only reaches the
 *   page after the right PIN (the node helper checks it).
 * Small Back / Reload buttons in the corner; a friendly card when the page can't load.
 */
Module.register("MMM-OpenSky-Embed", {
  defaults: {
    key: "smarthome",
    title: "Smart Home",
    url: null,          // public address (opensky.json); a private one or a PIN page's lives in secrets.json
    locked: false,      // true when a PIN is set (config.js knows from secrets.json, never the PIN itself)
    pinLength: 4,
    zoom: 1             // e.g. 0.8 to fit more of a busy dashboard
  },

  getScripts() { return ["modules/opensky-lib/client/i18n.js"]; },

  getStyles() { return ["MMM-OpenSky-Embed.css"]; },

  start() {
    this.visible = false;
    this.unlocked = false;
    this.entered = "";
    this.url = null;
    this.state = "idle";   // idle | locked | loading | open | error
    document.addEventListener("keydown", (e) => {
      if (!this.visible || this.state !== "locked" || e.ctrlKey || e.metaKey || e.altKey) return;
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
      if (/^[0-9]$/.test(e.key)) this.press(e.key);
      else if (e.key === "Backspace") this.press("back");
    });
  },

  getDom() {
    if (!this.root) {
      this.root = document.createElement("div");
      this.root.className = "oe-root";
      this.render();
    }
    return this.root;
  },

  // MMM-pages: shown / hidden
  resume() {
    this.visible = true;
    if (this.config.locked) { this.lock(); return; }
    if (!this.view && this.state !== "loading") { this.state = "loading"; this.render(); this.sendSocketNotification("OS_EMBED_INIT", { key: this.config.key, url: this.config.url }); }
  },
  suspend() { this.visible = false; if (this.config.locked) this.lock(); },

  notificationReceived(n, p) {
    // the first page is never "resumed" by MMM-pages: start it once everything is on screen
    if (n === "DOM_OBJECTS_CREATED") { setTimeout(() => { if (!this.hidden && !this.visible) this.resume(); }, 500); return; }
    if (!this.config.locked) return;
    if (n === "OPENSKY_IDLE_RESET" || (n === "OPENSKY_SCREEN_SLEEP" && p)) this.lock();
  },

  socketNotificationReceived(n, p) {
    if (!p || p.key !== this.config.key) return;
    if (n === "OS_EMBED_OPEN") {
      this.busy = false;
      if (this.config.locked && !this.visible) return;   // left the page while the PIN was checked → stay locked
      this.open(p.url);
    } else if (n === "OS_EMBED_LOCKED") {
      this.lock();
    } else if (n === "OS_EMBED_ERROR") {
      this.showError(p.message);
    } else if (n === "OS_EMBED_DENIED") {
      this.busy = false;
      this.entered = "";
      this.renderDots();
      if (p.error) return this.message(p.error, true);
      this.root.querySelector(".oe-dots")?.classList.remove("shake");
      void this.root.offsetWidth;
      this.root.querySelector(".oe-dots")?.classList.add("shake");
      if (p.wait) this.pause(p.wait);
      else this.message(osT("Wrong PIN — try again"), true);
    }
  },

  /* ---------------- the page ---------------- */
  open(url) {
    this.url = url;
    this.state = "open";
    this.unlocked = true;
    this.root.innerHTML = `
      <div class="oe-frame"></div>
      <div class="oe-tools">
        <button class="oe-tool oe-back" aria-label="${osT("Back")}"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <button class="oe-tool oe-reload" aria-label="${osT("Reload")}"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg></button>
        ${this.config.locked ? `<button class="oe-tool oe-lockbtn" aria-label="${osT("Lock")}"><svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="11" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg></button>` : ""}
      </div>`;
    const v = document.createElement("webview");
    v.className = "oe-view";
    v.setAttribute("src", url);
    v.addEventListener("did-fail-load", (e) => {
      if (e.isMainFrame === false || e.errorCode === -3) return;   // -3 = aborted (normal while navigating)
      this.showError(osT("Couldn't open {page}. Is it switched on and on the same Wi-Fi?", { page: this.config.title }));
    });
    v.addEventListener("dom-ready", () => {
      if (this.config.zoom && this.config.zoom !== 1) v.setZoomFactor(this.config.zoom);
      // Touches inside the page never reach the screen, so the idle return to Home would kick someone out mid-use.
      // The page reports activity through its console (at most every 5 s), which the screen can hear.
      v.executeJavaScript(`(() => { if (window.__osTouch) return; window.__osTouch = 1; let last = 0;
        const ping = () => { const n = Date.now(); if (n - last > 5000) { last = n; console.debug("__opensky_activity__"); } };
        ["pointerdown", "touchstart", "keydown", "wheel"].forEach((t) => addEventListener(t, ping, { capture: true, passive: true })); })()`).catch(() => {});
    });
    v.addEventListener("console-message", (e) => {
      if (String(e.message || "").includes("__opensky_activity__")) this.sendNotification("OPENSKY_ACTIVITY");
    });
    this.view = v;
    this.root.querySelector(".oe-frame").appendChild(v);
    this.root.querySelector(".oe-back").onclick = () => { if (v.canGoBack && v.canGoBack()) v.goBack(); };
    this.root.querySelector(".oe-reload").onclick = () => v.reload();
    const lockBtn = this.root.querySelector(".oe-lockbtn");
    if (lockBtn) lockBtn.onclick = () => this.lock();
  },

  showError(message) {
    this.state = "error";
    if (this.view) { this.view.remove(); this.view = null; }
    this.root.innerHTML = `
      <div class="oe-card oe-error">
        <div class="oe-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg></div>
        <div class="oe-title"></div><div class="oe-sub"></div>
        <button class="oe-btn">${osT("Try again")}</button>
      </div>`;
    this.root.querySelector(".oe-title").textContent = this.config.title;
    this.root.querySelector(".oe-sub").textContent = message;
    this.root.querySelector(".oe-btn").onclick = () => {
      if (this.config.locked) this.lock();
      else { this.state = "loading"; this.render(); this.sendSocketNotification("OS_EMBED_INIT", { key: this.config.key, url: this.config.url }); }
    };
  },

  /* ---------------- PIN ---------------- */
  lock() {
    this.unlocked = false;
    this.entered = "";
    this.busy = false;
    this.url = null;
    clearInterval(this._pauseTimer);
    this.pausedLeft = 0;
    if (this.view) { this.view.remove(); this.view = null; }   // the page is gone from the screen and memory
    this.state = "locked";
    this.render();
  },

  press(k) {
    if (this.unlocked || this.busy || this.pausedLeft > 0) return;
    if (k === "back") this.entered = this.entered.slice(0, -1);
    else if (this.entered.length < this.config.pinLength) this.entered += k;
    this.message("");
    this.renderDots();
    if (this.entered.length === this.config.pinLength) {
      this.busy = true;
      this.sendSocketNotification("OS_EMBED_UNLOCK", { key: this.config.key, pin: this.entered });
      clearTimeout(this._busyTimer);
      this._busyTimer = setTimeout(() => { if (this.busy) { this.busy = false; this.entered = ""; this.renderDots(); this.message(osT("Couldn't check the PIN — try again"), true); } }, 6000);
    }
  },

  pause(secs) {
    this.pausedLeft = secs;
    const tick = () => {
      if (this.pausedLeft <= 0) { clearInterval(this._pauseTimer); this.message(""); this.root.classList.remove("oe-paused"); return; }
      this.message(osT("Too many tries — wait {n} s", { n: this.pausedLeft }), true);
      this.pausedLeft--;
    };
    this.root.classList.add("oe-paused");
    clearInterval(this._pauseTimer);
    tick();
    this._pauseTimer = setInterval(tick, 1000);
  },

  render() {
    const r = this.root;
    if (!r || this.state === "open" || this.state === "error") return;
    r.classList.remove("oe-paused");
    if (this.state !== "locked") { r.innerHTML = `<div class="oe-card"><div class="oe-sub">${osT("Loading {page}…", { page: this.config.title.replace(/[<>&]/g, "") })}</div></div>`; return; }
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];
    r.innerHTML = `
      <div class="oe-card">
        <div class="oe-icon"><svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="11" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg></div>
        <div class="oe-title"></div>
        <div class="oe-sub">${osT("Enter the PIN")}</div>
        <div class="oe-dots"></div>
        <div class="oe-msg" aria-live="polite"></div>
        <div class="oe-pad">${keys.map((k) => k === "" ? "<span></span>"
          : `<button class="oe-key${k === "back" ? " oe-del" : ""}" data-k="${k}" aria-label="${k === "back" ? osT("Delete") : k}"
>${k === "back"
            ? `<svg viewBox="0 0 24 24"><path d="M21 5H9l-6 7 6 7h12z"/><path d="M17 9l-6 6M11 9l6 6"/></svg>` : k}</button>`).join("")}</div>
      </div>`;
    r.querySelector(".oe-title").textContent = this.config.title;
    r.querySelectorAll(".oe-key").forEach((b) => { b.onclick = () => this.press(b.dataset.k); });
    this.renderDots();
  },

  renderDots() {
    const d = this.root && this.root.querySelector(".oe-dots");
    if (d) d.innerHTML = Array.from({ length: this.config.pinLength }, (_, i) => `<i class="${i < this.entered.length ? "on" : ""}"></i>`).join("");
  },

  message(text, bad = false) {
    const m = this.root && this.root.querySelector(".oe-msg");
    if (!m) return;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }
});
