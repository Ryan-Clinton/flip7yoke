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
  const r = selftest(dir, { players: ['Ryan', 'Rita'], subtitle: 'Friday', ssid: 'Home', password: 'pw', showOnBoard: false, reader: false, main: 7790, also: 0 });
  assert.deepStrictEqual(r, { code: 0, out: 'SAVED' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepStrictEqual(saved.players, ['Ryan', 'Rita']); // a list even with PowerShell 5.1's JSON
  assert.strictEqual(saved.subtitle, 'Friday');
  assert.deepStrictEqual(saved.wifi, { ssid: 'Home', password: 'pw', auth: 'WPA', showOnBoard: false });
  assert.strictEqual(saved.cardReader.enabled, false);
  assert.deepStrictEqual(saved.ports, { main: 7790, also: 0 });
  const { validate } = require('../lib/config.js');
  assert.deepStrictEqual(validate(saved).notes, []); // nothing the server would have to correct

  const one = selftest(dir, { players: ['Solo'] });
  assert.strictEqual(one.code, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).players, ['Solo']);
  assert.ok(fs.existsSync(path.join(dir, 'config.json.bak')));
});

test('Settings Save refuses duplicate names and clashing ports, and leaves the file alone', { skip: process.platform !== 'win32' }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ players: ['Keep'] }));
  const r = selftest(dir, { players: ['Ryan', 'ryan'], main: 8000, also: 8000 });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /listed twice/);
  assert.match(r.out, /must be different/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).players, ['Keep']);
});
