/* MMM-OpenSky-Templates node helper — the family's event templates (lib/templates.js, config/templates.json).
 *   OS_TPL_INIT {calendars}               → OS_TPL_LIST {templates} + OS_TPL_COLORS {colors}
 *   OS_TPL_CALL {id, op, ...}             → OS_TPL_RESULT {id, ok, error?, ...}
 *     op "save" {template}   → {templates}        (a new one without template.id; a change with it)
 *     op "remove" {tid}      → {templates}
 *     op "plan" {tid, day}   → {template, creates: [{calendar, data}]}   (what placing it on that day creates)
 *     op "placed" {calendar, title, day, color} → {colors}               (remember an event's template color)
 */
const NodeHelper = require("node_helper");
const path = require("path");
const templates = require(path.join(__dirname, "..", "..", "lib", "templates.js"));

module.exports = NodeHelper.create({
  socketNotificationReceived(n, p) {
    if (n === "OS_TPL_INIT") {
      this.calendars = (p && Array.isArray(p.calendars) ? p.calendars : []).map(String);
      this.sendSocketNotification("OS_TPL_LIST", { templates: templates.list() });
      this.sendSocketNotification("OS_TPL_COLORS", { colors: templates.colors() });
      return;
    }
    if (n !== "OS_TPL_CALL" || !p || !p.id) return;
    const done = (extra) => this.sendSocketNotification("OS_TPL_RESULT", { id: p.id, ok: true, ...extra });
    try {
      if (p.op === "save") { const list = templates.save(p.template, this.calendars); this.sendSocketNotification("OS_TPL_LIST", { templates: list }); return done({ templates: list }); }
      if (p.op === "remove") { const list = templates.remove(p.tid); this.sendSocketNotification("OS_TPL_LIST", { templates: list }); return done({ templates: list }); }
      if (p.op === "plan") return done(templates.plan(p.tid, p.day));
      if (p.op === "moved" || p.op === "forget") {
        if (p.op === "moved") templates.moved(p.calendars, String(p.fromTitle), String(p.fromDay), String(p.toTitle), String(p.toDay));
        else templates.forget(p.calendars, String(p.title), String(p.day));

        const colors = templates.colors();
        this.sendSocketNotification("OS_TPL_COLORS", { colors });
        return done({ colors });
      }
      if (p.op === "placed") {

        templates.placed(String(p.calendar), String(p.title), String(p.day), p.color);
        const colors = templates.colors();
        this.sendSocketNotification("OS_TPL_COLORS", { colors });
        return done({ colors });
      }
      throw new Error("unknown op");
    } catch (e) {
      this.sendSocketNotification("OS_TPL_RESULT", { id: p.id, ok: false, error: e.message });
    }
  }
});
