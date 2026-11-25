/* MMM-OpenSky-Meals — the meal planner's page (opensky.json → pages: "meals").
 *
 * The week's confirmed plan (Saturday–Friday; a day = the day a dish is cooked, for the next day): drag a dish onto a
 * day (or back to "no day yet") and it's on the calendar as "Cook: …". Next to it the shopping list for the week,
 * sorted like a shop: tick what's at home; "Send to Bring!" (asks first) puts the rest on the Bring! list.
 * Dishes and the planning itself are on the kitchen page for phones (QR code here; no pairing code), served by this
 * module's node helper, which also keeps the data (lib/meals.js, config/meals.json).
 */
Module.register("MMM-OpenSky-Meals", {
  defaults: {
    bringList: null,       // opensky.json → meals.bringList (the Bring! list's name; default: the account's default list)
    kitchenPort: 8092      // opensky.json → meals.kitchenPort
  },

  getStyles() { return ["MMM-OpenSky-Meals.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js", "modules/opensky-lib/client/meals-shared.js", "modules/opensky-lib/client/vendor/qrcode.js"]; },

  start() {
    this.state = null;
    this.kitchen = { urls: [] };
    this.bringOn = false;
    this.week = null;
    this.calls = new Map();
    this.seq = 0;
    this.sendSocketNotification("OS_MEALS_INIT", { bringList: this.config.bringList, kitchenPort: this.config.kitchenPort });
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_MEALS_STATE" && p) {
      this.state = p.state; this.kitchen = p.kitchen || { urls: [] }; this.bringOn = !!p.bring;
      this.draw();

    } else if (n === "OS_MEALS_RESULT" && p && this.calls.has(p.id)) { const done = this.calls.get(p.id); this.calls.delete(p.id); done(p); }
  },

  notificationReceived(n) {
    if ((n === "OPENSKY_IDLE_RESET" || n === "PAGE_CHANGED") && this.popup) this.closePopup();
  },

  call(op, body) {
    const id = `m${++this.seq}`;
    return new Promise((resolve) => {
      this.calls.set(id, resolve);
      setTimeout(() => { if (this.calls.has(id)) { this.calls.delete(id); resolve({ ok: false, error: osT("Something went wrong") }); } }, 45000);
      this.sendSocketNotification("OS_MEALS_CALL", { id, op, body });
    });
  },
  async change(op, body) {
    const r = await this.call(op, body);
    if (!r.ok) window.OpenSkyToast(r.error || osT("Something went wrong"), "error");
    return r;
  },

  getDom() {
    if (!this.root) { this.root = document.createElement("div"); this.root.className = "ml-root"; }
    this.draw();
    return this.root;
  },

  // the week shown: a confirmed plan — next week's once it's there (planned on Thursday), else this week's
  weekShown() {
    const s = this.state;
    if (!s) return null;
    const ok = (ws) => s.plans[ws] && s.plans[ws].confirmed;
    if (this.week && ok(this.week)) return this.week;
    return ok(s.weeks.current) ? s.weeks.current : ok(s.weeks.next) ? s.weeks.next : null;
  },

  draw() {
    const r = this.root;
    if (!r) return;
    const s = this.state, M = window.OpenSkyMeals, loc = config.locale || "en-US";
    if (!s) { r.innerHTML = `<div class="ml-empty">${osT("Loading…")}</div>`; return; }
    const ws = this.weekShown(), p = ws ? s.plans[ws] : null;
    const both = s.plans[s.weeks.current]?.confirmed && s.plans[s.weeks.next]?.confirmed;
    r.innerHTML = `
      <header class="ml-head">
        <span class="ml-title">${window.OpenSkyIcons ? window.OpenSkyIcons.svg("food") : ""} ${osT("Meal plan")}</span>
        <span class="ml-week"></span>
        ${both ? `<span class="ml-tabs"><button data-w="${s.weeks.current}">${osT("This week")}</button><button data-w="${s.weeks.next}">${osT("Next week")}</button></span>` : ""}
        <span class="ml-kitchen"><span class="ml-qr"></span><span class="ml-kitchen-text"><b>${osT("Plan on your phone")}</b><small class="ml-url"></small></span></span>
      </header>
      <div class="ml-body"></div>`;
    r.querySelector(".ml-week").textContent = p ? M.week(ws, loc) : "";
    r.querySelectorAll(".ml-tabs button").forEach((b) => { b.classList.toggle("on", b.dataset.w === ws); b.onclick = () => { this.week = b.dataset.w; this.draw(); }; });
    const url = this.kitchen.urls[0];
    r.querySelector(".ml-url").textContent = url ? url.replace(/^http:\/\//, "") : osT("The kitchen page isn't running (see opensky logs)");
    if (url && typeof qrcode === "function") { try { const q = qrcode(0, "M"); q.addData(url); q.make(); r.querySelector(".ml-qr").innerHTML = q.createSvgTag({ cellSize: 3, margin: 1, scalable: true }); } catch (e) { /* no QR */ } }
    const body = r.querySelector(".ml-body");
    if (!p) {
      const draft = s.plans[s.weeks.next] && !s.plans[s.weeks.next].confirmed;
      body.innerHTML = `<div class="ml-empty"></div>`;
      body.firstChild.textContent = draft ? osT("Next week's plan is a draft — finish it on your phone (\"That's it\").") : osT("No plan for this week yet. Plan it on your phone: scan the code above.");
      return;
    }
    body.innerHTML = `<section class="ml-days"></section><section class="ml-shop"><div class="ml-shop-head"><span>${osT("Shopping")}</span><small></small></div><div class="ml-shop-list"></div><div class="ml-shop-foot"></div></section>`;
    this.drawDays(body.querySelector(".ml-days"), ws, p);
    this.drawShop(body.querySelector(".ml-shop"), ws, p);
  },

  dishCard(p, e) {
    const dish = this.state.dishes.find((d) => d.id === e.dishId);
    if (!dish) return null;
    const c = document.createElement("div");
    c.className = "ml-dish";
    c.innerHTML = `<b></b><small></small>`;
    c.querySelector("b").textContent = dish.name;
    c.querySelector("small").textContent = `${window.OpenSkyMeals.effort(dish.effort)} · ${osT("{n} servings", { n: e.servings })}`;
    this.draggable(c, p, e, dish);
    return c;
  },

  drawDays(box, ws, p) {
    const M = window.OpenSkyMeals, loc = config.locale || "en-US";
    const loose = p.entries.filter((e) => !e.day);
    const tray = document.createElement("div");
    tray.className = "ml-day ml-tray";
    tray.dataset.day = "";
    tray.innerHTML = `<div class="ml-day-name">${loose.length ? osT("No day yet — drag onto a day") : osT("All dishes have a day")}</div><div class="ml-day-dishes"></div>`;
    loose.forEach((e) => { const c = this.dishCard(p, e); if (c) tray.querySelector(".ml-day-dishes").appendChild(c); });
    box.appendChild(tray);
    const today = new Date(), todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    for (const day of p.days) {
      const row = document.createElement("div");
      row.className = "ml-day" + (day === todayKey ? " today" : "");
      row.dataset.day = day;
      row.innerHTML = `<div class="ml-day-name"></div><div class="ml-day-dishes"></div>`;
      row.querySelector(".ml-day-name").textContent = M.day(day, loc, true);
      p.entries.filter((e) => e.day === day).forEach((e) => { const c = this.dishCard(p, e); if (c) row.querySelector(".ml-day-dishes").appendChild(c); });
      box.appendChild(row);
    }
  },

  drawShop(box, ws, p) {
    const M = window.OpenSkyMeals;
    const list = box.querySelector(".ml-shop-list");
    const need = p.shopping.filter((it) => !it.have);
    box.querySelector(".ml-shop-head small").textContent = osT("{n} of {all} still to buy", { n: need.length, all: p.shopping.length });
    let cat = null;
    for (const it of p.shopping) {
      if (it.category !== cat) { cat = it.category; const h = document.createElement("div"); h.className = "ml-cat"; h.textContent = M.category(cat); list.appendChild(h); }
      const row = document.createElement("button");
      row.className = "ml-item" + (it.have ? " have" : "");
      row.innerHTML = `<span class="ml-tick"></span><span class="ml-name"></span><span class="ml-amt"></span>`;
      row.querySelector(".ml-name").textContent = it.name;
      row.querySelector(".ml-amt").textContent = M.amount(it);
      row.onclick = () => this.change("have", { weekStart: ws, key: it.key, have: !it.have });
      list.appendChild(row);
    }
    window.OpenSkyDragScroll(box, ".ml-shop-list");
    const foot = box.querySelector(".ml-shop-foot");
    if (this.bringOn) {
      const b = document.createElement("button");
      b.className = "ml-bring";
      b.disabled = !need.length;
      b.textContent = osT("Send to Bring!");
      b.onclick = () => this.askBring(ws, need);
      foot.appendChild(b);
    }
  },

  // ask first (the family's choice): then the unticked ingredients go onto the Bring! list
  askBring(ws, need) {
    const M = window.OpenSkyMeals;
    this.popupBox(osT("Put these on the Bring! list?"), (body) => {
      const p1 = document.createElement("p"); p1.textContent = osT("{n} items go onto your Bring! shopping list (with their amounts). Ticked ones stay off.", { n: need.length });
      const p2 = document.createElement("p"); p2.className = "ml-pop-small"; p2.textContent = need.map((it) => `${it.name}${M.amount(it) ? " (" + M.amount(it) + ")" : ""}`).join(", ");
      body.append(p1, p2);
    }, [[osT("Cancel"), "", () => true], [osT("Send to Bring!"), "primary", async (btn) => {
      btn.disabled = true; btn.textContent = osT("Sending…");
      const r = await this.call("bring", { weekStart: ws });
      if (!r.ok) { window.OpenSkyToast(r.error || osT("Something went wrong"), "error"); return true; }
      window.OpenSkyToast(osT("{n} items are on the Bring! list \"{list}\"", { n: r.sent.count, list: r.sent.list }), "success");
      return true;
    }]]);
  },

  popupBox(title, build, actions) {
    this.closePopup();
    const o = document.createElement("div");
    o.className = "ml-overlay";
    o.innerHTML = `<div class="ml-pop" role="dialog"><div class="ml-pop-title"></div><div class="ml-pop-body"></div><div class="ml-pop-actions"></div></div>`;
    o.querySelector(".ml-pop-title").textContent = title;
    build(o.querySelector(".ml-pop-body"));
    for (const [label, cls, fn] of actions) {
      const b = document.createElement("button");
      b.className = `ml-btn ${cls}`; b.textContent = label;
      b.onclick = async () => { if (await fn(b)) this.closePopup(); };
      o.querySelector(".ml-pop-actions").appendChild(b);
    }
    o.addEventListener("click", (e) => { if (e.target === o) this.closePopup(); });
    document.body.appendChild(o);
    this.popup = o;
  },
  closePopup() { if (this.popup) { this.popup.remove(); this.popup = null; } },

  // a tap shows the dish (ingredients for its servings, notes) — handy while cooking
  showDish(dish, e) {
    const M = window.OpenSkyMeals, scale = e.servings / (dish.servings || 1);
    this.popupBox(dish.name, (body) => {
      const sub = document.createElement("p"); sub.className = "ml-pop-small";
      sub.textContent = `${M.effort(dish.effort)} ${M.effortName(dish.effort)} · ${osT("{n} servings", { n: e.servings })}`;
      const ul = document.createElement("ul"); ul.className = "ml-ings";
      for (const i of dish.ingredients) { const li = document.createElement("li"); li.textContent = `${M.amount({ amount: i.amount == null ? null : i.amount * scale, unit: i.unit })} ${i.name}`.trim(); ul.appendChild(li); }
      body.append(sub, ul);
      if (dish.notes) { const n = document.createElement("p"); n.className = "ml-notes"; n.textContent = dish.notes; body.appendChild(n); }
    }, [[osT("Close"), "primary", () => true]]);
  },

  /* ---------------- drag a dish onto a day ----------------
   * Pointer events (touch, and touchscreens that act like a mouse): a press that moves drags a copy, the day under the
   * finger lights up, letting go there sets the dish's cooking day ("no day yet" takes it off). A tap shows the dish. */
  draggable(el, p, e, dish) {
    let start = null, ghost = null, over = null;
    const zoom = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--os-zoom")) || 1;
    const dayAt = (x, y) => document.elementsFromPoint(x, y).find((n) => n.classList && n.classList.contains("ml-day")) || null;
    const end = () => { if (ghost) ghost.remove(); if (over) over.classList.remove("ml-drop"); ghost = over = start = null; };
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button > 0) return;
      start = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, moved: false };
      try { el.setPointerCapture(ev.pointerId); } catch (x) { /* gone */ }
    });
    el.addEventListener("pointermove", (ev) => {
      if (!start || ev.pointerId !== start.id) return;
      if (!start.moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 10) return;
      ev.preventDefault();
      if (!start.moved) {
        start.moved = true;
        ghost = el.cloneNode(true); ghost.classList.add("ml-ghost");
        ghost.style.width = `${el.getBoundingClientRect().width / zoom()}px`;
        document.body.appendChild(ghost);
      }
      const z = zoom();
      ghost.style.left = `${ev.clientX / z}px`; ghost.style.top = `${ev.clientY / z}px`;
      const d = dayAt(ev.clientX, ev.clientY);
      if (d !== over) { if (over) over.classList.remove("ml-drop"); over = d; if (over) over.classList.add("ml-drop"); }
    });
    el.addEventListener("pointerup", (ev) => {
      if (!start || ev.pointerId !== start.id) return;
      const moved = start.moved, target = over;
      end();
      if (!moved) return this.showDish(dish, e);
      if (target && (target.dataset.day || null) !== (e.day || null)) this.change("day", { weekStart: p.weekStart, entryId: e.id, day: target.dataset.day || null });
    });
    el.addEventListener("pointercancel", end);
  }
});
