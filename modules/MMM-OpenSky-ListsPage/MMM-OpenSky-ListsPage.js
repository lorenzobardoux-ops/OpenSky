/* MMM-OpenSky-ListsPage — the full-screen Lists page: every list from every provider, side by side, each scrolling.
 * Shows what list providers broadcast (OPENSKY_LISTS { source, lists }) and sends taps back to them
 * (OPENSKY_LIST_ADD / _CHECK / _EDIT), exactly like the Home page's lists card. Columns: lib/client (OpenSkyListColumn).
 */
Module.register("MMM-OpenSky-ListsPage", {
  defaults: {
    columns: 4            // how many lists fit across before the page scrolls sideways
  },

  getStyles() { return ["modules/opensky-lib/client/list-columns.css", "MMM-OpenSky-ListsPage.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js"]; },

  start() {
    this.bySource = new Map();   // list provider → lists
  },

  getDom() {
    if (!this.root) {
      this.root = document.createElement("div");
      this.root.className = "lp-root";
      this.root.innerHTML = `
        <header class="lp-head">
          <span class="lp-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>${osT("Lists")}</span>
        </header>
        <div class="lp-columns"></div>
        <div class="lp-none" hidden>${osT("No lists yet. Add some under <b>\"lists\"</b> in opensky.json (see docs/configure.md).")}</div>`;

      this.root.style.setProperty("--lp-columns", this.config.columns);
    }
    this.render();
    return this.root;
  },

  notificationReceived(n, p) {
    if (n === "OPENSKY_LISTS" && p && p.source) {
      this.bySource.set(p.source, Array.isArray(p.lists) ? p.lists : []);
      this.render();
    } else if (n === "DOM_OBJECTS_CREATED") {
      this.sendNotification("OPENSKY_LISTS_REFRESH");
    }
  },

  resume() { this.sendNotification("OPENSKY_LISTS_REFRESH"); },

  render() {
    if (!this.root) return;
    const all = [...this.bySource.entries()].flatMap(([source, lists]) => lists.map((l) => ({ ...l, source })));
    const cols = this.root.querySelector(".lp-columns");
    // keep each column's scroll position across updates (a check-off redraws the lists)
    const scroll = new Map([...cols.querySelectorAll(".lc-list")].map((c) => [c.dataset.key, c.querySelector(".lc-items").scrollTop]));
    cols.innerHTML = "";
    this.root.querySelector(".lp-none").hidden = all.length > 0;
    all.forEach((list, idx) => {
      const send = (n, extra) => this.sendNotification(n, { source: list.source, listId: list.id, ...extra });
      const col = window.OpenSkyListColumn.render(list, {
        add: () => send("OPENSKY_LIST_ADD"),
        check: (item, el) => send("OPENSKY_LIST_CHECK", { item, el }),
        edit: (item) => send("OPENSKY_LIST_EDIT", { item })
      }, { alt: idx % 2 === 1 });
      col.dataset.key = `${list.source}/${list.id}`;
      cols.appendChild(col);
      const top = scroll.get(col.dataset.key);
      if (top) col.querySelector(".lc-items").scrollTop = top;
    });
  }
});
