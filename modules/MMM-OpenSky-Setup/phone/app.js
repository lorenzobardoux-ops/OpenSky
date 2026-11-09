/* OpenSky phone setup — the page the phone opens (served by MMM-OpenSky-Setup's node helper on the Pi).
 * Pair with the code on the screen, then edit the family's settings. Secrets (links, passwords, tokens) are
 * write-only: the Pi says which are set, never what they are. No libraries; everything is built with el().
 */
(() => {
  "use strict";
  const $app = document.getElementById("app");
  // texts in the screen's language (lib/client/i18n.js; the Pi serves it with opensky.json's language set)
  const osT = (text, vars) => (window.OpenSkyI18n ? window.OpenSkyI18n.t(text, vars) : text);
  let S = null;              // opensky.json being edited
  let secretsSet = new Set(); // dotted paths of secrets already saved on the Pi
  let pending = {};          // secret changes to send: path → value | null (remove)
  let info = {};             // { presets, timezone, service }
  let dirty = false, saved = false, busy = false;

  /* ---------------- tiny helpers ---------------- */
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "html") e.innerHTML = v;   // only ever used with fixed markup (icons)
      else if (k === "style") String(v).split(";").forEach((d) => { const i = d.indexOf(":"); if (i > 0) e.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); });   // (CSP: no style attributes)
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  // When the screen can't be reached the browser only says "Load failed" / "Failed to fetch": say what to check instead
  const OFFLINE = () => osT("Can't reach the screen. Check this phone is on the same Wi-Fi as the screen and that setup is still open there (Settings → Set up from your phone), then try again.");
  const api = async (method, url, body) => {
    let r;
    try { r = await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-OpenSky": "1" }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { throw new Error(OFFLINE()); }
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && d.pair) { showPair(); throw Object.assign(new Error(osT("Please pair again")), { pair: true }); }
    if (!r.ok) throw new Error(d.error || osT("Error {status}", { status: r.status }));

    return d;
  };
  const palette = () => (window.OpenSkyEventColors && window.OpenSkyEventColors.PALETTE) || { blue: ["#b9ddff", "#2e8bd6"] };
  const COLORS = ["blue", "pink", "green", "orange", "purple", "teal", "red", "yellow", "emerald", "indigo", "tan", "gray"];
  const hex = (name) => name === "peach" ? "#e8663f" : /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name || "") ? name : (palette()[name] || palette().blue)[1];   // (a color code shows as itself)
  const ICON = {
    logo: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>`,
    family: `<svg viewBox="0 0 24 24"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9v11h14V9"/><path d="M10 20v-5h4v5"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18"/></svg>`,
    lists: `<svg viewBox="0 0 24 24"><path d="M3.5 6.5l1.5 1.5 3-3M3.5 12.5l1.5 1.5 3-3M3.5 18.5l1.5 1.5 3-3"/><path d="M12 7h8.5M12 13h8.5M12 19h8.5"/></svg>`,
    photos: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>`,
    pages: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="18" rx="2"/><rect x="14" y="3" width="7" height="8" rx="2"/><rect x="14" y="15" width="7" height="6" rx="2"/></svg>`,
    web: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
    extras: `<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
    up: `<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>`,
    down: `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M10 3.5h4M6 7l1 13h10l1-13"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
    lock: `<svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="11" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`,
    backup: `<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`
  };
  const icon = (n, cls = "ic") => el("span", { class: cls, html: ICON[n] });
  const change = () => { dirty = true; saved = false; renderBar(); };
  const setSecret = (p, v) => { pending[p] = v; change(); };
  const isSet = (p) => (p in pending ? pending[p] !== null && pending[p] !== "" : secretsSet.has(p) || [...secretsSet].some((x) => x.startsWith(p + ".")));

  let toastTimer;
  function toast(msg, kind = "") {
    let t = document.querySelector(".toast");
    if (!t) { t = el("div", { class: "toast", role: "status" }); document.body.append(t); }
    t.textContent = msg; t.className = `toast show ${kind}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = `toast ${kind}`; }, kind === "bad" ? 8000 : 2600);   // problems stay long enough to read
  }

  /* ---------------- form controls ---------------- */
  const field = (label, input, hint) => el("label", { class: "field" }, el("span", { class: "label" }, label), input, hint ? el("span", { class: "hint" }, hint) : null);
  function text(value, onchange, attrs = {}) {
    return el("input", { type: "text", class: "input", value: value || "", autocomplete: "off", ...attrs, oninput: (e) => onchange(e.target.value) });
  }
  function secretInput(path, placeholder) {
    return el("input", { type: "password", class: "input", autocomplete: "off", placeholder: isSet(path) ? osT("Saved ✓ — type to replace") : placeholder, oninput: (e) => setSecret(path, e.target.value) });
  }
  function seg(options, value, onpick) {
    const box = el("div", { class: "seg", role: "radiogroup" });
    options.forEach(([v, label]) => box.append(el("button", { type: "button", class: v === value ? "on" : "", role: "radio", "aria-checked": String(v === value), onclick: () => { [...box.children].forEach((b) => { b.className = ""; b.setAttribute("aria-checked", "false"); }); const b = box.children[options.findIndex((o) => o[0] === v)]; b.className = "on"; b.setAttribute("aria-checked", "true"); onpick(v); } }, label)));
    return box;
  }
  function toggle(on, onflip, label) {
    const b = el("button", { type: "button", class: `toggle${on ? " on" : ""}`, role: "switch", "aria-checked": String(!!on), "aria-label": label }, el("span"));
    b.onclick = () => { const v = !b.classList.contains("on"); b.classList.toggle("on", v); b.setAttribute("aria-checked", String(v)); onflip(v); };
    return b;
  }
  function chips(value, onpick, colors = COLORS) {
    const box = el("div", { class: "chips" });
    colors.forEach((c) => box.append(el("button", { type: "button", class: `chip${c === value ? " on" : ""}`, style: `--c:${hex(c)}`, "aria-label": c, onclick: (e) => { box.querySelectorAll(".chip").forEach((x) => x.classList.remove("on")); e.currentTarget.classList.add("on"); onpick(c); } })));
    return box;
  }
  // a calendar's or list's color: a palette chip, or any color as a code (the phone's color picker or typed)
  function colorField(value, onpick) {
    const A = window.OpenSkyAccent, custom = /^#/.test(value || "") ? value : "";
    const box = chips(custom ? "" : value, (c) => { code.value = ""; code.classList.remove("bad"); picker.value = A.hex(c); onpick(c); });
    const useCode = (c) => { box.querySelectorAll(".chip").forEach((x) => x.classList.remove("on")); onpick(c); };
    const picker = el("input", { type: "color", class: "color-pick", value: custom || A.hex(value || "blue"), "aria-label": osT("Pick any color"),
      oninput: (e) => { code.value = e.target.value; code.classList.remove("bad"); useCode(e.target.value); } });
    const code = el("input", { type: "text", class: "input hex-input", value: custom, placeholder: "#8cbfc4", maxlength: "7", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": osT("Color code"),
      oninput: (e) => { const c = A.code(e.target.value); e.target.classList.remove("bad"); if (c) { picker.value = c; useCode(c); } },
      onblur: (e) => { e.target.classList.toggle("bad", !!e.target.value.trim() && !A.code(e.target.value)); } });
    return el("div", { class: "field" }, el("span", { class: "label" }, osT("Color")), box, el("div", { class: "hex-row" }, picker, code));
  }
  // the same icons as the screen's sidebar (OpenSkyIcons in opensky-client.js)
  function iconPicker(value, onpick) {
    const box = el("div", { class: "icon-grid" });
    const names = (window.OpenSkyIcons && window.OpenSkyIcons.webPage) || ["embed"];
    names.forEach((n) => box.append(el("button", { type: "button", class: `icon-pick${n === value ? " on" : ""}`, "aria-label": n, html: window.OpenSkyIcons ? window.OpenSkyIcons.svg(n) : "",
      onclick: (e) => { box.querySelectorAll(".icon-pick").forEach((x) => x.classList.remove("on")); e.currentTarget.classList.add("on"); onpick(n); } })));
    return box;
  }

  function select(options, value, onpick) {
    const s = el("select", { class: "input", onchange: (e) => onpick(e.target.value) });
    options.forEach(([v, label]) => s.append(el("option", { value: v, selected: v === value }, label)));
    return s;
  }
  const section = (id, iconName, title, sub, ...body) => el("section", { class: "card", id }, el("header", { class: "card-head" }, icon(iconName, "card-ic"), el("div", {}, el("h2", {}, title), sub ? el("p", {}, sub) : null)), ...body);
  const row = (dotColor, title, sub, onclick, extra) => el("button", { type: "button", class: "row", onclick }, el("span", { class: "dot", style: `--c:${dotColor}` }), el("span", { class: "row-main" }, el("b", {}, title), sub ? el("small", {}, sub) : null), extra || icon("chevron", "row-go"));

  /* ---------------- bottom sheet ---------------- */
  function sheet(title, build, actions) {
    const close = () => { back.classList.remove("show"); setTimeout(() => back.remove(), 250); document.body.classList.remove("noscroll"); };
    const body = el("div", { class: "sheet-body" });
    const foot = el("div", { class: "sheet-foot" });
    const back = el("div", { class: "sheet-back", onclick: (e) => { if (e.target === back) close(); } },
      el("div", { class: "sheet", role: "dialog", "aria-label": title }, el("div", { class: "grab" }), el("h3", {}, title), body, foot));
    build(body);
    actions.forEach(([label, cls, fn]) => foot.append(el("button", { type: "button", class: `btn ${cls}`, onclick: () => { if (fn() !== false) close(); } }, label)));
    document.body.append(back);
    document.body.classList.add("noscroll");
    requestAnimationFrame(() => back.classList.add("show"));
    return close;
  }

  /* ---------------- pairing ---------------- */
  function showPair(err) {
    $app.innerHTML = "";
    const input = el("input", { class: "code-input", inputmode: "numeric", pattern: "[0-9]*", maxlength: "6", autocomplete: "one-time-code", "aria-label": osT("Pairing code") });
    const boxes = el("div", { class: "code-boxes", onclick: () => input.focus() });
    const draw = () => { boxes.innerHTML = ""; for (let i = 0; i < 6; i++) boxes.append(el("span", { class: i === input.value.length ? "cur" : "" }, input.value[i] || "")); };
    const msg = el("p", { class: "pair-msg" }, err || "");
    const go = el("button", { type: "button", class: "btn primary big", disabled: true }, osT("Connect"));
    const submit = async () => {
      if (input.value.length !== 6 || busy) return;
      busy = true; go.textContent = osT("Connecting…"); go.disabled = true;
      try { await api("POST", "/api/pair", { code: input.value }); busy = false; load(); }
      catch (e) { busy = false; msg.textContent = e.message; msg.className = "pair-msg bad"; input.value = ""; draw(); go.textContent = osT("Connect"); boxes.classList.remove("shake"); void boxes.offsetWidth; boxes.classList.add("shake"); }
    };
    input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 6); draw(); go.disabled = input.value.length !== 6; msg.textContent = ""; if (input.value.length === 6) submit(); });
    go.onclick = submit;
    $app.append(el("div", { class: "pair" },
      el("img", { class: "brand-icon", src: "icon.png", alt: "OpenSky" }),
      el("h1", {}, osT("Connect to your OpenSky")),
      el("p", { class: "lead" }, osT("Type the 6-digit code shown on the screen.")),
      el("div", { class: "code-wrap" }, boxes, input), msg, go,
      el("p", { class: "fine" }, osT("Only phones that know the code can change your screen. The code changes every time setup opens."))));
    draw();
    setTimeout(() => input.focus(), 300);
  }

  /* ---------------- main ---------------- */
  async function load() {   // (returns a promise; the backup restore waits on it)
    try {
      const d = await api("GET", "/api/state");
      S = d.settings; secretsSet = new Set(d.secretsSet || []); pending = {}; info = d; dirty = false; saved = false;
      for (const k of ["family", "locale", "location", "weather", "header", "calendar", "lists", "photos", "pickup", "wordgame", "embeds"]) if (!S[k] || typeof S[k] !== "object") S[k] = {};
      if (!Array.isArray(S.pages)) S.pages = ["home", "calendar", "lists", "timer"];
      if (!Array.isArray(S.calendar.sources)) S.calendar.sources = [];
      if (!Array.isArray(S.lists.lists)) S.lists.lists = [];
      if (window.OpenSkyI18n) window.OpenSkyI18n.setLanguage(S.locale.language || "en");
      render();
    } catch (e) { if (!e.pair) $app.replaceChildren(
el("div", { class: "pair" }, el("h1", {}, osT("Couldn't load")), el("p", { class: "lead" }, e.message), el("button", { class: "btn primary big", onclick: load }, osT("Try again")))); }
  }

  function render() {
    const y = window.scrollY;
    $app.innerHTML = "";
    $app.append(
      el("header", { class: "top" }, el("div", { class: "brand" }, el("img", { class: "brand-icon sm", src: "icon.png", alt: "" }), el("div", {}, el("b", {}, "OpenSky"), el("small", {}, S.family.name || osT("Setup"))))),
      el("nav", { class: "jump" }, ...[["family", osT("Family")], ["calendars", osT("Calendars")], ["lists", osT("Lists")], ["photos", osT("Photos")], ["pages", osT("Pages")], ["web", osT("Web pages")], ["extras", osT("Extras")], ["backup", osT("Backup")]].map(([id, t]) => el("a", { href: `#${id}` }, t))),
      familyCard(), calendarsCard(), listsCard(), photosCard(), pagesCard(), webCard(), extrasCard(), backupCard(),
      el("p", { class: "fine end" }, osT("Changes reach the screen when you tap Finish.")),
      el("div", { class: "bar" }));
    renderBar();
    window.scrollTo(0, y);
  }

  function renderBar() {
    const bar = document.querySelector(".bar");
    if (!bar) return;
    bar.innerHTML = "";
    if (dirty) bar.append(el("span", { class: "bar-note" }, osT("Unsaved changes")), el("button", { type: "button", class: "btn primary", onclick: save }, osT("Save")));
    else bar.append(el("span", { class: "bar-note" }, saved ? osT("Saved ✓") : osT("All saved")), el("button", { type: "button", class: "btn primary", onclick: finish }, osT("Finish")));
  }

  async function save() {
    if (busy) return;
    busy = true;
    const btn = document.querySelector(".bar .btn"); if (btn) { btn.textContent = osT("Saving…"); btn.disabled = true; }
    try {
      const r = await api("POST", "/api/save", { settings: S, secrets: pending });
      secretsSet = new Set(r.secretsSet || []); pending = {}; dirty = false; saved = true; busy = false;
      toast(osT("Saved"), "good"); render();
    } catch (e) { busy = false; toast(e.message, "bad"); renderBar(); }
  }

  async function finish() {
    if (busy) return;
    busy = true;
    try {
      const r = await api("POST", "/api/done");
      $app.innerHTML = "";
      $app.append(el("div", { class: "pair done" }, el("div", { class: "logo good" }, icon("check")),
        el("h1", {}, osT("All set!")),
        el("p", { class: "lead" }, r.restarting ? osT("Your screen is restarting with the new settings — give it about half a minute.") : osT("Saved. Restart OpenSky on the Pi to see the changes (opensky restart).")),
        el("p", { class: "fine" }, osT("To change things later: Settings → Set up from your phone."))));
    } catch (e) { busy = false; toast(e.message, "bad"); }
  }

  /* ---------------- sections ---------------- */
  function familyCard() {
    const loc = S.location, place = el("div", { class: "place" });
    const drawPlace = () => {
      place.innerHTML = "";
      place.append(el("div", { class: "place-now" }, el("b", {}, loc.name || osT("Not set")), el("small", {}, loc.latitude != null ? osT("Weather, °F/°C and clock follow this") : osT("Needed for the weather"))),
        el("button", { type: "button", class: "btn small", onclick: pickPlace }, loc.name ? osT("Change") : osT("Choose")));
    };
    const pickPlace = () => {
      let results = el("div", { class: "results" });
      const q = text("", () => {}, { placeholder: osT("Town or city, e.g. Boston"), enterkeyhint: "search" });
      const search = async () => {
        results.replaceChildren(el("p", { class: "hint" }, osT("Looking…")));
        try {
          const d = await api("GET", `/api/geocode?q=${encodeURIComponent(q.value)}`);
          results.replaceChildren(...(d.results.length ? d.results.map((r) => el("button", { type: "button", class: "row", onclick: () => { applyPlace(r); close(); } },
            el("span", { class: "row-main" }, el("b", {}, r.name), el("small", {}, [r.admin1, r.country].filter(Boolean).join(", "))), icon("chevron", "row-go"))) : [el("p", { class: "hint" }, osT("Nothing found — try a nearby bigger town."))]));
        } catch (e) { results.replaceChildren(el("p", { class: "hint bad" }, e.message)); }
      };
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
      const close = sheet(osT("Where are you?"), (b) => { b.append(el("div", { class: "search" }, q, el("button", { type: "button", class: "btn primary", onclick: search }, osT("Search"))), results); setTimeout(() => q.focus(), 300); }, [[osT("Cancel"), "", () => {}]]);
    };
    const applyPlace = (r) => {
      const us = r.country_code === "US";
      loc.name = us && r.admin1 ? `${r.name}, ${r.admin1}` : [r.name, r.country].filter(Boolean).join(", ");
      loc.latitude = Math.round(r.latitude * 10000) / 10000; loc.longitude = Math.round(r.longitude * 10000) / 10000;
      S.locale.units = ["US", "LR", "MM"].includes(r.country_code) ? "imperial" : "metric";
      if (r.country_code) { S.locale.country = r.country_code; if (S.calendar.holidays !== "none") S.calendar.holidays = r.country_code; }
      S.locale.timeFormat = ["US", "CA", "AU", "NZ", "PH", "IN", "MX"].includes(r.country_code) ? 12 : 24;
      if (r.timezone && info.timezone && r.timezone !== info.timezone) toast(osT("Heads-up: the Pi's clock is set to {timezone}", { timezone: info.timezone }), "");
      change(); render();
    };
    drawPlace();
    return section("family", "family", osT("Your family"), osT("Shown at the top of the screen"),
      field(osT("Family name"), text(S.family.name, (v) => { S.family.name = v; change(); }, { placeholder: osT("e.g. The Smiths"), maxlength: "40" })),
      el("div", { class: "field" }, el("span", { class: "label" }, osT("Town (for the weather)")), place),
      el("div", { class: "two" },
        field(osT("Temperature"), seg([["imperial", "°F"], ["metric", "°C"]], S.locale.units || "imperial", (v) => { S.locale.units = v; change(); })),
        field(osT("Clock"), seg([[12, osT("12-hour")], [24, osT("24-hour")]], S.locale.timeFormat === 24 ? 24 : 12, (v) => { S.locale.timeFormat = v; change(); }))),
      field(osT("Week starts on"), seg([[0, osT("Sunday")], [1, osT("Monday")]], S.locale.firstDayOfWeek === 1 ? 1 : 0, (v) => { S.locale.firstDayOfWeek = v; change(); })),
      // the screen's language; dates follow it (German: 08.11.2026, English: as in the US)
      field(osT("Language"), seg([["en", "English"], ["de", "Deutsch"]], /^de\b/i.test(S.locale.language || "") ? "de" : "en", (v) => {
        S.locale.language = v;
        S.locale.locale = v === "de" ? "de-DE" : (/^en-/.test(S.locale.locale || "") ? S.locale.locale : "en-US");
        if (window.OpenSkyI18n) window.OpenSkyI18n.setLanguage(v);
        change(); render();
      }), osT("Texts and dates on the screen and on this page.")));

  }

  function calendarsCard() {
    const cal = S.calendar, list = el("div", { class: "rows" });
    const kind = (c) => c.type === "local" ? osT("On this screen · add & edit on the screen") : c.type === "caldav" ? osT("iCloud / CalDAV · add & edit") : c.type === "google" ? (c.readOnly ? osT("Google · view only") : osT("Google · add & edit")) : osT("Calendar link · read-only");
    cal.sources.forEach((c, i) => list.append(row(hex(c.color || "blue"), c.name, kind(c), () => editCalendar(i))));
    if (!cal.sources.length) list.append(el("p", { class: "empty" }, osT("No calendars yet.")));
    return section("calendars", "calendar", osT("Calendars"), osT("Each with its own color"),
      list,
      el("button", { type: "button", class: "add", onclick: addCalendar }, icon("plus"), osT("Add a calendar")),
      el("div", { class: "line" }, el("span", {}, el("b", {}, osT("Public holidays")), el("small", {}, osT("{country} · on the calendar and the countdown", { country: S.locale.country || (cal.holidays && cal.holidays !== "none" ? cal.holidays : "US") }))),
        toggle(!!cal.holidays && cal.holidays !== "none", (v) => { cal.holidays = v ? (S.locale.country || "US") : "none"; change(); }, osT("Public holidays"))));
  }

  function nameOk(name, taken) {
    if (!name) return osT("Please give it a name");
    if (/[.]/.test(name)) return osT("Names can't contain a dot");
    if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return osT("That name is already used");
    return null;
  }

  function addCalendar() {
    const d = { kind: "link", name: "", color: COLORS[S.calendar.sources.length % COLORS.length], link: "", server: "icloud", url: "", user: "", pass: "", remote: "",
      g: null, gcals: null, gcal: "", gurl: "", cid: "", csec: "", gaddr: "", gbusy: false, gerr: "" };
    const err = el("p", { class: "err" });
    sheet(osT("Add a calendar"), (b) => {
      const parts = el("div");
      const draw = () => {
        parts.replaceChildren(
          ...(d.kind === "google" ? [googleBox()] : []),
          ...(d.kind !== "google" || d.gcals ? [
            field(osT("Name"), text(d.name, (v) => { d.name = v.trim(); d.named = true; }, { placeholder: d.kind === "local" ? osT("e.g. Family") : osT("e.g. Mom, School, Soccer") })),
            colorField(d.color, (c) => { d.color = c; })] : []),
          ...(d.kind === "link" ? [
            field(osT("Calendar link"), el("textarea", { class: "input", rows: "3", placeholder: "https://… or webcal://…", oninput: (e) => { d.link = e.target.value.trim(); } }), osT("Kept private on the Pi.")),
            el("details", { class: "help" }, el("summary", {}, osT("Where do I find the link?")),
              el("p", {}, el("b", {}, "Google: "), osT("on a computer, Settings → your calendar → Integrate calendar → Secret address in iCal format.")),
              el("p", {}, el("b", {}, "Outlook: "), osT("Settings → Calendar → Shared calendars → Publish a calendar → the ICS link.")),
              el("p", {}, el("b", {}, osT("iCloud (read-only): ")), osT("Calendar app → ⓘ next to the calendar → Public Calendar → Share link.")),
              el("p", {}, osT("School and team calendars usually have an “iCal”, “ICS” or “Subscribe” link.")))
          ] : []),
          ...(d.kind === "caldav" ? [
            field(osT("Service"), select([["icloud", "iCloud"], ["fastmail", "Fastmail"], ["other", osT("Nextcloud / other CalDAV")]], d.server, (v) => { d.server = v; draw(); })),
            ...(d.server === "other" ? [field(osT("Server address"), text(d.url, (v) => { d.url = v.trim(); }, { placeholder: "https://your-server/remote.php/dav/", inputmode: "url" }))] : []),
            field(d.server === "icloud" ? osT("Apple ID (email)") : osT("Username"), text(d.user, (v) => { d.user = v.trim(); }, { inputmode: "email", autocapitalize: "off" })),
            field(d.server === "icloud" ? osT("App-specific password") : osT("Password (an app password if you have one)"), el("input", { type: "password", class: "input", autocomplete: "off", oninput: (e) => { d.pass = e.target.value.trim(); } }),
              d.server === "icloud" ? osT("Not your Apple ID password: make one at appleid.apple.com → Sign-In and Security → App-Specific Passwords.") : null),
            field(osT("Calendar's name in your calendar app"), text(d.remote, (v) => { d.remote = v.trim(); }, { placeholder: osT("Same as the name above if empty") }))
          ] : []),
          ...(d.kind === "local" ? [el("p", { class: "hint" }, osT("Events are kept on the Pi — no account needed. Add and edit them right on the screen."))] : []),
          err);
      };
      // Google: sign in once (guided), then pick one of the account's calendars
      const googleBox = () => {
        const box = el("div", { class: "gbox" });
        const run = async (fn) => { d.gbusy = true; d.gerr = ""; draw(); try { await fn(); } catch (e) { d.gerr = e.message; } d.gbusy = false; draw(); };
        if (!d.g) { box.append(el("p", { class: "hint" }, osT("Checking Google…"))); api("GET", "/api/google").then((g) => { d.g = g; draw(); }, (e) => { d.gerr = e.message; d.g = { clientSet: false, signedIn: false }; draw(); }); return box; }
        if (d.g.signedIn) {
          if (!d.gcals && !d.gbusy && !d.gerr) run(async () => { d.gcals = (await api("GET", "/api/google/calendars")).calendars; });
          if (d.gcals) {
            const pick = (id) => { d.gcal = id; const c = d.gcals.find((x) => x.id === id); if (c && !d.named) d.name = c.primary ? osT("Family") : c.name.slice(0, 30); };
            if (!d.gcal && d.gcals.length) pick(d.gcals[0].id);
            box.append(el("p", { class: "good-note" }, osT("Signed in to Google ✓")),
              field(osT("Which Google calendar?"), select(d.gcals.map((c) => [c.id, `${c.primary ? osT("Main calendar") : c.name}${c.canEdit ? "" : " " + osT("(view only)")}`]), d.gcal, (v) => { pick(v); draw(); })));
          }
        } else {
          box.append(el("details", { class: "help", open: !d.g.clientSet },
            el("summary", {}, osT("First: your own Google key (once, about 5 minutes)")),
            el("p", {}, osT("Google asks every MagicMirror screen to have its own key. On a computer, open console.cloud.google.com and:")),
            el("ol", { class: "steps" },
              el("li", {}, osT("Create a project (any name, e.g. OpenSky).")),
              el("li", {}, osT("APIs & Services → Library → “Google Calendar API” → Enable.")),
              el("li", {}, osT("Google Auth platform → Get started: app name “OpenSky”, your email, audience “External”.")),
              el("li", {}, osT("Audience → Publish app → In production (otherwise the sign-in stops working after 7 days).")),
              el("li", {}, osT("Clients → Create client → type “Desktop app” → copy the Client ID and Client secret below."))),
            el("p", {}, osT("Step-by-step with pictures: docs/google-calendar.md in OpenSky."))));
          if (!d.g.clientSet) box.append(
            field("Client ID", text(d.cid, (v) => { d.cid = v.trim(); }, { placeholder: "….apps.googleusercontent.com", autocapitalize: "off" })),
            field(osT("Client secret"), el("input", { type: "password", class: "input", autocomplete: "off", value: d.csec, oninput: (e) => { d.csec = e.target.value.trim(); } })));
          if (!d.gurl) box.append(el("button", { type: "button", class: "btn primary block", disabled: d.gbusy, onclick: () => run(async () => { d.gurl = (await api("POST", "/api/google/start", d.g.clientSet ? {} : { clientId: d.cid, clientSecret: d.csec })).url; d.g.clientSet = true; }) }, d.gbusy ? osT("One moment…") : osT("Get the Google sign-in")));
          else box.append(
            el("a", { class: "btn primary block", href: d.gurl, target: "_blank", rel: "noopener" }, osT("Sign in with Google")),
            el("p", { class: "hint" }, osT("Google may say it hasn't verified the app — it's your own key: tap Advanced → Go to OpenSky, then allow both permissions. At the end your browser shows a page that can't be reached (http://127.0.0.1…). That's expected: copy that whole address and paste it here.")),
            el("textarea", { class: "input", rows: "3", placeholder: "http://127.0.0.1:53682/?code=…", oninput: (e) => { d.gaddr = e.target.value.trim(); } }, d.gaddr),
            el("button", { type: "button", class: "btn primary block", disabled: d.gbusy, onclick: () => run(async () => { const r = await api("POST", "/api/google/finish", { address: d.gaddr }); d.gcals = r.calendars; d.g.signedIn = true; }) }, d.gbusy ? osT("Signing in…") : osT("Finish sign-in")));
        }
        if (d.gerr) box.append(el("p", { class: "err" }, d.gerr));
        return box;
      };
      b.append(seg([["link", osT("Link")], ["google", "Google"], ["caldav", osT("iCloud & co.")], ["local", osT("On screen")]], d.kind, (v) => { d.kind = v; draw(); }), parts);
      draw();
    }, [[osT("Cancel"), "", () => {}], [osT("Add"), "primary", () => {
      const bad = nameOk(d.name, S.calendar.sources.map((c) => c.name)) ||
        (d.kind === "link" && !/^(https?|webcal):\/\/\S+$/i.test(d.link) ? osT("Paste the calendar's link (it starts with https:// or webcal://)") : null) ||
        (d.kind === "caldav" && (!d.user || !d.pass) ? osT("Please fill in the username and password") : null) ||
        (d.kind === "google" && !d.gcal ? osT("Sign in to Google and pick a calendar first") : null) ||
        (d.kind === "caldav" && d.server === "other" && !/^https?:\/\//.test(d.url) ? osT("Please add the server address") : null);
      if (bad) { err.textContent = bad; return false; }
      const src = { name: d.name, color: d.color };
      if (d.kind === "local") src.type = "local";
      if (d.kind === "google") { src.type = "google"; src.calendarId = d.gcal; const c = (d.gcals || []).find((x) => x.id === d.gcal); if (c && !c.canEdit) src.readOnly = true; }
      if (d.kind === "caldav") {
        src.type = "caldav";
        const url = d.server === "icloud" ? "https://caldav.icloud.com/" : d.server === "fastmail" ? "https://caldav.fastmail.com/" : d.url;
        pending[`calendar.caldav.${d.name}`] = { url, username: d.user, password: d.pass, calendar: d.remote || d.name };
      }
      if (d.kind === "link") pending[`calendar.sources.${d.name}`] = d.link;
      S.calendar.sources.push(src);
      change(); render();
    }]]);
  }

  function editCalendar(i) {
    const c = S.calendar.sources[i];
    let color = c.color || "blue";
    sheet(c.name, (b) => {
      b.append(colorField(color, (v) => { color = v; }));
      if (c.type !== "local" && c.type !== "caldav" && c.type !== "google") b.append(field(osT("Replace the link"), el("textarea", { class: "input", rows: "2", placeholder: isSet(`calendar.sources.${c.name}`) ? osT("Saved ✓ — paste a new link to replace it") : "https://… or webcal://…", oninput: (e) => { if (e.target.value.trim()) pending[`calendar.sources.${c.name}`] = e.target.value.trim(); } })));
      if (c.type === "caldav") b.append(field(osT("New password"), el("input", { type: "password", class: "input", placeholder: osT("Saved ✓ — type to replace"), oninput: (e) => { if (e.target.value.trim()) pending[`calendar.caldav.${c.name}`] = { password: e.target.value.trim() }; } })));
      if (c.type === "local") b.append(el("p", { class: "hint" }, osT("Removing it here takes it off the screen. Its events stay saved on the Pi.")));
    }, [[osT("Remove"), "danger", () => {
      S.calendar.sources.splice(i, 1);
      if (isSet(`calendar.sources.${c.name}`)) pending[`calendar.sources.${c.name}`] = null;
      if (isSet(`calendar.caldav.${c.name}`)) pending[`calendar.caldav.${c.name}`] = null;
      change(); render();
    }], [osT("Done"), "primary", () => { c.color = color; change(); render(); }]]);
  }

  // Apple Reminders: sign in (Apple ID + password, then the code Apple shows on your devices), then — when onpick is
  // given — pick one of the account's lists. The password only passes through to the Pi for this sign-in; it's never
  // kept (the Pi keeps Apple's session, like a browser you told to trust).
  function icloudBox(picked, onpick) {
    const st = { status: null, step: "id", appleId: "", password: "", code: "", lists: null, busy: false, err: "", again: false };
    const box = el("div", { class: "gbox" });
    const run = async (fn) => { st.busy = true; st.err = ""; draw(); try { await fn(); } catch (e) { st.err = e.message; } st.busy = false; draw(); };
    const loadLists = () => run(async () => { st.lists = (await api("GET", "/api/icloud/lists")).lists || []; if (onpick && st.lists.length && !st.lists.some((l) => l.title === picked())) onpick(st.lists[0].title); });
    const draw = () => {
      box.replaceChildren();
      if (!st.status) { box.append(el("p", { class: "hint" }, osT("Checking Apple Reminders…"))); return; }
      if (st.status.available === false) box.append(el("p", { class: "err" }, osT("Apple Reminders needs an update of OpenSky's helper — run ./install.sh on the Pi")));
      else if (st.status.signedIn && st.step !== "code" && !st.again) {
        box.append(el("p", { class: "good-note" }, osT("Signed in to Apple Reminders as {appleId} ✓", { appleId: st.status.appleId })));
        if (onpick) {
          if (!st.lists && !st.busy && !st.err) loadLists();
          if (st.lists) box.append(field(osT("Which Reminders list?"), select(st.lists.map((l) => [l.title, l.title]), picked(), (v) => onpick(v)),
            osT("Lists of this Apple ID, also ones it shares. A list someone else created and shares with you can't be reached — create it with this Apple ID and share it the other way round.")));
        }
        box.append(el("button", { type: "button", class: "btn small", onclick: () => { st.again = true; st.step = "id"; draw(); } }, osT("Sign in again")));
      } else if (st.step === "code") {
        box.append(el("p", { class: "hint" }, st.sms ? osT("Apple has sent you a code by text message. Type it here:") : osT("Apple shows a code on your iPhone, iPad or Mac (tap Allow first). Type it here:")),
          field(osT("Code"), text(st.code, (v) => { st.code = v; }, { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7" })),
          el("button", { type: "button", class: "btn primary block", disabled: st.busy, onclick: () => run(async () => {
            await api("POST", "/api/icloud/code", { code: st.code });
            st.password = ""; st.code = ""; st.step = "id"; st.again = false; st.lists = null;
            st.status = await api("GET", "/api/icloud");
          }) }, st.busy ? osT("One moment…") : osT("Confirm")));
      } else {
        box.append(el("p", { class: "hint" }, osT("Your Apple ID password is only used for this sign-in and isn't saved. Apple then trusts this screen for about two months; after that it asks you to sign in here again.")),
          field(osT("Apple ID (email)"), text(st.appleId || st.status.appleId, (v) => { st.appleId = v.trim(); }, { inputmode: "email", autocapitalize: "off", autocomplete: "username" })),
          field(osT("Apple ID password"), el("input", { type: "password", class: "input", autocomplete: "current-password", value: st.password, oninput: (e) => { st.password = e.target.value; } })),
          el("button", { type: "button", class: "btn primary block", disabled: st.busy, onclick: () => run(async () => {
            const r = await api("POST", "/api/icloud/signin", { appleId: st.appleId || st.status.appleId, password: st.password });
            st.password = "";
            if (r.state === "2fa") { st.step = "code"; st.sms = !!r.sms; } else { st.again = false; st.lists = null; st.status = await api("GET", "/api/icloud"); }
          }) }, st.busy ? osT("Signing in…") : osT("Sign in to Apple")));
      }
      if (st.err) box.append(el("p", { class: "err" }, st.err));
    };
    api("GET", "/api/icloud").then((s) => { st.status = s; draw(); }, (e) => { st.status = { signedIn: false }; st.err = e.message; draw(); });
    draw();
    return box;
  }

  function listsCard() {
    const L = S.lists, rows = el("div", { class: "rows" });
    const where = (l) => l.provider === "icloud" ? `${osT("Apple Reminders")} · „${l.reminderList || l.name}“` : l.provider === "todoist" ? `Todoist${l.project && l.project !== l.name ? " · " + osT("project “{project}”", { project: l.project }) : ""}` : l.provider === "homeassistant" ? `Home Assistant · ${l.entity || "?"}` : osT("On this screen");
    L.lists.forEach((l, i) => rows.append(row(hex(l.color || "blue"), l.name, where(l), () => editList(i))));
    if (!L.lists.length) rows.append(el("p", { class: "empty" }, osT("No lists yet.")));
    const usesTodoist = L.lists.some((l) => l.provider === "todoist"), usesHA = L.lists.some((l) => l.provider === "homeassistant"), usesICloud = L.lists.some((l) => l.provider === "icloud");
    return section("lists", "lists", osT("Lists"), osT("Groceries, to-dos… the first three show on Home"),
      rows,
      el("button", { type: "button", class: "add", onclick: addList }, icon("plus"), osT("Add a list")),
      usesICloud ? el("div", { class: "field" }, el("span", { class: "label" }, osT("Apple Reminders")), icloudBox()) : null,
      usesTodoist ? field(osT("Todoist API token"), secretInput("lists.todoist.token", osT("Paste your token")), osT("Todoist → Settings → Integrations → Developer → API token.")) : null,
      usesHA ? field(osT("Home Assistant address"), secretInput("homeassistant.url", "http://homeassistant.local:8123")) : null,
      usesHA ? field(osT("Home Assistant token"), secretInput("homeassistant.token", osT("Paste a long-lived access token")), osT("In Home Assistant: your profile → Security → Long-lived access tokens → Create token.")) : null);
  }

  function addList() {
    const d = { name: "", color: COLORS[(S.lists.lists.length + 3) % COLORS.length], provider: "local", project: "", entity: "", reminderList: "" };
    const err = el("p", { class: "err" });
    sheet(osT("Add a list"), (b) => {
      const extra = el("div");
      const draw = () => extra.replaceChildren(...(d.provider === "todoist" ? [field(osT("Todoist project"), text(d.project, (v) => { d.project = v.trim(); }, { placeholder: osT("Same as the list's name if empty") }))]
        : d.provider === "icloud" ? [icloudBox(() => d.reminderList, (v) => { d.reminderList = v; })]
        : d.provider === "homeassistant" ? [field(osT("Home Assistant to-do list"), text(d.entity, (v) => { d.entity = v.trim().toLowerCase(); }, { placeholder: "todo.shopping_list", autocapitalize: "off" }), osT("Its entity ID (Settings → Entities in Home Assistant). Address and token go below the lists."))]
        : [el("p", { class: "hint" }, osT("Kept on the Pi — no account needed."))]));
      b.append(field(osT("Name"), text("", (v) => { d.name = v.trim(); }, { placeholder: osT("e.g. Groceries") }), osT("On the screen. Empty with Apple Reminders: the list's name there.")),
        colorField(d.color, (c) => { d.color = c; }),
        field(osT("Kept in"), seg([["local", osT("This screen")], ["todoist", "Todoist"], ["homeassistant", "Home Assistant"], ["icloud", osT("Reminders")]], d.provider, (v) => { d.provider = v; draw(); })), extra, err);
      draw();
    }, [[osT("Cancel"), "", () => {}], [osT("Add"), "primary", () => {
      if (d.provider === "icloud" && !d.name) d.name = d.reminderList;
      const bad = (d.provider === "icloud" && !d.reminderList ? osT("Sign in to Apple and pick a list first") : null) || nameOk(d.name, S.lists.lists.map((l) => l.name)) || (d.provider === "homeassistant" && !/^todo\.[a-z0-9_]+$/.test(d.entity) ? osT("The list's entity ID looks like todo.shopping_list") : null);
      if (bad) { err.textContent = bad; return false; }
      const l = { name: d.name, color: d.color };
      if (d.provider === "todoist") { l.provider = "todoist"; if (d.project && d.project !== d.name) l.project = d.project; }
      if (d.provider === "homeassistant") { l.provider = "homeassistant"; l.entity = d.entity; }
      if (d.provider === "icloud") { l.provider = "icloud"; if (d.reminderList !== d.name) l.reminderList = d.reminderList; }

      S.lists.lists.push(l);
      if (!S.pages.includes("lists") && S.lists.lists.length > 3) S.pages.splice(Math.min(3, S.pages.length), 0, "lists");
      change(); render();
    }]]);
  }

  function editList(i) {
    const l = S.lists.lists[i];
    let color = l.color || "blue";
    sheet(l.name, (b) => {
      b.append(colorField(color, (v) => { color = v; }));
      if (!l.provider || l.provider === "local") b.append(el("p", { class: "hint" }, osT("Removing the list takes it off the screen; its items stay saved on the Pi.")));
      if (l.provider === "icloud") b.append(el("p", { class: "hint" }, osT("Removing it here only takes it off the screen; the list stays in Apple Reminders.")));

    }, [[osT("Remove"), "danger", () => { S.lists.lists.splice(i, 1); change(); render(); }], [osT("Done"), "primary", () => { l.color = color; change(); render(); }]]);
  }

  function photosCard() {
    const P = S.photos, body = el("div");
    const mode = P.enabled === false ? "off" : P.provider === "immich" ? "immich" : "folder";
    const draw = (m) => body.replaceChildren(...(m === "folder" ? [
      field(osT("Folder on the Pi"), text(P.folder || "~/Pictures", (v) => { P.folder = v.trim(); change(); }), osT("Copy photos into it over the network — or use a USB stick:")),
      el("div", { class: "line" }, el("span", {}, el("b", {}, osT("USB stick")), el("small", {}, osT("Photos in a folder named “OpenSky” on a stick"))), toggle(P.usb !== false, (v) => { P.usb = v; change(); }, osT("USB stick")))
    ] : m === "immich" ? [
      field(osT("Immich address"), text(P.url, (v) => { P.url = v.trim(); change(); }, { placeholder: "http://192.168.1.20:2283", inputmode: "url", autocapitalize: "off" })),
      field(osT("Immich API key"), secretInput("photos.immich.apiKey", osT("Paste the key")), osT("In Immich: Account Settings → API Keys."))
    ] : [el("p", { class: "hint" }, osT("No photo card — the lists get more room."))]));
    draw(mode);
    return section("photos", "photos", osT("Photos"), osT("A slideshow on the Home page"),
      seg([["folder", osT("On the Pi")], ["immich", "Immich"], ["off", osT("Off")]], mode, (m) => { P.enabled = m !== "off"; if (m !== "off") P.provider = m; change(); draw(m); }),
      body,
      field(osT("Change photo every"), select([[15, osT("15 seconds")], [30, osT("30 seconds")], [60, osT("1 minute")], [300, osT("5 minutes")]], Number(P.intervalSeconds) || 30, (v) => { P.intervalSeconds = Number(v); change(); })));
  }

  function pagesCard() {
    const names = { home: osT("Home"), calendar: osT("Calendar"), lists: osT("Lists"), wordgame: osT("Word Game"), timer: osT("Timer"), music: osT("Music") };
    for (const [k, e] of Object.entries(S.embeds)) names[k] = (e && e.title) || k;
    const all = [...S.pages.filter((p) => names[p]), ...Object.keys(names).filter((k) => !S.pages.includes(k))];
    const box = el("div", { class: "rows" });
    all.forEach((k) => {
      const on = S.pages.includes(k), i = S.pages.indexOf(k);
      box.append(el("div", { class: `pagerow${on ? "" : " off"}` },
        el("span", { class: "row-main" }, el("b", {}, names[k])),
        on ? el("span", { class: "order" },
          el("button", { type: "button", class: "mini", "aria-label": osT("Up"), disabled: i === 0, onclick: () => { S.pages.splice(i, 1); S.pages.splice(i - 1, 0, k); change(); render(); }, html: ICON.up }),
          el("button", { type: "button", class: "mini", "aria-label": osT("Down"), disabled: i === S.pages.length - 1, onclick: () => { S.pages.splice(i, 1); S.pages.splice(i + 1, 0, k); change(); render(); }, html: ICON.down })) : null,
        toggle(on, (v) => { if (v) S.pages.push(k); else if (S.pages.length > 1) S.pages.splice(S.pages.indexOf(k), 1); change(); render(); }, names[k])));
    });
    return section("pages", "pages", osT("Pages"), osT("The buttons down the left side, top to bottom. The first is where the screen goes back to when idle."), box);
  }

  function webRow(k, e, sub, onclick, extra) {
    const r = row("#6b7280", (e && e.title) || k, sub, onclick, extra);
    const ic = el("span", { class: "row-icon", html: window.OpenSkyIcons ? window.OpenSkyIcons.svg((e && e.icon) || (k === "smarthome" ? "smarthome" : "embed")) : "" });
    r.querySelector(".dot").replaceWith(ic);
    return r;
  }

  function webCard() {
    const rows = el("div", { class: "rows" });
    Object.entries(S.embeds).forEach(([k, e]) => rows.append(webRow(k, e, isSet(`embeds.${k}.pin`) ? osT("Locked with a PIN") : (e && e.url) || osT("Private address"), () => editWeb(k), isSet(`embeds.${k}.pin`) ? icon("lock", "row-go") : null)));
    if (!Object.keys(S.embeds).length) rows.append(el("p", { class: "empty" }, osT("None yet.")));
    return section("web", "web", osT("Web pages"), osT("A page of its own for a Home Assistant dashboard, a camera, a website…"),
      rows, el("button", { type: "button", class: "add", onclick: addWeb }, icon("plus"), osT("Add a web page")));
  }

  function addWeb() {
    const d = { title: "", url: "", pin: "", icon: "globe" };
    const err = el("p", { class: "err" });
    sheet(osT("Add a web page"), (b) => b.append(
      field(osT("Button label"), text("", (v) => { d.title = v.trim(); }, { placeholder: osT("e.g. Smart Home"), maxlength: "14" })),
      field(osT("Address"), text("", (v) => { d.url = v.trim(); }, { placeholder: "http://homeassistant.local:8123", inputmode: "url", autocapitalize: "off" })),
      el("div", { class: "field" }, el("span", { class: "label" }, osT("Icon")), iconPicker(d.icon, (i) => { d.icon = i; })),
      field(osT("PIN (optional)"), el("input", { type: "password", class: "input", inputmode: "numeric", maxlength: "8", placeholder: osT("4–8 digits to lock the page"), oninput: (e) => { d.pin = e.target.value.replace(/\D/g, ""); } }), osT("With a PIN, the page asks for it every time it opens.")),
      err), [[osT("Cancel"), "", () => {}], [osT("Add"), "primary", () => {
      let key = d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "web";
      if (/^[^a-z]/.test(key)) key = `web-${key}`;
      const reserved = ["home", "calendar", "lists", "wordgame", "timer", "settings"];
      while (S.embeds[key] || reserved.includes(key)) key += "-2";
      const bad = !d.title ? osT("Please give it a label") : !/^https?:\/\/\S+$/i.test(d.url) ? osT("The address starts with http:// or https://") : d.pin && !/^\d{4,8}$/.test(d.pin) ? osT("A PIN is 4 to 8 digits") : null;
      if (bad) { err.textContent = bad; return false; }
      S.embeds[key] = d.pin ? { title: d.title, icon: d.icon } : { title: d.title, icon: d.icon, url: d.url };
      if (d.pin) { pending[`embeds.${key}.url`] = d.url; pending[`embeds.${key}.pin`] = d.pin; }
      if (!S.pages.includes(key)) S.pages.splice(Math.max(1, S.pages.length - 1), 0, key);
      change(); render();
    }]]);
  }

  function editWeb(k) {
    const e = S.embeds[k];
    sheet((e && e.title) || k, (b) => b.append(el("p", { class: "hint" }, isSet(`embeds.${k}.pin`) ? osT("This page is locked with a PIN.") : osT("Address: {url}", { url: (e && e.url) || osT("private") }))),
      [[osT("Remove"), "danger", () => {
        delete S.embeds[k];
        S.pages = S.pages.filter((p) => p !== k);
        if (isSet(`embeds.${k}`)) pending[`embeds.${k}`] = null;
        change(); render();
      }], [osT("Done"), "primary", () => {}]]);
  }

  // accent color: a palette chip, or any color as a code (#rrggbb) — typed, or picked with the phone's color picker
  function accentField() {
    const A = window.OpenSkyAccent;
    const now = (S.look && S.look.accent) || "peach", custom = /^#/.test(now) ? now : "";
    const set = (c) => { S.look = S.look || {}; if (c === "peach") delete S.look.accent; else S.look.accent = c; change(); };
    const warn = el("span", { class: "hint bad", hidden: true }, osT("That color is very light: white text on buttons will be hard to read."));
    const showWarn = (c) => { warn.hidden = !(c && A.light(c)); };
    const box = chips(custom ? "" : now, (c) => { code.value = ""; code.classList.remove("bad"); picker.value = A.hex(c); showWarn(null); set(c); }, ["peach", ...COLORS.filter((c) => c !== "gray")]);
    const useCode = (c) => { box.querySelectorAll(".chip").forEach((x) => x.classList.remove("on")); showWarn(c); set(c); };
    const picker = el("input", { type: "color", class: "color-pick", value: A.hex(now), "aria-label": osT("Pick any color"),
      oninput: (e) => { code.value = e.target.value; code.classList.remove("bad"); useCode(e.target.value); } });
    const code = el("input", { type: "text", class: "input hex-input", value: custom, placeholder: "#3b82f6", maxlength: "7", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": osT("Color code"),
      oninput: (e) => { const c = A.code(e.target.value); e.target.classList.remove("bad"); if (c) { picker.value = c; useCode(c); } },
      onblur: (e) => { e.target.classList.toggle("bad", !!e.target.value.trim() && !A.code(e.target.value)); } });
    showWarn(custom || null);
    return el("div", { class: "field" }, el("span", { class: "label" }, osT("Accent color (buttons, highlights)")), box,
      el("div", { class: "hex-row" }, picker, code), el("span", { class: "hint" }, osT("Or any color: tap the swatch to pick one, or type its code (e.g. your team's color).")), warn);
  }

  function extrasCard() {
    const pk = S.pickup, hd = S.header, wg = S.wordgame, w = S.weather;
    if (!hd.sports || typeof hd.sports !== "object") hd.sports = { league: "nfl", team: "" };
    const days = [["", osT("No pickup icons")], ["monday", osT("Monday")], ["tuesday", osT("Tuesday")], ["wednesday", osT("Wednesday")], ["thursday", osT("Thursday")], ["friday", osT("Friday")]];
    const weatherKey = el("div");
    const drawWeather = (p) => weatherKey.replaceChildren(...(p === "openweathermap" ? [field(osT("OpenWeatherMap API key"), secretInput("weather.openweathermap.apiKey", osT("Paste the key")))] : []));
    drawWeather(w.provider || "open-meteo");
    return section("extras", "extras", osT("Extras"), null,
      accentField(),
      field(osT("Trash day"), select(days, pk.trashDay || "", (v) => { pk.trashDay = v; change(); })),
      (info.presets || []).length ? field(osT("City pickup schedule"), select([["", osT("None — just my trash day")], ...info.presets.map((p) => [p, p.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ (\w\w)$/, (m) => m.toUpperCase())])], pk.preset || "", (v) => { pk.preset = v; change(); }), osT("Adds recycling, yard waste and holiday delays.")) : null,
      field(osT("Or a pickup calendar link"), el("input", { type: "password", class: "input", autocomplete: "off", inputmode: "url",
        placeholder: isSet("calendar.sources.Pickup") ? osT("Saved ✓ — paste a new link to replace it") : osT("https://… (your city or ReCollect)"),
        oninput: (e) => { const v = e.target.value.trim(); pending["calendar.sources.Pickup"] = v; pk.url = v ? "secret" : (isSet("calendar.sources.Pickup") ? "secret" : ""); if (!pk.url) delete pk.url; change(); } }),
        osT("Many cities publish trash & recycling days as a calendar. Its events become the icons. Kept private (it can contain your address).")),
      el("div", { class: "two" },
        field(osT("Sports league"), select([["nfl", "NFL"], ["college-football", osT("College football")], ["nba", "NBA"], ["wnba", "WNBA"], ["mens-college-basketball", osT("College basketball")], ["mlb", "MLB"], ["nhl", "NHL"], ["mls", "MLS"], ["nwsl", "NWSL"], ["epl", osT("Premier League")]], hd.sports.league || "nfl", (v) => { hd.sports.league = v; change(); })),
        field(osT("Team code"), text(hd.sports.team, (v) => { hd.sports.team = v.trim().toUpperCase(); change(); }, { placeholder: osT("e.g. NE"), maxlength: "5", autocapitalize: "characters" }), osT("Game-day pill. Empty = off."))),
      el("div", { class: "line" }, el("span", {}, el("b", {}, osT("Formula 1")), el("small", {}, osT("The next race and the days until it, at the top of the screen"))),
        toggle(hd.f1 === true, (v) => { if (v) hd.f1 = true; else delete hd.f1; change(); }, osT("Formula 1"))),

      field(osT("Word game"), seg([["nyt", osT("NYT's daily word")], ["opensky", osT("OpenSky's words")]], wg.source === "opensky" ? "opensky" : "nyt", (v) => { wg.source = v; change(); })),
      ...musicFields(),
      field(osT("Weather from"), seg([["open-meteo", osT("Open-Meteo (free)")], ["openweathermap", "OpenWeatherMap"]], w.provider || "open-meteo", (v) => { w.provider = v; change(); drawWeather(v); })),
      weatherKey);
  }

  // Music page: this screen as a speaker (the add-on: name, AirPlay / Spotify) and other speakers to control
  // (Home Assistant media players). Shown once the Music page is on, or the add-on is installed.
  function musicFields() {
    const inst = (info.addons && info.addons.music) || {};
    if (!S.pages.includes("music") && !inst.spotify && !inst.airplay) return [];
    if (!S.music || typeof S.music !== "object") S.music = {};
    const M = S.music;
    if (!Array.isArray(M.speakers)) M.speakers = [];
    const others = el("div", { class: "rows" });
    let found = null;   // [{ id, name, state }] once looked up
    const drawOthers = () => {
      const list = found ? [...found, ...M.speakers.filter((id) => !found.some((f) => f.id === id)).map((id) => ({ id, name: id, state: osT("not found") }))]
        : M.speakers.map((id) => ({ id, name: id, state: "" }));
      others.replaceChildren(...list.map((sp) => el("div", { class: "line" },
        el("span", {}, el("b", {}, sp.name), el("small", {}, sp.state && sp.state !== "unknown" ? `${sp.id} · ${sp.state}` : sp.id)),
        toggle(M.speakers.includes(sp.id), (v) => { M.speakers = v ? [...M.speakers.filter((x) => x !== sp.id), sp.id] : M.speakers.filter((x) => x !== sp.id); change(); }, sp.name))));
      if (found && !found.length) others.append(el("p", { class: "hint" }, osT("Home Assistant has no speakers (media players).")));
    };
    drawOthers();
    const haSet = isSet("homeassistant.url") && isSet("homeassistant.token");
    const find = el("button", { type: "button", class: "btn block", onclick: async (e) => {
      if (Object.keys(pending).some((k) => k.startsWith("homeassistant."))) return toast(osT("Save first, then look for speakers"), "bad");
      const b = e.currentTarget; b.disabled = true; b.textContent = osT("Looking…");
      try { found = (await api("GET", "/api/music/speakers")).speakers; drawOthers(); }
      catch (x) { toast(x.message, "bad"); }
      b.disabled = false; b.textContent = osT("Find my speakers");
    } }, osT("Find my speakers"));
    return [
      el("h4", { class: "sub-title" }, osT("Music")),
      !inst.spotify && !inst.airplay ? el("p", { class: "hint" }, osT("To use this screen as a speaker, on the Pi open Terminal and type  opensky addon music. Other speakers (below) work without it.")) : null,
      field(osT("Speaker name"), text(M.name || "", (v) => { M.name = v.trim(); if (!M.name) delete M.name; change(); }, { placeholder: S.family.name || "OpenSky", maxlength: "40" }), osT("What phones show in the AirPlay and Spotify speaker lists.")),
      el("div", { class: "line" }, el("span", {}, el("b", {}, "AirPlay"), el("small", {}, osT("iPhone, iPad, Mac"))), toggle(M.airplay !== false, (v) => { M.airplay = v; change(); }, "AirPlay")),
      el("div", { class: "line" }, el("span", {}, el("b", {}, "Spotify Connect"), el("small", {}, osT("Needs Spotify Premium"))), toggle(M.spotify !== false, (v) => { M.spotify = v; change(); }, "Spotify Connect")),
      el("h4", { class: "sub-title" }, osT("Other speakers to control")),
      el("p", { class: "hint" }, osT("Sonos, HomePod, Echo, Google speakers… through Home Assistant: the Music page gets a tab for each, with its song, buttons and volume.")),
      ...(haSet ? [] : [field(osT("Home Assistant address"), secretInput("homeassistant.url", "http://homeassistant.local:8123")),
        field(osT("Home Assistant token"), secretInput("homeassistant.token", osT("Paste a long-lived access token")), osT("In Home Assistant: your profile → Security → Long-lived access tokens → Create token. Save, then Find my speakers."))]),
      others, find
    ];
  }

  function backupCard() {
    const link = el("a", { class: "btn primary block", href: "/api/backup", download: "" }, osT("Download a backup"));
    const file = el("input", { type: "file", accept: "application/json,.json", class: "hidden-file", onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      let backup;
      try { backup = JSON.parse(await f.text()); } catch (x) { return toast(osT("That file isn't an OpenSky backup"), "bad"); }
      if (!backup || backup.opensky !== "backup") return toast(osT("That file isn't an OpenSky backup"), "bad");
      const when = backup.created ? new Date(backup.created).toLocaleString(S.locale.locale || [], { dateStyle: "medium", timeStyle: "short" })
 : osT("an earlier day");
      sheet(osT("Restore this backup?"), (b) => b.append(
        el("p", { class: "hint" }, osT("From {when}. It replaces this screen's settings", { when }) + (backup.data && Object.keys(backup.data).length ? osT(", calendar events on the screen, lists and word-game stats") : "") + (backup.secrets ? osT(", and its passwords and keys") : "") + "."),
        el("p", { class: "hint" }, osT("The current files are kept as .bak copies on the Pi."))),
      [[osT("Cancel"), "", () => {}], [osT("Restore"), "primary", () => {
        api("POST", "/api/restore", { backup }).then(() => { toast(osT("Restored — tap Finish to restart the screen"), "good"); load().then(() => { saved = true; renderBar(); }); }, (x) => toast(x.message, "bad"));
      }]]);
    } });
    // automatic nightly backups to a place this Pi can reach (USB stick, network folder…)
    S.backup = S.backup || {};
    const auto = el("div", { class: "auto-backup" });
    const drawAuto = (places, st) => {
      const opts = [["", osT("Off — no automatic backups")], ...places.map((p) => [p.path, `${p.label}${p.freeMB != null ? " · " + osT("{size} free", { size: p.freeMB >= 1024 ? `${Math.round(p.freeMB / 1024)} GB` : `${p.freeMB} MB` }) : ""}`])];
      if (S.backup.destination && !places.some((p) => p.path === S.backup.destination)) opts.push([S.backup.destination, osT("{place} (not available right now)", { place: S.backup.destination })]);
      const at = st && st.last ? new Date(st.last).toLocaleString(S.locale.locale || [], { dateStyle: "medium", timeStyle: "short" }) : "";
      const last = st && st.last ? `${st.ok ? osT("Last backup: {when}", { when: at }) : osT("Last try: {when}", { when: at })}${st.ok ? " ✓" : ` — ${st.error}`}` : osT("No automatic backup yet.");
      auto.replaceChildren(
        el("h4", { class: "sub-title" }, osT("Automatic backups")),
        field(osT("Back up every night to"), select(opts, S.backup.destination || "", (v) => { if (v) S.backup.destination = v; else delete S.backup.destination; change(); }),
          osT("USB sticks and network folders the Pi can see right now. Plug in a stick (or open a network folder on the Pi) and reload to see it here.")),
        el("div", { class: "two" },
          field(osT("Time"), select([["01:00", osT("1 AM")], ["02:00", osT("2 AM")], ["03:00", osT("3 AM")], ["04:00", osT("4 AM")], ["05:00", osT("5 AM")]], S.backup.time || "03:00", (v) => { S.backup.time = v; change(); })),
          field(osT("Keep"), select([[7, osT("7 backups")], [14, osT("14 backups")], [30, osT("30 backups")], [90, osT("90 backups")]], Number(S.backup.keep) || 14, (v) => { S.backup.keep = Number(v); change(); }))),
        el("div", { class: "line top" }, el("span", {}, el("b", {}, osT("Include passwords & keys")), el("small", {}, osT("A complete copy; keep that place private"))),
          toggle(!!S.backup.includeSecrets, (v) => { S.backup.includeSecrets = v; change(); }, osT("Include passwords in automatic backups"))),
        el("p", { class: `hint${st && st.ok === false ? " bad" : ""}` }, last),
        el("button", { type: "button", class: "btn block", onclick: async (e) => {
          if (dirty) return toast(osT("Save first, then back up"), "bad");
          e.currentTarget.disabled = true;
          try { const r = await api("POST", "/api/backup/run"); toast(osT("Backed up ✓"), "good"); drawAuto(places, r.status); }
          catch (x) { toast(x.message, "bad"); api("GET", "/api/backup/places").then((d) => drawAuto(d.places, d.status), () => {}); }
        } }, osT("Back up now")));
    };
    auto.append(el("p", { class: "hint" }, osT("Looking for places to back up to…")));
    api("GET", "/api/backup/places").then((d) => drawAuto(d.places, d.status), (e) => auto.replaceChildren(el("p", { class: "hint bad" }, e.message)));

    return section("backup", "backup", osT("Backup"), osT("Keep a copy of this screen's setup — handy for a new SD card or a new Pi"),
      el("h4", { class: "sub-title" }, osT("Download a copy")),
      el("div", { class: "line top" }, el("span", {}, el("b", {}, osT("Include passwords & keys")), el("small", {}, osT("Keep that file somewhere private"))),
        toggle(false, (v) => { link.setAttribute("href", v ? "/api/backup?secrets=1" : "/api/backup"); }, osT("Include passwords"))),
      link,
      el("button", { type: "button", class: "btn block", onclick: () => file.click() }, osT("Restore from a backup")), file, auto);
  }

  /* ---------------- start ---------------- */
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  load();
})();
