// Formula 1 in the header (header.f1): the next race weekend with its name, when qualifying and the race start, and
// the days until the next of them; each drops off 30 minutes after its start (qualifying first, then the race). The races are handed in as the node helper would (the
// harness points OPENSKY_F1_URL at nothing, so no test asks the real calendar).
module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const pill = () => page.evaluate(() => { const p = document.querySelector(".hb-f1"); return p ? { name: p.querySelector(".hb-f1-name").textContent, sessions: [...p.querySelectorAll(".hb-f1-session")].map((x) => x.textContent), when: (p.querySelector(".hb-f1-when") || {}).textContent || "", today: p.classList.contains("hb-f1-today") } : null; });
  // set the races relative to "now" on the screen (days at noon, so no test day ever crosses midnight)
  // (the header redraws a moment after the races arrive)
  const show = async (list) => { await show1(list); await h.sleep(400); };
  const show1 = (list) => page.evaluate((list) => {

    const hd = MM.getModules().withClass("MMM-OpenSky-Header")[0];
    hd.config.f1 = true;
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    hd.now = noon;
    hd.socketNotificationReceived("F1_RESULT", { ok: true, races: list.map(([name, days, hours, qualiHoursBefore]) => { const start = noon.getTime() + days * 86400e3 + (hours || 0) * 3600e3; return { name, start, quali: qualiHoursBefore ? start - qualiHoursBefore * 3600e3 : null }; }) });
  }, list);

  ok("no pill while F1 is off", (await pill()) === null);
  // [name, days from today's noon, + hours, qualifying this many hours before the race]
  await show([["Old Grand Prix", -7], ["Next Grand Prix", 12, 0, 24], ["Later Grand Prix", 30, 0, 24]]);
  let p = await pill();
  ok("the next weekend (not a past one): qualifying + race times and the days", p && p.name === "Next Grand Prix" && p.sessions.length === 2 && /Quali/i.test(p.sessions[0]) && /12/.test(p.when) && !p.today, p);
  await h.shot("f1-header");
  await show([["Tomorrow Grand Prix", 1, 0, 24]]);
  p = await pill();
  ok("qualifying today, the race tomorrow", p && p.today && /today|heute/.test(p.sessions[0]) && /tomorrow|morgen/.test(p.sessions[1]) && !p.when, p);
  await show([["Weekend Grand Prix", 1, 0, 24.4]]);   // qualifying started 24 min ago (= 0.4 h before noon → 11:36)
  p = await pill();
  ok("qualifying stays until 30 minutes after its start", p && p.sessions.length === 2, p);
  await show([["Weekend Grand Prix", 1, 0, 24.6]]);   // started 36 min ago
  p = await pill();
  ok("then only the race is left", p && p.sessions.length === 1 && /Race|Rennen/i.test(p.sessions[0]), p);
  await show([["Done Grand Prix", 0, -0.6], ["Next Grand Prix", 7, 0, 24]]);   // the race started 36 min ago
  p = await pill();
  ok("30 minutes after the race's start it's the next weekend's turn", p && p.name === "Next Grand Prix", p);
  await show([["No Quali Grand Prix", 3]]);
  p = await pill();
  ok("no qualifying time in the calendar: the race alone", p && p.sessions.length === 1, p);
  await show([]);
  ok("no races (between seasons): no pill", (await pill()) === null);

  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
