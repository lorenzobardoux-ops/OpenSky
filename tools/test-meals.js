#!/usr/bin/env node
// Meal planner (lib/meals.js): dishes, weeks Saturday–Friday, rolling (effort, season, cycle, due ones more often),
// reroll / choose / servings / cooking days, the sorted shopping list with "have", calendar events, what goes to Bring!.
const fs = require("fs"), os = require("os"), path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensky-meals-"));
process.env.OPENSKY_MEALS = path.join(tmp, "meals.json");
process.env.OPENSKY_SETTINGS = path.join(tmp, "opensky.json");
fs.writeFileSync(process.env.OPENSKY_SETTINGS, JSON.stringify({ locale: { language: "de" } }));
const meals = require(path.join(__dirname, "..", "lib", "meals.js"));
let pass = 0, fail = 0;
const ok = (n, c, i) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
const fails = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
// a repeatable "random"
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const THU = new Date(2026, 10, 26, 18);   // Thursday 26 Nov 2026: planning the week Sat 28 Nov – Fri 4 Dec
const ch = (op, body, now = THU) => meals.change(op, body, now, rnd);

const w = meals.weeks(THU);
ok("1 weeks run Saturday–Friday: this one and the next (planned on Thursday)", w.current === "2026-11-21" && w.next === "2026-11-28" && meals.weekOf("2026-12-04") === "2026-11-28" && meals.weekOf("2026-11-28") === "2026-11-28", w);

let s = ch("saveDish", { dish: { name: "  Lasagne ", effort: 4, cycleWeeks: 3, ingredients: [
  { name: "Hackfleisch", amount: "500", unit: "g" }, { name: "Lasagneplatten", amount: 250, unit: "g" },
  { name: "Passierte Tomaten", amount: 1, unit: "Dose" }, { name: "Mozzarella", amount: 1, unit: "Stück" }, { name: "Zwiebel", amount: 1, unit: "" }] } });
const lasagne = s.dishes[0];
ok("2 a dish: cleaned, amounts for the default 2 servings, ingredients sorted into sections by name", lasagne.name === "Lasagne" && lasagne.servings === 2 && lasagne.effort === 4 &&
  lasagne.ingredients.map((i) => i.category).join() === "meat,pasta,cans,dairy,vegetables", lasagne.ingredients.map((i) => `${i.name}:${i.category}`));
ok("3 a name is needed", /Namen|name/.test(fails(() => ch("saveDish", { dish: { name: "" } }))));
ch("settings", { defaultServings: 3 });
for (const [name, effort, extra] of [["Pfannkuchen", 1, { ingredients: [{ name: "Mehl", amount: 200, unit: "g" }, { name: "Milch", amount: 400, unit: "ml" }, { name: "Eier", amount: 2 }] }],
  ["Spargel mit Kartoffeln", 2, { months: [4, 5, 6], ingredients: [{ name: "Spargel", amount: 500, unit: "g" }] }],
  ["Gemüsecurry", 3, { ingredients: [{ name: "Kokosmilch", amount: 1, unit: "Dose" }, { name: "Zwiebel", amount: 2 }, { name: "Reis", amount: 200, unit: "g" }, { name: "Paprikapulver", amount: 1, unit: "TL" }] }],
  ["Linsensuppe", 2, {}], ["Ofengemüse", 2, { servings: 2, ingredients: [{ name: "Zwiebel", amount: 1 }, { name: "Zucchini", amount: 2 }] }], ["Burger", 5, {}]]) ch("saveDish", { dish: { name, effort, ...extra } });
s = meals.state(THU);
ok("4 the default servings apply to new dishes (and can be set per dish)", s.settings.defaultServings === 3 && s.dishes.find((x) => x.name === "Pfannkuchen").servings === 3 && s.dishes.find((x) => x.name === "Ofengemüse").servings === 2);
ok("5 'paprikapulver' is a spice, not a vegetable; 'Lachsfilet' is fish", s.dishes.find((x) => x.name === "Gemüsecurry").ingredients.find((i) => i.name === "Paprikapulver").category === "spices" && meals.guessCategory("Lachsfilet") === "fish" &&
  meals.guessCategory("Chilipulver") === "spices" && meals.guessCategory("Backpulver") === "baking" && meals.guessCategory("Kakaopulver") === "baking");



// rolling
s = ch("roll", { weekStart: w.next, count: 4, maxEffort: 3 });
let p = s.plans[w.next];
const names = () => p.entries.map((e) => s.dishes.find((x) => x.id === e.dishId).name);
ok("6 roll: 4 different dishes, none harder than 3, no asparagus in November, not confirmed yet", p.entries.length === 4 && new Set(names()).size === 4 &&
  !names().includes("Burger") && !names().includes("Lasagne") && !names().includes("Spargel mit Kartoffeln") && !p.confirmed && p.entries.every((e) => e.day === null && e.servings === 3), names());
const fri = "2026-12-04", sun = "2026-11-29", wed = "2026-12-02";
s = ch("roll", { weekStart: w.next, days: [sun, wed], maxEffort: 3, servings: 2 }); p = s.plans[w.next];
ok("7 roll for chosen cooking days: one dish per day", p.entries.length === 2 && p.entries[0].day === sun && p.entries[1].day === wed && p.entries[0].servings === 2, p.entries);
const before = p.entries[0].dishId;
s = ch("reroll", { weekStart: w.next, entryId: p.entries[0].id }); p = s.plans[w.next];
ok("8 reroll one: another dish, not one already in the plan", p.entries[0].dishId !== before && p.entries[0].dishId !== p.entries[1].dishId && p.entries[0].day === sun);
s = ch("choose", { weekStart: w.next, entryId: p.entries[0].id, dishId: lasagne.id }); p = s.plans[w.next];
s = ch("choose", { weekStart: w.next, dishId: s.dishes.find((x) => x.name === "Ofengemüse").id }); p = s.plans[w.next];
s = ch("servings", { weekStart: w.next, entryId: p.entries[0].id, servings: 4 }); p = s.plans[w.next];
ok("9 choose a dish for one, add one more, set servings", names()[0] === "Lasagne" && p.entries.length === 3 && p.entries[2].day === null && p.entries[0].servings === 4);
s = ch("day", { weekStart: w.next, entryId: p.entries[2].id, day: fri }); p = s.plans[w.next];
ok("10 a cooking day for a dish (drag on the screen); not outside the week", p.entries[2].day === fri && /Woche|week/.test(fails(() => ch("day", { weekStart: w.next, entryId: p.entries[2].id, day: "2026-12-05" }))));

// shopping list
const sh = p.shopping;
const it = (n) => sh.find((x) => x.name.toLowerCase() === n.toLowerCase());
ok("11 shopping list: scaled to the servings (Lasagne ×2), same things added up, sorted like a shop", it("Hackfleisch").amount === 1000 && it("Zwiebel").amount >= 3.5 &&

  sh.findIndex((x) => x.category === "vegetables") < sh.findIndex((x) => x.category === "dairy") && sh.findIndex((x) => x.category === "dairy") < sh.findIndex((x) => x.category === "meat"), sh.map((x) => `${x.name} ${x.amount ?? ""}${x.unit}`));
s = ch("have", { weekStart: w.next, key: it("Hackfleisch").key, have: true }); p = s.plans[w.next];
ok("12 tick what's at home: it stays ticked; it doesn't go to Bring!", p.shopping.find((x) => x.name === "Hackfleisch").have && !meals.toBuy(w.next).some((x) => x.name === "Hackfleisch") && meals.toBuy(w.next).some((x) => x.name === "Lasagneplatten" && x.spec === "500 g"), meals.toBuy(w.next));

// Bring! both ways: what was sent and is no longer "to buy" there gets ticked here; open ones stay on top
const buy = meals.toBuy(w.next);
meals.markSent(w.next, buy, THU);
let shop = meals.state(THU).plans[w.next].shopping;
ok("12b sent to Bring!: marked 'in Bring!' until bought", shop.filter((x) => !x.have).every((x) => x.inBring) && Object.keys(meals.waitingOnBring(THU)).length === 1);
const stillThere = buy.filter((x) => x.name !== "Lasagneplatten" && x.name !== "Mozzarella").map((x) => x.name.toUpperCase());
ok("12c bought in Bring! (gone from 'to buy') → ticked here; the rest waits", meals.syncBought(stillThere, THU) === 2 &&
  meals.state(THU).plans[w.next].shopping.find((x) => x.name === "Lasagneplatten").have && !meals.state(THU).plans[w.next].shopping.find((x) => x.name === "Passierte Tomaten").have);
shop = meals.state(THU).plans[w.next].shopping;
const firstDone = shop.findIndex((x) => x.have);
ok("12d the shopping list: still needed on top, what's done below", firstDone > 0 && shop.slice(firstDone).every((x) => x.have) && shop.slice(0, firstDone).every((x) => !x.have), shop.map((x) => `${x.name}${x.have ? "✓" : ""}`));
ch("have", { weekStart: w.next, key: shop.find((x) => x.name === "Lasagneplatten").key, have: false });
meals.syncBought(stillThere, THU);
ok("12e unticked by hand: stays unticked (no longer waiting on Bring!)", !meals.state(THU).plans[w.next].shopping.find((x) => x.name === "Lasagneplatten").have);
ch("have", { weekStart: w.next, key: shop.find((x) => x.name === "Lasagneplatten").key, have: true });

// calendar + cycle

ok("13 not confirmed: nothing on the calendar yet", meals.calendarEvents(THU).length === 0);
s = ch("confirm", { weekStart: w.next });
const evs = meals.calendarEvents(THU);
ok("14 confirmed: the cooking days are on the calendar (all day, 'Kochen: …')", evs.length === 3 && evs.some((e) => e.title === "Kochen: Lasagne" && new Date(Number(e.startDate)).getDate() === 29) && evs.every((e) => e.fullDayEvent), evs.map((e) => e.title));
const later = new Date(2026, 11, 3, 18);   // the Thursday after: planning the week of 5 Dec
let picked = new Set();
for (let i = 0; i < 25; i++) { const r = ch("roll", { weekStart: "2026-12-05", count: 5, maxEffort: 5 }, later); r.plans["2026-12-05"].entries.forEach((e) => picked.add(r.dishes.find((x) => x.id === e.dishId).name)); }
ok("15 cycle: Lasagne (every 3 weeks at the earliest) can't come back next week; asparagus stays out of season", !picked.has("Lasagne") && !picked.has("Spargel mit Kartoffeln"), [...picked]);
const april = new Date(2027, 3, 22, 18);
s = ch("roll", { weekStart: meals.weeks(april).next, count: 7, maxEffort: 5 }, april);
const aprilNames = s.plans[meals.weeks(april).next].entries.map((e) => s.dishes.find((x) => x.id === e.dishId).name);
ok("16 in season (April): asparagus can be picked; only 7 dishes exist, so 7 at most", aprilNames.includes("Spargel mit Kartoffeln") && aprilNames.length === 7, aprilNames);
s = ch("roll", { weekStart: "2026-12-12", count: 3, maxEffort: 1 }, new Date(2026, 11, 10));
ok("17 fewer fit than asked: as many as fit (and says so)", s.result.found === 1 && s.result.wanted === 3, s.result);
ch("deleteDish", { id: s.dishes.find((x) => x.name === "Pfannkuchen").id });
ok("17b nothing fits → a plain message", /Gericht|dish/.test(fails(() => ch("roll", { weekStart: "2026-12-12", count: 3, maxEffort: 1 }, new Date(2026, 11, 10)))));

s = ch("deleteDish", { id: lasagne.id });
ok("18 delete a dish: it drops off the plans", !s.dishes.some((x) => x.name === "Lasagne") && !Object.values(s.plans).some((pl) => pl.entries.some((e) => e.dishId === lasagne.id)));
fs.writeFileSync(process.env.OPENSKY_MEALS, "{ broken");
const orig = console.error; console.error = () => {};
ok("19 a damaged file: empty, a copy kept", meals.state(THU).dishes.length === 0 && fs.readdirSync(tmp).some((f) => f.includes(".damaged-")));
console.error = orig;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
