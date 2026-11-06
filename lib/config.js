// Settings in config.json (in the data folder, gitignored). Replaces .env and the values that were hard-coded.
// Precedence, highest first: environment variables (tests, development), config.json, the defaults below.
// A missing key takes its default, so an old or partial file still works. Bad values fall back to their default
// with a note; broken JSON keeps the last good settings and reports where the error is.
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const DEFAULTS = {
  version: VERSION,
  subtitle: '',
  wifi: { ssid: '', password: '', auth: 'WPA', showOnBoard: true },
  cardReader: { enabled: 'auto', model: 'qwen3-vl:4b-instruct', url: 'http://127.0.0.1:11434' },
  network: { address: 'auto' },
  ports: { main: 7777, also: 80 },
};
// Settings that only take effect on the next Start (listening sockets and the reader connection are set up once).
const RESTART_KEYS = ['cardReader.model', 'cardReader.url', 'network.address', 'ports.main', 'ports.also'];

const clone = v => JSON.parse(JSON.stringify(v));
const get = (o, key) => key.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Check every value; anything wrong takes its default. Returns { config, notes }.
function validate(raw) {
  const notes = [];
  const c = clone(DEFAULTS);
  if (!isObj(raw)) { notes.push('settings file is not a JSON object; using defaults'); return { config: c, notes }; }
  const bad = (key, why) => notes.push(`${key}: ${why}; using the default`);
  const sect = name => (isObj(raw[name]) ? raw[name] : (raw[name] !== undefined && bad(name, 'not an object'), {}));

  // (Older files have a "players" list. It's ignored: the names offered to phones are the people in saved games.)
  if (raw.subtitle !== undefined) {
    if (typeof raw.subtitle === 'string') c.subtitle = raw.subtitle.trim().slice(0, 60); else bad('subtitle', 'not text');
  }

  const w = sect('wifi');
  if (w.ssid !== undefined) { if (typeof w.ssid === 'string' && w.ssid.length <= 32) c.wifi.ssid = w.ssid; else bad('wifi.ssid', 'not a network name'); }
  if (w.password !== undefined) { if (typeof w.password === 'string' && w.password.length <= 63) c.wifi.password = w.password; else bad('wifi.password', 'not a Wi-Fi password'); }
  if (w.auth !== undefined) { if (['WPA', 'WEP', 'nopass'].includes(w.auth)) c.wifi.auth = w.auth; else bad('wifi.auth', 'must be WPA, WEP or nopass'); }
  if (w.showOnBoard !== undefined) { if (typeof w.showOnBoard === 'boolean') c.wifi.showOnBoard = w.showOnBoard; else bad('wifi.showOnBoard', 'must be true or false'); }

  const r = sect('cardReader');
  if (r.enabled !== undefined) { if ([true, false, 'auto'].includes(r.enabled)) c.cardReader.enabled = r.enabled; else bad('cardReader.enabled', 'must be "auto", true or false'); }
  if (r.model !== undefined) { if (typeof r.model === 'string' && r.model.trim()) c.cardReader.model = r.model.trim(); else bad('cardReader.model', 'empty'); }
  if (r.url !== undefined) {
    let ok = false;
    try { ok = typeof r.url === 'string' && ['http:', 'https:'].includes(new URL(r.url).protocol); } catch {}
    if (ok) c.cardReader.url = r.url.replace(/\/+$/, ''); else bad('cardReader.url', 'must start with http:// or https://');
  }

  const n = sect('network');
  if (n.address !== undefined) {
    if (n.address === 'auto' || (typeof n.address === 'string' && /^(\d{1,3})(\.\d{1,3}){3}$/.test(n.address) && n.address.split('.').every(x => +x <= 255))) c.network.address = n.address;
    else bad('network.address', 'must be "auto" or an IPv4 address');
  }

  const p = sect('ports');
  const port = (v, allowZero) => Number.isInteger(v) && v <= 65535 && (v >= 1 || (allowZero && v === 0));
  if (p.main !== undefined) { if (port(p.main, false)) c.ports.main = p.main; else bad('ports.main', 'must be a whole number from 1 to 65535'); }
  if (p.also !== undefined) { if (port(p.also, true)) c.ports.also = p.also; else bad('ports.also', 'must be 0 (off) or a whole number from 1 to 65535'); }
  if (c.ports.also === c.ports.main) { notes.push(`ports.also is the same as ports.main (${c.ports.main}); turned it off`); c.ports.also = 0; }

  return { config: c, notes };
}

// Write config.json, keeping the previous copy as config.json.bak.
function writeConfig(file, config) {
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// One-off move from .env (Wi-Fi details only) into a new config.json; .env becomes .env.migrated.
function migrateEnv(dir, file, log) {
  const envFile = path.join(dir, '.env');
  if (fs.existsSync(file) || !fs.existsSync(envFile)) return;
  const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const c = clone(DEFAULTS);
  if (env.WIFI_SSID) c.wifi.ssid = env.WIFI_SSID;
  if (env.WIFI_PASSWORD) c.wifi.password = env.WIFI_PASSWORD;
  if (env.WIFI_AUTH) c.wifi.auth = env.WIFI_AUTH;
  writeConfig(file, validate(c).config);
  fs.renameSync(envFile, envFile + '.migrated');
  log(`Moved the Wi-Fi details from .env into ${file} (.env is now .env.migrated).`);
}

// Loads config.json from `dir` and keeps it current. onChange(config, error) runs after each reload.
function openConfig(dir, { log = console.log, watch = true, onChange = () => {} } = {}) {
  const file = path.join(dir, 'config.json');
  let config = clone(DEFAULTS);
  let error = null; // a broken file: what's wrong and where
  let notes = [];

  try { migrateEnv(dir, file, log); } catch (e) { log(`Could not move .env into config.json: ${e.message}`); }

  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') { config = clone(DEFAULTS); error = null; notes = []; return; }
      error = `can't read config.json: ${e.code || e.message}`;
      log(`Settings: ${error}`);
      return;
    }
    let raw;
    try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
      error = `config.json has an error: ${e.message}`; // Node's message gives the line and column
      log(`Settings: ${error}. Keeping the last good settings.`);
      return;
    }
    ({ config, notes } = validate(raw));
    error = null;
    for (const n of notes) log(`Settings: ${n}`);
  }
  load();

  if (watch) {
    fs.watchFile(file, { interval: 1000 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs) return;
      load();
      onChange(config, error);
    });
  }

  return {
    file,
    get config() { return config; },
    get error() { return error; },
    get notes() { return notes; },
    reload() { load(); return config; },
    save(c) { writeConfig(file, validate(c).config); load(); },
    close() { fs.unwatchFile(file); },
  };
}

module.exports = { openConfig, validate, writeConfig, DEFAULTS, RESTART_KEYS, get, VERSION };
