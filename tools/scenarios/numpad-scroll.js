// The Timer's boxes bring up a number pad (digits + delete only; the first digit replaces "00", two digits at most,
// too big → the largest allowed), and a finger drag scrolls the Settings panel (also when the touchscreen acts like a
// mouse) without flipping the switch it started on.
module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const kb = () => page.evaluate(() => { const k = document.querySelector(".okb"); return !!k && !k.hidden && document.body.classList.contains("kb-open"); });
  const until = async (fn, tries = 20) => { for (let i = 0; i < tries && !(await fn()); i++) await h.sleep(200); return fn(); };
  const settle = async () => { let last = null; for (let i = 0; i < 20; i++) { const t = await page.evaluate(() => document.querySelector(".okb").getBoundingClientRect().top); if (t === last) break; last = t; await h.sleep(100); } };
  const key = async (k) => { await h.tap(`.okb-key[data-key="${k}"]`); await h.sleep(60); };

  // ---- Timer: number pad
  await page.evaluate(() => document.querySelector(".osu-later")?.click());
  await h.tap(".os-page-timer"); await h.sleep(500);
  await h.tap("#timer-minutes");
  await until(kb); await settle();
  const keys = await page.evaluate(() => [...document.querySelectorAll(".okb-key[data-key]")].map((b) => b.dataset.key).filter((k) => k !== "{hide}"));
  ok("the Timer's box brings up the number pad: 0–9 and delete only", await kb() && keys.sort().join(",") === "0,1,2,3,4,5,6,7,8,9,{back}", keys);
  for (const k of ["7", "5", "1"]) await key(k);
  const typed = await page.evaluate(() => document.getElementById("timer-minutes").value);
  ok("the first digit replaces 00; two digits at most", typed === "75", typed);
  await key("{back}"); await key("9");
  await h.shot("numpad-timer");
  await h.tap(".timer-start-btn"); await h.sleep(500);
  const started = await page.evaluate(() => { const t = MM.getModules().withClass("MMM-OpenSky-Timer")[0]; return t.timers.map((x) => x.total); });
  ok("delete works; 79 minutes → 59 (the largest), and the timer starts", JSON.stringify(started) === JSON.stringify([59 * 60]), started);
  await page.evaluate(() => { const t = MM.getModules().withClass("MMM-OpenSky-Timer")[0]; while (t.timers.length) t.removeTimer(0); });

  ok("the keyboard goes away", !(await kb()));

  // ---- Settings: drag to scroll (a mouse drag, like a touchscreen that reaches the page as a mouse)
  await h.tap(".os-settings"); await h.sleep(1200);
  const row = await h.box('.ost-page[data-page="calendar"] .ost-label');
  const before = await page.evaluate(() => ({ top: document.querySelector(".ost-body").scrollTop, on: document.querySelectorAll(".ost-toggle.on").length }));
  await page.mouse.move(row.x + 10, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 10, row.y + row.height / 2 - 220, { steps: 12 });
  await page.mouse.up();
  await h.sleep(300);
  const after = await page.evaluate(() => ({ top: document.querySelector(".ost-body").scrollTop, on: document.querySelectorAll(".ost-toggle.on").length, open: !document.querySelector(".ost-overlay").hidden }));
  ok("a drag scrolls the Settings panel; it stays open and no switch flips", after.top > before.top + 100 && after.open && after.on === before.on, { before, after });
  await h.shot("settings-scrolled");
  // a plain tap still works (the Up/Down buttons are drawn only for pages that are on; a toggle is enough here)
  const t0 = await page.evaluate(() => document.querySelector(".ost-toggle[data-id='dim']").classList.contains("on"));
  await page.evaluate(() => { document.querySelector(".ost-body").scrollTop = 0; });
  await h.tap(".ost-toggle[data-id='dim']"); await h.sleep(600);
  const t1 = await page.evaluate(() => document.querySelector(".ost-toggle[data-id='dim']").classList.contains("on"));
  ok("a tap without dragging still flips a switch", t1 !== t0, { t0, t1 });
  await page.evaluate(() => document.querySelector(".ost-x")?.click());

  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
