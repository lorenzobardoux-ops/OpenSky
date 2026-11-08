/* MMM-OpenSky-Lists node helper — reads and changes the lists through lib/lists.js (providers + tokens stay here).
 *   OS_LISTS_INIT {lists, refreshMinutes}   → starts refreshing; answers OS_LISTS {lists: [{id, title, color, items, error?}]}
 *   OS_LISTS_REFRESH                         → fetch again now (throttled)
 *   OS_LIST_OP {id, op: add|check|edit|remove, listId, item?, text?} → OS_LIST_RESULT {id, ok, error}, then OS_LISTS
 */
const NodeHelper = require("node_helper");
const path = require("path");
const { osT } = require(path.join(__dirname, "..", "..", "lib", "client", "i18n.js"));   // texts in opensky.json's language
const lists = require(path.join(global.root_path, "modules", "opensky-lib", "lists.js"));

module.exports = NodeHelper.create({
  start() {
    this.lists = [];
    this.last = new Map();   // list name → last good items (shown while a provider is unreachable)
    this.errors = new Map();
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_LISTS_INIT") {
      this.lists = (p && Array.isArray(p.lists)) ? p.lists : [];
      clearInterval(this.timer);
      const minutes = Math.max(1, Number(p && p.refreshMinutes) || 2);
      this.timer = setInterval(() => this.refresh(), minutes * 60 * 1000);
      if (this.last.size) this.broadcast();   // another screen (or a reload): show what we have at once
      this.refresh();
    } else if (n === "OS_LISTS_REFRESH") {
      if (Date.now() - (this.lastRefresh || 0) > 3000) this.refresh();
    } else if (n === "OS_LIST_OP" && p && p.id) {
      this.operate(p).then(
        () => this.sendSocketNotification("OS_LIST_RESULT", { id: p.id, ok: true }),
        (e) => {
          // also in the log (opensky logs), for when someone asks for help after the popup is gone (no item text, no tokens)
          console.error(`[OpenSky] list "${p.listId}": couldn't ${p.op === "check" ? "check off" : p.op} an item: ${e.message}`);
          this.sendSocketNotification("OS_LIST_RESULT", { id: p.id, ok: false, error: e.message });
        }
      ).finally(() => this.refresh(true));
    }
  },

  async operate({ op, listId, item, text }) {
    const list = this.lists.find((l) => l.name === listId);
    if (!list) throw new Error(osT("That list isn't on this screen any more"));
    const provider = lists.provider(list);
    if (op === "add") return provider.add(list, text);
    if (!item || !item.id) throw new Error(osT("Which item?"));
    if (op === "check") return provider.check(list, item);
    if (op === "edit") return provider.edit(list, item, text);
    if (op === "remove") return provider.remove(list, item);
    throw new Error(osT("Unknown change"));
  },

  async refresh(force) {
    if (this.running && !force) return;
    this.running = true;
    this.lastRefresh = Date.now();
    await Promise.all(this.lists.map(async (list) => {
      try {
        this.last.set(list.name, await lists.provider(list).items(list));
        this.errors.delete(list.name);
      } catch (e) {
        if (!this.errors.has(list.name)) console.error(`[OpenSky] list "${list.name}": ${e.message}`);
        this.errors.set(list.name, e.message);
      }
    }));
    this.running = false;
    this.broadcast();
  },

  broadcast() {
    this.sendSocketNotification("OS_LISTS", {
      lists: this.lists.map((l) => ({
        id: l.name, title: l.name, color: l.color || null, provider: l.provider || "local",
        items: this.last.get(l.name) || [],
        loaded: this.last.has(l.name) || this.errors.has(l.name),
        error: this.last.has(l.name) ? null : (this.errors.get(l.name) || null)
      }))
    });
  }
});
