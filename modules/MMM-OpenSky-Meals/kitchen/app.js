/* OpenSky kitchen page — the meal planner on a phone (served by MMM-OpenSky-Meals' node helper on the Pi).
 * Plan the week (roll, roll one again, choose, servings, cooking days, confirm), the dishes (ingredients, effort,
 * servings, cycle, season) and the shopping list (tick what's at home, send the rest to Bring!).
 * No pairing code: this page only reaches dishes and plans (never settings or passwords).
 */
(() => {
  "use strict";
  const osT = (t, v) => (window.OpenSkyI18n ? window.OpenSkyI18n.t(t, v) : t);
  const M = window.OpenSkyMeals;
  const $app = document.getElementById("app");
  let S = null;                // the state from the Pi
  let tab = "plan";            // plan | dishes | shop
  let week = null;             // the Saturday of the week shown
  let busy = false;
  let rollOpts = null;         // the last roll's options (for "roll everything again")

  /* ---------------- helpers ---------------- */
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "html") e.innerHTML = v;   // only fixed markup
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  const OFFLINE = () => osT("Can't reach the screen. Check this phone is on the same Wi-Fi as the screen, then try again.");
  async function api(method, url, body) {
    let r;
    try { r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-OpenSky": "1" }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { throw new Error(OFFLINE()); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || osT("Error {status}", { status: r.status }));
    return d;
  }
  async function change(op, body, okText) {
    if (busy) return null;
    busy = true;
    try {
      const r = await api("POST", "/api/change", { op, body });
      S = { ...r.state, bring: S.bring };
      if (okText) toast(okText, "good");
      render();
      return r;
    } catch (e) { toast(e.message, "bad"); return null; }
    finally { busy = false; }
  }
  let toastTimer;
  function toast(msg, kind = "") {
    let t = document.querySelector(".toast");
    if (!t) { t = el("div", { class: "toast", role: "status" }); document.body.append(t); }
    t.textContent = msg; t.className = `toast show ${kind}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = `toast ${kind}`; }, kind === "bad" ? 7000 : 2400);
  }
  function sheet(title, build, actions) {
    const close = () => { back.classList.remove("show"); setTimeout(() => back.remove(), 250); document.body.classList.remove("noscroll"); };
    const body = el("div", { class: "sheet-body" }), foot = el("div", { class: "sheet-foot" });
    const back = el("div", { class: "sheet-back", onclick: (e) => { if (e.target === back) close(); } },
      el("div", { class: "sheet", role: "dialog", "aria-label": title }, el("div", { class: "grab" }), el("h3", {}, title), body, foot));
    build(body, close);
    actions.forEach(([label, cls, fn]) => foot.append(el("button", { type: "button", class: `btn ${cls}`, onclick: async () => { if ((await fn()) !== false) close(); } }, label)));
    document.body.append(back);
    document.body.classList.add("noscroll");
    requestAnimationFrame(() => back.classList.add("show"));
    return close;
  }
  const field = (label, input, hint) => el("label", { class: "field" }, el("span", { class: "label" }, label), input, hint ? el("span", { class: "hint" }, hint) : null);
  function seg(options, value, onpick) {
    const box = el("div", { class: "seg", role: "radiogroup" });
    options.forEach(([v, label]) => box.append(el("button", { type: "button", class: v === value ? "on" : "", role: "radio", "aria-checked": String(v === value),
      onclick: (e) => { [...box.children].forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on"); onpick(v); } }, label)));
    return box;
  }
  function stepper(value, min, max, onset) {
    let v = value;
    const out = el("b", { class: "step-v" }, String(v));
    const set = (n) => { v = Math.min(max, Math.max(min, n)); out.textContent = String(v); onset(v); };
    return el("span", { class: "stepper" }, el("button", { type: "button", class: "mini", "aria-label": osT("Fewer"), onclick: () => set(v - 1) }, "−"), out,
      el("button", { type: "button", class: "mini", "aria-label": osT("More"), onclick: () => set(v + 1) }, "+"));
  }
  const dishOf = (id) => S.dishes.find((d) => d.id === id);
  const locale = () => undefined;   // the phone's own language for dates
  const planOf = (ws) => S.plans[ws] || null;

  /* ---------------- main ---------------- */
  async function load() {
    try {
      S = await api("GET", "/api/state");
      if (!week) week = S.plans[S.weeks.next] || !S.plans[S.weeks.current] ? S.weeks.next : S.weeks.current;
      render();
    } catch (e) {
      $app.replaceChildren(el("div", { class: "pair" }, el("h1", {}, osT("Couldn't load")), el("p", { class: "lead" }, e.message), el("button", { class: "btn primary big", onclick: load }, osT("Try again"))));
    }
  }

  function render() {
    const y = window.scrollY;
    $app.replaceChildren(
      el("header", { class: "top" }, el("div", { class: "brand" }, el("img", { class: "brand-icon sm", src: "icon.png", alt: "" }), el("div", {}, el("b", {}, osT("Kitchen")), el("small", {}, osT("Meal planner"))))),
      el("nav", { class: "jump" }, ...[["plan", osT("Plan the week")], ["shop", osT("Shopping")], ["dishes", osT("Dishes")]].map(([id, t]) =>
        el("a", { href: "#", class: tab === id ? "on" : "", onclick: (e) => { e.preventDefault(); tab = id; render(); window.scrollTo(0, 0); } }, t))),
      tab === "dishes" ? dishesCard() : tab === "shop" ? shopCard() : planCard());
    window.scrollTo(0, y);
  }

  function weekSwitch() {
    return seg([[S.weeks.current, osT("This week")], [S.weeks.next, osT("Next week")]], week, (v) => { week = v; render(); });
  }

  /* ---------------- plan the week ---------------- */
  function planCard() {
    const p = planOf(week);
    const card = el("section", { class: "card" }, el("header", { class: "card-head" }, el("div", {}, el("h2", {}, osT("Plan the week")), el("p", {}, M.week(week, locale())))), weekSwitch());
    if (!S.dishes.length) {
      card.append(el("p", { class: "empty" }, osT("No dishes yet. Add your dishes first — then roll a week.")),
        el("button", { type: "button", class: "btn primary block", onclick: () => { tab = "dishes"; render(); } }, osT("Add dishes")));
      return card;
    }
    if (!p || !p.entries.length) { card.append(rollForm(null)); return card; }
    card.append(el("p", { class: p.confirmed ? "good-note" : "hint" }, p.confirmed ? osT("Done — it's on the screen with its shopping list.") : osT("A draft: change what you like, then tap \"That's it\".")));
    const rows = el("div", { class: "plan-rows" });
    for (const e of p.entries) rows.append(entryRow(p, e));
    card.append(rows,
      el("div", { class: "plan-actions" },
        el("button", { type: "button", class: "btn", onclick: () => chooseDish(null) }, osT("+ Add a dish")),
        el("button", { type: "button", class: "btn", onclick: () => sheet(osT("Roll again"), (b, close) => b.append(rollForm(p, close)), [[osT("Cancel"), "", () => {}]]) }, osT("Roll everything again"))),
      p.confirmed ? null : el("button", { type: "button", class: "btn primary block", onclick: () => change("confirm", { weekStart: week }, osT("On the screen now")) }, osT("That's it")),
      el("button", { type: "button", class: "btn block danger-text", onclick: () => sheet(osT("Throw this plan away?"), (b) => b.append(el("p", { class: "hint" }, osT("The dishes stay; only this week's plan goes."))),
        [[osT("Keep"), "", () => {}], [osT("Throw away"), "danger", () => change("discard", { weekStart: week })]]) }, osT("Start this week over")));
    return card;
  }

  // the roll's options; in a sheet, `done` closes it after rolling
  function rollForm(p, done) {
    const days = p ? p.days : [...Array(7)].map((_, i) => { const d = new Date(...week.split("-").map((x, j) => (j === 1 ? Number(x) - 1 : Number(x)))); d.setDate(d.getDate() + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    const o = rollOpts && rollOpts.weekStart === week ? { ...rollOpts } : { weekStart: week, mode: "count", count: 4, days: [], maxEffort: (p && p.maxEffort) || 3, servings: S.settings.defaultServings || 2 };
    const box = el("div", { class: "roll" });
    const daysBox = el("div", { class: "day-picks" });
    days.forEach((d) => daysBox.append(el("button", { type: "button", class: `day-pick${o.days.includes(d) ? " on" : ""}`,
      onclick: (e) => { o.days = o.days.includes(d) ? o.days.filter((x) => x !== d) : [...o.days, d].sort(); e.currentTarget.classList.toggle("on"); } }, M.day(d, locale()))));
    const countBox = field(osT("How many cooking days"), stepper(o.count, 1, 7, (v) => { o.count = v; }));
    const show = () => { daysBox.hidden = o.mode !== "days"; countBox.hidden = o.mode !== "count"; };
    box.append(
      field(osT("Cooking days"), seg([["count", osT("A number")], ["days", osT("Pick the days")]], o.mode, (v) => { o.mode = v; show(); }),
        osT("The day a dish is cooked (for the next day). The week runs Saturday to Friday.")),
      countBox, daysBox,
      field(osT("At most this much effort"), seg([1, 2, 3, 4, 5].map((n) => [n, String(n)]), o.maxEffort, (v) => { o.maxEffort = v; }), osT("1 = very easy … 5 = a big job")),
      field(osT("Servings per dish"), stepper(o.servings, 1, 20, (v) => { o.servings = v; })),
      el("button", { type: "button", class: "btn primary block", onclick: async () => {
        if (o.mode === "days" && !o.days.length) return toast(osT("Pick at least one day"), "bad");
        rollOpts = o;
        const r = await change("roll", { weekStart: week, ...(o.mode === "days" ? { days: o.days } : { count: o.count }), maxEffort: o.maxEffort, servings: o.servings });
        if (r && r.result && r.result.found < r.result.wanted) toast(osT("Only {found} of {wanted} dishes fit (effort, season, or cooked too recently)", r.result), "bad");
        if (r && typeof done === "function") done();

      } }, osT("Roll the dishes")));
    show();
    return box;
  }

  function entryRow(p, e) {
    const dish = dishOf(e.dishId);
    if (!dish) return null;
    const daySel = el("select", { class: "input day-sel", onchange: (ev) => change("day", { weekStart: week, entryId: e.id, day: ev.target.value || null }) },
      el("option", { value: "" }, osT("No day yet")), ...p.days.map((d) => el("option", { value: d, selected: d === e.day }, M.day(d, locale(), true))));
    return el("div", { class: "plan-row" },
      el("div", { class: "plan-main" }, el("b", {}, dish.name), el("small", { title: M.effortName(dish.effort) }, `${M.effort(dish.effort)} · ${M.effortName(dish.effort)}`)),
      el("div", { class: "plan-ctl" }, daySel,
        el("span", { class: "serv" }, stepper(e.servings, 1, 20, (v) => { clearTimeout(e._t); e._t = setTimeout(() => change("servings", { weekStart: week, entryId: e.id, servings: v }), 500); }), el("small", {}, osT("servings")))),
      el("div", { class: "plan-btns" },
        el("button", { type: "button", class: "btn small", onclick: () => change("reroll", { weekStart: week, entryId: e.id }) }, osT("Roll again")),
        el("button", { type: "button", class: "btn small", onclick: () => chooseDish(e) }, osT("Choose")),
        el("button", { type: "button", class: "btn small danger-text", onclick: () => change("remove", { weekStart: week, entryId: e.id }) }, osT("Remove"))));
  }

  // pick a dish yourself: for one entry, or (null) one more for the week
  function chooseDish(entry) {
    let q = "";
    sheet(entry ? osT("Choose a dish") : osT("Add a dish"), (b, close) => {
      const list = el("div", { class: "rows" });
      const draw = () => list.replaceChildren(...S.dishes.filter((d) => d.name.toLowerCase().includes(q.toLowerCase())).map((d) =>
        el("button", { type: "button", class: "row", onclick: async () => { close(); await change("choose", { weekStart: week, entryId: entry ? entry.id : undefined, dishId: d.id, servings: S.settings.defaultServings }); } },
          el("span", { class: "row-main" }, el("b", {}, d.name), el("small", {}, `${M.effort(d.effort)} · ${d.ingredients.length} ${osT("ingredients")}`)))));
      b.append(el("input", { class: "input", placeholder: osT("Search"), oninput: (e) => { q = e.target.value; draw(); } }), list);
      draw();
    }, [[osT("Cancel"), "", () => {}]]);
  }

  /* ---------------- shopping list ---------------- */
  function shopCard() {
    const p = planOf(week);
    const card = el("section", { class: "card" }, el("header", { class: "card-head" }, el("div", {}, el("h2", {}, osT("Shopping")), el("p", {}, M.week(week, locale())))), weekSwitch());
    if (!p || !p.shopping.length) { card.append(el("p", { class: "empty" }, osT("Nothing to buy yet — plan the week first."))); return card; }
    card.append(el("p", { class: "hint" }, osT("Tick what's already at home.")));
    let cat = null;
    for (const it of p.shopping) {
      if (it.category !== cat) { cat = it.category; card.append(el("h4", { class: "sub-title" }, M.category(cat))); }
      card.append(el("button", { type: "button", class: `shop-row${it.have ? " have" : ""}`, onclick: () => change("have", { weekStart: week, key: it.key, have: !it.have }) },
        el("span", { class: "tick" }, it.have ? "✓" : ""), el("span", { class: "shop-name" }, it.name), el("span", { class: "shop-amt" }, M.amount(it))));
    }
    const need = p.shopping.filter((it) => !it.have);
    card.append(S.bring
      ? el("button", { type: "button", class: "btn primary block", disabled: !need.length, onclick: () => sendToBring(need) }, osT("Put {n} on the Bring! list", { n: need.length }))
      : el("p", { class: "hint" }, osT("Bring!: set it up on the screen under Settings → Set up from your phone → Extras.")));
    return card;
  }

  function sendToBring(need) {
    sheet(osT("Put these on the Bring! list?"), (b) => b.append(
      el("p", { class: "hint" }, osT("{n} items go onto your Bring! shopping list (with their amounts). Ticked ones stay off.", { n: need.length })),
      el("p", { class: "fine" }, need.map((it) => `${it.name}${M.amount(it) ? " (" + M.amount(it) + ")" : ""}`).join(", "))),
    [[osT("Cancel"), "", () => {}], [osT("Send to Bring!"), "primary", async () => {
      try { const r = await api("POST", "/api/bring", { weekStart: week }); toast(osT("{n} items are on the Bring! list \"{list}\"", { n: r.sent.count, list: r.sent.list }), "good"); }
      catch (e) { toast(e.message, "bad"); }
    }]]);
  }

  /* ---------------- dishes ---------------- */
  function dishesCard() {
    let q = "";
    const list = el("div", { class: "rows" });
    const draw = () => list.replaceChildren(...(S.dishes.length ? S.dishes.filter((d) => d.name.toLowerCase().includes(q.toLowerCase())).map((d) =>
      el("button", { type: "button", class: "row", onclick: () => editDish(d) },
        el("span", { class: "row-main" }, el("b", {}, d.name),
          el("small", {}, [M.effort(d.effort), `${d.servings} ${osT("servings")}`, d.cycleWeeks ? (d.cycleWeeks === 1 ? osT("once a week at most") : osT("every {n} weeks at most", { n: d.cycleWeeks })) : null, d.months.length ? osT("in season") : null].filter(Boolean).join(" · ")))))
      : [el("p", { class: "empty" }, osT("No dishes yet."))]));
    draw();
    return el("section", { class: "card" }, el("header", { class: "card-head" }, el("div", {}, el("h2", {}, osT("Dishes")), el("p", {}, osT("With their ingredients, for the planner")))),
      el("button", { type: "button", class: "add", onclick: () => editDish(null) }, osT("+ New dish")),
      S.dishes.length > 6 ? el("input", { class: "input", placeholder: osT("Search"), oninput: (e) => { q = e.target.value; draw(); } }) : null,
      list,
      el("h4", { class: "sub-title" }, osT("Standard servings")),
      field(osT("New dishes and the planner start with"), stepper(S.settings.defaultServings || 2, 1, 20, (v) => { clearTimeout(dishesCard._t); dishesCard._t = setTimeout(() => change("settings", { defaultServings: v }), 600); }),
        osT("Amounts are for this many servings; the planner scales them.")));
  }

  function editDish(dish) {
    const d = dish ? JSON.parse(JSON.stringify(dish)) : { name: "", effort: 2, servings: S.settings.defaultServings || 2, cycleWeeks: 0, months: [], ingredients: [{ name: "", amount: "", unit: "", category: "" }], notes: "" };
    const err = el("p", { class: "err" });
    sheet(dish ? osT("Change dish") : osT("New dish"), (b) => {
      const ing = el("div", { class: "ings" });
      const drawIng = () => ing.replaceChildren(...d.ingredients.map((i, n) => el("div", { class: "ing" },
        el("input", { class: "input amt", inputmode: "decimal", placeholder: osT("Amount"), value: i.amount ?? "", oninput: (e) => { i.amount = e.target.value; } }),
        el("input", { class: "input unit", placeholder: osT("Unit"), value: i.unit || "", oninput: (e) => { i.unit = e.target.value; } }),
        el("input", { class: "input iname", placeholder: osT("Ingredient"), value: i.name || "", oninput: (e) => { i.name = e.target.value; } }),
        (() => { const s = el("select", { class: "input icat", "aria-label": osT("Section"), onchange: (e) => { i.category = e.target.value; } },
          el("option", { value: "" }, osT("Section: automatic")), ...M.categories().map(([k, v]) => el("option", { value: k, selected: k === i.category }, v))); return s; })(),
        el("button", { type: "button", class: "mini", "aria-label": osT("Remove"), onclick: () => { d.ingredients.splice(n, 1); drawIng(); } }, "×"))));
      drawIng();
      const months = el("div", { class: "day-picks" });
      [...Array(12)].forEach((_, m) => months.append(el("button", { type: "button", class: `day-pick${d.months.includes(m + 1) ? " on" : ""}`,
        onclick: (e) => { d.months = d.months.includes(m + 1) ? d.months.filter((x) => x !== m + 1) : [...d.months, m + 1]; e.currentTarget.classList.toggle("on"); } },
      new Date(2000, m, 1).toLocaleDateString(undefined, { month: "short" }))));
      b.append(
        field(osT("Name"), el("input", { class: "input", value: d.name, maxlength: "80", placeholder: osT("e.g. Lasagne"), oninput: (e) => { d.name = e.target.value; } })),
        field(osT("Effort"), seg([1, 2, 3, 4, 5].map((n) => [n, String(n)]), d.effort, (v) => { d.effort = v; }), osT("1 = very easy … 5 = a big job")),
        field(osT("The amounts are for"), el("span", { class: "with-unit" }, stepper(d.servings, 1, 20, (v) => { d.servings = v; }), el("small", {}, osT("servings")))),
        field(osT("Ingredients"), ing),
        el("button", { type: "button", class: "add", onclick: () => { d.ingredients.push({ name: "", amount: "", unit: "", category: "" }); drawIng(); ing.lastElementChild.querySelector(".amt").focus(); } }, osT("+ Ingredient")),
        field(osT("At the earliest again after"), el("select", { class: "input", onchange: (e) => { d.cycleWeeks = Number(e.target.value); } },
          ...[0, 1, 2, 3, 4, 6, 8, 12, 26].map((n) => el("option", { value: n, selected: n === d.cycleWeeks }, n === 1 ? osT("1 week") : n ? osT("{n} weeks", { n }) : osT("any time")
)))),
        field(osT("Season (only in these months)"), months, osT("None picked: all year.")),
        field(osT("Notes"), el("textarea", { class: "input", rows: "3", oninput: (e) => { d.notes = e.target.value; } }, d.notes || "")),
        err);
    }, [
      ...(dish ? [[osT("Delete"), "danger", async () => {
        if (!confirm(osT("Delete \"{name}\"? It goes from the plans too.", { name: dish.name }))) return false;
        await change("deleteDish", { id: dish.id }, osT("Deleted"));
      }]] : []),
      [osT("Cancel"), "", () => {}],
      [osT("Save"), "primary", async () => {
        if (!d.name.trim()) { err.textContent = osT("Please give it a name"); return false; }
        d.ingredients = d.ingredients.filter((i) => String(i.name || "").trim());
        const r = await change("saveDish", { dish: d }, osT("Saved"));
        return r ? undefined : false;
      }]]);
  }

  load();
})();
