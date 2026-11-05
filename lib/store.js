// Saves a JSON file safely, for the current game and the history.
// - One write at a time; if saves pile up, only the newest is written next, so the newest always lands last.
// - Atomic replace: write file.tmp, flush it to disk, copy the current file to file.bak, rename the .tmp over the file.
// - file.bak is only ever a copy of a file that loaded or saved successfully, so it is always a good one.
// - Windows can refuse the rename while antivirus or a backup tool holds the file (EPERM/EBUSY): retry for about
//   a second, then give up, leave both files as they were, report the error and try again on the next save.
const fs = require('fs');
const fsp = fs.promises;

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retry(fn, tries = 5, gap = 200) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !RETRY_CODES.has(e.code)) throw e;
      await sleep(gap);
    }
  }
}

function jsonFile(file, { log = console.log, onError = () => {} } = {}) {
  let fileGood = false; // does `file` on disk hold a good save (safe to copy to .bak)?
  let queued = null;    // newest text waiting to be written
  let running = false;
  let error = null;     // last write error, cleared by the next good write
  let idle = [];        // flush() callers waiting for the queue to empty

  // Read the file, falling back to file.bak if it is missing or broken. Returns the parsed value or null.
  function load() {
    try { fs.rmSync(file + '.tmp', { force: true }); } catch {}
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      fileGood = true;
      return v;
    } catch (e) {
      const missing = e.code === 'ENOENT';
      try {
        const v = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
        log(`${file} ${missing ? 'is missing' : `could not be read (${e.message})`}; loaded ${file}.bak instead.`);
        return v;
      } catch {
        if (!missing) log(`${file} could not be read (${e.message}) and there is no good backup; starting fresh.`);
        return null;
      }
    }
  }

  async function writeOnce(text) {
    const tmp = file + '.tmp';
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    if (fileGood) await retry(() => fsp.copyFile(file, file + '.bak'));
    await retry(() => fsp.rename(tmp, file));
    fileGood = true;
  }

  function setError(e) {
    const msg = e ? `${e.code ? e.code + ': ' : ''}${e.message}` : null;
    if (msg === error) return;
    error = msg;
    if (msg) log(`Could not save ${file}: ${msg}`);
    else log(`Saving ${file} works again.`);
    onError(msg);
  }

  async function run() {
    running = true;
    while (queued !== null) {
      const text = queued;
      queued = null;
      try { await writeOnce(text); if (error) setError(null); } catch (e) { setError(e); }
    }
    running = false;
    const waiting = idle;
    idle = [];
    for (const f of waiting) f();
  }

  // Snapshot now (so later changes to the object don't leak into this save) and queue it.
  function save(value) {
    queued = JSON.stringify(value, null, 2);
    if (!running) run();
  }

  // Resolves once every queued write has finished; rejects if the last one failed.
  function flush() {
    return new Promise(resolve => (running ? idle.push(resolve) : resolve())).then(() => {
      if (error) throw new Error(error);
    });
  }

  return { load, save, flush, get error() { return error; }, file };
}

module.exports = { jsonFile, retry };
