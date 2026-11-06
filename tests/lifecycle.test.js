// Supervisor lifecycle: stop saves everything, crashes restart, a killed supervisor takes its server with it,
// only one copy runs. Runs `node main.js`, or the packaged exe when FLIP7_TEST_EXE is set.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const EXE = process.env.FLIP7_TEST_EXE;
const TMP = path.join(__dirname, '.tmp');
const tmpDir = () => { fs.mkdirSync(TMP, { recursive: true }); return fs.mkdtempSync(path.join(TMP, 'life-')); };
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) { const v = await fn(); if (v) return v; }
  return null;
}

function launch(dir, port) {
  const env = { ...process.env, FLIP7_DATA: dir, PORT: String(port), ALSO_PORT: '0', FLIP7_NO_READER: '1' };
  for (const k of ['STATE_FILE', 'HISTORY_FILE', 'SCANS_DIR']) delete env[k];
  const cmd = EXE || process.execPath;
  const args = EXE ? [] : [path.join(__dirname, '..', 'main.js')];
  const p = spawn(cmd, args, { env, stdio: 'ignore', windowsHide: true });
  p.exited = new Promise(r => p.once('exit', code => r(code)));
  return p;
}
const record = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'server.pid.json'), 'utf8')); } catch { return null; } };
const status = url => fetch(url + '/api/status').then(r => r.json()).catch(() => null);
const post = (url, type, args = {}) => fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...args }) });
const stop = rec => fetch(`http://127.0.0.1:${rec.controlPort}/stop`, { method: 'POST', headers: { 'x-flip7-token': rec.token } }).then(r => r.json());

test('stop right after a score is entered: the score is saved, the record is removed, the process exits', async () => {
  const dir = tmpDir(), port = await freePort(), url = `http://127.0.0.1:${port}`;
  const sup = launch(dir, port);
  const rec = await until(() => { const r = record(dir); return r && r.port ? r : null; });
  assert.ok(rec, 'server.pid.json with a port');
  const st = await status(url);
  assert.strictEqual(st.token, rec.token); // /api/status proves the server on the port is this one
  const id = (await (await post(url, 'addPlayer', { name: 'Rossi' })).json()).id;
  await post(url, 'setEntry', { id, entry: { cards: [9, 4], mods: [] } });
  assert.deepStrictEqual(await stop(rec), { saved: true, error: null });
  assert.strictEqual(await sup.exited, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepStrictEqual(saved.draft[id], { cards: [9, 4], mods: [] });
  assert.strictEqual(record(dir), null);
  assert.ok(!alive(rec.childPid));
});

test('a crashed server is restarted; a second copy refuses to start; a wrong token is ignored', async () => {
  const dir = tmpDir(), port = await freePort(), url = `http://127.0.0.1:${port}`;
  const sup = launch(dir, port);
  try {
    const rec = await until(() => { const r = record(dir); return r && r.port ? r : null; });
    process.kill(rec.childPid); // like a crash
    const rec2 = await until(() => { const r = record(dir); return r && r.childPid !== rec.childPid && r.port ? r : null; });
    assert.ok(rec2, 'a new server process');
    assert.ok(await until(() => status(url)));

    const second = launch(dir, port);
    assert.strictEqual(await second.exited, 0); // "already running"
    assert.strictEqual(record(dir).supervisorPid, rec.supervisorPid);

    const bad = await fetch(`http://127.0.0.1:${rec.controlPort}/stop`, { method: 'POST', headers: { 'x-flip7-token': 'nope' } });
    assert.strictEqual(bad.status, 404);
    assert.ok(await status(url));
  } finally {
    const r = record(dir);
    if (r) await stop(r).catch(() => {});
    await sup.exited;
  }
});

test('a killed supervisor takes its server with it, and the port is free again', async () => {
  const dir = tmpDir(), port = await freePort(), url = `http://127.0.0.1:${port}`;
  const sup = launch(dir, port);
  const rec = await until(() => { const r = record(dir); return r && r.port ? r : null; });
  await post(url, 'addPlayer', { name: 'Jarvis' });
  process.kill(rec.supervisorPid);
  await sup.exited;
  assert.ok(await until(() => !alive(rec.childPid)), 'server exits after its supervisor dies');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepStrictEqual(saved.players.map(p => p.name), ['Jarvis']);
  const free = await new Promise(r => { const s = net.createServer().once('error', () => r(false)).listen(port, '0.0.0.0', () => s.close(() => r(true))); });
  assert.ok(free, 'port is free');
});

test('stop then start straight away: one server, no restart race', async () => {
  const dir = tmpDir(), port = await freePort(), url = `http://127.0.0.1:${port}`;
  let sup = launch(dir, port);
  let rec = await until(() => { const r = record(dir); return r && r.port ? r : null; });
  await stop(rec);
  await sup.exited;
  sup = launch(dir, port);
  try {
    rec = await until(() => { const r = record(dir); return r && r.port ? r : null; });
    assert.ok(rec);
    await wait(2500); // longer than the crash-restart delay
    const now = record(dir);
    assert.strictEqual(now.childPid, rec.childPid);
    assert.strictEqual((await status(url)).token, rec.token);
  } finally {
    await stop(record(dir)).catch(() => {});
    await sup.exited;
  }
});

test('two copies started at the same moment: one runs, the other exits, and the record stays correct', async () => {
  const dir = tmpDir(), port = await freePort(), url = `http://127.0.0.1:${port}`;
  const a = launch(dir, port), b = launch(dir, port);
  try {
    const loser = await Promise.race([a.exited.then(() => a), b.exited.then(() => b), wait(15000).then(() => null)]);
    assert.ok(loser, 'one copy exits');
    const winner = loser === a ? b : a;
    assert.strictEqual(await loser.exited, 0, 'the second copy exits quietly ("already running")');
    await wait(3000); // longer than a crash restart, in case the loser had broken anything
    const rec = record(dir);
    assert.ok(rec, 'server.pid.json is still there');
    assert.strictEqual(rec.supervisorPid, winner.pid);
    assert.ok(alive(winner.pid));
    assert.strictEqual((await status(url)).token, rec.token);
  } finally {
    const r = record(dir);
    if (r) await stop(r).catch(() => {});
    await Promise.all([a.exited, b.exited]);
  }
});

test('port taken by another program: the supervisor gives up with a message, no restart loop', async () => {
  const dir = tmpDir(), port = await freePort();
  const squatter = net.createServer().listen(port, '0.0.0.0');
  await new Promise(r => squatter.once('listening', r));
  try {
    const sup = launch(dir, port);
    assert.strictEqual(await sup.exited, 2);
    assert.match(fs.readFileSync(path.join(dir, 'server.error.txt'), 'utf8'), /already in use/);
    assert.strictEqual(record(dir), null);
  } finally { squatter.close(); }
});
