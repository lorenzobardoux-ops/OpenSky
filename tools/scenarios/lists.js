// Lists: on-device lists on the Home card — add, check off with Undo, edit, delete, errors, idle close.
module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const fs = require("fs"), path = require("path");
  const FILE = path.join(__dirname, "..", "out", "lists.test.json");
  const stored = (name) => (JSON.parse(fs.readFileSync(FILE, "utf8")).lists[name] || []).map((x) => x.text);
  const cards = () => page.evaluate(() => [...document.querySelectorAll(".hd-lists .lc-list")].map((c) => ({
    title: c.querySelector(".lc-list-title").textContent, badge: c.querySelector(".lc-badge").textContent,
    items: [...c.querySelectorAll(".lc-item")].map((r) => r.querySelector(".lc-item-text").textContent + (r.classList.contains("is-done") ? " ✓" : "")) })));
  const groceries = async () => ((await cards()).find((c) => c.title === "Groceries") || { items: [] });
  const popup = () => page.evaluate(() => { const m = document.querySelector(".osl-overlay"); return m ? { title: m.querySelector(".osl-title").textContent, value: m.querySelector(".osl-input").value, error: m.querySelector(".osl-error").hidden ? "" : m.querySelector(".osl-error").textContent, buttons: [...m.querySelectorAll(".osl-btn")].map((b) => b.textContent) } : null; });
  const typeIn = (v) => page.evaluate((v) => { document.querySelector(".osl-input").value = v; }, v);
  const press = (label) => page.evaluate((l) => [...document.querySelectorAll(".osl-btn")].find((b) => b.textContent === l).click(), label);
  const until = async (fn, tries = 20) => { for (let i = 0; i < tries && !(await fn()); i++) await h.sleep(300); return fn(); };
  const tapItem = (text, part) => page.evaluate(([t, p]) => { const r = [...document.querySelectorAll(".hd-lists .lc-item")].find((x) => x.querySelector(".lc-item-text").textContent === t); r.querySelector(p).click(); }, [text, part]);

  await until(async () => (await groceries()).items.length === 2);
  ok("seeded lists show", (await groceries()).items.join() === "Milk,Apples", await cards());

  // add
  await h.tap(".hd-lists .lc-add-item"); await h.sleep(300);
  let p = await popup();
  ok("Add item opens 'Add to Groceries' (Cancel / Add)", p && p.title === "Add to Groceries" && p.buttons.join() === "Cancel,Add", p);
  await press("Add"); await h.sleep(200);
  p = await popup();
  ok("empty → stays open with a friendly hint", p && /type something/i.test(p.error), p);
  await typeIn("  Bread   rolls "); await press("Add");
  await until(async () => (await groceries()).items.includes("Bread rolls"));
  ok("added: popup closes, shows on the card, saved on the Pi (tidied spaces)", !(await popup()) && (await groceries()).items.includes("Bread rolls") && stored("Groceries").includes("Bread rolls"), stored("Groceries"));

  // check off + Undo
  await tapItem("Milk", ".lc-check"); await h.sleep(300);
  const undoShown = await page.evaluate(() => { const u = document.querySelector(".osl-undo.show"); return u ? u.textContent : null; });
  ok("check-off: shown done at once, Undo offered, badge counts open items", (await groceries()).items.includes("Milk ✓") && /Milk/.test(undoShown || "") && (await groceries()).badge === "2", { g: await groceries(), undoShown });
  await h.tap(".osl-undo-btn"); await h.sleep(300);
  ok("Undo: back to normal, nothing changed on the Pi", (await groceries()).items.includes("Milk") && stored("Groceries").includes("Milk") && !(await page.evaluate(() => !!document.querySelector(".osl-undo.show"))));
  await tapItem("Apples", ".lc-check");
  await until(async () => !(await groceries()).items.some((t) => t.startsWith("Apples")), 30);
  ok("after the Undo time: gone from the card and the Pi", !(await groceries()).items.some((t) => t.startsWith("Apples")) && !stored("Groceries").includes("Apples"), stored("Groceries"));

  // edit
  await tapItem("Bread rolls", ".lc-item-text"); await h.sleep(300);
  p = await popup();
  ok("tap an item → edit popup with its text (Delete / Done / Cancel / Save)", p && p.value === "Bread rolls" && p.buttons.join() === "Delete,Done ✓,Cancel,Save", p);
  await typeIn("Rye bread"); await press("Save");
  await until(async () => (await groceries()).items.includes("Rye bread"));
  ok("edit saved", (await groceries()).items.includes("Rye bread") && stored("Groceries").includes("Rye bread") && !stored("Groceries").includes("Bread rolls"));

  // an item that changed underneath → error inside the popup, popup stays
  await tapItem("Rye bread", ".lc-item-text"); await h.sleep(300);
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8")); raw.lists.Groceries = raw.lists.Groceries.filter((x) => x.text !== "Rye bread"); fs.writeFileSync(FILE, JSON.stringify(raw));
  await typeIn("Rye bread x2"); await press("Save"); await h.sleep(800);
  p = await popup();
  ok("changed elsewhere → clear message in the popup, buttons usable again", p && /gone/i.test(p.error) && p.buttons.includes("Save"), p);
  ok("…and the failure is in the log too (for opensky logs)", /\[OpenSky\] list "Groceries": couldn't edit an item: .*gone/i.test(h.serverLog()), h.serverLog().split("\n").filter((l) => /couldn.t/.test(l)));
  await page.evaluate(() => document.querySelector(".osl-x").click());
  await page.evaluate(() => MM.getModules().withClass("MMM-OpenSky-Lists")[0].sendSocketNotification("OS_LISTS_REFRESH"));
  await until(async () => !(await groceries()).items.includes("Rye bread"));

  // delete + Done ✓ from the popup
  await tapItem("Milk", ".lc-item-text"); await h.sleep(300); await press("Delete");
  await until(async () => !(await groceries()).items.includes("Milk"));
  ok("Delete removes it", !(await groceries()).items.includes("Milk") && !stored("Groceries").includes("Milk"), stored("Groceries"));
  await h.tap(".hd-lists .lc-add-item"); await h.sleep(300); await typeIn("Eggs"); await press("Add");
  await until(async () => (await groceries()).items.includes("Eggs"));
  await tapItem("Eggs", ".lc-item-text"); await h.sleep(300); await press("Done ✓"); await h.sleep(300);
  ok("Done ✓ in the popup = check off with Undo", !(await popup()) && (await groceries()).items.includes("Eggs ✓") && await page.evaluate(() => !!document.querySelector(".osl-undo.show")));
  await h.shot("lists-undo");
  await until(async () => !(await groceries()).items.some((t) => t.startsWith("Eggs")), 30);
  ok("…and it's gone after the Undo time; the empty list says All done", (await groceries()).items.length === 0 && await page.evaluate(() => /All done/.test(document.querySelector(".hd-lists .lc-empty")?.textContent || "")), await groceries());

  // idle → popup closes
  await h.tap(".hd-lists .lc-add-item"); await h.sleep(300);
  await page.evaluate(() => MM.getModules().withClass("MMM-OpenSky-Sidebar")[0].sendNotification("OPENSKY_IDLE_RESET"));
  await h.sleep(200);
  ok("idle reset closes the popup", !(await popup()));

  // ---- the Lists page ----
  ok("Home has 'See all' (the Lists page is on)", !!(await h.box(".hd-see-all")));
  const many = JSON.parse(fs.readFileSync(FILE, "utf8"));
  many.lists.Chores = [...Array(30)].map((_, i) => ({ id: `c${i}`, text: `Chore number ${i + 1}` }));
  fs.writeFileSync(FILE, JSON.stringify(many));
  await h.sleep(3200);   // (refreshes are throttled to one per 3 s)
  // Home: a long list scrolls — by dragging (a touchscreen that acts like a mouse), keeping its place on a redraw
  await page.evaluate(() => MM.getModules().withClass("MMM-OpenSky-Home")[0].sendNotification("OPENSKY_LISTS_REFRESH"));
  await until(async () => (await page.evaluate(() => document.querySelectorAll(".hd-lists .lc-item").length)) >= 30);
  const homeBox = () => page.evaluate(() => { const b = [...document.querySelectorAll(".hd-lists .lc-list")].find((c) => /Chores/.test(c.textContent)).querySelector(".lc-items"); return { top: b.scrollTop, more: b.classList.contains("lc-more") }; });
  const hb = await h.box(".hd-lists .lc-list:nth-child(2) .lc-items");
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height * 0.2, { steps: 10 });
  await page.mouse.up();
  await h.sleep(300);
  const scrolled = await homeBox();
  await page.evaluate(() => MM.getModules().withClass("MMM-OpenSky-Home")[0].renderLists());
  await h.sleep(200);
  const redrawn = await homeBox();
  ok("Home: a long list scrolls with a drag (no item opens), and keeps its place when redrawn", scrolled.top > 50 && Math.abs(redrawn.top - scrolled.top) < 2 && !(await popup()), { scrolled, redrawn });
  await page.evaluate(() => { const b = [...document.querySelectorAll(".hd-lists .lc-list")].find((c) => /Chores/.test(c.textContent)).querySelector(".lc-items"); b.scrollTop = b.scrollHeight; });
  await h.sleep(200);
  ok("Home: the bottom fades only while there's more below", !(await homeBox()).more);
  await h.tap(".hd-see-all");   // the Lists page asks for fresh lists when it opens

  await until(async () => (await page.evaluate(() => document.querySelectorAll(".lp-root .lc-item").length)) === 30);
  const lp = () => page.evaluate(() => {
    const vis = (e) => !!e && e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    return { zoom: Number(getComputedStyle(document.documentElement).getPropertyValue("--os-zoom")) || 1, page: vis(document.querySelector(".lp-root")), home: vis(document.querySelector(".hd-root")), active: document.querySelector(".os-page-lists")?.classList.contains("active"),
      cols: [...document.querySelectorAll(".lp-root .lc-list")].map((c) => ({ title: c.querySelector(".lc-list-title").textContent, n: c.querySelectorAll(".lc-item").length,
        scrolls: c.querySelector(".lc-items").scrollHeight > c.querySelector(".lc-items").clientHeight + 10, width: Math.round(c.getBoundingClientRect().width) })) };
  });
  let L = await lp();
  ok("'See all' opens the Lists page (sidebar highlights it)", L.page && !L.home && L.active, L);
  ok("every list side by side; a long list scrolls", L.cols.length === 2 && L.cols[1].title === "Chores" && L.cols[1].n === 30 && L.cols[1].scrolls && L.cols[0].width > 600 * L.zoom, L.cols);   // (600 px on the 1920-wide layout, scaled)
  await page.evaluate(() => { document.querySelectorAll(".lp-root .lc-items")[1].scrollTop = 400; });
  await page.evaluate(() => [...document.querySelectorAll(".lp-root .lc-item")].find((r) => r.textContent === "Chore number 12").querySelector(".lc-check").click());
  await h.sleep(400);
  const kept = await page.evaluate(() => document.querySelectorAll(".lp-root .lc-items")[1].scrollTop);
  ok("check-off on the Lists page: ticked with Undo, list keeps its scroll position", kept >= 380 && await page.evaluate(() => !!document.querySelector(".osl-undo.show") && [...document.querySelectorAll(".lp-root .lc-item.is-done")].some((r) => r.textContent === "Chore number 12")), kept);
  await h.tap(".osl-undo-btn"); await h.sleep(300);
  await page.evaluate(() => document.querySelectorAll(".lp-root .lc-add-item")[0].click()); await h.sleep(300);
  await typeIn("Coffee"); await press("Add");
  await until(async () => (await lp()).cols[0].n === 1);
  ok("Add item works from the Lists page", stored("Groceries").includes("Coffee") && (await lp()).cols[0].n === 1, stored("Groceries"));
  await h.shot("lists-page");

  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
