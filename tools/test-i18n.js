#!/usr/bin/env node
// Translations: every osT("…") in the code has a German line in lib/client/i18n.js, with the same {placeholders};
// no osT(`…${x}…`) (the key must be the plain English text); the helper itself fills placeholders and falls back.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const i18n = require(path.join(REPO, "lib", "client", "i18n.js"));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); } };

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return ["vendor", "node_modules", "assets"].includes(d.name) ? [] : files(p);
    return /\.js$/.test(d.name) && d.name !== "i18n.js" ? [p] : [];
  });
}
const sources = [...files(path.join(REPO, "modules")), ...files(path.join(REPO, "lib")), path.join(REPO, "config", "config.js")];

// osT( "…" | '…' | `…` )  — the first argument only
const RE = /\bosT\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const keys = new Map(); // key → first place it's used
const dynamic = [];
for (const f of sources) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(RE)) {
    const raw = m[2];
    if (m[1] === "`" && raw.includes("${")) { dynamic.push(`${path.relative(REPO, f)}: ${raw.slice(0, 60)}`); continue; }
    // the string as JavaScript sees it
    const key = m[1] === "`" ? raw : JSON.parse('"' + raw.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"') + '"');
    if (!keys.has(key)) keys.set(key, path.relative(REPO, f));
  }
}
const DE = i18n.TABLES.de;
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const missing = [...keys.keys()].filter((k) => !Object.prototype.hasOwnProperty.call(DE, k));
const mismatched = [...keys.keys()].filter((k) => DE[k] != null && holes(k) !== holes(DE[k]));
const unused = Object.keys(DE).filter((k) => !keys.has(k));

ok(`1 found translated texts in the code (${keys.size})`, keys.size > 0);
ok("2 every osT text has a German line", missing.length === 0, missing.slice(0, process.env.ALL ? 9999 : 25).map((k) => `\n      ${JSON.stringify(k)}  (${keys.get(k)})`).join(""));
ok("3 the {placeholders} match", mismatched.length === 0, mismatched.slice(0, 10).map((k) => `\n      ${JSON.stringify(k)} → ${JSON.stringify(DE[k])}`).join(""));
ok("4 no osT(`…${x}…`) — use {placeholders}", dynamic.length === 0, dynamic.slice(0, 10).map((d) => "\n      " + d).join(""));
if (unused.length) console.log(`(note: ${unused.length} German lines aren't used in the code: ${unused.slice(0, 8).map((k) => JSON.stringify(k)).join(", ")}…)`);

i18n.setLanguage("de");
ok("5 German: translated + filled in", i18n.t("Save") === "Speichern" && i18n.t("x {n} y", { n: 3 }) === "x 3 y");
ok("6 a text without a translation stays English", i18n.t("Something new") === "Something new");
i18n.setLanguage("en-US");
ok("7 English: the text as written", i18n.t("Save") === "Save");
i18n.setLanguage("de-DE");
ok("8 \"de-DE\" counts as German", i18n.t("Save") === "Speichern");
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
