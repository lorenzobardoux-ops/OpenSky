/* OpenSky meal planner — what the screen (MMM-OpenSky-Meals) and the kitchen page for phones share.
 * window.OpenSkyMeals: category names, amounts, units (what adds up), day labels, effort dots. Needs lib/client/i18n.js first.
 * In Node (lib/meals.js) it exports just the unit helpers.
 */
(function () {
  /* ---- units (also used by the server, lib/meals.js): which ones add up, and in what ---- */
  // kind: what can be added together; f: how many of the kind's smallest unit
  const UNITS = [
    ["mass", 1, ["g", "gr", "gr.", "gramm", "gram", "grams"]], ["mass", 1000, ["kg", "kilo", "kilogramm", "kilogram"]],
    ["volume", 1, ["ml", "milliliter", "millilitre"]], ["volume", 10, ["cl"]], ["volume", 100, ["dl"]],
    ["volume", 1000, ["l", "ltr", "liter", "litre"]],
    ["spoon", 1, ["tl", "tsp", "teelöffel", "teaspoon"]], ["spoon", 3, ["el", "tbsp", "esslöffel", "tablespoon"]],
    ["piece", 1, ["", "stück", "stk", "stk.", "st", "st.", "pc", "pcs", "piece", "pieces"]]
  ];
  // the same unit written another way (singular/plural, short) — adds up with itself
  const SAME = [["dose", "dosen", "ds", "ds."], ["packung", "packungen", "pck", "pck.", "pkg", "pkg.", "päckchen", "pack", "packs"],
    ["glas", "gläser"], ["becher"], ["bund", "bünde"], ["zehe", "zehen"], ["scheibe", "scheiben"], ["prise", "prisen"],
    ["tin", "tins", "can", "cans"], ["jar", "jars"], ["pot", "pots"], ["bunch", "bunches"], ["clove", "cloves"],
    ["slice", "slices"], ["pinch", "pinches"]];
  const norm = (u) => String(u || "").toLowerCase().replace(/\s+/g, " ").trim();
  const units = {
    /** { kind, f } — a unit OpenSky doesn't know only adds up with itself */
    unitOf(u) { const n = norm(u); const hit = UNITS.find((x) => x[2].includes(n)); if (hit) return { kind: hit[0], f: hit[1] }; const same = SAME.find((x) => x.includes(n)); return { kind: `=${same ? same[0] : n}`, f: 1 }; },
    /** can amounts in these two units be added up? */
    sameKind(a, b) { return units.unitOf(a).kind === units.unitOf(b).kind; },
    /** a sum in the kind's smallest unit → { amount, unit } in a unit people read (g → kg from 1000, ml → l) */
    readable(base, kind, firstUnit) {
      if (kind === "mass") return base >= 1000 ? { amount: base / 1000, unit: "kg" } : { amount: base, unit: "g" };
      if (kind === "volume") return base >= 1000 ? { amount: base / 1000, unit: "l" } : { amount: base, unit: "ml" };
      return { amount: base / units.unitOf(firstUnit).f, unit: String(firstUnit || "").trim() };
    }
  };
  if (typeof module === "object" && module.exports) module.exports = units;
  if (typeof window === "undefined" || window.OpenSkyMeals) return;
  const osT = (t, v) => (window.OpenSkyI18n ? window.OpenSkyI18n.t(t, v) : t);
  const CATEGORY = () => ({
    vegetables: osT("Vegetables"), fruit: osT("Fruit"), bread: osT("Bread & bakery"), dairy: osT("Dairy & eggs"), meat: osT("Meat"),
    fish: osT("Fish"), pasta: osT("Pasta, rice & grains"), baking: osT("Baking"), cans: osT("Tins, jars & sauces"), spices: osT("Spices & oils"),
    frozen: osT("Frozen"), drinks: osT("Drinks"), other: osT("Other")
  });
  const parse = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
  window.OpenSkyMeals = {
    ...units,
    /** the units offered in the ingredient's unit menu ([value, label]); anything else can be typed */
    unitChoices() {
      return [["", osT("no unit")], ["g", "g"], ["kg", "kg"], ["ml", "ml"], ["l", "l"], [osT("pc"), osT("pc")], [osT("tbsp"), osT("tbsp")],
        [osT("tsp"), osT("tsp")], [osT("pinch"), osT("pinch")], [osT("bunch"), osT("bunch")], [osT("clove"), osT("clove")],
        [osT("slice"), osT("slice")], [osT("tin"), osT("tin")], [osT("jar"), osT("jar")], [osT("pot"), osT("pot")], [osT("pack"), osT("pack")]];
    },
    /** other dishes that have this ingredient in a unit that doesn't add up with `unit`: [{ dish, unit }] */
    unitClashes(dishes, selfId, name, unit) {
      const n = norm(name); if (!n) return [];
      const out = [];
      for (const d of dishes || []) {
        if (d.id === selfId) continue;
        for (const i of d.ingredients || []) if (norm(i.name) === n && !units.sameKind(i.unit, unit) && !out.some((o) => o.dish === d.name && norm(o.unit) === norm(i.unit))) out.push({ dish: d.name, unit: i.unit || "" });
      }
      return out;
    },
    /** the hint under an ingredient whose unit doesn't add up with the same ingredient in another dish ("" if none) */
    unitClashText(dishes, selfId, name, unit) {
      const c = this.unitClashes(dishes, selfId, name, unit);
      if (!c.length) return "";
      const show = (u) => String(u || "").trim() || osT("no unit");
      return osT("\"{name}\" has another unit in other dishes: {list}. That doesn't add up with {unit}, so the shopping list shows two lines — use the same unit (or g/kg, ml/l, tbsp/tsp) to add it up.",
        { name: String(name).trim(), list: c.slice(0, 4).map((x) => `${show(x.unit)} (${x.dish})`).join(", "), unit: show(unit) });
    },
    category(key) { return CATEGORY()[key] || CATEGORY().other; },
    categories() { return Object.entries(CATEGORY()); },
    /** "400 g", "1,5", "" */
    amount(it) { return it.amount == null ? "" : `${String(Math.round(it.amount * 100) / 100).replace(".", ",")}${it.unit ? " " + it.unit : ""}`; },
    /** "Sa 28.11." (locale: the screen's / the phone's) */
    day(s, locale, long) {
      const d = parse(s);
      return `${d.toLocaleDateString(locale || undefined, { weekday: long ? "long" : "short" })} ${d.toLocaleDateString(locale || undefined, { day: "numeric", month: "numeric" })}`;
    },
    week(start, locale) { const end = parse(start); end.setDate(end.getDate() + 6); return `${this.day(start, locale)} – ${this.day(`${end.getFullYear()}-${end.getMonth() + 1}-${end.getDate()}`, locale)}`; },
    /** ●●●○○ as text (no emoji: Raspberry Pi OS has no color-emoji font) */
    effort(n) { return "●".repeat(n) + "○".repeat(Math.max(0, 5 - n)); },
    effortName(n) { return [osT("very easy"), osT("easy"), osT("medium"), osT("takes a while"), osT("a big job")][Math.max(1, Math.min(5, n)) - 1]; }
  };
})();
