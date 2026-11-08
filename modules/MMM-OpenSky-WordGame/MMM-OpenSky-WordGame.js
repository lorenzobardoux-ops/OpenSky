/* MMM-OpenSky-WordGame — the family's daily five-letter word game (one shared board per day).
 * The answer stays on the server (node_helper.js checks every guess); the page only gets colored patterns.
 * Board + big touch keyboard (the wireless keyboard works too), tile flip animation, family stats card,
 * countdown to the next puzzle. New puzzle at midnight. */
Module.register("MMM-OpenSky-WordGame", {
  defaults: {
    source: "nyt",      // "nyt" = the New York Times' daily word (OpenSky's own if NYT can't be reached) | "opensky"
    extraWords: []      // more accepted guesses (opensky.json → wordgame.extraWords)
  },

  ROWS: [["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"], ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["enter", "z", "x", "c", "v", "b", "n", "m", "back"]],
  PRAISE: () => [osT("Genius!"), osT("Magnificent!"), osT("Impressive!"), osT("Splendid!"), osT("Great!"), osT("Phew!")],

  getScripts() { return ["modules/opensky-lib/client/i18n.js"]; },

  getStyles() { return ["MMM-OpenSky-WordGame.css"]; },

  start() {
    this.state = null;
    this.typed = "";
    this.busy = false;
    this.revealRow = -1;             // row currently flipping (animation)
    this.sendSocketNotification("OS_WG_INIT", { source: this.config.source, extraWords: this.config.extraWords });
    this.lastDate = this.ymd();
    setInterval(() => {              // midnight → new puzzle; countdown tick
      if (this.ymd() !== this.lastDate) { this.lastDate = this.ymd(); this.typed = ""; this.sendSocketNotification("OS_WG_SYNC"); }
      this.tickCountdown();
    }, 1000);
    document.addEventListener("keydown", (e) => {
      if (!this.visible || e.ctrlKey || e.metaKey || e.altKey) return;
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
      if (/^[a-zA-Z]$/.test(e.key)) this.press(e.key.toLowerCase());
      else if (e.key === "Enter") this.press("enter");
      else if (e.key === "Backspace") this.press("back");
    });
  },

  ymd(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; },

  suspend() { this.visible = false; },
  resume() { this.visible = true; this.sendSocketNotification("OS_WG_SYNC"); },

  notificationReceived(n) {
    if (n === "OPENSKY_IDLE_RESET") { this.typed = ""; this.render(); }
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_WG_STATE" || n === "OS_WG_ERROR") clearTimeout(this._busyTimer);
    if (n === "OS_WG_STATE") {
      const prevCount = this.state ? this.state.guesses.length : 0;
      const sameDay = this.state && this.state.date === p.date;
      this.state = p;
      this.busy = false;
      if (sameDay && p.guesses.length > prevCount) { this.typed = ""; this.revealRow = p.guesses.length - 1; }
      else this.revealRow = -1;
      this.render();
      if (this.revealRow >= 0) setTimeout(() => { this.revealRow = -1; this.renderKeys(); this.renderStats(); }, 5 * 280 + 350);
    } else if (n === "OS_WG_ERROR") {
      this.busy = false;
      this.toast(p.message);
      const row = this.root && this.root.querySelector(`.wg-row[data-r="${this.state.guesses.length}"]`);
      if (row) { row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake"); }
    }
  },

  press(k) {
    const s = this.state;
    if (!s || s.status !== "playing" || this.busy || this.revealRow >= 0) return;
    if (k === "back") this.typed = this.typed.slice(0, -1);
    else if (k === "enter") {
      if (this.typed.length < 5) { this.toast(osT("Not enough letters")); this.shakeCurrent(); return; }
      this.busy = true;                                    // blocks a double-tapped Enter
      this.sendSocketNotification("OS_WG_GUESS", { word: this.typed, date: s.date });
      // If no answer comes back (connection blip), unlock instead of freezing the keyboard
      clearTimeout(this._busyTimer);
      this._busyTimer = setTimeout(() => { if (this.busy) { this.busy = false; this.toast(osT("Couldn't check that — try again")); this.sendSocketNotification("OS_WG_SYNC"); } }, 8000);
      return;
    } else if (this.typed.length < 5) this.typed += k;
    this.renderBoard();
  },

  shakeCurrent() {
    const row = this.root.querySelector(`.wg-row[data-r="${this.state.guesses.length}"]`);
    if (row) { row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake"); }
  },

  /* ======================= rendering ======================= */
  getDom() {
    if (!this.root) { this.root = document.createElement("div"); this.root.className = "wg-root"; }
    setTimeout(() => this.render(), 0);
    return this.root;
  },

  render() {
    const r = this.root;
    if (!r) return;
    if (!this.state) { r.innerHTML = `<div class="wg-loading">${osT("Loading today's puzzle…")}</div>`; return; }
    const s = this.state;
    const day = new Date(s.date + "T12:00:00").toLocaleDateString(config.locale || "en-US", { weekday: "long", month: "long", day: "numeric" });
    r.innerHTML = `
      <div class="wg-head">
        <div class="wg-title"><span class="wg-logo"><i class="g">W</i></span>${osT("Word Game")}</div>
        <div class="wg-sub">${s.number != null ? `#${s.number} · ` : ""}${day} · ${osT("today's family puzzle")}${s.backup ? " " + osT("(NYT's word unavailable — OpenSky's word)") : ""}</div>
      </div>
      <div class="wg-body">
        <div class="wg-play">
          <div class="wg-toast" hidden></div>
          <div class="wg-board"></div>
          <div class="wg-keys"></div>
        </div>
        <aside class="wg-side"></aside>
      </div>`;
    this.renderBoard();
    this.renderKeys();
    this.renderStats();
  },

  renderBoard() {
    const s = this.state, b = this.root && this.root.querySelector(".wg-board");
    if (!b) return;
    let html = "";
    for (let r = 0; r < 6; r++) {
      const g = s.guesses[r];
      const word = g ? g.word : (r === s.guesses.length && s.status === "playing" ? this.typed : "");
      const flipping = r === this.revealRow, won = s.status === "won" && r === s.guesses.length - 1 && this.revealRow < 0;
      html += `<div class="wg-row${won ? " win" : ""}" data-r="${r}">`;
      for (let c = 0; c < 5; c++) {
        const ch = word[c] || "";
        const st = g ? ({ g: "correct", y: "present", b: "absent" })[g.pattern[c]] : "";
        html += `<div class="wg-tile ${ch ? "filled" : ""} ${st && !flipping ? st : ""} ${flipping ? "flip" : ""}"
          ${flipping ? `style="--d:${c * 280}ms" data-final="${st}"` : ""} ${won ? `style="--d:${c * 90}ms"` : ""}>${ch}</div>`;
      }
      html += "</div>";
    }
    b.innerHTML = html;
    // flip: color each tile at the middle of its own flip
    if (this.revealRow >= 0) {
      b.querySelectorAll(".wg-tile.flip").forEach((t, c) => setTimeout(() => t.classList.add(t.dataset.final), c * 280 + 175));
    }
  },

  keyStates() {
    const rank = { correct: 3, present: 2, absent: 1 }, out = {};
    this.state.guesses.forEach((g, r) => {
      if (r === this.revealRow) return;          // reveal the keyboard after the tiles flip
      [...g.word].forEach((ch, i) => {
        const st = ({ g: "correct", y: "present", b: "absent" })[g.pattern[i]];
        if (!out[ch] || rank[st] > rank[out[ch]]) out[ch] = st;
      });
    });
    return out;
  },

  renderKeys() {
    const k = this.root && this.root.querySelector(".wg-keys");
    if (!k || !this.state) return;
    const st = this.keyStates();
    k.innerHTML = this.ROWS.map((row) => `<div class="wg-krow">${row.map((key) => {
      const label = key === "enter" ? osT("Enter") : key === "back" ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H9l-6 7 6 7h12z"/><path d="M17 9l-6 6M11 9l6 6"/></svg>` : key;
      return `<button class="wg-key ${key.length > 1 ? "wide" : ""} ${st[key] || ""}" data-k="${key}">${label}</button>`;
    }).join("")}</div>`).join("");
    k.querySelectorAll(".wg-key").forEach((b) => { b.onclick = () => this.press(b.dataset.k); });
  },

  renderStats() {
    const side = this.root && this.root.querySelector(".wg-side");
    if (!side || !this.state) return;
    const s = this.state, st = s.stats, done = s.status !== "playing" && this.revealRow < 0;
    const maxD = Math.max(1, ...st.dist);
    const winPct = st.played ? Math.round((st.won / st.played) * 100) : 0;
    side.innerHTML = `
      <div class="wg-card wg-result ${done ? s.status : "playing"}">
        ${done && s.status === "won" ? `<div class="wg-big">${this.PRAISE()[s.guesses.length - 1]}</div><div class="wg-small">${s.guesses.length === 1 ? osT("Solved in 1 guess") : osT("Solved in {n} guesses", { n: s.guesses.length })}</div>`
        : done ? `<div class="wg-big">${osT("So close!")}</div><div class="wg-small">${osT("The word was {word}", { word: `<b class="wg-answer">${(s.answer || "").toUpperCase()}</b>` })}</div>`
        : `<div class="wg-big">${s.guesses.length ? osT("Guess {n} of 6", { n: s.guesses.length + 1 }) : osT("Today's puzzle")}</div><div class="wg-small">${s.guesses.length ? osT("Keep going — everyone can chip in") : osT("Tap the letters or use the keyboard")}</div>`}
        ${done ? `<div class="wg-next">${osT("Next puzzle in {time}", { time: `<b class="wg-countdown"></b>` })}</div>` : ""}
      </div>
      <div class="wg-card">
        <div class="wg-card-title">${osT("Family stats")}</div>
        <div class="wg-nums">
          <div><b>${st.played}</b><span>${osT("Played")}</span></div>
          <div><b>${winPct}</b><span>${osT("Win %")}</span></div>
          <div><b>${st.streak}</b><span>${osT("Streak")}</span></div>
          <div><b>${st.maxStreak}</b><span>${osT("Best")}</span></div>
        </div>
        <div class="wg-card-title">${osT("Guess distribution")}</div>

        <div class="wg-dist">${st.dist.map((n, i) => `<div class="wg-drow"><span>${i + 1}</span><div class="wg-bar ${done && s.status === "won" && s.guesses.length === i + 1 ? "today" : ""}" style="width:${Math.max(8, (n / maxD) * 100)}%">${n}</div></div>`).join("")}</div>
      </div>`;
    this.tickCountdown();
  },

  tickCountdown() {
    const el = this.root && this.root.querySelector(".wg-countdown");
    if (!el) return;
    const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    el.textContent = `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  },

  toast(msg) {
    const t = this.root && this.root.querySelector(".wg-toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
  }
});
