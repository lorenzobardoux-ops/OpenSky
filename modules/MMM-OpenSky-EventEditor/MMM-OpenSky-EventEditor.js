/* MMM-OpenSky-EventEditor
 * Event popups for the Home page and the month view: a day's list, an event's details, and add / edit / delete.
 * Shown on CALENDAR_DAY_CLICKED, CALENDAR_EVENT_CLICKED and CALENDAR_ADD_EVENT.
 * Changes go through the node helper (never from the page straight to a server) to an editable calendar:
 *   type "local"  — the on-device calendar (no account; shown again at once)
 *   type "caldav" — iCloud / Fastmail / Nextcloud… through OpenSky's calendar service on the Pi
 * Events of other calendars (links) are read-only: no Edit / Delete buttons.
 */
Module.register("MMM-OpenSky-EventEditor", {
  defaults: {
    editable: [],   // [{ name, type: "local" | "caldav" }] — built by config.js from calendar.sources
    servicePort: 5747
  },

  getStyles() { return ["MMM-OpenSky-EventEditor.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js"]; },

  start() {
    this.currentEvent = null;
    this.mode = null; // 'day', 'view', 'edit', 'create', 'confirm-delete'
    this.selectedDate = null;
    this.busy = false;
    this.pending = new Map();   // request id → resolve
    this.sendSocketNotification("OS_EV_INIT", { editable: this.config.editable, servicePort: this.config.servicePort });
  },

  locale() { return (typeof config !== "undefined" && config.locale) || "en-US"; },
  hour12() { return !(typeof config !== "undefined" && config.timeFormat === 24); },
  editableCal(name) { return this.config.editable.find((c) => c.name === name); },

  getDom() {
    // The modal is rendered on <body> (see render()), outside the fullscreen region,
    // so its backdrop really covers everything (header, "+" button, list chips).
    const wrapper = document.createElement("div");
    wrapper.className = "calendar-editor-wrapper";
    return wrapper;
  },

  render() {
    if (!this.host) {
      this.host = document.createElement("div");
      this.host.className = "calendar-editor-host";
      document.body.appendChild(this.host);
    }
    this.host.innerHTML = "";
    if (this.mode) this.host.appendChild(this.createModal());
  },

  notificationReceived(notification, payload) {
    if (notification === "OPENSKY_IDLE_RESET") {
      if (this.mode && !this.busy) this.closeModal(); // nobody touched it for a while (MMM-OpenSky-Sidebar)
      return;
    }
    if (notification === "CALENDAR_DAY_CLICKED") {
      this.day = payload; // { date: ms of local midnight, events: [...] }
      this.currentEvent = null;
      this.mode = "day";
      this.render();
    } else if (notification === "CALENDAR_EVENT_CLICKED") {
      this.day = null;
      this.currentEvent = payload;
      this.mode = "view";
      this.render();
    } else if (notification === "CALENDAR_ADD_EVENT") {
      if (!this.config.editable.length) return;
      this.day = null;
      this.currentEvent = null;
      this.selectedDate = payload?.date || new Date();
      this.mode = "create";
      this.render();
    } else if (notification === "PAGE_CHANGED" && this.mode) {
      this.closeModal();
    }
  },

  /* ---------------- modal ---------------- */

  createModal() {
    const overlay = document.createElement("div");
    overlay.className = "calendar-editor-overlay";
    // a tap outside closes it — only when the press started outside too (a finger pressed on a button that moved
    // away under it must not close the editor and lose what was typed)
    let pressedOutside = false;
    overlay.addEventListener("pointerdown", (e) => { pressedOutside = e.target === overlay; });
    overlay.onclick = (e) => {
      if (e.target === overlay && pressedOutside && !this.busy) this.closeModal();
    };

    const modal = document.createElement("div");
    modal.className = "calendar-editor-modal";

    if (this.mode === "day") modal.appendChild(this.createDayMode());
    else if (this.mode === "view") modal.appendChild(this.createViewMode());
    else if (this.mode === "edit") modal.appendChild(this.createFormMode(osT("Edit Event"), osT("Save Changes"), () => this.saveEvent()));
    else if (this.mode === "create") modal.appendChild(this.createFormMode(osT("New Event"), osT("Add Event"), () => this.createEvent()));
    else if (this.mode === "confirm-delete") modal.appendChild(this.createConfirmDelete());

    overlay.appendChild(modal);
    return overlay;
  },

  createHeader(titleText, { editButton = false, titleClass = "", back = null } = {}) {
    const header = document.createElement("div");
    header.className = titleClass ? "event-view-header" : "event-edit-header";

    if (back) {
      const backBtn = document.createElement("button");
      backBtn.className = "event-back-btn";
      backBtn.setAttribute("aria-label", osT("Back"));
      backBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"></path></svg>`;
      backBtn.onclick = back;
      header.appendChild(backBtn);
    }

    const title = document.createElement("h2");
    if (titleClass) title.className = titleClass;
    title.textContent = titleText;
    header.appendChild(title);

    if (editButton) {
      const editBtn = document.createElement("button");
      editBtn.className = "event-edit-btn";
      editBtn.innerHTML = this.getPencilIcon();
      editBtn.onclick = () => { this.mode = "edit"; this.render(); };
      header.appendChild(editBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "event-close-btn";
    closeBtn.innerHTML = "×";
    closeBtn.onclick = () => this.closeModal();
    header.appendChild(closeBtn);
    return header;
  },

  createViewMode() {
    const ev = this.currentEvent;
    const editable = this.isEditable(ev);
    const container = document.createElement("div");
    container.className = "event-view-container";
    const back = this.day ? () => { this.mode = "day"; this.currentEvent = null; this.render(); } : null;
    container.appendChild(this.createHeader(ev.title || osT("Untitled Event"), { editButton: editable, titleClass: "event-view-title", back }));

    const details = document.createElement("div");
    details.className = "event-details";
    details.appendChild(this.createDetailRow(this.getClockIcon(), this.formatEventDateTime(ev)));
    if (ev.location) details.appendChild(this.createDetailRow(this.getPinIcon(), ev.location));
    if (ev.description) details.appendChild(this.createDetailRow(this.getDocIcon(), ev.description));
    details.appendChild(this.createDetailRow(this.getCalendarIcon(), this.calendarsOf(ev).join(", ") || osT("Calendar")));
    container.appendChild(details);

    if (editable) {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "event-delete-btn";
      deleteBtn.textContent = osT("Delete Event");
      deleteBtn.onclick = () => { this.mode = "confirm-delete"; this.render(); };
      container.appendChild(deleteBtn);
    }
    return container;
  },

  createDayMode() {
    const day = new Date(this.day.date);
    const container = document.createElement("div");
    container.className = "event-view-container";
    const title = day.toLocaleDateString(this.locale(), { weekday: "long", month: "long", day: "numeric" });
    container.appendChild(this.createHeader(title, { titleClass: "event-view-title" }));

    const list = document.createElement("div");
    list.className = "day-event-list";
    if (!this.day.events.length) {
      const empty = document.createElement("div");
      empty.className = "day-empty";
      empty.textContent = osT("Nothing planned");
      list.appendChild(empty);
    }
    this.day.events.forEach((ev) => {
      const row = document.createElement("button");
      row.className = "day-event-row";
      row.style.setProperty("--event-color", this.calendarColor(ev));
      const when = document.createElement("span");
      when.className = "day-event-time";
      when.textContent = this.shortWhen(ev, day);
      const name = document.createElement("span");
      name.className = "day-event-title";
      name.textContent = ev.title;
      row.appendChild(when);
      row.appendChild(name);
      row.onclick = () => { this.currentEvent = ev; this.mode = "view"; this.render(); };
      list.appendChild(row);
    });
    container.appendChild(list);

    if (!this.config.editable.length) return container;   // read-only calendars: no "+ Add Event"
    const add = document.createElement("button");
    add.className = "event-btn event-btn-primary day-add-btn";
    add.textContent = osT("+ Add Event");
    add.onclick = () => {
      // Today: next hour from now. Other days: 9:00 AM (createFormMode rounds up an hour).
      const now = new Date();
      this.selectedDate = day.toDateString() === now.toDateString() ? now : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8);
      this.currentEvent = null;
      this.mode = "create";
      this.render();
    };
    container.appendChild(add);
    return container;
  },

  // Same colors as the calendar (window.OpenSkyEventColors)
  calendarColor(ev) {
    return window.OpenSkyEventColors ? window.OpenSkyEventColors.bar(ev) : "#9ca3af";
  },

  // "All day", "4:00 PM", or "Starts 4:00 PM"/"Until 11:00 AM" for multi-day timed events
  shortWhen(ev, day) {
    if (ev.allDay) return osT("All day");
    const start = new Date(ev.startDate);
    const end = new Date(ev.endDate);
    const t = (d) => d.toLocaleTimeString(this.locale(), { hour: "numeric", minute: "2-digit", hour12: this.hour12() });
    const sameDay = (a) => a.toDateString() === day.toDateString();
    if (sameDay(start)) return t(start);
    if (sameDay(end)) return osT("Until {time}", { time: t(end) });
    return osT("All day");
  },

  createConfirmDelete() {
    const container = document.createElement("div");
    container.className = "event-view-container";
    container.appendChild(this.createHeader(osT("Delete this event?"), { titleClass: "event-view-title" }));

    const text = document.createElement("div");
    text.className = "event-confirm-text";
    const cals = this.editableOf(this.currentEvent), cal = cals[0] || this.currentEvent.calendarName;
    const everywhere = cals.some((c) => (this.editableCal(c) || {}).type === "caldav");
    const v = { title: this.currentEvent.title, calendar: cal, calendars: cals.join(", ") };
    text.textContent = cals.length > 1 ? osT("\"{title}\" will be removed from the calendars {calendars}.", v)
      : everywhere ? osT("\"{title}\" will be removed from the {calendar} calendar on every device.", v) : osT("\"{title}\" will be removed from the {calendar} calendar.", v);

    container.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "event-actions";
    const keep = document.createElement("button");
    keep.className = "event-btn event-btn-secondary";
    keep.textContent = osT("Keep");
    keep.onclick = () => { this.mode = "view"; this.render(); };
    const del = document.createElement("button");
    del.className = "event-btn event-btn-danger";
    del.textContent = osT("Delete");
    del.onclick = () => this.deleteEvent(del);
    actions.appendChild(keep);
    actions.appendChild(del);
    container.appendChild(actions);
    return container;
  },

  createFormMode(heading, submitLabel, onSubmit) {
    const container = document.createElement("div");
    container.className = "event-edit-container";
    container.appendChild(this.createHeader(heading));

    let event;
    if (this.mode === "edit") {
      event = { ...this.currentEvent };
      // All-day events end at midnight of the following day; show the last day in the form
      if (event.allDay && event.endDate) event.endDate = Number(event.endDate) - 1;
    } else {
      // New event: next full hour, one hour long
      const start = new Date(this.selectedDate);
      start.setMinutes(0, 0, 0);
      start.setHours(start.getHours() + 1);
      event = { title: "", startDate: start, endDate: new Date(start.getTime() + 60 * 60 * 1000), allDay: false, description: "" };
    }
    container.appendChild(this.createEventForm(event));

    const actions = document.createElement("div");
    actions.className = "event-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "event-btn event-btn-secondary";
    cancelBtn.textContent = osT("Cancel");
    cancelBtn.onclick = () => {
      if (this.mode === "edit") { this.mode = "view"; this.render(); }
      else if (this.day) { this.mode = "day"; this.render(); }
      else this.closeModal();
    };
    const submitBtn = document.createElement("button");
    submitBtn.className = "event-btn event-btn-primary";
    submitBtn.textContent = submitLabel;
    submitBtn.onclick = () => onSubmit(submitBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    container.appendChild(actions);
    return container;
  },

  createEventForm(event) {
    const form = document.createElement("form");
    form.className = "event-form";
    form.id = "event-form";
    form.onsubmit = (e) => e.preventDefault();

    form.appendChild(this.createFormGroup(osT("Title"), "text", "event-title", event.title || "", true, osT("Event name")));

    // Which calendar a new event goes to (only when there's a choice)
    if (this.mode === "create" && this.config.editable.length > 1) {
      const group = document.createElement("div");
      group.className = "form-group";
      group.innerHTML = `<label for="event-calendar">${osT("Calendar")}</label><select id="event-calendar" class="form-input"></select>`;
      const sel = group.querySelector("select");
      this.config.editable.forEach((c) => { const o = document.createElement("option"); o.value = c.name; o.textContent = c.name; sel.appendChild(o); });
      form.appendChild(group);
    }

    // All-day switch
    const allDayRow = document.createElement("label");
    allDayRow.className = "event-allday-row";
    allDayRow.innerHTML = `<span>${osT("All day")}</span><input type="checkbox" id="event-all-day" class="event-switch">`;
    const allDay = allDayRow.querySelector("input");
    allDay.checked = !!event.allDay;
    form.appendChild(allDayRow);

    const grid = document.createElement("div");
    grid.className = "event-datetime-grid";
    grid.appendChild(this.createFormGroup(osT("Start Date"), "date", "event-start-date", this.formatDate(event.startDate), true));
    grid.appendChild(this.createFormGroup(osT("Start Time"), "time", "event-start-time", this.formatTime(event.startDate), true));
    grid.appendChild(this.createFormGroup(osT("End Date"), "date", "event-end-date", this.formatDate(event.endDate), true));
    grid.appendChild(this.createFormGroup(osT("End Time"), "time", "event-end-time", this.formatTime(event.endDate), true));
    form.appendChild(grid);

    const syncAllDay = () => grid.classList.toggle("all-day", allDay.checked);
    allDay.onchange = syncAllDay;
    syncAllDay();

    // Keep the end after the start when the start changes
    const startDate = grid.querySelector("#event-start-date");
    const endDate = grid.querySelector("#event-end-date");
    startDate.onchange = () => { if (endDate.value < startDate.value) endDate.value = startDate.value; };

    const descGroup = document.createElement("div");
    descGroup.className = "form-group";
    descGroup.innerHTML = `<label for="event-description">${osT("Description")}</label>`;
    const desc = document.createElement("textarea");
    desc.id = "event-description";
    desc.className = "form-textarea";
    desc.rows = 3;
    desc.placeholder = osT("Add details...");
    desc.value = event.description || "";
    descGroup.appendChild(desc);
    form.appendChild(descGroup);
    return form;
  },

  createFormGroup(label, type, id, value, required = false, placeholder = "") {
    const group = document.createElement("div");
    group.className = `form-group form-group-${type}`;

    const labelEl = document.createElement("label");
    labelEl.htmlFor = id;
    labelEl.textContent = label + (required ? " *" : "");

    const input = document.createElement("input");
    input.type = type;
    input.id = id;
    input.className = "form-input";
    input.value = value;
    input.required = required;
    if (placeholder) input.placeholder = placeholder;

    group.appendChild(labelEl);
    group.appendChild(input);
    return group;
  },

  createDetailRow(icon, text) {
    const row = document.createElement("div");
    row.className = "event-detail-row";
    const iconEl = document.createElement("div");
    iconEl.className = "event-detail-icon";
    iconEl.innerHTML = icon;
    const textEl = document.createElement("div");
    textEl.className = "event-detail-text";
    textEl.textContent = text;
    row.appendChild(iconEl);
    row.appendChild(textEl);
    return row;
  },

  /* ---------------- backend calls ---------------- */

  originalRef() {
    return {
      originalTitle: this.currentEvent.title,
      originalStart: new Date(Number(this.currentEvent.startDate)).toISOString()
    };
  },

  // Ask the node helper to make the change; it answers OS_EV_RESULT {id, ok, error}
  request(op, calendar, ref, data) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: osT("The calendar didn't answer. Try again in a minute.") }); }, 30000);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.sendSocketNotification("OS_EV", { id, op, calendar, ref, data });
    });
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_EV_RESULT" && this.pending.has(p.id)) { const done = this.pending.get(p.id); this.pending.delete(p.id); done(p); }
  },

  // The calendars an event is in: one, or — for an event placed from a template into several (shown once) — each
  // (window.OpenSkyEventCopies, set by MMM-OpenSky-Calendars). editableOf: those this screen can change.
  calendarsOf(ev) {
    const copies = ev && window.OpenSkyEventKey && (window.OpenSkyEventCopies || {})[window.OpenSkyEventKey(ev)];
    return copies && copies.includes(ev.calendarName) ? copies : (ev && ev.calendarName ? [ev.calendarName] : []);
  },
  editableOf(ev) { return this.calendarsOf(ev).filter((c) => this.editableCal(c)); },

  // calendar: one name, or a list (every copy of a template event gets the same change)
  async send(op, calendar, ref, data, button, busyLabel, successMessage) {
    if (this.busy) return;
    this.busy = true;
    const label = button ? button.textContent : "";
    if (button) { button.textContent = busyLabel; button.disabled = true; }
    const cals = Array.isArray(calendar) ? calendar : [calendar];
    const errors = [];
    for (const cal of cals) {
      const r = await this.request(op, cal, ref, data);
      if (!r.ok) errors.push(cals.length > 1 ? `${cal}: ${r.error || osT("Something went wrong")}` : (r.error || osT("Something went wrong")));
      // a linked calendar is fetched again now; the on-device calendar shows the change by itself
      else if ((this.editableCal(cal) || {}).type !== "local") this.sendNotification("OPENSKY_CALENDAR_REFETCH", { name: cal });
    }
    this.busy = false;
    if (errors.length < cals.length) {
      this.closeModal();
      this.showNotification(successMessage, "success");
    } else if (button) { button.textContent = label; button.disabled = false; }
    if (errors.length) this.showNotification(errors.join(" · "), "error");
  },

  saveEvent(button) {
    const formData = this.getFormData();
    if (!formData) return;
    // an event from a template keeps its template color (kept by MMM-OpenSky-Templates by calendar + title + day)
    const ev = this.currentEvent, cals = this.editableOf(ev);
    if (window.OpenSkyEventColors && window.OpenSkyEventColors.overrideOf(ev)) {
      const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const toDay = formData.allDay ? String(formData.startDate).slice(0, 10) : ymd(new Date(formData.startDate));
      this.sendNotification("OPENSKY_TEMPLATE_EVENT_MOVED", { calendars: cals, fromTitle: ev.title, fromDay: ymd(new Date(Number(ev.startDate))), toTitle: formData.title, toDay });
    }
    this.send("update", cals, this.originalRef(), formData, button, osT("Saving…"), osT("Event updated"));

  },

  createEvent(button) {
    const formData = this.getFormData();
    const calendar = document.getElementById("event-calendar")?.value || (this.config.editable[0] || {}).name;
    if (formData) this.send("create", calendar, null, formData, button, osT("Adding…"), osT("Event added"));
  },

  deleteEvent(button) {
    const ev = this.currentEvent, cals = this.editableOf(ev);
    if (window.OpenSkyEventColors && window.OpenSkyEventColors.overrideOf(ev)) {
      const d = new Date(Number(ev.startDate)), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      this.sendNotification("OPENSKY_TEMPLATE_EVENT_DELETED", { calendars: cals, title: ev.title, day });
    }
    this.send("delete", cals, this.originalRef(), null, button, osT("Deleting…"), osT("Event deleted"));


  },

  getFormData() {
    const val = (id) => document.getElementById(id)?.value?.trim() || "";
    const title = val("event-title");
    const allDay = document.getElementById("event-all-day")?.checked || false;
    const startDate = val("event-start-date");
    const endDate = val("event-end-date");
    const description = val("event-description");

    if (!title) { this.showNotification(osT("Please add a title"), "error"); return null; }
    if (!startDate || !endDate) { this.showNotification(osT("Please pick a start and end date"), "error"); return null; }

    if (allDay) {
      if (endDate < startDate) { this.showNotification(osT("End date must be on or after the start date"), "error"); return null; }
      return { title, allDay: true, startDate, endDate, description };
    }

    const startTime = val("event-start-time");
    const endTime = val("event-end-time");
    if (!startTime || !endTime) { this.showNotification(osT("Please pick a start and end time"), "error"); return null; }
    const start = new Date(`${startDate}T${startTime}`);
    const end = new Date(`${endDate}T${endTime}`);
    if (end <= start) { this.showNotification(osT("End time must be after start time"), "error"); return null; }
    return { title, allDay: false, startDate: start.toISOString(), endDate: end.toISOString(), description };
  },

  closeModal() {
    this.mode = null;
    this.day = null;
    this.currentEvent = null;
    this.busy = false;
    this.render();
  },

  isEditable(event) {
    return this.editableOf(event).length > 0;

  },

  /* ---------------- formatting ---------------- */

  formatEventDateTime(event) {
    if (!event.startDate) return osT("No date");
    const start = new Date(Number(event.startDate));
    if (isNaN(start)) return osT("No date");
    // All-day events end at midnight of the following day; show the last day instead
    let end = event.endDate ? new Date(Number(event.endDate)) : null;
    if (end && event.allDay) end = new Date(end.getTime() - 1);

    const day = (d) => d.toLocaleDateString(this.locale(), { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const shortDay = (d) => d.toLocaleDateString(this.locale(), { weekday: "short", month: "short", day: "numeric" });
    const time = (d) => d.toLocaleTimeString(this.locale(), { hour: "numeric", minute: "2-digit", hour12: this.hour12() });
    const sameDay = end && start.toDateString() === end.toDateString();

    if (event.allDay) {
      return (!end || sameDay) ? `${day(start)} • ${osT("All day")}` : `${shortDay(start)} – ${shortDay(end)} • ${osT("All day")}`;

    }
    if (!end || end.getTime() === start.getTime()) return `${day(start)} • ${time(start)}`;
    if (sameDay) return `${day(start)} • ${time(start)} – ${time(end)}`;
    return `${shortDay(start)}, ${time(start)} – ${shortDay(end)}, ${time(end)}`;
  },

  // Local date/time for the form inputs (toISOString would shift evening events to the next day)
  formatDate(date) {
    if (!date) return "";
    const d = new Date(typeof date === "string" && /^\d+$/.test(date) ? Number(date) : date);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  formatTime(date) {
    if (!date) return "";
    const d = new Date(typeof date === "string" && /^\d+$/.test(date) ? Number(date) : date);
    return d.toTimeString().slice(0, 5);
  },

  /* ---------------- toast ---------------- */

  showNotification(message, type) {
    Log.info(`[${type}] ${message}`);
    window.OpenSkyToast(message, type);
  },

  /* ---------------- icons ---------------- */

  getPencilIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>`;
  },

  getPinIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"></path>
      <circle cx="12" cy="10" r="2.5"></circle>
    </svg>`;
  },

  getClockIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>`;
  },

  getDocIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
      <polyline points="10 9 9 9 8 9"></polyline>
    </svg>`;
  },

  getCalendarIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="16" y1="2" x2="16" y2="6"></line>
      <line x1="8" y1="2" x2="8" y2="6"></line>
      <line x1="3" y1="10" x2="21" y2="10"></line>
    </svg>`;
  }
});
