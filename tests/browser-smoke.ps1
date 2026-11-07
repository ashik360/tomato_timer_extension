$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('tomato-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$unit = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'run.js'))
$mock = $unit.Substring($unit.IndexOf('let now ='), $unit.IndexOf('function worker()') - $unit.IndexOf('let now ='))
$mock = $mock.Replace('let now = 1000000;', 'let now = Date.now();').Replace('const chrome = {', 'const mockChrome = {')
$mock += "`nObject.defineProperty(window, 'chrome', { value: mockChrome, configurable: true });`nwindow.testErrors = [];`nwindow.addEventListener('error', e => testErrors.push(e.message));`nwindow.addEventListener('unhandledrejection', e => testErrors.push(String(e.reason)));"
[IO.File]::WriteAllText((Join-Path $testRoot 'mock.js'), $mock, $utf8)
$checks = @"
(async () => {
  const wait = () => new Promise(resolve => setTimeout(resolve, 30));
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  await wait();
  check(document.getElementById('clock').textContent === '২৫:০০', 'Initial clock');
  document.querySelector('[data-mode="custom"]').click();
  await wait();
  check(!document.getElementById('customPanel').classList.contains('hidden'), 'Custom panel');
  const input = document.getElementById('focusInput');
  input.value = 1;
  input.dispatchEvent(new Event('change'));
  await wait();
  document.getElementById('startBtn').click();
  await wait();
  check(document.getElementById('startBtn').disabled, 'Start button');
  document.getElementById('pauseBtn').click();
  await wait();
  check(document.getElementById('pauseBtn').disabled, 'Pause button');
  document.getElementById('startBtn').click();
  await wait();
  const state = (await chrome.storage.local.get()).timerState;
  state.endAt = Date.now() - 1;
  await chrome.storage.local.set({timerState:state});
  await chrome.runtime.sendMessage({target:'timer', command:'get'});
  await wait();
  check(document.getElementById('overlay').classList.contains('tomato'), 'Break overlay');
  check(document.getElementById('ovClock').textContent !== '০০:০০', 'Break countdown');
  const next = (await chrome.storage.local.get()).timerState;
  next.endAt = Date.now() - 1;
  await chrome.storage.local.set({timerState:next});
  await chrome.runtime.sendMessage({target:'timer', command:'get'});
  await wait();
  check(document.getElementById('overlay').classList.contains('green'), 'Done overlay');
  check(document.getElementById('ovClock').textContent === '০০:০০', 'Done clock');
  document.getElementById('ovMainBtn').click();
  await wait();
  check(document.getElementById('overlay').classList.contains('hidden'), 'Restart closes overlay');
  document.getElementById('resetBtn').click();
  await wait();
  check(document.getElementById('clock').textContent === '০১:০০', 'Reset restores chosen duration');
  check(testErrors.length === 0, testErrors.join('; '));
  document.body.setAttribute('data-test-result', 'passed');
})().catch(error => { document.body.setAttribute('data-test-result','failed'); document.body.setAttribute('data-test-error', String(error)); });
"@
[IO.File]::WriteAllText((Join-Path $testRoot 'checks.js'), $checks, $utf8)
Copy-Item -LiteralPath (Join-Path $root 'background.js') -Destination $testRoot
Copy-Item -LiteralPath (Join-Path $root 'timer.js') -Destination $testRoot
$html = [IO.File]::ReadAllText((Join-Path $root 'timer.html'))
$html = $html.Replace('<head>', '<head><script src="mock.js"></script><script src="background.js"></script>')
$html = $html.Replace('</body>', '<script src="checks.js"></script></body>')
# Avoid external font requests in this deterministic local smoke test.
$html = [regex]::Replace($html, '<link[^>]*https://fonts\.[^>]*>', '')
[IO.File]::WriteAllText((Join-Path $testRoot 'index.html'), $html, $utf8)
$browser = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$output = Join-Path $testRoot 'output.html'
$errors = Join-Path $testRoot 'browser.log'
$profile = Join-Path $testRoot 'profile'
$url = ([uri](Join-Path $testRoot 'index.html')).AbsoluteUri
$arguments = @('--headless', '--disable-gpu', '--no-first-run', '--disable-extensions', '--allow-file-access-from-files', '--disable-background-networking', '--dump-dom', '--virtual-time-budget=5000', ('--user-data-dir="' + $profile + '"'), $url)
$process = Start-Process -FilePath $browser -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $output -RedirectStandardError $errors
if (-not $process.WaitForExit(30000)) { $process.Kill(); throw "Browser smoke test timed out. Artifacts: $testRoot" }
$result = ''
for ($attempt = 0; $attempt -lt 100; $attempt++) {
  try { $result = [IO.File]::ReadAllText($output) } catch [IO.IOException] { }
  if ($result -match 'data-test-result="(?:passed|failed)"') { break }
  Start-Sleep -Milliseconds 200
}
if ($result -notmatch 'data-test-result="passed"') {
  $failure = [regex]::Match($result, 'data-test-error="([^"]*)"').Groups[1].Value
  throw "Browser smoke test failed: $failure. Artifacts: $testRoot"
}
Write-Output "PASS: Chrome renders the original UI and runs custom duration, start, pause, resume, break/done overlays, restart and reset without JavaScript errors. Artifacts: $testRoot"