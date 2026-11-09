// Event templates on Home (home.panel "templates"): the card replaces the photos; a template is made with the form
// (name, notes, time, color), dragged onto a day — twice, it stays a template — and the events show in its color,
// in OpenSky's own calendar; one with a chosen calendar goes there; tapping a template changes it.
module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const until = async (fn, tries = 40) => { for (let i = 0; i < tries && !(await fn()); i++) await h.sleep(250); return fn(); };
  await page.evaluate(() => document.querySelector(".osu-later")?.click());
  await until(() => page.evaluate(() => !!document.querySelector(".hd-templates .tp-new")));
  ok("the templates card is where the photos were", await page.evaluate(() => !!document.querySelector(".hd-templates .tp-new") && !document.querySelector(".hd-photo")));

  // two templates through the form
  const make = (title, opts) => page.evaluate(async ([title, opts]) => {
    document.querySelector(".tp-new").click();
    await new Promise((r) => setTimeout(r, 300));
    const m = document.querySelector(".tp-modal");
    m.querySelector(".tp-name").value = title;
    m.querySelector(".tp-desc").value = opts.desc || "";
    if (opts.allDay) m.querySelector(".tp-toggle").click();
    else { m.querySelector(".tp-start").value = opts.start; m.querySelector(".tp-end").value = opts.end; }
    m.querySelector(`.tp-color[data-c="${opts.color}"]`).click();
    for (const c of opts.calendars || []) [...m.querySelectorAll(".tp-cal")].find((b) => b.textContent === c)?.click();
    m.querySelector(".tp-save").click();
  }, [title, opts]);
  await make("Football training", { start: "17:30", end: "19:00", color: "green", desc: "Pitch 2" });
  await until(() => page.evaluate(() => document.querySelectorAll(".tp-chip").length === 1));
  await make("Visit Grandma", { allDay: true, color: "purple", calendars: ["Testers"] });
  await until(() => page.evaluate(() => document.querySelectorAll(".tp-chip").length === 2));
  ok("two templates made with the form", await page.evaluate(() => [...document.querySelectorAll(".tp-chip-title")].map((x) => x.textContent).join() === "Football training,Visit Grandma"));

  // drag (a mouse drag, as a touchscreen that acts like a mouse sends it) onto days of this week
  const days = await page.evaluate(() => [...document.querySelectorAll(".hd-day[data-day]")].map((d) => d.dataset.day));
  const drag = async (chipIndex, day) => {
    const from = await h.box(`.tp-chip:nth-child(${chipIndex})`), to = await h.box(`.hd-day[data-day="${day}"]`);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
  };
  const titles = (day) => page.evaluate((d) => [...document.querySelectorAll(`.hd-day[data-day="${d}"] .hd-event-title`)].map((x) => x.textContent), day);
  await drag(1, days[1]);
  await until(async () => (await titles(days[1])).includes("Football training"));
  await drag(1, days[3]);
  await until(async () => (await titles(days[3])).includes("Football training"));
  await drag(2, days[3]);
  await until(async () => (await titles(days[3])).includes("Visit Grandma"));
  await h.shot("templates-placed");
  ok("dragged onto a day: the event is there — the same template twice, on two days", (await titles(days[1])).includes("Football training") && (await titles(days[3])).includes("Football training") && (await titles(days[3])).includes("Visit Grandma"), { a: await titles(days[1]), b: await titles(days[3]) });
  ok("the templates are still there to use again", await page.evaluate(() => document.querySelectorAll(".tp-chip").length === 2));
  const info = await page.evaluate((d) => {
    const pill = [...document.querySelectorAll(`.hd-day[data-day="${d}"] .hd-event`)].find((p) => /Football/.test(p.textContent));
    const gran = [...document.querySelectorAll(`.hd-day[data-day="${d}"] .hd-event`)].find((p) => /Grandma/.test(p.textContent));
    return { time: pill.querySelector(".hd-event-time").textContent, bar: getComputedStyle(pill).getPropertyValue("--evc-bar").trim(), granBar: getComputedStyle(gran).getPropertyValue("--evc-bar").trim(), granAllDay: gran.querySelector(".hd-event-time").textContent };
  }, days[3]);
  ok("at the template's time, in the template's color (not the calendar's)", /17:30/.test(info.time) && info.bar === "#78b014" && info.granBar === "#7b4ae2" && /day|tägig/i.test(info.granAllDay), info);
  // which calendar each one went to: the event view says
  await page.evaluate((d) => [...document.querySelectorAll(`.hd-day[data-day="${d}"] .hd-event`)].find((p) => /Grandma/.test(p.textContent)).click(), days[3]);
  await h.sleep(500);
  const where = await page.evaluate(() => document.querySelector(".calendar-editor-modal, .event-view-header")?.closest("div").parentElement.innerText || "");
  ok("a template with a chosen calendar goes there (Testers)", /Testers/.test(where), where);
  await page.evaluate(() => document.querySelector(".event-close-btn")?.click());
  // a tap (no drag) changes the template
  const chip = await h.box(".tp-chip:nth-child(1)");
  await page.mouse.click(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await h.sleep(400);
  ok("tapping a template opens it to change", await page.evaluate(() => document.querySelector(".tp-name")?.value === "Football training"));
  await page.evaluate(() => document.querySelector(".tp-cancel")?.click());

  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
module.exports.patchSettings = (s) => { s.home = { panel: "templates" }; };
