/* MMM-OpenSky-Keyboard — an on-screen keyboard for the touchscreen (phone-style layout, no dependencies).
 * - Appears when a text box gets focus (not for date/time pickers, switches or sliders); hides when nothing typeable
 *   has focus any more (a popup closed, a button was tapped, the page changed) or on HIDE_KEYBOARD.
 * - Types into the focused box at the caret; keys never take the focus away from it.
 * - Shift = one capital letter (an empty box starts with a capital, like a phone); "123" = numbers and symbols.
 * - Return: a new line in a multi-line box, otherwise an Enter key press (the popup's main button reacts to it).
 * - body.kb-open while it's up, so popups move above it (styles in MMM-OpenSky-Keyboard.css).
 * Other modules may call showKeyboard() / hideKeyboard() (never show()/hide(): those are MagicMirror's own).
 */
Module.register("MMM-OpenSky-Keyboard", {
  defaults: {
    layout: "en"
  },

  LAYOUTS: {
    en: {
      letters: [["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"], ["a", "s", "d", "f", "g", "h", "j", "k", "l"], ["{shift}", "z", "x", "c", "v", "b", "n", "m", "{back}"], ["{numbers}", ",", "{space}", ".", "{enter}"]],
      numbers: [["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""], ["#", "%", "+", "=", "?", "!", "'", "*", "{back}"], ["{letters}", ",", "{space}", ".", "{enter}"]]
    },
    // German (QWERTZ with umlauts and ß); opensky.json → keyboard.layout "de", the default when locale.language is "de"
    de: {
      letters: [["q", "w", "e", "r", "t", "z", "u", "i", "o", "p", "ü"], ["a", "s", "d", "f", "g", "h", "j", "k", "l", "ö", "ä"], ["{shift}", "y", "x", "c", "v", "b", "n", "m", "ß", "{back}"], ["{numbers}", ",", "{space}", ".", "{enter}"]],
      numbers: [["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], ["-", "/", ":", ";", "(", ")", "€", "&", "@", "\""], ["#", "%", "+", "=", "?", "!", "'", "*", "{back}"], ["{letters}", ",", "{space}", ".", "{enter}"]]
    }
  },
  // (ß has no capital on a keyboard: "ß".toUpperCase() would be "SS")
  upper(k) { return k === "ß" ? k : k.toUpperCase(); },

  getScripts() { return ["modules/opensky-lib/client/i18n.js"]; },

  getStyles() { return ["MMM-OpenSky-Keyboard.css"]; },

  start() {
    this.shift = false;
    this.layer = "letters";
    this.target = null;
    document.addEventListener("focusin", (e) => { if (this.typeable(e.target)) this.showKeyboard(e.target); }, true);
    // nothing typeable focused any more → hide (checked after the focus settles)
    document.addEventListener("focusout", () => setTimeout(() => { if (!this.typeable(document.activeElement)) this.hideKeyboard(); }, 120), true);
    // While it's open, pressing a button (a popup's Add / Save / Cancel…) must not take the focus off the text box:
    // the keyboard would close and the popup slide back down while the finger is still on the screen, so the finger
    // was lifted somewhere else and the tap was lost (on touchscreens; Return worked). The button's click still runs.
    document.addEventListener("mousedown", (e) => {
      if (!this.target || !this.root || this.root.hidden || this.root.contains(e.target)) return;
      const b = e.target.closest && e.target.closest("button, [role=button], a[href], input[type=button], input[type=submit]");
      if (b) e.preventDefault();
    }, true);
    // a popup closing removes its focused text box without any focus event (Chromium) → watch for that while open
    this.watcher = new MutationObserver(() => { if (this.target && !this.target.isConnected) this.hideKeyboard(); });
  },

  getDom() { return document.createElement("div"); },   // the keyboard itself lives on <body>

  notificationReceived(n) {
    if (n === "HIDE_KEYBOARD" || n === "PAGE_CHANGED" || n === "OPENSKY_IDLE_RESET") this.hideKeyboard();
  },

  typeable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return ["text", "search", "email", "url", "tel", "password", ""].includes((el.getAttribute("type") || "").toLowerCase());
  },

  /* ---------------- building ---------------- */
  build() {
    if (this.root) return;
    this.root = document.createElement("div");
    this.root.className = "okb";
    this.root.hidden = true;
    // a key press must never move focus off the text box
    this.root.addEventListener("pointerdown", (e) => e.preventDefault());
    this.root.addEventListener("mousedown", (e) => e.preventDefault());
    this.root.addEventListener("click", (e) => {
      const k = e.target.closest(".okb-key");
      if (k) this.press(k.dataset.key);
    });
    document.body.appendChild(this.root);
    this.draw();
  },

  draw() {
    const rows = (this.LAYOUTS[this.config.layout] || this.LAYOUTS.en)[this.layer];
    const label = {
      "{shift}": `<svg viewBox="0 0 24 24"><path d="M12 4l8 8h-4.5v8h-7v-8H4z"/></svg>`,
      "{back}": `<svg viewBox="0 0 24 24"><path d="M9 5h11a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 20 19H9l-6.5-7z"/><path d="M12 9.5l5 5M17 9.5l-5 5"/></svg>`,
      "{numbers}": "123", "{letters}": "ABC", "{space}": osT("space"), "{enter}": osT("return")
    };
    this.root.innerHTML = `<div class="okb-rows">${rows.map((row) => `<div class="okb-row">${row.map((k) => {
      const special = k.startsWith("{");
      const text = special ? label[k] : (this.shift && this.layer === "letters" ? this.upper(k) : k);
      const cls = special ? ` okb-${k.slice(1, -1)}` : "";
      const on = k === "{shift}" && this.shift ? " on" : "";
      return `<button class="okb-key${cls}${on}" data-key="${k.replace(/"/g, "&quot;")}">${text}</button>`;
    }).join("")}</div>`).join("")}<button class="okb-key okb-hide" data-key="{hide}" aria-label="${osT("Hide keyboard")}"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></div>`;
  },

  /* ---------------- typing ---------------- */
  press(key) {
    const el = this.target;
    if (key === "{hide}") { if (el) el.blur(); this.hideKeyboard(); return; }
    if (key === "{shift}") { this.shift = !this.shift; this.draw(); return; }
    if (key === "{numbers}" || key === "{letters}") { this.layer = key === "{numbers}" ? "numbers" : "letters"; this.shift = false; this.draw(); return; }
    if (!el || !document.body.contains(el)) { this.hideKeyboard(); return; }
    if (key === "{enter}") {
      if (el.tagName === "TEXTAREA") this.insert(el, "\n");
      else {
        const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
      }
      return;
    }
    if (key === "{back}") { this.backspace(el); return; }
    let ch = key === "{space}" ? " " : key;
    if (this.shift && this.layer === "letters") ch = this.upper(ch);

    this.insert(el, ch);
    if (this.shift) { this.shift = false; this.draw(); }   // shift is for one letter
    if (this.layer === "numbers" && ch === " ") { this.layer = "letters"; this.draw(); }   // back to letters after a space
  },

  insert(el, text) {
    const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
    const max = el.maxLength > 0 ? el.maxLength : Infinity;
    if (el.value.length - (end - start) + text.length > max) return;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) { /* some types can't */ }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },

  backspace(el) {
    let start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (start === end && start > 0) start -= 1;
    el.value = el.value.slice(0, start) + el.value.slice(end);
    try { el.setSelectionRange(start, start); } catch (e) { /* ignore */ }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (!el.value && !this.shift && this.layer === "letters" && el.dataset.okbCaps !== "off") { this.shift = true; this.draw(); }
  },

  /* ---------------- public ---------------- */
  showKeyboard(el) {
    this.build();
    this.target = el && el.tagName ? el : (this.typeable(document.activeElement) ? document.activeElement : this.target);
    this.layer = this.target && /^(tel|number)$/i.test(this.target.getAttribute("type") || "") ? "numbers" : "letters";
    // an empty box starts with a capital letter (like a phone); data-okb-caps="off" turns that off
    this.shift = !!(this.target && !this.target.value && this.layer === "letters" && this.target.dataset.okbCaps !== "off");
    this.draw();
    this.root.hidden = false;
    document.body.classList.add("kb-open");
    this.watcher.observe(document.body, { childList: true, subtree: true });
  },

  hideKeyboard() {
    if (!this.root || this.root.hidden) return;
    this.root.hidden = true;
    this.target = null;
    this.watcher.disconnect();
    document.body.classList.remove("kb-open");
  }
});
