/* OpenSky lists (server side) — the family's lists, from whichever provider each list uses.
 * Used by MMM-OpenSky-Lists' node helper. The page never talks to a provider (or sees a token) itself.
 *
 * A list (from opensky.json → lists.lists):  { name, color?, provider: "local" | "todoist", project? }
 *   local   — kept on the Pi in config/lists.json (no account). Default.
 *   todoist — a Todoist project: "project" (its name; default: the list's name) or "projectId".
 *             Token: secrets.json → lists.todoist.token
 *   homeassistant — a Home Assistant to-do list: "entity" (e.g. "todo.shopping_list").
 *             Address + long-lived token: secrets.json → homeassistant.url / homeassistant.token
 *
 * Every provider answers the same calls:
 *   items(list)                → [{ id, text }]   (open items, in the provider's order)
 *   add(list, text) · check(list, item) · edit(list, item, text) · remove(list, item)
 * An item is { id, text }. Errors carry a friendly message (shown on screen as a toast).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MM_ROOT = global.root_path || process.cwd();
const { secret } = require(path.join(__dirname, "secrets.js"));
const { osT } = require("./client/i18n.js");   // texts in opensky.json's language

/* ---------------- on-device lists ---------------- */
const FILE = process.env.OPENSKY_LOCAL_LISTS || path.join(MM_ROOT, "config", "lists.json");

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return data && typeof data.lists === "object" && data.lists ? data : { version: 1, lists: {} };
  } catch (e) {
    if (e.code !== "ENOENT") {
      // damaged file: keep a copy for recovery, start empty rather than crash
      try { fs.copyFileSync(FILE, `${FILE}.damaged-${Date.now()}`); } catch (x) { /* ignore */ }
      console.error(`[OpenSky] lists.json unreadable (${e.message}); a copy was kept`);
    }
    return { version: 1, lists: {} };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, FILE);   // atomic: a power cut can't leave half a file
}

function cleanText(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) throw new Error(osT("Please type something first"));
  if (t.length > 500) throw new Error(osT("That's a bit long — keep it under 500 characters"));
  return t;
}

function localChange(list, fn) {
  const store = readStore();
  const items = Array.isArray(store.lists[list.name]) ? store.lists[list.name] : [];
  fn(items);
  store.lists[list.name] = items;
  writeStore(store);
}

function localFind(items, item) {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) throw new Error(osT("That item is gone (it may have just been changed)"));
  return i;
}

const local = {
  async items(list) {
    const items = readStore().lists[list.name];
    return (Array.isArray(items) ? items : []).map((x) => ({ id: x.id, text: x.text }));
  },
  async add(list, text) {
    const t = cleanText(text);
    localChange(list, (items) => items.push({ id: crypto.randomUUID(), text: t, created: new Date().toISOString() }));
  },
  async check(list, item) { localChange(list, (items) => items.splice(localFind(items, item), 1)); },
  async remove(list, item) { localChange(list, (items) => items.splice(localFind(items, item), 1)); },
  async edit(list, item, text) {
    const t = cleanText(text);
    localChange(list, (items) => { items[localFind(items, item)].text = t; });
  }
};

/* ---------------- Todoist (API v1) ---------------- */
const TODOIST = process.env.OPENSKY_TODOIST_API || "https://api.todoist.com/api/v1";
let projectIds = new Map();   // project name (lower case) → id, for this token
let projectToken = null;

function todoistToken() {
  const t = secret("lists.todoist.token");
  if (!t) throw new Error(osT("Todoist isn't set up — add your API token to secrets.json (lists.todoist.token)"));
  return t;
}

async function todoist(method, url, body) {
  const token = todoistToken();
  let res;
  try {
    res = await fetch(`${TODOIST}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw new Error(osT("Can't reach Todoist. Check the internet and try again."));
  }
  if (res.status === 401 || res.status === 403) throw new Error(osT("Todoist refused the API token — check lists.todoist.token in secrets.json"));
  if (res.status === 404) throw Object.assign(new Error(osT("Not found in Todoist (it may have just been changed)")), { status: 404 });
  if (res.status === 429) throw new Error(osT("Todoist says slow down — try again in a minute"));
  if (!res.ok) throw new Error(osT("Todoist error (HTTP {status})", { status: res.status }));
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function todoistAll(url) {
  const out = [];
  let cursor = null;
  do {
    const sep = url.includes("?") ? "&" : "?";
    const page = await todoist("GET", `${url}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...((page && page.results) || []));
    cursor = page && page.next_cursor;
  } while (cursor);
  return out;
}

async function projectId(list) {
  if (list.projectId) return String(list.projectId);
  const want = String(list.project || list.name);
  const token = todoistToken();
  if (token !== projectToken || !projectIds.has(want.toLowerCase())) {
    projectIds = new Map((await todoistAll("/projects")).map((p) => [String(p.name).toLowerCase(), p.id]));
    projectToken = token;
  }
  const id = projectIds.get(want.toLowerCase());
  if (!id) throw new Error(`No Todoist project called "${want}" — check the list's "project" in opensky.json`);
  return id;
}

const todo = {
  async items(list) {
    const id = await projectId(list);
    const tasks = await todoistAll(`/tasks?project_id=${encodeURIComponent(id)}`);
    return tasks.filter((t) => !t.checked && !t.is_deleted)
      .sort((a, b) => (a.child_order ?? 0) - (b.child_order ?? 0))
      .map((t) => ({ id: String(t.id), text: t.content }));
  },
  async add(list, text) { await todoist("POST", "/tasks", { content: cleanText(text), project_id: await projectId(list) }); },
  async check(list, item) { await todoist("POST", `/tasks/${encodeURIComponent(item.id)}/close`); },
  async edit(list, item, text) { await todoist("POST", `/tasks/${encodeURIComponent(item.id)}`, { content: cleanText(text) }); },
  async remove(list, item) { await todoist("DELETE", `/tasks/${encodeURIComponent(item.id)}`); }
};

/* ---------------- Home Assistant to-do lists ---------------- */
async function ha(service, body, response) {
  const url = String(secret("homeassistant.url") || "").replace(/\/+$/, ""), token = secret("homeassistant.token");
  if (!url || !token) throw new Error(osT("Home Assistant isn't set up — add homeassistant.url and homeassistant.token to secrets.json"));
  let res;
  try {
    res = await fetch(`${url}/api/services/todo/${service}${response ? "?return_response" : ""}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw new Error(osT("Can't reach Home Assistant. Is it on, and is the address right?"));
  }
  if (res.status === 401 || res.status === 403) throw new Error(osT("Home Assistant refused the token — check homeassistant.token in secrets.json"));
  if (res.status === 400) throw new Error(osT("Home Assistant didn't accept that (does the to-do list exist?)"));
  if (!res.ok) throw new Error(`Home Assistant error (HTTP ${res.status})`);
  return res.json().catch(() => null);
}
const entity = (list) => {
  const e = String(list.entity || "");
  if (!/^todo\.[a-z0-9_]+$/.test(e)) throw new Error(`"${list.name}" needs its Home Assistant list, e.g. "entity": "todo.shopping_list"`);
  return e;
};

const homeassistant = {
  async items(list) {
    const e = entity(list);
    const d = await ha("get_items", { entity_id: e, status: "needs_action" }, true);
    const items = (((d && d.service_response) || {})[e] || {}).items || [];
    return items.filter((it) => it.status !== "completed").map((it) => ({ id: String(it.uid || it.summary), text: it.summary }));
  },
  async add(list, text) { await ha("add_item", { entity_id: entity(list), item: cleanText(text) }); },
  async check(list, item) { await ha("update_item", { entity_id: entity(list), item: item.id, status: "completed" }); },
  async edit(list, item, text) { await ha("update_item", { entity_id: entity(list), item: item.id, rename: cleanText(text) }); },
  async remove(list, item) { await ha("remove_item", { entity_id: entity(list), item: [item.id] }); }
};

/* ---------------- public ---------------- */
const PROVIDERS = { local, todoist: todo, homeassistant };

module.exports = {
  FILE,
  PROVIDERS: Object.keys(PROVIDERS),
  provider(list) {
    const p = PROVIDERS[(list && list.provider) || "local"];
    if (!p) throw new Error(osT("Unknown list provider \"{provider}\"", { provider: list.provider })
);
    return p;
  }
};
