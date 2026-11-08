/* MMM-OpenSky-Setup — "Set up from your phone" on the screen.
 * - The first time OpenSky starts: a welcome card offering phone setup (once; "Not now" is remembered).
 * - Settings → "Set up from your phone" (OPENSKY_SETUP_OPEN): a card with a QR code, the address and a 6-digit
 *   pairing code. It follows along: phone connected → saved → done, then closes. The web server behind it
 *   (node helper) only runs while this card is open, or while a paired phone is still busy with it.
 */
Module.register("MMM-OpenSky-Setup", {
  getStyles() { return ["MMM-OpenSky-Setup.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/vendor/qrcode.js"]; },

  start() {
    this.mode = null;          // null | "welcome" | "pair"
    this.info = null;          // { urls, code, expiresAt }
    this.status = "waiting";   // waiting | paired | saved | closed | error
    this.sendSocketNotification("OS_SETUP_INIT");
    setInterval(() => this.tick(), 1000);
  },

  getDom() { return document.createElement("div"); },   // the card lives on <body>

  notificationReceived(n) {
    if (n === "OPENSKY_SETUP_OPEN") this.openPair();
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_SETUP_WELCOME" && p && p.show && !this.mode) { this.mode = "welcome"; this.render(); }
    else if (n === "OS_SETUP_READY") { this.info = p; if (this.status === "error" || this.status === "closed") this.status = "waiting"; if (this.mode === "pair") this.render(); }
    else if (n === "OS_SETUP_PAIRED") { this.status = "paired"; this.renderStatus(); }
    else if (n === "OS_SETUP_SAVED") { this.status = "saved"; this.renderStatus(); }
    else if (n === "OS_SETUP_STOPPED") {
      if (this.mode !== "pair") return;
      const finished = /finished/.test(p.reason || "");
      // (failed: the reason is in the screen's language, so it isn't matched as text)
      this.status = finished ? "done" : (p.failed || /busy|start/i.test(p.reason || "")) ? "error" : "closed";

      this.errorText = p.reason;
      this.renderStatus();
      if (finished) setTimeout(() => this.close(false), 4000);
    }
  },

  openPair() {
    this.mode = "pair";
    this.status = "waiting";
    this.info = null;
    this.render();
    this.sendSocketNotification("OS_SETUP_START");
  },

  close(stop = true) {
    if (stop) this.sendSocketNotification("OS_SETUP_STOP");
    this.mode = null;
    if (this.host) this.host.innerHTML = "";
  },

  /* ---------------- drawing ---------------- */
  host_() {
    if (!this.host) { this.host = document.createElement("div"); this.host.className = "osu-host"; document.body.appendChild(this.host); }
    return this.host;
  },

  phoneIcon: `<svg viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>`,

  render() {
    const h = this.host_();
    if (!this.mode) { h.innerHTML = ""; return; }
    if (this.mode === "welcome") {
      h.innerHTML = `
        <div class="osu-overlay">
          <div class="osu-card osu-welcome">
            <img class="osu-brand" src="modules/opensky-lib/client/assets/opensky-icon.png" alt="">
            <h2>${osT("Welcome to OpenSky!")}</h2>
            <p>${osT("Add your calendars, lists, photos and more from your phone — it takes a couple of minutes.")}</p>
            <div class="osu-actions">
              <button class="osu-btn osu-later">${osT("Not now")}</button>
              <button class="osu-btn osu-primary osu-go">${osT("Set up on my phone")}</button>
            </div>
            <div class="osu-foot">${osT("You can always find this later in Settings.")}</div>
          </div>
        </div>`;
      h.querySelector(".osu-go").onclick = () => this.openPair();
      h.querySelector(".osu-later").onclick = () => this.close(true);
      return;
    }
    const info = this.info;
    h.innerHTML = `
      <div class="osu-overlay">
        <div class="osu-card osu-pair">
          <button class="osu-x" aria-label="${osT("Close")}">×</button>
          <div class="osu-left">
            <div class="osu-qr">${info ? this.qr(info.urls[0]) : `<div class="osu-qr-wait">…</div>`}</div>
            <div class="osu-scan">${osT("Scan with your phone's camera")}</div>
          </div>
          <div class="osu-right">
            <h2>${osT("Set up from your phone")}</h2>
            <ol class="osu-steps">
              <li>${osT("Join the same Wi-Fi as this screen.")}</li>
              <li>${osT("Scan the code, or open {address}", { address: `<b class="osu-url"></b>` })}</li>
              <li>${osT("Enter this pairing code:")}</li>
            </ol>
            <div class="osu-code">${info ? [...info.code].map((d, i) => `<span>${d}</span>${i === 2 ? `<i></i>` : ""}`).join("") : ""}</div>
            <div class="osu-expiry"></div>
            <div class="osu-status"></div>
            <div class="osu-actions">
              <button class="osu-btn osu-newcode">${osT("New code")}</button>
              <button class="osu-btn osu-close">${osT("Close")}</button>
            </div>
          </div>
        </div>
      </div>`;
    if (info) h.querySelector(".osu-url").textContent = info.urls[0].replace(/^http:\/\//, "");
    h.querySelector(".osu-x").onclick = () => this.close(true);
    h.querySelector(".osu-close").onclick = () => this.close(true);
    h.querySelector(".osu-newcode").onclick = () => this.sendSocketNotification("OS_SETUP_NEWCODE");
    this.renderStatus();
    this.tick();
  },

  qr(text) {
    try {
      const q = qrcode(0, "M");   // vendor/qrcode.js (MIT, Kazuhiko Arase)
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch (e) { return `<div class="osu-qr-wait">${osT("QR unavailable")}</div>`; }
  },

  renderStatus() {
    const el = this.host && this.host.querySelector(".osu-status");
    if (!el) return;
    const text = {
      waiting: osT("Waiting for your phone…"),
      paired: osT("Phone connected — carry on there"),
      saved: osT("Saved! Tap Done on your phone when you're finished"),
      done: osT("All done — OpenSky is restarting with your settings"),
      closed: osT("Setup has closed"),
      error: osT("Couldn't start phone setup ({error})", { error: this.errorText || osT("error") })
    }[this.status];
    el.className = `osu-status is-${this.status}`;
    el.innerHTML = `<i></i><span></span>`;
    el.querySelector("span").textContent = text;
  },

  tick() {
    const el = this.host && this.host.querySelector(".osu-expiry");
    if (!el || !this.info) return;
    const s = Math.max(0, Math.round((this.info.expiresAt - Date.now()) / 1000));
    el.textContent = this.status !== "waiting" ? "" : s > 0 ? osT("The code works for {time}", { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` }) : osT("This code has expired — tap New code");

  }
});
