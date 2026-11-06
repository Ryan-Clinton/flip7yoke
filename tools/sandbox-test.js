// Runs the clean-PC acceptance test in Windows Sandbox: a clean Windows with no Node or Ollama.
//   node tools/sandbox-test.js
// Needs Windows Sandbox enabled and dist\Flip7yoke-Setup-<version>.exe built (npm run installer).
// The sandbox runs tests/sandbox/acceptance.ps1, which is fully automatic: nobody needs to touch the sandbox.
// This side answers the sandbox's "can the host reach this URL?" requests (that goes through the sandbox's
// firewall, as a phone's request would), prints the log as it grows, closes the sandbox when the results are in,
// and ends with them. Results stay in tests/.tmp/sandbox-<time>/.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SANDBOX = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
if (!fs.existsSync(SANDBOX)) { console.error('Windows Sandbox is not enabled (Turn Windows features on or off > Windows Sandbox).'); process.exit(1); }
if (!fs.readdirSync(path.join(ROOT, 'dist')).some(f => /^Flip7yoke-Setup-.*\.exe$/.test(f))) { console.error('Build the installer first: npm run installer'); process.exit(1); }

const results = path.join(ROOT, 'tests', '.tmp', `sandbox-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(results, { recursive: true });
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const wsb = path.join(results, 'flip7yoke.wsb');
fs.writeFileSync(wsb, `<Configuration>
  <Networking>Enable</Networking>
  <MappedFolders>
    <MappedFolder><HostFolder>${esc(path.join(ROOT, 'dist'))}</HostFolder><SandboxFolder>C:\\fy\\dist</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${esc(path.join(ROOT, 'tests', 'sandbox'))}</HostFolder><SandboxFolder>C:\\fy\\scripts</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${esc(results)}</HostFolder><SandboxFolder>C:\\fy\\results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>cmd.exe /c start "Flip7yoke acceptance test" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File C:\\fy\\scripts\\acceptance.ps1</Command></LogonCommand>
</Configuration>
`);
console.log(`Starting Windows Sandbox; results in ${path.relative(ROOT, results)}`);
spawn(SANDBOX, [wsb], { detached: true, stdio: 'ignore' }).unref();

let shown = 0;
const answered = new Set();
// It stops when the results are in or the sandbox is closed.
const sandboxOpen = () => /WindowsSandbox(RemoteSession|Client)/i.test(
  require('child_process').spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout || '');
let ticks = 0;
const tick = async () => {
  const log = path.join(results, 'log.txt');
  if (fs.existsSync(log)) {
    const text = fs.readFileSync(log, 'utf8');
    if (text.length > shown) { process.stdout.write(text.slice(shown)); shown = text.length; }
  }
  for (const f of fs.readdirSync(results).filter(f => /^host-.*\.request\.json$/.test(f) && !answered.has(f))) {
    answered.add(f);
    const { url } = JSON.parse(fs.readFileSync(path.join(results, f), 'utf8').replace(/^\uFEFF/, ''));
    let out;
    try {
      const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(5000) });
      out = { reachable: r.ok, status: r.status };
    } catch (e) { out = { reachable: false, error: (e.cause && e.cause.code) || e.name }; }
    fs.writeFileSync(path.join(results, f.replace('.request', '.result')), JSON.stringify(out));
  }
  if (fs.existsSync(path.join(results, 'done.txt'))) {
    const res = JSON.parse(fs.readFileSync(path.join(results, 'results.json'), 'utf8').replace(/^\uFEFF/, ''));
    // Shutting down from inside doesn't close the sandbox's window, so close it from here (it's thrown away).
    for (const im of ['WindowsSandboxRemoteSession.exe', 'WindowsSandboxClient.exe'])
      require('child_process').spawnSync('taskkill', ['/im', im, '/f'], { stdio: 'ignore' });
    console.log('\n== Results');
    for (const r of [].concat(res)) console.log(`${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'NOTE'}  ${r.step}: ${r.detail}`);
    process.exit(res.some(r => r.ok === false) ? 1 : 0);
  }
  // Checked every 30s after the first 2 minutes, which gives the sandbox time to open.
  if (++ticks > 120 && ticks % 30 === 0 && !sandboxOpen()) { console.log('\nThe sandbox was closed before the test finished.'); process.exit(1); }
  setTimeout(tick, 1000);
};
tick();
