#!/usr/bin/env node
// Bring! (lib/bring.js) against a local stand-in for api.getbring.com: sign in, the list by name or the default one,
// adding items with their amounts, a token Bring! ended (signs in again), wrong password, not set up — no real account.
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensky-bring-"));
const SECRETS = path.join(tmp, "secrets.json");
process.env.OPENSKY_SECRETS = SECRETS;
process.env.OPENSKY_SETTINGS = path.join(tmp, "opensky.json");
fs.writeFileSync(process.env.OPENSKY_SETTINGS, JSON.stringify({ locale: { language: "en" } }));
let pass = 0, fail = 0;
const ok = (n, c, i) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${i !== undefined ? "  — " + JSON.stringify(i) : ""}`); };
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const setSecrets = (o) => { fs.writeFileSync(SECRETS, JSON.stringify(o)); fs.utimesSync(SECRETS, new Date(), new Date(Date.now() + Math.random() * 1e6)); };

const calls = [], items = { L1: [], L2: [] };
let tokenNo = 0, validToken = null;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    calls.push(`${req.method} ${req.url}`);
    if (req.headers["x-bring-api-key"] !== "cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp") return send(403, {});
    if (req.url === "/v2/bringauth") {
      const f = new URLSearchParams(body);
      if (f.get("email") !== "fam@example.test" || f.get("password") !== "right") return send(401, { message: "wrong" });
      validToken = `tok${++tokenNo}`;
      return send(200, { uuid: "U1", publicUuid: "P1", access_token: validToken, refresh_token: "r", token_type: "Bearer", expires_in: 604799, bringListUUID: "L2" });
    }
    if (req.headers.authorization !== `Bearer ${validToken}` || req.headers["x-bring-user-uuid"] !== "U1") return send(401, {});
    if (req.url === "/bringusers/U1/lists") return send(200, { lists: [{ listUuid: "L1", name: "Zuhause" }, { listUuid: "L2", name: "Einkauf" }] });
    const m = req.url.match(/^\/v2\/bringlists\/(L\d)\/items$/);
    if (m && req.method === "PUT") { JSON.parse(body).changes.forEach((c) => items[m[1]].push(c)); res.writeHead(204); return res.end(); }
    send(404, {});
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.OPENSKY_BRING_API = `http://127.0.0.1:${server.address().port}/`;
  const bring = require(path.join(__dirname, "..", "lib", "bring.js"));
  ok("1 not set up: says where to add it", /phone setup/.test(await fails(() => bring.add([{ name: "Milch" }]))) && !bring.configured());
  setSecrets({ bring: { email: "fam@example.test", password: "wrong" } });
  ok("2 a wrong password: plain message", /didn't accept/.test(await fails(() => bring.add([{ name: "Milch" }]))));
  setSecrets({ bring: { email: "x1y2z3@privaterelay.appleid.com", password: "nope" } });
  ok("2b an account made with Apple (Hide My Email address) that isn't accepted: says how to set a password in the Bring! app", /Change password/.test(await fails(() => bring.add([{ name: "Milch" }]))) && bring.appleAddress("A@PrivateRelay.AppleID.com"));
  setSecrets({ bring: { email: "fam@example.test", password: "right" } });
  let r =
 await bring.add([{ name: "Milch", spec: "400 ml" }, { name: " Eier ", spec: "6" }, { name: "" }]);
  ok("3 no list named: the account's default list; items with their amounts, to buy", r.list === "Einkauf" && r.count === 2 && items.L2.map((c) => `${c.itemId}:${c.spec}:${c.operation}`).join() === "Milch:400 ml:TO_PURCHASE,Eier:6:TO_PURCHASE", items.L2);
  r = await bring.add([{ name: "Mehl", spec: "1 kg" }], "zuhause");
  ok("4 a list by its name (any case)", r.list === "Zuhause" && items.L1[0].itemId === "Mehl");
  ok("5 a list that doesn't exist: says which", /"Garten"/.test(await fails(() => bring.add([{ name: "Salz" }], "Garten"))));
  const logins = calls.filter((c) => c.includes("bringauth")).length;
  validToken = "ended";   // Bring! ended the session
  r = await bring.add([{ name: "Butter" }]);
  ok("6 a token Bring! ended: signs in again once, then it works", r.count === 1 && calls.filter((c) => c.includes("bringauth")).length === logins + 1);
  ok("7 nothing to add: nothing sent", (await bring.add([])).count === 0);
  server.close();
  bring._reset();
  process.env.OPENSKY_BRING_API = "http://127.0.0.1:9/";
  ok("8 Bring! unreachable: plain message", /reach Bring/.test(await fails(() => bring.add([{ name: "Milch" }]))));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`SUMMARY pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`SUMMARY pass=${pass} fail=${fail + 1} (crashed: ${e.message})`); process.exit(1); });
