// Formula 1 in the header (header.f1): the next race weekend with its name and only its next session (sprint
// qualifying, sprint, qualifying or the race) with its start and the days until it; 30 minutes after a session's start
// it moves on to the next one, 30 minutes after the race's start to the next weekend. The races are handed in as the node helper would (the
// harness points OPENSKY_F1_URL at nothing, so no test asks the real calendar).
module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const pill = () => page.evaluate(() => { const p = document.querySelector(".hb-f1"); return p ? { name: p.querySelector(".hb-f1-name").textContent, sessions: [...p.querySelectorAll(".hb-f1-session")].map((x) => x.textContent), when: (p.querySelector(".hb-f1-when") || {}).textContent || "", today: p.classList.contains("hb-f1-today") } : null; });
  // races as { name, race, quali, sprint, sprintQuali }: hours from today's noon (so no test day crosses midnight)
  // (the header redraws a moment after the races arrive)
  const show = async (list) => { await show1(list); await h.sleep(400); };
  const show1 = (list) => page.evaluate((list) => {
    const hd = MM.getModules().withClass("MMM-OpenSky-Header")[0];
    hd.config.f1 = true;
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    hd.now = noon;
    const at = (hrs) => (hrs == null ? null : noon.getTime() + hrs * 3600e3);
    hd.socketNotificationReceived("F1_RESULT", { ok: true, races: list.map((r) => ({ name: r.name, start: at(r.race), quali: at(r.quali), sprint: at(r.sprint), sprintQuali: at(r.sprintQuali) })) });
  }, list);

  ok("no pill while F1 is off", (await pill()) === null);
  const d = 24;
  await show([{ name: "Old Grand Prix", race: -7 * d }, { name: "Next Grand Prix", race: 12 * d, quali: 11 * d }, { name: "Later Grand Prix", race: 30 * d, quali: 29 * d }]);
  let p = await pill();
  ok("the next weekend (not a past one): only its next session (Quali) and the days", p && p.name === "Next Grand Prix" && p.sessions.length === 1 && /Quali/i.test(p.sessions[0]) && /11/.test(p.when) && !p.today, p);
  await h.shot("f1-header");
  // a sprint weekend: sprint quali Fri, sprint Sat 11:00, quali Sat 15:00, race Sun
  const sprint = (shift) => [{ name: "Sprint Grand Prix", sprintQuali: d + shift, sprint: 2 * d - 1 + shift, quali: 2 * d + 3 + shift, race: 3 * d + shift }];
  const order = [];
  for (const [shift, label] of [[0, "sprint quali, in 1 day"], [-d - 0.4, "sprint quali started 24 min ago"], [-d - 0.6, "36 min after it: the sprint"], [-2 * d + 1 - 0.6, "36 min after the sprint: quali"], [-2 * d - 3 - 0.6, "36 min after quali: the race"]]) {
    await show(sprint(shift)); p = await pill(); order.push(`${label}: ${p && p.sessions[0]}`);
  }
  ok("a sprint weekend goes sprint quali → sprint → quali → race, each until 30 minutes after its start",
    /Sprint.?quali/i.test(order[0]) && /Sprint.?quali/i.test(order[1]) && /Sprint(?!.?quali)/i.test(order[2].split(": ")[1]) && /Quali/i.test(order[3].split(": ")[1]) && !/Sprint/i.test(order[3].split(": ")[1]) && /Race|Rennen/i.test(order[4].split(": ")[1]), order);
  await show([{ name: "Today Grand Prix", race: 2, quali: -d }]);
  p = await pill();
  ok("race day: the race today with its start time, highlighted", p && /Race|Rennen/i.test(p.sessions[0]) && /today|heute/.test(p.sessions[0]) && p.today && !p.when, p);
  await show([{ name: "Done Grand Prix", race: -0.6 }, { name: "Next Grand Prix", race: 7 * d, quali: 6 * d }]);
  p = await pill();
  ok("30 minutes after the race's start it's the next weekend's turn", p && p.name === "Next Grand Prix", p);
  await show([{ name: "No Quali Grand Prix", race: 3 * d }]);
  p = await pill();
  ok("no other session in the calendar: the race", p && /Race|Rennen/i.test(p.sessions[0]), p);
  await show([]);
  ok("no races (between seasons): no pill", (await pill()) === null);

  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
