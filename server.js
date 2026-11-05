// Flip 7 score keeper: zero-dependency Node server shared by every device on the Wi-Fi.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 7777;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const INDEX = path.join(__dirname, 'public', 'index.html');

const fresh = () => ({ mode: 'classic', target: 200, players: [], rounds: [], draft: {}, version: 0 });
let state = fresh();
try { state = { ...fresh(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
state.finishing = false; // the auto-finish timer doesn't survive a restart

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
  for (const k of ['bust', 'x2', 'half', 'wipe', 'lucky', 'unlucky', 'chance']) if (e[k] === true) out[k] = true;
  if (Number.isFinite(e.manual)) out.manual = Math.max(-9999, Math.min(9999, Math.trunc(e.manual)));
  if (Number.isInteger(e.dup) && e.dup >= 0 && e.dup <= 13) out.dup = e.dup;
  if (typeof e.hit === 'string' && state.players.some(p => p.id === e.hit)) out.hit = e.hit;
  return out;
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

// Once every player has sent a score, finish the round after a short pause (time to fix a typo).
const AUTO_MS = 5000;
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
    }, AUTO_MS);
  } else if (!all && autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
    state.finishing = false;
  }
}

// ---- card reader: a local vision model in Ollama turns a photo of a hand into cards ----
const OLLAMA = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-vl:4b-instruct' // ~2s per photo on a GTX 1080, read both test hands exactly;

const CARD_GUIDE = {
  classic: `Number cards show one big number from 0 to 12.
Modifier cards show +2, +4, +6, +8, +10 or x2.
Action cards: "Freeze", "Flip Three", "Second Chance".`,
  vengeance: `Number cards show one big number from 0 to 13. The 0 card may say "The Zero".
Special number cards: "Lucky 13" (a 13 with a lucky label) and "Unlucky 7" (a 7 with an unlucky label).
Modifier cards show -2, -4, -6, -8, -10 or ÷2 (divide by two).
Action cards: "Just One More", "Flip Four", "Discard", "Steal", "Swap".`,
};
const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    numbers: { type: 'array', items: { type: 'integer' }, description: 'value of every number card, one entry per card, repeats included' },
    modifiers: { type: 'array', items: { type: 'string' }, description: 'each modifier card exactly as printed, e.g. "+4", "-6", "x2", "÷2"' },
    specials: { type: 'array', items: { type: 'string', enum: ['lucky13', 'unlucky7', 'second_chance'] } },
  },
  required: ['numbers', 'modifiers', 'specials'],
};

function ollamaChat(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: OLLAMA.hostname, port: OLLAMA.port || 80, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 90000,
    }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`card reader said ${res.statusCode}: ${out.slice(0, 200)}`));
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('card reader timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

// Returns an entry-shaped hand. The phone shows it for checking before anything is saved.
async function scanCards(imageB64) {
  const V = Rules.isVengeance(state.mode);
  const reply = await ollamaChat({
    model: OLLAMA_MODEL,
    stream: false,
    think: false, // answer straight away; reasoning first is slow on a GTX 1080 and made results wobble
    keep_alive: '2h', // stay loaded on the GPU between rounds so later scans are quick
    format: SCAN_SCHEMA,
    options: { temperature: 0 },
    messages: [{
      role: 'user',
      images: [imageB64],
      content: `This photo shows one player's hand from the card game Flip 7${V ? ' With a Vengeance' : ''}, laid out on a table.
${CARD_GUIDE[V ? 'vengeance' : 'classic']}
List every card you can see. Ignore action cards, card backs and anything that is not a card.
Each card goes in exactly one list: a card printed with a sign (+, -, x, ÷) is a modifier, never a number card.
Read the big number in the middle or corner of each card. Do not guess cards you cannot see.`,
    }],
  });
  const got = JSON.parse(reply.message.content);
  const hand = { cards: [], mods: [] };
  const top = V ? 13 : 12;
  for (const n of got.numbers || []) if (Number.isInteger(n) && n >= 0 && n <= top) hand.cards.push(n);
  for (const raw of got.modifiers || []) {
    const m = String(raw).replace(/\s/g, '').toLowerCase();
    if (/^(x|×|\*)2$/.test(m)) { if (!V) hand.x2 = true; continue; }
    if (/^(÷|\/|:)2$/.test(m)) { if (V) hand.half = true; continue; }
    const v = Math.abs(parseInt(m.replace(/^[+−-]/, ''), 10));
    if ([2, 4, 6, 8, 10].includes(v) && !hand.mods.includes(v)) hand.mods.push(v);
  }
  const sp = got.specials || [];
  if (V && sp.includes('lucky13')) { hand.lucky = true; if (!hand.cards.includes(13)) hand.cards.push(13); }
  if (V && sp.includes('unlucky7')) { hand.unlucky = true; if (!hand.cards.includes(7)) hand.cards.push(7); }
  if (!V && sp.includes('second_chance')) hand.chance = true;
  return hand;
}

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
  if (req.url === '/api/scan' && req.method === 'POST') {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { image } = JSON.parse(body);
        if (typeof image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image)) throw new Error('no photo');
        const hand = await scanCards(image);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hand));
      } catch (e) {
        const down = /ECONNREFUSED|ENOTFOUND/.test(e.code || e.message);
        res.writeHead(down ? 503 : 500, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: down ? "The card reader isn't running on the computer." : String(e.message).slice(0, 200) }));
      }
    });
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
        const out = actions[type](args);
        scheduleAuto();
        save();
        if (out) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
        else res.writeHead(204).end();
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
