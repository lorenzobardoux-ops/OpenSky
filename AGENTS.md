# AGENTS.md — guide for AI coding assistants working on OpenSky

You are helping someone run, fix or extend **OpenSky**, a family wall calendar / home dashboard built on
MagicMirror². This file is the entry point; read it first, then the docs it points to.

> Status: early development. This file grows with the project — keep it current when you change things.

## Read in this order
1. `PLAN.md` — goals, principles, the options matrix (which providers exist or are planned) and the roadmap.
2. `docs/` — user documentation: `install.md`, `configure.md` (every setting in `opensky.json` / `secrets.json`),
   `troubleshooting.md`. Point people there rather than re-explaining.
3. `docs/development/architecture.md` — how OpenSky is put together (distribution on upstream MagicMirror²,
   settings vs secrets, module names, services, lessons learned). Testing guide: `docs/development/testing.md`.

## Ground rules for agents
- **Never put secrets in `config.js`.** MagicMirror serves it to the whole network. Keys, tokens and PINs go in the
  server-only secrets file (documented in `docs/`), read by node helpers.
- **Don't break the screen.** Test changes off-screen (headless compositor + Playwright, see
  `docs/development/testing.md`) before restarting the real display.
- **Prefer configuration over code edits** for a user's personal setup; if you add a provider, follow the provider
  pattern so it shows up in settings for everyone.
- **Keep docs in step with code** — a feature isn't done until `docs/` and this file say how to use it.

## Where things are on an installed Pi
| What | Where |
|---|---|
| The user's settings + data (back this up) | `~/OpenSky/config/`: `opensky.json`, `secrets.json` (chmod 600), `device.json` (Settings panel), `local-calendar.json`, `lists.json`, `calendar-cache/` |
| Runtime (re-creatable by `./install.sh`) | `~/.local/share/opensky/`: `MagicMirror/` (pinned tag, OpenSky linked in by `tools/link-mm.sh`), `node/` (only if the system Node is too old), `venv/` |
| Services | systemd **user** units `opensky.service` (Electron) + `opensky-calendar.service` (CalDAV helper); started by `~/.config/autostart/opensky.desktop` |
| Commands | `opensky status · logs · check · restart · edit · secrets · update · pull-hook on\|off` (`tools/opensky`) |
| A Pi on its own branch (a fork) | `git pull` instead of `opensky update` (which refuses there); `opensky pull-hook on` makes git's post-merge hook run `tools/after-pull.sh` (install.sh when needed, then restart) — see `docs/install.md` |

The settings files are found through environment variables set by the services (`OPENSKY_SETTINGS`, `OPENSKY_SECRETS`,
`OPENSKY_LOCAL_CALENDAR`, `OPENSKY_LOCAL_LISTS`, `OPENSKY_CALENDAR_CACHE`), so nothing personal lives in the runtime.

## Helping a user (checklist)
1. `opensky status`, `opensky check`, `opensky logs` — most problems are a JSON typo or a wrong link/password.
2. Most people set things up with the **phone page** (Settings → Set up from your phone); by hand works too.
   Change **settings**, not code: `config/opensky.json` / `config/secrets.json`, then `opensky restart`.
3. Never print, paste or commit the contents of `secrets.json`, private calendar links or tokens.
4. Don't edit files in `~/.local/share/opensky/MagicMirror` — they are replaced on update.

## Conventions for code changes
- Module fields/methods must not reuse MagicMirror's `Module` names (`data`, `show`, `hide`, `config`, `name`…).
- No emoji in the UI (Raspberry Pi OS has no color-emoji font) — use inline SVG.
- Errors people see are plain and say what to do ("check the app-specific password in secrets.json").
- Private values never reach a log or the page: node helpers read `secrets.json`; the test harness fails a run if
  any `secrets.json` value appears in MagicMirror's output.
- Anything that touches hardware or the system (backlight, ddcutil, volume, restart, update, power) must honour
  `OPENSKY_DRY_RUN=1` — the test harness sets it so tests never touch the real screen.
- `tools/test-all.sh` must pass before a commit (see `docs/development/testing.md`).
- The maintainer also edits on GitHub: `git pull --rebase` before pushing; never force-push.
- Every provider (calendar, list, photo…) gets an on-screen scenario, not only a unit test: wiring between modules is where bugs hide (see tools/scenarios/google.js, holidays.js), plus a line in tools/test-config.js.

