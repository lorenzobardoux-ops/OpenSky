/* MMM-OpenSky-Timer (from the OpenSky reference build's MMM-Timer)
 * Kitchen timers with circular progress rings (up to 2 at once).
 * - Counts against real end times, so timers survive a page reload (localStorage).
 * - When a timer finishes, a chime plays through the Pi's own audio output
 *   (Web Audio, no sound files) until someone taps Stop, and a banner with a
 *   Stop button appears on every page. A sleeping screen wakes up (OPENSKY_WAKE).
 */
Module.register("MMM-OpenSky-Timer", {
  defaults: {
    maxTimers: 2,
    maxDuration: 24 * 60 * 60, // seconds
    quickAddButtons: [
      { label: "+5 min", seconds: 5 * 60 },
      { label: "+10 min", seconds: 10 * 60 },
      { label: "+15 min", seconds: 15 * 60 },
      { label: "+30 min", seconds: 30 * 60 },
      { label: "+45 min", seconds: 45 * 60 },
      { label: "+1 hr", seconds: 60 * 60 }
    ],
    alarm: {
      volume: 0.6,            // 0..1
      repeatEverySeconds: 2.5,
      maxRingSeconds: 180     // stop ringing on its own after 3 minutes
    }
  },

  STORAGE_KEY: "MMM-OpenSky-Timer.timers",

  getScripts() { return ["modules/opensky-lib/client/i18n.js"]; },

  getStyles() {
    return ["MMM-OpenSky-Timer.css"];
  },

  start() {
    this.timers = this.loadTimers(); // [{ id, total, endAt, pausedRemaining, completed }]
    this.tick = null;
    this.ringTimer = null;
    this.ringStartedAt = 0;
    if (this.timers.length) this.startTicking();

    // If another window/instance changes the timers (e.g. Stop pressed there), follow it
    window.addEventListener("storage", (e) => {
      if (e.key !== this.STORAGE_KEY) return;
      this.timers = this.loadTimers();
      if (!this.timers.some((t) => t.completed)) this.stopRinging();
      if (this.timers.length) this.startTicking(); else this.stopTicking();
      this.renderBanner();
      this.updateDom(0);
    });
  },

  suspend() {
    this.sendNotification("HIDE_KEYBOARD");
  },

  /* ---------------- state ---------------- */

  remaining(timer) {
    if (timer.completed) return 0;
    if (timer.pausedRemaining != null) return timer.pausedRemaining;
    return Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
  },

  saveTimers() {
    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.timers)); } catch (e) { /* storage unavailable */ }
  },

  loadTimers() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "[]");
      return Array.isArray(saved) ? saved.slice(0, this.config.maxTimers) : [];
    } catch (e) {
      return [];
    }
  },

  addTimer(seconds) {
    if (this.timers.length >= this.config.maxTimers) return;
    seconds = Math.min(seconds, this.config.maxDuration);
    this.unlockAudio();
    this.sendNotification("HIDE_KEYBOARD");
    this.timers.push({ id: Date.now(), total: seconds, endAt: Date.now() + seconds * 1000, pausedRemaining: null, completed: false });
    this.saveTimers();
    this.startTicking();
    this.updateDom(0);
  },

  quickAdd(seconds) {
    this.unlockAudio();
    this.sendNotification("HIDE_KEYBOARD");
    // Add to the first running timer, otherwise start a new one
    const running = this.timers.find((t) => !t.completed && t.pausedRemaining == null);
    if (running) {
      running.endAt += seconds * 1000;
      running.total += seconds;
      this.saveTimers();
      this.updateDom(0);
    } else {
      this.addTimer(seconds);
    }
  },

  removeTimer(index) {
    this.timers.splice(index, 1);
    this.saveTimers();
    if (!this.timers.some((t) => t.completed)) this.stopRinging();
    if (!this.timers.length) this.stopTicking();
    this.updateDom(0);
  },

  togglePause(index) {
    const t = this.timers[index];
    if (t.completed) return;
    if (t.pausedRemaining == null) {
      t.pausedRemaining = this.remaining(t);
    } else {
      t.endAt = Date.now() + t.pausedRemaining * 1000;
      t.pausedRemaining = null;
    }
    this.saveTimers();
    this.updateDom(0);
  },

  startTicking() {
    if (this.tick) return;
    this.tick = setInterval(() => this.onTick(), 1000);
    this.onTick();
  },

  stopTicking() {
    clearInterval(this.tick);
    this.tick = null;
  },

  onTick() {
    let justFinished = false;
    this.timers.forEach((t) => {
      if (!t.completed && t.pausedRemaining == null && this.remaining(t) <= 0) {
        t.completed = true;
        justFinished = true;
      }
    });
    if (justFinished) {
      this.saveTimers();
      this.startRinging();
    }
    this.renderBanner();
    this.updateDom(0);
  },

  /* ---------------- sound ---------------- */

  // Create/resume the audio context during a tap so playback is allowed later
  unlockAudio() {
    try {
      if (!this.audio) this.audio = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audio.state === "suspended") this.audio.resume();
    } catch (e) {
      Log.warn(`${this.name}: audio unavailable: ${e}`);
    }
  },

  // Settings → Sound → "Test" plays the same chime
  notificationReceived(notification) {
    if (notification === "TIMER_TEST_CHIME") this.playChime();
  },

  // Three soft bell tones, rising
  playChime() {
    this.unlockAudio();
    const ctx = this.audio;
    if (!ctx) return;
    const now = ctx.currentTime;
    [880, 1109, 1319].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.22;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(this.config.alarm.volume, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.95);
    });
  },

  startRinging() {
    if (this.ringTimer) return;
    this.sendNotification("OPENSKY_WAKE");   // a sleeping screen wakes so the Stop button is right there
    this.ringStartedAt = Date.now();
    this.playChime();
    this.ringTimer = setInterval(() => {
      if (Date.now() - this.ringStartedAt > this.config.alarm.maxRingSeconds * 1000) {
        this.stopRinging();
        return;
      }
      this.playChime();
    }, this.config.alarm.repeatEverySeconds * 1000);
  },

  stopRinging() {
    clearInterval(this.ringTimer);
    this.ringTimer = null;
  },

  // Stop button in the banner / on a finished timer: silence and clear finished timers
  dismissFinished() {
    this.stopRinging();
    if (this.banner) this.banner.hidden = true;
    this.timers = this.timers.filter((t) => !t.completed);
    this.saveTimers();
    if (!this.timers.length) this.stopTicking();
    this.renderBanner();
    this.updateDom(0);
  },

  // "Timer finished" banner on <body>, so it shows on every page
  renderBanner() {
    const finished = this.timers.some((t) => t.completed);
    if (!finished) {
      if (this.banner) this.banner.hidden = true;
      return;
    }
    if (!this.banner) {
      this.banner = document.createElement("div");
      this.banner.className = "timer-banner";
      this.banner.innerHTML = `
        <span class="timer-banner-icon">${this.getBellIcon()}</span>
        <span class="timer-banner-text">${osT("Timer finished")}</span>
        <button class="timer-banner-stop">${osT("Stop")}</button>`;
      this.banner.querySelector(".timer-banner-stop").onclick = () => this.dismissFinished();
      document.body.appendChild(this.banner);
    }
    this.banner.hidden = false;
  },

  /* ---------------- DOM ---------------- */

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "timer-wrapper";

    if (this.timers.length === 0) {
      wrapper.appendChild(this.createSetupScreen());
    } else {
      const container = document.createElement("div");
      container.className = `timer-displays count-${this.timers.length}`;
      this.timers.forEach((t, i) => container.appendChild(this.createTimerDisplay(t, i, this.timers.length > 1)));
      wrapper.appendChild(container);
      // Running: the same buttons add time, right under the rings
      wrapper.appendChild(this.createQuickAddButtons(osT("Add time")));
    }
    return wrapper;
  },

  createSetupScreen() {
    const screen = document.createElement("div");
    screen.className = "timer-setup-screen";
    // Tapping the background dismisses the keyboard. The layout moves up when the
    // keyboard opens, so the same tap can end on the background: ignore that.
    screen.onclick = (e) => {
      if (Date.now() - (this.lastInputFocus || 0) < 600) return;
      if (!e.target.closest("input, button")) {
        document.querySelectorAll(".timer-input-field").forEach((input) => input.blur());
        this.sendNotification("HIDE_KEYBOARD");
      }
    };

    const title = document.createElement("div");
    title.className = "timer-setup-title";
    title.textContent = osT("Set a Timer");
    screen.appendChild(title);

    const inputs = document.createElement("div");
    inputs.className = "timer-input-container";
    inputs.appendChild(this.createNumberInput(osT("Hours"), "hours", 0, 23));
    inputs.appendChild(this.createColon());
    inputs.appendChild(this.createNumberInput(osT("Minutes"), "minutes", 0, 59));
    inputs.appendChild(this.createColon());
    inputs.appendChild(this.createNumberInput(osT("Seconds"), "seconds", 0, 59));
    screen.appendChild(inputs);

    const startBtn = document.createElement("button");
    startBtn.className = "timer-start-btn";
    startBtn.textContent = osT("Start");
    startBtn.onclick = () => {
      document.querySelectorAll(".timer-input-field").forEach((input) => input.blur());
      const val = (id) => parseInt(document.getElementById(`timer-${id}`).value, 10) || 0;
      const total = val("hours") * 3600 + val("minutes") * 60 + val("seconds");
      if (total > 0) this.addTimer(total);
    };
    screen.appendChild(startBtn);

    // Quick timers sit right under Start (they used to be stranded at the bottom of the screen)
    screen.appendChild(this.createQuickAddButtons(osT("Quick timers")));
    return screen;
  },

  createColon() {
    const colon = document.createElement("span");
    colon.className = "timer-input-colon";
    colon.textContent = ":";
    return colon;
  },

  createNumberInput(label, id, min, max) {
    const container = document.createElement("div");
    container.className = "timer-number-input";

    const input = document.createElement("input");
    input.type = "number";
    input.id = `timer-${id}`;
    input.min = min;
    input.max = max;
    input.value = "00";
    input.className = "timer-input-field";
    input.onfocus = () => { this.lastInputFocus = Date.now(); };
    // Return on the on-screen keyboard starts the timer
    input.onkeydown = (e) => {
      if (e.key === "Enter") document.querySelector(".timer-start-btn")?.click();
    };

    const labelEl = document.createElement("label");
    labelEl.textContent = label;
    labelEl.className = "timer-input-label";

    container.appendChild(input);
    container.appendChild(labelEl);
    return container;
  },

  createTimerDisplay(timer, index, isDual) {
    const remaining = this.remaining(timer);
    const paused = timer.pausedRemaining != null;
    const display = document.createElement("div");
    display.className = `timer-display ${isDual ? "dual" : "single"}`;
    if (timer.completed) display.classList.add("completed");
    if (paused) display.classList.add("paused");

    const size = 200, r = 88, circumference = 2 * Math.PI * r;
    const progress = timer.total > 0 ? remaining / timer.total : 0;
    const ring = document.createElement("div");
    ring.className = "timer-ring";
    ring.innerHTML = `
      <svg class="timer-circle" viewBox="0 0 ${size} ${size}">
        <defs>
          <linearGradient id="timerGradient${index}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#ffb79b"/>
            <stop offset="100%" stop-color="#ff8a65"/>
          </linearGradient>
        </defs>
        <circle class="timer-circle-bg" cx="100" cy="100" r="${r}"></circle>
        <circle class="timer-circle-progress" cx="100" cy="100" r="${r}"
          stroke="url(#timerGradient${index})"
          stroke-dasharray="${circumference} ${circumference}"
          stroke-dashoffset="${circumference * (1 - progress)}"></circle>
      </svg>`;

    const center = document.createElement("div");
    center.className = "timer-center";
    const time = document.createElement("div");
    time.className = "timer-time-display";
    time.textContent = timer.completed ? osT("Done!") : this.formatTime(remaining);
    const sub = document.createElement("div");
    sub.className = "timer-subtitle";
    sub.textContent = timer.completed ? osT("Time's up") : paused ? osT("Paused") : osT("of {time}", { time: this.formatTime(timer.total) });
    center.appendChild(time);
    center.appendChild(sub);
    ring.appendChild(center);
    display.appendChild(ring);

    const controls = document.createElement("div");
    controls.className = "timer-controls";
    if (timer.completed) {
      const stop = document.createElement("button");
      stop.className = "timer-control-btn stop wide";
      stop.textContent = osT("Stop");
      stop.onclick = () => this.dismissFinished();
      controls.appendChild(stop);
    } else {
      const pauseBtn = document.createElement("button");
      pauseBtn.className = "timer-control-btn pause";
      pauseBtn.setAttribute("aria-label", paused ? osT("Resume") : osT("Pause"));
      pauseBtn.innerHTML = paused ? this.getPlayIcon() : this.getPauseIcon();
      pauseBtn.onclick = () => this.togglePause(index);
      const cancel = document.createElement("button");
      cancel.className = "timer-control-btn cancel";
      cancel.setAttribute("aria-label", osT("Cancel timer"));

      cancel.innerHTML = this.getCloseIcon();
      cancel.onclick = () => this.removeTimer(index);
      controls.appendChild(pauseBtn);
      controls.appendChild(cancel);
    }
    display.appendChild(controls);
    return display;
  },

  createQuickAddButtons(label) {
    const container = document.createElement("div");
    container.className = "timer-quickadd-container";
    const title = document.createElement("div");
    title.className = "timer-quickadd-label";
    title.textContent = label;
    container.appendChild(title);
    this.config.quickAddButtons.forEach((btn) => {
      const button = document.createElement("button");
      button.className = "timer-quickadd-btn";
      button.textContent = btn.label;
      button.onclick = () => this.quickAdd(btn.seconds);
      container.appendChild(button);
    });
    return container;
  },

  formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  },

  /* ---------------- icons ---------------- */

  getPauseIcon() {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"></rect><rect x="14" y="5" width="4" height="14" rx="1.2"></rect></svg>`;
  },

  getPlayIcon() {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"></path></svg>`;
  },

  getCloseIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>`;
  },

  getBellIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>`;
  }
});
