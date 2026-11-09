// Todoist, Home Assistant and Apple Reminders lists on the screen (fake servers): items show, Add and check-off reach the provider.
const http = require("http");
const PORT = 8095;
const todo = [{ id: "t1", content: "Buy stamps", project_id: "p1", child_order: 1 }];
const ha = [{ uid: "h1", summary: "Batteries", status: "needs_action" }];
const rem = [{ id: "r1", text: "Sunscreen" }];
const calls = [];
const fake = http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
    calls.push(`${req.method} ${u.pathname}`);
    // Apple Reminders through the calendar service's /_reminders (services/calendar-service/reminders.py)
    if (u.pathname === "/_reminders/items") return send(200, u.searchParams.get("list") === "Holiday packing" ? { items: rem } : { error: "no such list" });
    if (u.pathname === "/_reminders/add") { rem.push({ id: `r${rem.length + 1}`, text: JSON.parse(raw).text }); return send(200, { ok: true }); }
    if (u.pathname === "/_reminders/check") { const i = rem.findIndex((x) => x.id === JSON.parse(raw).id); if (i >= 0) rem.splice(i, 1); return send(200, { ok: true }); }
    if (u.pathname === "/todoist/projects") return send(200, { results: [{ id: "p1", name: "Errands" }] });
    if (u.pathname === "/todoist/tasks" && req.method === "GET") return send(200, { results: todo });
    if (u.pathname === "/todoist/tasks" && req.method === "POST") { const b = JSON.parse(raw); todo.push({ id: `t${todo.length + 1}`, content: b.content, project_id: b.project_id, child_order: 9 }); return send(200, {}); }
    let m = u.pathname.match(/^\/todoist\/tasks\/([^/]+)\/close$/);
    if (m) { const i = todo.findIndex((t) => t.id === m[1]); if (i >= 0) todo.splice(i, 1); return send(204); }
    if (u.pathname.startsWith("/api/services/todo/")) {
      const svc = u.pathname.split("/").pop(), b = JSON.parse(raw || "{}");
      if (svc === "get_items") return send(200, { service_response: { [b.entity_id]: { items: ha } } });
      if (svc === "add_item") { ha.push({ uid: `h${ha.length + 1}`, summary: b.item, status: "needs_action" }); return send(200, []); }
      if (svc === "update_item") { const it = ha.find((x) => x.uid === b.item); if (it && b.status) it.status = b.status; return send(200, []); }
    }
    send(404, {});
  });
});
fake.listen(PORT, "127.0.0.1"); fake.unref();

module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const until = async (fn, tries = 60) => { for (let i = 0; i < tries && !(await fn()); i++) await h.sleep(250); return fn(); };
  const col = (title) => page.evaluate((t) => { const c = [...document.querySelectorAll(".hd-lists .lc-list")].find((x) => x.querySelector(".lc-list-title").textContent === t); return c ? [...c.querySelectorAll(".lc-item-text")].map((x) => x.textContent) : null; }, title);
  await until(async () => ((await col("Errands")) || []).length && ((await col("Garage")) || []).length && ((await col("Packing")) || []).length);
  ok("Todoist, Home Assistant and Apple Reminders lists show their items", JSON.stringify(await col("Errands")) === '["Buy stamps"]' && JSON.stringify(await col("Garage")) === '["Batteries"]' && JSON.stringify(await col("Packing")) === '["Sunscreen"]', [await col("Errands"), await col("Garage"), await col("Packing")]);
  for (const [title, text] of [["Errands", "Post office"], ["Garage", "Light bulbs"], ["Packing", "Passports"]]) {
    await page.evaluate((t) => [...document.querySelectorAll(".hd-lists .lc-list")].find((x) => x.querySelector(".lc-list-title").textContent === t).querySelector(".lc-add-item").click(), title);
    await h.sleep(300);
    await page.evaluate((v) => { document.querySelector(".osl-input").value = v; [...document.querySelectorAll(".osl-btn")].find((b) => b.textContent === "Add").click(); }, text);
    await until(async () => ((await col(title)) || []).includes(text));
  }
  ok("Add item reaches Todoist, Home Assistant and Apple Reminders", todo.some((t) => t.content === "Post office" && t.project_id === "p1") && ha.some((x) => x.summary === "Light bulbs") && rem.some((x) => x.text === "Passports"));
  await page.evaluate(() => [...document.querySelectorAll(".hd-lists .lc-item")].find((r) => r.textContent === "Sunscreen").querySelector(".lc-check").click());
  await until(() => !rem.some((x) => x.id === "r1"), 60);
  ok("check-off reaches Apple Reminders", !rem.some((x) => x.id === "r1"));
  await page.evaluate(() => [...document.querySelectorAll(".hd-lists .lc-item")].find((r) => r.textContent === "Batteries").querySelector(".lc-check").click());
  await until(() => ha.find((x) => x.uid === "h1").status === "completed", 60);
  await until(async () => !((await col("Garage")) || []).includes("Batteries"));
  ok("check-off reaches Home Assistant after the Undo time, and the item goes", ha.find((x) => x.uid === "h1").status === "completed" && !(await col("Garage")).includes("Batteries"));
  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
module.exports.patchSettings = (s) => { s.lists = { lists: [{ name: "Errands", provider: "todoist", color: "teal" }, { name: "Garage", provider: "homeassistant", entity: "todo.garage", color: "orange" }, { name: "Packing", provider: "icloud", reminderList: "Holiday packing", color: "pink" }] }; };
module.exports.patchSecrets = (s) => { s.lists = { todoist: { token: "fake-todoist-token" } }; s.homeassistant = { url: `http://127.0.0.1:${PORT}`, token: "fake-ha-token-123" }; };
module.exports.env = { OPENSKY_TODOIST_API: `http://127.0.0.1:${PORT}/todoist`, OPENSKY_CALENDAR_PORT: String(PORT) };
