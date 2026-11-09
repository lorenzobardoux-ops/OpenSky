/* OpenSky shared screen-side helpers (loaded by modules via getScripts: "modules/opensky-lib/client/opensky-client.js").
 * Defines window.OpenSkyEventColors and window.OpenSkyFit. Safe to load more than once.
 */
(function () {
  if (window.OpenSkyEventColors) return;
  // texts in the screen's language (lib/client/i18n.js, loaded before this file; without it: English)
  const osT = (text, vars) => (window.OpenSkyI18n ? window.OpenSkyI18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m)));

  /* ---------- Event colors ----------
   * Every event gets a pale background + a solid side bar from a named palette. Choose colors in opensky.json:
   *   calendar.colors.calendars: { "<calendar name>": "blue" }       — all events of one calendar
   *   calendar.colors.rules: [{ "match": "dentist", "color": "indigo" }] — title keywords (case-insensitive)
   *   calendar.sources[].color                                         — a source's own color
   * Anything else gets a palette color picked from its title, so the same title always has the same color. */
  const PALETTE = {
    pink: ["#ffc2e2", "#dd4f98"], green: ["#d7f199", "#78b014"], blue: ["#b9ddff", "#2e8bd6"],
    orange: ["#ffc9a3", "#ec7a2c"], yellow: ["#ffe882", "#cfa000"], emerald: ["#b5edc4", "#2e9e57"],
    purple: ["#cdb4ff", "#7b4ae2"], red: ["#ffb3b3", "#e04848"], teal: ["#95e8d6", "#11998e"],
    indigo: ["#b8c2ff", "#4a5bd8"], tan: ["#efd9b5", "#b8864b"], gray: ["#e5e7eb", "#9ca3af"]
  };
  const AUTO = ["pink", "green", "blue", "orange", "yellow", "emerald"];

  // a color code (#rgb / #rrggbb, any case) → "#rrggbb", else null
  const hexCode = (v) => { const m = String(v == null ? "" : v).trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/); return m ? `#${m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1]}` : null; };
  // a palette name or a color code → the name / "#rrggbb", else null
  const colorOf = (v) => (PALETTE[v] ? v : hexCode(v));
  // the pale background that goes with a color code (the palette's pairs are about this light)
  const paleOf = (hex) => `color-mix(in srgb, ${hex} 32%, white)`;

  // One event wherever it's kept: its title, start and end ("<title>|<start ms>|<end ms>"). The calendars a template
  // event was placed in (MMM-OpenSky-Calendars sets window.OpenSkyEventCopies) are found by it.
  // (all-day: by its day — calendars keep its start at local or UTC midnight)
  window.OpenSkyEventKey = (ev) => {
    const title = String(ev.title || "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).toLowerCase().replace(/\s+/g, " ").trim();
    if (ev.allDay === true || ev.fullDayEvent === true || ev.fullDayEvent === "true") {
      const d = new Date(Number(ev.startDate) + 12 * 3600e3);   // (noon of its day, either way)
      const day = (t) => `${t.getUTCFullYear()}-${t.getUTCMonth() + 1}-${t.getUTCDate()}`;
      return `${title}|day|${day(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())))}|${Math.round((Number(ev.endDate) - Number(ev.startDate)) / 86400e3)}`;
    }
    return `${title}|${Number(ev.startDate)}|${Number(ev.endDate)}`;
  };

  window.OpenSkyEventCopies = window.OpenSkyEventCopies || {};

  window.OpenSkyEventColors = {

    PALETTE,
    calendars: {},
    rules: [],
    colorOf,

    /** Called by modules with calendar.colors from the settings (any module may call it; last call wins). */
    configure(colors) {
      if (!colors) return;
      if (colors.calendars && typeof colors.calendars === "object") this.calendars = colors.calendars;
      if (Array.isArray(colors.rules)) {
        this.rules = colors.rules.filter((r) => r && r.match && colorOf(r.color))
          .map((r) => ({ re: new RegExp(String(r.match).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), color: colorOf(r.color) }));
      }
    },

    // Events placed from a template (MMM-OpenSky-Templates): their template's color, kept on the Pi, never in the
    // calendar. "<calendar>|<title>|<YYYY-MM-DD>" → color (lib/templates.js key)
    overrides: {},
    setOverrides(map) { this.overrides = map && typeof map === "object" ? map : {}; },
    overrideOf(ev) {
      if (!ev || !Object.keys(this.overrides).length) return null;
      const t = Number(ev.startDate), d = new Date(t), title = String(ev.title || "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).toLowerCase().replace(/\s+/g, " ").trim();
      const ymd = (y, m, dd) => `${y}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      // (all-day events from some calendars start at UTC midnight: that day too)
      for (const day of [ymd(d.getFullYear(), d.getMonth(), d.getDate()), ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())]) {
        const c = this.overrides[`${ev.calendarName}|${title}|${day}`];
        if (c) return colorOf(c);
      }
      return null;
    },

    // Priority: template color → keyword rule → calendar color in settings → the source's own color → a stable
    // palette color. A palette name, or a color code ("#rrggbb") where one was set.
    name(ev) {
      const tpl = this.overrideOf(ev);
      if (tpl) return tpl;
      const title = String(ev.title || "").toLowerCase().replace(/\s+/g, " ").trim();

      const rule = this.rules.find((r) => r.re.test(title));
      if (rule) return rule.color;
      const cal = colorOf(this.calendars[ev.calendarName]);
      if (cal) return cal;
      const own = colorOf(ev.colorName);
      if (own) return own;
      let hash = 0;
      for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      return AUTO[hash % AUTO.length];
    },

    /** CSS custom properties for an event element: `style="${vars(ev)}"` */
    vars(ev) { const [bg, bar] = this.pair(this.name(ev)); return `--evc-bg:${bg};--evc-bar:${bar}`; },
    bar(ev) { return this.pair(this.name(ev))[1]; },
    /** [pale background, solid bar] for a palette name or a color code */
    pair(c) { const h = hexCode(c); return h ? [paleOf(h), h] : (PALETTE[c] || PALETTE.blue); }
  };

  /* ---------- Accent color ----------
   * opensky.json → look.accent: "peach" (the default), a palette color name, or a color code (#rgb / #rrggbb).
   * The same rule as lib/accent.js (the Pi's side). Used by Settings on the screen and the phone setup page. */
  window.OpenSkyAccent = {
    PEACH: "#e8663f",
    /** A palette name, "#rrggbb" (from #rgb or #rrggbb, any case), or null when it's neither. */
    normalize(v) {
      const s = String(v == null ? "" : v).trim().toLowerCase();
      if (s === "peach" || PALETTE[s]) return s;
      const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
      return m ? `#${m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1]}` : null;
    },
    /** What someone typed into a color-code box ("3b82f6", "#3B82F6", " #abc ") → "#rrggbb", or null. */
    code(v) { const s = String(v || "").trim(); const n = this.normalize(s.startsWith("#") ? s : `#${s}`); return n && n.startsWith("#") ? n : null; },
    /** The color itself: "#rrggbb" for a name or a code. */
    hex(v) { const n = this.normalize(v); return !n || n === "peach" ? this.PEACH : n.startsWith("#") ? n : PALETTE[n][1]; },
    /** Too light for the white text on buttons (contrast below about 3:1)? */
    light(v) {
      const h = this.hex(v), c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 1.05 / (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] + 0.05) < 3;
    }
  };

  /* ---------- Two-line event names, only where there's room ----------
   * A cut-off title may wrap to a second line, but only if that can't push another event out of view. */
  window.OpenSkyFit = {
    truncated(el) { return !!el && el.scrollWidth > el.clientWidth + 1; },

    // Widen cut-off titles one at a time while `fits()` stays true (Home day tiles)
    grow(pills, titleSel, fits) {
      for (const pill of pills) {
        if (!this.truncated(pill.querySelector(titleSel))) continue;
        pill.classList.add("mf-two");
        if (!fits()) { pill.classList.remove("mf-two"); break; }
      }
    },

    // Month view: one week's event layer. CalendarExt3 places events in a grid of --maxeventlines rows
    // (grid-auto-flow: column dense); a single-day event may span 2 rows if its day has a free row.
    cx3Week(layer) {
      const evs = [...layer.querySelectorAll(":scope > .event")];
      const reset = (e) => { e.classList.remove("mf-two"); e.style.gridRow = ""; };
      evs.forEach(reset);
      const cx3 = layer.closest(".CX3");
      const lines = parseInt(getComputedStyle(cx3).getPropertyValue("--maxeventlines"), 10) || 3;
      const cols = (e) => { const m = (e.style.gridColumn || "").match(/(\d+)\s*\/\s*(\d+)/); return m ? [+m[1], +m[2]] : null; };
      const used = {};
      evs.forEach((e) => { const c = cols(e); if (c) for (let i = c[0]; i < c[1]; i++) used[i] = (used[i] || 0) + 1; });
      const shown = () => evs.filter((e) => e.getBoundingClientRect().height > 1).length;
      const before = shown();
      const changed = [];
      evs.forEach((e) => {
        const c = cols(e);
        if (!c || c[1] - c[0] !== 1 || used[c[0]] + 1 > lines) return;
        if (!this.truncated(e.querySelector(".title"))) return;
        used[c[0]]++;
        e.classList.add("mf-two");
        e.style.gridRow = "span 2";
        changed.push(e);
      });
      if (!changed.length) return;
      // Safety net: if anything got hidden or clipped, undo this week
      const box = layer.getBoundingClientRect();
      if (shown() < before || evs.some((e) => { const r = e.getBoundingClientRect(); return r.height > 1 && r.bottom > box.bottom + 1; })) changed.forEach(reset);
    },

    cx3All() {
      document.querySelectorAll(".CX3 .week .eventContainer").forEach((layer) => {
        if (layer.getBoundingClientRect().width > 0) this.cx3Week(layer);   // only while the page is visible
      });
    }
  };

  /* Shared toast: OpenSkyToast("Saved", "success" | "error" | "info"). Styles: css/opensky.css (.os-toast). */
  let toastTimer = null;
  /* Drag to scroll a box (the Settings panel…). Some touchscreens reach the page as a mouse, and a mouse drag selects
   * text instead of scrolling, so a press that moves more than a few pixels scrolls the box under it, and the tap that
   * ends the drag is dropped (it mustn't flip a switch). Real touch still scrolls natively (touch-action: pan-y in CSS;
   * the browser then cancels the pointer). Sliders, menus and text boxes keep their own dragging.
   *   OpenSkyDragScroll(panel, ".ost-body")  — panel: where presses are watched; the selector: the box that scrolls */
  window.OpenSkyDragScroll = function (host, scrollSel) {
    if (!host || host.osDragScroll) return;
    host.osDragScroll = true;
    let drag = null, dragged = false;
    host.addEventListener("pointerdown", (e) => {
      dragged = false;
      if (e.button > 0 || !e.target.closest) return;
      if (e.target.closest("input, select, textarea")) return;
      const box = e.target.closest(scrollSel);
      // (the screen is scaled to fit — look.scale / --os-zoom — so a finger's pixels are 1/zoom of the box's)
      const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--os-zoom")) || 1;
      if (box && box.scrollHeight > box.clientHeight) drag = { box, y: e.clientY, top: box.scrollTop, id: e.pointerId, on: false, zoom };
    });
    host.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y;
      if (!drag.on) {
        if (Math.abs(dy) < 10) return;
        drag.on = dragged = true;
        try { drag.box.setPointerCapture(e.pointerId); } catch (x) { /* already gone */ }
      }
      drag.box.scrollTop = drag.top - dy / drag.zoom;

      e.preventDefault();
    });
    const stop = () => { drag = null; };
    host.addEventListener("pointerup", stop);
    host.addEventListener("pointercancel", () => { drag = null; dragged = false; });
    host.addEventListener("click", (e) => { if (dragged) { dragged = false; e.stopPropagation(); e.preventDefault(); } }, true);
  };

  window.OpenSkyToast = function (message, type = "info") {

    let toast = document.querySelector(".os-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "os-toast";
      toast.setAttribute("role", "status");
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.type = type;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), type === "error" ? 5000 : 2500);
  };

  /* One list as a column (Home's lists card, the Lists page). Styles: lib/client/list-columns.css.
   * list = { id, title, color, items: [{ id, text, done? }], loaded, error }
   * on = { add(), check(item, row), edit(item) } — the caller sends OPENSKY_LIST_ADD / _CHECK / _EDIT. */
  const svg = (paths, w = 2.4) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  window.OpenSkyListColumn = {
    render(list, on, { alt = false } = {}) {
      const col = document.createElement("div");
      col.className = "lc-list" + (alt ? " alt" : "");   // default colors alternate blue, peach, blue…
      const EC = window.OpenSkyEventColors, c = EC && EC.colorOf(list.color);
      if (c) {                                             // a palette name or a color code → accent, pale tint, dark text
        const solid = EC.pair(c)[1];
        col.style.setProperty("--list-accent", solid);
        col.style.setProperty("--list-tint", `color-mix(in srgb, ${solid} 7%, white)`);
        col.style.setProperty("--list-dark", `color-mix(in srgb, ${solid} 78%, black)`);
      }
      const items = list.items || [];
      col.innerHTML = `
        <div class="lc-list-head"><span class="lc-list-title"></span><span class="lc-badge">${items.filter((it) => !it.done).length}</span></div>
        <button class="lc-add-item">${svg(`<path d="M12 5v14M5 12h14"/>`, 2)}<span>${osT("Add item")}</span></button>
        <div class="lc-items"></div>`;
      col.querySelector(".lc-list-title").textContent = list.title || osT("List");
      col.querySelector(".lc-add-item").onclick = () => on.add();
      const box = col.querySelector(".lc-items");
      if (list.loaded === false) box.innerHTML = `<div class="lc-empty">${osT("Loading…")}</div>`;
      else if (list.error && !items.length) {
        box.innerHTML = `<div class="lc-empty lc-list-error"></div>`;
        box.firstChild.textContent = list.error;
      } else if (!items.length) {
        // (no emoji: Raspberry Pi OS has no color-emoji font)
        box.innerHTML = `<div class="lc-empty lc-all-done">${svg(`<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/>`)}${osT("All done!")}</div>`;
      }
      items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "lc-item" + (item.done ? " is-done" : "");
        row.innerHTML = `<button class="lc-check" aria-label="${osT("Check off")}"></button>
<span class="lc-item-text"></span>`;
        row.querySelector(".lc-item-text").textContent = item.text;
        row.querySelector(".lc-check").onclick = () => { if (!item.done) on.check(item, row); };
        row.querySelector(".lc-item-text").onclick = () => { if (!item.done) on.edit(item); };
        box.appendChild(row);
      });
      // more items than fit: scroll (also by dragging with a finger), with a fade at the bottom while there's more
      window.OpenSkyDragScroll(col, ".lc-items");
      const fade = () => box.classList.toggle("lc-more", box.scrollTop + box.clientHeight < box.scrollHeight - 2);
      box.addEventListener("scroll", fade, { passive: true });
      requestAnimationFrame(fade);
      if (window.ResizeObserver) new ResizeObserver(fade).observe(box);
      return col;

    }
  };

  /* One icon set for the sidebar, Settings and the phone page: 24×24, 2 px round strokes (Lucide-style).
   * OpenSkyIcons.svg(name) → an <svg>; OpenSkyIcons.webPage = the icons a family can pick for a web page. */
  const ICONS = {
    calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18"/><path d="M8 13.5h.01M12 13.5h.01M16 13.5h.01M8 17.5h.01M12 17.5h.01"/>',
    lists: '<path d="M3.5 6.5l1.5 1.5 3-3M3.5 12.5l1.5 1.5 3-3M3.5 18.5l1.5 1.5 3-3"/><path d="M12 7h8.5M12 13h8.5M12 19h8.5"/>',
    food: '<path d="M5 3v7a2 2 0 0 0 2 2h1v9M10 3v7M7.5 3v6"/><path d="M18 21V3c-2.2 0-4 2.2-4 6v4h4"/>',
    wordgame: '<rect x="3" y="3" width="5" height="5" rx="1.2"/><rect x="9.5" y="3" width="5" height="5" rx="1.2"/><rect x="16" y="3" width="5" height="5" rx="1.2"/><rect x="3" y="9.5" width="5" height="5" rx="1.2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1.2"/><rect x="16" y="9.5" width="5" height="5" rx="1.2"/><path d="M3 18.5h18"/>',
    smarthome: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v10.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M8.8 14.2a4.5 4.5 0 0 1 6.4 0M10.4 16.3a2.2 2.2 0 0 1 3.2 0"/><path d="M12 18.4h.01"/>',
    embed: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
    timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
    sleep: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a6.5 6.5 0 0 0 11 11z"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2.5 3.5h3l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.5-1.1l1.6-6.3H6.4"/>',
    school: '<path d="M2 9.5 12 5l10 4.5-10 4.5z"/><path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/><path d="M22 9.5v5"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18"/>',
    heart: '<path d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.6 3.9 4.5 7 4.5c2 0 3.5 1.1 5 3 1.5-1.9 3-3 5-3 3.1 0 5.3 3.1 4.2 6.2C19.5 15.4 12 20 12 20z"/>',
    chart: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6.5" rx="1"/><rect x="10.5" y="6.5" width="3" height="11" rx="1"/><rect x="15.5" y="9" width="3" height="8.5" rx="1"/>',
    cloud: '<path d="M7 18.5h10a4.5 4.5 0 0 0 .6-9 6 6 0 0 0-11.4 1.6A3.8 3.8 0 0 0 7 18.5z"/>',
    car: '<path d="M5 16.5V12l2-5h10l2 5v4.5"/><path d="M3.5 16.5h17v2.5h-3v-2.5M6.5 19v-2.5"/><circle cx="7.5" cy="13.5" r=".9"/><circle cx="16.5" cy="13.5" r=".9"/><path d="M5 12h14"/>',
    paw: '<circle cx="7" cy="10" r="1.8"/><circle cx="10.5" cy="6.5" r="1.8"/><circle cx="14.5" cy="6.5" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M12 12c-2.8 0-5 2.9-5 5.2 0 1.6 1.3 2.3 2.7 2.3 1 0 1.6-.5 2.3-.5s1.3.5 2.3.5c1.4 0 2.7-.7 2.7-2.3C17 14.9 14.8 12 12 12z"/>',
    book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"/>'
  };
  window.OpenSkyIcons = {
    paths: ICONS,
    webPage: ["embed", "smarthome", "globe", "camera", "play", "music", "cart", "food", "school", "briefcase", "heart", "chart", "cloud", "car", "paw", "book"],
    svg(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.embed}</svg>`; }
  };
})();
