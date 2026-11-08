/* MMM-OpenSky-Calendars — the family's calendar sources (no screen of its own).
 * Fetches each source on the Pi (node helper) and broadcasts all events together as CALENDAR_EVENTS, the standard
 * MagicMirror notification, so the Home page, the month view and the header's birthday countdown all see them.
 * Each event carries calendarName (the source's name) and color (its color: palette or code), like MagicMirror's calendar.
 * Status for a settings page: OPENSKY_CALENDAR_STATUS { name: "ok" | "error message" }.
 */
Module.register("MMM-OpenSky-Calendars", {
  defaults: {
    sources: [],          // [{ name, type: "local" | "link" | "caldav", url (public links only), color, fetchMinutes }]
    days: 400             // how far ahead (and back) to keep events
  },

  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js"]; },

  start() {
    this.events = new Map();   // source name → events
    this.status = {};
    this.sendSocketNotification("OS_CAL_START", {
      // everything a source type needs (holidays: country/region; google: calendarId) — no colors, no secrets here
      sources: this.config.sources.map((s) => ({ name: s.name, type: s.type || "link", url: s.url || null, fetchMinutes: s.fetchMinutes,
        country: s.country, region: s.region, calendarId: s.calendarId })),
      days: this.config.days
    });
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_CAL_EVENTS") {
      this.events.set(p.name, Array.isArray(p.events) ? p.events : []);
      this.status[p.name] = "ok";
      this.broadcast();
    } else if (n === "OS_CAL_ERROR") {
      this.status[p.name] = p.message;
      Log.warn(`${this.name}: ${p.name}: ${p.message}`);
      this.sendNotification("OPENSKY_CALENDAR_STATUS", { ...this.status });
    }
  },

  broadcast() {
    const list = [];
    const pickup = [];
    for (const src of this.config.sources) {
      const evs = this.events.get(src.name) || [];
      // a trash/recycling calendar isn't shown as events: the Home page turns it into pickup icons
      if (src.role === "pickup") { evs.forEach((ev) => pickup.push({ title: ev.title, startDate: ev.startDate, fullDayEvent: ev.fullDayEvent })); continue; }
      const EC = window.OpenSkyEventColors, own = EC ? EC.colorOf(src.color) : null;   // a palette name or a color code
      const color = own ? EC.pair(own)[1] : "";
      // symbol: [] — MagicMirror's calendar always sets it and CalendarExt3 requires it (calls symbol.join)
      for (const ev of evs) list.push({ ...ev, calendarName: src.name, color, colorName: src.color || null, symbol: [] });
    }
    list.sort((a, b) => Number(a.startDate) - Number(b.startDate));
    this.sendNotification("CALENDAR_EVENTS", list);
    if (this.config.sources.some((src) => src.role === "pickup")) this.sendNotification("OPENSKY_PICKUP_EVENTS", pickup);
    this.sendNotification("OPENSKY_CALENDAR_STATUS", { ...this.status });
  },

  notificationReceived(n, p) {
    // a page that asks again (e.g. after a reload) gets the current list
    if (n === "OPENSKY_CALENDAR_REFRESH" && this.events.size) this.broadcast();
    // after an edit: fetch that source again now (instead of at its next interval)
    if (n === "OPENSKY_CALENDAR_REFETCH") this.sendSocketNotification("OS_CAL_REFETCH", p || {});
  }
});
