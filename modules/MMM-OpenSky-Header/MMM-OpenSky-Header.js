/* MMM-OpenSky-Header
 * Always-on header: family name • clock • current weather • (optional) sports pill • countdown pill.
 * - Weather is fetched by the node helper (Open-Meteo by default, no key; OpenWeatherMap with a key from
 *   secrets.json) and shared with other modules as OPENSKY_WEATHER { current, daily, units }.
 * - Countdown: the next holiday (built-in "US" set or none) or your own dates, plus birthdays found in the calendar.
 * - Sports pill: today's game for one team from ESPN's public scoreboard (unofficial, can change). Off by default.
 */
Module.register("MMM-OpenSky-Header", {
  defaults: {
    title: "Our Family",
    time: { format12: true, showSeconds: false, updateInterval: 1000 },
    weather: { provider: "open-meteo", latitude: null, longitude: null, units: "imperial", refreshMinutes: 15 },
    countdown: { holidays: "US", custom: [], birthdays: true },  // custom: [{ name, month (1-12), day, icon? }]
    sports: null                                                   // e.g. { league: "nfl", team: "NE" }
  },

  getScripts() { return ["modules/opensky-lib/client/i18n.js"]; },

  getStyles() { return ["MMM-OpenSky-Header.css"]; },

  start() {
    this.now = new Date();
    this.temp = null;
    this.wxId = null;
    this.game = null;
    if (this.config.sports && this.config.sports.team) this.pollGame();
    // Formula 1: the next race (the Pi asks the calendar on Mondays; asking it here every 6 hours costs nothing)
    this.f1 = null;
    if (this.config.f1) { this.pollF1(); setInterval(() => this.pollF1(), 6 * 3600e3); }

    // clock
    this._timeTimer = setInterval(() => {
      this.now = new Date();
      if (this.config.time.showSeconds || this.now.getSeconds() === 0) this.updateDom(0);
    }, this.config.time.updateInterval);

    // weather (fetched by the node helper; no location = no weather)
    const w = this.config.weather;
    if (Number.isFinite(w.latitude) && Number.isFinite(w.longitude)) {
      this._fetchWeather();
      this._wxTimer = setInterval(() => this._fetchWeather(), Math.max(5, w.refreshMinutes) * 60 * 1000);
    } else {
      Log.info(`${this.name}: weather off (set location.latitude/longitude in opensky.json)`);
    }
  },

  getDom() {
    const row = document.createElement("div");
    row.className = "hb-row";

    const title = document.createElement("div");
    title.className = "hb-title";
    title.textContent = this.config.title;
    row.appendChild(title);

    const time = document.createElement("div");
    time.className = "hb-time";
    time.textContent = this._formatTime(this.now);
    row.appendChild(time);

    const wx = document.createElement("div");
    wx.className = "hb-weather";
    wx.innerHTML = this._formatWeather();
    row.appendChild(wx);

    // Sports game-day pill (only on the day of a game, gone at midnight)
    const g = this.gameToday();
    if (g) row.appendChild(this._gamePill(g));

    // Formula 1: the next race and how many days until it
    const race = this.nextRace(this.now || new Date());
    if (race) row.appendChild(this._f1Pill(race, this.now || new Date()));

    // Top-right: quiet countdown to the next big holiday or family birthday
    const next = this._nextOccasion(this.now || new Date());
    if (next) {
      const cd = document.createElement("div");
      cd.className = "hb-countdown";
      // Holiday on the day: "Happy Halloween!"; birthday on the day: "Mom's Birthday · today"
      const happy = next.days === 0 && !next.birthday;
      const when = happy ? "" : next.days === 0 ? osT("today") : next.days === 1 ? osT("tomorrow") : osT("{n} days", { n: next.days });
      cd.classList.add(`hb-theme-${next.key}`);
      cd.innerHTML = `<span class="hb-cd-ico">${this._occasionIcon(next.key)}</span>`
        + `<span class="hb-cd-name"></span>` + (when ? `<span class="hb-cd-when">${when}</span>` : "");
      const greeting = { christmas: osT("Merry Christmas!"), newyear: osT("Happy New Year!"), memorial: osT("Memorial Day"), easter: osT("Happy Easter!") }[next.key] || osT("Happy {name}!", { name: next.name });
      cd.querySelector(".hb-cd-name").textContent = happy ? greeting : next.name;
      if (next.days === 0) cd.classList.add("hb-cd-today"); // not ".today": MMM-Todoist.css underlines every .today
      row.appendChild(cd);
    }

    return row;
  },

  // Birthdays come from the calendar ("… Birthday" / "Bday" events), broadcast by the calendar module
  notificationReceived(n, payload) {
    if (n !== "CALENDAR_EVENTS" || !Array.isArray(payload)) return;
    // countdown.holidays "calendar" (countries other than the US): the next days of the Holidays calendar
    if (this.config.countdown.holidays === "calendar") {
      const hol = payload.filter((e) => e.calendarName === "Holidays" && e.fullDayEvent)
        .map((e) => { const d = new Date(Number(e.startDate)); return { name: (e.title || "").trim(), date: new Date(d.getFullYear(), d.getMonth(), d.getDate()) }; });
      const hk = JSON.stringify(hol);
      if (hol.length && hk !== this._holKey) { this._holKey = hk; this.calendarHolidays = hol; this.updateDom(0); }
    }
    if (this.config.countdown.birthdays === false) return;
    const list = payload
      .filter((e) => /birthday|\bbday\b|geburtstag/i.test(e.title || ""))
      .map((e) => { const d = new Date(Number(e.startDate)); return { name: (e.title || "").trim(), m: d.getMonth(), d: d.getDate() }; });
    const key = JSON.stringify(list);
    if (key !== this._bdayKey) { this._bdayKey = key; this.birthdays = list; this.updateDom(0); }
  },

  /* ---------- holiday / birthday countdown ---------- */
  _holidays(year) {
    const nth = (month, weekday, n) => { // n-th weekday of a month (n = -1: last)
      if (n > 0) { const d = new Date(year, month, 1); d.setDate(1 + ((weekday - d.getDay() + 7) % 7) + (n - 1) * 7); return d; }
      const d = new Date(year, month + 1, 0); d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7)); return d;
    };
    const easter = (() => { // anonymous Gregorian computus
      const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
      const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
      const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
      const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
      return new Date(year, month - 1, day);
    })();
    const custom = (this.config.countdown.custom || [])
      .filter((c) => c && c.name && c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= 31)
      .map((c) => [c.icon || "custom", c.name, new Date(year, c.month - 1, c.day)]);
    if (this.config.countdown.holidays === "calendar") {
      return [...custom.map(([key, name, date]) => ({ key, name, date })),
        ...(this.calendarHolidays || []).filter((h) => h.date.getFullYear() === year).map((h) => ({ key: this._holidayIcon(h.name), name: h.name, date: h.date }))];
    }
    if (this.config.countdown.holidays !== "US") return custom.map(([key, name, date]) => ({ key, name, date }));
    return [...custom,
      ["newyear", osT("New Year's Day"), new Date(year, 0, 1)], ["valentine", osT("Valentine's Day"), new Date(year, 1, 14)],
      ["easter", osT("Easter"), easter], ["mothers", osT("Mother's Day"), nth(4, 0, 2)], ["memorial", osT("Memorial Day"), nth(4, 1, -1)],
      ["fathers", osT("Father's Day"), nth(5, 0, 3)], ["july4", osT("4th of July"), new Date(year, 6, 4)],
      ["labor", osT("Labor Day"), nth(8, 1, 1)], ["halloween", osT("Halloween"), new Date(year, 9, 31)],
      ["thanksgiving", osT("Thanksgiving"), nth(10, 4, 4)], ["christmas", osT("Christmas"), new Date(year, 11, 25)]
    ].map(([key, name, date]) => ({ key, name, date }));
  },

  // a matching built-in icon for well-known days, else the star
  _holidayIcon(name) {
    const n = String(name).toLowerCase();
    // (German names too: the holiday calendar is in the screen's language)
    return /christmas|weihnacht/.test(n) ? "christmas" : /easter|ostern/.test(n) ? "easter" : /new year|neujahr/.test(n) ? "newyear" : /halloween/.test(n) ? "halloween"
      : /thanksgiving|erntedank/.test(n) ? "thanksgiving" : /mother|mutter/.test(n) ? "mothers" : /father|vater/.test(n) ? "fathers" : "custom";
  },

  _nextOccasion(now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const all = [];
    for (const y of [today.getFullYear(), today.getFullYear() + 1]) {
      all.push(...this._holidays(y));
      (this.birthdays || []).forEach((b) => all.push({ key: "birthday", name: b.name, date: new Date(y, b.m, b.d), birthday: true }));
    }
    const upcoming = all.filter((o) => o.date >= today).sort((a, b) => a.date - b.date || (b.birthday ? 1 : -1));
    if (!upcoming.length) return null;
    const o = upcoming[0];
    const days = Math.round((o.date - today) / 86400000); // both local midnights; round absorbs DST hours
    return { key: o.key, name: o.name, days, birthday: !!o.birthday };
  },

  // Small full-color icons, one per occasion (24x24)
  _occasionIcon(key) {
    const flag = `<defs><clipPath id="hb-flag"><rect x="2.5" y="5" width="19" height="14" rx="2.2"/></clipPath></defs>
      <g clip-path="url(#hb-flag)"><rect x="2.5" y="5" width="19" height="14" fill="#fff"/>
      <path d="M2.5 6h19M2.5 10h19M2.5 14h19M2.5 18h19" stroke="#e04848" stroke-width="2"/>
      <rect x="2.5" y="5" width="9" height="8" fill="#2f5fb8"/>
      <g fill="#fff"><circle cx="4.6" cy="7" r=".6"/><circle cx="7" cy="7" r=".6"/><circle cx="9.4" cy="7" r=".6"/><circle cx="5.8" cy="9" r=".6"/><circle cx="8.2" cy="9" r=".6"/><circle cx="4.6" cy="11" r=".6"/><circle cx="7" cy="11" r=".6"/><circle cx="9.4" cy="11" r=".6"/></g></g>
      <rect x="2.5" y="5" width="19" height="14" rx="2.2" fill="none" stroke="#c9d3e6" stroke-width=".7"/>`;
    const icons = {
      custom: `<circle cx="12" cy="12" r="8.5" fill="#ffd8c9"/><path d="M12 6.6l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z" fill="#e8663f"/>`,
      halloween: `<path d="M12 6.8c.2-1.9 1.2-3.1 2.8-3.4" stroke="#3f7d3a" stroke-width="1.8" fill="none" stroke-linecap="round"/>
        <ellipse cx="8" cy="14" rx="5" ry="6.3" fill="#ec7a2c"/><ellipse cx="16" cy="14" rx="5" ry="6.3" fill="#ec7a2c"/>
        <ellipse cx="12" cy="14" rx="4.3" ry="6.9" fill="#ff9a4d"/><path d="M13.6 6.4c1.5-1.5 3.6-1.5 4.4-.8-1 1.3-2.7 1.9-4.4.8z" fill="#5fa84f"/>
        <path d="M9.2 12.6l1.2-1.7 1.2 1.7zM12.4 12.6l1.2-1.7 1.2 1.7z" fill="#7a3a12"/>
        <path d="M9.6 15.4q2.4 2.1 4.8 0" stroke="#7a3a12" stroke-width="1.2" fill="none" stroke-linecap="round"/>`,
      christmas: `<path d="M12 3.6 7.2 10h2.5L6.2 15h3L5.2 20.4h13.6L14.8 15h3l-3.5-5h2.5z" fill="#3f9467"/>
        <rect x="10.8" y="20.3" width="2.4" height="2.6" rx=".6" fill="#8a5a36"/>
        <path d="M12 .9l.75 1.5 1.6.2-1.2 1.1.3 1.6-1.45-.8-1.45.8.3-1.6-1.2-1.1 1.6-.2z" fill="#f5c542"/>
        <circle cx="10.2" cy="12.8" r="1" fill="#e04848"/><circle cx="14" cy="17.4" r="1" fill="#f5c542"/><circle cx="10.6" cy="18.2" r="1" fill="#5b8def"/><circle cx="13.3" cy="9.6" r=".8" fill="#f5c542"/>`,
      july4: flag,
      memorial: flag,
      valentine: `<path d="M12 20.6s-7.6-4.6-7.6-10.1A4.2 4.2 0 0 1 12 7.9a4.2 4.2 0 0 1 7.6 2.6c0 5.5-7.6 10.1-7.6 10.1z" fill="#ec5c9a"/>
        <path d="M7.6 9.6a2.1 2.1 0 0 1 2-1.6" stroke="#fff" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".75"/>`,
      easter: `<path d="M12 2.8c3.6 0 6.5 6 6.5 10.4a6.5 6.5 0 0 1-13 0C5.5 8.8 8.4 2.8 12 2.8z" fill="#c9b6ff"/>
        <path d="M5.9 11.4c2 1.3 4.1 1.3 6.1 0s4.1-1.3 6.1 0" stroke="#fff" stroke-width="1.5" fill="none"/>
        <path d="M5.6 15.3c2.1 1.2 4.3 1.2 6.4 0s4.3-1.2 6.4 0" stroke="#8fd3b0" stroke-width="1.5" fill="none"/>
        <circle cx="10" cy="7.6" r=".95" fill="#ffd166"/><circle cx="14" cy="8.1" r=".95" fill="#ff9fb6"/>`,
      mothers: `<g fill="#ff9fb6"><circle cx="12" cy="7.8" r="3.3"/><circle cx="16" cy="10.7" r="3.3"/><circle cx="14.5" cy="15.4" r="3.3"/><circle cx="9.5" cy="15.4" r="3.3"/><circle cx="8" cy="10.7" r="3.3"/></g>
        <circle cx="12" cy="12" r="2.7" fill="#ffd166"/>`,
      fathers: `<path d="M9.9 3h4.2l-.8 3h-2.6z" fill="#1f6fb2"/><path d="M10.8 6h2.4l2.4 11.4L12 21l-3.6-3.6z" fill="#2e8bd6"/>
        <path d="M10.4 9.2l3.6 2.3M9.8 12.8l4.8 3" stroke="#fff" stroke-width="1" opacity=".6"/>`,
      labor: `<path d="M4 16.2a8 8 0 0 1 16 0z" fill="#f5c542"/><rect x="10.8" y="7.8" width="2.4" height="8.4" rx="1" fill="#e0a800"/>
        <rect x="2.5" y="16" width="19" height="2.8" rx="1.4" fill="#e0a800"/>`,
      thanksgiving: `<g><circle cx="6.4" cy="9.8" r="3" fill="#e8663f"/><circle cx="8.8" cy="7.4" r="3" fill="#f5c542"/><circle cx="12" cy="6.5" r="3" fill="#d9621c"/>
        <circle cx="15.2" cy="7.4" r="3" fill="#f5c542"/><circle cx="17.6" cy="9.8" r="3" fill="#e8663f"/></g>
        <circle cx="12" cy="14.6" r="5" fill="#9a6a44"/><circle cx="12" cy="10.4" r="2.6" fill="#b07d52"/>
        <circle cx="11.1" cy="10" r=".45" fill="#3a2a1a"/><circle cx="12.9" cy="10" r=".45" fill="#3a2a1a"/>
        <path d="M11.4 11.1l.6 1 .6-1z" fill="#f5a623"/><path d="M12.4 11.7c.6.5.6 1.4 0 1.8" stroke="#e04848" stroke-width=".9" fill="none"/>`,
      newyear: `<path d="M4 20.5l4.6-11.2 6.6 6.6z" fill="#f5c542"/><path d="M6.4 14.8l3.3 3.3" stroke="#e8663f" stroke-width="1.4"/>
        <path d="M11 7.4c1-2 3-2 3-4.2M15.8 12.6c2-1 2.6 1 4.6 0" stroke="#e8663f" stroke-width="1.3" fill="none" stroke-linecap="round"/>
        <circle cx="15.2" cy="5" r="1" fill="#ec5c9a"/><circle cx="19.2" cy="8.8" r="1" fill="#5b8def"/><circle cx="18.7" cy="4" r=".85" fill="#3f9467"/>`,
      birthday: `<rect x="4" y="11" width="16" height="8.6" rx="2" fill="#ffc9a3"/>
        <path d="M4 13.4c1.3 1.2 2.7 1.2 4 0s2.7-1.2 4 0 2.7 1.2 4 0 2.7-1.2 4 0V13a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2z" fill="#fff"/>
        <rect x="7.9" y="6.6" width="1.6" height="4.4" rx=".5" fill="#5b8def"/><rect x="11.2" y="6.6" width="1.6" height="4.4" rx=".5" fill="#ec5c9a"/><rect x="14.5" y="6.6" width="1.6" height="4.4" rx=".5" fill="#3f9467"/>
        <path d="M8.7 3.6c.7.9.9 1.6 0 2.3-.9-.7-.7-1.4 0-2.3zM12 3.6c.7.9.9 1.6 0 2.3-.9-.7-.7-1.4 0-2.3zM15.3 3.6c.7.9.9 1.6 0 2.3-.9-.7-.7-1.4 0-2.3z" fill="#f5a623"/>
        <rect x="2.5" y="19.4" width="19" height="1.7" rx=".85" fill="#e5c8b0"/>`
    };
    return `<svg viewBox="0 0 24 24">${icons[key] || icons.birthday}</svg>`;
  },

  _formatTime(d) {
    if (!d) return "";
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const s = d.getSeconds().toString().padStart(2, "0");
    if (this.config.time.format12) {
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      return this.config.time.showSeconds ? `${h}:${m}:${s} ${ampm}` : `${h}:${m} ${ampm}`;
    } else {
      h = h.toString().padStart(2, "0");
      return this.config.time.showSeconds ? `${h}:${m}:${s}` : `${h}:${m}`;
    }
  },

  _formatWeather() {
    if (this.temp == null) return "";
    const t = Math.round(this.temp);
    const icon = this.wxId != null ? this._svgForWeatherId(this.wxId) : "";
    return `<span class="hb-wx-ico">${icon}</span><span class="hb-wx-temp">${t}°</span>`;
  },

  _fetchWeather() {
    const { provider, latitude, longitude, units } = this.config.weather;
    this.sendSocketNotification("WEATHER_FETCH", { provider, latitude, longitude, units });
  },

  /* ---------- Colored SVGs (compact, inline) ---------- */
  _svgForWeatherId(id) {
    if (id >= 200 && id < 300) return this._svgThunder();
    if (id >= 300 && id < 600) return this._svgRain();
    if (id >= 600 && id < 700) return this._svgSnow();
    if (id >= 700 && id < 800) return this._svgMist();
    if (id === 800)              return this._svgSun();
    if (id > 800)                return this._svgCloud();
    return this._svgCloud();
  },

  _svgSun() {
    return `
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <circle cx="12" cy="12" r="5.5" fill="#FFA726"/>
        <g stroke="#FFB74D" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="1.5" x2="12" y2="4.5"/>
          <line x1="12" y1="19.5" x2="12" y2="22.5"/>
          <line x1="1.5" y1="12" x2="4.5" y2="12"/>
          <line x1="19.5" y1="12" x2="22.5" y2="12"/>
          <line x1="4.2" y1="4.2" x2="6.3" y2="6.3"/>
          <line x1="17.7" y1="17.7" x2="19.8" y2="19.8"/>
          <line x1="4.2" y1="19.8" x2="6.3" y2="17.7"/>
          <line x1="17.7" y1="6.3" x2="19.8" y2="4.2"/>
        </g>
      </svg>`;
  },

  _svgCloud() {
    return `
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <path d="M6 18h11a4 4 0 0 0 0-8 6 6 0 0 0-11.3-1.5A4.5 4.5 0 0 0 6 18z" fill="#90A4AE"/>
      </svg>`;
  },

  _svgRain() {
    return `
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <path d="M6 14h11a4 4 0 0 0 0-8 6 6 0 0 0-11.3-1.5A4.5 4.5 0 0 0 6 14z" fill="#90A4AE"/>
        <g stroke="#42A5F5" stroke-width="2" stroke-linecap="round">
          <line x1="9" y1="16.5" x2="9" y2="20.5"/>
          <line x1="12" y1="16.5" x2="12" y2="21.5"/>
          <line x1="15" y1="16.5" x2="15" y2="20.5"/>
        </g>
      </svg>`;
  },

  _svgSnow() {
    return `
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <path d="M6 14h11a4 4 0 0 0 0-8 6 6 0 0 0-11.3-1.5A4.5 4.5 0 0 0 6 14z" fill="#90CAF9"/>
        <g stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round">
          <line x1="12" y1="16" x2="12" y2="21"/>
          <line x1="10" y1="18.5" x2="14" y2="18.5"/>
          <line x1="10.8" y1="17.2" x2="13.2" y2="19.8"/>
          <line x1="10.8" y1="19.8" x2="13.2" y2="17.2"/>
        </g>
      </svg>`;
  },

  _svgThunder() {
    return `
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <path d="M6 13h11a4 4 0 0 0 0-8 6 6 0 0 0-11.3-1.5A4.5 4.5 0 0 0 6 13z" fill="#90A4AE"/>
        <polygon points="11,14 9,20 13,17 12,22 16,15" fill="#FFCA28"/>
      </svg>`;
  },

  _svgMist() {
    return `
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <path d="M4 10h16M3 13h18M4 16h16" stroke="#B0BEC5" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  },

  suspend() {},
  resume() {},
  stop() {
    clearInterval(this._timeTimer);
    clearInterval(this._wxTimer);
    clearTimeout(this._wxRetry);
    clearTimeout(this._gameTimer);
  },

  /* ---------- Sports game-day pill ----------
   * ESPN's public scoreboard (no key, unofficial): today's game for config.sports.team in config.sports.league.
   * Shown only on game day: before kickoff "@ Bills · 1 PM · CBS", live "● 14 – 17" (score only — ESPN's free feed
   * updates the clock in jumps), afterwards "Final" + W/L. Polling: live every 60 s, before the start every 15 min
   * (every minute from 5 min before), otherwise hourly. */
  _localYMD(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; },

  // Ask the node helper (ESPN refuses requests from the page itself); the answer arrives as GAME_RESULT
  pollGame() {
    clearTimeout(this._gameTimer);
    // A live (or just-finished) late game belongs to the day it started, even after midnight
    const g = this.game, recent = g && (g.state === "in" || (g.state === "post" && Date.now() - g.start < 6 * 3600e3));
    const ymd = this._localYMD(recent ? new Date(g.start) : new Date());
    this.sendSocketNotification("GAME_FETCH", { league: this.config.sports.league || "nfl", team: String(this.config.sports.team).toUpperCase(), ymd });
    // Safety net: if no answer comes back, try again in 5 minutes
    this._gameTimer = setTimeout(() => this.pollGame(), 5 * 60 * 1000);
  },

  socketNotificationReceived(n, p) {
    if (n === "F1_RESULT") {
      if (p && p.ok && Array.isArray(p.races)) { this.f1 = p.races; this.updateDom(0); }
      else { Log.warn(`${this.name}: F1 calendar: ${p && p.error} — retrying in 30 minutes`); this._f1Retry = setTimeout(() => this.pollF1(), 30 * 60 * 1000); }
      return;
    }
    if (n === "WEATHER_RESULT") {

      clearTimeout(this._wxRetry);
      if (!p || !p.ok) {
        // network hiccup: try again in a minute instead of waiting for the next regular refresh
        Log.warn(`${this.name}: weather failed: ${p && p.error} — retrying in 1 minute`);
        this._wxRetry = setTimeout(() => this._fetchWeather(), 60 * 1000);
        return;
      }
      this.temp = p.current ? p.current.temp : null;
      this.wxId = p.current ? p.current.id : null;
      this.sendNotification("OPENSKY_WEATHER", { current: p.current, daily: p.daily, units: this.config.weather.units });
      this.updateDom(0);
      return;
    }
    if (n !== "GAME_RESULT") return;
    clearTimeout(this._gameTimer);
    const team = String(this.config.sports.team).toUpperCase();
    let next = 60 * 60 * 1000;
    if (p && p.ok) {
      const prev = JSON.stringify(this.game);
      this.game = p.event ? this._parseGame(p.event, team) : null;
      if (this.game) {
        const untilKick = this.game.start - Date.now();
        if (this.game.state === "in") next = 60 * 1000;    // score only → once a minute is plenty
        else if (this.game.state === "pre") next = untilKick > 5 * 60 * 1000 ? Math.min(15 * 60 * 1000, untilKick - 4 * 60 * 1000) : 60 * 1000;
        else if (this.game.state === "off") next = 60 * 60 * 1000;     // postponed / canceled
        else next = 30 * 60 * 1000;                     // final: occasional score corrections
      }
      if (JSON.stringify(this.game) !== prev) this.updateDom(0);
    } else {
      Log.warn(`${this.name}: game score fetch failed: ${p && p.error}`);
      next = this.game && this.game.state === "in" ? 60 * 1000 : 15 * 60 * 1000;
    }
    // Always re-check just after midnight (a new day may be a game day; yesterday's final goes away)
    const now = new Date(), midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1);
    this._gameTimer = setTimeout(() => this.pollGame(), Math.max(15 * 1000, Math.min(next, midnight - now)));
  },

  _parseGame(ev, team) {
    const c = ev && ev.competitions && ev.competitions[0];
    if (!c || !Array.isArray(c.competitors) || c.competitors.length < 2) return null;     // incomplete data: show nothing
    const st = c.status || {};
    const side = (x) => ({ abbr: x.team?.abbreviation || "?", name: x.team?.shortDisplayName || x.team?.abbreviation || osT("Opponent"),
      logo: x.team?.logo || "", score: x.score == null || x.score === "" ? "0" : String(typeof x.score === "object" ? x.score.displayValue : x.score),
      winner: !!x.winner, id: x.team?.id, home: x.homeAway === "home" });
    const comps = c.competitors.map(side);
    const us = comps.find((x) => x.abbr === team), them = comps.find((x) => x.abbr !== team);
    const start = Date.parse(ev.date);
    if (!us || !them || !Number.isFinite(start)) return null;
    // Postponed / canceled / suspended come back as "post" (or "pre") — never show them as a Final with W/L
    const name = String(st.type?.name || "");
    const off = /POSTPONED|CANCELED|CANCELLED|SUSPENDED|FORFEIT/.test(name);
    return {
      start, state: off ? "off" : (st.type?.state || "pre"), detail: off ? (st.type?.description || osT("Postponed")) : this._fmtDetail(st.type?.shortDetail || ""),
      us, them, home: us.home, network: (c.broadcasts || []).flatMap((b) => b.names || [b.media?.shortName]).filter(Boolean)[0] || "",
      possession: c.situation?.possession || null, redZone: !!c.situation?.isRedZone
    };
  },

  // ESPN "13:08 - 3rd" → "Q3 · 13:08", "End of 3rd" → "End Q3"; "Halftime", "Delayed", "Final/OT" stay as they are
  _fmtDetail(d) {
    let m = d.match(/^(\d+:\d+) - (\d)(?:st|nd|rd|th)$/);
    if (m) return `Q${m[2]} · ${m[1]}`;
    m = d.match(/^(\d+:\d+) - OT$/);
    if (m) return `OT · ${m[1]}`;
    m = d.match(/^End of (\d)(?:st|nd|rd|th)$/);
    if (m) return osT("End Q{n}", { n: m[1] });
    return d;
  },

  // Today's game; also a live game that runs past midnight, and a late game that ended < 3 h ago (then gone)
  gameToday() {
    const g = this.game;
    if (!g) return null;
    const now = this.now || new Date();
    if (this._localYMD(new Date(g.start)) === this._localYMD(now)) return g;
    if (g.state === "in" && now - g.start < 8 * 3600e3) return g;
    if (g.state === "post" && now - g.start < 6 * 3600e3 && now.getHours() < 3) return g;
    return null;
  },

  /* ---------- Formula 1 pill ----------
   * The next race weekend (from MMM-OpenSky-Header's node helper → lib/f1.js): its name, when qualifying and the race
   * start, and a countdown in days to the next of the two. A session drops off 30 minutes after its start (qualifying
   * first, then the race; then it's the next weekend's turn). */
  F1_AFTER: 30 * 60 * 1000,
  pollF1() {
    clearTimeout(this._f1Retry);
    this.sendSocketNotification("F1_FETCH");
  },

  nextRace(now) {
    if (!this.config.f1 || !Array.isArray(this.f1)) return null;
    return this.f1.filter((r) => r.start > now.getTime() - this.F1_AFTER).sort((a, b) => a.start - b.start)[0] || null;
  },

  // the sessions still to show: qualifying (until 30 min after its start), then the race
  f1Sessions(race, now) {
    return [[osT("Quali"), race.quali], [osT("Race"), race.start]]
      .filter(([, t]) => Number.isFinite(t) && t > now.getTime() - this.F1_AFTER)
      .map(([label, t]) => ({ label, start: t }));
  },

  _f1Pill(race, now) {
    const loc = config.locale || "en-US", h12 = this.config.time.format12;
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const daysTo = (t) => Math.round((day(new Date(t)) - day(now)) / 86400e3);
    const time = (t) => new Date(t).toLocaleTimeString(loc, { hour: h12 ? "numeric" : "2-digit", minute: "2-digit", hour12: h12 });   // 05:00 / 5:00 AM

    // "today 14:00", "tomorrow 14:00", "Sat 14:00" this week, "Sat 21.11. 14:00" further off
    const at = (t) => {
      const n = daysTo(t), d = new Date(t);
      if (n <= 0) return osT("today {time}", { time: time(t) });
      if (n === 1) return osT("tomorrow {time}", { time: time(t) });
      const wd = d.toLocaleDateString(loc, { weekday: "short" });
      return n < 7 ? `${wd} ${time(t)}` : `${wd} ${d.toLocaleDateString(loc, { day: "numeric", month: "numeric" })} ${time(t)}`;
    };
    const sessions = this.f1Sessions(race, now);
    const first = sessions[0] || { start: race.start };
    const n = daysTo(first.start);
    const el = document.createElement("div");
    el.className = "hb-f1" + (n <= 0 ? " hb-f1-today" : "");
    el.innerHTML = `<span class="hb-f1-flag"><svg viewBox="0 0 24 24"><path d="M5 21V4"/><path d="M5 4h14v9H5"/><path d="M5 4h3.5v3H5zM12 4h3.5v3H12zM8.5 7H12v3H8.5zM15.5 7H19v3h-3.5zM5 10h3.5v3H5zM12 10h3.5v3H12z" class="f"/></svg></span>`
      + `<span class="hb-f1-tag">F1</span><span class="hb-f1-name"></span>`
      + sessions.map((s, i) => `<span class="hb-f1-session${i === 0 ? " next" : ""}"><b></b><span></span></span>`).join("")
      + (n > 1 ? `<span class="hb-f1-when"></span>` : "");
    el.querySelector(".hb-f1-name").textContent = race.name;
    el.querySelectorAll(".hb-f1-session").forEach((x, i) => { x.querySelector("b").textContent = sessions[i].label; x.querySelector("span").textContent = at(sessions[i].start); });
    if (n > 1) el.querySelector(".hb-f1-when").textContent = osT("{n} days", { n });
    return el;
  },


  _gamePill(g) {

    const el = document.createElement("div");
    el.className = `hb-game hb-game-${g.state}`;
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x]));
    // (the logo address comes from ESPN's feed too: escaped like the names, so it can't add attributes)
    const logo = (t) => /^https:\/\//.test(t.logo || "") ? `<img class="hb-game-logo" src="${esc(t.logo)}" alt="" onerror="this.remove()">` : "";
    if (g.state === "off") {
      el.innerHTML = `${logo(g.us)}<span class="hb-game-vs">${g.home ? "vs" : "@"}</span>${logo(g.them)}<span class="hb-game-team">${esc(g.them.name)}</span>`
        + `<span class="hb-game-when">${esc(g.detail)}</span>`;
      return el;
    }
    if (g.state === "pre") {
      const t = new Date(g.start).toLocaleTimeString(config.locale || "en-US", { hour: "numeric", minute: "2-digit", hour12: this.config.time.format12 }).replace(":00", "");
      el.innerHTML = `${logo(g.us)}<span class="hb-game-vs">${g.home ? "vs" : "@"}</span>${logo(g.them)}<span class="hb-game-team">${esc(g.them.name)}</span>`
        + `<span class="hb-game-when">${esc(t)}${g.network ? " · " + esc(g.network) : ""}</span>`;
    } else {
      // Score only while live: ESPN's free feed updates the game clock in jumps and freezes it during
      // stoppages, so a clock would look stuck next to the TV. Red dot = live.
      const us = `${logo(g.us)}<span class="hb-game-score us">${esc(g.us.score)}</span>`;
      const them = `<span class="hb-game-score">${esc(g.them.score)}</span>${logo(g.them)}`;
      const status = g.state === "in" ? `<span class="hb-game-live"></span>` : `<span class="hb-game-final">${osT("Final")}</span>`
;
      const result = g.state === "post" ? (g.us.winner ? `<span class="hb-game-wl w">W</span>` : g.them.winner ? `<span class="hb-game-wl l">L</span>` : `<span class="hb-game-wl">T</span>`) : "";
      el.innerHTML = `${g.state === "in" ? status : ""}${us}<span class="hb-game-dash">–</span>${them}${g.state === "post" ? status + result : ""}`;
    }
    return el;
  }
});
