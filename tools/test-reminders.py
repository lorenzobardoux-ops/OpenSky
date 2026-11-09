#!/usr/bin/env python3
"""Apple Reminders lists (services/calendar-service/reminders.py) against a stand-in for iCloud — no Apple account.
Sign-in with a 2FA code, a session reused without any password, lists by name, add / check off / rename / delete,
a session Apple ended → "sign in again", and the password is never written anywhere.
Run: <venv>/bin/python tools/test-reminders.py   (the venv with the calendar service's requirements)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix="opensky-rem-")
os.environ["OPENSKY_SECRETS"] = os.path.join(tmp, "secrets.json")
os.environ["OPENSKY_SETTINGS"] = os.path.join(tmp, "opensky.json")
with open(os.environ["OPENSKY_SETTINGS"], "w") as f:
    json.dump({"locale": {"language": "en"}}, f)
sys.path.insert(0, os.path.join(HERE, "..", "services", "calendar-service"))
import reminders  # noqa: E402
from flask import Flask  # noqa: E402

passed = failed = 0


def ok(name, cond, info=""):
    global passed, failed
    passed, failed = passed + bool(cond), failed + (not cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name} {info}")


# ---- a stand-in for iCloud
class Item:
    def __init__(self, id, list_id, title):
        self.id, self.list_id, self.title = id, list_id, title
        self.completed, self.completed_date, self.deleted, self.parent_reminder_id = False, None, False, None


class Lst:
    def __init__(self, id, title):
        self.id, self.title, self.deleted, self.is_group = id, title, False, False


class Result:
    def __init__(self, items):
        self.reminders = items


class FakeReminders:
    def __init__(self):
        self.lists_ = [Lst("L1", "Einkauf"), Lst("L2", "Haushalt")]
        self.items = [Item("R1", "L1", "Milch"), Item("R2", "L1", "Brot"), Item("R3", "L2", "Staubsaugen")]
        self.items[1].completed = False
        self.ended = False

    def _guard(self):
        if self.ended:
            raise type("PyiCloudAuthRequiredException", (Exception,), {})()

    def lists(self):
        self._guard()
        return list(self.lists_)

    def list_reminders(self, list_id, include_completed=False, results_limit=200):
        self._guard()
        return Result([x for x in self.items if x.list_id == list_id and (include_completed or not x.completed) and not x.deleted])

    def create(self, list_id, title, **kw):
        self._guard()
        self.items.append(Item(f"R{len(self.items) + 1}", list_id, title))

    def update(self, item):
        self._guard()

    def delete(self, item):
        self._guard()
        item.deleted = True


FAKE = FakeReminders()
logins = []   # (apple_id, password) per new session object


class FakeService:
    def __init__(self, apple_id, password):
        logins.append((apple_id, password))
        self.trusted = os.path.exists(os.path.join(reminders.SESSION_DIR, "trusted"))
        if password is None and not self.trusted:
            raise type("PyiCloudFailedLoginException", (Exception,), {})("No password set")
        if password is not None and password != "right":
            raise type("PyiCloudFailedLoginException", (Exception,), {})("Invalid email/password combination.")
        self.requires_2fa = password is not None   # a fresh sign-in asks for the code
        self.requires_2sa = False
        self.two_factor_delivery_method = "trusted_device"
        self.is_trusted_session = self.trusted

    def request_2fa_code(self):
        return True

    def validate_2fa_code(self, code):
        if code != "123456":
            return False
        with open(os.path.join(reminders.SESSION_DIR, "trusted"), "w") as f:
            f.write("session")
        self.requires_2fa, self.is_trusted_session = False, True
        return True

    def trust_session(self):
        return True

    @property
    def reminders(self):
        return FAKE


reminders.make_service = FakeService
reminders.pyicloud_available = lambda: True
app = Flask(__name__)
app.register_blueprint(reminders.bp)
c = app.test_client()


def post(path, body):
    r = c.post(path, json=body)
    return r.status_code, r.get_json()


def get(path):
    r = c.get(path)
    return r.status_code, r.get_json()


st, d = get("/_reminders/items?list=Einkauf")
ok("1 not signed in yet: a plain message to sign in", st == 401 and d.get("signIn") and "sign in" in d["error"], d)
st, d = post("/_reminders/signin", {"appleId": "fam@example.com", "password": "wrong"})
ok("2 a wrong password: Apple didn't accept it", st == 401 and "didn't accept" in d["error"], d)
st, d = post("/_reminders/signin", {"appleId": "fam@example.com", "password": "right"})
ok("3 right password → asks for the 2FA code", st == 200 and d["state"] == "2fa", d)
st, d = post("/_reminders/code", {"code": "000000"})
ok("4 a wrong code: try again", st == 400 and "isn't right" in d["error"], d)
st, d = post("/_reminders/code", {"code": "123 456"})
ok("5 the right code (spaces allowed) → signed in", st == 200 and d["state"] == "ok", d)
st, d = get("/_reminders/status")
ok("6 status: signed in as that Apple ID", d["signedIn"] and d["appleId"] == "fam@example.com" and not d["pending2fa"], d)
st, d = get("/_reminders/lists")
ok("7 the account's lists", st == 200 and [l["title"] for l in d["lists"]] == ["Einkauf", "Haushalt"], d)
st, d = get("/_reminders/items?list=einkauf")
ok("8 a list by its name (any case): its open items", st == 200 and [x["text"] for x in d["items"]] == ["Milch", "Brot"], d)
post("/_reminders/add", {"list": "Einkauf", "text": "  Eier  "})
post("/_reminders/check", {"list": "Einkauf", "id": "R1"})
post("/_reminders/edit", {"list": "Einkauf", "id": "R2", "text": "Vollkornbrot"})
st, d = get("/_reminders/items?list=Einkauf")
ok("9 add, check off, rename — as in Apple Reminders", [x["text"] for x in d["items"]] == ["Vollkornbrot", "Eier"] and FAKE.items[0].completed and FAKE.items[0].completed_date is not None, d)
post("/_reminders/remove", {"list": "Einkauf", "id": "R4"})
st, d = get("/_reminders/items?list=Einkauf")
ok("10 delete", [x["text"] for x in d["items"]] == ["Vollkornbrot"] and FAKE.items[3].deleted, d)
st, d = post("/_reminders/add", {"list": "Einkauf", "text": "   "})
ok("11 an empty item: please type something", st == 400 and "type something" in d["error"], d)
st, d = get("/_reminders/items?list=Garten")
ok("12 a list that doesn't exist: says which", st == 404 and "Garten" in d["error"], d)

# the service restarts: the saved session is used — without any password
reminders._api = reminders._rem = None
logins.clear()
st, d = get("/_reminders/items?list=Haushalt")
ok("13 after a restart: the saved session, no password", st == 200 and logins == [("fam@example.com", None)] and d["items"][0]["text"] == "Staubsaugen", logins)
FAKE.ended = True
st, d = get("/_reminders/items?list=Haushalt")
ok("14 Apple ended the session → sign in again (from the phone)", st == 401 and d.get("signIn"), d)
FAKE.ended = False

secret_seen = []
for root, _, files in os.walk(tmp):
    for f in files:
        with open(os.path.join(root, f), errors="ignore") as fh:
            if "right" in fh.read():
                secret_seen.append(f)
ok("15 the password is written nowhere", not secret_seen, secret_seen)
mode = oct(os.stat(reminders.SESSION_DIR).st_mode & 0o777)
ok("16 the session folder is private (700)", mode == "0o700", mode)
st, d = post("/_reminders/signout", {})
ok("17 sign out: the session is gone", st == 200 and not os.path.exists(reminders.SESSION_DIR) and not get("/_reminders/status")[1]["signedIn"])
with open(os.environ["OPENSKY_SETTINGS"], "w") as f:
    json.dump({"locale": {"language": "de"}}, f)
st, d = get("/_reminders/items?list=Einkauf")
ok("18 messages in the screen's language", "Apple-Erinnerungen" in d["error"], d)

print(f"SUMMARY pass={passed} fail={failed}")
sys.exit(1 if failed else 0)
