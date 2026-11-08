/* MMM-OpenSky-Embed node helper — hands each embed page its web address, and checks PINs.
 * A page's address comes from opensky.json (embeds.<key>.url, passed in by the page) or, for private ones,
 * from secrets.json → embeds.<key>.url. A page with a PIN (secrets.json → embeds.<key>.pin, 4–8 digits) only
 * gets its address after the right PIN, every time; 5 wrong PINs in a row → a 30-second pause.
 *   OS_EMBED_INIT {key, url?} → OS_EMBED_OPEN {key, url} | OS_EMBED_LOCKED {key} | OS_EMBED_ERROR {key, message}
 *   OS_EMBED_UNLOCK {key, pin} → OS_EMBED_OPEN {key, url} | OS_EMBED_DENIED {key, wait?, error?}
 */
const NodeHelper = require("node_helper");
const path = require("path");
const { osT } = require(path.join(__dirname, "..", "..", "lib", "client", "i18n.js"));   // texts in opensky.json's language
const crypto = require("crypto");
const { secret } = require(path.join(global.root_path, "modules", "opensky-lib", "secrets.js"));

const MAX_TRIES = 5, PAUSE_S = 30;

module.exports = NodeHelper.create({
  start() {
    this.publicUrls = new Map();
    this.tries = new Map();   // key → { wrong, until }
  },

  pin(key) {
    const p = secret(`embeds.${key}.pin`);
    return p != null && /^\d{4,8}$/.test(String(p)) ? String(p) : null;
  },

  url(key) { return secret(`embeds.${key}.url`) || this.publicUrls.get(key) || null; },

  socketNotificationReceived(n, p) {
    if (!p || !p.key) return;
    const key = String(p.key);
    if (n === "OS_EMBED_INIT") {
      if (p.url) this.publicUrls.set(key, String(p.url));
      if (this.pin(key)) return this.sendSocketNotification("OS_EMBED_LOCKED", { key });
      const url = this.url(key);
      if (!url) return this.sendSocketNotification("OS_EMBED_ERROR", { key, message: osT("No web address for \"{key}\" yet — add embeds.{key}.url to opensky.json (or secrets.json)", { key }) });
      return this.sendSocketNotification("OS_EMBED_OPEN", { key, url });
    }
    if (n === "OS_EMBED_UNLOCK") {
      const pin = this.pin(key), t = this.tries.get(key) || { wrong: 0, until: 0 };
      if (!pin) return this.sendSocketNotification("OS_EMBED_DENIED", { key, error: osT("No PIN is set for this page (secrets.json)") });
      const now = Date.now();
      if (t.until > now) return this.sendSocketNotification("OS_EMBED_DENIED", { key, wait: Math.ceil((t.until - now) / 1000) });
      const given = Buffer.from(String(p.pin || "")), want = Buffer.from(pin);
      if (given.length === want.length && crypto.timingSafeEqual(given, want)) {
        this.tries.delete(key);
        const url = this.url(key);
        if (!url) return this.sendSocketNotification("OS_EMBED_DENIED", { key, error: osT("No web address for \"{key}\" — add embeds.{key}.url to secrets.json", { key }) });

        return this.sendSocketNotification("OS_EMBED_OPEN", { key, url });
      }
      t.wrong += 1;
      if (t.wrong >= MAX_TRIES) { t.wrong = 0; t.until = now + PAUSE_S * 1000; }
      this.tries.set(key, t);
      return this.sendSocketNotification("OS_EMBED_DENIED", { key, wait: t.until > now ? PAUSE_S : 0 });
    }
  }
});
