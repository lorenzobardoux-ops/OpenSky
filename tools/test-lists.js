// Unit test for lib/lists.js: the on-device provider, and the Todoist provider against a fake Todoist API (no account needed).
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensky-lists-"));
const SECRETS = path.join(tmp, "secrets.json");
process.env.OPENSKY_LOCAL_LISTS = path.join(tmp, "lists.json");
process.env.OPENSKY_SECRETS = SECRETS;

let passed = 0, failed = 0;
const ok = (name, cond, info) => { cond ? passed++ : failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info !== undefined ? "  — " + JSON.stringify(info) : ""}`); };
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// fake Todoist API v1: two pages of projects, tasks with paging, close/update/delete, Bearer check
const tasks = [
  { id: "t1", content: "Milk", project_id: "p2", child_order: 2 },
  { id: "t2", content: "Eggs", project_id: "p2", child_order: 1 },
  { id: "t3", content: "Mow the lawn", project_id: "p1", child_order: 1 }
];
let nextId = 10; const calls = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer good-token") return send(401, { error: "unauthorized" });
    if (req.method === "GET" && url.pathname === "/api/v1/projects") {
      return url.searchParams.get("cursor") ? send(200, { results: [{ id: "p2", name: "Groceries" }], next_cursor: null })
        : send(200, { results: [{ id: "p1", name: "Chores" }], next_cursor: "page2" });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/tasks") {
      const mine = tasks.filter((t) => t.project_id === url.searchParams.get("project_id"));
      return url.searchParams.get("cursor") ? send(200, { results: mine.slice(1), next_cursor: null }) : send(200, { results: mine.slice(0, 1), next_cursor: mine.length > 1 ? "more" : null });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/tasks") {
      const b = JSON.parse(body); tasks.push({ id: `t${nextId++}`, content: b.content, project_id: b.project_id, child_order: 9 }); return send(200, tasks[tasks.length - 1]);
    }
    let m = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)(\/close)?$/);
    const i = m ? tasks.findIndex((t) => t.id === m[1]) : -1;
    if (m && i < 0) return send(404, { error: "not found" });
    if (m && req.method === "POST" && m[2]) { tasks.splice(i, 1); return send(204); }
    if (m && req.method === "POST") { tasks[i].content = JSON.parse(body).content; return send(200, tasks[i]); }
    if (m && req.method === "DELETE") { tasks.splice(i, 1); return send(204); }
    send(404, {});
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.OPENSKY_TODOIST_API = `http://127.0.0.1:${server.address().port}/api/v1`;
  const lists = require(path.join(__dirname, "..", "lib", "lists.js"));

  // ---- on-device ----
  const g = { name: "Groceries" }, local = lists.provider(g);
  ok("1 default provider is on-device; an unknown one is refused", lists.provider({ name: "x", provider: "local" }) === local && /Unknown/.test(await fails(() => lists.provider({ name: "x", provider: "nope" }))));
  ok("2 a new list starts empty (no file yet)", (await local.items(g)).length === 0);
  await local.add(g, "  Milk  "); await local.add(g, "Bread");
  let items = await local.items(g);
  ok("3 add keeps order and tidies spaces", items.map((x) => x.text).join() === "Milk,Bread", items);
  ok("4 empty text is refused kindly", /type something/i.test(await fails(() => local.add(g, "   "))));
  await local.edit(g, items[1], "Rye bread");
  await local.check(g, items[0]);
  items = await local.items(g);
  ok("5 edit + check off", items.map((x) => x.text).join() === "Rye bread", items);
  ok("6 an item that's gone → clear message", /gone/.test(await fails(() => local.check(g, { id: "nope" }))));
  await local.remove(g, items[0]);
  ok("7 delete; other lists untouched", (await local.items(g)).length === 0 && (await local.items({ name: "Other" })).length === 0);
  fs.writeFileSync(process.env.OPENSKY_LOCAL_LISTS, "{ broken");
  items = await local.items(g);
  ok("8 damaged file → empty lists + a copy kept (no crash)", items.length === 0 && fs.readdirSync(tmp).some((f) => f.includes(".damaged-")));

  // ---- Todoist ----
  const shop = { name: "Shopping", provider: "todoist", project: "groceries" }, todo = lists.provider(shop);
  ok("9 no token → says where to put it", /secrets\.json/.test(await fails(() => todo.items(shop))));
  fs.writeFileSync(SECRETS, JSON.stringify({ lists: { todoist: { token: "bad-token" } } }));
  ok("10 refused token → says what to check", /refused the API token/.test(await fails(() => todo.items(shop))));
  fs.writeFileSync(SECRETS, JSON.stringify({ lists: { todoist: { token: "good-token" } } }));
  fs.utimesSync(SECRETS, new Date(), new Date(Date.now() + 5000));   // make sure the change is seen
  items = await todo.items(shop);
  ok("11 project by name (any case, across pages) + all task pages, in Todoist's order", items.map((x) => x.text).join() === "Eggs,Milk", items);
  ok("12 an unknown project → names it", /No Todoist project called "Pets"/.test(await fails(() => todo.items({ name: "Pets", provider: "todoist" }))));
  await todo.add(shop, "Butter");
  await todo.edit(shop, items[0], "Brown eggs");
  await todo.check(shop, items[1]);
  items = await todo.items(shop);
  ok("13 add / edit / check off reach Todoist", items.map((x) => x.text).join() === "Brown eggs,Butter", items);
  await todo.remove(shop, items[1]);
  ok("14 delete; projectId works without a lookup", (await todo.items({ name: "x", provider: "todoist", projectId: "p2" })).map((x) => x.text).join() === "Brown eggs");
  ok("15 an item deleted in Todoist → clear message", /Not found in Todoist/.test(await fails(() => todo.check(shop, { id: "gone" }))));
  server.close();
  ok("16 Todoist unreachable → friendly message", /Can't reach Todoist/.test(await fails(() => todo.items(shop))));

  // ---- Home Assistant to-do ----
  const haItems = [{ uid: "u1", summary: "Bread", status: "needs_action" }, { uid: "u2", summary: "Old", status: "completed" }];
  const haCalls = [];
  const haServer = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== "Bearer ha-token") return send(401, {});
      const b = JSON.parse(body || "{}"), svc = req.url.replace(/^\/api\/services\/todo\//, "");
      haCalls.push(`${svc} ${JSON.stringify(b)}`);
      if (b.entity_id !== "todo.shopping") return send(400, { message: "no such entity" });
      if (svc === "get_items?return_response") return send(200, { changed_states: [], service_response: { "todo.shopping": { items: haItems } } });
      if (svc === "add_item") { haItems.push({ uid: `u${haItems.length + 1}`, summary: b.item, status: "needs_action" }); return send(200, []); }
      const it = haItems.find((x) => x.uid === (Array.isArray(b.item) ? b.item[0] : b.item));
      if (!it) return send(400, { message: "not found" });
      if (svc === "update_item") { if (b.status) it.status = b.status; if (b.rename) it.summary = b.rename; return send(200, []); }
      if (svc === "remove_item") { haItems.splice(haItems.indexOf(it), 1); return send(200, []); }
      send(404, {});
    });
  });
  await new Promise((r) => haServer.listen(0, "127.0.0.1", r));
  const shopping = { name: "Shopping", provider: "homeassistant", entity: "todo.shopping" }, hap = lists.provider(shopping);
  ok("17 HA not set up → says what to add", /homeassistant\.url/.test(await fails(() => hap.items(shopping))));
  fs.writeFileSync(SECRETS, JSON.stringify({ homeassistant: { url: `http://127.0.0.1:${haServer.address().port}/`, token: "ha-token" } }));
  fs.utimesSync(SECRETS, new Date(), new Date(Date.now() + 10000));
  items = await hap.items(shopping);
  ok("18 HA: open items only, by uid", items.map((x) => x.text).join() === "Bread" && items[0].id === "u1", items);
  await hap.add(shopping, "Milk"); items = await hap.items(shopping);
  await hap.edit(shopping, items[0], "Rye bread"); await hap.check(shopping, items[1]);
  items = await hap.items(shopping);
  ok("19 HA: add / rename / check off use todo.add_item / update_item", items.map((x) => x.text).join() === "Rye bread" && haCalls.some((c) => /^update_item .*"rename":"Rye bread"/.test(c)) && haCalls.some((c) => /^update_item .*"status":"completed"/.test(c)), haCalls.slice(-3));
  await hap.remove(shopping, items[0]);
  ok("20 HA: delete uses todo.remove_item", (await hap.items(shopping)).length === 0);
  ok("21 HA: a missing or wrong entity is explained", /needs its Home Assistant list/.test(await fails(() => hap.items({ name: "X", provider: "homeassistant" }))) && /didn't accept/.test(await fails(() => hap.items({ name: "X", provider: "homeassistant", entity: "todo.nope" }))));
  fs.writeFileSync(SECRETS, JSON.stringify({ homeassistant: { url: `http://127.0.0.1:${haServer.address().port}`, token: "wrong" } }));
  fs.utimesSync(SECRETS, new Date(), new Date(Date.now() + 20000));
  ok("22 HA: a refused token is explained", /refused the token/.test(await fails(() => hap.items(shopping))));
  haServer.close();

  // Apple Reminders: through a stand-in for the calendar service's /_reminders (services/calendar-service/reminders.py)
  const rem = [{ id: "r1", text: "Milch" }], remCalls = [];
  const remServer = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x"), b = JSON.parse(body || "{}"), send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      remCalls.push(`${req.method} ${u.pathname}${u.search} ${body}`);
      if (u.searchParams.get("list") === "Signed out") return send(401, { error: "Apple Reminders: the sign-in has ended — sign in again", signIn: true });
      if (u.pathname === "/_reminders/items") return send(200, { items: rem });
      if (u.pathname === "/_reminders/add") { rem.push({ id: `r${rem.length + 1}`, text: b.text }); return send(200, { ok: true }); }
      const i = rem.findIndex((x) => x.id === b.id);
      if (u.pathname === "/_reminders/edit") { rem[i].text = b.text; return send(200, { ok: true }); }
      if (u.pathname === "/_reminders/check" || u.pathname === "/_reminders/remove") { rem.splice(i, 1); return send(200, { ok: true }); }
      send(404, {});
    });
  });
  await new Promise((r) => remServer.listen(0, "127.0.0.1", r));
  process.env.OPENSKY_CALENDAR_PORT = String(remServer.address().port);
  const shared = { name: "Einkauf", provider: "icloud", reminderList: "Einkauf Lena & Lorenzo" }, rp = lists.provider(shared);
  items = await rp.items(shared);
  ok("23 Apple Reminders: the list's items, asked by its name in Reminders", items.map((x) => x.text).join() === "Milch" && remCalls[0].includes("list=Einkauf%20Lena%20%26%20Lorenzo"), remCalls[0]);
  await rp.add(shared, "  Eier "); await rp.edit(shared, { id: "r1" }, "Hafermilch"); items = await rp.items(shared);
  ok("24 Apple Reminders: add (cleaned) and rename", items.map((x) => x.text).join() === "Hafermilch,Eier" && remCalls.some((c) => c.includes('"text":"Eier"')), items);
  await rp.check(shared, { id: "r1" }); await rp.remove(shared, { id: "r2" });
  ok("25 Apple Reminders: check off and delete", (await rp.items(shared)).length === 0 && remCalls.some((c) => c.startsWith("POST /_reminders/check")) && remCalls.some((c) => c.startsWith("POST /_reminders/remove")));
  ok("26 Apple Reminders: without reminderList the list's own name", (await (async () => { remCalls.length = 0; await rp.items({ name: "Haushalt", provider: "icloud" }); return remCalls[0]; })()).includes("list=Haushalt"));
  ok("27 Apple Reminders: a session Apple ended → the service's message (sign in again)", /sign in again/.test(await fails(() => rp.items({ name: "Signed out", provider: "icloud" }))));
  remServer.close();
  process.env.OPENSKY_CALENDAR_PORT = "9";
  ok("28 Apple Reminders: the calendar service not running → says so", /calendar service/.test(await fails(() => rp.items(shared))));

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`SUMMARY pass=${passed} fail=${failed}`);
})().catch((e) => { console.log(`SUMMARY pass=${passed} fail=${failed + 1} (crashed: ${e.message})`); process.exit(1); });
