#!/usr/bin/env python3
"""OpenSky calendar service — read and change CalDAV calendars (iCloud, Fastmail, Nextcloud, …) for the screen.

Runs on the Pi, listens on 127.0.0.1 only (never on the network). MagicMirror's node helpers call it:
  GET  /health
  GET  /<name>/calendar.ics      the whole calendar as one iCalendar feed (MMM-OpenSky-Calendars reads it)
  POST /<name>/create-event      {title, startDate, endDate, allDay?, description?}
  POST /<name>/update-event      {originalTitle, originalStart, title, startDate, endDate, allDay?, description?}
  POST /<name>/delete-event      {originalTitle, originalStart}
Timed events: ISO datetimes. All-day: allDay=true, YYYY-MM-DD dates with an INCLUSIVE end date.

Accounts live in config/secrets.json (re-read when it changes), one per calendar name used in opensky.json:
  "calendar": { "caldav": { "<name>": { "url": "https://caldav.icloud.com/", "username": "...",
                                         "password": "app-specific password", "calendar": "<calendar name on the server>" } } }
iCloud needs an app-specific password (appleid.apple.com → Sign-In and Security → App-Specific Passwords).

The last good feed of each calendar is kept on disk, so the screen still shows events after a reboot without internet.
Repeating events can't be changed here (the server's calendar app is the right place for that).
Apple Reminders lists (shared ones too) for the screen's Lists: reminders.py, under /_reminders/.

Based on the OpenSky reference build's iCloud backend.
"""
import json
import os
import sys
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import caldav
from flask import Flask, Response, jsonify, request
from icalendar import Calendar, Event as ICalEvent

MM_ROOT = os.environ.get("OPENSKY_MM") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SECRETS = os.environ.get("OPENSKY_SECRETS") or os.path.join(MM_ROOT, "config", "secrets.json")
CACHE_DIR = os.environ.get("OPENSKY_CALENDAR_CACHE") or os.path.join(MM_ROOT, "config", "calendar-cache")


def settings_port():
    """calendar.service.port from opensky.json (OPENSKY_SETTINGS), else 5747."""
    try:
        with open(os.environ.get("OPENSKY_SETTINGS") or os.path.join(MM_ROOT, "config", "opensky.json")) as f:
            return int(((json.load(f).get("calendar") or {}).get("service") or {}).get("port") or 5747)
    except (OSError, ValueError, TypeError, AttributeError):
        return 5747


PORT = int(os.environ.get("OPENSKY_CALENDAR_PORT") or settings_port())
DEFAULT_URL = "https://caldav.icloud.com/"


def local_tz():
    """The Pi's time zone (for all-day events and times without a zone)."""
    name = os.environ.get("TZ")
    if not name:
        try:
            name = os.path.realpath("/etc/localtime").split("zoneinfo/", 1)[1]
        except (IndexError, OSError):
            name = "UTC"
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo("UTC")


TZ = local_tz()
app = Flask(__name__)
# Apple Reminders lists (reminders.py: /_reminders/…; needs pyicloud, which install.sh puts in the venv)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reminders  # noqa: E402
app.register_blueprint(reminders.bp)
_lock = threading.Lock()
_accounts, _mtime, _calendars = {}, 0, {}


class UserError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def accounts():
    """CalDAV accounts from secrets.json (re-read after it changes)."""
    global _accounts, _mtime, _calendars
    try:
        m = os.stat(SECRETS).st_mtime
        if m != _mtime:
            with open(SECRETS) as f:
                _accounts = (json.load(f).get("calendar") or {}).get("caldav") or {}
            _mtime, _calendars = m, {}
    except FileNotFoundError:
        _accounts = {}
    except (OSError, ValueError) as e:
        print(f"can't read secrets.json: {e}", flush=True)
    return _accounts


def get_calendar(name, refresh=False):
    acc = accounts().get(name)
    if not acc or not acc.get("username") or not acc.get("password"):
        raise UserError(f'No CalDAV account for "{name}" in secrets.json (calendar.caldav.{name})', 404)
    with _lock:
        if refresh or name not in _calendars:
            client = caldav.DAVClient(url=acc.get("url") or DEFAULT_URL, username=acc["username"], password=acc["password"], timeout=20)
            want = acc.get("calendar") or name
            found = None
            for cal in client.principal().calendars():
                if cal.name == want:
                    found = cal
                    break
            if found is None:
                raise UserError(f'Calendar "{want}" not found in that account', 404)
            _calendars[name] = found
        return _calendars[name]


def with_calendar(name, fn):
    """Run fn(calendar); after a connection/auth hiccup reconnect once and retry."""
    try:
        try:
            return fn(get_calendar(name))
        except caldav.lib.error.AuthorizationError:
            raise
        except (caldav.lib.error.DAVError, ConnectionError, OSError):
            return fn(get_calendar(name, refresh=True))
    except caldav.lib.error.AuthorizationError:
        raise UserError(f'The account for "{name}" was refused — check the username and (app-specific) password in secrets.json', 401)


def parse_times(data):
    if data.get("allDay"):
        start = date.fromisoformat(str(data.get("startDate", ""))[:10])
        last = date.fromisoformat(str(data.get("endDate", ""))[:10])
        if last < start:
            raise UserError("End date must be on or after the start date")
        return start, last + timedelta(days=1)   # DTEND is exclusive for all-day events
    start = datetime.fromisoformat(str(data["startDate"]).replace("Z", "+00:00"))
    end = datetime.fromisoformat(str(data["endDate"]).replace("Z", "+00:00"))
    if end <= start:
        raise UserError("End time must be after start time")
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def set_times(component, dtstart, dtend):
    for key in ("dtstart", "dtend", "duration"):
        if key in component:
            del component[key]
    component.add("dtstart", dtstart)
    component.add("dtend", dtend)


def find_event(calendar, data):
    """The event shown on screen, by its original title + start (the month view has no UID)."""
    title = (data.get("originalTitle") or "").strip()
    start = data.get("originalStart")
    if not (title and start):
        return None, None
    want = datetime.fromisoformat(start.replace("Z", "+00:00"))
    for event in calendar.events():
        for comp in Calendar.from_ical(event.data).walk("VEVENT"):
            if str(comp.get("summary", "")).strip() != title:
                continue
            dt = comp.decoded("dtstart")
            if isinstance(dt, datetime):
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=TZ)
                if abs((dt - want).total_seconds()) < 60:
                    return event, comp
            elif dt == want.astimezone(TZ).date():
                return event, comp
    return None, None


def cache_file(name):
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
    return os.path.join(CACHE_DIR, f"{safe}.ics")


@app.before_request
def only_this_pi():
    """Only requests addressed to this Pi itself: a web page can't use DNS tricks (a name that points at 127.0.0.1)
    to read the family's calendars or change them from the screen's browser."""
    if request.host.rsplit(":", 1)[0].lower() not in ("127.0.0.1", "localhost", "[::1]"):
        return jsonify({"error": "Wrong address"}), 421


@app.errorhandler(UserError)
def user_error(e):
    return jsonify({"error": str(e)}), e.status


@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "opensky-calendar-service", "calendars": sorted(accounts().keys())})


@app.route("/<name>/calendar.ics")
def feed(name):
    def build(calendar):
        out = Calendar()
        out.add("prodid", "-//OpenSky//calendar-service//EN")
        out.add("version", "2.0")
        out.add("x-wr-calname", name)
        seen_tz = set()
        for event in calendar.events():
            for comp in Calendar.from_ical(event.data).subcomponents:
                if comp.name == "VTIMEZONE":
                    tzid = str(comp.get("tzid"))
                    if tzid in seen_tz:
                        continue
                    seen_tz.add(tzid)
                if comp.name in ("VEVENT", "VTIMEZONE"):
                    out.add_component(comp)
        return out.to_ical()
    try:
        ics = with_calendar(name, build)
    except Exception as e:
        print(f"[{name}] feed error: {e}", flush=True)
        try:
            with open(cache_file(name), "rb") as f:   # last good copy (also after a reboot without internet)
                return Response(f.read(), mimetype="text/calendar", headers={"X-Feed-Stale": "1"})
        except OSError:
            status = e.status if isinstance(e, UserError) else 502
            return Response(f"feed error: {e}", status=status, mimetype="text/plain")
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = cache_file(name) + ".tmp"
        with open(tmp, "wb") as f:
            f.write(ics)
        os.replace(tmp, cache_file(name))
    except OSError as e:
        print(f"[{name}] can't write the feed cache: {e}", flush=True)
    return Response(ics, mimetype="text/calendar")


@app.route("/<name>/create-event", methods=["POST"])
def create_event(name):
    data = request.get_json(silent=True) or {}
    if not str(data.get("title", "")).strip():
        raise UserError("Please add a title")
    if not (data.get("startDate") and data.get("endDate")):
        raise UserError("Please pick a start and end")
    dtstart, dtend = parse_times(data)
    cal = Calendar()
    cal.add("prodid", "-//OpenSky//calendar-service//EN")
    cal.add("version", "2.0")
    ev = ICalEvent()
    ev.add("uid", str(uuid.uuid4()))
    ev.add("summary", str(data["title"]).strip())
    ev.add("dtstamp", datetime.now(timezone.utc))
    set_times(ev, dtstart, dtend)
    if data.get("description"):
        ev.add("description", data["description"])
    cal.add_component(ev)
    try:
        with_calendar(name, lambda c: c.save_event(cal.to_ical().decode()))
    except UserError:
        raise
    except Exception as e:
        print(f"[{name}] create failed: {e}", flush=True)
        return jsonify({"error": f"Could not save to the calendar: {e}"}), 502
    return jsonify({"success": True})


@app.route("/<name>/update-event", methods=["POST"])
def update_event(name):
    data = request.get_json(silent=True) or {}
    if not (data.get("startDate") and data.get("endDate")):
        raise UserError("Please pick a start and end")
    dtstart, dtend = parse_times(data)

    def do(calendar):
        target, _ = find_event(calendar, data)
        if not target:
            raise UserError("Event not found (it may have been changed elsewhere)", 404)
        ical = Calendar.from_ical(target.data)
        for comp in ical.walk("VEVENT"):
            if "rrule" in comp:
                raise UserError("Repeating events can only be changed in your calendar app", 409)
            if data.get("title"):
                comp["summary"] = str(data["title"]).strip()
            set_times(comp, dtstart, dtend)
            if "description" in data:
                comp["description"] = data.get("description", "")
            comp["last-modified"] = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target.data = ical.to_ical().decode()
        target.save()
    try:
        with_calendar(name, do)
    except UserError:
        raise
    except Exception as e:
        print(f"[{name}] update failed: {e}", flush=True)
        return jsonify({"error": f"Could not update the calendar: {e}"}), 502
    return jsonify({"success": True})


@app.route("/<name>/delete-event", methods=["POST"])
def delete_event(name):
    data = request.get_json(silent=True) or {}

    def do(calendar):
        target, _ = find_event(calendar, data)
        if not target:
            raise UserError("Event not found (it may have been changed elsewhere)", 404)
        # the whole resource goes, so look at all of it: a moved occurrence (RECURRENCE-ID) lives with its series
        if any("rrule" in c or "recurrence-id" in c for c in Calendar.from_ical(target.data).walk("VEVENT")):
            raise UserError("Repeating events can only be deleted in your calendar app", 409)
        target.delete()
    try:
        with_calendar(name, do)
    except UserError:
        raise
    except Exception as e:
        print(f"[{name}] delete failed: {e}", flush=True)
        return jsonify({"error": f"Could not delete from the calendar: {e}"}), 502
    return jsonify({"success": True})


if __name__ == "__main__":
    print(f"OpenSky calendar service on 127.0.0.1:{PORT} — accounts: {', '.join(sorted(accounts())) or 'none yet'} (time zone {TZ})", flush=True)
    # localhost only; never the Werkzeug debugger (it allows remote code execution)
    import socket
    probe = socket.socket()
    try:
        probe.bind(("127.0.0.1", PORT))
    except OSError:
        print(f"Port {PORT} is already used by another program on this Pi. Pick another one in opensky.json → "
              f'"calendar": {{ "service": {{ "port": 5748 }} }}, then: opensky restart', flush=True)
        sys.exit(1)
    finally:
        probe.close()
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
    sys.exit(0)
