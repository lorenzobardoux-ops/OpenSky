/* MMM-OpenSky-Lists
 * The family's lists (groceries, to-dos…) from any provider — on-device (default, no account) or Todoist.
 * Broadcasts OPENSKY_LISTS { source: "opensky", lists } for the Home page's lists card, and answers its taps:
 *   OPENSKY_LIST_ADD {source, listId}           → "Add to …" popup
 *   OPENSKY_LIST_CHECK {source, listId, item}   → shown as done at once, with Undo; the provider is told after a few seconds
 *   OPENSKY_LIST_EDIT {source, listId, item}    → edit popup (Save / Done / Delete)
 *   OPENSKY_LISTS_REFRESH                       → fetch again (e.g. the Home page came back on screen)
 * Every change goes through the node helper (the page never sees a token). No visible DOM of its own; popups live on <body>.
 */
Module.register("MMM-OpenSky-Lists", {
  defaults: {
    lists: [],            // [{ name, color, provider, project? }] — built by config.js from opensky.json (no tokens)
    refreshMinutes: 2,
    undoSeconds: 5
  },

  SOURCE: "opensky",

  getStyles() { return ["MMM-OpenSky-Lists.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js"]; },

  start() {
    this.lists = [];
    this.pending = null;        // check-off waiting for Undo: { listId, item, timer }
    this.committing = new Set(); // item ids sent to the provider, hidden until the next update
    this.calls = new Map();     // request id → resolve
    this.seq = 0;
    this.sendSocketNotification("OS_LISTS_INIT", { lists: this.config.lists, refreshMinutes: this.config.refreshMinutes });
  },

  getDom() { return document.createElement("div"); },

  notificationReceived(n, p) {
    if (n === "OPENSKY_IDLE_RESET" || n === "PAGE_CHANGED") { if (this.popup && !this.busy) this.closePopup(); return; }
    if (n === "OPENSKY_LISTS_REFRESH") { this.sendSocketNotification("OS_LISTS_REFRESH"); return; }
    if (!p || p.source !== this.SOURCE) return;   // another list provider's lists
    const list = this.lists.find((l) => l.id === p.listId);
    if (!list) return;
    if (n === "OPENSKY_LIST_ADD") this.openAdd(list);
    else if (n === "OPENSKY_LIST_CHECK" && p.item) this.checkOff(list, p.item);
    else if (n === "OPENSKY_LIST_EDIT" && p.item) this.openEdit(list, p.item);
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_LISTS" && p && Array.isArray(p.lists)) {
      this.lists = p.lists;
      const present = new Set(this.lists.flatMap((l) => (l.items || []).map((it) => it.id)));
      this.committing.forEach((id) => { if (!present.has(id)) this.committing.delete(id); });   // gone for good
      this.broadcast();
    } else if (n === "OS_LIST_RESULT" && p && this.calls.has(p.id)) {
      this.calls.get(p.id)(p);
      this.calls.delete(p.id);
    }
  },

  // The lists as Home shows them: an item waiting for Undo is marked done, one being checked off is hidden
  broadcast() {
    const pend = this.pending;
    const lists = this.lists.map((l) => ({
      ...l,
      items: (l.items || []).filter((it) => !this.committing.has(it.id))
        .map((it) => (pend && pend.listId === l.id && pend.item.id === it.id ? { ...it, done: true } : it))
    }));
    this.sendNotification("OPENSKY_LISTS", { source: this.SOURCE, lists });
  },

  call(op, listId, extra) {
    const id = `l${++this.seq}`;
    return new Promise((resolve) => {
      this.calls.set(id, resolve);
      this.sendSocketNotification("OS_LIST_OP", { id, op, listId, ...extra });
      setTimeout(() => { if (this.calls.has(id)) { this.calls.delete(id); resolve({ ok: false, error: osT("No answer from the lists service — try again") }); } }, 30000);
    });
  },

  /* ---------------- check off with Undo ---------------- */
  // Shown as done right away; the provider is told after undoSeconds, so Undo just cancels.
  // Checking a second item commits the first.
  checkOff(list, item) {
    if (this.pending && this.pending.item.id === item.id) return;
    this.commitPending();
    this.pending = { listId: list.id, item, timer: setTimeout(() => this.commitPending(), this.config.undoSeconds * 1000) };
    this.broadcast();
    this.showUndo(item.text);
  },

  async commitPending() {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    this.hideUndo();
    this.committing.add(p.item.id);
    this.broadcast();
    const r = await this.call("check", p.listId, { item: p.item });
    if (!r.ok) {
      this.committing.delete(p.item.id);
      this.broadcast();
      window.OpenSkyToast(`${osT("Couldn't check off “{item}”.", { item: p.item.text })} ${r.error || ""}`.trim(), "error");
    }
  },

  undo() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
    this.hideUndo();
    this.broadcast();
  },

  showUndo(text) {
    if (!this.undoBar) {
      const bar = document.createElement("div");
      bar.className = "osl-undo";
      bar.innerHTML = `<span class="osl-undo-text"></span><button class="osl-undo-btn">${osT("Undo")}</button>`;
      bar.querySelector(".osl-undo-btn").onclick = () => this.undo();
      document.body.appendChild(bar);
      this.undoBar = bar;
    }
    this.undoBar.querySelector(".osl-undo-text").textContent = osT("Checked off “{item}”", { item: text });
    this.undoBar.classList.add("show");
  },

  hideUndo() { if (this.undoBar) this.undoBar.classList.remove("show"); },

  /* ---------------- popups ---------------- */
  openAdd(list) {
    this.openPopup({
      title: osT("Add to {list}", { list: list.title }), value: "", placeholder: osT("Type an item…"), list,
      buttons: [{ cls: "osl-cancel", label: osT("Cancel") }, { cls: "osl-primary", label: osT("Add"), busy: osT("Adding…"), main: true,
        run: (text) => this.call("add", list.id, { text }) }]
    });
  },

  openEdit(list, item) {
    if (this.pending && this.pending.item.id === item.id) return;
    this.openPopup({
      title: list.title, value: item.text, placeholder: osT("Item"), list,
      buttons: [
        { cls: "osl-danger", label: osT("Delete"), busy: osT("Deleting…"), run: () => this.call("remove", list.id, { item }) },
        { cls: "osl-done", label: osT("Done ✓"), run: () => { this.closePopup(); this.checkOff(list, item); return null; } },
        { cls: "osl-cancel", label: osT("Cancel") },
        { cls: "osl-primary", label: osT("Save"), busy: osT("Saving…"), main: true,
          run: (text) => (text === item.text ? null : this.call("edit", list.id, { item, text })) }
      ]
    });
  },

  openPopup({ title, value, placeholder, list, buttons }) {
    this.closePopup();
    const overlay = document.createElement("div");
    overlay.className = "osl-overlay";
    overlay.innerHTML = `
      <div class="osl-modal" role="dialog">
        <div class="osl-head"><span class="osl-title"></span><button class="osl-x" aria-label="${osT("Close")}">×</button></div>
        <input type="text" class="osl-input" maxlength="500" autocomplete="off" />
        <div class="osl-error" hidden></div>
        <div class="osl-actions"></div>
      </div>`;
    overlay.querySelector(".osl-title").textContent = title;
    const EC = window.OpenSkyEventColors, c = EC && EC.colorOf(list.color);   // a palette name or a color code
    if (c) overlay.style.setProperty("--osl-accent", EC.pair(c)[1]);
    const input = overlay.querySelector(".osl-input");
    input.value = value;
    input.placeholder = placeholder;
    const err = overlay.querySelector(".osl-error");
    const actions = overlay.querySelector(".osl-actions");
    let main = null;
    buttons.forEach((b) => {
      const el = document.createElement("button");
      el.className = `osl-btn ${b.cls}`;
      el.textContent = b.label;
      el.onclick = async () => {
        if (this.busy) return;
        if (!b.run) { this.closePopup(); return; }
        const text = input.value.replace(/\s+/g, " ").trim();
        if (b.main && !text) { err.textContent = osT("Please type something first"); err.hidden = false; input.focus(); return; }
        const pending = b.run(text);
        if (!pending) { this.closePopup(); return; }
        this.busy = true;
        el.textContent = b.busy || "…";
        actions.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        const r = await pending;
        this.busy = false;
        if (r.ok) { this.closePopup(); return; }
        el.textContent = b.label;
        actions.querySelectorAll("button").forEach((x) => { x.disabled = false; });
        err.textContent = r.error || osT("Something went wrong");

        err.hidden = false;
      };
      if (b.main) main = el;
      actions.appendChild(el);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && main) main.click();
      if (e.key === "Escape" && !this.busy) this.closePopup();
    });
    overlay.querySelector(".osl-x").onclick = () => { if (!this.busy) this.closePopup(); };
    // a tap outside closes it — only when the press started outside too (else a finger lifted off a button that moved
    // away under it closed the popup and lost the item)
    let pressedOutside = false;
    overlay.addEventListener("pointerdown", (e) => { pressedOutside = e.target === overlay; });
    overlay.addEventListener("click", (e) => { if (e.target === overlay && pressedOutside && !this.busy) this.closePopup(); });
    document.body.appendChild(overlay);
    this.popup = overlay;
    setTimeout(() => input.focus(), 50);   // (the on-screen keyboard follows the focus)
  },

  closePopup() {
    if (!this.popup) return;
    this.popup.remove();
    this.popup = null;
    this.busy = false;
  }
});
