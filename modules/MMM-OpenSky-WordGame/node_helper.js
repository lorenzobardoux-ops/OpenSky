/* MMM-OpenSky-WordGame node helper — the family's daily five-letter word game (one shared board per day).
 * - Today's word (opensky.json → wordgame.source):
 *     "nyt" (default) — the New York Times' daily Wordle word, fetched here on the Pi; if that fails, OpenSky's own
 *                       word for the day, and NYT is tried again every 10 minutes until someone has guessed;
 *     "opensky"       — the next word in words/answers.txt (a fixed order, one a day, the same on every OpenSky screen).
 *   New puzzle at local midnight.
 * - Guesses are checked HERE: the page never receives the answer until the game is over.
 * - Accepted guesses: words/allowed.txt + opensky.json → wordgame.extraWords.
 * - Board + family stats in config/wordgame.json (next to opensky.json; OPENSKY_WORDGAME overrides).
 * Socket: OS_WG_INIT {extraWords} / OS_WG_SYNC → OS_WG_STATE; OS_WG_GUESS {word, date} → OS_WG_STATE | OS_WG_ERROR {message}
 */
const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const { osT } = require(path.join(__dirname, "..", "..", "lib", "client", "i18n.js"));   // texts in opensky.json's language

const WORDS = path.join(__dirname, "words");
const SETTINGS_DIR = path.dirname(process.env.OPENSKY_SETTINGS || path.join(global.root_path || process.cwd(), "config", "opensky.json"));
const STATE_FILE = process.env.OPENSKY_WORDGAME || path.join(SETTINGS_DIR, "wordgame.json");
const FIRST_DAY = "2026-01-01";   // OpenSky puzzle #1
const NYT = process.env.OPENSKY_NYT_URL || "https://www.nytimes.com/svc/wordle/v2";
const MAX_GUESSES = 6;
const readList = (f) => fs.readFileSync(path.join(WORDS, f), "utf8").split("\n").map((w) => w.trim()).filter((w) => /^[a-z]{5}$/.test(w));

module.exports = NodeHelper.create({
  start() {
    this.answers = readList("answers.txt");
    this.allowed = new Set([...readList("allowed.txt"), ...this.answers]);
    this.source = "nyt";
    this.cached = null;      // today's puzzle { date, number, answer, source, tried }
    this.loading = null;
  },

  ymd(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  },

  // OpenSky's own word for a date (also the backup when NYT can't be reached)
  ownPuzzle(date) {
    const days = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${FIRST_DAY}T12:00:00Z`)) / 86400000);
    const i = ((days % this.answers.length) + this.answers.length) % this.answers.length;
    return { date, number: days + 1, answer: this.answers[i], source: "opensky", tried: Date.now() };
  },

  // Today's puzzle (kept for the day)
  async puzzle(date = this.ymd()) {
    if (this.cached && this.cached.date === date) return this.cached;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let p = null;
      if (this.source === "nyt") {
        try {
          const r = await fetch(`${NYT}/${date}.json`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = await r.json();
          const answer = String(d.solution || "").toLowerCase();
          if (!/^[a-z]{5}$/.test(answer)) throw new Error("no word in the reply");
          p = { date, number: d.days_since_launch ?? null, answer, source: "nyt", tried: Date.now() };
        } catch (e) {
          console.log(`[OpenSky] word game: NYT's word unavailable (${e.message}) — using OpenSky's word for now`);
        }
      }
      this.cached = p || { ...this.ownPuzzle(date), backup: this.source === "nyt" };
      this.loading = null;
      return this.cached;
    })();
    return this.loading;
  },

  readState() {
    const fresh = () => ({ today: null, stats: { played: 0, won: 0, streak: 0, maxStreak: 0, dist: [0, 0, 0, 0, 0, 0], lastWonDate: null }, history: {} });
    let raw;
    try { raw = fs.readFileSync(STATE_FILE, "utf8"); } catch (e) { return fresh(); }   // first game: no file yet
    try {
      const s = JSON.parse(raw), d = fresh();
      // fill anything missing so a partial file can't break the game
      s.stats = { ...d.stats, ...(s.stats || {}) };
      if (!Array.isArray(s.stats.dist) || s.stats.dist.length !== 6) s.stats.dist = d.stats.dist;
      s.history = s.history || {};
      if (s.today && !Array.isArray(s.today.guesses)) s.today = null;
      return s;
    } catch (e) {
      // a damaged file (e.g. a power cut): keep a copy rather than silently wiping the family's stats
      const keep = `${STATE_FILE}.damaged-${Date.now()}`;
      try { fs.copyFileSync(STATE_FILE, keep); } catch (x) { /* ignore */ }
      console.error(`[OpenSky] wordgame.json unreadable (${e.message}); a copy was kept`);
      return fresh();
    }
  },

  writeState(s) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(s, null, 1));
    fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  },

  // Standard coloring with repeated letters handled: "g" right spot, "y" elsewhere in the word, "b" not in it
  score(guess, answer) {
    const res = Array(5).fill("b"), left = {};
    for (let i = 0; i < 5; i++) {
      if (guess[i] === answer[i]) res[i] = "g";
      else left[answer[i]] = (left[answer[i]] || 0) + 1;
    }
    for (let i = 0; i < 5; i++) {
      if (res[i] !== "g" && left[guess[i]] > 0) { res[i] = "y"; left[guess[i]]--; }
    }
    return res.join("");
  },

  async today() {
    const date = this.ymd();
    // on the backup word and nobody has guessed yet → try NYT again every 10 minutes
    if (this.cached && this.cached.backup && this.cached.date === date && Date.now() - this.cached.tried > 10 * 60 * 1000) {
      const st = this.readState();
      if (!st.today || st.today.date !== date || !st.today.guesses.length) this.cached = null;
    }
    const p = await this.puzzle(date), s = this.readState();
    if (s.today && s.today.date === p.date && !s.today.guesses.length && s.today.source !== p.source) {
      s.today.source = p.source; s.today.number = p.number; this.writeState(s);   // switched to NYT's word
    }
    if (!s.today || s.today.date !== p.date) {
      s.today = { date: p.date, number: p.number, source: p.source, guesses: [], status: "playing" };
      this.writeState(s);
    }
    return { s, p };
  },

  view(s, p) {
    const t = s.today;
    return { date: t.date, number: t.number, source: t.source || p.source, backup: !!p.backup, guesses: t.guesses, status: t.status,
      answer: t.status === "playing" ? null : p.answer, stats: this.liveStats(s.stats) };
  },

  // A streak only counts if the last win was today or yesterday (skipping a day breaks it)
  liveStats(st) {
    const y = new Date(); y.setDate(y.getDate() - 1);
    const alive = st.lastWonDate === this.ymd() || st.lastWonDate === this.ymd(y);
    return { ...st, streak: alive ? st.streak : 0 };
  },

  async socketNotificationReceived(n, payload) {
    if (n === "OS_WG_INIT") {
      if (payload && (payload.source === "nyt" || payload.source === "opensky") && payload.source !== this.source) { this.source = payload.source; this.cached = null; }
      ((payload && payload.extraWords) || []).map((w) => String(w).trim().toLowerCase()).filter((w) => /^[a-z]{5}$/.test(w)).forEach((w) => this.allowed.add(w));
    }
    if (n === "OS_WG_INIT" || n === "OS_WG_SYNC") {
      const { s, p } = await this.today();
      return this.sendSocketNotification("OS_WG_STATE", this.view(s, p));
    }
    if (n !== "OS_WG_GUESS") return;
    const word = String((payload && payload.word) || "").toLowerCase();
    const { s, p } = await this.today();
    const t = s.today;
    // a guess typed just before midnight must not land on the next day's puzzle
    if (payload && payload.date && payload.date !== t.date) {
      this.sendSocketNotification("OS_WG_STATE", this.view(s, p));
      return this.sendSocketNotification("OS_WG_ERROR", { message: osT("A new puzzle just started") });
    }
    if (t.status !== "playing") return this.sendSocketNotification("OS_WG_STATE", this.view(s, p));
    if (!/^[a-z]{5}$/.test(word)) return this.sendSocketNotification("OS_WG_ERROR", { message: osT("Not enough letters") });
    if (!this.allowed.has(word) && word !== p.answer) return this.sendSocketNotification("OS_WG_ERROR", { message: osT("Not in the word list") });
    if (t.guesses.some((g) => g.word === word)) return this.sendSocketNotification("OS_WG_ERROR", { message: osT("Already tried that one") });
    const pattern = this.score(word, p.answer);
    t.guesses.push({ word, pattern, at: new Date().toISOString() });
    if (pattern === "ggggg" || t.guesses.length >= MAX_GUESSES) {
      const won = pattern === "ggggg", st = s.stats;
      t.status = won ? "won" : "lost";
      st.played++;
      if (won) {
        st.won++;
        st.dist[t.guesses.length - 1]++;
        const y = new Date(`${t.date}T12:00:00`); y.setDate(y.getDate() - 1);
        st.streak = st.lastWonDate === this.ymd(y) ? st.streak + 1 : 1;
        st.maxStreak = Math.max(st.maxStreak, st.streak);
        st.lastWonDate = t.date;
      } else st.streak = 0;
      s.history[t.date] = { number: t.number, guesses: t.guesses.length, won, patterns: t.guesses.map((g) => g.pattern) };
    }
    this.writeState(s);
    this.sendSocketNotification("OS_WG_STATE", this.view(s, p));
  }
});
