/* OpenSky Google Calendar (server side) — read AND change Google calendars through the Google Calendar API.
 *
 * Sign-in is the usual MagicMirror way (as MMM-GoogleCalendar does it), just guided from the phone setup page:
 *   1. the family makes their own Google Cloud project with a "Desktop app" OAuth client (docs/google-calendar.md);
 *   2. phone setup: paste its Client ID + secret → "Sign in with Google" (authUrl, PKCE) → Google sends the browser to
 *      http://127.0.0.1:53682/?code=… (a page that doesn't load — that's expected) → paste that address back
 *      (finishSignIn) → the refresh token is saved in secrets.json → google.
 *   (Google's TV-style "enter a code" sign-in doesn't allow calendar access, and Google blocks sign-in inside embedded
 *   browsers like the screen's, so the phone's own browser does it.)
 * Scopes: see the calendar list + view and edit events — nothing else.
 *
 * secrets.json → google: { clientId, clientSecret, refreshToken }   (one Google account, any number of its calendars)
 * Calendar sources (opensky.json): { name, type: "google", calendarId: "primary" | "<id>@group.calendar.google.com" }
 */
const crypto = require("crypto");
const path = require("path");
const { secret } = require(path.join(__dirname, "secrets.js"));
const { osT } = require("./client/i18n.js");   // texts in opensky.json's language

const AUTH = process.env.OPENSKY_GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = process.env.OPENSKY_GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const API = process.env.OPENSKY_GOOGLE_API_URL || "https://www.googleapis.com/calendar/v3";
const REDIRECT = "http://127.0.0.1:53682/";
const SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"];

class GoogleError extends Error { constructor(m, status) { super(m); this.status = status; } }

/* ---------------- sign-in ---------------- */
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Start a sign-in: the address to open, plus what finishSignIn needs back (keep it on the Pi). */
function authUrl(clientId) {
  if (!/\.apps\.googleusercontent\.com$/.test(String(clientId || ""))) throw new GoogleError(osT("That doesn't look like a Google Client ID (it ends in .apps.googleusercontent.com)"), 400);
  const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(16));
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", state,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256"
  });
  return { url: `${AUTH}?${q}`, state, verifier };
}

/** Finish a sign-in from the pasted address (or just the code). Returns { refreshToken }. */
async function finishSignIn(pasted, pending, clientId, clientSecret) {
  if (!pending) throw new GoogleError(osT("Tap \"Sign in with Google\" first"), 400);
  let code = String(pasted || "").trim(), state = null;
  if (/^https?:\/\//.test(code)) {
    const u = new URL(code);
    if (u.searchParams.get("error")) throw new GoogleError(u.searchParams.get("error") === "access_denied" ? osT("Google sign-in was cancelled — try again, and allow both permissions") : osT("Google said: {error}", { error: u.searchParams.get("error") }), 400);
    code = u.searchParams.get("code") || ""; state = u.searchParams.get("state");
  }
  if (!code) throw new GoogleError(osT("Paste the whole address from your browser — it contains \"code=\""), 400);
  if (state && state !== pending.state) throw new GoogleError(osT("That address is from an older sign-in — tap Sign in with Google again"), 400);
  const d = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, client_secret: clientSecret, code_verifier: pending.verifier });
  if (!d.refresh_token) throw new GoogleError(osT("Google didn't give a lasting sign-in — remove OpenSky's access at myaccount.google.com/permissions and sign in again"), 400);
  cache = { token: d.access_token, until: Date.now() + (d.expires_in || 3000) * 1000 - 60000, key: d.refresh_token };
  return { refreshToken: d.refresh_token };
}

async function tokenRequest(form) {
  let r;
  try { r = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new GoogleError(osT("Can't reach Google. Check the internet and try again."), 502); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (d.error === "invalid_grant") throw new GoogleError(osT("The Google sign-in has expired — sign in again from phone setup (and set your Google app to \"In production\" so it lasts; see docs/google-calendar.md)"), 401);
    if (d.error === "invalid_client" || d.error === "unauthorized_client") throw new GoogleError(osT("Google didn't accept the Client ID / secret — check them in phone setup"), 401);
    throw new GoogleError(osT("Google sign-in failed ({error})", { error: d.error || r.status })
, 502);
  }
  return d;
}

/* ---------------- API calls ---------------- */
let cache = { token: null, until: 0, key: null };

async function accessToken() {
  const refreshToken = secret("google.refreshToken"), clientId = secret("google.clientId"), clientSecret = secret("google.clientSecret");
  if (!refreshToken || !clientId) throw new GoogleError(osT("Google Calendar isn't signed in yet — use phone setup → Calendars → Google"), 401);
  if (cache.token && cache.key === refreshToken && Date.now() < cache.until) return cache.token;
  const d = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret || "" });
  cache = { token: d.access_token, until: Date.now() + (d.expires_in || 3000) * 1000 - 60000, key: refreshToken };
  return cache.token;
}

async function api(method, url, body, retried) {
  const token = await accessToken();
  let r;
  try {
    r = await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) { throw new GoogleError(osT("Can't reach Google Calendar. Check the internet and try again."), 502); }
  if (r.status === 401 && !retried) { cache.until = 0; return api(method, url, body, true); }   // token went stale early
  if (r.status === 204) return null;
  const d = await r.json().catch(() => ({}));
  if (r.status === 403) throw new GoogleError(/insufficient|scope/i.test(JSON.stringify(d)) ? osT("Google Calendar access wasn't fully allowed — sign in again and tick both permissions") : osT("Google refused that (is the Calendar API enabled in your Google Cloud project?)"), 403);

  if (r.status === 404) throw new GoogleError(osT("That calendar or event wasn't found in Google (it may have just been changed)"), 404);
  if (!r.ok) throw new GoogleError(osT("Google Calendar error ({error})", { error: (d.error && d.error.message) || r.status })
, 502);
  return d;
}

async function listCalendars() {
  const out = [];
  let pageToken = null;
  do {
    const d = await api("GET", `/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    out.push(...(d.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary, canEdit: ["owner", "writer"].includes(c.accessRole), color: c.backgroundColor || null })));
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}

const cal = (id) => `/calendars/${encodeURIComponent(id || "primary")}`;

// a Google event → MagicMirror's calendar event (what CALENDAR_EVENTS carries)
function toMM(e) {
  const allDay = !!(e.start && e.start.date);
  const ms = (x) => allDay ? (() => { const [y, m, d] = x.date.split("-").map(Number); return new Date(y, m - 1, d).getTime(); })() : new Date(x.dateTime).getTime();
  const start = ms(e.start), end = e.end ? ms(e.end) : start;
  return { title: e.summary || "(no title)", startDate: String(start), endDate: String(end), fullDayEvent: allDay, recurringEvent: !!e.recurringEventId,
    class: "PUBLIC", firstYear: new Date(start).getFullYear(), location: e.location || false, geo: false, description: e.description || false };
}

/** Events between two dates (repeating ones expanded). */
async function events(calendarId, from, to) {
  const out = [];
  let pageToken = null, pages = 0;
  do {
    const q = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", maxResults: "2500", timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString() });
    if (pageToken) q.set("pageToken", pageToken);
    const d = await api("GET", `${cal(calendarId)}/events?${q}`);
    out.push(...(d.items || []).filter((e) => e.status !== "cancelled" && e.start));
    pageToken = d.nextPageToken;
  } while (pageToken && ++pages < 10);
  return out;
}

async function mmEvents(calendarId, from, to) { return (await events(calendarId, from, to)).map(toMM); }

/* ---------------- changes (the event editor) ---------------- */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function body(data) {
  const title = String(data.title || "").trim();
  if (!title) throw new GoogleError(osT("Please add a title"), 400);
  const b = { summary: title };
  if ("description" in data) b.description = String(data.description || "");
  if (data.allDay) {
    const s = String(data.startDate || "").slice(0, 10), e = String(data.endDate || "").slice(0, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(s) || !/^\d{4}-\d\d-\d\d$/.test(e) || e < s) throw new GoogleError(osT("Please pick a start and end date"), 400);
    const [y, m, d] = e.split("-").map(Number);
    b.start = { date: s }; b.end = { date: ymd(new Date(y, m - 1, d + 1)) };   // Google's all-day end is exclusive
  } else {
    const s = new Date(data.startDate), e = new Date(data.endDate);
    if (isNaN(s) || isNaN(e)) throw new GoogleError(osT("Please pick a start and end time"), 400);
    if (e <= s) throw new GoogleError(osT("End time must be after start time"), 400);
    b.start = { dateTime: s.toISOString() }; b.end = { dateTime: e.toISOString() };
  }
  return b;
}

// the event on screen, by its original title + start (what the month view knows)
async function find(calendarId, ref) {
  const raw = ref.originalStart, want = /^\d+$/.test(String(raw)) ? Number(raw) : new Date(raw).getTime(), title = String(ref.originalTitle || "").trim();
  if (!title || isNaN(want)) throw new GoogleError(osT("Which event?"), 400);
  const around = await events(calendarId, want - 36 * 3600e3, want + 36 * 3600e3);
  const hit = around.find((e) => (e.summary || "").trim() === title && Math.abs(Number(toMM(e).startDate) - want) < 60000);
  if (!hit) throw new GoogleError(osT("Event not found (it may have just been changed in Google Calendar)"), 404);
  if (hit.recurringEventId) throw new GoogleError(osT("Repeating events can only be changed in Google Calendar"), 409);
  return hit;
}

async function create(calendarId, data) { await api("POST", `${cal(calendarId)}/events`, body(data)); }
async function update(calendarId, ref, data) { const e = await find(calendarId, ref); await api("PATCH", `${cal(calendarId)}/events/${encodeURIComponent(e.id)}`, body(data)); }
async function remove(calendarId, ref) { const e = await find(calendarId, ref); await api("DELETE", `${cal(calendarId)}/events/${encodeURIComponent(e.id)}`); }

module.exports = { authUrl, finishSignIn, listCalendars, mmEvents, create, update, remove, GoogleError, REDIRECT, SCOPES };
