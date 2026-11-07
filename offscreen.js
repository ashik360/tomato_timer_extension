'use strict';
let audioCtx;
let ringInterval;
const voices = new Set();

function stop() {
  clearInterval(ringInterval);
  ringInterval = null;
  for (const voice of voices) { try { voice.stop(); } catch (_) {} }
  voices.clear();
}

function tone(frequency, delay, duration, type = 'sine', volume = 0.25) {
  const start = audioCtx.currentTime + delay;
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(audioCtx.destination);
  voices.add(oscillator);
  oscillator.onended = () => { voices.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(start);
  oscillator.stop(start + duration + 0.06);
}

async function play(kind) {
  stop();
  if (kind === 'stop') return;
  audioCtx = audioCtx || new AudioContext();
  await audioCtx.resume();
  if (kind === 'break') {
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, i) => {
      tone(frequency, i * 0.22, 1.7);
      tone(frequency * 2, i * 0.22, 0.9, 'triangle', 0.05);
    });
    tone(261.63, 0, 2.8, 'sine', 0.1);
  } else if (kind === 'done') {
    const ring = () => {
      for (let r = 0; r < 2; r++) for (let i = 0; i < 3; i++) {
        tone(880, r * 0.95 + i * 0.23, 0.17, 'square', 0.14);
        tone(1320, r * 0.95 + i * 0.23, 0.17, 'triangle', 0.07);
      }
      tone(440, 1.95, 0.9, 'sine', 0.14);
    };
    ring();
    let repeats = 0;
    ringInterval = setInterval(() => { if (++repeats > 8) stop(); else ring(); }, 3600);
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'audio' || sender.id !== chrome.runtime.id) return false;
  play(message.kind).then(() => sendResponse({ ok: true }), error => sendResponse({ error: error.message }));
  return true;
});