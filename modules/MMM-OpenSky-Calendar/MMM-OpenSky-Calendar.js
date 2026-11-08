/* MMM-OpenSky-Calendar — the Calendar page's own parts, next to the month view (MMM-CalendarExt3, "CX3"):
 * - toolbar on the month title line: [+ Add Event] (only with an event editor)  [‹] [Today] [›]
 * - taps: an event → CALENDAR_EVENT_CLICKED, empty space in a day → CALENDAR_DAY_CLICKED {date, events}
 *   (the event editor shows them)
 * - two-line event names where a day has room (window.OpenSkyFit.cx3All after every redraw)
 * - back to this month on the idle reset (OPENSKY_IDLE_RESET)
 * Event colors come from window.OpenSkyEventColors through CX3's eventTransformer (set in config.js).
 */
Module.register("MMM-OpenSky-Calendar", {
  defaults: {
    instanceId: "OPENSKY",
    canAddEvents: false,
    eventColors: null
  },

  getStyles() { return ["MMM-OpenSky-Calendar.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js"]; },

  start() {
    this.offset = 0;   // months from this month
    // One delegated listener survives every CX3 redraw (month change, refresh)
    this.onTap = (e) => {
      if (!e.target.closest || !e.target.closest(".CX3") || e.target.closest(".module.hidden")) return;
      const eventEl = e.target.closest(".event");
      if (eventEl) {
        e.stopPropagation();
        const ev = this.eventFromElement(eventEl);
        if (ev) this.sendNotification("CALENDAR_EVENT_CLICKED", ev);
        return;
      }
      // Empty space in a day: CX3 draws events in a week-wide layer over the cells, so find the cell under the finger
      const cell = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList && el.classList.contains("cell") && el.dataset.date);
      if (!cell) return;
      e.stopPropagation();
      const day = Number(cell.dataset.date);
      this.sendNotification("CALENDAR_DAY_CLICKED", { date: day, events: this.eventsForDay(day) });
    };
    document.addEventListener("click", this.onTap, true);
    // Re-fit event names after every CX3 redraw
    const refit = () => { clearTimeout(this.fitTimer); this.fitTimer = setTimeout(() => window.OpenSkyFit && window.OpenSkyFit.cx3All(), 150); };
    new MutationObserver((muts) => {
      if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches(".CX3, .week, .event") || n.querySelector?.(".week"))))) refit();
    }).observe(document.body, { childList: true, subtree: true });
    this.refit = refit;
  },

  notificationReceived(n) {
    if (n === "DOM_OBJECTS_CREATED" && window.OpenSkyEventColors) window.OpenSkyEventColors.configure(this.config.eventColors);
    else if (n === "PAGE_CHANGED" && this.refit) this.refit();   // sizes are only measurable while visible
    else if (n === "OPENSKY_IDLE_RESET" && this.offset !== 0) this.today();
  },

  getDom() {
    const bar = document.createElement("div");
    bar.className = "os-cal-nav";
    const button = (cls, html, onTap, label) => {
      const b = document.createElement("button");
      b.className = `os-nav-btn ${cls}`;
      b.innerHTML = html;
      b.setAttribute("aria-label", label);
      b.onclick = onTap;
      bar.appendChild(b);
    };
    if (this.config.canAddEvents) button("os-nav-add", `${this.svg("M12 5v14M5 12h14")}<span class="os-nav-text">${osT("Add Event")}</span>`, () => this.sendNotification("CALENDAR_ADD_EVENT", { date: new Date() }), osT("Add event"));
    button("os-nav-prev", this.svg("M15 5l-7 7 7 7"), () => this.move(-1), osT("Previous month"));
    button("os-nav-today", `<span class="os-nav-text">${osT("Today")}</span>`, () => this.today(), osT("Today"));
    button("os-nav-next", this.svg("M9 5l7 7-7 7"), () => this.move(1), osT("Next month"));

    return bar;
  },

  move(dir) {
    this.offset += dir;
    this.sendNotification("CX3_SET_CONFIG", { instanceId: this.config.instanceId, monthIndex: this.offset });
  },

  today() {
    this.offset = 0;
    this.sendNotification("CX3_RESET", { instanceId: this.config.instanceId });
  },

  // CX3 keeps the event on the element's data attributes (dates are epoch milliseconds as strings). Title, place and
  // notes were made safe for HTML by config.js (eventTransformer): turn them back into the real text.
  eventFromElement(el) {
    const d = el.dataset;
    const text = (v) => (typeof v === "string" ? v.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))) : v);
    const start = Number(d.startDate), end = Number(d.endDate);
    if (!d.title || !Number.isFinite(start)) return null;
    return this.normalize({ title: text(d.title), calendarName: d.calendarName, startDate: start, endDate: Number.isFinite(end) ? end : start,
      fullDayEvent: d.fullDayEvent === "true", location: text(d.location), description: text(d.description), color: d.color });
  },

  normalize(ev) {
    const clean = (v) => (v && v !== "undefined" && v !== "false" ? String(v) : "");
    return { title: String(ev.title || "").trim(), calendarName: ev.calendarName || "", startDate: Number(ev.startDate), endDate: Number(ev.endDate),
      allDay: ev.fullDayEvent === true || ev.fullDayEvent === "true", location: clean(ev.location), description: clean(ev.description), color: ev.color || "" };
  },

  // Every event (from CX3's pool, i.e. every calendar) that touches the given day
  eventsForDay(dayStart) {
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const cx3 = MM.getModules().withClass("MMM-CalendarExt3")[0];
    const pool = cx3 && cx3.eventPool ? [...cx3.eventPool.values()].flat() : [];
    const seen = new Set();
    return pool.map((ev) => this.normalize(ev))
      .filter((ev) => { const end = ev.endDate > ev.startDate ? ev.endDate : ev.startDate + 1; return ev.startDate < dayEnd.getTime() && end > dayStart; })
      .filter((ev) => { const k = `${ev.title}|${ev.startDate}|${ev.calendarName}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (b.allDay - a.allDay) || (a.startDate - b.startDate));
  },

  svg(d) {
    return `<svg class="os-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  }
});
