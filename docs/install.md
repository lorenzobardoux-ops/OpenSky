# Installing OpenSky

About 20 minutes, most of it waiting. You don't need to know Linux; just copy and paste the commands below.

## What you need
- A **Raspberry Pi 5 or 4** (2 GB+ RAM). A Pi 5 is snappier.
- A **touchscreen** (any HDMI or DSI touch display; 15–27″ landscape looks best).
- A **microSD card**, 32 GB or bigger, plus the Pi's power supply.
- Wi-Fi or a network cable.

## 1. Put Raspberry Pi OS on the card
1. On a computer, install **Raspberry Pi Imager** from <https://www.raspberrypi.com/software/>.
2. Choose your Pi model, then **Raspberry Pi OS (64-bit)**. Use the normal one with the desktop, not "Lite".
3. Click **Edit settings** before writing the card:
   - set a username and password (write them down)
   - add your Wi-Fi name and password
   - set your **time zone**
   - turn on **SSH** if you'd like to set things up from another computer
4. Write the card, put it in the Pi and switch it on. The first start takes a few minutes.

## 2. Install OpenSky
On the Pi, open **Terminal** (the black icon at the top) and paste these lines one at a time:

```bash
git clone https://github.com/CosmoJM/OpenSky.git ~/OpenSky
cd ~/OpenSky
./install.sh
```

The installer:
- checks the Pi and downloads what OpenSky needs (MagicMirror², and a newer Node.js only if needed)
- asks a few questions: your **family name** and **town**. The town is used for weather, °F/°C and the clock style.
- asks a few yes/no questions. Answer **yes** to all of them:
  - "Keep the screen from going blank by itself?" OpenSky has its own Sleep button.
  - "Log in automatically at power-on?" This lets OpenSky start by itself after a power cut.
  - "Keep the Wi-Fi awake?" Otherwise the Pi's Wi-Fi power saving can stop your phone from reaching the screen.
  - It may also offer to set your screen's brightness from Settings.
- starts OpenSky

When it says **All set!**, OpenSky fills the screen. Restart the Pi once (`sudo reboot`) to make sure it starts by itself.

## 3. Make it yours
The first time OpenSky starts it offers **Set up on my phone**: scan the QR code, type the code from the screen and
add your calendars, lists and photos from the sofa. (Later: Settings → Set up from your phone.)

Out of the box you get:
- an on-device **Family** calendar you can add events to from the screen
- two lists, **To-Dos** and **Groceries**
- weather for your town
- a timer
- photos from the Pi's `~/Pictures` folder or a USB stick

Next steps, all in [configure.md](configure.md):
- **Show your existing calendars**: Google, iCloud, Outlook or any calendar link.
- **Use Todoist** for your lists instead of the on-device ones.
- **Photos** from a USB stick, a folder, or your Immich server.
- **Trash day** icons, your team's game day, colors per person, and which pages to show.

To change settings, open Terminal and type `opensky edit`. Save with Ctrl+O, Enter, then exit with Ctrl+X. Then type `opensky restart`.

## Updating
```bash
opensky update
```
This gets the newest OpenSky, re-runs the installer (no questions) and restarts. If the new version doesn't start
properly, it goes back to the previous one by itself. To go back by hand: `opensky rollback`. (Settings → Update does
the same from the screen.) Your settings and data in `~/OpenSky/config/` are kept.

### Your own version (a fork)
If you keep your own changes on a branch of your GitHub fork, let the Pi follow that branch instead (once):
```bash
cd ~/OpenSky && git remote set-url origin https://github.com/YOU/OpenSky.git
git fetch origin && git checkout -B my-branch --track origin/my-branch
opensky pull-hook on
```
From then on `cd ~/OpenSky && git pull` is all it takes: OpenSky restarts with the new files by itself, and re-runs
the installer first when the pull changed something it sets up (a new module, the services, `install.sh`).
`opensky update` and Settings → Update leave a branch like this alone (they'd switch it to the official release).
`opensky pull-hook off` turns the automatic restart off again.

## Uninstalling
```bash
cd ~/OpenSky && ./install.sh --uninstall
```
This stops OpenSky and removes its start-up entries. It asks before deleting the downloaded parts. Your `config/` folder is never deleted. Remove `~/OpenSky` yourself if you want it gone completely.

## Backing up
The easy way: **Settings → Set up from your phone → Backup → Download a backup** (switch on "Include passwords & keys"
for a complete copy, and keep that file private). To move to a new SD card or a new Pi: install OpenSky there, open
phone setup, **Restore from a backup**, then **Finish**.

Automatic: Settings → **Backups** (or the phone page) → pick a USB stick or network folder; a copy is made every night.
`opensky backup` makes one right away.

By hand: everything personal lives in **`~/OpenSky/config/`**: your settings, passwords and keys, and the on-device calendar and lists. Copy that folder somewhere safe, such as a USB stick or your computer. It holds passwords, so keep the copy private.

## Installer options
| Option | What it does |
|---|---|
| `--yes` | no questions (defaults; edit settings later) |
| `--no-services` | install only; don't start with the desktop or change screen blanking |
| `--home DIR` | put the downloaded parts somewhere else (default `~/.local/share/opensky`) |
| `--uninstall` | stop OpenSky and remove its start-up entries |

Something not working? See [troubleshooting.md](troubleshooting.md).
