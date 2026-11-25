/* OpenSky meal planner — what the screen (MMM-OpenSky-Meals) and the kitchen page for phones share.
 * window.OpenSkyMeals: category names, amounts, day labels, effort dots. Needs lib/client/i18n.js first.
 */
(function () {
  if (window.OpenSkyMeals) return;
  const osT = (t, v) => (window.OpenSkyI18n ? window.OpenSkyI18n.t(t, v) : t);
  const CATEGORY = () => ({
    vegetables: osT("Vegetables"), fruit: osT("Fruit"), bread: osT("Bread & bakery"), dairy: osT("Dairy & eggs"), meat: osT("Meat"),
    fish: osT("Fish"), pasta: osT("Pasta, rice & grains"), baking: osT("Baking"), cans: osT("Tins, jars & sauces"), spices: osT("Spices & oils"),
    frozen: osT("Frozen"), drinks: osT("Drinks"), other: osT("Other")
  });
  const parse = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
  window.OpenSkyMeals = {
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
