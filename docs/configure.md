# Setting up OpenSky

**The easy way: set it up from your phone.** On the screen tap **Settings → Set up from your phone** (the very first
start offers it by itself). Scan the QR code with your phone's camera — or open the address it shows — and type the
6-digit code. You can add calendars (Google, Outlook, iCloud…), lists, photos, pages, web pages, trash day, your team,
then tap **Save** and **Finish**; the screen restarts with your settings. Your phone must be on the same Wi-Fi.
Passwords and links you type there go straight into `secrets.json`; the phone can replace them but never read them back.
The setup page only exists while the code is on the screen (it closes by itself after 30 quiet minutes).

Everything below can also be edited by hand — the phone page writes these same files.

**Day-to-day things are on the screen itself:** tap **Settings** at the bottom left for brightness, evening dimming,
the night-time sleep schedule, volume, restart / update / shut down. Those choices are saved in `config/device.json`.

Everything else is in two files in `~/OpenSky/config/`:

| File | What's in it | Open it with |
|---|---|---|
| `opensky.json` | your **settings**: family name, town, calendars, lists, photos, pages… | `opensky edit` |
| `secrets.json` | **passwords and keys**: private calendar links, iCloud password, Todoist token, Immich key | `opensky secrets` |

`secrets.json` is read only by the Pi itself. It is never sent to the screen or to other devices on your network, so private things belong there and nowhere else.

After changing either file, run **`opensky restart`**. If the screen doesn't come back, run **`opensky check`**. It tells you about a missing comma or quote.

> **The file format (JSON), in 20 seconds:**
> - Text goes in "double quotes".
> - Items in a list are separated by commas, with **no comma after the last one**.
> - `{ }` holds named settings; `[ ]` holds a list.
> - Keys starting with `_` are notes and are ignored.

---

## Family and place
```json
"family":   { "name": "The Smiths" },
"location": { "name": "Boston, MA", "latitude": 42.3601, "longitude": -71.0589 },
"locale":   { "language": "en", "locale": "en-US", "timeFormat": 12, "units": "imperial", "firstDayOfWeek": 0 }
```
- `family.name`: shown at the top left. Its first letter (ignoring "The") is the Home button's badge.
- `location`: used for the weather. The installer fills it in. To find the numbers yourself, search for your town on
  <https://open-meteo.com/en/docs> and copy the latitude and longitude.
- `locale.timeFormat`: `12` (3:00 PM) or `24` (15:00).
- `locale.units`: `"imperial"` (°F) or `"metric"` (°C).
- `locale.firstDayOfWeek`: `0` = Sunday, `1` = Monday (month view).
- `locale.locale`: how dates are written (`"en-US"`, `"en-GB"`, `"de-DE"`…) — on the screen and in date boxes.
- `locale.language`: the language of the screen and the phone page: `"en"` (English) or `"de"` (Deutsch). The phone
  page has it under Family → Language, which also sets `locale.locale` (`"de-DE"`: dates like 08.11.2026). With
  `"de"` the on-screen keyboard is German (QWERTZ, umlauts, ß) unless `keyboard.layout` says otherwise, and public
  holidays from other countries come with their local names. Event titles, list items and the word game's words stay
  as they are. For a German screen:
  `"locale": { "language": "de", "locale": "de-DE", "timeFormat": 24, "units": "metric", "firstDayOfWeek": 1 }`

- The **time zone** comes from the Pi itself. To change it: `sudo raspi-config nonint do_change_timezone America/Chicago` (use your zone).

## Accent color and size
```json
"look": { "accent": "teal", "scale": "auto" }
```
`scale`: OpenSky is laid out for a 1920×1080 screen and is scaled to fit yours (`"auto"`): a 1280×720 screen shows
the same layout at two-thirds size, a 4K screen at double size. Want it bigger or smaller? Use a number, e.g. `1.2`.

`accent`: the color of buttons, highlights and the active page: any palette color name (see Calendars) or any
color as a code, `"#rrggbb"` (or the short `"#rgb"`), e.g. `"#3b82f6"` or your team's color. Leave it out for the
default peach. Pick it on the screen (Settings → Look & extras: a chip, or type a code under "Or a color code") or on
the phone (Extras: a chip, the color picker, or a code). A very light color gets a warning: the text on buttons is
white.

## Pages
```json
"pages": ["home", "calendar", "lists", "timer"]
```
These are the buttons on the left, in this order. The first one is where the screen returns after a few idle minutes.

| Page | What it is |
|---|---|
| `home` | the week ahead, your lists and a photo |
| `calendar` | month view (two weeks / one week from its toolbar), tap a day or event to see or edit it |
| `lists` | every list side by side, each one scrolls (Home shows the first three) |
| `wordgame` | a daily five-letter word puzzle for the whole family (one shared board a day, family stats) |
| `timer` | kitchen timers with a chime |
| `music` | **add-on**: what's playing on the screen's speakers, with play / pause / skip and the volume — see [music.md](music.md) |

You can also add your own **web pages** as pages (next section).

**Word game:** a new puzzle every day at midnight — by default the same word as the New York Times' daily Wordle
(fetched by the Pi). If NYT can't be reached, OpenSky's own word for the day is used (the page says so) and NYT is
tried again until someone guesses. For OpenSky's own words only: `"wordgame": { "source": "opensky" }`.
A word you know is real but isn't accepted? Add it: `"wordgame": { "extraWords": ["emoji"] }`.

## Web pages on the screen (Smart Home, cameras…)
Any web page can be a page of its own — a Home Assistant dashboard, a camera, a school portal, a recipe site.
**Easiest:** Settings → Pages → **+ Add a web page** (or the phone page → Web pages): type a name and the address,
pick an icon, optionally lock it with a PIN, then **Restart now**. Edit or remove it the same way. By hand:
```json
"pages": ["home", "calendar", "lists", "smarthome", "timer"],
"embeds": {
  "smarthome": { "title": "Smart Home", "url": "http://homeassistant.local:8123/lovelace/0?kiosk", "zoom": 1 }
}
```
- The key (`smarthome` here) is what you put in `pages`. Lower-case letters, digits and `-`.
- `title` is the sidebar label; `icon` is one of `embed globe smarthome camera play music cart food school briefcase
  heart chart cloud car paw book`; `zoom` (e.g. `0.8`) fits more of a busy page.
- Log in once on the screen (the keyboard appears); the page remembers it like a browser does.
- **Back** and **Reload** buttons sit in the bottom-right corner.
- **Private address or a PIN:** put them in `secrets.json`, not here (opensky.json can be read by devices on your Wi-Fi):
  ```json
  "embeds": { "money": { "url": "http://192.168.1.50:8080/", "pin": "4826" } }
  ```
  With a PIN, the page asks for it **every time** it's opened; leaving the page, the screen going to sleep or the
  auto-return to Home lock it again. Five wrong PINs in a row → a 30-second pause.

## Weather
```json
"weather": { "provider": "open-meteo" }
```
- `"open-meteo"` (default) is free and needs no account or key.
- `"openweathermap"` needs a free API key from <https://openweathermap.org/>, put in `secrets.json → weather.openweathermap.apiKey`.

## Header (top bar)
```json
"header": {
  "holidays": "US",
  "occasions": [ { "name": "Anniversary", "month": 6, "day": 14 } ],
  "birthdaysFromCalendar": true,
  "sports": { "league": "nfl", "team": "NE" },
  "f1": true
}
```
- The top-right pill counts down to the next holiday, occasion or birthday.
  - Holidays follow `calendar.holidays` (your country); `header.holidays: "none"` leaves them out of the pill.
  - `occasions`: your own yearly dates. `month` runs 1–12.
  - `birthdaysFromCalendar`: calendar events with "Birthday" or "Bday" in the title count as birthdays.
- `sports`: on game day, a pill shows your team's game, time and channel, then the live score.
  - Leagues: `nfl`, `college-football`, `nba`, `wnba`, `mens-college-basketball`, `mlb`, `nhl`, `mls`, `nwsl`, `epl`.
  - `team` is the short code shown on scoreboards (`NE`, `BOS`, `LAL`…). Leave it `""` for no sports pill.
- `f1: true`: a pill with the next Formula 1 weekend: the race's name, when qualifying and the race start
  ("Quali Sa 21.11. 05:00 · Race So 22.11. 05:00", "today" / "tomorrow" close to it) and the days until the next of
  the two. Each drops off 30 minutes after its start (qualifying first, then the race; then the next weekend shows).
  Phone page: Extras → Formula 1. The calendar comes from Jolpica

  (api.jolpi.ca, free, no key), asked on Mondays and kept in `config/calendar-cache/`, so it works offline too.
  Race names are in the screen's language ("Großer Preis von Monaco").
- `birthdaysFromCalendar` also counts "Geburtstag" in a title.


## Calendars
OpenSky can show any number of calendars, each with its own color. Some can also be **added to and edited from the screen**.

```json
"calendar": {
  "sources": [
    { "name": "Family", "type": "local", "color": "blue" },
    { "name": "School", "url": "https://example.org/school-events.ics", "color": "teal" },
    { "name": "Mom", "color": "pink" },
    { "name": "Shared", "type": "caldav", "color": "green" }
  ],
  "holidays": "US",
  "colors": {
    "calendars": {},
    "rules": [ { "match": "dentist", "color": "indigo" }, { "match": "soccer", "color": "green" } ]
  }
}
```

| Kind | How | Edit from the screen? |
|---|---|---|
| **On the Pi** | `"type": "local"`. Nothing to set up; events are kept on the Pi. | ✅ |
| **A calendar link** (Google, Outlook, iCloud, school or team calendars…) | `"url": "…"` in opensky.json if it's public, or no url and the link in `secrets.json → calendar.sources.<name>` if it's private | read-only |
| **Google, with editing** | `"type": "google", "calendarId": "primary"` — a one-time Google key + sign-in, guided on the phone: [google-calendar.md](google-calendar.md) | ✅ |
| **iCloud, Fastmail, Nextcloud (CalDAV)** | `"type": "caldav"` and the account in `secrets.json` (below) | ✅ |

- `holidays`: your country's public holidays as a calendar (and in the countdown pill): a two-letter country code —
  `"US"` (Google's US list, with Mother's Day, Halloween…), `"GB"`, `"CA"`, `"DE"`, `"AU"`… (from Nager.Date, about 200 countries).
  `"holidaysRegion": "GB-SCT"` (or `"CA-ON"`, `"DE-BY"`…) adds that region's own days. `"none"` turns it off.
- **Colors:** `pink`, `green`, `blue`, `orange`, `yellow`, `emerald`, `purple`, `red`, `teal`, `indigo`, `tan`, `gray` —
  or any color as a code, `"#8cbfc4"` (or `"#8cf"`; upper or lower case): events get a solid bar in that color on a pale
  background of it. Anything else is ignored (the event gets an automatic color). Each event's color is picked in this order:
  1. a matching `rules` keyword in the title
  2. `colors.calendars` (`{ "Mom": "pink" }`)
  3. the calendar's own `color` in `sources`
  4. otherwise a steady automatic color

### Finding a calendar's link
- **Google Calendar** (on a computer): ⚙ Settings → pick the calendar on the left → *Integrate calendar* → copy **Secret address in iCal format**. It's private, so put it in `secrets.json`.
- **Outlook / Microsoft 365**: Settings → Calendar → *Shared calendars* → *Publish a calendar* → choose "Can view all details" → copy the **ICS** link.
- **iCloud** (read-only link): Calendar app → the calendar's ⓘ → **Public Calendar** → copy the link (`webcal://…` works).
- School, team and sports calendars usually offer an "iCal / ICS / Subscribe" link.

A private link goes in `secrets.json` like this. The name must match opensky.json:
```json
"calendar": { "sources": { "Mom": "https://calendar.google.com/calendar/ical/…/private-…/basic.ics" } }
```

### iCloud / Fastmail / Nextcloud with editing (CalDAV)
In `opensky.json`: `{ "name": "Shared", "type": "caldav", "color": "green" }`. Then in `secrets.json`:
```json
"calendar": { "caldav": {
  "Shared": { "url": "https://caldav.icloud.com/", "username": "you@icloud.com", "password": "abcd-efgh-ijkl-mnop", "calendar": "Family" }
} }
```
- **iCloud needs an app-specific password**, not your Apple ID password. Create one at <https://appleid.apple.com> → *Sign-In and Security* → *App-Specific Passwords*.
- `calendar` is the calendar's name as it appears in the Calendar app.
- **Fastmail**: `"url": "https://caldav.fastmail.com/"` with an app password.
- **Nextcloud**: `"url": "https://your-server/remote.php/dav/"`.
- Repeating events are shown, but are changed in your calendar app rather than on the screen.
- The last copy of each calendar is kept on the Pi, so events still show if the internet is down.

## Lists
```json
"lists": {
  "lists": [
    { "name": "To-Dos", "color": "blue" },
    { "name": "Groceries", "color": "orange" },
    { "name": "Shopping", "provider": "todoist", "project": "Shopping", "color": "green" }
  ],
  "refreshMinutes": 2,
  "columns": 4
}
```
- `color`: a palette name (as for calendars) or a color code like `"#8cbfc4"`.
- **On the Pi** (default, no `provider`): items are kept on the Pi.
- **Todoist** (`"provider": "todoist"`): shows a Todoist project, by default the one with the same name as the list. Use `"project": "…"` for a different name, or `"projectId": "…"`.
  - Add your token to `secrets.json → lists.todoist.token`. Find it in Todoist → Settings → *Integrations* → *Developer* → **API token**.
  - Changes on the screen show in the Todoist app, and the other way round. The screen checks every `refreshMinutes`.
- **Home Assistant** (`"provider": "homeassistant", "entity": "todo.shopping_list"`): any Home Assistant to-do list
  (the built-in Shopping List, Local To-do, Google Tasks or others connected to HA). Put your HA address and a
  long-lived access token (HA → your profile → Security) in `secrets.json → homeassistant.url / .token`.
- Home shows the first three lists; the **Lists** page shows them all (`columns` fit across, more scroll sideways). Tap **Add item** to add, tap the circle to check off (with Undo), or tap an item to edit or delete it.

## Photos
```json
"photos": { "enabled": true, "provider": "folder", "folder": "~/Pictures", "usb": true, "intervalSeconds": 30 }
```
- `folder`: pictures in this folder and its sub-folders, shuffled. Copy them over the network, or with a USB stick and the file manager.
- `usb`: also show photos from a plugged-in USB stick. Put them in a folder named **`OpenSky`** on the stick; the rest of the stick is ignored.
- Two portrait photos are shown side by side. The date a photo was taken is shown when the photo has it.
- **Immich** (your own photo server): `"provider": "immich", "url": "http://192.168.1.20:2283"`. Put an API key in
  `secrets.json → photos.immich.apiKey`; create it in Immich under Account Settings → *API Keys*.
- `"enabled": false`: no photo card.

## Trash and recycling day
```json
"pickup": { "trashDay": "monday", "preset": "" }
```
A small trash-can icon appears on pickup days in the week view. It moves a day later after a holiday.
- `trashDay`: `"monday"` … `"friday"`. Leave it `""` for no icons.
- `preset`: a city's full schedule, including yard waste and holidays. Current presets: `"new-bedford-ma"`. Want your city added? Open an issue on GitHub with a link to its schedule, or ask an AI assistant to make one with `lib/pickup-presets/new-bedford-ma.json` as the example.
- **From a calendar:** many cities (and services like ReCollect) publish pickup days as a calendar link.
  `"pickup": { "url": "https://…" }` — or keep it private (it can contain your address): `"url": "secret"` and the
  link in `secrets.json → calendar.sources.Pickup`. Events with "trash/garbage/refuse", "recycling" or
  "yard/leaf/compost" in their names become the icons (they don't show as events). Works together with `trashDay`.
- Your own rules (every-other-week recycling, yard-waste weeks…) can go here too; see the notes at the top of `lib/client/pickup.js`.

## Screen and timers
```json
"sidebar": { "idleReturnMinutes": 5 },
"timer":   { "quickAddMinutes": [5, 10, 15, 30, 45, 60], "chimeVolume": 0.6 }
```
- `idleReturnMinutes`: after this many minutes without a touch, open pop-ups close and the screen returns to the first page. A running timer stays put. `0` turns this off.
- **Sleep** (bottom left) blacks out the screen until the next touch.
- `quickAddMinutes`: the timer's quick buttons. `chimeVolume` runs from 0 to 1.

## On-screen keyboard
```json
"keyboard": { "enabled": true }
```
A keyboard slides up whenever you tap a text box (adding a list item, naming an event). Turn it off with `false`
if you use a real keyboard. Dates and times use pickers instead. `"layout": "de"` gives the German keyboard
(QWERTZ with ä, ö, ü, ß), the default when `locale.language` is `"de"`; `"en"` the English one. The Timer's hours,
minutes and seconds get a number pad instead (digits and delete only).



## The Settings panel (on the screen)
| Setting | What it does |
|---|---|
| Brightness | Uses the display's backlight (Pi touch displays), the monitor's own brightness over HDMI (most monitors; the installer sets this up), or — if neither works — dims the picture. The panel says which. |
| Dim in the evening | From the time you pick until the morning, brightness goes down to the level you pick. |
| Sleep turns off by | How the screen goes off: **Automatic** (recommended), **Black screen + dim** (works on every screen), **Turn the signal off** (most monitors), **TV standby (HDMI-CEC**, only offered when a TV answers), **Display backlight off** (Pi displays). **Every screen is different — try them with Test** (back after 10 seconds or at a touch). A monitor that turns itself back on when the signal stops is noticed and switched to Black screen + dim; a screen that doesn't come back after waking is retried, then switched too. If none suits your screen, Black screen + dim always works. (There's deliberately no "monitor power-off over HDMI": on some monitors it switches them fully off, and only their power button brings them back.) |
| Sleep at night | The screen goes dark at "Off at" and comes back at "On at". A touch wakes it; it sleeps again after 3 quiet minutes. A running timer keeps it on. |
| Volume / Test | The Pi's speaker volume; Test plays the timer chime. |
| Pages | Turn pages on/off and change their order (also on the phone). |
| Look & extras | Accent color, word game (NYT's word or OpenSky's), photo slideshow on/off, trash day. |
| Backups | Every night to a USB stick, a network folder or the Pi itself — the list shows what the Pi can reach right now; keep 7–90; passwords included only if you switch it on; **Back up now**. |
| System | Internet, the Pi's address, the OpenSky version (and **Update** when there is one), Reload, Restart OpenSky, Restart Pi, Shut down. The last three ask you to tap twice. |

## Phone setup
```json
"setup": { "port": 8090 }
```
The port the phone page uses while setup is open (only then). Change it if something else on the Pi uses 8090.

## Automatic backups
```json
"backup": { "destination": "/media/pi/MYSTICK", "time": "03:00", "keep": 14, "includeSecrets": false }
```
Easiest from Settings (on the screen) or the phone page → Backup. Backups go to `<destination>/OpenSky-backups/`, one
file per night, the newest `keep` kept. A USB stick that's unplugged is retried every hour. A network folder: mount it
on the Pi (e.g. open it once in the file manager: *Go → Network*) and it appears in the list. Restore a backup from the
phone page → Backup → Restore.

## Updates
```json
"update": { "channel": "releases" }
```
`opensky update` (and Settings → Update) installs the newest **release**. `"main"` follows the newest development
version instead — for testers. Either way, a version that doesn't start is rolled back by itself.

