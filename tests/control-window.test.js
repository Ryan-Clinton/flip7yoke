// The control window's Settings: fills the real form off-screen and presses Save (Flip7.ps1 -Action selftest),
// then checks config.json. Windows only (PowerShell 5.1 WinForms).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PS1 = path.join(__dirname, '..', 'Flip7.ps1');
const TMP = path.join(__dirname, '.tmp');
const tmpDir = () => { fs.mkdirSync(TMP, { recursive: true }); return fs.mkdtempSync(path.join(TMP, 'ps-')); };

function selftest(dir, values) {
  const input = path.join(dir, 'input.json');
  fs.writeFileSync(input, JSON.stringify(values));
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Action', 'selftest', '-Out', input],
      { env: { ...process.env, FLIP7_DATA: dir }, encoding: 'utf8', windowsHide: true });
    return { code: 0, out: out.trim() };
  } catch (e) { return { code: e.status, out: String(e.stdout).trim() }; }
}

test('Settings Save writes config.json that the server accepts as is', { skip: process.platform !== 'win32' }, () => {
  const dir = tmpDir();
  // An older file's players list is dropped on Save: the names offered come from saved games.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ players: ['Alex', 'Sam'], subtitle: 'Old' }));
  const r = selftest(dir, { subtitle: 'Friday', ssid: 'Home', password: 'pw', showOnBoard: false, reader: false, main: 7790, also: 0 });
  assert.deepStrictEqual(r, { code: 0, out: 'SAVED' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.players, undefined);
  assert.strictEqual(saved.subtitle, 'Friday');
  assert.deepStrictEqual(saved.wifi, { ssid: 'Home', password: 'pw', auth: 'WPA', showOnBoard: false });
  assert.strictEqual(saved.cardReader.enabled, false);
  assert.deepStrictEqual(saved.ports, { main: 7790, also: 0 });
  const { validate } = require('../lib/config.js');
  assert.deepStrictEqual(validate(saved).notes, []); // nothing the server would have to correct

  const again = selftest(dir, { subtitle: 'Saturday' });
  assert.strictEqual(again.code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).subtitle, 'Saturday');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json.bak'), 'utf8')).subtitle, 'Friday');
});

// An installed copy: the exe and a version-stamped Flip7yoke.ps1 side by side, as the installer lays them out.
const EXE = path.join(__dirname, '..', 'dist', 'Flip7yoke-server.exe');
function installedCopy() {
  const base = tmpDir();
  const app = path.join(base, 'app'), data = path.join(base, 'data');
  fs.mkdirSync(app); fs.mkdirSync(data);
  fs.copyFileSync(EXE, path.join(app, 'Flip7yoke-server.exe'));
  const version = execFileSync(EXE, ['--version'], { encoding: 'utf8' }).trim();
  const ps1 = fs.readFileSync(PS1, 'utf8').replace(/\r\n/g, '\n').replace("$AppVersion = 'dev'\n", `$AppVersion = '${version}'\n`);
  fs.writeFileSync(path.join(app, 'Flip7yoke.ps1'), ps1.replace(/\n/g, '\r\n'));
  return { app, data, ps1: path.join(app, 'Flip7yoke.ps1') };
}
function ps(copy, action) {
  try {
    return { code: 0, out: execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', copy.ps1, '-Action', action],
      { env: { ...process.env, FLIP7_DATA: copy.data, FLIP7_BIND: '127.0.0.1' }, encoding: 'utf8', windowsHide: true }).trim() };
  } catch (e) { return { code: e.status, out: String(e.stdout).trim() }; }
}

test('installed copy with its record missing: status still sees it, Stop ends it (exit 2), the game is kept', { skip: process.platform !== 'win32' || !fs.existsSync(EXE) }, async () => {
  const copy = installedCopy();
  const port = 7700 + Math.floor(Math.random() * 80);
  fs.writeFileSync(path.join(copy.data, 'config.json'), JSON.stringify({ ports: { main: port, also: 0 }, cardReader: { enabled: false } }));
  assert.strictEqual(ps(copy, 'start').code, 0);
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { await new Promise(r => setTimeout(r, 200)); ok = await fetch(`http://127.0.0.1:${port}/api/status`).then(r => r.ok).catch(() => false); }
  assert.ok(ok, 'the installed copy answers');
  await fetch(`http://127.0.0.1:${port}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"addPlayer","name":"Kept"}' });
  await new Promise(r => setTimeout(r, 300));
  fs.rmSync(path.join(copy.data, 'server.pid.json')); // the record is gone, the server isn't

  assert.match(ps(copy, 'status').out, /Running without its record/);
  const stopped = ps(copy, 'stop');
  assert.strictEqual(stopped.code, 2, stopped.out); // ended, but the save couldn't be confirmed: the installer asks
  assert.match(stopped.out, /without its record/);
  const left = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='Flip7yoke-server.exe'" | Where-Object { $_.ExecutablePath -eq '${path.join(copy.app, 'Flip7yoke-server.exe')}' }).Count`],
    { encoding: 'utf8' }).trim();
  assert.strictEqual(left, '0');
  const saved = JSON.parse(fs.readFileSync(path.join(copy.data, 'state.json'), 'utf8'));
  assert.deepStrictEqual(saved.players.map(p => p.name), ['Kept']);
  assert.strictEqual(ps(copy, 'stop').code, 0); // nothing left: a clean "stopped"
});

test('Settings Save refuses clashing ports, and leaves the file alone', { skip: process.platform !== 'win32' }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ subtitle: 'Keep' }));
  const r = selftest(dir, { subtitle: 'Changed', main: 8000, also: 8000 });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /must be different/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).subtitle, 'Keep');
});
