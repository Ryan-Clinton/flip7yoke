// Launcher: runs server.js and restarts it whenever its code changes, so updates never need a manual restart.
// Uses stat polling (fs.watchFile) because change events don't fire reliably on \\wsl.localhost paths from Windows.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const WATCH = [SERVER, path.join(__dirname, 'public', 'rules.js')];
let child = null;
let restarting = false;

function start() {
  child = spawn(process.execPath, [SERVER], { stdio: 'inherit', env: process.env });
  child.on('exit', code => {
    child = null;
    if (restarting) { restarting = false; start(); return; }
    // Crashed: try again shortly rather than leaving the board dead.
    console.log(`Server stopped (code ${code}). Restarting in 2s...`);
    setTimeout(start, 2000);
  });
}

let timer = null;
for (const f of WATCH) {
  fs.watchFile(f, { interval: 1000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`\n${path.basename(f)} changed, restarting the score keeper...`);
      if (child) { restarting = true; child.kill(); } else start();
    }, 500); // let a multi-file save settle first
  });
}

// Closing the launcher closes the server with it, so no orphan keeps the port.
const stop = () => { if (child) child.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);

start();
