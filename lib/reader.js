// Card reader: a local vision model in Ollama turns a photo of a hand into cards.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Rules = require('../public/rules.js');

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
const SCANS_KEEP = 30;

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

// Numbers and modifier strings -> an entry-shaped hand for the rules the game is set to.
function toHand(got, mode) {
  const V = Rules.isVengeance(mode);
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
  return hand;
}

function createReader({ url, model, scansDir, log = console.log, onChange = () => {}, healthMs = 30000 }) {
  const base = new URL(url);
  const lib = base.protocol === 'https:' ? https : http;

  function call(apiPath, body, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = lib.request({
        hostname: base.hostname, port: base.port || (base.protocol === 'https:' ? 443 : 80), path: apiPath,
        method: data ? 'POST' : 'GET',
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        timeout,
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
      req.end(data || undefined);
    });
  }

  // Keep the last few photos and readings on this machine so a misread can be looked at afterwards.
  function keepScan(imageB64, mode, got, hand) {
    try {
      fs.mkdirSync(scansDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(scansDir, `${stamp}.jpg`), Buffer.from(imageB64, 'base64'));
      fs.writeFileSync(path.join(scansDir, `${stamp}.json`), JSON.stringify({ mode, model, read: got, hand }, null, 2));
      const old = fs.readdirSync(scansDir).filter(f => f.endsWith('.jpg')).sort().slice(0, -SCANS_KEEP);
      for (const f of old) for (const ext of ['.jpg', '.json']) fs.rmSync(path.join(scansDir, f.replace(/\.jpg$/, ext)), { force: true });
    } catch (e) { log('Could not save scan:', e.message); }
  }

  // Returns an entry-shaped hand. The phone shows it for checking before anything is saved.
  async function scan(imageB64, mode, keep = true) {
    const reply = await call('/api/chat', {
      model,
      stream: false,
      think: false, // answer straight away; reasoning first is slow on a GTX 1080 and made results wobble
      keep_alive: -1, // stay loaded on the GPU all night; Stop in the Flip 7 window frees it
      format: SCAN_SCHEMA,
      options: { temperature: 0 },
      messages: [{ role: 'user', images: [imageB64], content: SCAN_PROMPT }],
    });
    const raw = JSON.parse(reply.message.content);
    const got = { ...readCards(raw.cards, Rules.isVengeance(mode)), cards: raw.cards };
    const hand = toHand(got, mode);
    if (keep) keepScan(imageB64, mode, got, hand);
    return hand;
  }

  // ---- readiness: off, checking, no-ollama, no-model, ready. The phone shows the camera only when ready. ----
  let state = 'off';
  let enabled = false;
  let retryTimer = null, healthTimer = null, tries = 0, checking = null;
  const set = s => {
    if (s === state) return;
    state = s;
    log(`Card reader: ${{ off: 'off', checking: 'checking...', 'no-ollama': "Ollama isn't answering", 'no-model': `Ollama is running but ${model} isn't downloaded`, ready: 'ready' }[s]}`);
    onChange(s);
  };

  // Load the model onto the GPU, so the first photo of the night doesn't wait ~4s for it. Best effort.
  const warm = () => call('/api/generate', { model, keep_alive: -1 })
    .then(() => log('Card reader: model loaded on the GPU.'))
    .catch(e => log(`Card reader: could not preload the model (${e.message}); it loads on the first photo.`));

  // Full check: is Ollama answering, and does it have the model? Never runs while off.
  function check() {
    if (!enabled) return Promise.resolve(state);
    if (checking) return checking;
    if (state !== 'ready') set('checking');
    checking = (async () => {
      try {
        await call('/api/version', undefined, 3000);
        const tags = await call('/api/tags', undefined, 5000);
        const names = (tags.models || []).flatMap(m => [m.name, m.model]);
        if (!names.some(n => n === model || n === `${model}:latest`)) return set('no-model');
        const was = state;
        set('ready');
        if (was !== 'ready') warm();
      } catch { set('no-ollama'); }
    })().then(() => { checking = null; return state; });
    return checking;
  }

  // At start: check now, then up to 4 more times 15s apart (Ollama may start just after us).
  // While enabled: every 30s a cheap /api/version (never loads the model). Answering again -> full check.
  function begin() {
    tries = 0;
    const attempt = () => check().then(s => {
      if (s !== 'ready' && enabled && ++tries < 5) retryTimer = setTimeout(attempt, 15000);
    });
    attempt();
    healthTimer = setInterval(() => {
      if (checking) return;
      call('/api/version', undefined, 3000)
        .then(() => { if (state !== 'ready') check(); })
        .catch(() => set('no-ollama'));
    }, healthMs);
  }
  function end() { clearTimeout(retryTimer); clearInterval(healthTimer); retryTimer = healthTimer = null; }

  // Turn the reader on or off (cardReader.enabled is live: "auto" and true are on).
  function setEnabled(on) {
    on = on !== false;
    if (on === enabled) return;
    enabled = on;
    end();
    if (on) begin(); else set('off');
  }

  return { scan, check, setEnabled, stop: () => { enabled = false; end(); }, get state() { return state; }, call, model };
}

module.exports = { createReader, readCards, toHand, SCAN_SCHEMA };
