# Tomato Timer

The extension icon opens `timer.html` in a tab, or focuses the existing timer tab.
The background worker owns the saved timer and alarms, so closing or reloading the timer tab does not reset a running session. After browser sleep/restart, elapsed phases catch up to their original deadlines.

## Load or update

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode.
3. Choose **Load unpacked** and select this folder. If already loaded, click its **Reload** button.
4. Close any older timer tab, then click the extension icon.

Requires Chrome/Edge 116 or newer. No build or dependencies are needed.

The existing fullscreen button handles browsers that require a user gesture before entering fullscreen. When focus time ends and the break begins, playing videos in accessible tabs are paused, including videos in embedded frames and open shadow roots. They are not automatically resumed. The pause happens once at break start, so you can manually play a video afterward. Timer sounds being muted does not disable video pausing.

## Checks

Run `node tests/run.js` for background lifecycle and UI binding regression checks.
On Windows with Chrome installed, run `powershell -NoProfile -ExecutionPolicy Bypass -File tests/browser-smoke.ps1` for a headless browser smoke test. This uses a temporary browser profile and mocked extension APIs; it does not load the extension into your personal browser. Test artifacts remain in the temporary directory printed by the script.

The tests cover icon/tab reuse, saved deadlines, pause/resume, focus and break transitions, restart recovery, missed alarms, sound commands and cancellation, input bounds, and UI controls/overlays. Audible playback and browser-managed extension lifecycle should also be checked after loading the unpacked extension.
## Video permissions

Reload the extension after updating, and allow its site access on all sites so it can pause background tabs automatically. Browser-protected pages (including the Chrome Web Store and browser settings) cannot be controlled. To pause local file videos, enable **Allow access to file URLs** in the extension details. Incognito tabs require **Allow in Incognito**. Unsupported or inaccessible tabs are skipped without interrupting the timer.
