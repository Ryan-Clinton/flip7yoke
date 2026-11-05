// Card-reader accuracy test: sends real game-night photos from scans/ through /api/scan and compares
// with the hands checked by eye. Run with the score keeper (and Ollama) running:
//   node tools/eval-scans.js [http://localhost:7777]
// scans/ is gitignored (it holds photos from the night), so this only works on the machine that has them.
// Add new photos to TRUTH after checking them by eye; keep the stamp (yyyy-mm-ddThh-mm-ss part of the filename).
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:7777';
const SCANS = path.join(__dirname, '..', 'scans');

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
  let right = 0, n = 0, ms = 0;
  for (const [stamp, truth] of Object.entries(TRUTH)) {
    const file = fs.readdirSync(SCANS).find(f => f.startsWith(stamp) && f.endsWith('.jpg'));
    if (!file) { console.log('skip (photo not here)', stamp); continue; }
    const t = Date.now();
    const res = await fetch(`${BASE}/api/scan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Flip7-Test': '1' }, // not saved to scans/
      body: JSON.stringify({ image: fs.readFileSync(path.join(SCANS, file)).toString('base64') }),
    });
    ms += Date.now() - t;
    const hand = await res.json();
    if (!res.ok) { console.log('ERROR', stamp, hand.error); n++; continue; }
    const got = [[...hand.cards].sort((a, b) => a - b), [...hand.mods].sort((a, b) => a - b)];
    const ok = JSON.stringify(got) === JSON.stringify(truth);
    right += ok; n++;
    console.log(`${ok ? 'ok  ' : 'MISS'} ${stamp} got ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(truth)}`);
  }
  console.log(`\n${right}/${n} correct, ${(ms / Math.max(n, 1) / 1000).toFixed(1)}s per photo`);
})();
