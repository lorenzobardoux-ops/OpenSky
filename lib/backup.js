/* OpenSky backups (server side) — used by phone setup (download / restore) and the nightly automatic backup.
 * A backup is one JSON file: opensky.json + the on-device data (screen calendar, lists, word-game stats, screen
 * settings) and, only when asked, secrets.json (passwords and keys).
 *
 * Automatic backups (opensky.json → backup):
 *   { "destination": "/media/pi/MYSTICK", "time": "03:00", "keep": 14, "includeSecrets": false }
 *   → <destination>/OpenSky-backups/opensky-backup-YYYY-MM-DD.json, the newest `keep` files kept.
 *   destinations() lists what this Pi can write to: USB sticks / drives (/media, /mnt), network folders
 *   (SMB/NFS mounts, network places opened in the file manager) and a folder in the home directory.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { osT } = require("./client/i18n.js");   // texts in opensky.json's language

const MM_CONFIG = path.join(global.root_path || process.cwd(), "config");
const SETTINGS = process.env.OPENSKY_SETTINGS || path.join(MM_CONFIG, "opensky.json");
const SECRETS = process.env.OPENSKY_SECRETS || path.join(path.dirname(SETTINGS), "secrets.json");
const DATA = {
  localCalendar: process.env.OPENSKY_LOCAL_CALENDAR || path.join(MM_CONFIG, "local-calendar.json"),
  lists: process.env.OPENSKY_LOCAL_LISTS || path.join(MM_CONFIG, "lists.json"),
  wordgame: process.env.OPENSKY_WORDGAME || path.join(path.dirname(SETTINGS), "wordgame.json"),
  device: process.env.OPENSKY_DEVICE_SETTINGS || path.join(path.dirname(SETTINGS), "device.json")
};
const STATUS = process.env.OPENSKY_BACKUP_STATUS || path.join(path.dirname(SETTINGS), "backup-status.json");
const FOLDER = "OpenSky-backups";

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n", mode ? { mode } : undefined);
  fs.renameSync(`${file}.tmp`, file);
  if (mode) fs.chmodSync(file, mode);
}

function make(includeSecrets) {
  const b = { opensky: "backup", version: 1, created: new Date().toISOString(), settings: readJson(SETTINGS, {}), data: {} };
  for (const [k, f] of Object.entries(DATA)) { const d = readJson(f, null); if (d) b.data[k] = d; }
  if (includeSecrets) b.secrets = readJson(SECRETS, {});
  return b;
}

function restore(b) {
  if (!b || b.opensky !== "backup" || !b.settings || typeof b.settings !== "object") throw Object.assign(new Error(osT("That isn't an OpenSky backup file")), { status: 400 });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak`);
  writeJson(SETTINGS, b.settings);
  const done = ["settings"];
  for (const [k, f] of Object.entries(DATA)) {
    const d = b.data && b.data[k];
    if (d && typeof d === "object") { if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak`); writeJson(f, d); done.push(k); }
  }
  if (b.secrets && typeof b.secrets === "object") {
    if (fs.existsSync(SECRETS)) { fs.copyFileSync(SECRETS, `${SECRETS}.bak`); fs.chmodSync(`${SECRETS}.bak`, 0o600); }
    writeJson(SECRETS, b.secrets, 0o600);
    done.push("secrets");
  }
  return done;
}

/* ---------------- where backups can go ---------------- */
const NET = new Set(["cifs", "smb3", "nfs", "nfs4", "fuse.sshfs", "fuse.rclone", "davfs", "fuse.gvfsd-fuse"]);
const freeMB = (p) => { try { const s = fs.statfsSync(p); return Math.round((s.bavail * s.bsize) / 1048576); } catch (e) { return null; } };
const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch (e) { return false; } };

function destinations() {
  const out = [], seen = new Set();
  const add = (p, kind, label) => {
    const real = (() => { try { return fs.realpathSync(p); } catch (e) { return p; } })();
    if (seen.has(real) || !fs.existsSync(p) || !writable(p)) return;
    seen.add(real);
    out.push({ path: p, kind, label, freeMB: freeMB(p) });
  };
  // mounted drives and network folders
  let mounts = [];
  try { mounts = fs.readFileSync(process.env.OPENSKY_MOUNTS || "/proc/mounts", "utf8").split("\n").map((l) => l.split(" ")).filter((m) => m.length > 2); } catch (e) { /* none */ }
  const decode = (s) => s.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\134/g, "\\");
  for (const [dev, mp0, type] of mounts) {
    const mp = decode(mp0);
    if (NET.has(type) && !/gvfs$/.test(mp)) add(mp, "network", osT("Network folder {name} ({where})", { name: path.basename(mp), where: dev.replace(/^\/\//, "").slice(0, 40) }));
    else if (/^\/(media|mnt)\//.test(mp) && /^\/dev\//.test(dev)) add(mp, "usb", osT("USB drive {name}", { name: path.basename(mp) })
);
  }
  // network places opened in the file manager (gvfs), e.g. smb-share:server=nas,share=backups
  const gvfs = process.env.OPENSKY_GVFS || path.join(`/run/user/${process.getuid ? process.getuid() : 1000}`, "gvfs");
  try {
    for (const d of fs.readdirSync(gvfs)) {
      const m = d.match(/server=([^,]+).*share=([^,]+)/);
      add(path.join(gvfs, d), "network", m ? osT("Network folder {name} on {host}", { name: m[2], host: m[1] }) : osT("Network place {name}", { name: d })
);
    }
  } catch (e) { /* none */ }
  add(process.env.OPENSKY_BACKUP_HOME || path.join(os.homedir()), "folder", osT("This Pi (home folder) — not safe if the SD card fails"));
  return out;
}

/* ---------------- automatic backups ---------------- */
function settings() {
  const b = (readJson(SETTINGS, {}) || {}).backup || {};
  return { destination: b.destination || null, time: /^\d\d:\d\d$/.test(b.time || "") ? b.time : "03:00", keep: Math.max(1, Math.min(365, Number(b.keep) || 14)), includeSecrets: !!b.includeSecrets };
}

const status = () => readJson(STATUS, { last: null, ok: null, file: null, error: null });

/** Write a backup now to the chosen destination. Returns the status. */
function run(opts = settings()) {
  const st = { last: new Date().toISOString(), ok: false, file: null, error: null, destination: opts.destination };
  try {
    if (!opts.destination) throw new Error(osT("No backup place chosen yet"));
    if (!fs.existsSync(opts.destination)) throw new Error(/^\/(media|mnt)\//.test(opts.destination) ? osT("The USB drive isn't plugged in") : osT("The backup place isn't available (network folder offline?)"));
    const dir = path.join(opts.destination, FOLDER);
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;   // local date
    const file = path.join(dir, `opensky-backup-${day}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(make(opts.includeSecrets), null, 1), opts.includeSecrets ? { mode: 0o600 } : undefined);
    fs.renameSync(`${file}.tmp`, file);
    // keep the newest `keep` backups
    const old = fs.readdirSync(dir).filter((f) => /^opensky-backup-\d{4}-\d\d-\d\d\.json$/.test(f)).sort().reverse().slice(opts.keep);
    old.forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ } });
    Object.assign(st, { ok: true, file });
  } catch (e) { st.error = e.message; }
  try { writeJson(STATUS, st); } catch (e) { /* ignore */ }
  return st;
}

/** Is a nightly backup due now? (past today's time and none since then) */
function due(now = new Date()) {
  const o = settings();
  if (!o.destination) return false;
  const [h, m] = o.time.split(":").map(Number);
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  if (now < slot) slot.setDate(slot.getDate() - 1);
  const st = status(), last = st.last ? new Date(st.last) : null;
  if (last && st.ok === false && now - last > 60 * 60 * 1000) return true;   // it failed (stick unplugged?): try hourly
  return !last || last < slot;
}

module.exports = { make, restore, destinations, run, due, settings, status, DATA, SETTINGS, SECRETS };
