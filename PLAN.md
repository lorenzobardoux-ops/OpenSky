# OpenSky — project plan

OpenSky is a family wall calendar / home dashboard for a touchscreen: the week ahead, lists, a timer, photos,
weather and smart-home controls on one friendly screen. It runs on a Raspberry Pi and is built on
[MagicMirror²](https://magicmirror.builders/) (MIT).

It started as one family's kitchen calendar (the "reference build", 2026) and is being turned into something anyone
can install, configure and extend.

## Guiding principles
1. **Friendly out of the box.** It should look good and do something useful before you've entered a single key.
   Every feature has a no-account default where one exists (Open-Meteo weather, on-device lists, an ICS calendar).
2. **Configure from a phone, not a text editor.** A setup page served by the Pi (a QR code on screen on first boot)
   for everything a normal person needs; hand-editing config is for power users only.
3. **Secrets stay on the Pi's server side.** MagicMirror serves `config.js` to every device on the network
   (`:8081/config`), so OpenSky keeps keys, tokens and PINs in a separate server-only file. (Learned the hard way.)
4. **Everything optional, nothing fragile.** A missing key or an unreachable service shows a friendly message on that
   card, never a broken screen.
5. **Documentation lives in the release.** Human docs in `docs/`, and `AGENTS.md` written for AI coding assistants,
   so anyone can point their agent at the repo and have it fix problems or build their own integration.
6. **Choice where people differ.** Wherever families use different services (calendars, lists, photos, screens…),
   OpenSky offers several providers behind one setting. The matrix below tracks them.

## Scope
- In: Home (week + lists + photos), Calendar (month/week, add/edit), Lists, Timer, Smart Home page, Settings,
  sidebar, header pills (countdown, sports, Formula 1), curbside pickup icons, Wordle-style daily game, sleep/wake.
- Later (add-on): **Food** (restaurants nearby).
- Out: the reference build's finance page. (A generic "PIN-locked embedded page" may come back as an option.)

## Options matrix — the reference build's choice, and what OpenSky should offer
Legend: **default** = what a new install uses; ✅ = in the reference build already; 🔜 = planned; 💭 = idea.

| Area | Reference build | Options to offer | Notes |
|---|---|---|---|
| Install | hand-built Pi | one-line installer on Raspberry Pi OS ✅; 💭 ready-made SD-card image | Image = friendliest, more work |
| First-run setup | hand-edited config.js | **phone setup page** (QR + pairing code) **default** ✅; config file for power users ✅ | Validates input, explains each field |
| Hardware | Pi 5 + 24" Elo touch | Pi 5 / Pi 4 (Pi 3 = light mode?); any HDMI touchscreen; official Pi touch display | Test matrix needed |
| Screen off/on | soft sleep (black cover + DDC backlight 0) ✅ | Settings → "Sleep turns off by" ✅: auto / black screen + dim / signal off (wlr-randr, came-back self-check + did-it-wake check) / HDMI-CEC (only when a TV answers) / display backlight; Test button; wake-on-touch input watcher. DDC/CI power-off removed after a real test fully powered down a touch monitor (only its power button woke it) | Auto-detect + "test" button |
| Wake | touch / mouse / keyboard ✅ | + motion sensor (PIR) 💭; + presence (Home Assistant) | |
| Sleep schedule | Settings page + HA automations ✅ | **built-in schedule** default ✅; Home Assistant optional | Don't require HA |
| Calendar (read) | iCloud via CalDAV backend ✅ | **ICS URL** default ✅ (Google/Outlook/iCloud "secret address"); on-device ✅; iCloud + generic CalDAV ✅; Google Calendar API ✅ (own OAuth client, guided on the phone); Microsoft 365 / Outlook (Graph) | Several calendars, color per person |
| Calendar (add/edit) | iCloud CalDAV ✅ | CalDAV ✅; Google (OAuth, read + write) ✅; Microsoft 365 💭; read-only mode ✅ | OAuth = setup friction; guide it |
| Lists | Todoist (2 projects) ✅ | **on-device lists** default (no account) ✅; Todoist ✅; Home Assistant to-do ✅ (covers Google Tasks etc. connected to HA); Google Tasks; Microsoft To Do; Apple Reminders (CalDAV VTODO); 💭 Grocy, AnyList, Mealie | Any number of lists, user-named |
| Weather (header + day tiles) | OpenWeatherMap (header) + Open-Meteo (7-day) ✅ | **Open-Meteo** default (no key) ✅; OpenWeatherMap ✅; 💭 NWS, Met.no | °F/°C, location by address search |
| Photos | Immich ✅ | **local folder / USB stick** default ✅; Immich ✅; 🔜 PhotoPrism; Nextcloud/WebDAV; iCloud shared album link; 💭 Google Photos (API is very limited now) | Portrait pairing ✅ |
| Smart Home page | Home Assistant dashboard (webview) ✅ | Home Assistant; **any URL** embed; none | Generic "embedded page" with optional PIN |
| HA integration | screen switch/sensor, presence, sleep helpers ✅ | optional: auto-create HA entities via MQTT discovery or a small HA integration 💭 | Reference build uses REST + templates |
| Header countdown pill | US holidays + birthdays ✅ | holidays by **country** ✅ (US: Google list; ~200 others: Nager.Date, + regions); birthdays from a calendar or a list | Themed icons ✅ |
| Sports pill | Patriots (ESPN) ✅ | pick any team ✅: NFL/NBA/MLB/NHL/MLS/college/EPL (ESPN); off by default | ESPN API is unofficial → can break |
| Curbside pickup icons | New Bedford rules (collection.js) ✅ | generic schedule ✅ (trash day, recycling weekly/every other week, yard-waste weeks, holiday shift rule); ICS import ✅ (city / ReCollect pickup calendars → icons by keyword) (many cities / ReCollect publish one); city presets contributed by users | Reference city = example preset |
| Timer chime | USB speaker (PipeWire) ✅ | any audio output; 💭 smart-speaker announcement via HA | |
| Daily word game | NYT daily word ✅ | **NYT word default** ✅ (the maintainer's call); built-in SCOWL words as backup / opt-out ✅ | Rename (not "Wordle", a NYT trademark) |
| On-screen keyboard | iPad-style US ✅ | own module ✅; 🔜 layouts (US, UK, intl.); 💭 languages | |
| Brightness / volume (Settings) | ddcutil + wpctl ✅ | DDC/CI; Pi display backlight; none (hide slider) | Auto-detect |
| Look & feel | family name in the header, pastel theme ✅ | family name ✅, 12/24 h ✅, units ✅, first day of week ✅; accent color ✅; 🔜 light/dark, date format; 💭 languages (i18n) | |
| Updates | manual | "Update" button in Settings ✅ (git pull + installer); automatic rollback when it doesn't start ✅ + `opensky rollback`; 🔜 settings migrations | Big for friendliness |
| Backups | nightly git + NAS (reference build) | export/import from the phone setup page ✅ (settings + on-device data; passwords optional) | |
| Food (add-on) | Google Places + Routes ✅ | Google (own key); 💭 OpenStreetMap/Overpass (free, no key) | Later |

## Roadmap (milestones)
1. **Skeleton** — repo, plan, docs layout, AGENTS.md, licence, separate backups. ✅
2. **Port the reference build, scrubbed** — modules copied in, every secret/personal value moved to settings with
   safe defaults; community-module changes as forks/patches with their licences kept.
   Progress: ✅ settings → config builder, base theme, shared lib (weather, secrets), off-screen harness;
   ✅ Timer, ✅ Sidebar (soft sleep on any screen), ✅ Header (Open-Meteo default, custom dates, any-team sports pill),
   ✅ Home (events from any calendar source, named color palette + rules, shared weather, provider-neutral lists
   card, photos from a folder/USB stick or Immich, generic pickup schedule + New Bedford preset).
   ✅ Calendar sources (public links in settings, private links in secrets.json, MagicMirror's own fetcher),
   ✅ Calendar page (MMM-CalendarExt3 pinned + patch, toolbar, taps, two-line fitting, palette colors).
   ✅ On-device calendar (default, no account) + event editor (day list, view, add, edit, delete; linked calendars
   read-only; changes go through the node helper).
   ✅ CalDAV calendar service (services/calendar-service: iCloud/Fastmail/Nextcloud…, add/edit/delete, offline
   cache, tested against a throwaway Radicale server).
   ✅ Lists (on-device default + Todoist; add / edit / delete / check off with Undo; shared toast).
   ✅ Installer (`install.sh`: private Node only if needed, pinned MagicMirror, CalDAV venv, first-run questions,
   systemd user services + desktop autostart, `opensky` command) and user docs (install, configure, troubleshooting).
   ✅ Lists page (all lists side by side, scrolling; shared list-column renderer with Home).
   ✅ Settings panel (brightness by backlight / DDC/CI / software, evening dim, built-in sleep schedule, volume,
   status, update / restart / power with tap-twice; dry-run for tests).
   ✅ On-screen keyboard (own module, no dependency) + the screen's language follows the settings.
   ✅ Embed pages (any web page as a page; optional PIN checked on the Pi; private address only after the PIN).
   ✅ Word game: NYT's daily word by default (the maintainer's decision, 2026-10-16), OpenSky's own SCOWL word as the backup
   or with wordgame.source "opensky"; checked on the Pi; family board + stats.
   ✅ Phone setup page (QR + 6-digit pairing code on the screen; LAN server only while open; write-only secrets;
   first-run welcome card; Settings → Set up from your phone).
   Next: clean-install test on a spare SD card (needs the maintainer), then providers from the matrix.
   Since: Google Calendar (read + write), Home Assistant lists, holidays for ~200 countries, pickup from a calendar
   link, backups (download/restore + nightly automatic), safe updates with rollback, accent color, screen-off methods
   with Test + wake on touch, Settings on the screen = the phone's core settings, web-page touches count as activity,
   **add your own web page** from Settings or the phone (name, address, 16 icons, optional PIN).
3. **First public milestone (v1.0)** — everything above. ✅ built, tested off-screen, and installed from GitHub on a
   real Pi + touch monitor (v1.0.0-rc.3: installer questions, phone setup over Wi-Fi, every page, updates).
4. ~~Phone setup page~~ ✅ (done in 2).  5. ~~Providers from the matrix~~ ✅ most of them (done in 2).
6. ✅ **Public release v1.0.0** (2026-10-23): tag + GitHub release. Next: announcement (MagicMirror forum "Showcase").

## v2 (nice to have — after v1.0)
- Look: dark mode, date format, more themes; languages (i18n); keyboard layouts (UK, international).
- More providers: Microsoft 365 / Outlook (Graph) calendars, Google Tasks direct, Apple Reminders (CalDAV VTODO),
  PhotoPrism / Nextcloud photos, NWS / Met.no weather.
- Presence: screen on/off from Home Assistant (nobody home → off), settings migrations between versions.
- Add-ons: **Food** (nearby restaurants), others from the community; a ready-to-flash SD-card image.
- **Music add-on** (asked for by a user): ✅ step 1 — the screen as an AirPlay + Spotify Connect speaker with a Music
  page (`opensky addon music`, docs/music.md). ✅ Step 2 — the same page as a remote for other speakers through Home
  Assistant media players (Sonos, HomePod, Echo, Google, Spotify…). Maybe later: Spotify's Web API directly (each
  family's own developer key, Premium) for families without Home Assistant.
