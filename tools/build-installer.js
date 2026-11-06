// Builds dist\Flip7yoke-Setup-<version>.exe and its SHA-256:
//   node tools/build-installer.js            (builds the exe first; --skip-exe reuses dist\Flip7yoke-server.exe)
// Needs Inno Setup 6.7 (ISCC.exe): found via the ISCC environment variable or its usual install folders.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'installer');
const fail = s => { console.error(`\nINSTALLER BUILD FAILED: ${s}`); process.exit(1); };
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// 1. The exe (its own build checks the Node version and smoke-tests it).
if (!process.argv.includes('--skip-exe')) execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });
const exe = path.join(ROOT, 'dist', 'Flip7yoke-server.exe');
if (!fs.existsSync(exe)) fail('dist\\Flip7yoke-server.exe is missing');
const exeVersion = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
if (exeVersion !== version) fail(`the exe is version ${exeVersion} but package.json says ${version}; rebuild without --skip-exe`);

// 2. The control window, stamped with the version, so an installed copy can tell a half-finished install.
console.log('\n== Control window');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const ps1 = fs.readFileSync(path.join(ROOT, 'Flip7.ps1'), 'utf8').replace(/\r\n/g, '\n');
const marker = "$AppVersion = 'dev'\n";
if (!ps1.includes(marker)) fail(`Flip7.ps1 no longer contains ${marker}`);
const stamped = ps1.replace(/\r\n/g, '\n').replace(marker, `$AppVersion = '${version}'\n`);
if (/[^\x00-\x7f]/.test(stamped)) fail('Flip7.ps1 must stay ASCII only (PowerShell 5.1 reads BOM-less UTF-8 as ANSI)');
fs.writeFileSync(path.join(OUT, 'Flip7yoke.ps1'), stamped.replace(/\r?\n/g, '\r\n'));
console.log(`stamped version ${version}`);

// 3. Inno Setup.
console.log('\n== Inno Setup');
const candidates = [process.env.ISCC,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe')].filter(Boolean);
const iscc = candidates.find(p => fs.existsSync(p));
if (!iscc) fail('Inno Setup 6 (ISCC.exe) not found; install it or set ISCC to its path');
execFileSync(iscc, ['/Q', `/DAppVersion=${version}`, path.join(ROOT, 'installer', 'Flip7yoke.iss')], { stdio: 'inherit' });

// 4. Checksum, for the README and the release page.
const setup = path.join(ROOT, 'dist', `Flip7yoke-Setup-${version}.exe`);
const hash = crypto.createHash('sha256').update(fs.readFileSync(setup)).digest('hex').toUpperCase();
fs.writeFileSync(setup + '.sha256', `${hash}  ${path.basename(setup)}\n`);
console.log(`\nBuilt ${path.relative(ROOT, setup)} (${(fs.statSync(setup).size / 1048576).toFixed(0)} MB)\nSHA-256 ${hash}`);
