// The supervisor: starts the game server as a child process and owns its lifecycle. Used by the packaged exe
// (started with no arguments) and by run.js in development. Never a Windows service.
// - Crash restarts: an exit while not stopping restarts the server within ~2s; 5 crashes in a minute gives up.
// - Stopping is only ever done here: set "stopping" (so nothing restarts), ask the child over IPC to stop, wait
//   for it to report its saves, then exit. A child that hasn't gone after 5s is killed.
// - server.pid.json in the data folder records what's running, so the control window can tell our server from
//   another program on the same port: PIDs, start times, exe path, ports, a random token, the control port.
// - Control channel: 127.0.0.1 on a random port, one request: POST /stop with the token. It answers once the
//   stop has finished, with {saved, error}.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const paths = require('./paths.js');

const RESTART_MS = 2000;
const STOP_WAIT_MS = 5000;

function run({ watch = false } = {}) {
  const dataDir = paths.dataDir();
  try { paths.checkDataDir(dataDir); } catch (e) { console.log(e.message); process.exit(2); }
  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'server.log');
  try { if (fs.statSync(logFile).size > 5e6) fs.renameSync(logFile, path.join(logDir, 'server.old.log')); } catch {}
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const log = line => { const s = `${line}\n`; process.stdout.write(s); logStream.write(s); };

  const pidFile = path.join(dataDir, 'server.pid.json');
  const errorFile = path.join(dataDir, 'server.error.txt');
  const token = crypto.randomBytes(16).toString('hex');
  const record = {
    supervisorPid: process.pid, supervisorStart: new Date().toISOString(), exe: process.execPath,
    childPid: null, childStart: null, port: null, controlPort: null, token, dataDir,
  };
  const writeRecord = () => {
    const tmp = pidFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, pidFile);
  };

  let child = null, stopping = false, restartTimer = null, crashes = [];

  function spawnChild() {
    // Packaged: run this exe again with --serve. From the repo: node main.js --serve.
    const args = paths.packaged ? ['--serve'] : [path.join(paths.ROOT, 'main.js'), '--serve'];
    child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      env: { ...process.env, FLIP7_TOKEN: token, FLIP7_DATA: dataDir },
    });
    const me = child;
    for (const s of [me.stdout, me.stderr]) s.on('data', d => { process.stdout.write(d); logStream.write(d); });
    record.childPid = me.pid;
    record.childStart = new Date().toISOString();
    writeRecord();
    me.on('message', m => {
      if (m && m.listening) {
        record.port = m.port;
        writeRecord();
        try { fs.rmSync(errorFile, { force: true }); } catch {}
      }
      if (m && m.failed) fs.writeFileSync(errorFile, m.error);
    });
    me.on('exit', (code, signal) => {
      if (child === me) child = null;
      if (stopping || me.replaced) return;
      if (code === 2) { // couldn't start: retrying won't help (port taken, data folder)
        log('The score keeper could not start; see the message above.');
        return finish(2);
      }
      const now = Date.now();
      crashes = crashes.filter(t => now - t < 60000).concat(now);
      if (crashes.length >= 5) {
        log('The score keeper crashed 5 times in a minute; giving up. The log above shows why.');
        fs.writeFileSync(errorFile, 'The score keeper kept crashing. See logs\\server.log.');
        return finish(1);
      }
      log(`Score keeper stopped unexpectedly (${signal || 'code ' + code}). Restarting in 2s...`);
      restartTimer = setTimeout(spawnChild, RESTART_MS);
    });
  }

  // Ask the child to stop and wait for its answer (or its exit). Resolves to {saved, error}.
  function stopChild() {
    const me = child;
    if (!me) return Promise.resolve({ saved: true, error: null });
    return new Promise(resolve => {
      let result = { saved: false, error: 'the server did not report its last save' };
      const kill = setTimeout(() => { log('The score keeper did not stop in 5s; ending it.'); me.kill(); }, STOP_WAIT_MS);
      me.on('message', m => { if (m && m.stopped) result = { saved: m.saved, error: m.error || null }; });
      me.once('exit', () => { clearTimeout(kill); resolve(result); });
      try { me.send({ stop: true }); } catch { me.kill(); }
    });
  }

  let finishing = null;
  function finish(code, result) {
    if (finishing) return finishing;
    stopping = true;
    clearTimeout(restartTimer);
    finishing = stopChild().then(r => {
      result = result || r;
      try { fs.rmSync(pidFile, { force: true }); } catch {}
      control.close();
      logStream.end(() => process.exit(code));
      return result;
    });
    return finishing;
  }

  // The control channel. Only answers on 127.0.0.1, only to a request carrying the token.
  const control = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/stop' && req.headers['x-flip7-token'] === token) {
      log('Stop requested from the control window.');
      stopping = true;
      clearTimeout(restartTimer);
      return stopChild().then(r => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(r), () => finish(0, r));
      });
    }
    if (req.method === 'GET' && req.url === '/ping' && req.headers['x-flip7-token'] === token) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, pid: process.pid }));
    }
    res.writeHead(404).end();
  });

  // One copy only: if a recorded supervisor still answers with its token, it's running; leave it alone.
  function alreadyRunning() {
    let old;
    try { old = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch { return Promise.resolve(false); }
    if (!old.controlPort || !old.token) return Promise.resolve(false);
    return new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port: old.controlPort, path: '/ping', headers: { 'x-flip7-token': old.token }, timeout: 1000 },
        res => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  alreadyRunning().then(running => {
    if (running) { console.log(`Flip7yoke is already running (see ${pidFile}).`); process.exit(0); }
    control.listen(0, '127.0.0.1', () => {
      record.controlPort = control.address().port;
      log(`\n${new Date().toLocaleString()} Flip7yoke supervisor started (pid ${process.pid}).`);
      spawnChild();
    });
  });

  process.on('SIGINT', () => finish(0));
  process.on('SIGTERM', () => finish(0));

  // Development: restart the server when its code changes. A supervisor-initiated stop then start, not a crash.
  if (watch) {
    const files = ['server.js', 'main.js', 'public/rules.js', ...fs.readdirSync(path.join(paths.ROOT, 'lib')).map(f => `lib/${f}`)]
      .filter(f => f.endsWith('.js')).map(f => path.join(paths.ROOT, f));
    let timer = null;
    for (const f of files) {
      fs.watchFile(f, { interval: 1000 }, (cur, prev) => {
        if (cur.mtimeMs === prev.mtimeMs || stopping) return;
        clearTimeout(timer);
        timer = setTimeout(() => { // let a multi-file save settle first
          log(`\n${path.basename(f)} changed, restarting the score keeper...`);
          const old = child;
          if (old) old.replaced = true;
          stopChild().then(() => { if (!stopping) spawnChild(); });
        }, 500);
      });
    }
  }
}

module.exports = { run };
