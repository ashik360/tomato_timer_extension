'use strict';

const TIMER_ALARM = 'timer-phase-end';
const BADGE_ALARM = 'timer-badge';
const MIN = 60000;
let queue = Promise.resolve();

// Serialize commands, alarms and startup recovery so only one phase transition is committed.
function serialize(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error('Timer:', error));
  return result;
}

function initialState() {
  return { phase: 'idle', running: false, endAt: 0, remaining: 25 * MIN,
    totalMs: 25 * MIN, focusMs: 25 * MIN, breakMs: 5 * MIN,
    customMinutes: 15, mode: 'default', soundOn: true };
}

async function loadState() {
  const { timerState } = await chrome.storage.local.get('timerState');
  if (!timerState || !['idle', 'focus', 'break', 'done'].includes(timerState.phase) ||
      !Number.isFinite(timerState.remaining) || !Number.isFinite(timerState.focusMs)) return initialState();
  return { ...initialState(), ...timerState };
}

async function focusTimerTab() {
  const url = chrome.runtime.getURL('timer.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url });
}

async function sound(kind) {
  if (kind === 'stop' && !(await chrome.offscreen.hasDocument())) return;
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play timer phase sounds even when the timer tab is closed.' });
  }
  await chrome.runtime.sendMessage({ target: 'audio', kind });
}

async function updateBadge(state) {
  const remaining = state.running ? Math.max(0, state.endAt - Date.now()) : state.remaining;
  await chrome.action.setBadgeText({ text: state.phase === 'done' ? '✓' :
    state.phase === 'idle' ? '' : state.running ? String(Math.ceil(remaining / MIN)) : 'Ⅱ' });
  await chrome.action.setBadgeBackgroundColor({ color: state.phase === 'break' ? '#1f5c26' : '#e8452a' });
}

async function save(state) {
  await chrome.storage.local.set({ timerState: state });
  // Always rebuild alarms: Chrome may clear them when the browser restarts.
  await chrome.alarms.clear(TIMER_ALARM);
  await chrome.alarms.clear(BADGE_ALARM);
  if (state.running) {
    await chrome.alarms.create(TIMER_ALARM, { when: state.endAt });
    await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  }
  await updateBadge(state);
}

async function reconcile(state) {
  if (!state.running) return false;
  let transitioned = false;
  const now = Date.now();
  // Use the original deadline so sleep/delayed alarms do not extend either phase.
  if (now >= state.endAt && state.phase === 'focus') {
    state.phase = 'break';
    state.totalMs = state.breakMs;
    state.endAt += state.breakMs;
    transitioned = true;
  }
  if (now >= state.endAt && state.phase === 'break') {
    state.phase = 'done';
    state.running = false;
    state.remaining = 0;
    transitioned = true;
  } else if (state.running) state.remaining = Math.max(0, state.endAt - now);
  return transitioned;
}

// Self-contained: Chrome serializes this function into each accessible frame.
function pauseDocumentVideos() {
  function visit(root) {
    for (const video of root.querySelectorAll('video')) {
      try { if (!video.paused && !video.ended) video.pause(); } catch (_) { }
    }
    // Some custom players keep their video element inside an open shadow root.
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  }
  visit(document);
}

async function pauseVideosInTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (!Number.isInteger(tab.id) || tab.discarded || !/^(https?:\/\/|file:\/\/)/i.test(tab.url || '')) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: pauseDocumentVideos
      });
    } catch (_) {
      // Protected sites, revoked site access, navigation and closed tabs are expected.
      // One unavailable tab must not stop the others or the timer's next alarm.
    }
  }));
}
async function announce(state) {
  // Pause playback before bringing the timer forward or playing its break sound.
  if (state.phase === 'break') await pauseVideosInTabs().catch(error => console.warn('Pause videos:', error));
  // A failed focus/audio operation must never prevent saving the timer or the next alarm.
  await focusTimerTab().catch(error => console.warn('Timer tab:', error));
  if (state.soundOn) await sound(state.phase).catch(error => console.warn('Timer audio:', error));
}

function reset(state) {
  Object.assign(state, { phase: 'idle', running: false, endAt: 0,
    remaining: state.focusMs, totalMs: state.focusMs });
}

function start(state) {
  if (state.running) return;
  if (state.phase === 'idle' || state.phase === 'done') {
    state.phase = 'focus';
    state.remaining = state.focusMs;
    state.totalMs = state.focusMs;
  }
  state.running = true;
  state.endAt = Date.now() + state.remaining;
}

function bounded(value, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid duration');
  return Math.min(maximum, Math.max(1, Math.round(number)));
}

async function execute(message) {
  const state = await loadState();
  let transitioned = await reconcile(state);
  let stopSound = false;
  switch (message.command) {
    case 'get': break;
    case 'start': start(state); stopSound = true; break;
    case 'pause': state.running = false; state.endAt = 0; break;
    case 'reset': reset(state); stopSound = true; transitioned = false; break;
    case 'restart': reset(state); start(state); stopSound = true; transitioned = false; break;
    case 'toggle-sound': state.soundOn = !state.soundOn; stopSound = !state.soundOn; break;
    case 'settings':
      if (message.mode === 'default' || message.mode === 'custom') state.mode = message.mode;
      if (message.customMinutes !== undefined) state.customMinutes = bounded(message.customMinutes, 180);
      if (message.breakMinutes !== undefined) state.breakMs = bounded(message.breakMinutes, 60) * MIN;
      state.focusMs = (state.mode === 'default' ? 25 : state.customMinutes) * MIN;
      if (state.phase === 'idle') reset(state);
      break;
    default: throw new Error('Unknown timer command');
  }
  await save(state);
  if (stopSound) await sound('stop').catch(error => console.warn('Stop audio:', error));
  if (transitioned) await announce(state);
  return { state };
}

chrome.action.onClicked.addListener(() => serialize(focusTimerTab));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'timer' || sender.id !== chrome.runtime.id) return false;
  serialize(() => execute(message)).then(sendResponse, error => sendResponse({ error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if ([TIMER_ALARM, BADGE_ALARM, 'focus_tick', 'break_tick'].includes(alarm.name)) {
    serialize(() => execute({ command: 'get' }));
  }
});
async function recover() {
  await chrome.alarms.clear('focus_tick');
  await chrome.alarms.clear('break_tick');
  await execute({ command: 'get' });
}
chrome.runtime.onInstalled.addListener(() => serialize(recover));
chrome.runtime.onStartup.addListener(() => serialize(recover));