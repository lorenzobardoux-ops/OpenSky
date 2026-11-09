/* MMM-OpenSky-Templates — event templates on the Home page (opensky.json → home.panel: "templates").
 *
 * A card where the photos would be: the family's standard events (name, notes, a time or all day, a color, and
 * optionally the calendars they go to). Drag one onto a day of the week view → that event on that day; a template
 * can be used any number of times. Tap one → change or remove it; "+ New" adds one.
 *
 * Placing creates an ordinary event through the event editor (MMM-OpenSky-EventEditor.request, so local, iCloud/CalDAV
 * and Google all work the same) in the template's calendars, or — with none chosen — in OpenSky's own on-device
 * calendar "OpenSky". The color stays on the Pi (lib/templates.js "colors") and paints the event via
 * window.OpenSkyEventColors.setOverrides; it's never written into a calendar.
 * The card is drawn into Home's <section class="hd-templates"> (and again whenever Home draws a new one).
 */
Module.register("MMM-OpenSky-Templates", {
  defaults: {
    calendars: []          // the calendars a template may also go to (built by config.js: the editable ones)
  },
  COLORS: ["blue", "pink", "green", "orange", "purple", "teal", "red", "yellow", "emerald", "indigo", "tan", "gray"],

  getStyles() { return ["MMM-OpenSky-Templates.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js"]; },

  start() {
    this.templates = [];
    this.calls = new Map();
    this.seq = 0;
    this.sendSocketNotification("OS_TPL_INIT", { calendars: this.config.calendars });
  },

  getDom() { return document.createElement("div"); },   // the card lives in Home's .hd-templates

  notificationReceived(n) {
    if (n === "DOM_OBJECTS_CREATED") {
      // Home may draw its page again: fill each new (empty) card
      new MutationObserver(() => { const host = document.querySelector(".hd-templates"); if (host && !host.firstChild) this.render(); })
        .observe(document.body, { childList: true, subtree: true });
      this.render();
    } else if ((n === "OPENSKY_IDLE_RESET" || n === "PAGE_CHANGED") && this.popup && !this.busy) this.closeForm();
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_TPL_LIST" && p && Array.isArray(p.templates)) { this.templates = p.templates; this.render(); }
    else if (n === "OS_TPL_COLORS" && p && p.colors) {
      if (window.OpenSkyEventColors) window.OpenSkyEventColors.setOverrides(p.colors);
      this.sendNotification("OPENSKY_CALENDAR_REFRESH");   // redraw the calendars with the colors
    } else if (n === "OS_TPL_RESULT" && p && this.calls.has(p.id)) { const done = this.calls.get(p.id); this.calls.delete(p.id); done(p); }
  },

  // one request to the node helper → its answer
  call(op, args) {
    const id = `t${++this.seq}`;
    return new Promise((resolve) => {
      this.calls.set(id, resolve);
      setTimeout(() => { if (this.calls.has(id)) { this.calls.delete(id); resolve({ ok: false, error: osT("Something went wrong") }); } }, 30000);
      this.sendSocketNotification("OS_TPL_CALL", { id, op, ...args });
    });
  },

  /* ---------------- the card ---------------- */
  when(t) { return t.allDay ? osT("All day") : `${this.fmt(t.start)} – ${this.fmt(t.end)}`; },
  fmt(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(config.locale || "en-US", { hour: "2-digit", minute: "2-digit", hour12: config.timeFormat !== 24 });
  },

  render() {
    const host = document.querySelector(".hd-templates");
    if (!host) return;
    host.innerHTML = `
      <header class="tp-head">
        <span class="tp-title">${this.icon("copy")} ${osT("Templates")}</span>
        <span class="tp-hint"></span>
        <button class="tp-new">${this.icon("plus")} ${osT("New")}</button>
      </header>
      <div class="tp-grid"></div>`;
    host.querySelector(".tp-hint").textContent = this.templates.length ? osT("Drag onto a day") : "";
    host.querySelector(".tp-new").onclick = () => this.openForm(null);
    const grid = host.querySelector(".tp-grid");
    if (!this.templates.length) {
      const empty = document.createElement("div");
      empty.className = "tp-empty";
      empty.textContent = osT("No templates yet. Tap New for an event you put in often — then drag it onto a day.");
      grid.appendChild(empty);
    }
    for (const t of this.templates) grid.appendChild(this.chip(t));
  },

  chip(t) {
    const el = document.createElement("div");
    el.className = "tp-chip";
    el.setAttribute("role", "button");
    const EC = window.OpenSkyEventColors, [bg, bar] = EC ? EC.pair(EC.colorOf(t.color) || "blue") : ["#b9ddff", "#2e8bd6"];
    el.style.setProperty("--tp-bg", bg);
    el.style.setProperty("--tp-bar", bar);
    el.innerHTML = `<span class="tp-chip-title"></span><span class="tp-chip-when"></span>${t.calendars && t.calendars.length ? `<span class="tp-chip-cal"></span>` : ""}`;
    el.querySelector(".tp-chip-title").textContent = t.title;
    el.querySelector(".tp-chip-when").textContent = this.when(t);
    if (t.calendars && t.calendars.length) el.querySelector(".tp-chip-cal").textContent = t.calendars.join(", ");
    this.draggable(el, t);
    return el;
  },

  /* ---------------- drag onto a day ----------------
   * Pointer events (a touchscreen may act like a mouse; HTML drag-and-drop doesn't work with touch). A press that
   * moves starts a drag: a copy of the chip follows the finger, the day under it lights up, letting go there places
   * the template. A press that doesn't move is a tap: change the template. */
  draggable(el, t) {
    let start = null, ghost = null, over = null;
    const zoom = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--os-zoom")) || 1;
    const dayAt = (x, y) => { const hit = document.elementsFromPoint(x, y).find((e) => e.classList && e.classList.contains("hd-day") && e.dataset.day); return hit || null; };
    const end = () => {
      if (ghost) ghost.remove();
      if (over) over.classList.remove("tp-drop");
      document.body.classList.remove("tp-dragging");
      ghost = null; over = null; start = null;
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* gone */ }
    });
    el.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) return;
      e.preventDefault();
      if (!start.moved) {
        start.moved = true;
        ghost = el.cloneNode(true);
        ghost.classList.add("tp-ghost");
        ghost.style.width = `${el.getBoundingClientRect().width / zoom()}px`;
        document.body.appendChild(ghost);
        document.body.classList.add("tp-dragging");
      }
      const z = zoom();
      ghost.style.left = `${e.clientX / z}px`;
      ghost.style.top = `${e.clientY / z}px`;
      const day = dayAt(e.clientX, e.clientY);
      if (day !== over) { if (over) over.classList.remove("tp-drop"); over = day; if (over) over.classList.add("tp-drop"); }
    });
    el.addEventListener("pointerup", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const moved = start.moved, day = over && over.dataset.day;
      end();
      if (!moved) this.openForm(t);
      else if (day) this.place(t, day);
    });
    el.addEventListener("pointercancel", end);
  },

  // the template's event(s) on that day: through the event editor, then remember the color
  async place(t, day) {
    if (this.placing) return;
    this.placing = true;
    try {
      const plan = await this.call("plan", { tid: t.id, day });
      if (!plan.ok) return window.OpenSkyToast(plan.error || osT("Something went wrong"), "error");
      const ee = MM.getModules().withClass("MMM-OpenSky-EventEditor")[0];
      if (!ee || typeof ee.request !== "function") return window.OpenSkyToast(osT("Events can't be added on this screen"), "error");
      const failed = [];
      for (const c of plan.creates) {
        const r = await ee.request("create", c.calendar, null, c.data);
        if (!r.ok) { failed.push(`${c.calendar}: ${r.error || osT("Something went wrong")}`); continue; }
        await this.call("placed", { calendar: c.calendar, title: c.data.title, day, color: plan.template.color });
        // the on-device calendars show it by themselves; the others are asked again now
        if (!/^OpenSky$/.test(c.calendar) && !((ee.editableCal(c.calendar) || {}).type === "local")) this.sendNotification("OPENSKY_CALENDAR_REFETCH", { name: c.calendar });
      }
      const [y, m, d] = day.split("-").map(Number);
      const label = new Date(y, m - 1, d).toLocaleDateString(config.locale || "en-US", { weekday: "short", day: "numeric", month: "short" });
      if (failed.length) window.OpenSkyToast(failed.join(" · "), "error");
      if (failed.length < plan.creates.length) window.OpenSkyToast(osT("“{title}” added on {day}", { title: t.title, day: label }), "success");
    } finally {
      this.placing = false;
    }
  },

  /* ---------------- add / change a template ---------------- */
  openForm(t) {
    this.closeForm();
    const f = t ? { ...t, calendars: [...(t.calendars || [])] } : { title: "", description: "", allDay: false, start: "09:00", end: "10:00", color: "blue", calendars: [] };
    const overlay = document.createElement("div");
    overlay.className = "tp-overlay";
    overlay.innerHTML = `
      <div class="tp-modal" role="dialog">
        <div class="tp-modal-head"><span class="tp-modal-title"></span><button class="tp-x" aria-label="${osT("Close")}">×</button></div>
        <label class="tp-field"><span>${osT("Name")}</span><input class="tp-input tp-name" maxlength="80" autocomplete="off"></label>
        <label class="tp-field"><span>${osT("Description")}</span><textarea class="tp-input tp-desc" rows="2" maxlength="2000"></textarea></label>
        <div class="tp-row"><span>${osT("All day")}</span><button class="tp-toggle" role="switch"><span></span></button></div>
        <div class="tp-row tp-times"><span>${osT("From")}</span><input type="time" class="tp-input tp-start"><span>${osT("to")}</span><input type="time" class="tp-input tp-end"></div>
        <div class="tp-field"><span>${osT("Color")}</span><div class="tp-colors"></div>
          <div class="tp-row tp-code"><span class="tp-swatch"></span><input class="tp-input tp-hex" maxlength="7" placeholder="#8cbfc4" data-okb-caps="off" autocomplete="off" spellcheck="false"></div></div>
        <div class="tp-field tp-cals-field"><span>${osT("Put it in")}</span><div class="tp-cals"></div>
          <small class="tp-note">${osT("None chosen: only on this screen (OpenSky's own calendar). The color stays on this screen either way.")}</small></div>
        <div class="tp-err" hidden></div>
        <div class="tp-actions">
          ${t ? `<button class="tp-btn tp-danger tp-remove">${osT("Delete")}</button>` : ""}
          <button class="tp-btn tp-cancel">${osT("Cancel")}</button>
          <button class="tp-btn tp-primary tp-save">${osT("Save")}</button>
        </div>
      </div>`;
    const q = (s) => overlay.querySelector(s);
    q(".tp-modal-title").textContent = t ? osT("Change template") : osT("New template");
    q(".tp-name").value = f.title;
    q(".tp-desc").value = f.description || "";
    q(".tp-start").value = f.start || "09:00";
    q(".tp-end").value = f.end || "10:00";
    const toggle = q(".tp-toggle");
    const syncAllDay = () => { toggle.classList.toggle("on", !!f.allDay); toggle.setAttribute("aria-checked", String(!!f.allDay)); q(".tp-times").hidden = !!f.allDay; };
    toggle.onclick = () => { f.allDay = !f.allDay; syncAllDay(); };
    syncAllDay();
    // colors: the palette, or any color as a code
    const EC = window.OpenSkyEventColors, A = window.OpenSkyAccent;
    const box = q(".tp-colors"), hex = q(".tp-hex"), swatch = q(".tp-swatch");
    const syncColor = () => {
      box.querySelectorAll(".tp-color").forEach((b) => b.classList.toggle("on", b.dataset.c === f.color));
      swatch.style.setProperty("--c", EC ? EC.pair(EC.colorOf(f.color) || "blue")[1] : "#2e8bd6");
    };
    for (const c of this.COLORS) {
      const b = document.createElement("button");
      b.className = "tp-color"; b.dataset.c = c; b.setAttribute("aria-label", c);
      b.style.setProperty("--c", EC ? EC.pair(c)[1] : "#999");
      b.onclick = () => { f.color = c; hex.value = ""; syncColor(); };
      box.appendChild(b);
    }
    if (/^#/.test(f.color)) hex.value = f.color;
    hex.oninput = () => { const c = A ? A.code(hex.value) : null; if (c) { f.color = c; syncColor(); } };
    syncColor();
    // the calendars it also goes to
    const cals = q(".tp-cals");
    if (!this.config.calendars.length) q(".tp-cals-field").hidden = true;
    for (const name of this.config.calendars) {
      const b = document.createElement("button");
      b.className = "tp-cal" + (f.calendars.includes(name) ? " on" : "");
      b.textContent = name;
      b.onclick = () => { f.calendars = f.calendars.includes(name) ? f.calendars.filter((x) => x !== name) : [...f.calendars, name]; b.classList.toggle("on", f.calendars.includes(name)); };
      cals.appendChild(b);
    }
    const err = (m) => { const e = q(".tp-err"); e.textContent = m || ""; e.hidden = !m; };
    const close = () => this.closeForm();
    q(".tp-x").onclick = close;
    q(".tp-cancel").onclick = close;
    let pressedOutside = false;
    overlay.addEventListener("pointerdown", (e) => { pressedOutside = e.target === overlay; });
    overlay.addEventListener("click", (e) => { if (e.target === overlay && pressedOutside && !this.busy) close(); });
    q(".tp-save").onclick = async () => {
      if (this.busy) return;
      f.title = q(".tp-name").value; f.description = q(".tp-desc").value; f.start = q(".tp-start").value; f.end = q(".tp-end").value;
      if (!f.title.trim()) return err(osT("Please give it a name"));
      this.busy = true; err("");
      const r = await this.call("save", { template: f });
      this.busy = false;
      if (!r.ok) return err(r.error);
      close();
      this.sendNotification("HIDE_KEYBOARD");
    };
    if (t) {
      const rm = q(".tp-remove");
      rm.onclick = async () => {
        if (!rm.classList.contains("tp-confirm")) { rm.classList.add("tp-confirm"); rm.textContent = osT("Tap again to delete"); return; }
        this.busy = true;
        const r = await this.call("remove", { tid: t.id });
        this.busy = false;
        if (!r.ok) return err(r.error);
        close();
      };
    }
    document.body.appendChild(overlay);
    this.popup = overlay;
    if (!t) setTimeout(() => q(".tp-name").focus(), 50);
  },

  closeForm() {
    if (this.popup) { this.popup.remove(); this.popup = null; this.sendNotification("HIDE_KEYBOARD"); }
  },

  icon(name) {
    const p = {
      copy: `<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/>`,
      plus: `<path d="M12 5v14M5 12h14"/>`
    }[name];
    return `<svg class="tp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }
});
