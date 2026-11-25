// Meal planner (page "meals"): the kitchen page for phones (no code, but only this Pi's addresses and only with the
// X-OpenSky header) makes dishes and rolls next week; the screen shows the plan and its sorted shopping list; a dish
// dragged onto a day is on the calendar ("Cook: …"); ticked items stay off Bring!; "Send to Bring!" asks first.
const http = require("http");
const BRING = 8096, KITCHEN = 8093;
const sent = [];
const fake = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/v2/bringauth") return send(200, { uuid: "U1", publicUuid: "P1", access_token: "tok", expires_in: 3600, bringListUUID: "L1" });
    if (req.url === "/bringusers/U1/lists") return send(200, { lists: [{ listUuid: "L1", name: "Einkauf" }] });
    if (req.url === "/v2/bringlists/L1/items") { JSON.parse(body).changes.forEach((c) => sent.push(`${c.itemId}|${c.spec}`)); res.writeHead(204); return res.end(); }
    send(404, {});
  });
});
fake.listen(BRING, "127.0.0.1"); fake.unref();

const kitchen = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: KITCHEN, path: p, method, headers: { "Content-Type": "application/json", "X-OpenSky": "1", ...headers } }, (res) => {
    let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) { /* page */ } resolve({ status: res.statusCode, json: j, text: d }); });
  });
  req.on("error", reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const until = async (fn, tries = 40) => { for (let i = 0; i < tries && !(await fn()); i++) await h.sleep(250); return fn(); };
  await page.evaluate(() => document.querySelector(".osu-later")?.click());
  await until(async () => (await kitchen("GET", "/api/state").catch(() => ({}))).status === 200);

  // the kitchen page: open, but guarded
  const pg = await kitchen("GET", "/");
  const noHeader = await kitchen("POST", "/api/change", { op: "settings", body: { defaultServings: 3 } }, { "X-OpenSky": "" });
  const evilHost = await kitchen("GET", "/api/state", null, { Host: "evil.example" });
  const settings = await kitchen("POST", "/api/change", { op: "saveDish", body: {} });
  ok("kitchen page: served without a code; changes need the X-OpenSky header; only this Pi's addresses; no other kinds of change",
    pg.status === 200 && /app\.js/.test(pg.text) && noHeader.status === 403 && evilHost.status === 421 && settings.status === 400, { page: pg.status, noHeader: noHeader.status, evilHost: evilHost.status });

  for (const dish of [
    { name: "Lasagna", effort: 3, ingredients: [{ name: "Minced beef", amount: 500, unit: "g" }, { name: "Onion", amount: 1 }, { name: "Mozzarella", amount: 1, unit: "ball" }] },
    { name: "Pancakes", effort: 1, ingredients: [{ name: "Flour", amount: 200, unit: "g" }, { name: "Milk", amount: 400, unit: "ml" }] },
    { name: "Veggie curry", effort: 2, ingredients: [{ name: "Onion", amount: 2 }, { name: "Coconut milk", amount: 1, unit: "tin" }] }]) await kitchen("POST", "/api/change", { op: "saveDish", body: { dish } });
  let st = (await kitchen("GET", "/api/state")).json;
  const ws = st.weeks.next;
  let r = await kitchen("POST", "/api/change", { op: "roll", body: { weekStart: ws, count: 3, maxEffort: 5 } });
  ok("roll next week (Saturday–Friday): 3 dishes, a draft", r.status === 200 && r.json.state.plans[ws].entries.length === 3 && !r.json.state.plans[ws].confirmed && new Date(ws + "T12:00").getDay() === 6, r.json && r.json.state.plans[ws]);
  await kitchen("POST", "/api/change", { op: "confirm", body: { weekStart: ws } });

  // the screen: the plan and the shopping list
  await h.tap(".os-page-meals");
  await until(() => page.evaluate(() => document.querySelectorAll(".ml-dish").length === 3));
  const scr = await page.evaluate(() => ({
    dishes: [...document.querySelectorAll(".ml-tray .ml-dish b")].map((b) => b.textContent),
    days: document.querySelectorAll(".ml-day[data-day]:not(.ml-tray)").length,
    cats: [...document.querySelectorAll(".ml-cat")].map((c) => c.textContent),
    onion: [...document.querySelectorAll(".ml-item")].find((x) => /Onion/.test(x.textContent))?.querySelector(".ml-amt").textContent,
    qr: !!document.querySelector(".ml-qr svg"), url: document.querySelector(".ml-url").textContent
  }));
  ok("screen: the confirmed plan (no days yet), 7 days, the shopping list by section with amounts added up, the kitchen page's QR code",
    scr.dishes.length === 3 && scr.days === 7 && scr.cats[0] === "Vegetables" && scr.onion === "3" && scr.qr && /:8093$/.test(scr.url), scr);
  await h.shot("meals-plan");

  // drag a dish onto a day → its cooking day, on the calendar
  const from = await h.box(".ml-tray .ml-dish"), to = await h.box(".ml-day[data-day]:not(.ml-tray):nth-child(3)");
  const name = await page.evaluate(() => document.querySelector(".ml-tray .ml-dish b").textContent);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await until(async () => (await kitchen("GET", "/api/state")).json.plans[ws].entries.some((e) => e.day));
  st = (await kitchen("GET", "/api/state")).json;
  const placed = st.plans[ws].entries.find((e) => e.day);
  await until(() => page.evaluate((n) => [...MM.getModules().withClass("MMM-OpenSky-Home")[0].pools.values()].flat().some((ev) => ev.title === `Cook: ${n}`), name));
  const onCal = await page.evaluate((n) => [...MM.getModules().withClass("MMM-OpenSky-Home")[0].pools.values()].flat().find((ev) => ev.title === `Cook: ${n}`), name);
  ok("dragged onto a day: that's its cooking day, and it's on the calendar (all day, 'Cook: …')", placed && placed.day === st.plans[ws].days[1] && onCal && onCal.fullDayEvent && new Date(Number(onCal.startDate)).getDate() === new Date(placed.day + "T12:00").getDate(), { placed, onCal: onCal && onCal.title });

  // tick what's at home, then send the rest to Bring! (asks first)
  await page.evaluate(() => [...document.querySelectorAll(".ml-item")].find((x) => /Flour|Milk|Minced/.test(x.textContent)).click());
  await until(() => page.evaluate(() => !!document.querySelector(".ml-item.have")));
  const ticked = await page.evaluate(() => document.querySelector(".ml-item.have .ml-name").textContent);
  await h.tap(".ml-bring");
  await h.sleep(300);
  const asked = await page.evaluate(() => document.querySelector(".ml-pop-title")?.textContent);
  ok("Send to Bring! asks first (nothing sent yet)", /Bring/.test(asked || "") && sent.length === 0, asked);
  await page.evaluate(() => [...document.querySelectorAll(".ml-pop .ml-btn")].find((b) => b.classList.contains("primary")).click());
  await until(() => sent.length > 0);
  await h.sleep(300);
  ok("after yes: the unticked ingredients with their amounts are on the Bring! list; the ticked one isn't", sent.includes("Onion|3") && !sent.some((x) => x.startsWith(`${ticked}|`)) && sent.length === 5, sent);   // (6 different ingredients, 1 ticked)


  // the screen's dish list: every dish, a dish's ingredients, and a new dish made on the screen
  await page.evaluate(() => [...document.querySelectorAll(".ml-views button")].find((b) => b.dataset.v === "dishes").click());
  await h.sleep(300);
  const listed = await page.evaluate(() => [...document.querySelectorAll(".ml-entry b")].map((b) => b.textContent));
  await page.evaluate(() => [...document.querySelectorAll(".ml-entry")].find((e) => /Lasagna/.test(e.textContent)).click());
  await h.sleep(300);
  const info = await page.evaluate(() => document.querySelector(".ml-pop").innerText);
  ok("screen: all dishes listed; a tap shows its ingredients with amounts", listed.join() === "Lasagna,Pancakes,Veggie curry" && /Minced beef/.test(info) && /500 g/.test(info), { listed, info });
  await page.evaluate(() => document.querySelector(".ml-pop .ml-btn.primary").click());
  await h.tap(".ml-new");
  await h.sleep(400);
  const kb = await page.evaluate(() => document.body.classList.contains("kb-open"));
  await page.evaluate(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); };
    const pop = document.querySelector(".ml-pop");
    set(pop.querySelector(".ml-name-in"), "Tomato soup");
    const row = pop.querySelector(".ml-ing-edit");
    set(row.querySelector(".ml-amt-in"), "800"); set(row.querySelector(".ml-unit-in"), "g"); set(row.querySelector(".ml-ing-in"), "Tomatoes");
    [...pop.querySelectorAll(".ml-pop-actions .ml-btn")].find((b) => b.classList.contains("primary")).click();
  });
  await until(async () => (await kitchen("GET", "/api/state")).json.dishes.some((d) => d.name === "Tomato soup"));
  const soup = (await kitchen("GET", "/api/state")).json.dishes.find((d) => d.name === "Tomato soup");
  ok("screen: a new dish (the keyboard comes up for its name), saved with its ingredient — the phones see it too", kb && soup && soup.ingredients[0].name === "Tomatoes" && soup.ingredients[0].amount === 800 &&
    await page.evaluate(() => [...document.querySelectorAll(".ml-entry b")].some((b) => b.textContent === "Tomato soup")), soup);

  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);

  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
module.exports.patchSettings = (s) => { s.pages = ["home", "meals", "calendar", "lists", "timer"]; };
module.exports.patchSecrets = (s) => { s.bring = { email: "family@example.test", password: "fake-bring-password" }; };
module.exports.env = { OPENSKY_BRING_API: `http://127.0.0.1:${BRING}` };
