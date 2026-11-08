// Formula 1 in the header (header.f1): the next race with its name and the days until it, "tomorrow", on race day
// its start time; a race is gone 3 hours after its start. The races are handed in as the node helper would (the
// harness points OPENSKY_F1_URL at nothing, so no test asks the real calendar).
module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const pill = () => page.evaluate(() => { const p = document.querySelector(".hb-f1"); return p ? { name: p.querySelector(".hb-f1-name").textContent, when: p.querySelector(".hb-f1-when").textContent, today: p.classList.contains("hb-f1-today") } : null; });
  // set the races relative to "now" on the screen (days at noon, so no test day ever crosses midnight)
  // (the header redraws a moment after the races arrive)
  const show = async (list) => { await show1(list); await h.sleep(400); };
  const show1 = (list) => page.evaluate((list) => {

    const hd = MM.getModules().withClass("MMM-OpenSky-Header")[0];
    hd.config.f1 = true;
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    hd.now = noon;
    hd.socketNotificationReceived("F1_RESULT", { ok: true, races: list.map(([name, days, hours]) => ({ name, start: noon.getTime() + days * 86400e3 + (hours || 0) * 3600e3 })) });
  }, list);

  ok("no pill while F1 is off", (await pill()) === null);
  await show([["Old Grand Prix", -7], ["Next Grand Prix", 12], ["Later Grand Prix", 30]]);
  let p = await pill();
  ok("the next race (not a past one) with its days", p && p.name === "Next Grand Prix" && /12/.test(p.when) && !p.today, p);
  await h.shot("f1-header");
  await show([["Tomorrow Grand Prix", 1]]);
  p = await pill();
  ok("the day before: tomorrow", p && /tomorrow|morgen/.test(p.when), p);
  await show([["Today Grand Prix", 0, 2], ["Next Grand Prix", 7]]);
  p = await pill();
  ok("race day: today with its start time", p && p.name === "Today Grand Prix" && p.today && /\d/.test(p.when), p);
  await show([["Done Grand Prix", 0, -4], ["Next Grand Prix", 7]]);
  p = await pill();
  ok("3 hours after the start it moves on to the next race", p && p.name === "Next Grand Prix", p);
  await show([]);
  ok("no races (between seasons): no pill", (await pill()) === null);

  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
