// Formula 1 in the header (header.f1): the next race weekend with its name and all its sessions in order (sprint
// qualifying, sprint, qualifying, race) with their starts in German time; the next one is marked, finished ones fade;
// 30 minutes after the race's start it's the next weekend's turn. The races are handed in as the node helper would (the
// harness points OPENSKY_F1_URL at nothing, so no test asks the real calendar).
module.exports = async (page, h) => {
  const R = {}; const ok = (k, v, i) => { R[k] = v; h.log(`${v ? "PASS" : "FAIL"}  ${k}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
  const pill = () => page.evaluate(() => { const p = document.querySelector(".hb-f1"); return p ? { name: p.querySelector(".hb-f1-name").textContent, sessions: [...p.querySelectorAll(".hb-f1-session")].map((x) => x.textContent), next: (p.querySelector(".hb-f1-session.next") || {}).textContent || "", done: p.querySelectorAll(".hb-f1-session.done").length, when: (p.querySelector(".hb-f1-when") || {}).textContent || "", today: p.classList.contains("hb-f1-today") } : null; });
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
  ok("the next weekend (not a past one): Quali + Race together, the next marked, and the days", p && p.name === "Next Grand Prix" && p.sessions.length === 2 && /^Quali/i.test(p.sessions[0]) && /^(Race|Rennen)/i.test(p.sessions[1]) && /^Quali/.test(p.next) && /11/.test(p.when) && !p.today, p);
  await h.shot("f1-header");
  // a sprint weekend: sprint quali, sprint, quali, race — all four, in that order
  const sprint = (shift) => [{ name: "Sprint Grand Prix", sprintQuali: d + shift, sprint: 2 * d - 1 + shift, quali: 2 * d + 3 + shift, race: 3 * d + shift }];
  await show(sprint(0));
  p = await pill();
  ok("a sprint weekend: all four sessions in order", p && p.sessions.length === 4 && /Sprint/i.test(p.sessions[0]) && /Sprint/i.test(p.sessions[1]) && /Quali/i.test(p.sessions[2]) && !/Sprint/i.test(p.sessions[2]) && /^(Race|Rennen)/i.test(p.sessions[3]) && p.next === p.sessions[0], p);
  await show(sprint(-d - 0.6));   // sprint quali started 36 min ago
  p = await pill();
  ok("30 minutes after a session's start it fades and the next one is marked; nothing disappears", p && p.sessions.length === 4 && p.done === 1 && p.next === p.sessions[1], p);
  await show(sprint(-3 * d - 0.4));   // the race started 24 min ago
  p = await pill();
  ok("during the race the weekend stays", p && p.name === "Sprint Grand Prix" && p.done === 3 && p.next === p.sessions[3] && p.today, p);
  await show([{ name: "Done Grand Prix", race: -0.6, quali: -d }, { name: "Next Grand Prix", race: 7 * d, quali: 6 * d }]);
  p = await pill();
  ok("30 minutes after the race's start it's the next weekend's turn", p && p.name === "Next Grand Prix", p);
  // start times in German time, whatever the Pi's clock says (here: the weekend's race at 14:00 UTC)
  const berlin = await page.evaluate(async () => {
    const hd = MM.getModules().withClass("MMM-OpenSky-Header")[0];
    hd.config.f1TimeZone = "Europe/Berlin";
    const start = Date.UTC(new Date().getUTCFullYear() + 1, 0, 15, 14, 0);   // mid-January: MEZ = UTC+1
    hd.now = new Date(start - 3 * 86400e3);
    hd.socketNotificationReceived("F1_RESULT", { ok: true, races: [{ name: "Winter Grand Prix", start }] });
    await new Promise((r) => setTimeout(r, 400));
    return document.querySelector(".hb-f1-session").textContent;
  });
  ok("start times in German time (14:00 UTC in January → 15:00)", /15:00|3:00/.test(berlin), berlin);
  await show([]);
  ok("no races (between seasons): no pill", (await pill()) === null);

  const f = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  h.log(`SUMMARY: ${f.length ? "FAILED: " + f.join("; ") : "ALL CHECKS PASSED"} (${Object.keys(R).length} checks)`);
};
