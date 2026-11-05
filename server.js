// Flip 7 score keeper: zero-dependency Node server shared by every device on the Wi-Fi.
// Loading this file does nothing by itself; start() runs a server. `node server.js` calls start() (see the end).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Rules = require('./public/rules.js');
const { jsonFile } = require('./lib/store.js');
const { createReader } = require('./lib/reader.js');

const MODES = ['classic', 'vengeance', 'brutal'];
// Names shown under "Played before? Tap your name". Tapping one joins the game as that player.
const REGULARS = ['Ryan', 'Gareth', 'Rossi', 'Chris', 'Carlo', 'Jarvis', 'Rita'];
const PUBLIC = path.join(__dirname, 'public');

const fresh = () => ({ mode: 'classic', zeroRule: 'total', target: 200, players: [], rounds: [], draft: {}, version: 0 });
const uid = () => Math.random().toString(36).slice(2, 9);

// Rebuild an entry from known fields only, so stored state is always plain numbers and booleans.
function cleanEntry(e, players) {
  e = e && typeof e === 'object' ? e : {};
  const ints = (a, lo, hi, max) => (Array.isArray(a) ? a : [])
    .filter(n => Number.isInteger(n) && n >= lo && n <= hi).slice(0, max);
  const out = { cards: ints(e.cards, 0, 13, 20), mods: [...new Set(ints(e.mods, 2, 10, 5))] };
  for (const k of ['bust', 'x2', 'half', 'wipe', 'lucky', 'unlucky', 'chance']) if (e[k] === true) out[k] = true;
  if (Number.isFinite(e.manual)) out.manual = Math.max(-9999, Math.min(9999, Math.trunc(e.manual)));
  if (Number.isInteger(e.dup) && e.dup >= 0 && e.dup <= 13) out.dup = e.dup;
  if (typeof e.hit === 'string' && players.some(p => p.id === e.hit)) out.hit = e.hit;
  return out;
}

// Wi-Fi details from .env (kept out of git), shown on the board with a join-the-Wi-Fi QR code.
function readEnv(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { return {}; }
}
function wifiInfo(envFile) {
  const env = readEnv(envFile);
  if (!env.WIFI_SSID) return null;
  // Standard Wi-Fi QR format that iPhone and Android cameras offer to join; these characters need a backslash.
  const q = s => String(s).replace(/([\\;,:"])/g, '\\$1');
  const auth = env.WIFI_PASSWORD ? (env.WIFI_AUTH || 'WPA') : 'nopass';
  return {
    ssid: env.WIFI_SSID, password: env.WIFI_PASSWORD || '',
    qr: `WIFI:T:${auth};S:${q(env.WIFI_SSID)};${env.WIFI_PASSWORD ? `P:${q(env.WIFI_PASSWORD)};` : ''};`,
  };
}

function defaults() {
  const env = process.env;
  return {
    port: env.PORT === undefined ? 7777 : Number(env.PORT),
    alsoPort: env.ALSO_PORT === undefined ? 80 : Number(env.ALSO_PORT),
    stateFile: env.STATE_FILE || path.join(__dirname, 'state.json'),
    historyFile: env.HISTORY_FILE || path.join(__dirname, 'history.json'),
    scansDir: env.SCANS_DIR || path.join(__dirname, 'scans'),
    envFile: path.join(__dirname, '.env'),
    ollamaUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434',
    ollamaModel: env.OLLAMA_MODEL || 'qwen3-vl:4b-instruct', // ~2s per photo on a GTX 1080
    warmReader: true,
    autoMs: Number(env.FLIP7_AUTO_MS) || 5000, // tests shorten the auto-finish pause
    log: console.log,
  };
}

// Starts a score keeper. Resolves once it is listening, with { port, act, state, close }.
function start(options = {}) {
  const o = { ...defaults(), ...options };
  const log = o.log;
  const saveErrors = {};
  const onSaveError = name => msg => { saveErrors[name] = msg; broadcast(); };

  const stateStore = jsonFile(o.stateFile, { log, onError: onSaveError('state') });
  const historyStore = jsonFile(o.historyFile, { log, onError: onSaveError('history') });

  let state = { ...fresh(), ...(stateStore.load() || {}) };
  state.finishing = false; // the auto-finish timer doesn't survive a restart
  // Finished games, newest first. Kept by player name, since player ids are per game.
  let history = historyStore.load();
  if (!Array.isArray(history)) history = [];

  const reader = createReader({ url: o.ollamaUrl, model: o.ollamaModel, scansDir: o.scansDir, log });
  const clients = new Set();

  const saveError = () => saveErrors.state || saveErrors.history || null;
  function broadcast() {
    const msg = `data: ${JSON.stringify({ ...state, saveError: saveError() })}\n\n`;
    for (const res of clients) res.write(msg);
  }
  function save() {
    state.version++;
    stateStore.save(state);
    broadcast();
  }

  // Save the current game to history (called before New game clears it). Games with no rounds are skipped.
  function archiveGame() {
    if (!state.rounds.length || !state.players.length) return;
    const totals = Rules.totals(state);
    const name = id => (state.players.find(p => p.id === id) || {}).name;
    const players = state.players.map(p => ({ name: p.name, total: totals[p.id] })).sort((a, b) => b.total - a.total);
    const best = players[0].total;
    const complete = best >= state.target;
    const times = state.rounds.map(r => r.at).filter(Boolean);
    history.unshift({
      id: uid(),
      endedAt: times.length ? Math.max(...times) : Date.now(),
      startedAt: times.length ? Math.min(...times) : null,
      mode: state.mode, target: state.target, complete,
      winners: complete ? players.filter(p => p.total === best).map(p => p.name) : [],
      players,
      rounds: state.rounds.map(r => ({
        at: r.at || null,
        scores: Object.fromEntries(state.players.map(p => [p.name, r.scores[p.id] || 0])),
        zero: (r.zero || []).map(name).filter(Boolean),
      })),
    });
    historyStore.save(history);
  }

  const actions = {
    // Joining with a name already in the game claims that player, so a phone that reloads doesn't add a duplicate.
    addPlayer({ name }) {
      name = String(name || '').trim().slice(0, 20);
      if (!name) return;
      const same = state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (same) return { id: same.id };
      const p = { id: uid(), name };
      state.players.push(p);
      return { id: p.id };
    },
    removePlayer({ id }) {
      state.players = state.players.filter(p => p.id !== id);
      delete state.draft[id];
    },
    renamePlayer({ id, name }) {
      const p = state.players.find(p => p.id === id);
      name = String(name || '').trim().slice(0, 20);
      if (p && name) p.name = name;
    },
    setEntry({ id, entry }) {
      if (state.players.some(p => p.id === id)) state.draft[id] = cleanEntry(entry, state.players);
    },
    clearEntry({ id }) { delete state.draft[id]; },
    commitRound() {
      const scores = {}, zero = [];
      for (const p of state.players) {
        const e = state.draft[p.id];
        const sc = Rules.entryScore(e, state.mode);
        scores[p.id] = Number.isFinite(sc) ? sc : 0;
        if (Rules.wipes(e)) zero.push(p.id);
      }
      if (state.mode === 'brutal') {
        for (const p of state.players) {
          const e = state.draft[p.id];
          if (Rules.isFlip7(e) && e.hit in scores && e.hit !== p.id) scores[e.hit] -= 15;
        }
      }
      state.rounds.push({ scores, zero, at: Date.now() });
      state.draft = {};
    },
    editScore({ round, id, score }) {
      const r = state.rounds[round];
      if (r && Number.isFinite(score) && typeof id === 'string') {
        r.scores[id] = Math.trunc(score);
        r.zero = (r.zero || []).filter(z => z !== id); // typing a number undoes a wipe
      }
    },
    setMode({ mode }) {
      if (MODES.includes(mode) && mode !== state.mode) { state.mode = mode; state.draft = {}; }
    },
    // The Zero: 'total' wipes the player's game total (house rule), 'round' just scores the round 0 (rulebook).
    setZeroRule({ rule }) {
      if (rule === 'total' || rule === 'round') state.zeroRule = rule;
    },
    deleteRound({ round }) { state.rounds.splice(round, 1); },
    setTarget({ target }) { if (Number.isFinite(target) && target > 0) state.target = Math.trunc(target); },
    newGame() { archiveGame(); state.rounds = []; state.draft = {}; },
    deleteHistory({ id }) {
      const before = history.length;
      history = history.filter(g => g.id !== id);
      if (history.length !== before) historyStore.save(history);
    },
  };

  // Once every player has sent a score, finish the round after a short pause (time to fix a typo).
  let autoTimer = null;
  function scheduleAuto() {
    const all = state.players.length > 0 && state.players.every(p => state.draft[p.id]);
    if (all && !autoTimer) {
      state.finishing = true;
      autoTimer = setTimeout(() => {
        autoTimer = null;
        state.finishing = false;
        if (state.players.every(p => state.draft[p.id])) actions.commitRound();
        save();
      }, o.autoMs);
    } else if (!all && autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
      state.finishing = false;
    }
  }

  // Run one action exactly as POST /api/action does. Throws on an unknown action.
  let accepting = true;
  function act(type, args = {}) {
    if (!accepting) throw new Error('stopping');
    if (!Object.prototype.hasOwnProperty.call(actions, type)) throw new Error('unknown action');
    const out = actions[type](args);
    scheduleAuto();
    save();
    return out;
  }

  function lanUrls(port) {
    return Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))
      .map(i => `http://${i.address}:${port}`);
  }

  // Scripts the page loads, all served from this machine so game night needs no internet.
  // Exact allow-list (no path joining from the URL), plus the bundled fonts.
  const STATIC = {
    '/rules.js': ['rules.js', 'text/javascript; charset=utf-8'],
    '/qrcode.min.js': ['qrcode.min.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };
  try {
    for (const f of fs.readdirSync(path.join(PUBLIC, 'fonts'))) {
      if (f.endsWith('.woff2')) STATIC[`/fonts/${f}`] = [`fonts/${f}`, 'font/woff2'];
    }
  } catch {}

  const json = (res, code, body, extra = {}) =>
    res.writeHead(code, { 'Content-Type': 'application/json', ...extra }).end(JSON.stringify(body));
  let port = o.port;

  function handle(req, res) {
    if (req.url === '/events') {
      // Which browser each device uses, for diagnosing a phone that can't show the page.
      log(`${new Date().toLocaleTimeString()} device connected: ${req.socket.remoteAddress} ${req.headers['user-agent'] || '?'}`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ ...state, saveError: saveError() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (req.url === '/api/scan' && req.method === 'POST') {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4e6) req.destroy(); });
      req.on('end', async () => {
        try {
          const { image } = JSON.parse(body);
          if (typeof image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image)) throw new Error('no photo');
          // tools/eval-scans.js marks its requests so test runs don't push real photos out of scans/
          json(res, 200, await reader.scan(image, state.mode, !req.headers['x-flip7-test']));
        } catch (e) {
          const down = /ECONNREFUSED|ENOTFOUND/.test(e.code || e.message);
          json(res, down ? 503 : 500, { error: down ? "The card reader isn't running on the computer." : String(e.message).slice(0, 200) });
        }
      });
      return;
    }
    if (req.url === '/api/history') return json(res, 200, history, { 'Cache-Control': 'no-cache' });
    if (req.url === '/api/status') {
      return json(res, 200, {
        devices: clients.size, uptime: Math.round(process.uptime()), mode: state.mode,
        players: state.players.map(p => p.name), round: state.rounds.length + 1,
        scored: Object.keys(state.draft).length, urls: lanUrls(port), saveError: saveError(),
      });
    }
    if (req.url === '/api/info') return json(res, 200, { urls: lanUrls(port), names: REGULARS, wifi: wifiInfo(o.envFile) });
    if (req.url === '/api/action' && req.method === 'POST') {
      // A JSON content type forces a CORS preflight, which this server never approves, so other sites can't post here.
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const { type, ...args } = JSON.parse(body);
          const out = act(type, args);
          if (out) json(res, 200, out); else res.writeHead(204).end();
        } catch (e) {
          res.writeHead(e.message === 'stopping' ? 503 : 400).end(String(e.message));
        }
      });
      return;
    }
    if (STATIC[req.url]) {
      const [file, type] = STATIC[req.url];
      return fs.readFile(path.join(PUBLIC, file), (err, body) => {
        res.writeHead(err ? 404 : 200, { 'Content-Type': type, 'Cache-Control': type.startsWith('font/') ? 'max-age=604800' : 'no-cache' });
        res.end(err ? '' : body);
      });
    }
    fs.readFile(path.join(PUBLIC, 'index.html'), (err, html) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(err ? 'index.html missing' : html);
    });
  }

  const servers = [];
  const listen = (p, required) => new Promise((resolve, reject) => {
    const s = http.createServer(handle);
    s.once('error', e => {
      if (required) return reject(e);
      log(`Port ${p} not available (${e.code}); phones use :${port}`);
      resolve(null);
    });
    s.listen(p, '0.0.0.0', () => { servers.push(s); resolve(s); });
  });

  return (async () => {
    const main = await listen(o.port, true);
    port = main.address().port;
    log('Flip 7 score keeper running. Open on any device on the Wi-Fi:');
    for (const u of lanUrls(port)) log('  ' + u);
    // Also answer on the standard web port, so a phone that blocks unusual ports can use http://<ip> with no number.
    if (o.alsoPort && o.alsoPort !== port && await listen(o.alsoPort, false)) {
      log(`Also answering on port ${o.alsoPort} (no :${port} needed)`);
    }
    if (o.warmReader) reader.warm();

    // Stop taking actions, finish pending saves, close the listeners. Resolves to { saved, error }.
    async function close() {
      accepting = false;
      clearTimeout(autoTimer);
      reader.stop();
      for (const res of clients) res.end();
      clients.clear();
      let error = null;
      try { await stateStore.flush(); } catch (e) { error = e.message; }
      try { await historyStore.flush(); } catch (e) { error = error || e.message; }
      await Promise.all(servers.map(s => new Promise(r => { s.close(() => r()); s.closeAllConnections(); })));
      return { saved: !error, error };
    }
    return { port, act, close, get state() { return state; }, get history() { return history; }, saveError };
  })();
}

module.exports = { start, cleanEntry };

if (require.main === module) {
  start().catch(e => {
    console.log(e.code === 'EADDRINUSE' ? `Port ${e.port} is already in use by another program.` : `Could not start: ${e.message}`);
    process.exit(1);
  });
}
