# OpenSky
<img width="2172" height="724" alt="OpenSky open-window calendar logo" src="https://github.com/user-attachments/assets/02481f6e-e7b1-4418-8ce7-6a9d387bf25a" />

A friendly family wall calendar and home dashboard for a Raspberry Pi touchscreen — the week ahead, shared lists,
timers, photos, weather and smart-home controls on one screen. Built on [MagicMirror²](https://magicmirror.builders/).

> **v1.0** — what's in it: [CHANGELOG.md](CHANGELOG.md). Where it's heading: [PLAN.md](PLAN.md).

> **This is a fork** of [CosmoJM/OpenSky](https://github.com/CosmoJM/OpenSky) with its own additions on the branch
> **`meine-anpassungen`** (see [below](#this-forks-additions)). The Pi follows that branch and updates with `git pull`.

**Watch the intro video** (YouTube):

[![OpenSky intro video on YouTube](https://img.youtube.com/vi/qnbN82BGLP4/maxresdefault.jpg)](https://www.youtube.com/watch?v=qnbN82BGLP4)

![The Home page: the week ahead, lists and a photo](docs/assets/screenshots/home.jpg)

<table><tr>
<td><img src="docs/assets/screenshots/calendar.jpg" alt="Calendar page"></td>
<td><img src="docs/assets/screenshots/lists.jpg" alt="Lists page"></td>
</tr><tr>
<td><img src="docs/assets/screenshots/settings.jpg" alt="Settings on the screen"></td>
<td><img src="docs/assets/screenshots/phone-setup-screen.jpg" alt="Set up from your phone: QR code and pairing code"></td>
</tr></table>
<p align="center"><img src="docs/assets/screenshots/phone-setup.jpg" alt="The phone setup page" width="260"></p>

<sub>Screenshots use a made-up family and demo pictures (`node tools/harness.js tools/demo/screenshots.js`).</sub>

## What you get
- **Home:** the week ahead with everyone's events in their colors, weather, trash-day icons, your lists and a photo.
- **Calendar:** month / two-week / week view; tap to see, add, edit or delete events.
- **Lists:** to-dos and groceries — kept on the Pi, or in Todoist. Check off with Undo.
- **Timer**, holiday & birthday countdown, your team's game day, sleep button, photos from a folder, USB stick or Immich.
- Works with Google, Outlook, iCloud, Fastmail, Nextcloud or any calendar link — or no account at all.
- **Add-on — Music:** the screen becomes an AirPlay and Spotify speaker, with a Music page
  ([docs/music.md](docs/music.md)): `opensky addon music`.

## This fork's additions
- **German** screen, phone page and messages (`locale.language: "de"`, dates like 08.11.2026, a QWERTZ keyboard with
  ä ö ü ß) — set it on the phone page: Family → Language.
- **Formula 1** in the header: the next race weekend with qualifying, sprint and race times in German time.
- **Apple Reminders** lists (also ones shared with family), signed in from the phone page.
- **Event templates** on Home instead of the photos: standard events to drag onto a day, in their own color, into
  one or several calendars (shown once).
- Settings and lists scroll with a finger drag; the Timer's boxes open a number pad.
- Updates with a plain `git pull` on the Pi (below). Details for every setting: [docs/configure.md](docs/configure.md).

## Install
On a Raspberry Pi 4/5 with Raspberry Pi OS (64-bit, desktop) and a touchscreen:
```bash
git clone -b meine-anpassungen https://github.com/lorenzobardoux-ops/OpenSky.git ~/OpenSky && cd ~/OpenSky && ./install.sh
```
Then, once, so a `git pull` restarts OpenSky with the new files by itself:
```bash
opensky pull-hook on
```

Step by step: [docs/install.md](docs/install.md) · settings: [docs/configure.md](docs/configure.md) ·
Google Calendar with editing: [docs/google-calendar.md](docs/google-calendar.md) ·
help: [docs/troubleshooting.md](docs/troubleshooting.md)

## Updating (in the console)
Open a Terminal on the Pi (or connect with `ssh`) and run:
```bash
cd ~/OpenSky && git pull
```
That's all: with the pull hook on (above), OpenSky sets up what changed (`./install.sh` when needed — a new module,
the services, new Python parts) and restarts by itself. Without the hook, restart it yourself:
```bash
opensky restart
```
- Check it's running: `opensky status` · its log: `opensky logs` · the settings files: `opensky check`.
- `opensky update` doesn't apply here: it would switch to the original project's release and leave this branch (it
  refuses and says to `git pull` instead).
- A Pi that still points at the original project: switch it once to this fork's branch —
  `git remote set-url origin https://github.com/lorenzobardoux-ops/OpenSky.git && git fetch origin && git checkout -B meine-anpassungen --track origin/meine-anpassungen`
  — then `opensky pull-hook on`. Your settings in `config/` stay as they are.
- Bring the original project's new versions into this fork (on a computer with the repository, not on the Pi):
  `git remote add upstream https://github.com/CosmoJM/OpenSky.git` (once), then
  `git checkout meine-anpassungen && git pull upstream main && git push`; the Pi then gets them with `git pull`.

## Docs

- **For people:** [`docs/`](docs/README.md).
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md).
- **For AI assistants:** start with [`AGENTS.md`](AGENTS.md).
