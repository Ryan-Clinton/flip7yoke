// Card-reader accuracy test: sends real game-night photos through /api/scan and compares them with the
// hands checked by eye. Run with the score keeper (and Ollama) running, with the game on Vengeance rules:
//   node tools/eval-scans.js [--url http://localhost:7777] [--dir scans]
// The photos are gitignored (they're from a real game night), so this only works where they are.
// Fails (exit code 1) if any expected photo is missing, the server isn't on Vengeance, or any reading is wrong.
// Add new photos to TRUTH after checking them by eye; keep the stamp (yyyy-mm-ddThh-mm-ss part of the filename).
const fs = require('fs');
const path = require('path');

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
// The old form `node tools/eval-scans.js http://...` still works.
const BASE = arg('--url', process.argv[2] && /^https?:/.test(process.argv[2]) ? process.argv[2] : 'http://localhost:7777');
const SCANS = path.resolve(arg('--dir', path.join(__dirname, '..', 'scans')));

// stamp -> [number cards sorted, minus-modifier values sorted]   (game played in Vengeance mode)
const TRUTH = {
  '2026-11-05T19-16-14': [[0, 4, 7, 8, 10, 12, 13], []], // Flip 7 with The Zero
  '2026-11-05T19-23-08': [[4, 7, 8, 13, 13], []],        // Lucky 13 + 13
  '2026-11-05T19-46-36': [[4, 7, 8, 13, 13], []],
  '2026-11-05T20-37-31': [[1, 4, 6, 9, 10], []],         // sideways 6 (old reader said 9)
  '2026-11-05T20-37-48': [[4, 5, 7, 8, 11], []],
  '2026-11-05T20-37-56': [[1, 4, 6, 9, 10], []],
  '2026-11-05T20-39-31': [[9], [8]],                     // -8 modifier (old reader also counted an 8)
  '2026-11-05T20-40-10': [[9], [8]],                     // -8 upside down, half under the 9
  '2026-11-05T20-45-30': [[6, 9, 11, 13], []],
  '2026-11-05T20-47-16': [[3, 9, 10, 12], []],
  '2026-11-05T21-03-37': [[5, 9], []],
  '2026-11-05T21-06-22': [[8, 10, 11, 12, 13], []],
  '2026-11-05T21-06-37': [[2, 3, 8, 12, 13], []],
  '2026-11-05T21-11-28': [[6, 7, 8, 9, 10, 11], []],
  '2026-11-05T21-23-43': [[6, 8, 13], [8]],              // sideways 6 + -8: both old failure modes
};

(async () => {
  let files = [];
  try { files = fs.readdirSync(SCANS); } catch {}
  const missing = Object.keys(TRUTH).filter(stamp => !files.some(f => f.startsWith(stamp) && f.endsWith('.jpg')));
  if (missing.length) {
    console.log(`FAIL: ${missing.length} of ${Object.keys(TRUTH).length} photos not found in ${SCANS}:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  let mode;
  try { mode = (await (await fetch(`${BASE}/api/status`)).json()).mode; } catch (e) {
    console.log(`FAIL: no score keeper at ${BASE} (${e.cause ? e.cause.code : e.message})`);
    process.exit(1);
  }
  if (mode !== 'vengeance') {
    console.log(`FAIL: the game at ${BASE} is on ${mode} rules; these photos need Vengeance (switch in the board's menu).`);
    process.exit(1);
  }

  let right = 0, n = 0, ms = 0;
  for (const [stamp, truth] of Object.entries(TRUTH)) {
    const file = files.find(f => f.startsWith(stamp) && f.endsWith('.jpg'));
    const t = Date.now();
    const res = await fetch(`${BASE}/api/scan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Flip7-Test': '1' }, // not saved to scans/
      body: JSON.stringify({ image: fs.readFileSync(path.join(SCANS, file)).toString('base64') }),
    });
    ms += Date.now() - t;
    n++;
    const hand = await res.json();
    if (!res.ok) { console.log('ERROR', stamp, hand.error); continue; }
    const got = [[...hand.cards].sort((a, b) => a - b), [...hand.mods].sort((a, b) => a - b)];
    const ok = JSON.stringify(got) === JSON.stringify(truth);
    right += ok;
    console.log(`${ok ? 'ok  ' : 'MISS'} ${stamp} got ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(truth)}`);
  }
  const total = Object.keys(TRUTH).length;
  console.log(`\n${right}/${total} correct, ${(ms / n / 1000).toFixed(1)}s per photo`);
  process.exit(right === total ? 0 : 1);
})();
