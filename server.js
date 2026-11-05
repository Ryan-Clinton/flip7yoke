// Flip 7 score keeper: zero-dependency Node server shared by every device on the Wi-Fi.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 7777;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const INDEX = path.join(__dirname, 'public', 'index.html');

const fresh = () => ({ mode: 'classic', zeroRule: 'total', target: 200, players: [], rounds: [], draft: {}, version: 0 });
let state = fresh();
try { state = { ...fresh(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}

// Finished games, newest first. Kept by player name, since player ids are per game.
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'history.json');
let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
const saveHistory = () => fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), () => {});
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
// Scripts the page loads, all served from this machine so game night needs no internet.
// Exact allow-list (no path joining from the URL), plus the bundled fonts.
const STATIC = {
  '/rules.js': ['rules.js', 'text/javascript; charset=utf-8'],
  '/qrcode.min.js': ['qrcode.min.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
try {
  for (const f of fs.readdirSync(path.join(__dirname, 'public', 'fonts'))) {
    if (f.endsWith('.woff2')) STATIC[`/fonts/${f}`] = [`fonts/${f}`, 'font/woff2'];
  }
} catch {}
const MODES = ['classic', 'vengeance', 'brutal'];
// Names shown under "Played before? Tap your name". Tapping one joins the game as that player.
const REGULARS = ['Ryan', 'Gareth', 'Rossi', 'Chris', 'Carlo', 'Jarvis', 'Rita'];

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
  saveHistory();
}

// Wi-Fi details from .env (kept out of git), shown on the board with a join-the-Wi-Fi QR code.
function readEnv() {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)
      .filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { return {}; }
}
function wifiInfo() {
  const env = readEnv();
  if (!env.WIFI_SSID) return null;
  // Standard Wi-Fi QR format that iPhone and Android cameras offer to join; these characters need a backslash.
  const q = s => String(s).replace(/([\\;,:"])/g, '\\$1');
  const auth = env.WIFI_PASSWORD ? (env.WIFI_AUTH || 'WPA') : 'nopass';
  return {
    ssid: env.WIFI_SSID, password: env.WIFI_PASSWORD || '',
    qr: `WIFI:T:${auth};S:${q(env.WIFI_SSID)};${env.WIFI_PASSWORD ? `P:${q(env.WIFI_PASSWORD)};` : ''};`,
  };
}

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
    if (history.length !== before) saveHistory();
  },
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

// Ask for each physical card once, with its banner word and big symbol, and work the values out here.
// Asking for plain number/modifier lists made the model count a -8 as a number 8 too, and read sideways
// 6s as 9s; the banner word (SIX / NINE) settles 6 vs 9 whichever way up. 15/15 on game-night photos.
// Covers both decks: the rules setting may not match the cards on the table.
const SCAN_PROMPT = `This photo shows one player's cards from the card game Flip 7, laid out on a table. Cards may be sideways or upside down.
Number cards are cream with a big number in the middle (0 to 13) and the same number spelled out as a word on a banner along one edge (ONE, SIX, NINE, THIRTEEN, THE ZERO, LUCKY).
Modifier cards are red or coral (not cream) and show a sign and a number, like -8, +4, x2 or ÷2, with small text "play on any player". They have no word banner.
Action cards show words like Freeze, Flip Three, Second Chance, Just One More, Flip Four, Discard, Steal or Swap: mark them as other.
List each physical card exactly once. For number cards, read the banner word carefully: it tells 6 (SIX) from 9 (NINE) whichever way up the card is.
Ignore anything that is not a card. Reply with compact JSON on a single line.`; // compact JSON halves the answer time
const BANNER_WORDS = {
  ZERO: 0, 'THE ZERO': 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9,
  TEN: 10, ELEVEN: 11, TWELVE: 12, THIRTEEN: 13, LUCKY: 13, 'LUCKY 13': 13, UNLUCKY: 7, 'UNLUCKY 7': 7,
};

// Keep the last few photos and readings on this machine so a misread can be looked at afterwards.
const SCANS_DIR = process.env.SCANS_DIR || path.join(__dirname, 'scans');
const SCANS_KEEP = 30;
function keepScan(imageB64, got, hand) {
  try {
    fs.mkdirSync(SCANS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(SCANS_DIR, `${stamp}.jpg`), Buffer.from(imageB64, 'base64'));
    fs.writeFileSync(path.join(SCANS_DIR, `${stamp}.json`), JSON.stringify({ mode: state.mode, model: OLLAMA_MODEL, read: got, hand }, null, 2));
    const old = fs.readdirSync(SCANS_DIR).filter(f => f.endsWith('.jpg')).sort().slice(0, -SCANS_KEEP);
    for (const f of old) for (const ext of ['.jpg', '.json']) fs.rmSync(path.join(SCANS_DIR, f.replace(/\.jpg$/, ext)), { force: true });
  } catch (e) { console.log('Could not save scan:', e.message); }
}
const SCAN_SCHEMA = {
  type: 'object',
  properties: { cards: { type: 'array', items: { type: 'object', properties: {
    // colour first: the model commits to it before reading, and red = modifier is reliable even for a card upside down under another
    colour: { type: 'string', enum: ['cream', 'red', 'other'], description: 'background colour of the card' },
    kind: { type: 'string', enum: ['number', 'modifier', 'other'] },
    banner: { type: 'string', description: 'the word on the banner along the side of a number card, e.g. SIX; empty otherwise' },
    big: { type: 'string', description: 'the big symbol in the middle exactly as printed, including any sign, e.g. 13, -8, ÷2' },
  }, required: ['colour', 'kind', 'banner', 'big'] } } },
  required: ['cards'],
};

// One entry per physical card -> number values and modifier strings. The banner word wins over the big
// digits (6/9); anything signed is a modifier even if the model called it a number.
function readCards(cards, V) {
  const numbers = [], modifiers = [];
  for (const c of cards || []) {
    if (!c || c.kind === 'other') continue;
    const big = String(c.big || '').replace(/\s/g, '').replace(/[−–]/g, '-');
    // In Vengeance every modifier card is red and every number card cream.
    if (c.kind === 'modifier' || /^[-+x×÷/*:]/i.test(big) || (V && c.colour === 'red')) {
      // a bare number on a modifier card takes the deck's sign: minus in Vengeance, plus in Classic
      modifiers.push(/^\d+$/.test(big) ? (V ? '-' : '+') + big : big);
      continue;
    }
    const word = String(c.banner || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const v = word in BANNER_WORDS ? BANNER_WORDS[word] : parseInt(big, 10);
    if (Number.isInteger(v)) numbers.push(v);
  }
  return { numbers, modifiers };
}

function ollamaChat(body, apiPath = '/api/chat') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: OLLAMA.hostname, port: OLLAMA.port || 80, path: apiPath, method: 'POST',
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
    keep_alive: -1, // stay loaded on the GPU all night; Stop in the Flip 7 window frees it
    format: SCAN_SCHEMA,
    options: { temperature: 0 },
    messages: [{
      role: 'user',
      images: [imageB64],
      content: SCAN_PROMPT,
    }],
  });
  const raw = JSON.parse(reply.message.content);
  const got = { ...readCards(raw.cards, V), cards: raw.cards };
  const hand = { cards: [], mods: [] };
  let vengeanceCards = false; // anything that only exists in the Vengeance deck
  for (const n of got.numbers || []) if (Number.isInteger(n) && n >= 0 && n <= 13) {
    hand.cards.push(n);
    if (n === 13) vengeanceCards = true;
  }
  for (const raw of got.modifiers || []) {
    const m = String(raw).replace(/\s/g, '').toLowerCase();
    if (/^(x|×|\*)2$/.test(m)) { if (!V) hand.x2 = true; continue; }
    if (/^(÷|\/|:)2$/.test(m)) { vengeanceCards = true; if (V) hand.half = true; continue; }
    const minus = /^[−-]/.test(m);
    const v = Math.abs(parseInt(m.replace(/^[+−-]/, ''), 10));
    if (minus) vengeanceCards = true;
    // Only count modifiers that belong to the deck the rules are set to: +N in Classic, -N in Vengeance.
    if ([2, 4, 6, 8, 10].includes(v) && minus === V && !hand.mods.includes(v)) hand.mods.push(v);
  }
  // Special cards don't change a finished hand's score, with one exception: two 13s on the table
  // means one must be the Lucky 13 (otherwise the player would have busted).
  // Unlucky 7 has already discarded everything else by the time of the photo and scores as a plain 7.
  if (V && hand.cards.filter(n => n === 13).length === 2) hand.lucky = true;
  if (!V && vengeanceCards) hand.deckHint = 'vengeance';
  keepScan(imageB64, got, hand);
  return hand;
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))
    .map(i => `http://${i.address}:${PORT}`);
}

// Load the model onto the GPU as soon as we start, so the first photo of the night doesn't wait ~4s for it.
// Ollama may come up after us, so keep trying until it answers.
function warmReader() {
  ollamaChat({ model: OLLAMA_MODEL, keep_alive: -1 }, '/api/generate')
    .then(() => console.log('Card reader ready (model loaded on the GPU).'))
    .catch(() => setTimeout(warmReader, 15000));
}
warmReader();

const mainServer = http.createServer((req, res) => {
  if (req.url === '/events') {
    // Which browser each device uses, for diagnosing a phone that can't show the page.
    console.log(`${new Date().toLocaleTimeString()} device connected: ${req.socket.remoteAddress} ${req.headers['user-agent'] || '?'}`);
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
  if (req.url === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(history));
  }
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      devices: clients.size, uptime: Math.round(process.uptime()), mode: state.mode,
      players: state.players.map(p => p.name), round: state.rounds.length + 1,
      scored: Object.keys(state.draft).length, urls: lanUrls(),
    }));
  }
  if (req.url === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ urls: lanUrls(), names: REGULARS, wifi: wifiInfo() }));
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
  if (STATIC[req.url]) {
    const [file, type] = STATIC[req.url];
    return fs.readFile(path.join(__dirname, 'public', file), (err, body) => {
      res.writeHead(err ? 404 : 200, { 'Content-Type': type, 'Cache-Control': type.startsWith('font/') ? 'max-age=604800' : 'no-cache' });
      res.end(err ? '' : body);
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

// Also answer on the standard web port, so a phone that blocks unusual ports can use http://<ip> with no number.
const ALSO_PORT = process.env.ALSO_PORT === undefined ? 80 : Number(process.env.ALSO_PORT);
if (ALSO_PORT && ALSO_PORT !== PORT) {
  http.createServer(mainServer.listeners('request')[0])
    .on('error', e => console.log(`Port ${ALSO_PORT} not available (${e.code}); phones use :${PORT}`))
    .listen(ALSO_PORT, '0.0.0.0', () => console.log(`Also answering on port ${ALSO_PORT} (no :${PORT} needed)`));
}
