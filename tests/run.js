'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'timer.js'), 'utf8');
new vm.Script(client);
new vm.Script(fs.readFileSync(path.join(root, 'offscreen.js'), 'utf8'));
let now = 1000000;
let stored = {};
let tabs = [];
let nextTabId = 1;
let audio = [];
let offscreen = false;
let focusCount = 0;
const injections = [];
let failAllTabQuery = false;
let changed = [];
const alarms = new Map();
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const chrome = {
  storage: { local: {
    async get() { return JSON.parse(JSON.stringify(stored)); },
    async set(values) {
      Object.assign(stored, JSON.parse(JSON.stringify(values)));
      changed.forEach(fn => fn({timerState: {newValue: values.timerState}}, 'local'));
    }
  }, onChanged: { addListener(fn) { changed.push(fn); } } },
  action: { onClicked: event(), async setBadgeText(value) { this.badge = value.text; }, async setBadgeBackgroundColor() {} },
  alarms: { onAlarm: event(), async clear(name) { return alarms.delete(name); }, async create(name, value) { alarms.set(name, value); } },
  runtime: { id: 'test', getURL: name => 'chrome-extension://test/' + name,
    onMessage: event(), onInstalled: event(), onStartup: event(),
    async sendMessage(message) {
      if (message.target === 'audio') { audio.push(message.kind); return {ok:true}; }
      return new Promise(resolve => this.onMessage.listeners[0](message, {id:'test'}, resolve));
    }
  },
  tabs: { async query(query) {
    if (!query.url && failAllTabQuery) throw new Error('Tab query unavailable');
    return query.url ? tabs.filter(tab => tab.url === query.url) : tabs;
  }, async create(value) { tabs.push({id:nextTabId++, windowId:1, url:value.url}); },
    async update() { focusCount++; } },
  scripting: { async executeScript(injection) {
    injections.push(injection);
    if (injection.target.tabId === 103) throw new Error('Site access denied or tab closed');
    return [];
  } },
  windows: { async update() {} },
  offscreen: { async hasDocument() { return offscreen; }, async createDocument() { offscreen = true; } }
};
function worker() {
  chrome.runtime.onMessage.listeners = [];
  chrome.action.onClicked.listeners = [];
  chrome.alarms.onAlarm.listeners = [];
  chrome.runtime.onInstalled.listeners = [];
  chrome.runtime.onStartup.listeners = [];
  const context = vm.createContext({ chrome, console, Date: { now: () => now } });
  vm.runInContext(background, context);
  return context;
}
const send = (command, values) => chrome.runtime.sendMessage(Object.assign({target:'timer', command}, values));
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let context = worker();
  let result = await send('get');
  assert.equal(result.state.phase, 'idle');
  assert.equal(chrome.action.badge, '');
  await chrome.action.onClicked.listeners[0]();
  await chrome.action.onClicked.listeners[0]();
  assert.equal(tabs.length, 1, 'Icon must reuse an existing timer tab');
  assert.equal(focusCount, 1);
  await send('settings', { mode:'custom', customMinutes:1, breakMinutes:1 });
  result = await send('start');
  const originalEnd = result.state.endAt;
  assert.equal(alarms.get('timer-phase-end').when, originalEnd);
  now += 10000;
  result = await send('pause');
  assert.equal(result.state.remaining, 50000);
  assert.equal(alarms.size, 0);
  now += 20000;
  result = await send('start');
  assert.equal(result.state.endAt, now + 50000);
  assert.equal(result.state.totalMs, 60000, 'Resume preserves progress denominator');
  context = worker();
  result = await send('get');
  assert.equal(result.state.endAt, now + 50000, 'Worker restart preserves deadline');
  now += 50000;
  tabs = [];
  result = await send('get');
  assert.equal(result.state.phase, 'break');
  assert.equal(result.state.endAt, now + 60000);
  assert.equal(tabs.length, 1, 'Completion reopens a closed timer tab');
  assert.equal(audio[audio.length - 1], 'break');
  const soundCount = audio.length;
  await Promise.all([send('get'), send('get')]);
  assert.equal(audio.length, soundCount, 'Simultaneous checks must not duplicate phase alerts');
  now += 60000;
  result = await send('get');
  assert.equal(result.state.phase, 'done');
  assert.equal(result.state.running, false);
  assert.equal(audio[audio.length - 1], 'done');
  assert.equal(alarms.size, 0);
  await send('toggle-sound');
  assert.equal(audio[audio.length - 1], 'stop');
  await send('restart');
  now += 180000;
  const mutedCount = audio.length;
  result = await send('get');
  assert.equal(result.state.phase, 'done', 'Sleep past both phases catches up');
  assert.equal(audio.length, mutedCount, 'Muted timer emits no sounds');
  await send('reset');
  result = await send('settings', {customMinutes:1000, breakMinutes:0});
  assert.equal(result.state.focusMs, 180 * 60000);
  assert.equal(result.state.breakMs, 60000);
  result = await send('settings', {customMinutes:'invalid'});
  assert.ok(result.error);
  result = await send('get');
  assert.equal(result.state.focusMs, 180 * 60000, 'Invalid settings do not corrupt saved values');
  await send('settings', {customMinutes:1});
  await send('start');
  alarms.clear();
  await chrome.runtime.onStartup.listeners[0]();
  assert.ok(alarms.has('timer-phase-end'), 'Startup recreates missing alarms');
  now += 60000;
  await chrome.alarms.onAlarm.listeners[0]({name:'timer-phase-end'});
  await send('get');
  assert.equal(stored.timerState.phase, 'break');
  await send('reset');

  // Break start pauses all eligible tabs, even with timer sounds muted.
  assert.equal(injections.length, 0, 'Extension-only tabs are never injected');
  tabs.push(
    {id:101, url:'https://example.com/watch', active:false},
    {id:102, url:'https://player.example.org/', audible:false},
    {id:103, url:'https://denied.example.org/'},
    {id:104, url:'file:///C:/videos/example.html'},
    {id:105, url:'chrome://settings/'},
    {id:106, url:'https://discarded.example.org/', discarded:true},
    {id:107, url:'edge://newtab/'}
  );
  await send('start');
  assert.equal(injections.length, 0, 'Starting focus does not interrupt videos');
  now += 60000;
  result = await send('get');
  assert.equal(result.state.phase, 'break');
  assert.equal(result.state.soundOn, false);
  assert.deepEqual(injections.map(value => value.target.tabId).sort(), [101,102,103,104]);
  injections.forEach(value => {
    assert.equal(value.target.allFrames, true, 'Embedded players must also be targeted');
    assert.equal(typeof value.func, 'function');
  });
  assert.ok(alarms.has('timer-phase-end'), 'Denied access must not cancel the break alarm');
  const count = injections.length;
  await Promise.all([send('get'), send('get')]);
  assert.equal(injections.length, count, 'Pause occurs once at break start');
  now += 60000;
  await send('get');
  assert.equal(injections.length, count, 'Break completion does not pause newly played videos');

  // Run the injected function without worker closures, as Chrome does in each frame.
  function video(paused, ended, throws) {
    return {paused, ended, calls:0, pause() {
      this.calls++;
      if (throws) throw new Error('Unavailable player');
      this.paused = true;
    }};
  }
  const playing = video(false, false);
  const muted = video(false, false);
  muted.muted = true;
  const paused = video(true, false);
  const ended = video(false, true);
  const broken = video(false, false, true);
  const shadowVideo = video(false, false);
  const nestedVideo = video(false, false);
  function scope(videos, children) {
    return {querySelectorAll(selector) { return selector === 'video' ? videos : children || []; }};
  }
  const nestedRoot = scope([nestedVideo]);
  const shadowRoot = scope([shadowVideo], [{shadowRoot:nestedRoot}]);
  const page = scope([broken, playing, muted, paused, ended], [{shadowRoot}, {shadowRoot:null}]);
  const injectedSource = '(' + injections[0].func.toString() + ')()';
  vm.runInNewContext(injectedSource, {document:page});
  [playing, muted, shadowVideo, nestedVideo].forEach(value => assert.equal(value.calls, 1));
  assert.equal(paused.calls, 0);
  assert.equal(ended.calls, 0);
  const embeddedVideo = video(false, false);
  vm.runInNewContext(injectedSource, {document:scope([embeddedVideo])});
  assert.equal(embeddedVideo.paused, true);

  await send('reset');
  await send('start');
  now += 60000;
  failAllTabQuery = true;
  result = await send('get');
  failAllTabQuery = false;
  assert.equal(result.state.phase, 'break', 'Query failures cannot stop phase transitions');
  assert.ok(alarms.has('timer-phase-end'));
  await send('reset');
  tabs = tabs.filter(tab => tab.url === chrome.runtime.getURL('timer.html'));
  // Exercise the real client bindings and rendering against the same worker.
  class Element {
    constructor(id, dataset) { this.id=id; this.dataset=dataset || {}; this.listeners={}; this.style={}; this.value=15; this.disabled=false; this.attributes={}; this.classes=new Set();
      this.classList={add:(...names)=>names.forEach(n=>this.classes.add(n)), remove:(...names)=>names.forEach(n=>this.classes.delete(n)),
        toggle:(name,on)=>on ? this.classes.add(name) : this.classes.delete(name)};
    }
    addEventListener(name, fn) { this.listeners[name]=fn; }
    setAttribute(name, value) { this.attributes[name]=value; }
    closest(selector) { return selector === '.chip' ? this : null; }
  }
  const nodes = {};
  const html = fs.readFileSync(path.join(root, 'timer.html'), 'utf8');
  const pattern = /id="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(html))) nodes[match[1]]=new Element(match[1]);
  const modeTabs = ['default','custom'].map(mode => new Element('', {mode}));
  const focusChips = [5,10,20,30,40].map(min => new Element('', {min:String(min)}));
  const breakChips = [5,10,15,20,30].map(min => new Element('', {min:String(min)}));
  const document = { activeElement:null, fullscreenElement:null, documentElement:{}, visibilityState:'visible', listeners:{},
    getElementById:id=>nodes[id], addEventListener(name,fn) { this.listeners[name]=fn; },
    querySelectorAll(selector) { return selector === '.tab' ? modeTabs : selector === '#focusChips .chip' ? focusChips : selector === '#breakChips .chip' ? breakChips : []; } };
  const errors=[];
  vm.runInNewContext(client, {chrome, document, window:{}, navigator:{}, Date:{now:()=>now},
    console:{error:error=>errors.push(error)}, setInterval(){}, clearInterval(){} });
  await flush();
  assert.equal(nodes.status.textContent, 'প্রস্তুত');
  await nodes.startBtn.listeners.click();
  await flush();
  assert.equal(nodes.startBtn.disabled, true);
  await nodes.pauseBtn.listeners.click();
  await flush();
  assert.equal(nodes.pauseBtn.disabled, true);
  await nodes.startBtn.listeners.click();
  await flush();
  now += 60000;
  await send('get');
  await flush();
  assert.equal(nodes.ovTitle.textContent, 'বিরতি শুরু হয়েছে!');
  assert.equal(nodes.overlay.classes.has('hidden'), false);
  now += 60000;
  await send('get');
  await flush();
  assert.equal(nodes.ovClock.textContent, '০০:০০');
  await nodes.ovCloseBtn.listeners.click();
  await flush();
  assert.equal(nodes.overlay.classes.has('hidden'), true);
  assert.equal(errors.length, 0, errors.map(String).join('\n'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.ok(!manifest.action.default_popup);
  assert.ok(manifest.permissions.includes('scripting'));
  ['http://*/*', 'https://*/*', 'file:///*'].forEach(pattern => assert.ok(manifest.host_permissions.includes(pattern)));
  assert.ok(!/<script>/.test(html), 'Extension cannot use inline scripts');
  console.log('PASS: icon opening/reuse, pause/resume, persistence, startup recovery, both phase alarms, delayed catch-up, sound cancellation/muting, validation, concurrent commands, cross-tab video pausing (embedded/shadow players, muted playback, denied access), and UI control/overlay integration.');
})().catch(error => { console.error(error); process.exitCode=1; });