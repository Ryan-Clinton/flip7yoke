// Where things live. Running from the repo, data stays in the project folder as before; the packaged exe keeps
// it in %LOCALAPPDATA%\Flip7yoke (Program files can't be written to, and it survives upgrades and uninstalls).
const fs = require('fs');
const path = require('path');

let sea = null;
try { sea = require('node:sea'); } catch {} // only in Node versions that have single executable support
const packaged = !!(sea && sea.isSea && sea.isSea());

const ROOT = path.join(__dirname, '..');

// First match wins: FLIP7_DATA, the per-user folder when packaged, the project folder from the repo.
function dataDir() {
  if (process.env.FLIP7_DATA) return path.resolve(process.env.FLIP7_DATA);
  if (packaged) return path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'Flip7yoke');
  return ROOT;
}

// Make sure the data folder exists and can be written. Throws one plain sentence if not.
function checkDataDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
  } catch (e) {
    throw new Error(`Can't write to ${dir}: ${e.code || e.message}`);
  }
}

// The web page and its files. Packaged, they are assets inside the exe; from the repo, files in public/.
// Always returns a Buffer (getAsset gives an ArrayBuffer), or null if there's no such file.
function readPublic(name) {
  if (packaged) {
    try { return Buffer.from(sea.getAsset(`public/${name}`)); } catch { return null; }
  }
  try { return fs.readFileSync(path.join(ROOT, 'public', name)); } catch { return null; }
}

// Every file the page may load. Packaged, the build writes the list into the exe (assets/manifest.json).
function publicFiles() {
  if (packaged) {
    try { return JSON.parse(Buffer.from(sea.getAsset('manifest.json')).toString('utf8')); } catch { return []; }
  }
  const out = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(ROOT, 'public', rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else out.push(r);
    }
  };
  try { walk(''); } catch {}
  return out;
}

module.exports = { packaged, dataDir, checkDataDir, readPublic, publicFiles, ROOT };
