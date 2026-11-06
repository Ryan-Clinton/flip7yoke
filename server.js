// Flip 7 score keeper: zero-dependency Node server shared by every device on the Wi-Fi.
// Loading this file does nothing by itself; start() runs a server. `node server.js` calls start() (see the end).
const http = require('http');
const os = require('os');
const path = require('path');
const Rules = require('./public/rules.js');
const { jsonFile } = require('./lib/store.js');
const { createReader } = require('./lib/reader.js');
const { openConfig, RESTART_KEYS, get } = require('./lib/config.js');
const { pickAddress, addresses } = require('./lib/net.js');
const paths = require('./lib/paths.js');

const MODES = ['classic', 'vengeance', 'brutal'];
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };

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

// Join-the-Wi-Fi details for the board, only when the host has ticked "show on board" and set a network.
function wifiInfo(w) {
  if (!w.showOnBoard || !w.ssid) return null;
  // Standard Wi-Fi QR format that iPhone and Android cameras offer to join; these characters need a backslash.
  const q = s => String(s).replace(/([\\;,:"])/g, '\\$1');
  const auth = w.password ? w.auth : 'nopass';
  return { ssid: w.ssid, password: w.password, qr: `WIFI:T:${auth};S:${q(w.ssid)};${w.password ? `P:${q(w.password)};` : ''};` };
}

// Only answer requests addressed to this PC (localhost, its own addresses or its name). This stops a web page
// elsewhere reaching the game through DNS rebinding; the JSON-only rule on actions stops cross-site posts.
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const name = os.hostname().toLowerCase();
  if (['localhost', '127.0.0.1', '::1', name, `${name}.local`].includes(host)) return true;
  return addresses().some(a => a.address === host);
}

// Starts a score keeper. Resolves once it is listening, with { port, act, close, ... }.
// Options override the environment, which overrides config.json (see lib/config.js).
async function start(options = {}) {
  const env = process.env;
  const log = options.log || console.log;
  const dataDir = options.dataDir || paths.dataDir();
  paths.checkDataDir(dataDir); // throws "Can't write to <folder>: <reason>"

  const cfg = options.config === false ? null : openConfig(dataDir, { log, onChange: () => { configVersion++; applyConfig(); } });
  const C = () => (cfg ? cfg.config : require('./lib/config.js').DEFAULTS);
  const startCfg = JSON.parse(JSON.stringify(C()));
  const pick = (opt, envVal, conv, cfgVal) => (opt !== undefined ? opt : envVal !== undefined ? conv(envVal) : cfgVal);
  const o = {
    port: pick(options.port, env.PORT, Number, startCfg.ports.main),
    alsoPort: pick(options.alsoPort, env.ALSO_PORT, Number, startCfg.ports.also),
    stateFile: options.stateFile || env.STATE_FILE || path.join(dataDir, 'state.json'),
    historyFile: options.historyFile || env.HISTORY_FILE || path.join(dataDir, 'history.json'),
    scansDir: options.scansDir || env.SCANS_DIR || path.join(dataDir, 'scans'),
    ollamaUrl: pick(options.ollamaUrl, env.OLLAMA_URL, String, startCfg.cardReader.url),
    ollamaModel: pick(options.ollamaModel, env.OLLAMA_MODEL, String, startCfg.cardReader.model),
    reader: options.reader !== undefined ? options.reader : !env.FLIP7_NO_READER, // false: never contact Ollama
    autoMs: options.autoMs || Number(env.FLIP7_AUTO_MS) || 5000, // tests shorten the auto-finish pause
  };

  const saveErrors = {};
  const onSaveError = name => msg => { saveErrors[name] = msg; broadcast(); };
  const stateStore = jsonFile(o.stateFile, { log, onError: onSaveError('state') });
  const historyStore = jsonFile(o.historyFile, { log, onError: onSaveError('history') });

  let state = { ...fresh(), ...(stateStore.load() || {}) };
  state.finishing = false; // the auto-finish timer doesn't survive a restart
  // Finished games, newest first. Kept by player name, since player ids are per game.
  let history = historyStore.load();
  if (!Array.isArray(history)) history = [];

  const reader = createReader({ url: o.ollamaUrl, model: o.ollamaModel, scansDir: o.scansDir, log, onChange: () => broadcast() });
  const clients = new Set();
  const saveError = () => saveErrors.state || saveErrors.history || null;
  // What every page needs besides the game itself, sent with each update. configVersion goes up whenever
  // config.json is reloaded, so open pages fetch /api/info again (names, subtitle, Wi-Fi) without a reload.
  let configVersion = 1;
  const extras = () => ({ saveError: saveError(), reader: reader.state, configVersion });

  function broadcast() {
    const msg = `data: ${JSON.stringify({ ...state, ...extras() })}\n\n`;
    for (const res of clients) res.write(msg);
  }
  function save() {
    state.version++;
    stateStore.save(state);
    broadcast();
  }

  // Live settings: players, subtitle, Wi-Fi and the card reader on/off. The rest waits for the next Start.
  function applyConfig() {
    reader.setEnabled(o.reader && C().cardReader.enabled !== false);
    broadcast();
  }
  const restartNeeded = () => RESTART_KEYS.filter(k => JSON.stringify(get(C(), k)) !== JSON.stringify(get(startCfg, k)));

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

  // Exact allow-list of the page's files (no path joining from the URL). Packaged, the list is built into the exe.
  const STATIC = {};
  for (const f of paths.publicFiles()) {
    const type = TYPES[f.split('.').pop()];
    if (type && f !== 'index.html') STATIC['/' + f] = [f, type];
  }

  const json = (res, code, body, extra = {}) =>
    res.writeHead(code, { 'Content-Type': 'application/json', ...extra }).end(JSON.stringify(body));
  let port = o.port;
  let join = { address: null, all: [] };
  const urlFor = a => `http://${a}${port === 80 ? '' : ':' + port}`;
  const lanUrls = () => {
    const rest = addresses().map(a => urlFor(a.address)).filter(u => u !== joinUrl());
    return joinUrl() ? [joinUrl(), ...rest] : rest;
  };
  const joinUrl = () => (join.address ? urlFor(join.address) : null);
  const readBody = (req, max, cb) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > max) req.destroy(); });
    req.on('end', () => cb(body));
  };

  function handle(req, res) {
    if (!hostAllowed(req.headers.host)) {
      return res.writeHead(403, { 'Content-Type': 'text/plain' }).end("Open the game using this computer's address, as shown on the board.");
    }
    const url = req.url.split('?')[0];
    if (url === '/events') {
      // Which browser each device uses, for diagnosing a phone that can't show the page.
      log(`${new Date().toLocaleTimeString()} device connected: ${req.socket.remoteAddress} ${req.headers['user-agent'] || '?'}`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ ...state, ...extras() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (url === '/api/scan' && req.method === 'POST') {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
      return readBody(req, 4e6, async body => {
        try {
          if (reader.state === 'off') throw Object.assign(new Error('The card reader is turned off.'), { off: true });
          const { image } = JSON.parse(body);
          if (typeof image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image)) throw new Error('no photo');
          // tools/eval-scans.js marks its requests so test runs don't push real photos out of scans/
          json(res, 200, await reader.scan(image, state.mode, !req.headers['x-flip7-test']));
        } catch (e) {
          const down = /ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(e.code || e.message);
          if (down) reader.check(); // hides the camera on every phone if Ollama has gone
          json(res, down || e.off ? 503 : 500, { error: down ? "The card reader isn't running on the computer." : String(e.message).slice(0, 200) });
        }
      });
    }
    if (url === '/api/reader/check' && req.method === 'POST') {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
      return readBody(req, 1e3, () => reader.check().then(s => json(res, 200, { reader: s })));
    }
    if (url === '/api/history') return json(res, 200, history, { 'Cache-Control': 'no-cache' });
    if (url === '/api/status') {
      return json(res, 200, {
        devices: clients.size, uptime: Math.round(process.uptime()), mode: state.mode,
        players: state.players.map(p => p.name), round: state.rounds.length + 1,
        scored: Object.keys(state.draft).length, urls: lanUrls(), joinUrl: joinUrl(), port,
        saveError: saveError(), reader: reader.state, dataDir,
        configError: cfg ? cfg.error : null, restartNeeded: restartNeeded(),
        token: options.token || env.FLIP7_TOKEN || null,
      }, { 'Cache-Control': 'no-cache' });
    }
    if (url === '/api/info') {
      return json(res, 200, {
        urls: lanUrls(), joinUrl: joinUrl(),
        addresses: join.all.map(a => ({ ...a, url: urlFor(a.address) })),
        names: C().players, subtitle: C().subtitle, wifi: wifiInfo(C().wifi), reader: reader.state,
      }, { 'Cache-Control': 'no-cache' });
    }
    if (url === '/api/action' && req.method === 'POST') {
      // A JSON content type forces a CORS preflight, which this server never approves, so other sites can't post here.
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
      return readBody(req, 1e5, body => {
        try {
          const { type, ...args } = JSON.parse(body);
          const out = act(type, args);
          if (out) json(res, 200, out); else res.writeHead(204).end();
        } catch (e) {
          res.writeHead(e.message === 'stopping' ? 503 : 400).end(String(e.message));
        }
      });
    }
    if (STATIC[url]) {
      const [file, type] = STATIC[url];
      const body = paths.readPublic(file);
      res.writeHead(body ? 200 : 404, { 'Content-Type': type, 'Cache-Control': type.startsWith('font/') ? 'max-age=604800' : 'no-cache' });
      return res.end(body || '');
    }
    const html = paths.readPublic('index.html');
    res.writeHead(html ? 200 : 500, { 'Content-Type': TYPES.html, 'Cache-Control': 'no-cache' });
    res.end(html || 'index.html missing');
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

  let main;
  try { main = await listen(o.port, true); } catch (e) {
    if (cfg) cfg.close();
    throw e;
  }
  port = main.address().port;
  join = await pickAddress(startCfg.network.address, log);
  log(`Flip 7 score keeper running (data in ${dataDir}). Phones join at:`);
  log('  ' + (joinUrl() || `no network address found; this PC only: http://localhost:${port}`));
  for (const u of lanUrls().slice(1)) log('  also ' + u);
  if (cfg && cfg.error) log(`Settings: ${cfg.error}`);
  // Also answer on the standard web port, so a phone that blocks unusual ports can use http://<ip> with no number.
  if (o.alsoPort && o.alsoPort !== port && await listen(o.alsoPort, false)) {
    log(`Also answering on port ${o.alsoPort} (no :${port} needed)`);
  }
  applyConfig(); // starts the card reader check unless it's off

  // Stop taking actions, finish pending saves, close the listeners. Resolves to { saved, error }.
  async function close() {
    accepting = false;
    clearTimeout(autoTimer);
    reader.stop();
    if (cfg) cfg.close();
    for (const res of clients) res.end();
    clients.clear();
    let error = null;
    try { await stateStore.flush(); } catch (e) { error = e.message; }
    try { await historyStore.flush(); } catch (e) { error = error || e.message; }
    await Promise.all(servers.map(s => new Promise(r => { s.close(() => r()); s.closeAllConnections(); })));
    return { saved: !error, error };
  }
  return { port, act, close, reader, get state() { return state; }, get history() { return history; }, saveError };
}

module.exports = { start, cleanEntry, hostAllowed, wifiInfo };

if (require.main === module) {
  start().catch(e => {
    console.log(e.code === 'EADDRINUSE' ? `Port ${e.port} is already in use by another program.` : `Could not start: ${e.message}`);
    process.exit(1);
  });
}
