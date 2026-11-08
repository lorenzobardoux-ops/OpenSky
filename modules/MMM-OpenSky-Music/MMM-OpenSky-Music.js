/* MMM-OpenSky-Music — the Music page (an add-on: `opensky addon music` turns the screen into an AirPlay and a
 * Spotify Connect speaker). Shows what's playing (art, title, artist, progress) with previous / play-pause / next and
 * the screen's volume; when nothing plays, how to pick this screen as the speaker on a phone.
 * With other speakers set (Home Assistant media players: Sonos, HomePod, Echo…), tabs along the top switch between
 * "This screen" and each of them: the same view is then a remote for that speaker (its buttons and its volume).
 * The screen's volume is the Settings module's (OPENSKY_VOLUME_SET → OPENSKY_VOLUME), so both sliders always agree.
 */
Module.register("MMM-OpenSky-Music", {
  defaults: {
    name: "OpenSky",      // the speaker's name on phones
    spotify: true,
    airplay: true,
    speakers: []          // other speakers: Home Assistant media_player entity ids
  },

  getStyles() { return ["MMM-OpenSky-Music.css"]; },
  getScripts() { return ["modules/opensky-lib/client/i18n.js", "modules/opensky-lib/client/opensky-client.js"]; },

  start() {
    this.now = null;          // what plays on this screen
    this.speakers = [];       // [{ id, name, available, volume, now }]
    this.selected = null;     // "screen" | an entity id (a tap picks; otherwise whatever plays)
    this.installed = null;
    this.volume = null;       // { volume, name } from Settings
    this.receivedAt = 0;
    this.arts = {};           // cover pictures by id (OS_MUSIC_ART), named "art:<id>" in the states
    this.sendSocketNotification("OS_MUSIC_INIT", { spotify: this.config.spotify, airplay: this.config.airplay, speakers: this.config.speakers });
    setInterval(() => this.tickProgress(), 500);
  },

  // leaving the page forgets a tapped speaker: next time it opens on whatever plays
  suspend() { this.sendSocketNotification("OS_MUSIC_VISIBLE", false); this.forgetTab(); },
  forgetTab() { if (this.selected) { this.selected = null; this.shownId = null; if (this.root) this.updateDom(); } },
  resume() { this.sendSocketNotification("OS_MUSIC_VISIBLE", true); this.sendNotification("OPENSKY_VOLUME_GET"); },

  notificationReceived(n, p) {
    if (n === "OPENSKY_VOLUME") { this.volume = p; this.syncVolume(); }
    else if (n === "OPENSKY_IDLE_RESET") this.forgetTab();
    else if (n === "DOM_OBJECTS_CREATED") this.sendNotification("OPENSKY_VOLUME_GET");
  },

  socketNotificationReceived(n, p) {
    if (n === "OS_MUSIC_STATE") {
      const before = this.shape();
      this.now = p.now; this.installed = p.installed; this.speakers = p.speakers || []; this.receivedAt = Date.now();
      if (this.shape() !== before || !this.root) this.updateDom(); else { this.syncPlaying(); this.syncVolume(); }
    } else if (n === "OS_MUSIC_ART" && p && p.id) {
      this.arts[p.id] = p.url;
      const ids = Object.keys(this.arts);
      if (ids.length > 12) delete this.arts[ids[0]];   // (keep the last few; a dropped one is asked for again when needed)
      if (this.missing && this.missing.has(p.id)) { this.missing.delete(p.id); this.updateDom(); }
    } else if (n === "OS_MUSIC_ERROR") this.toast(p.message);
  },

  /* ---------------- drawing ---------------- */
  ICON: {
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5v14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M19 5.5v13a.6.6 0 0 1-.9.5L8.6 12.5a.6.6 0 0 1 0-1L18.1 5a.6.6 0 0 1 .9.5z" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M18 5v14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5 5.5v13a.6.6 0 0 0 .9.5l9.5-6.5a.6.6 0 0 0 0-1L5.9 5a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/></svg>',
    low: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/></svg>',
    high: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    airplay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1"/><path d="M12 15l5 6H7z"/></svg>',
    spotify: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M7 9.5c3.5-1 7.5-.6 10.5 1M7.5 12.8c2.8-.8 6-.4 8.5 1M8 16c2.2-.6 4.5-.3 6.5.8"/></svg>'
  },

  hasScreen() { const i = this.installed; return !i || i.spotify || i.airplay; },

  /** Which speaker is shown: the one tapped; else one that plays (this screen first); else the one shown before while
   *  it still has a song (paused — so pausing doesn't jump away from its Play button); else one with a song; else the first. */
  view() {
    const ids = [...(this.hasScreen() || !this.speakers.length ? ["screen"] : []), ...this.speakers.map((s) => s.id)];
    const nowOf = (id) => (id === "screen" ? this.now : ((this.speakers.find((s) => s.id === id) || {}).now || null));
    let id = ids.includes(this.selected) ? this.selected : null;
    if (!id) id = ids.find((i) => nowOf(i) && nowOf(i).playing) || (ids.includes(this.shownId) && nowOf(this.shownId) ? this.shownId : null) || ids.find((i) => nowOf(i)) || ids[0];
    this.shownId = id;
    if (id === "screen") return { id, name: osT("This screen"), screen: true, now: this.now };
    const sp = this.speakers.find((s) => s.id === id);
    return { id, name: sp.name, screen: false, now: sp.now, available: sp.available, volume: sp.volume, error: sp.error };
  },

  /** What, when it changes, needs a full redraw (song, cover, speaker tabs) — not progress or volume. */
  shape() {
    const v = this.view(), n = v.now;
    const tabs = this.speakers.map((s) => `${s.id}:${s.name}:${s.available}:${!!(s.now && s.now.playing)}`).join(",");
    return `${v.id}|${n ? `${n.source}|${n.title}|${n.artist}|${n.art ? n.art.length + n.art.slice(-24) : ""}` : `idle|${v.available}`}|${JSON.stringify(this.installed)}|${this.now ? this.now.playing : ""}|${tabs}`;
  },

  getDom() {
    const root = document.createElement("div");
    root.className = "mu-root";
    this.root = root;
    const v = this.view(), inst = this.installed;
    if (this.speakers.length) root.append(this.tabs(v));
    if (v.screen && inst && !inst.spotify && !inst.airplay) root.append(this.notInstalled());
    else if (v.now) root.append(this.player(v.now, v));
    else if (v.screen) root.append(this.idle());
    else root.append(this.speakerIdle(v));
    this.syncVolume();
    return root;
  },

  tabs(v) {
    const bar = this.el("div", "mu-tabs");
    const tab = (id, name, playing, off) => {
      const b = this.el("button", `mu-tab${id === v.id ? " on" : ""}${off ? " off" : ""}`);
      if (playing) b.append(this.html("span", "mu-eq", "<i></i><i></i><i></i>"));
      b.append(this.el("span", null, name));
      b.onclick = () => { this.selected = id; this.updateDom(); };
      return b;
    };
    if (this.hasScreen()) bar.append(tab("screen", osT("This screen"), this.now && this.now.playing));
    this.speakers.forEach((s) => bar.append(tab(s.id, s.name, s.now && s.now.playing, !s.available)));
    return bar;
  },

  speakerIdle(v) {
    const card = this.el("div", "mu-card mu-idle");
    card.append(this.html("div", "mu-idle-ic", window.OpenSkyIcons ? window.OpenSkyIcons.svg("music") : ""),
      this.el("h2", "mu-idle-title", v.available === false ? osT("{name} isn't reachable", { name: v.name }) : osT("Nothing playing on {name}", { name: v.name })),
      this.el("p", "mu-idle-sub", v.available === false ? (v.error || osT("Is it switched on? Check it in Home Assistant.")) : osT("Start some music in its app (Spotify, Apple Music, Sonos…), then control it here.")));
    if (v.available !== false) card.append(this.volumeRow());
    return card;
  },

  el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
  html(tag, cls, html) { const e = this.el(tag, cls); e.innerHTML = html; return e; },   // (only our own icons)

  artUrl(a) {
    if (!a || !a.startsWith("art:")) return a;
    const id = a.slice(4);
    if (this.arts[id]) return this.arts[id];
    this.missing = this.missing || new Set();
    if (!this.missing.has(id)) { this.missing.add(id); this.sendSocketNotification("OS_MUSIC_ART_GET", id); }   // (dropped: ask again)
    return null;
  },

  player(now, v) {
    const card = this.el("div", "mu-card mu-player");
    const art = this.artUrl(now.art);
    if (art) { const bg = this.el("div", "mu-backdrop"); bg.style.backgroundImage = `url("${art.replace(/"/g, "%22")}")`; card.append(bg); }
    const box = this.el("div", "mu-art");
    if (art) { const img = this.el("img"); img.src = art; img.alt = ""; box.append(img); } else box.append(this.html("div", "mu-art-empty", window.OpenSkyIcons ? window.OpenSkyIcons.svg("music") : ""));
    const info = this.el("div", "mu-info");
    const chip = this.el("div", `mu-chip mu-chip-${now.source}`);
    chip.append(this.html("span", "mu-chip-ic", this.ICON[now.source] || this.ICON.high), this.el("span", null, now.source === "spotify" ? "Spotify" : now.source === "airplay" ? "AirPlay" : v.name));
    info.append(chip, this.el("div", "mu-title", now.title), this.el("div", "mu-artist", now.artist));
    if (now.album) info.append(this.el("div", "mu-album", now.album));
    const prog = this.el("div", "mu-progress");
    prog.append(this.el("div", "mu-bar"), this.el("div", "mu-times"));
    prog.querySelector(".mu-bar").append(this.el("i"));
    prog.querySelector(".mu-times").append(this.el("span", "mu-pos"), this.el("span", "mu-dur"));
    info.append(prog);
    const ctl = this.el("div", "mu-controls");
    const btn = (cls, icon, action, label) => { const b = this.html("button", `mu-btn ${cls}`, icon); b.setAttribute("aria-label", label); b.onclick = () => this.control(action); return b; };
    ctl.append(btn("mu-prev", this.ICON.prev, "previous", osT("Previous")), btn("mu-play", now.playing ? this.ICON.pause : this.ICON.play, "playpause", now.playing ? osT("Pause") : osT("Play")), btn("mu-next", this.ICON.next, "next", osT("Next")));
    info.append(ctl, this.volumeRow());
    card.append(box, info);
    this.syncPlaying(card);
    return card;
  },

  idle() {
    const card = this.el("div", "mu-card mu-idle");
    const name = this.config.name;
    card.append(this.html("div", "mu-idle-ic", window.OpenSkyIcons ? window.OpenSkyIcons.svg("music") : ""),
      this.el("h2", "mu-idle-title", osT("Play music on this screen")),
      this.el("p", "mu-idle-sub", osT("On your phone, pick “{name}” as the speaker.", { name })));
    const how = this.el("div", "mu-how");
    const tile = (icon, title, steps, note) => {
      const t = this.el("div", "mu-how-tile");
      t.append(this.html("div", "mu-how-ic", icon), this.el("b", null, title));
      const ol = this.el("ol"); steps.forEach((s) => ol.append(this.el("li", null, s))); t.append(ol);
      if (note) t.append(this.el("small", null, note));
      return t;
    };
    const inst = this.installed || { airplay: this.config.airplay, spotify: this.config.spotify };
    if (this.config.airplay && inst.airplay) how.append(tile(this.ICON.airplay, "AirPlay (iPhone, iPad, Mac)", [osT("Open Control Center (or the song in Apple Music)"), osT("Tap the AirPlay icon"), osT("Pick “{name}”", { name })], osT("Works with Apple Music, Podcasts, YouTube and most apps")));
    if (this.config.spotify && inst.spotify) how.append(tile(this.ICON.spotify, osT("Spotify (any phone)"), [osT("Play something in Spotify"), osT("Tap the speaker icon at the bottom"), osT("Pick “{name}”", { name })], osT("Needs Spotify Premium")));
    card.append(how, this.volumeRow());
    return card;
  },

  notInstalled() {
    const card = this.el("div", "mu-card mu-idle");
    card.append(this.html("div", "mu-idle-ic", window.OpenSkyIcons ? window.OpenSkyIcons.svg("music") : ""),
      this.el("h2", "mu-idle-title", osT("Turn this screen into a speaker")),
      this.el("p", "mu-idle-sub", osT("The Music add-on lets your family play music here from their phones (AirPlay and Spotify).")));
    const box = this.el("div", "mu-install");
    box.append(this.el("span", null, osT("On the Pi, open Terminal and type:")), this.el("code", null, "opensky addon music"));
    card.append(box, this.el("p", "mu-idle-note", osT("Speakers you already have (Sonos, HomePod, Echo…) can be controlled from here through Home Assistant: phone setup → Extras → Music.")));
    return card;
  },

  volumeRow() {
    const row = this.el("div", "mu-volume");
    const range = this.el("input", "mu-range");
    range.type = "range"; range.min = "0"; range.max = "100"; range.step = "1";
    range.setAttribute("aria-label", osT("Volume"));
    range.oninput = () => {
      range.style.setProperty("--v", `${range.value}%`);
      this.volBusyUntil = Date.now() + 1500;   // a finger on the slider wins over replies still on their way
      clearTimeout(this.volTimer);
      const v = this.view();
      this.volTimer = setTimeout(() => {
        if (v.screen) this.sendNotification("OPENSKY_VOLUME_SET", Number(range.value));
        else this.sendSocketNotification("OS_MUSIC_CONTROL", { source: "homeassistant", entity: v.id, action: "volume", value: Number(range.value) });
      }, 120);
    };
    row.append(this.html("span", "mu-vol-ic", this.ICON.low), range, this.html("span", "mu-vol-ic", this.ICON.high));
    return row;
  },

  syncVolume() {
    const row = this.root && this.root.querySelector(".mu-volume");
    if (!row) return;
    const view = this.view();
    const v = view.screen ? (this.volume && this.volume.volume) : view.volume;
    row.hidden = v == null;
    const r = row.querySelector("input");
    if (v != null && !(Date.now() < (this.volBusyUntil || 0))) { r.value = String(v); r.style.setProperty("--v", `${v}%`); }
  },

  fmt(ms) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; },

  position() {
    const n = this.view().now;
    if (!n) return 0;
    const p = n.position + (n.playing ? Date.now() - this.receivedAt : 0);
    return n.duration ? Math.min(p, n.duration) : p;
  },

  syncPlaying(scope) {
    const root = scope || this.root, n = this.view().now;
    if (!root || !n) return;
    const play = root.querySelector(".mu-play");
    if (play && play.dataset.playing !== String(n.playing)) {
      play.dataset.playing = String(n.playing);
      play.innerHTML = n.playing ? this.ICON.pause : this.ICON.play;
      play.setAttribute("aria-label", n.playing ? osT("Pause") : osT("Play"));

    }
    root.classList && root.classList.toggle("is-paused", !n.playing);
    this.tickProgress(root);
  },

  tickProgress(scope) {
    const root = scope || this.root, n = this.root ? this.view().now : null;
    const prog = root && root.querySelector(".mu-progress");
    if (!prog || !n) return;
    prog.hidden = !n.duration;
    if (!n.duration) return;
    const p = this.position();
    prog.querySelector(".mu-bar i").style.width = `${(p / n.duration) * 100}%`;
    prog.querySelector(".mu-pos").textContent = this.fmt(p);
    prog.querySelector(".mu-dur").textContent = this.fmt(n.duration);
  },

  control(action) {
    const v = this.view(), n = v.now;
    if (!n) return;
    if (action === "playpause") {   // show it at once
      const flipped = { ...n, position: this.position(), playing: !n.playing };
      if (v.screen) this.now = flipped; else this.speakers = this.speakers.map((s) => (s.id === v.id ? { ...s, now: flipped } : s));
      this.receivedAt = Date.now(); this.syncPlaying();
    }
    this.sendSocketNotification("OS_MUSIC_CONTROL", { source: n.source, action, entity: v.screen ? undefined : v.id });
  },

  toast(msg) {
    if (window.OpenSkyToast) return window.OpenSkyToast(msg, "error");
    console.warn(`[MMM-OpenSky-Music] ${msg}`);
  }
});
