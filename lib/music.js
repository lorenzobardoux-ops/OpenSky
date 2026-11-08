/* OpenSky Music add-on (server side) — what's playing on this screen's speakers, and its buttons.
 * Used by MMM-OpenSky-Music's node helper. Both receivers are optional; `opensky addon music` installs them.
 *   spotify — go-librespot (Spotify Connect) and its local API on 127.0.0.1:3678   (OPENSKY_SPOTIFY_API to test)
 *   airplay — shairport-sync (AirPlay) on the session D-Bus (MPRIS), read with busctl  (OPENSKY_BUSCTL to test)
 *   homeassistant — other speakers: Home Assistant media players (Sonos, HomePod, Echo, Google…), a remote for them
 * state()  → { source, playing, title, artist, album, art, position, duration } or null (nothing playing on the screen)
 * speakers([entity…]) → [{ id, name, available, volume, now }]     listSpeakers() → every media player HA has
 * control(source, action, entity?, value?)   action: "playpause" | "next" | "previous" | "volume" (other speakers)
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SPOTIFY = process.env.OPENSKY_SPOTIFY_API || "http://127.0.0.1:3678";
const BUSCTL = process.env.OPENSKY_BUSCTL || "busctl";
const MPRIS = ["org.mpris.MediaPlayer2.ShairportSync", "/org/mpris/MediaPlayer2"];

/* ---------------- Spotify Connect (go-librespot) ---------------- */
async function spotifyCall(method, path, body) {
  const r = await fetch(`${SPOTIFY}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`Spotify speaker: HTTP ${r.status}`);
  return method === "GET" ? r.json() : null;
}

const spotify = {
  async state() {
    let st;
    try { st = await spotifyCall("GET", "/status"); } catch (e) { return null; }   // not installed / not running
    const t = st && st.track;
    if (!t || st.stopped) return null;
    return {
      source: "spotify", playing: !st.paused, buffering: !!st.buffering,
      title: String(t.name || ""), artist: (t.artist_names || []).join(", "), album: String(t.album_name || ""),
      art: t.album_cover_url || null, position: Number(t.position) || 0, duration: Number(t.duration) || 0
    };
  },
  async control(action) {
    const path = { playpause: "/player/playpause", next: "/player/next", previous: "/player/prev" }[action];
    if (path) await spotifyCall("POST", path);
  }
};

/* ---------------- AirPlay (shairport-sync over MPRIS) ---------------- */
const busctl = (args) => new Promise((resolve) => {
  execFile(BUSCTL, ["--user", ...args], { timeout: 3000 }, (e, out) => resolve(e ? null : String(out)));
});
const val = (v) => (v && typeof v === "object" && "data" in v ? v.data : v);
// shairport-sync doesn't report how far into the song it is (Position stays 0), so it's counted here from when the song
// was first seen: it stops while paused, and the page can be opened any time. (A seek on the phone isn't seen.)
let apClock = { key: null, elapsed: 0, since: 0 };
const apReset = () => { apClock = { key: null, elapsed: 0, since: 0 }; };
function apPosition(key, playing, reported, duration) {
  const now = Date.now();
  if (key !== apClock.key) apClock = { key, elapsed: 0, since: playing ? now : 0 };
  else if (playing && !apClock.since) apClock.since = now;
  else if (!playing && apClock.since) { apClock.elapsed += now - apClock.since; apClock.since = 0; }
  if (reported > 0) { apClock.elapsed = reported; apClock.since = playing ? now : 0; }   // (a version that reports it)
  let total = apClock.elapsed + (apClock.since ? now - apClock.since : 0);
  // past the song's end and still the same song: it's playing again (repeat one) — a new count
  if (duration && total > duration + 1500) { total %= duration; apClock.elapsed = total; apClock.since = playing ? now : 0; }
  return total;
}
let artCache = { path: null, url: null };

// cover art is a file in shairport-sync's cache: sent to the page as a data: URL (once per new picture)
function artFrom(url) {
  if (!url || !/^file:\/\//.test(url)) return /^https?:\/\//.test(url || "") ? url : null;
  const file = decodeURIComponent(url.slice(7));
  if (artCache.path === file) return artCache.url;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 3 * 1024 * 1024) return null;
    const type = buf[0] === 0x89 ? "image/png" : "image/jpeg";
    artCache = { path: file, url: `data:${type};base64,${buf.toString("base64")}` };
    return artCache.url;
  } catch (e) { return null; }
}

const airplay = {
  async state() {
    const out = await busctl(["--json=short", "call", ...MPRIS, "org.freedesktop.DBus.Properties", "GetAll", "s", "org.mpris.MediaPlayer2.Player"]);
    if (!out) { apReset(); return null; }
    let p;
    try { p = (JSON.parse(out).data || [])[0] || {}; } catch (e) { return null; }
    const status = val(p.PlaybackStatus), md = val(p.Metadata) || {};
    const title = val(md["xesam:title"]);
    if (!status || status === "Stopped" || !title) { apReset(); return null; }   // (stopped / disconnected: the same song again starts at 0:00)
    const artists = val(md["xesam:artist"]);
    const artist = Array.isArray(artists) ? artists.join(", ") : String(artists || ""), album = String(val(md["xesam:album"]) || "");
    const playing = status === "Playing", duration = Math.round((Number(val(md["mpris:length"])) || 0) / 1000);
    const position = Math.round(apPosition(`${title}|${artist}|${album}|${duration}`, playing, Math.round((Number(val(p.Position)) || 0) / 1000), duration));
    return {
      source: "airplay", playing, buffering: false, title: String(title), artist, album,
      art: artFrom(val(md["mpris:artUrl"])), position: duration ? Math.min(position, duration) : position, duration
    };
  },
  async control(action) {
    const method = { playpause: "PlayPause", next: "Next", previous: "Previous" }[action];
    if (method && (await busctl(["call", ...MPRIS, "org.mpris.MediaPlayer2.Player", method])) === null) throw new Error(osT("The AirPlay phone didn't take the button — use the phone"));
  }
};

const SOURCES = { spotify, airplay };

/* ---------------- other speakers: Home Assistant media players (Sonos, HomePod, Echo, Google, Spotify…) ---------------- */
// Address + token: secrets.json → homeassistant.url / .token (the same as Home Assistant lists). Cover art is fetched
// here and sent to the page as a data: URL, so the page never sees Home Assistant's address or token.
const { secret } = require(path.join(__dirname, "secrets.js"));
const { osT } = require("./client/i18n.js");   // texts in opensky.json's language
const haArt = new Map();   // entity → { key, url }
async function haCall(method, p, body) {
  const url = String(secret("homeassistant.url") || "").replace(/\/+$/, ""), token = secret("homeassistant.token");
  if (!url || !token) throw new Error(osT("Home Assistant isn't set up — add its address and token in phone setup"));
  let res;
  try {
    res = await fetch(`${url}${p}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  } catch (e) { throw new Error(osT("Can't reach Home Assistant")); }
  if (res.status === 401 || res.status === 403) throw new Error(osT("Home Assistant refused the token"));
  if (res.status === 404) throw new Error(osT("Home Assistant doesn't know that speaker"));
  if (!res.ok) throw new Error(`Home Assistant error (HTTP ${res.status})`);
  return res;
}
async function haPicture(entity, picture) {
  if (!picture) return null;
  const cached = haArt.get(entity);
  if (cached && cached.key === picture) return cached.url;
  let url = null;
  try {
    // a full address (Spotify, Google Cast…) is fetched directly — never through haCall, which would send the token there
    const r = /^https?:\/\//i.test(picture) ? await fetch(picture, { signal: AbortSignal.timeout(5000) }) : await haCall("GET", picture.startsWith("/") ? picture : `/${picture}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length <= 3 * 1024 * 1024) url = `data:${r.headers.get("content-type") || "image/jpeg"};base64,${buf.toString("base64")}`;
  } catch (e) { /* no picture */ }
  haArt.set(entity, { key: picture, url });
  return url;
}
const ENTITY = /^media_player\.[a-z0-9_]+$/;
const homeassistant = {
  /** One speaker: { id, name, available, volume (0-100 | null), now (as state()) } */
  async speaker(entity) {
    if (!ENTITY.test(entity)) return { id: entity, name: entity, available: false, volume: null, now: null };
    let st;
    try { st = await (await haCall("GET", `/api/states/${entity}`)).json(); } catch (e) { return { id: entity, name: entity, available: false, error: e.message, volume: null, now: null }; }
    const a = st.attributes || {}, playing = st.state === "playing";
    let now = null;
    if ((playing || st.state === "paused") && a.media_title) {
      const updated = Date.parse(a.media_position_updated_at || "") || Date.now();
      now = {
        source: "homeassistant", entity, playing, buffering: false,
        title: String(a.media_title), artist: String(a.media_artist || a.media_album_artist || ""), album: String(a.media_album_name || ""),
        art: await haPicture(entity, a.entity_picture),
        position: Math.round(((Number(a.media_position) || 0) * 1000) + (playing ? Math.max(0, Date.now() - updated) : 0)),
        duration: Math.round((Number(a.media_duration) || 0) * 1000)
      };
      if (now.duration && now.position > now.duration) now.position = now.duration;
    }
    return { id: entity, name: String(a.friendly_name || entity), available: !["unavailable", "unknown"].includes(st.state), volume: a.volume_level != null ? Math.round(Number(a.volume_level) * 100) : null, now };
  },
  async control(entity, action, value) {
    if (!ENTITY.test(entity || "")) throw new Error(osT("Which speaker?"));
    if (action === "volume") return haCall("POST", "/api/services/media_player/volume_set", { entity_id: entity, volume_level: Math.max(0, Math.min(100, Number(value) || 0)) / 100 });
    const svc = { playpause: "media_play_pause", next: "media_next_track", previous: "media_previous_track" }[action];
    if (!svc) throw new Error(osT("Unknown button"));
    return haCall("POST", `/api/services/media_player/${svc}`, { entity_id: entity });
  },
  /** Every media player Home Assistant has (for picking them in phone setup): [{ id, name, state }] */
  async list() {
    const all = await (await haCall("GET", "/api/states")).json();
    return all.filter((s) => ENTITY.test(s.entity_id || "")).map((s) => ({ id: s.entity_id, name: String((s.attributes || {}).friendly_name || s.entity_id), state: s.state }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
};

module.exports = {
  /** What's playing: the source that plays beats a paused one; null when nothing is on. */
  async state(enabled = { spotify: true, airplay: true }) {
    const all = (await Promise.all(Object.entries(SOURCES).filter(([k]) => enabled[k] !== false).map(([, s]) => s.state()))).filter(Boolean);
    return all.find((s) => s.playing) || all[0] || null;
  },
  async control(source, action, entity, value) {
    if (source === "homeassistant") return homeassistant.control(entity, action, value);
    if (!SOURCES[source]) throw new Error(osT("Unknown music source"));
    return SOURCES[source].control(action);
  },
  /** Other speakers (Home Assistant media players), in the order given. */
  speakers(entities) { return Promise.all((entities || []).map((e) => homeassistant.speaker(e))); },
  listSpeakers: () => homeassistant.list(),
  SOURCES: Object.keys(SOURCES)
};
