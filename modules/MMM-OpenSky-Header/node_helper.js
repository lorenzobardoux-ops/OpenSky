/* MMM-OpenSky-Header node helper
 * - WEATHER_FETCH {provider, latitude, longitude, units} → WEATHER_RESULT {ok, current, daily} | {ok:false, error}
 *   (OpenWeatherMap's key comes from secrets.json, never from the page)
 * - GAME_FETCH {league, team, ymd} → GAME_RESULT {ok, event|null}: ESPN's public scoreboard. ESPN refuses requests
 *   from the page itself (browser origin) but not from the server.
 * - F1_FETCH → F1_RESULT {ok, races} | {ok:false, error}: the Formula 1 calendar (lib/f1.js; asked on Mondays, kept on disk)
 */
const NodeHelper = require("node_helper");
const path = require("path");
// The shared library sits at <MagicMirror>/modules/opensky-lib (resolve from MagicMirror's root, not this file:
// in development this module folder is a link into the OpenSky repo)
const lib = (f) => require(path.join(global.root_path, "modules", "opensky-lib", f));
const { fetchWeather } = lib("weather.js");
const { secret } = lib("secrets.js");
const f1 = lib("f1.js");

// OpenSky league name → ESPN "sport/league" path
const LEAGUES = {
  nfl: "football/nfl", "college-football": "football/college-football",
  nba: "basketball/nba", wnba: "basketball/wnba", "mens-college-basketball": "basketball/mens-college-basketball",
  mlb: "baseball/mlb", nhl: "hockey/nhl", mls: "soccer/usa.1", nwsl: "soccer/usa.nwsl", epl: "soccer/eng.1"
};

module.exports = NodeHelper.create({
  async socketNotificationReceived(n, p) {
    if (n === "F1_FETCH") {
      try { this.sendSocketNotification("F1_RESULT", { ok: true, races: await f1.races() }); }
      catch (e) { this.sendSocketNotification("F1_RESULT", { ok: false, error: e.message }); }
      return;
    }

    if (n === "WEATHER_FETCH") {
      try {
        const w = await fetchWeather({ ...p, apiKey: secret("weather.openweathermap.apiKey") });
        this.sendSocketNotification("WEATHER_RESULT", { ok: true, current: w.current, daily: w.daily });
      } catch (e) {
        this.sendSocketNotification("WEATHER_RESULT", { ok: false, error: e.message });
      }
      return;
    }
    if (n !== "GAME_FETCH" || !p || !/^\d{8}$/.test(p.ymd || "") || !/^[A-Z0-9]{2,5}$/.test(p.team || "")) return;
    const path = LEAGUES[p.league];
    if (!path) return this.sendSocketNotification("GAME_RESULT", { ok: false, error: `unknown league "${p.league}" (use one of: ${Object.keys(LEAGUES).join(", ")})` });
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${p.ymd}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const ev = (data.events || []).find((e) => (e.competitions?.[0]?.competitors || []).some((c) => c.team?.abbreviation === p.team));
      this.sendSocketNotification("GAME_RESULT", { ok: true, event: ev || null });
    } catch (e) {
      this.sendSocketNotification("GAME_RESULT", { ok: false, error: e.message });
    }
  }
});
