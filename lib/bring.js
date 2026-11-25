/* OpenSky ↔ Bring! (server side): put the meal plan's shopping list onto a Bring! list.
 * Bring! has no official API for this; this is the same unofficial way in the Home Assistant Bring! integration and
 * the bring-api library use (https://api.getbring.com/rest): sign in with the account's e-mail + password, then
 * add items. If Bring! changes it, only "send to Bring!" stops working, with a message.
 *   secrets.json → bring.email, bring.password (set on the phone page: Extras → Bring!)
 *   opensky.json → meals.bringList: the list's name (default: the account's default list)
 *   lists() → [{ uuid, name }] · add(items: [{ name, spec }]) → { list, count }
 * OPENSKY_BRING_API replaces the address (the tests use a stand-in).
 */
const crypto = require("crypto");
const path = require("path");
const { secret } = require(path.join(__dirname, "secrets.js"));
const { osT } = require("./client/i18n.js");

const API = () => (process.env.OPENSKY_BRING_API || "https://api.getbring.com/rest").replace(/\/+$/, "");
// the public key Bring!'s own apps send (the same in every client of this API)
const HEADERS = { "X-BRING-API-KEY": "cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp", "X-BRING-CLIENT": "android", "X-BRING-APPLICATION": "bring", "X-BRING-COUNTRY": "DE" };

let session = null;   // { email, uuid, publicUuid, token, defaultList, until }

// a Bring! account made with "Sign in with Apple" (also with "Hide My Email"): its login is the address Bring! shows
// under Profile (often …@privaterelay.appleid.com) with a password set in the Bring! app — then it signs in like any other
const appleAddress = (email) => /@privaterelay\.appleid\.com$/i.test(email);
const refused = (email) => appleAddress(email)
  ? osT("Bring! didn't accept the Apple address or password — set a password in the Bring! app (Profile → Settings → More settings → Change password) and use the address shown under Profile")
  : osT("Bring! didn't accept the e-mail or password — check them in phone setup → Extras");

function account() {
  const email = String(secret("bring.email") || "").trim(), password = String(secret("bring.password") || "");
  if (!email || !password) throw new Error(osT("Bring! isn't set up — add your Bring! e-mail and password in phone setup → Extras"));
  return { email, password };
}

async function call(method, url, { form, json, auth = true } = {}) {
  const headers = { ...HEADERS };
  if (auth) Object.assign(headers, { Authorization: `Bearer ${session.token}`, "X-BRING-USER-UUID": session.uuid, "X-BRING-PUBLIC-USER-UUID": session.publicUuid || "" });
  let body;
  if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  let res;
  try { res = await fetch(`${API()}${url}`, { method, headers, body, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error(osT("Can't reach Bring! — check the internet and try again")); }
  return res;
}

async function login() {
  const { email, password } = account();
  if (session && session.email === email && session.until > Date.now()) return session;
  const res = await call("POST", "/v2/bringauth", { form: { email, password }, auth: false });
  if (res.status === 401 || res.status === 400) throw Object.assign(new Error(refused(email)), { status: 401 });
  if (!res.ok) throw new Error(osT("Bring! error (HTTP {status})", { status: res.status }));
  const d = await res.json().catch(() => ({}));
  if (!d.uuid || !d.access_token) throw new Error(osT("Bring! sent an answer OpenSky doesn't understand — it may have changed"));
  session = { email, uuid: d.uuid, publicUuid: d.publicUuid || "", token: d.access_token, defaultList: d.bringListUUID || null,
    until: Date.now() + Math.max(60, Math.min(Number(d.expires_in) || 3600, 7 * 86400) - 60) * 1000 };
  return session;
}

// a signed-in call; a token Bring! ended in the meantime → sign in again once
async function authed(method, url, opts) {
  await login();
  let res = await call(method, url, opts);
  if (res.status === 401) { session = null; await login(); res = await call(method, url, opts); }
  if (res.status === 401) throw new Error(refused(session ? session.email : ""));
  if (!res.ok) throw new Error(osT("Bring! error (HTTP {status})", { status: res.status }));
  return res;
}

async function lists() {
  await login();
  const d = await (await authed("GET", `/bringusers/${encodeURIComponent(session.uuid)}/lists`)).json().catch(() => ({}));
  return (Array.isArray(d.lists) ? d.lists : []).map((l) => ({ uuid: String(l.listUuid), name: String(l.name || "") }));
}

/** The list by its name (any case), else the account's default list, else the first one. */
async function target(name) {
  const all = await lists();
  if (!all.length) throw new Error(osT("Your Bring! account has no lists"));
  const want = String(name || "").trim().toLowerCase();
  if (want) {
    const hit = all.find((l) => l.name.trim().toLowerCase() === want);
    if (!hit) throw new Error(osT("There's no Bring! list \"{name}\" — check its name in phone setup → Extras", { name }));
    return hit;
  }
  return all.find((l) => l.uuid === session.defaultList) || all[0];
}

/** Put items on the list ("to buy"); an item already there gets the new amount. */
async function add(items, listName) {
  const list = await target(listName);
  const changes = (items || []).filter((it) => it && String(it.name || "").trim()).map((it) => ({
    itemId: String(it.name).trim().slice(0, 60), spec: String(it.spec || "").slice(0, 60), uuid: crypto.randomUUID(),
    operation: "TO_PURCHASE", accuracy: "0.0", altitude: "0.0", latitude: "0.0", longitude: "0.0"
  }));
  if (!changes.length) return { list: list.name, count: 0 };
  await authed("PUT", `/v2/bringlists/${encodeURIComponent(list.uuid)}/items`, { json: { changes, sender: "" } });
  return { list: list.name, count: changes.length };
}

module.exports = { lists, add, appleAddress,
 configured: () => { try { account(); return true; } catch (e) { return false; } }, _reset: () => { session = null; } };
