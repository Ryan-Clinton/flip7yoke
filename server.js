// Flip 7 score keeper: zero-dependency Node server shared by every device on the Wi-Fi.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 7777;
const STATE_FILE = path.join(__dirname, 'state.json');
const INDEX = path.join(__dirname, 'public', 'index.html');

const fresh = () => ({ mode: 'classic', target: 200, players: [], rounds: [], draft: {}, version: 0 });
let state = fresh();
try { state = { ...fresh(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}

const clients = new Set();
const uid = () => Math.random().toString(36).slice(2, 9);

function save() {
  state.version++;
  fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(msg);
}

const Rules = require('./public/rules.js');
const RULES_JS = path.join(__dirname, 'public', 'rules.js');
const MODES = ['classic', 'vengeance', 'brutal'];

// Rebuild an entry from known fields only, so stored state is always plain numbers and booleans.
function cleanEntry(e) {
  e = e && typeof e === 'object' ? e : {};
  const ints = (a, lo, hi, max) => (Array.isArray(a) ? a : [])
    .filter(n => Number.isInteger(n) && n >= lo && n <= hi).slice(0, max);
  const out = { cards: ints(e.cards, 0, 13, 20), mods: [...new Set(ints(e.mods, 2, 10, 5))] };
  for (const k of ['bust', 'x2', 'half', 'wipe']) if (e[k] === true) out[k] = true;
  if (Number.isFinite(e.manual)) out.manual = Math.max(-9999, Math.min(9999, Math.trunc(e.manual)));
  if (typeof e.hit === 'string' && state.players.some(p => p.id === e.hit)) out.hit = e.hit;
  return out;
}

const actions = {
  addPlayer({ name }) {
    name = String(name || '').trim().slice(0, 20);
    if (name) state.players.push({ id: uid(), name });
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
    if (state.players.some(p => p.id === id)) state.draft[id] = cleanEntry(entry);
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
    state.rounds.push({ scores, zero });
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
  deleteRound({ round }) { state.rounds.splice(round, 1); },
  setTarget({ target }) { if (Number.isFinite(target) && target > 0) state.target = Math.trunc(target); },
  newGame() { state.rounds = []; state.draft = {}; },
};

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))
    .map(i => `http://${i.address}:${PORT}`);
}

http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (req.url === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ urls: lanUrls() }));
  }
  if (req.url === '/api/action' && req.method === 'POST') {
    // A JSON content type forces a CORS preflight, which this server never approves, so other sites can't post here.
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { type, ...args } = JSON.parse(body);
        if (!actions[type]) throw new Error('unknown action');
        actions[type](args);
        save();
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end(String(e.message));
      }
    });
    return;
  }
  if (req.url === '/rules.js') {
    return fs.readFile(RULES_JS, (err, js) => {
      res.writeHead(err ? 404 : 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(err ? '' : js);
    });
  }
  fs.readFile(INDEX, (err, html) => {
    res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(err ? 'index.html missing' : html);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log('Flip 7 score keeper running. Open on any device on the Wi-Fi:');
  for (const u of lanUrls()) console.log('  ' + u);
});
