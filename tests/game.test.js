// Gameplay tests: scoring rules, and the server's actions over HTTP. No dependencies: `node --test tests/game.test.js`.
// Set FLIP7_TEST_EXE to a packaged Flip7yoke-server.exe to run the server tests against it instead of server.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const Rules = require('../public/rules.js');

// ---------- rules ----------

const S = (e, mode) => Rules.entryScore(e, mode);

test('classic: numbers, x2 before modifiers, Flip 7 bonus, bust', () => {
  assert.strictEqual(S({ cards: [3, 5, 9], mods: [] }, 'classic'), 17);
  assert.strictEqual(S({ cards: [3, 5], mods: [4], x2: true }, 'classic'), 20); // (3+5)*2 + 4
  assert.strictEqual(S({ cards: [0, 1, 2, 3, 4, 5, 6], mods: [] }, 'classic'), 21 + 15);
  assert.strictEqual(S({ cards: [3, 5], mods: [10], bust: true }, 'classic'), 0);
  assert.strictEqual(S({ manual: 42 }, 'classic'), 42);
});

test('vengeance: The Zero scores the round 0 unless you Flip 7', () => {
  assert.strictEqual(S({ cards: [0, 9, 12], mods: [] }, 'vengeance'), 0);
  assert.strictEqual(S({ cards: [0, 1, 2, 3, 4, 5, 6], mods: [] }, 'vengeance'), 21 + 15);
});

test('vengeance: halve rounding down, then subtract, floor at 0', () => {
  assert.strictEqual(S({ cards: [4, 7], mods: [], half: true }, 'vengeance'), 5); // floor(11/2)
  assert.strictEqual(S({ cards: [4, 7], mods: [2], half: true }, 'vengeance'), 3);
  assert.strictEqual(S({ cards: [3], mods: [10] }, 'vengeance'), 0);
  assert.strictEqual(S({ cards: [3], mods: [10], bust: true }, 'vengeance'), 0);
});

test('vengeance: Lucky 13 lets two 13s count towards a Flip 7', () => {
  const e = { cards: [13, 13, 1, 2, 3, 4, 5], mods: [], lucky: true };
  assert.ok(Rules.isFlip7(e));
  assert.strictEqual(S(e, 'vengeance'), 41 + 15);
});

test('brutal: negative rounds, modifiers hit busted players, Flip 7 hit gives up the +15', () => {
  assert.strictEqual(S({ cards: [3], mods: [10] }, 'brutal'), -7);
  assert.strictEqual(S({ cards: [3, 5], mods: [4, 6], bust: true }, 'brutal'), -10);
  const f7 = { cards: [1, 2, 3, 4, 5, 6, 7], mods: [] };
  assert.strictEqual(S(f7, 'brutal'), 28 + 15);
  assert.strictEqual(S({ ...f7, hit: 'someone' }, 'brutal'), 28);
});

test('wipes and totals: The Zero wipe resets the game total, a Flip 7 cancels it', () => {
  assert.ok(Rules.wipes({ cards: [0, 5], wipe: true }));
  assert.ok(!Rules.wipes({ cards: [0, 1, 2, 3, 4, 5, 6], wipe: true }));
  const st = { players: [{ id: 'a' }, { id: 'b' }], rounds: [
    { scores: { a: 30, b: 10 } }, { scores: { a: 0, b: 5 }, zero: ['a'] }, { scores: { a: 7, b: 1 } },
  ] };
  assert.deepStrictEqual(Rules.totals(st), { a: 7, b: 16 });
});

// ---------- server over HTTP ----------

const EXE = process.env.FLIP7_TEST_EXE;
// Throwaway data folders inside the repo (gitignored), never the system temp folder.
const TMP = path.join(__dirname, '.tmp');
const tmpDir = () => { fs.mkdirSync(TMP, { recursive: true }); return fs.mkdtempSync(path.join(TMP, 'game-')); };
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// Starts a server on a free port with its data in `dir`. In-process by default, or the packaged exe.
async function startGame(dir) {
  const port = await freePort();
  if (!EXE) {
    const { start } = require('../server.js');
    const g = await start({ dataDir: dir, port, alsoPort: 0, reader: false, autoMs: 100, log: () => {} });
    return { url: `http://127.0.0.1:${port}`, stop: () => g.close() };
  }
  const env = { ...process.env, PORT: String(port), ALSO_PORT: '0', FLIP7_DATA: dir, FLIP7_AUTO_MS: '100', FLIP7_NO_READER: '1' };
  for (const k of ['STATE_FILE', 'HISTORY_FILE', 'SCANS_DIR', 'OLLAMA_URL', 'OLLAMA_MODEL']) delete env[k];
  const child = spawn(EXE, ['--serve'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/status')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    url,
    stop: () => new Promise(resolve => {
      child.once('message', m => resolve({ saved: m.saved, error: m.error }));
      child.send({ stop: true });
    }),
  };
}

const post = (url, type, args = {}) => fetch(url + '/api/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...args }),
}).then(async r => ({ status: r.status, body: r.status === 200 ? await r.json() : null }));

// The current game, as the first message on /events.
async function getState(url) {
  const ac = new AbortController();
  const res = await fetch(url + '/events', { signal: ac.signal });
  const rd = res.body.getReader();
  let buf = '';
  while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await rd.read()).value);
  ac.abort();
  return JSON.parse(buf.slice(buf.indexOf('data: ') + 6, buf.indexOf('\n\n')));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('server: join, duplicate names claim the same player, actions need JSON', async () => {
  const dir = tmpDir();
  const g = await startGame(dir);
  try {
    const a = await post(g.url, 'addPlayer', { name: 'Ryan' });
    const b = await post(g.url, 'addPlayer', { name: '  ryan ' });
    assert.strictEqual(a.body.id, b.body.id);
    await post(g.url, 'addPlayer', { name: 'Gareth' });
    assert.deepStrictEqual((await getState(g.url)).players.map(p => p.name), ['Ryan', 'Gareth']);
    const plain = await fetch(g.url + '/api/action', { method: 'POST', body: '{"type":"newGame"}' });
    assert.strictEqual(plain.status, 415);
    assert.strictEqual((await post(g.url, 'nope')).status, 400);
    assert.strictEqual((await post(g.url, 'constructor')).status, 400);
  } finally { await g.stop(); }
});

test('server: a round finishes by itself once everyone has scored; edit, remove, mode change', async () => {
  const dir = tmpDir();
  const g = await startGame(dir);
  try {
    const r = (await post(g.url, 'addPlayer', { name: 'Ryan' })).body.id;
    const c = (await post(g.url, 'addPlayer', { name: 'Chris' })).body.id;
    await post(g.url, 'setEntry', { id: r, entry: { cards: [3, 4], mods: [] } });
    let s = await getState(g.url);
    assert.strictEqual(s.rounds.length, 0);
    assert.ok(!s.finishing);
    await post(g.url, 'setEntry', { id: c, entry: { cards: [10], mods: [2], junk: 'x' } });
    assert.ok((await getState(g.url)).finishing);
    await wait(400);
    s = await getState(g.url);
    assert.strictEqual(s.rounds.length, 1);
    assert.deepStrictEqual(s.rounds[0].scores, { [r]: 7, [c]: 12 });
    assert.deepStrictEqual(s.draft, {});

    await post(g.url, 'editScore', { round: 0, id: c, score: 20 });
    assert.strictEqual((await getState(g.url)).rounds[0].scores[c], 20);

    await post(g.url, 'setEntry', { id: r, entry: { cards: [1], mods: [] } });
    await post(g.url, 'setMode', { mode: 'vengeance' });
    s = await getState(g.url);
    assert.strictEqual(s.mode, 'vengeance');
    assert.deepStrictEqual(s.draft, {}); // switching rules clears the round's entries

    await post(g.url, 'removePlayer', { id: c });
    assert.deepStrictEqual((await getState(g.url)).players.map(p => p.name), ['Ryan']);
  } finally { await g.stop(); }
});

test('server: New game archives to history; delete a history entry', async () => {
  const dir = tmpDir();
  const g = await startGame(dir);
  try {
    const r = (await post(g.url, 'addPlayer', { name: 'Ryan' })).body.id;
    await post(g.url, 'setTarget', { target: 20 });
    await post(g.url, 'setEntry', { id: r, entry: { cards: [12, 11], mods: [] } });
    await wait(400);
    await post(g.url, 'newGame');
    const h = await (await fetch(g.url + '/api/history')).json();
    assert.strictEqual(h.length, 1);
    assert.deepStrictEqual(h[0].winners, ['Ryan']);
    assert.strictEqual(h[0].complete, true);
    assert.deepStrictEqual(h[0].rounds[0].scores, { Ryan: 23 });
    assert.strictEqual((await getState(g.url)).rounds.length, 0);
    await post(g.url, 'deleteHistory', { id: h[0].id });
    assert.strictEqual((await (await fetch(g.url + '/api/history')).json()).length, 0);
  } finally { await g.stop(); }
});

test('server: the game survives a restart, and a damaged state.json falls back to the backup', async () => {
  const dir = tmpDir();
  let g = await startGame(dir);
  const r = (await post(g.url, 'addPlayer', { name: 'Ryan' })).body.id;
  await post(g.url, 'addPlayer', { name: 'Rita' });
  await post(g.url, 'setEntry', { id: r, entry: { cards: [5], mods: [] } });
  const result = await g.stop(); // a clean stop flushes the last write
  assert.deepStrictEqual(result, { saved: true, error: null });

  g = await startGame(dir);
  let s = await getState(g.url);
  assert.deepStrictEqual(s.players.map(p => p.name), ['Ryan', 'Rita']);
  assert.deepStrictEqual(s.draft[r], { cards: [5], mods: [] });
  await post(g.url, 'addPlayer', { name: 'Carlo' }); // one more save so state.json.bak holds the two-player game
  await g.stop();

  assert.ok(fs.existsSync(path.join(dir, 'state.json.bak')));
  fs.writeFileSync(path.join(dir, 'state.json'), '{"players": [broken');
  g = await startGame(dir);
  try {
    s = await getState(g.url);
    assert.deepStrictEqual(s.players.map(p => p.name), ['Ryan', 'Rita']);
  } finally { await g.stop(); }
});

test('store: rapid saves land newest-last, flush waits for them', { skip: !!EXE }, async () => {
  const { jsonFile } = require('../lib/store.js');
  const file = path.join(tmpDir(), 'x.json');
  const st = jsonFile(file, { log: () => {} });
  st.load();
  for (let i = 0; i < 200; i++) st.save({ i });
  await st.flush();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { i: 199 });
  assert.ok(!fs.existsSync(file + '.tmp'));
});

test('store: a write that fails is reported, keeps the old file, and clears on the next good save', { skip: !!EXE }, async () => {
  const { jsonFile } = require('../lib/store.js');
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  const errors = [];
  const st = jsonFile(file, { log: () => {}, onError: m => errors.push(m) });
  st.load();
  st.save({ v: 1 });
  await st.flush();
  fs.mkdirSync(file + '.tmp'); // a directory in the way makes the next write fail
  st.save({ v: 2 });
  await assert.rejects(st.flush());
  assert.ok(st.error);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 });
  fs.rmdirSync(file + '.tmp');
  st.save({ v: 3 });
  await st.flush();
  assert.strictEqual(st.error, null);
  assert.deepStrictEqual(errors.map(Boolean), [true, false]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { v: 1 });
});

// ---------- settings, network, card reader ----------

test('config: bad values fall back to defaults with a note; duplicates and port clashes handled', () => {
  const { validate, DEFAULTS } = require('../lib/config.js');
  const { config, notes } = validate({
    players: ['Ryan', ' ryan ', '', 'Gareth', 42], subtitle: '  Thursday  ',
    wifi: { ssid: 'Home', password: 'pw', auth: 'WPA3', showOnBoard: 'yes' },
    cardReader: { enabled: 'maybe', url: 'ftp://x' }, network: { address: '300.1.1.1' },
    ports: { main: 8080, also: 8080 },
  });
  assert.deepStrictEqual(config.players, ['Ryan', 'Gareth']);
  assert.strictEqual(config.subtitle, 'Thursday');
  assert.strictEqual(config.wifi.auth, 'WPA');
  assert.strictEqual(config.wifi.showOnBoard, true);
  assert.strictEqual(config.cardReader.enabled, 'auto');
  assert.strictEqual(config.cardReader.url, DEFAULTS.cardReader.url);
  assert.strictEqual(config.network.address, 'auto');
  assert.deepStrictEqual(config.ports, { main: 8080, also: 0 });
  assert.ok(notes.length >= 6);
  assert.deepStrictEqual(validate({}).config, DEFAULTS); // an empty file is all defaults
});

test('config: broken JSON keeps the last good settings; .env moves into config.json once', async () => {
  const { openConfig } = require('../lib/config.js');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.env'), 'WIFI_SSID=Home\nWIFI_PASSWORD=secret\n');
  const c = openConfig(dir, { log: () => {}, watch: false });
  assert.strictEqual(c.config.wifi.ssid, 'Home');
  assert.ok(fs.existsSync(path.join(dir, '.env.migrated')) && !fs.existsSync(path.join(dir, '.env')));
  fs.writeFileSync(c.file, JSON.stringify({ players: ['Rita'] }));
  assert.deepStrictEqual(c.reload().players, ['Rita']);
  fs.writeFileSync(c.file, '{ "players": [ "Rita", }');
  c.reload();
  assert.match(c.error, /config\.json has an error/);
  assert.deepStrictEqual(c.config.players, ['Rita']);
});

test('server: names, subtitle and Wi-Fi come from config.json and change live; Wi-Fi only when shown on board', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ players: ['Carlo'], subtitle: 'Friday', wifi: { ssid: 'Home', password: 'pw', showOnBoard: false } }));
  const g = await startGame(dir);
  try {
    let i = await (await fetch(g.url + '/api/info')).json();
    assert.deepStrictEqual(i.names, ['Carlo']);
    assert.strictEqual(i.subtitle, 'Friday');
    assert.strictEqual(i.wifi, null);
    assert.strictEqual(i.reader, 'off');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ players: ['Carlo', 'Jarvis'], wifi: { ssid: 'Home', password: 'p;w' } }));
    for (let n = 0; n < 40 && i.names.length < 2; n++) { await wait(100); i = await (await fetch(g.url + '/api/info')).json(); }
    assert.deepStrictEqual(i.names, ['Carlo', 'Jarvis']);
    assert.strictEqual(i.wifi.qr, String.raw`WIFI:T:WPA;S:Home;P:p\;w;;`);
  } finally { await g.stop(); }
});

test('server: requests addressed to another host name are refused (DNS rebinding)', async () => {
  const dir = tmpDir();
  const g = await startGame(dir);
  try {
    const port = new URL(g.url).port;
    const res = await new Promise(resolve => require('http').get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: `evil.example:${port}` } }, resolve));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual((await fetch(`http://localhost:${port}/api/status`)).status, 200);
    const { hostAllowed } = require('../server.js');
    assert.ok(hostAllowed('[::1]:7777') && !hostAllowed('') && !hostAllowed(undefined));
  } finally { await g.stop(); }
});

test('net: private ranges include 172.16/12; virtual adapters lose', () => {
  const { isPrivate, VIRTUAL } = require('../lib/net.js');
  assert.ok(['10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.141'].every(isPrivate));
  assert.ok(!['172.32.0.1', '8.8.8.8', '100.64.0.1'].some(isPrivate));
  assert.ok(VIRTUAL.test('vEthernet (WSL)') && VIRTUAL.test('Tailscale') && !VIRTUAL.test('Wi-Fi') && !VIRTUAL.test('Ethernet 2'));
});

test('reader: no-model, then ready, then no-ollama when it stops, then ready when it returns', { skip: !!EXE }, async () => {
  const { createReader } = require('../lib/reader.js');
  const http = require('http');
  let models = [];
  const handler = (req, res) => {
    if (req.url === '/api/version') return res.end('{"version":"x"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models }));
    req.resume(); req.on('end', () => res.end('{}'));
  };
  let fake = http.createServer(handler);
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  const seen = [];
  const rd = createReader({ url: `http://127.0.0.1:${port}`, model: 'm:1', scansDir: tmpDir(), log: () => {}, healthMs: 100, onChange: s => seen.push(s) });
  try {
    assert.strictEqual(rd.state, 'off');
    rd.setEnabled(true);
    assert.strictEqual(await rd.check(), 'no-model');
    models = [{ name: 'm:1', model: 'm:1' }];
    assert.strictEqual(await rd.check(), 'ready');
    fake.closeAllConnections(); await new Promise(r => fake.close(r));
    for (let n = 0; n < 30 && rd.state !== 'no-ollama'; n++) await wait(50);
    assert.strictEqual(rd.state, 'no-ollama'); // noticed by the health check, without a photo
    fake = http.createServer(handler);
    await new Promise(r => fake.listen(port, '127.0.0.1', r));
    for (let n = 0; n < 30 && rd.state !== 'ready'; n++) await wait(50);
    assert.strictEqual(rd.state, 'ready');
    rd.setEnabled(false);
    assert.strictEqual(rd.state, 'off');
    // the camera never shows before the model is confirmed: checking -> no-model -> (checking) -> ready
    assert.deepStrictEqual(seen.slice(0, 2), ['checking', 'no-model']);
    assert.ok(seen.indexOf('ready') > 1 && !seen.slice(0, seen.indexOf('ready')).includes('ready'));
  } finally {
    rd.stop();
    fake.closeAllConnections(); fake.close();
  }
});
