/* OpenSky photo sources (server side). Used by MMM-OpenSky-Home's node helper.
 *
 *   { provider: "folder", folder: "~/Pictures", usb: true }   (default — no account needed)
 *       every JPEG/PNG/WebP under the folder (and under an "OpenSky" folder on any USB stick, if usb is true)
 *   { provider: "immich", url: "http://nas:2283" }            API key from secrets.json → photos.immich.apiKey
 *
 * next() → { photos: [{ id, date, place, portrait }] } — one photo, or two portrait photos to show side by side.
 * image(id) → { type, body } for the screen (ids are opaque: file paths never leave the Pi).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { osT } = require("./client/i18n.js");   // texts in opensky.json's language

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const SCREENSHOT_RE = /screen ?shot|screen_?recording/i;
const RESCAN_MS = 10 * 60 * 1000;

/* ---------- tiny image header readers (no dependencies) ---------- */
// JPEG: size from the SOF marker, EXIF orientation (0x0112) and DateTimeOriginal (0x9003)
function jpegInfo(buf) {
  const info = {};
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString("ascii", i + 4, i + 8) === "Exif") Object.assign(info, exif(buf, i + 10));
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcb)) {
      info.height = buf.readUInt16BE(i + 5); info.width = buf.readUInt16BE(i + 7);
      break;
    }
    i += 2 + len;
  }
  return info;
}
function exif(buf, tiff) {
  const out = {};
  try {
    const le = buf.toString("ascii", tiff, tiff + 2) === "II";
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = (start, wantSub) => {
      const n = u16(tiff + start);
      for (let k = 0; k < n; k++) {
        const e = tiff + start + 2 + k * 12, tag = u16(e);
        if (tag === 0x0112) out.orientation = u16(e + 8);
        if (tag === 0x9003) out.taken = buf.toString("ascii", tiff + u32(e + 8), tiff + u32(e + 8) + 19);
        if (tag === 0x8769 && wantSub) ifd(u32(e + 8), false);
      }
    };
    ifd(u32(tiff + 4), true);
  } catch (e) { /* damaged EXIF: ignore */ }
  return out;
}
function pngInfo(buf) { return buf.toString("ascii", 12, 16) === "IHDR" ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : {}; }

function readInfo(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, n);
    if (b[0] === 0xff && b[1] === 0xd8) return jpegInfo(b);
    if (b.toString("ascii", 1, 4) === "PNG") return pngInfo(b);
    return {};
  } finally { fs.closeSync(fd); }
}

/* ---------- folder provider ---------- */
class FolderPhotos {
  constructor(o) {
    this.roots = [o.folder ? o.folder.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), "Pictures")];
    this.usb = o.usb !== false;
    this.files = [];
    this.scannedAt = 0;
  }
  usbRoots() {
    if (!this.usb) return [];
    const base = path.join("/media", os.userInfo().username);
    try {
      return fs.readdirSync(base).flatMap((stick) => {
        try { return fs.readdirSync(path.join(base, stick)).filter((d) => /^opensky/i.test(d)).map((d) => path.join(base, stick, d)); } catch (e) { return []; }
      });
    } catch (e) { return []; }
  }
  scan() {
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 6 || found.length > 50000) return;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (IMAGE_RE.test(e.name) && !SCREENSHOT_RE.test(e.name)) found.push(p);
      }
    };
    [...this.roots, ...this.usbRoots()].forEach((r) => walk(r, 0));
    this.files = found;
    this.byId = new Map(found.map((f) => [crypto.createHash("sha1").update(f).digest("hex").slice(0, 20), f]));
    this.idOf = new Map([...this.byId].map(([id, f]) => [f, id]));
    this.scannedAt = Date.now();
  }
  describe(file) {
    let info = {}; try { info = readInfo(file); } catch (e) { /* unreadable: still show it */ }
    let w = info.width, h = info.height;
    if ([5, 6, 7, 8].includes(info.orientation)) [w, h] = [h, w];
    // Only the camera's "date taken" (EXIF). A file's modified date is when it was copied, not when it was taken.
    const date = info.taken && /^\d{4}:\d\d:\d\d/.test(info.taken) ? info.taken.slice(0, 10).replace(/:/g, "-") + "T12:00:00Z" : null;
    return { id: this.idOf.get(file), portrait: !!(w && h && h > w), date, place: null };
  }
  async candidates(n) {
    if (!this.files.length || Date.now() - this.scannedAt > RESCAN_MS) this.scan();
    const out = [];
    for (let k = 0; k < n && this.files.length; k++) out.push(this.describe(this.files[Math.floor(Math.random() * this.files.length)]));
    return out;
  }
  async image(id) {
    const f = this.byId && this.byId.get(id);
    if (!f) return null;
    const ext = path.extname(f).toLowerCase();
    return { type: ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg", body: await fs.promises.readFile(f) };
  }
}

/* ---------- Immich provider ---------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class ImmichPhotos {
  constructor(o, apiKey) { this.url = String(o.url || "").replace(/\/+$/, ""); this.apiKey = apiKey; }
  async candidates(n) {
    if (!this.url || !this.apiKey) throw new Error(osT("Immich needs photos.url in opensky.json and photos.immich.apiKey in secrets.json"));
    const r = await fetch(`${this.url}/api/search/random`, {
      method: "POST", headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ size: Math.max(n, 30), type: "IMAGE", withExif: true, visibility: "timeline" }), signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(`Immich search/random HTTP ${r.status}`);
    const assets = await r.json();
    return (Array.isArray(assets) ? assets : [])
      .filter((a) => a && UUID_RE.test(a.id) && !SCREENSHOT_RE.test(a.originalFileName || "") && !a.isTrashed)
      .map((a) => {
        const x = a.exifInfo || {};
        let w = x.exifImageWidth, h = x.exifImageHeight;
        if (["5", "6", "7", "8"].includes(String(x.orientation))) [w, h] = [h, w];
        return { id: a.id, portrait: !!(w && h && h > w), date: a.localDateTime || a.fileCreatedAt || null, place: [x.city, x.state].filter(Boolean).join(", ") || null };
      });
  }
  async image(id) {
    if (!UUID_RE.test(id)) return null;
    const r = await fetch(`${this.url}/api/assets/${id}/thumbnail?size=preview`, { headers: { "x-api-key": this.apiKey }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return { type: r.headers.get("content-type") || "image/jpeg", body: Buffer.from(await r.arrayBuffer()) };
  }
}

/* ---------- shared picking: no recent repeats, portraits come in pairs ---------- */
class PhotoPicker {
  constructor(source) { this.source = source; this.queue = []; this.recent = []; }
  async refill() {
    const list = await this.source.candidates(30);
    const fresh = list.filter((p) => p.id && !this.recent.includes(p.id));
    const seen = new Set();
    this.queue = (fresh.length ? fresh : list).filter((p) => p.id && !seen.has(p.id) && seen.add(p.id));
    this.pool = list;   // everything just fetched, incl. recently shown — used to find a portrait partner
  }
  async next() {
    if (!this.queue.length) await this.refill();
    const first = this.queue.shift();
    if (!first) throw new Error("no photos found");
    const photos = [first];
    if (first.portrait) {
      let i = this.queue.findIndex((q) => q.portrait && q.id !== first.id);
      if (i < 0) { await this.refill(); i = this.queue.findIndex((q) => q.portrait && q.id !== first.id); }
      if (i >= 0) photos.push(this.queue.splice(i, 1)[0]);
      else {
        // small library: a recently shown portrait is a better partner than none
        const again = (this.pool || []).find((q) => q.portrait && q.id !== first.id);
        if (again) photos.push(again);
      }
    }
    photos.forEach((p) => this.recent.push(p.id));
    this.recent = this.recent.slice(-15);
    return { photos };
  }
  image(id) { return this.source.image(id); }
}

function createPhotoSource(o, secretFn) {
  const src = (o.provider || "folder") === "immich" ? new ImmichPhotos(o, secretFn("photos.immich.apiKey")) : new FolderPhotos(o);
  return new PhotoPicker(src);
}

module.exports = { createPhotoSource, readInfo };
