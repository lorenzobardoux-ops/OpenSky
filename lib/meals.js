/* OpenSky meal planner (server side) — the family's dishes, the week's plan and its shopping list.
 * Kept on the Pi in config/meals.json (OPENSKY_MEALS). Used by MMM-OpenSky-Meals' node helper (the screen and the
 * kitchen page for phones) and MMM-OpenSky-Calendars (the cooking days on the calendar).
 *
 *   dishes:   [{ id, name, effort 1–5, servings (the amounts are for this many), cycleWeeks (at the earliest again
 *               after), months [1–12] (only then; empty = all year), ingredients [{ name, amount, unit, category }], notes }]
 *   settings: { defaultServings }
 *   plans:    { "<Saturday YYYY-MM-DD>": { weekStart, confirmed, maxEffort, entries [{ id, dishId, servings, day }],
 *               have { "<ingredient key>": true } } }
 *
 * A week runs Saturday to Friday (the family shops on Friday). A plan's day is the day a dish is COOKED (for the next
 * day). Rolling picks dishes at random: not harder than maxEffort, in season, and not cooked within their cycle;
 * dishes that are due (long ago, or never) come up more often.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { osT } = require("./client/i18n.js");

const MM_ROOT = global.root_path || process.cwd();
const FILE = () => process.env.OPENSKY_MEALS || path.join(path.dirname(process.env.OPENSKY_SETTINGS || path.join(MM_ROOT, "config", "opensky.json")), "meals.json");
const bus = new EventEmitter();
const KEEP_WEEKS = 60;   // plans older than this are dropped (they only matter for the cycles)

// Shopping list order, like a walk through the shop (and the words that sort an ingredient there)
const CATEGORIES = ["vegetables", "fruit", "bread", "dairy", "meat", "fish", "pasta", "baking", "cans", "spices", "frozen", "drinks", "other"];
const WORDS = {
  vegetables: "kartoffel zwiebel knoblauch karotte möhre paprika tomate gurke zucchini aubergine brokkoli blumenkohl spinat salat rucola lauch porree sellerie kürbis pilz champignon erbse bohne mais kohl wirsing rotkohl weißkohl spargel radieschen rote bete süßkartoffel ingwer chili frühlingszwiebel schalotte fenchel kohlrabi petersilie basilikum schnittlauch koriander dill avocado potato onion garlic carrot pepper tomato cucumber courgette eggplant broccoli cauliflower spinach lettuce leek celery pumpkin squash mushroom pea bean corn cabbage asparagus radish beetroot ginger herb parsley basil",
  fruit: "apfel birne banane zitrone limette orange mandarine beere erdbeere himbeere heidelbeere blaubeere traube kirsche pfirsich nektarine pflaume ananas mango kiwi melone granatapfel apple pear banana lemon lime berry strawberry raspberry blueberry grape cherry peach plum pineapple melon",
  bread: "brot brötchen toast baguette tortilla wrap fladenbrot ciabatta knäckebrot bread bun roll pita",
  dairy: "milch sahne schmand crème fraîche creme fraiche joghurt quark butter käse mozzarella parmesan feta gouda frischkäse ricotta mascarpone ei eier buttermilch kefir milk cream yogurt yoghurt cheese egg",
  meat: "hähnchen huhn hühnchen pute rind hack hackfleisch schwein speck schinken wurst salami bratwurst lamm steak gulasch chicken turkey beef mince pork bacon ham sausage lamb",
  fish: "lachs thunfisch fisch garnele shrimp kabeljau seelachs forelle muschel salmon tuna fish prawn cod trout",
  pasta: "nudel spaghetti penne fusilli lasagne tagliatelle reis couscous bulgur quinoa linsen kichererbse haferflocken müsli gnocchi pasta noodle rice lentil chickpea oat",
  baking: "mehl zucker backpulver kakaopulver hefe vanille kakao schokolade speisestärke stärke puderzucker honig sirup nuss mandel walnuss haselnuss rosine flour sugar baking yeast vanilla cocoa chocolate starch honey syrup nut almond",
  cans: "passierte dose tomatenmark kokosmilch brühe fond pesto ketchup senf mayo mayonnaise sojasauce sojasoße essig sauce soße gurken oliven kapern konserve stock broth paste coconut mustard vinegar olive",
  spices: "salz pfeffer pulver paprikapulver chilipulver curry kreuzkümmel kümmel zimt muskat oregano thymian rosmarin majoran lorbeer gewürz öl olivenöl rapsöl sesam salt spice cumin cinnamon nutmeg thyme rosemary oil",
  frozen: "tiefkühl tk gefroren frozen",
  drinks: "wasser saft wein bier limo water juice wine beer"
};
// longest words first, so "paprikapulver" (spices) wins over "paprika" (vegetables)
const LOOKUP = Object.entries(WORDS).flatMap(([cat, w]) => w.split(" ").map((word) => [word, cat])).sort((a, b) => b[0].length - a[0].length);
function guessCategory(name) {
  const n = String(name || "").toLowerCase();
  const hit = LOOKUP.find(([word]) => n.includes(word));
  return hit ? hit[1] : "other";
}

/* ---------------- dates ---------------- */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const isDay = (s) => /^\d{4}-\d\d-\d\d$/.test(String(s || "")) && !isNaN(parse(s));
/** The Saturday a day's week starts on (a week runs Saturday–Friday). */
function weekOf(day) { const d = parse(day); d.setDate(d.getDate() - ((d.getDay() + 1) % 7)); return ymd(d); }
/** This week's and next week's Saturdays (next week = the one being planned, usually on Thursday). */
function weeks(now = new Date()) { const cur = weekOf(ymd(now)); return { current: cur, next: addDays(cur, 7) }; }
const weekDays = (weekStart) => [...Array(7)].map((_, i) => addDays(weekStart, i));

/* ---------------- the file ---------------- */
function read() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return {
      dishes: Array.isArray(d.dishes) ? d.dishes : [],
      settings: { defaultServings: 2, ...(d.settings && typeof d.settings === "object" ? d.settings : {}) },
      plans: d.plans && typeof d.plans === "object" ? d.plans : {}
    };
  } catch (e) {
    if (e.code !== "ENOENT") {
      try { fs.copyFileSync(FILE(), `${FILE()}.damaged-${Date.now()}`); } catch (x) { /* ignore */ }
      console.error(`[OpenSky] meals.json unreadable (${e.message}); a copy was kept`);
    }
    return { dishes: [], settings: { defaultServings: 2 }, plans: {} };
  }
}
function write(d, now = new Date()) {
  const oldest = addDays(weekOf(ymd(now)), -7 * KEEP_WEEKS);
  for (const k of Object.keys(d.plans)) if (k < oldest) delete d.plans[k];
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(d, null, 1));
  fs.renameSync(`${FILE()}.tmp`, FILE());   // atomic: a power cut can't leave half a file
  bus.emit("change");
}

/* ---------------- dishes ---------------- */
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
function cleanDish(x, settings) {
  const name = String((x && x.name) || "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error(osT("Please give it a name"));
  if (name.length > 80) throw new Error(osT("That's a bit long — keep it under 80 characters"));
  const ingredients = (Array.isArray(x.ingredients) ? x.ingredients : []).map((i) => {
    const iname = String((i && i.name) || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!iname) return null;
    const amount = i.amount === "" || i.amount == null ? null : Number(String(i.amount).replace(",", "."));
    return {
      name: iname,
      amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 1000) / 1000 : null,
      unit: String(i.unit || "").trim().slice(0, 12),
      category: CATEGORIES.includes(i.category) ? i.category : guessCategory(iname)
    };
  }).filter(Boolean).slice(0, 60);
  return {
    name,
    effort: Math.round(num(x.effort, 1, 5, 2)),
    servings: Math.round(num(x.servings, 1, 20, settings.defaultServings || 2)),
    cycleWeeks: Math.round(num(x.cycleWeeks, 0, 52, 0)),
    months: [...new Set((Array.isArray(x.months) ? x.months : []).map(Number).filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b),
    ingredients,
    notes: String(x.notes || "").trim().slice(0, 2000)
  };
}

/* ---------------- rolling ---------------- */
// the last day each dish was (or will be) cooked, from the confirmed plans before `weekStart`
function lastCooked(d, weekStart) {
  const last = {};
  for (const p of Object.values(d.plans)) {
    if (!p.confirmed || p.weekStart >= weekStart) continue;
    for (const e of p.entries) { const day = e.day || p.weekStart; if (!last[e.dishId] || day > last[e.dishId]) last[e.dishId] = day; }
  }
  return last;
}
function inSeason(dish, weekStart) {
  if (!dish.months || !dish.months.length) return true;
  // in season if any day of that week falls in one of its months
  return weekDays(weekStart).some((day) => dish.months.includes(parse(day).getMonth() + 1));
}
/** Dishes that may be picked for that week, each with a weight (due ones more often). */
function candidates(d, weekStart, maxEffort, exclude = new Set()) {
  const last = lastCooked(d, weekStart);
  const out = [];
  for (const dish of d.dishes) {
    if (exclude.has(dish.id) || dish.effort > maxEffort || !inSeason(dish, weekStart)) continue;
    const prev = last[dish.id];
    const weeksSince = prev ? (parse(weekStart) - parse(prev)) / (7 * 86400e3) : null;
    if (prev && dish.cycleWeeks && weeksSince < dish.cycleWeeks) continue;   // at the earliest again after its cycle
    // never cooked: 3; else how overdue it is (1 = just due), at least 1, at most 4
    const weight = prev == null ? 3 : Math.max(1, Math.min(4, dish.cycleWeeks ? weeksSince / dish.cycleWeeks : weeksSince / 2));
    out.push({ dish, weight });
  }
  return out;
}
function pick(cands, rnd) {
  const total = cands.reduce((s, c) => s + c.weight, 0);
  let r = rnd() * total;
  for (const c of cands) { r -= c.weight; if (r < 0) return c.dish; }
  return cands.length ? cands[cands.length - 1].dish : null;
}
const entryId = () => crypto.randomBytes(6).toString("hex");

/* ---------------- shopping list ---------------- */
const keyOf = (name, unit) => `${String(name).toLowerCase().replace(/\s+/g, " ").trim()}|${String(unit || "").toLowerCase().trim()}`;
function shopping(d, plan) {
  const items = new Map();
  for (const e of plan.entries) {
    const dish = d.dishes.find((x) => x.id === e.dishId);
    if (!dish) continue;
    const scale = (e.servings || dish.servings) / (dish.servings || 1);
    for (const i of dish.ingredients) {
      const k = keyOf(i.name, i.unit);
      const it = items.get(k) || { key: k, name: i.name, unit: i.unit, amount: 0, counted: false, category: i.category || guessCategory(i.name), dishes: [] };
      if (i.amount != null) { it.amount += i.amount * scale; it.counted = true; }
      if (!it.dishes.includes(dish.name)) it.dishes.push(dish.name);
      items.set(k, it);
    }
  }
  const list = [...items.values()].map((it) => ({
    key: it.key, name: it.name, unit: it.unit, category: it.category, dishes: it.dishes,
    amount: it.counted ? Math.round(it.amount * 100) / 100 : null,
    have: !!(plan.have && plan.have[it.key]),
    inBring: !!(plan.sent && plan.sent[it.key]) && !(plan.have && plan.have[it.key])   // sent, not bought yet
  }));
  // what's still needed first (by shop section), then what's at home or bought
  list.sort((a, b) => (a.have - b.have) || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name, "de"));
  return list;
}
const amountText = (it) => (it.amount == null ? "" : `${String(it.amount).replace(".", ",")}${it.unit ? " " + it.unit : ""}`);

/* ---------------- the public calls ---------------- */
function planOf(d, weekStart) {
  if (!isDay(weekStart) || weekOf(weekStart) !== weekStart) throw new Error(osT("That week isn't right"));
  return d.plans[weekStart] || null;
}
function needPlan(d, weekStart) {
  const p = planOf(d, weekStart);
  if (!p) throw new Error(osT("There's no plan for that week yet"));
  return p;
}
function findEntry(p, id) {
  const e = p.entries.find((x) => x.id === id);
  if (!e) throw new Error(osT("That dish is gone from the plan (it may have just been changed)"));
  return e;
}
function needDish(d, id) {
  const dish = d.dishes.find((x) => x.id === id);
  if (!dish) throw new Error(osT("That dish is gone (it may have just been changed)"));
  return dish;
}

/** Everything the screen and the kitchen page show. */
function state(now = new Date()) {
  const d = read();
  const w = weeks(now);
  const plans = {};
  for (const ws of [w.current, w.next]) {
    const p = d.plans[ws];
    if (p) plans[ws] = { ...p, days: weekDays(ws), shopping: shopping(d, p) };
  }
  return { dishes: d.dishes, settings: d.settings, weeks: w, plans, categories: CATEGORIES };
}

const ops = {
  saveDish(d, { dish }) {
    const c = cleanDish(dish || {}, d.settings);
    if (dish && dish.id) {
      const i = d.dishes.findIndex((x) => x.id === dish.id);
      if (i < 0) throw new Error(osT("That dish is gone (it may have just been changed)"));
      d.dishes[i] = { id: dish.id, ...c };
    } else {
      if (d.dishes.length >= 500) throw new Error(osT("That's a lot of dishes — remove one first"));
      d.dishes.push({ id: crypto.randomUUID(), ...c });
    }
    d.dishes.sort((a, b) => a.name.localeCompare(b.name, "de"));
  },
  deleteDish(d, { id }) {
    d.dishes = d.dishes.filter((x) => x.id !== id);
    // (plans keep it out: a planned dish that's gone just drops off)
    for (const p of Object.values(d.plans)) p.entries = p.entries.filter((e) => e.dishId !== id);
  },
  settings(d, { defaultServings }) { d.settings.defaultServings = Math.round(num(defaultServings, 1, 20, 2)); },

  /** A new random selection: `days` (cooking days of that week) or `count`, at most `maxEffort`. Unconfirmed until confirm. */
  roll(d, { weekStart, days, count, maxEffort, servings }, rnd = Math.random) {
    planOf(d, weekStart);
    const all = weekDays(weekStart);
    const chosenDays = (Array.isArray(days) ? days : []).filter((x) => all.includes(x));
    const n = chosenDays.length || Math.round(num(count, 1, 7, 4));
    const max = Math.round(num(maxEffort, 1, 5, 5));
    const keep = d.plans[weekStart] || {};
    const per = Math.round(num(servings, 1, 20, d.settings.defaultServings || 2));
    const used = new Set();
    const entries = [];
    for (let i = 0; i < n; i++) {
      const dish = pick(candidates(d, weekStart, max, used), rnd);
      if (!dish) break;
      used.add(dish.id);
      entries.push({ id: entryId(), dishId: dish.id, servings: per, day: chosenDays[i] || null });
    }
    if (!entries.length) throw new Error(osT("No dish fits (effort, season, or cooked too recently) — add dishes or allow more effort"));
    d.plans[weekStart] = { weekStart, confirmed: false, maxEffort: max, entries, have: keep.have || {} };
    return { found: entries.length, wanted: n };
  },
  /** Another random dish for one entry (not one already in the plan). */
  reroll(d, { weekStart, entryId: id }, rnd = Math.random) {
    const p = needPlan(d, weekStart), e = findEntry(p, id);
    const dish = pick(candidates(d, weekStart, p.maxEffort || 5, new Set(p.entries.map((x) => x.dishId))), rnd);
    if (!dish) throw new Error(osT("No other dish fits — add dishes or allow more effort"));
    e.dishId = dish.id;
  },
  /** A chosen dish for one entry, or (no entryId) one more dish in the plan. */
  choose(d, { weekStart, entryId: id, dishId, servings }) {
    needDish(d, dishId);
    let p = planOf(d, weekStart);
    if (!p) p = d.plans[weekStart] = { weekStart, confirmed: false, maxEffort: 5, entries: [], have: {} };
    if (id) findEntry(p, id).dishId = dishId;
    else {
      if (p.entries.length >= 14) throw new Error(osT("That's a lot of dishes for one week"));
      p.entries.push({ id: entryId(), dishId, servings: Math.round(num(servings, 1, 20, d.settings.defaultServings || 2)), day: null });
    }
  },
  remove(d, { weekStart, entryId: id }) { const p = needPlan(d, weekStart); findEntry(p, id); p.entries = p.entries.filter((x) => x.id !== id); },
  servings(d, { weekStart, entryId: id, servings }) { findEntry(needPlan(d, weekStart), id).servings = Math.round(num(servings, 1, 20, 2)); },
  /** The cooking day of a dish (null = not set yet). */
  day(d, { weekStart, entryId: id, day }) {
    const p = needPlan(d, weekStart), e = findEntry(p, id);
    if (day != null && !weekDays(weekStart).includes(day)) throw new Error(osT("That day isn't in this week"));
    e.day = day || null;
  },
  confirm(d, { weekStart, confirmed }) { needPlan(d, weekStart).confirmed = confirmed !== false; },
  discard(d, { weekStart }) { needPlan(d, weekStart); delete d.plans[weekStart]; },
  have(d, { weekStart, key, have }) {
    const p = needPlan(d, weekStart);
    p.have = p.have || {};
    if (have) p.have[String(key)] = true; else delete p.have[String(key)];
    // ticked or unticked by hand: it's no longer waiting on Bring! (unticking it won't be undone by the next check)
    if (p.sent) delete p.sent[String(key)];

  }
};

/** One change (the kitchen page and the screen send the same): returns the new state. */
function change(op, body, now = new Date(), rnd = Math.random) {
  if (!Object.prototype.hasOwnProperty.call(ops, op)) throw new Error(osT("Unknown change"));
  const d = read();
  const result = ops[op](d, body || {}, rnd);
  write(d, now);
  return { ...state(now), result: result || null };
}

/** The cooking days as calendar events (all day, "Cook: <dish>"), confirmed plans only. */
function calendarEvents(now = new Date()) {
  const d = read();
  const from = addDays(weekOf(ymd(now)), -7);
  const out = [];
  for (const p of Object.values(d.plans)) {
    if (!p.confirmed || p.weekStart < from) continue;
    for (const e of p.entries) {
      if (!e.day) continue;
      const dish = d.dishes.find((x) => x.id === e.dishId);
      if (!dish) continue;
      const start = parse(e.day), end = parse(addDays(e.day, 1));
      out.push({ title: osT("Cook: {dish}", { dish: dish.name }), startDate: String(start.getTime()), endDate: String(end.getTime()), fullDayEvent: true,
        recurringEvent: false, class: "PUBLIC", firstYear: start.getFullYear(), location: false, geo: false,
        description: `${osT("{n} servings", { n: e.servings })}${dish.notes ? " · " + dish.notes : ""}` });
    }
  }
  return out;
}

/** What goes to Bring!: the plan's ingredients nobody ticked as "have" — [{ key, name, spec }]. */
function toBuy(weekStart) {
  const d = read();
  const p = needPlan(d, weekStart);
  return shopping(d, p).filter((it) => !it.have).map((it) => ({ key: it.key, name: it.name, spec: amountText(it) }));
}

/** Remember what was put on the Bring! list (by ingredient), so buying it there ticks it here. */
function markSent(weekStart, items, now = new Date()) {
  const d = read();
  const p = needPlan(d, weekStart);
  p.sent = p.sent || {};
  for (const it of items) p.sent[it.key] = { name: it.name, at: now.getTime() };
  write(d, now);
}

/** The weeks with ingredients on the Bring! list that aren't bought yet: { weekStart: [{ key, name }] }. */
function waitingOnBring(now = new Date()) {
  const d = read();
  const w = weeks(now), out = {};
  for (const ws of [w.current, w.next]) {
    const p = d.plans[ws];
    if (!p || !p.sent) continue;
    const open = Object.entries(p.sent).filter(([k]) => !(p.have && p.have[k])).map(([key, s]) => ({ key, name: s.name }));
    if (open.length) out[ws] = open;
  }
  return out;
}

/** Bring!'s "to buy" names now → everything sent that's no longer on it was bought (or taken off): tick it here.
 *  Returns how many were ticked. */
function syncBought(stillToBuy, now = new Date()) {
  const want = new Set([...stillToBuy].map((n) => String(n).toLowerCase().replace(/\s+/g, " ").trim()));
  const d = read();
  let n = 0;
  for (const [ws, open] of Object.entries(waitingOnBring(now))) {
    const p = d.plans[ws];
    for (const it of open) {
      if (want.has(String(it.name).toLowerCase().replace(/\s+/g, " ").trim())) continue;
      p.have = p.have || {};
      p.have[it.key] = true;
      n++;
    }
  }
  if (n) write(d, now);
  return n;
}

module.exports = { FILE, CATEGORIES, guessCategory, weekOf, weeks, weekDays, state, change, calendarEvents, toBuy, markSent, waitingOnBring, syncBought, amountText,
 on: (ev, fn) => bus.on(ev, fn) };
