
(function () {
  'use strict';

  /* =====================================================
     বাংলা সংখ্যা ও সময় ফরম্যাট
     ===================================================== */
  const BN_DIGITS = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
  const bn  = v => String(v).replace(/[0-9]/g, d => BN_DIGITS[+d]);
  const p2  = n => String(n).padStart(2, '0');

  function fmtTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return bn(p2(Math.floor(total / 60)) + ':' + p2(total % 60));
  }

  const $ = id => document.getElementById(id);

  /* =====================================================
     স্টেট
     ===================================================== */
  const MIN = 60 * 1000;

  const state = {
    phase: 'idle',          // idle | focus | break | done
    running: false,
    endAt: 0,
    remaining: 25 * MIN,
    totalMs: 25 * MIN,
    focusMs: 25 * MIN,
    breakMs: 5 * MIN,
    mode: 'default',
    soundOn: true
  };

  let wakeLock = null;

  /* =====================================================
     পেজের প্লেব্যাক থামানো
     ===================================================== */
  function pauseAllPlayback() {
    // ১) পেজের ভেতরের সব অডিও/ভিডিও
    document.querySelectorAll('audio, video').forEach(el => {
      try { el.pause(); } catch (e) {}
    });

    // ২) চলমান স্পিচ সিন্থেসিস
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {}

    // ৩) সিস্টেম মিডিয়া সেশন (সমর্থিত হলে)
    try {
      if ('mediaSession' in navigator && navigator.mediaSession.playbackState === 'playing') {
        navigator.mediaSession.playbackState = 'paused';
      }
    } catch (e) {}
  }

  /* =====================================================
     ওয়েক লক (স্ক্রিন যেন বন্ধ না হয়)
     ===================================================== */
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* ignore */ }
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.running) requestWakeLock();
  });

  /* =====================================================
     ফুলস্ক্রিন
     ===================================================== */
  async function tryFullscreen() {
    try {
      if (document.fullscreenElement) return true;
      const el = document.documentElement;
      if (el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' });
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else if (el.msRequestFullscreen) {
        el.msRequestFullscreen();
      } else {
        return false;
      }
      return !!document.fullscreenElement;
    } catch (e) {
      return false;
    }
  }

  function exitFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch (e) {}
  }

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      $('ovFsBtn').classList.add('hidden');
    } else if (state.phase === 'break') {
      $('ovFsBtn').classList.remove('hidden');
    }
  });

  /* =====================================================
     রেন্ডার
     ===================================================== */
  function renderClock() {
    const txt = fmtTime(state.remaining);
    $('clock').textContent = txt;

    const pct = state.totalMs ? (1 - state.remaining / state.totalMs) : 0;
    const w = Math.min(100, Math.max(0, pct * 100)).toFixed(2) + '%';
    $('progressFill').style.width = w;

    if (state.phase === 'break') {
      $('ovClock').textContent = txt;
      $('ovBarFill').style.width = w;
    }

    updateTitle();
  }

  function updateTitle() {
    let t = '🍅 টমেটো টাইমার';
    if (state.phase === 'focus' && state.running) {
      t = fmtTime(state.remaining) + ' · কাজ চলছে';
    } else if (state.phase === 'break' && state.running) {
      t = fmtTime(state.remaining) + ' · বিরতি চলছে';
    } else if (state.phase === 'done') {
      t = '✅ বিরতি শেষ! · টমেটো টাইমার';
    } else if (state.phase === 'focus' && !state.running) {
      t = fmtTime(state.remaining) + ' · থামানো';
    }
    document.title = t;
  }

  function setStatus(text) { $('status').textContent = text; }

  function setRunningUI(running) {
    $('startBtn').disabled = running;
    $('pauseBtn').disabled = !running;
    $('startBtn').textContent = running
      ? 'চলছে…'
      : (state.phase === 'idle' ? 'শুরু করুন' : 'চালিয়ে যান');
  }

  /* =====================================================
     টাইমার ইঞ্জিন
     ===================================================== */
  function openOverlay(kind) {
    const ov = $('overlay');
    ov.classList.remove('hidden');

    if (kind === 'break') {
      ov.classList.add('tomato');
      ov.classList.remove('green');
      $('ovEmoji').textContent = '🍅';
      $('ovTitle').textContent = 'বিরতি শুরু হয়েছে!';
      $('ovMsg').textContent   = 'উঠে দাঁড়ান, গভীর শ্বাস নিন, একটু পানি খান। স্ক্রিন থেকে চোখ সরান। ফোন দূরে রাখুন।';
      $('ovMainBtn').classList.add('hidden');
      $('ovCloseBtn').classList.add('hidden');
      $('ovSkipBtn').classList.remove('hidden');
      $('ovFsBtn').classList.add('hidden');
    } else {
      ov.classList.add('green');
      ov.classList.remove('tomato');
      $('ovEmoji').textContent = '🌿';
      $('ovTitle').textContent = 'বিরতি শেষ!';
      $('ovMsg').textContent   = 'নতুন একটি পোমোডোরো শুরু করার জন্য প্রস্তুত তো? একটু হাসুন, তারপর আবার শুরু করুন।';
      $('ovMainBtn').classList.remove('hidden');
      $('ovCloseBtn').classList.remove('hidden');
      $('ovSkipBtn').classList.add('hidden');
      $('ovFsBtn').classList.add('hidden');
    }
  }

  function closeOverlay() {
    const ov = $('overlay');
    ov.classList.add('hidden');
    ov.classList.remove('tomato', 'green');
  }

  let ready = false;
  let lastPhase = 'idle';
  let commandQueue = Promise.resolve();

  function applyState(saved) {
    if (!saved) return;
    Object.assign(state, saved);
    ready = true;
    const changed = lastPhase !== state.phase;
    if (state.phase === 'break' || state.phase === 'done') {
      openOverlay(state.phase);
      if (changed && state.phase === 'break') {
        pauseAllPlayback();
        tryFullscreen().then(ok => $('ovFsBtn').classList.toggle('hidden', ok));
      }
      $('ovFsBtn').classList.toggle('hidden', state.phase !== 'break' || !!document.fullscreenElement);
    } else {
      closeOverlay();
      if (changed) exitFullscreen();
    }
    if (state.running) requestWakeLock(); else releaseWakeLock();
    lastPhase = state.phase;
    document.querySelectorAll('.tab').forEach(tab => {
      const active = tab.dataset.mode === state.mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    $('customPanel').classList.toggle('hidden', state.mode !== 'custom');
    if (document.activeElement !== $('focusInput')) $('focusInput').value = state.customMinutes;
    document.querySelectorAll('#focusChips .chip').forEach(chip =>
      chip.classList.toggle('active', +chip.dataset.min === state.customMinutes));
    document.querySelectorAll('#breakChips .chip').forEach(chip =>
      chip.classList.toggle('active', +chip.dataset.min * MIN === state.breakMs));
    $('breakLabel').textContent = bn(state.breakMs / MIN) + ' মিনিট';
    $('soundToggle').textContent = state.soundOn ? '🔊' : '🔇';
    $('soundToggle').setAttribute('aria-pressed', String(state.soundOn));
    setRunningUI(state.running);
    setStatus(state.phase === 'idle' ? 'প্রস্তুত' : state.phase === 'done' ? 'বিরতি শেষ' :
      !state.running ? 'বিরামত — আবার শুরু করতে পারবেন' :
      state.phase === 'focus' ? 'মনোযোগ দিয়ে কাজ চলছে…' : 'বিরতি চলছে…');
    render();
  }

  function render() {
    if (state.running) state.remaining = Math.max(0, state.endAt - Date.now());
    renderClock();
    if (state.phase === 'done') {
      $('ovClock').textContent = fmtTime(0);
      $('ovBarFill').style.width = '100%';
    }
  }

  function command(command, values = {}) {
    commandQueue = commandQueue.then(async () => {
      const response = await chrome.runtime.sendMessage({ target: 'timer', command, ...values });
      if (!response || response.error) throw new Error((response && response.error) || 'Timer unavailable');
      applyState(response.state);
    }).catch(error => {
      console.error(error);
      setStatus('টাইমার চালু করা যায়নি — এক্সটেনশন রিলোড করুন');
    });
    return commandQueue;
  }

  $('startBtn').addEventListener('click', () => command('start'));
  $('pauseBtn').addEventListener('click', () => command('pause'));
  $('resetBtn').addEventListener('click', () => command('reset'));
  $('ovMainBtn').addEventListener('click', () => command('restart'));
  $('ovCloseBtn').addEventListener('click', () => command('reset'));
  $('ovSkipBtn').addEventListener('click', () => command('reset'));
  $('ovFsBtn').addEventListener('click', async () => {
    if (await tryFullscreen()) $('ovFsBtn').classList.add('hidden');
  });
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () =>
    command('settings', { mode: tab.dataset.mode })));
  $('focusChips').addEventListener('click', event => {
    const chip = event.target.closest('.chip');
    if (chip) command('settings', { customMinutes: +chip.dataset.min });
  });
  $('focusInput').addEventListener('change', event => {
    const value = Number(event.target.value);
    const minutes = Number.isFinite(value) ? Math.min(180, Math.max(1, Math.round(value))) : 15;
    event.target.value = minutes;
    command('settings', { customMinutes: minutes });
  });
  $('breakChips').addEventListener('click', event => {
    const chip = event.target.closest('.chip');
    if (chip) command('settings', { breakMinutes: +chip.dataset.min });
  });
  $('soundToggle').addEventListener('click', () => command('toggle-sound'));
  document.addEventListener('keydown', event => {
    if (event.target.closest('input, textarea, select, button, [contenteditable="true"]') || event.repeat || !ready) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (state.phase !== 'break' && state.phase !== 'done') command(state.running ? 'pause' : 'start');
    } else if (event.key.toLowerCase() === 'r') command('reset');
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.timerState && changes.timerState.newValue)) applyState(changes.timerState.newValue);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') command('get');
  });
  setInterval(() => {
    render();
    if (ready && state.running && state.remaining === 0) command('get');
  }, 250);
  command('get');
})();