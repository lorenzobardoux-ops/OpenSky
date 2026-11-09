"""OpenSky Apple Reminders — lists from iCloud Reminders (also ones shared with family) for the screen's Lists.

Part of the calendar service (127.0.0.1 only). Uses pyicloud's CloudKit Reminders service: Apple has no official
Reminders API for other devices, and CalDAV doesn't see today's (shared) reminder lists. It's an unofficial way in,
so Apple can change it; when it breaks only these lists stop, with a message on the screen.

Sign-in (from the phone page, through MMM-OpenSky-Setup's node helper):
  GET  /_reminders/status                → {available, signedIn, appleId, pending2fa}
  POST /_reminders/signin {appleId, password} → {state: "ok" | "2fa"}   (the password is only used for this sign-in:
                                                                         never written anywhere)
  POST /_reminders/code   {code}           → {state: "ok"}               (the 6-digit code Apple shows on your devices)
  POST /_reminders/signout                 → {state: "signed-out"}
After the code, Apple trusts this Pi's session (kept in config/icloud-session/, like a browser's "trust this
browser"); when Apple ends it (about every two months) the list says to sign in again from the phone.

The lists (MMM-OpenSky-Lists' node helper, lib/lists.js provider "icloud"):
  GET  /_reminders/lists                         → {lists: [{id, title}]}
  GET  /_reminders/items?list=<title or id>      → {items: [{id, text}]}   open reminders, oldest first
  POST /_reminders/add    {list, text}
  POST /_reminders/check  {list, id}             → done (completed in Apple Reminders too)
  POST /_reminders/edit   {list, id, text}
  POST /_reminders/remove {list, id}             → deleted in Apple Reminders
Only lists of the signed-in Apple ID are seen — also those it shares with others. A list someone else created and
shares with you lives in their account, so it isn't among them (Apple doesn't hand those to this way in).
"""
import json
import os
import shutil
import threading
import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

bp = Blueprint("reminders", __name__)

SECRETS = os.environ.get("OPENSKY_SECRETS") or os.path.join(
    os.environ.get("OPENSKY_MM") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")), "config", "secrets.json")
SESSION_DIR = os.environ.get("OPENSKY_ICLOUD_SESSION") or os.path.join(os.path.dirname(SECRETS), "icloud-session")
ACCOUNT_FILE = os.path.join(SESSION_DIR, "account.json")
# (pyicloud asks the system keyring for a password when none is given; this Pi never keeps it there)
os.environ.setdefault("PYTHON_KEYRING_BACKEND", "keyring.backends.null.Keyring")


def make_service(apple_id, password):
    """A signed-in pyicloud session (the tests replace this)."""
    from pyicloud import PyiCloudService
    return PyiCloudService(apple_id, password, cookie_directory=SESSION_DIR)


def pyicloud_available():
    try:
        import pyicloud  # noqa: F401
        return True
    except ImportError:
        return False


class RemindersError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


SIGN_IN_AGAIN = ("Apple Reminders: the sign-in has ended — sign in again in Settings → Set up from your phone → Lists",
                 "Apple-Erinnerungen: Die Anmeldung ist abgelaufen – melde dich unter Einstellungen → Mit dem Handy einrichten → Listen neu an")


def german():
    try:
        with open(os.environ.get("OPENSKY_SETTINGS") or os.path.join(os.path.dirname(SECRETS), "opensky.json")) as f:
            return str(((json.load(f).get("locale") or {}).get("language")) or "").lower().startswith("de")
    except (OSError, ValueError, AttributeError):
        return False


def say(pair):
    """(English, German) → in opensky.json's language"""
    return pair[1] if german() else pair[0]


_lock = threading.RLock()
_api = None            # the signed-in session
_rem = None            # its Reminders service (asking for it costs a request to Apple)
_pending = None        # (service, until): signed in, waiting for the 2FA code
_lists_cache = (0, [])


def account():
    try:
        with open(ACCOUNT_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_account(apple_id):
    os.makedirs(SESSION_DIR, mode=0o700, exist_ok=True)
    tmp = ACCOUNT_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"appleId": apple_id, "since": int(time.time())}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ACCOUNT_FILE)


def service():
    """The Reminders service of the signed-in account (from the saved session — no password)."""
    global _api, _rem
    with _lock:
        if _rem is not None:
            return _rem
        if _api is None:
            apple_id = account().get("appleId")
            if not apple_id:
                raise RemindersError(say(("Apple Reminders isn't signed in yet — sign in in Settings → Set up from your phone → Lists",
                                          "Apple-Erinnerungen ist noch nicht angemeldet – melde dich unter Einstellungen → Mit dem Handy einrichten → Listen an")), 401)
            try:
                # no password: only the saved session. (pyicloud then stops before asking Apple at all, so a session
                # that ended can never count as a wrong password and lock the Apple ID.)
                api = make_service(apple_id, None)
            except Exception:
                raise RemindersError(say(SIGN_IN_AGAIN), 401)
            if getattr(api, "requires_2fa", False) or getattr(api, "requires_2sa", False):
                raise RemindersError(say(SIGN_IN_AGAIN), 401)
            _api = api
        try:
            _rem = _api.reminders
            return _rem
        except Exception as e:
            _api = None
            raise RemindersError(say(SIGN_IN_AGAIN) if "auth" in type(e).__name__.lower() or "login" in type(e).__name__.lower()
                                 else say(("Couldn't reach Apple Reminders ({error})", "Apple-Erinnerungen nicht erreichbar ({error})")).format(error=type(e).__name__), 502)


def call(fn):
    """Run a Reminders call; a session Apple has ended → sign in again (and forget the session object)."""
    global _api, _rem
    with _lock:
        try:
            return fn(service())
        except RemindersError:
            raise
        except Exception as e:
            name = type(e).__name__
            if any(k in name for k in ("Auth", "Login", "2FA", "2SA")):
                _api = _rem = None
                raise RemindersError(say(SIGN_IN_AGAIN), 401)
            raise RemindersError(say(("Apple Reminders didn't answer ({error}) — try again in a minute",
                                      "Apple-Erinnerungen hat nicht geantwortet ({error}) – versuch es in einer Minute noch einmal")).format(error=name), 502)


def all_lists(fresh=False):
    global _lists_cache
    if not fresh and time.time() - _lists_cache[0] < 60:
        return _lists_cache[1]
    lists = call(lambda r: [{"id": l.id, "title": l.title} for l in r.lists() if not getattr(l, "deleted", False) and not getattr(l, "is_group", False)])
    _lists_cache = (time.time(), lists)
    return lists


def find_list(name_or_id):
    want = str(name_or_id or "").strip()
    for fresh in (False, True):
        for l in all_lists(fresh):
            if l["id"] == want or l["title"].strip().lower() == want.lower():
                return l
    raise RemindersError(say(('There\'s no Apple Reminders list "{name}" — check its name in phone setup',
                              'Es gibt keine Apple-Erinnerungsliste „{name}“ – prüf den Namen in der Handy-Einrichtung')).format(name=want), 404)


def open_items(list_id):
    res = call(lambda r: r.list_reminders(list_id=list_id, include_completed=False, results_limit=200))
    items = [x for x in res.reminders if not x.completed and not x.deleted and not x.parent_reminder_id]
    return items


def find_item(list_id, item_id):
    for x in open_items(list_id):
        if x.id == item_id:
            return x
    raise RemindersError(say(("That item is gone (it may have just been changed)",
                              "Dieser Eintrag ist weg (vielleicht wurde er gerade geändert)")), 404)


def clean(text):
    t = " ".join(str(text or "").split())
    if not t:
        raise RemindersError(say(("Please type something first", "Bitte gib zuerst etwas ein")))
    if len(t) > 500:
        raise RemindersError(say(("That's a bit long — keep it under 500 characters", "Das ist etwas lang – bitte unter 500 Zeichen")))
    return t


@bp.errorhandler(RemindersError)
def reminders_error(e):
    return jsonify(error=str(e), signIn=e.status == 401), e.status


@bp.before_request
def need_pyicloud():
    if request.path.endswith("/status"):
        return None
    if not pyicloud_available():
        return jsonify(error=say(("Apple Reminders needs an update of OpenSky's helper — run ./install.sh on the Pi",
                                  "Apple-Erinnerungen braucht ein Update des Helfers – führ ./install.sh auf dem Pi aus"))), 503
    return None


@bp.route("/_reminders/status")
def status():
    acc = account()
    with _lock:
        pending = bool(_pending and _pending[1] > time.time())
    return jsonify(available=pyicloud_available(), signedIn=bool(acc.get("appleId")), appleId=acc.get("appleId") or "", pending2fa=pending)


@bp.route("/_reminders/signin", methods=["POST"])
def signin():
    global _api, _rem, _pending, _lists_cache
    data = request.get_json(silent=True) or {}
    apple_id, password = str(data.get("appleId") or "").strip(), str(data.get("password") or "")
    if not apple_id or not password:
        raise RemindersError(say(("Please type your Apple ID and password", "Bitte gib Apple-ID und Passwort ein")))
    with _lock:
        # a new sign-in starts from scratch (another Apple ID, or a session Apple ended)
        _api, _rem, _pending, _lists_cache = None, None, None, (0, [])
        shutil.rmtree(SESSION_DIR, ignore_errors=True)
        os.makedirs(SESSION_DIR, mode=0o700, exist_ok=True)
        try:
            api = make_service(apple_id, password)
        except Exception as e:
            name = type(e).__name__
            if "Locked" in name:
                raise RemindersError(say(("Apple has locked this Apple ID for now — unlock it at iforgot.apple.com",
                                          "Apple hat diese Apple-ID vorübergehend gesperrt – entsperre sie unter iforgot.apple.com")), 403)
            if "Login" in name or "Password" in name:
                raise RemindersError(say(("Apple didn't accept the Apple ID or password", "Apple hat Apple-ID oder Passwort nicht angenommen")), 401)
            raise RemindersError(say(("Couldn't reach Apple ({error}) — try again in a minute",
                                      "Apple ist nicht erreichbar ({error}) – versuch es in einer Minute noch einmal")).format(error=name), 502)
        if getattr(api, "requires_2fa", False) or getattr(api, "requires_2sa", False):
            try:
                if not api.request_2fa_code():
                    raise RemindersError(say(("This Apple ID signs in with a security key — that isn't supported here",
                                              "Diese Apple-ID meldet sich mit einem Sicherheitsschlüssel an – das geht hier nicht")))
            except RemindersError:
                raise
            except Exception:
                # Apple may already show a code on your devices: it can still be typed in
                try:
                    api.use_existing_trusted_device_code()
                except Exception:
                    pass
            _pending = (api, time.time() + 10 * 60)
            save_account(apple_id)
            return jsonify(state="2fa", sms=getattr(api, "two_factor_delivery_method", "") == "sms")
        _api, _rem = api, None
        save_account(apple_id)
        return jsonify(state="ok")



@bp.route("/_reminders/code", methods=["POST"])
def code():
    global _api, _rem, _pending
    c = "".join(ch for ch in str((request.get_json(silent=True) or {}).get("code") or "") if ch.isdigit())
    with _lock:
        if not _pending or _pending[1] < time.time():
            _pending = None
            raise RemindersError(say(("That sign-in has timed out — sign in again", "Diese Anmeldung ist abgelaufen – melde dich neu an")))
        api = _pending[0]
        if len(c) != 6:
            raise RemindersError(say(("The code has 6 digits", "Der Code hat 6 Ziffern")))
        try:
            ok = api.validate_2fa_code(c)
        except Exception as e:
            raise RemindersError(say(("Apple didn't take the code ({error})", "Apple hat den Code nicht angenommen ({error})")).format(error=type(e).__name__), 400)
        if not ok:
            raise RemindersError(say(("That code isn't right — check it and try again", "Der Code stimmt nicht – prüf ihn und versuch es noch einmal")))
        if not getattr(api, "is_trusted_session", True):
            try:
                api.trust_session()
            except Exception:
                pass
        _api, _rem, _pending = api, None, None
        return jsonify(state="ok")


@bp.route("/_reminders/signout", methods=["POST"])
def signout():
    global _api, _rem, _pending, _lists_cache
    with _lock:
        _api, _rem, _pending, _lists_cache = None, None, None, (0, [])
        shutil.rmtree(SESSION_DIR, ignore_errors=True)
    return jsonify(state="signed-out")


@bp.route("/_reminders/lists")
def lists():
    return jsonify(lists=all_lists(fresh=True))


@bp.route("/_reminders/items")
def items():
    l = find_list(request.args.get("list"))
    return jsonify(items=[{"id": x.id, "text": x.title} for x in open_items(l["id"])])


@bp.route("/_reminders/add", methods=["POST"])
def add():
    d = request.get_json(silent=True) or {}
    l, text = find_list(d.get("list")), clean(d.get("text"))
    call(lambda r: r.create(list_id=l["id"], title=text))
    return jsonify(ok=True)


def change(fn):
    d = request.get_json(silent=True) or {}
    l = find_list(d.get("list"))
    item = find_item(l["id"], str(d.get("id") or ""))
    call(lambda r: fn(r, item, d))
    return jsonify(ok=True)


@bp.route("/_reminders/check", methods=["POST"])
def check():
    def done(r, item, d):
        item.completed = True
        item.completed_date = datetime.now(timezone.utc)
        r.update(item)
    return change(done)


@bp.route("/_reminders/edit", methods=["POST"])
def edit():
    def rename(r, item, d):
        item.title = clean(d.get("text"))
        r.update(item)
    return change(rename)


@bp.route("/_reminders/remove", methods=["POST"])
def remove():
    return change(lambda r, item, d: r.delete(item))
