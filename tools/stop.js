// Stops a running Flip7yoke the proper way (through its supervisor), from its data folder's server.pid.json.
//   node tools/stop.js [data folder]      (default: the same folder the server would use)
const fs = require('fs');
const path = require('path');
const dir = process.argv[2] ? path.resolve(process.argv[2]) : require('../lib/paths.js').dataDir();
let rec;
try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'server.pid.json'), 'utf8')); } catch {
  console.log(`Not running (no server.pid.json in ${dir}).`);
  process.exit(0);
}
fetch(`http://127.0.0.1:${rec.controlPort}/stop`, { method: 'POST', headers: { 'x-flip7-token': rec.token }, signal: AbortSignal.timeout(15000) })
  .then(r => r.json())
  .then(r => { console.log(r.saved ? 'Stopped; everything saved.' : `Stopped, but the last save failed: ${r.error}`); })
  .catch(e => { console.log(`No answer from the supervisor (${e.message}). The record may be stale: ${path.join(dir, 'server.pid.json')}`); process.exit(1); });
