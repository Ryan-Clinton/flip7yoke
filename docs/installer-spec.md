# Flip7yoke installer: spec

Status: **Stages 1 to 4 built** (5 and 6 Nov 2026), with the audit round 4 corrections. In Stage 5 the README and screenshots are done. Still to do: the clean-PC checks (see "Not checked yet") and the release. Nothing is public. Written 5 Nov 2026; revised after ChatGPT audit rounds 1 (`ac5e102`) and 2 (`d70d3dc`), then where building Stages 1 to 3 showed a better or necessary way (each marked **As built**).

## What's built (Stages 1 to 3)

| Part | Where |
|---|---|
| Safe saving | `lib/store.js` |
| Settings | `lib/config.js`, `config.example.json` |
| Data folder, page files from disk or the exe | `lib/paths.js` |
| Card reader and its states | `lib/reader.js` |
| Join address | `lib/net.js` |
| Game server, `start()` | `server.js` |
| Supervisor, and the server as its child | `lib/supervisor.js`, `lib/child.js`, entry `main.js` (`run.js` in development) |
| Exe build | `tools/build.js` → `dist\Flip7yoke-server.exe` |
| Control window | `Flip7.ps1` (Settings, reader fix buttons, process ownership, `-Action snapshot`) |
| Tests | `npm test` (`tests/game.test.js`, `tests/lifecycle.test.js`); `FLIP7_TEST_EXE=dist\Flip7yoke-server.exe npm test` runs them against the exe |
| Card-reader check | `node tools/eval-scans.js --url <server>` |
| Clean stop from a terminal | `node tools/stop.js [data folder]` |
| Icon | `tools/make-icon.ps1` → `assets\flip7yoke.ico` |
| Installer | `installer/Flip7yoke.iss`; `npm run installer` (`tools/build-installer.js`) → `dist\Flip7yoke-Setup-<version>.exe` + `.sha256` |
| Licences | `LICENSE` (MIT), `THIRD-PARTY-NOTICES.txt`, `licenses/` (Node.js 22.20.0, OFL for Barlow and Big Shoulders, MIT for qrcode-generator; exact texts from their sources) |
| Settings Save test | `tests/control-window.test.js` (fills the real Settings form off-screen and presses Save) |

Results on Ryan's PC (GTX 1080, Windows 11, Node 22.20.0, Ollama for Windows 0.40.14):
- Tests: 25 pass from the repo. Against the exe, 20 pass and 3 are skipped because they test internal modules directly.
- Installer: 22 MB.
- Card reader: 15/15 against the exe, about 5 seconds a photo; it was about 3 on the old WSL Ollama.
- The exe is 82 MB.

## Goal

Someone who isn't technical can download one file, `Flip7yoke-Setup.exe`, click through it, and run a game night. They shouldn't need to install Node, use a terminal or edit files.

What they get:

- A Start menu entry and a desktop icon, "Flip7yoke", that open the control window (Start, Stop, Open board, Settings).
- The board opens in their browser, and phones join by QR code, as they do now.
- An optional card reader ("📷 Snap my cards"). Without it, the camera button is hidden and everything else works.
- An uninstall entry in Windows Settings. Uninstalling keeps their score history unless they tick a box to remove it.

Not in scope, on purpose: Mac or Linux builds, an MSI, auto-update, a Windows service, user accounts, cloud storage, telemetry, a CI pipeline, or bundling Ollama or the model inside the installer. Effort goes on what protects a game night: saved scores, working QR codes, reliable start and stop, and clear messages when something predictable goes wrong.

## Stages

Each stage leaves a working game. `node run.js` from the repo keeps working throughout.

1. **Keep the working game working.** Card reader on Windows, safe saving, gameplay tests.
2. **Make the app portable.** Data folder, `config.json`, optional card reader, network address choice, Settings.
3. **Package the server** as one exe, with process ownership and a check that it behaves the same as `node server.js`.
4. **Build the installer.** Install, upgrade, uninstall, firewall, optional card-reader setup.
5. **Validate and release.** Run the release checklist, then publish only with Ryan's go-ahead.

A ChatGPT audit round follows stage 3, once the portable app and the exe exist.

## Stage 1: keep the working game working

### Card reader on Windows

As in `HANDOVER.md` Step 1:

- Install Ollama for Windows and run `ollama pull qwen3-vl:4b-instruct`.
- `Flip7.ps1` starts Windows `ollama serve` instead of `wsl.exe` and records the PID it started. If Ollama is already running (the tray app often is), use it and leave it running on Stop. Only a PID we started is ever stopped.
- Check: `node tools/eval-scans.js` gives 15/15 (see "Card-reader check" below). Then retire the WSL copy.
- **As built:**
  - Ollama for Windows 0.40.14 is installed and the model pulled. Its log shows the GTX 1080 found through the CUDA 12 build (the CUDA 13 build skips compute 6.1), with all 37 layers on the GPU.
  - 15/15 passes.
  - The score keeper now runs from `C:\Projects\flip7yoke` and the desktop shortcut points there.
  - The WSL Ollama was stopped on 5 Nov 2026. The Windows Ollama tray app now serves port 11434, and the live score keeper gets 15/15 through it, at about 5 seconds a photo. The WSL copy is retired.

### Safe saving

Today `save()` and `saveHistory()` in `server.js` call `fs.writeFile(..., () => {})`. Errors are thrown away, and two quick saves can finish out of order, so an older state can land on disk last. A crash mid-write can leave broken JSON.

Replace both with one small writer, used for `state.json` and `history.json`:

- **One write at a time per file.** If a save is requested while one is in flight, remember only the latest and write it next. The newest state always lands last. History archiving (`archiveGame()` on New game, and Delete history) goes through the same writer.
- **Atomic replace.** Write `state.json.tmp` and flush it. Copy the current `state.json` to `state.json.bak`, then rename the `.tmp` over `state.json`.
- **When Windows refuses the rename** (antivirus or a backup tool holding the file gives `EPERM` or `EBUSY`), retry up to 5 times over about a second. If it still fails, leave `state.json` and `state.json.bak` as they were, report a save error (below), and try again on the next save. The `.bak` is only replaced by a copy of a file that last saved successfully, so it's always a good one.
- **Flush on exit.** `flush()` resolves when every queued write has finished, or rejects with the first error. A clean shutdown (Stage 3) awaits it before exiting and reports the result.
- **On start,** read `state.json`. If it's missing or won't parse, fall back to `state.json.bak` and log that it did. A leftover `.tmp` is ignored and deleted.
- **Errors are visible.** A failed write is logged with the reason and sets a `saveError` flag in `/api/status`. The board shows a small "Scores not saving: <reason>" banner, and the control window's status line shows it too. The flag clears on the next good write.

### Gameplay tests

`tests/game.test.js`, run with `node --test` (built into Node 22, no dependencies). It covers:

- Scoring in all three modes from `public/rules.js`: the Zero (Vengeance round only, Brutal whole game), ÷2 rounding, Lucky 13, Flip 7 bonus, the floor at 0 outside Brutal.
- Server actions against a temp data folder: join, duplicate names, submit and auto-finish a round, edit a score, remove a player, change mode, new game archives to history, delete a history entry, and state surviving a restart (including recovery from a damaged `state.json`).

To make the actions testable, `server.js` exports its action handlers and an explicit `start(options)` function. Loading it does nothing else: no listening, no timers, no reader check. Each entry point calls `start()` itself:

- `run.js` (development) starts `server.js` as a child process, and `server.js` calls `start()` when `require.main === module`.
- The packaged exe's bundle entry (Stage 3) calls `start()` directly, so it doesn't depend on how a SEA sets `require.main`.
- The tests `require()` the file and call `start()` with a temp data folder and port 0, or call the actions without starting it.

### Card-reader check

`tools/eval-scans.js` currently skips photos that aren't there and prints `right/n` for the ones it ran, so a clean run isn't proof of 15/15.

- It takes `--dir <folder>` (default `scans/`) and `--url <server>`.
- It **fails** (non-zero exit) if any of the 15 expected photos is missing, or if any reading is wrong.
- The photos stay out of git (they're photos from Ryan's game night). Only someone with the photos can run this check; that's accepted.

## Stage 2: make the app portable

### Install and data ownership

**Per-user install.** Everything belongs to the person who installed it, so there's never a question of whose profile owns the data:

| What | Where |
|---|---|
| Program | `%LOCALAPPDATA%\Programs\Flip7yoke\` |
| Data and settings | `%LOCALAPPDATA%\Flip7yoke\` |
| Shortcuts | That user's Start menu and desktop |
| Uninstall entry | That user's (HKCU) |

The installer runs without admin. The only step that needs admin is the firewall rule (see Stage 4), which asks once with a UAC prompt.

### Data folder

| File | From the repo (dev) | Installed |
|---|---|---|
| Current game | `state.json` (+ `.bak`) | `%LOCALAPPDATA%\Flip7yoke\state.json` |
| Finished games | `history.json` (+ `.bak`) | `...\history.json` |
| Last 30 photos | `scans/` | `...\scans\` |
| Server log | `logs/` | `...\logs\` |
| Settings | `.env` | `...\config.json` |
| Running-server record | n/a | `...\server.pid.json` |

Folder choice, first match wins: `FLIP7_DATA` env var; `%LOCALAPPDATA%\Flip7yoke` when running as the packaged exe; the project folder when running from the repo. The existing `STATE_FILE`, `HISTORY_FILE` and `SCANS_DIR` overrides still win for their own file.

If the data folder can't be created or written, the server doesn't start. It logs one plain sentence ("Can't write to <folder>: <reason>"), and the control window shows it.

### config.json

Replaces `.env` and the hard-coded values.

```json
{
  "version": 1,
  "players": ["Ryan", "Gareth", "Rossi"],
  "subtitle": "Thursday game night",
  "wifi": { "ssid": "", "password": "", "auth": "WPA", "showOnBoard": true },
  "cardReader": { "enabled": "auto", "model": "qwen3-vl:4b-instruct", "url": "http://127.0.0.1:11434" },
  "network": { "address": "auto" },
  "ports": { "main": 7777, "also": 80 }
}
```

**Precedence**, highest first: environment variables (`PORT`, `ALSO_PORT`, `OLLAMA_URL`, `OLLAMA_MODEL`, used by tests and development), then `config.json`, then built-in defaults. A missing key takes its default, so an old or partial file still works.

**Live or restart:**

| Setting | Takes effect |
|---|---|
| `players`, `subtitle`, `wifi` | Live: the server re-reads `config.json` when it changes (`fs.watchFile` polling). **As built (audit round 4):** every update on `/events` carries a `configVersion` that goes up on each reload. Open pages fetch `/api/info` again when it changes, so names, subtitle, Wi-Fi and the join address update on a board that's already open. Checked in Chrome |
| `cardReader.enabled` | Live: switching it on runs a readiness check, switching it off hides the camera |
| `cardReader.model`, `cardReader.url`, `network.address`, `ports` | On the next Start. The Settings panel says "Restart to apply" and offers a Restart button |

**Validation.** Each value is checked on load:

- Bad JSON: keep running on the last good settings (or defaults on first start), log the line and column, and show "Settings file has an error" in the control window. The bad file is left alone for the user to fix or reset from Settings.
- Bad values are replaced by their default, with a note in the log:
  - Ports must be whole numbers 1 to 65535, and `main` and `also` must differ (`also: 0` means off).
  - Player names are trimmed and checked for duplicates case-insensitively, and blanks are dropped.
  - The card-reader URL must be `http://` or `https://`.
- The Settings panel runs the same checks before saving, so most mistakes never reach the file.

**Field notes:**

- `players` replaces `REGULARS` in `server.js` (line 47). A new install starts empty, so the phone page asks for a name.
- `subtitle` replaces the "Thursday game night" text in `public/index.html`. It's served through `/api/info`, not baked into the page.
- `config.json` is gitignored. The repo ships `config.example.json` with no personal data.
- When it's written (by Settings or a migration), the previous copy is kept as `config.json.bak`.

**Migration from `.env`.** If `.env` exists and `config.json` doesn't, copy `WIFI_SSID`, `WIFI_PASSWORD` and `WIFI_AUTH` into a new `config.json`, then rename `.env` to `.env.migrated` so it isn't read again. The server stops reading `.env` on every request.

### Wi-Fi details

Wi-Fi details are only for the board's join-the-Wi-Fi QR, and only when the host wants it:

- **SSID:** detected with `netsh wlan show interfaces` and offered in Settings. The user can change it.
- **Password:** Settings has a "Read from Windows" button that tries `netsh wlan show profile name="<ssid>" key=clear`. That can fail (policy, permissions, a wired PC, or non-English Windows, where the output labels are translated). If it does, Settings says so and the user types the password or leaves it blank. The server never runs `netsh` itself; it only uses what's in `config.json`.
- **Exposure:** `/api/info` includes the Wi-Fi details only when `showOnBoard` is on and a password or SSID is set. With it off, the QR and password aren't sent to anyone. With it on, they go to every device that loads the page, which is the point of putting them on the board. Settings says so next to the tick box.

### Card reader: optional

Today `warmReader()` runs at start and retries every 15 seconds forever, whether or not Ollama is installed. It becomes a readiness state, reported in `/api/info` and `/api/status`:

| State | Meaning | Phone shows camera |
|---|---|---|
| `off` | `cardReader.enabled` is false | No |
| `checking` | Check in progress | No |
| `no-ollama` | Nothing answers at the reader URL | No |
| `no-model` | Ollama answers but the model isn't pulled | No |
| `ready` | Ollama answers and has the model (**as built:** the model is then preloaded onto the GPU as a best effort; if that fails it loads on the first photo, and the log says so) | Yes |

- **`off`:** never contact Ollama.
- **`auto` or `true`:** both mean on and behave the same. At start, check `/api/version` and `/api/tags`, then warm the model (`keep_alive: -1`). The check runs at most 5 times, 15 seconds apart, so Ollama starting just after us is picked up quickly. After that only the cheap health check below runs.
- **Health check while enabled:** every 30 seconds, `GET /api/version` (cheap, never loads the model). If it stops answering, the state goes to `no-ollama` and the camera hides. If it answers again, the full check runs (tags, then warm the model), and the state goes back to `ready`. While `off`, nothing runs.
- **Re-check on demand:** the control window's "Check card reader" button (or turning it on in Settings) runs the full check immediately. A failed photo read with "can't reach the reader" also triggers one.
- The phone page renders "📷 Snap my cards" only when the state is `ready`. It updates live through `/events`, so the button appears when the reader comes up mid-game.
- Manual scoring never depends on the reader.

### Join address

Today the server lists every IPv4 address, and the board and control window prefer anything starting `192.168.` or `10.`. That can pick a VPN or Hyper-V address the phones can't reach.

- **Private ranges:** `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`.
- **Auto choice** prefers, in order:
  1. The address Windows would use to reach the default gateway, if it's private and its adapter doesn't look virtual. **As built:** found by connecting a UDP socket to a documentation address (`192.0.2.1`), which sends nothing and only asks the routing table. That needs no PowerShell and works offline (it just finds nothing). A full-tunnel VPN owns the default route, so its adapter name sends it to the next rule.
  2. Any private address on an adapter whose name doesn't look virtual (`vEthernet`, `VirtualBox`, `VMware`, `Hyper-V`, `WSL`, `Tailscale`, `ZeroTier`, `VPN`, `Docker`, `Bluetooth`, `Loopback`).
  3. Any private address, then anything else.

  On Ryan's PC this picks the Wi-Fi address over two `vEthernet` adapters in `172.16.0.0/12` (Default Switch and WSL), the exact case the audit raised.

  The server works this out once and returns `joinUrl` plus the full list in `/api/info`. The board and control window use `joinUrl` instead of their own regexes.
- **Manual choice:** Settings lists the addresses, labelled with the adapter name (from `Get-NetIPAddress`), so the user can pick one when auto gets it wrong. It's stored as `network.address` and applied on the next Start.
- No further discovery (mDNS, scanning). A good default plus a picker is enough.

### Who can change the game

Today any device that can reach the server can run every action, including New game, Remove player, Edit score and Delete history. That's how the night works: everyone enters their own score and anyone can fix a mistake.

Kept as is, with two cheap protections:

- **Host check:** the server rejects requests (403) whose `Host` header isn't `localhost`, `127.0.0.1`, `[::1]`, this PC's name (or `<name>.local`), or one of this PC's own addresses (port optional). This stops a web page elsewhere from reaching the game through DNS rebinding. It sits alongside the existing JSON-only rule.
- **Private networks only:** the firewall rule (Stage 4) allows Private networks, not Public, so a café or hotel Wi-Fi can't reach it.

A host PIN for destructive actions is an open question for Ryan (see the end).

### Control window

`Flip7.ps1` stays as PowerShell 5.1 WinForms, ASCII only (handover gotcha). Additions:

- **Settings button:** player names (one per line), subtitle, Wi-Fi ("Detect" fills the SSID, "From Windows" tries the password, "show on board" tick box with the exposure note), card reader on/off, join address picker, ports. It validates before saving.
  - **As built:** instead of a Restart button, the main window's note line says "Settings changed: press Stop, then Start, to apply them". It shows this whenever `/api/status` lists `restartNeeded` keys.
  - It writes `config.json` with a `.bak`, the same as the server.
- **Status line:** the server's state, a save error if there is one, and the card-reader state with a matching action:
  - "Install Ollama" for `no-ollama` when Ollama isn't installed. It runs `winget install Ollama.Ollama` in a visible window, or opens ollama.com/download if winget is missing.
  - "Check again" for `no-ollama` when Ollama is installed.
  - "Download model (3.3 GB)" for `no-model`, which runs `ollama pull` in a visible window.

  Every action ends with `POST /api/reader/check`, which runs the full check now.
- **Open data folder** button for the data folder (`%LOCALAPPDATA%\Flip7yoke` installed, the project folder from the repo).
- **Ollama for Windows:** Start uses an Ollama that's already answering (the tray app usually starts one). It only starts `ollama serve` itself if none is, and records that PID in `logs\ollama.pid`. Stop stops only an Ollama it started.
  - Stop also frees the GPU: if the card reader is on and our model is loaded (`/api/ps`), it unloads just that model (`keep_alive: 0`).
  - **Accepted in audit round 4:** this happens even when something else started that Ollama. Only our model is unloaded, other models and the Ollama process are left alone, and ours reloads on its next use.
- **As built:** `Flip7.ps1 -Action snapshot -Out <folder>` draws the window and Settings to PNGs without showing them on screen, for README screenshots and checks.

## Stage 3: package the server

### Single executable

`Flip7yoke-server.exe` is a Node single executable application (SEA): a copy of `node.exe` with our code and files injected. No Node install is needed on the target PC.

**Pinned build tools,** recorded in `package.json` (`devDependencies` and `engines`) with a lockfile:

- **Node 22.x LTS,** exact version written in `.node-version`. The build refuses to run on any other version, because SEA blobs are tied to the exact `node.exe` they're injected into.
- **`postject`** (1.0.0-alpha.6, published by the Node.js project), exact version. Dev-only; the app still has no runtime dependencies.
- **As built: no `rcedit`.** Every `rcedit` version on npm now carries "Package no longer supported. Contact Support", which is npm's wording for a pulled package. Its origin couldn't be confirmed, so it was removed without being run. The exe keeps Node's icon and "Node.js" file description, which show in Task Manager. The shortcuts use `assets\flip7yoke.ico`. The version comes from `Flip7yoke-server.exe --version` rather than file metadata. Revisit with a trusted resource editor, or by signing, later.

**What goes in.** A SEA can only `require` built-in modules and can't read files beside itself. `tools/build.js`:

- Writes one script, `build/bundle.js`. **As built:**
  - Every local module (`main.js`, `server.js`, `lib/*.js`, `public/rules.js`, `package.json`) goes into a table of functions, each with its own `module` object. A small `require` resolves relative paths in that table, and anything else goes to Node's `require`, which in a SEA means built-ins only.
  - `public/rules.js` is included byte for byte and called with `this` = `module.exports`, so its existing `module.exports` branch runs unchanged.
  - The build fails if any local `require` points outside the bundle.
- Builds an asset manifest from the files in `public/` (including each font). It replaces the `readdirSync` of `public/fonts`, and the `STATIC` allow-list is generated from it.
- Writes `sea-config.json` with the bundle as `main` and every manifest file as an `asset`.

**How the server reads its files.** One helper, `readPublic(name)`, always returns a Node `Buffer`. When packaged it uses `Buffer.from(sea.getAsset(name))`, because `getAsset` returns an `ArrayBuffer`. When not packaged it reads from disk. Packaged detection is `require('node:sea').isSea()`.

**Entry point.** `main.js`, called explicitly by the bundle. `--serve` runs the server (`lib/child.js`, which calls `start()`), `--version` prints the version, and no argument runs the supervisor. It never relies on `require.main`. The build's smoke test (step 6) catches an exe that starts and exits without listening.

**Same scoring everywhere.** The browser's `/rules.js` is served from the same asset as the inlined copy. The build checks the two are byte-identical, so the server and phones can't drift apart.

**Build steps** (`node tools/build.js`):

1. Check the Node version.
2. Bundle, build the manifest and write `sea-config.json`.
3. `node --experimental-sea-config sea-config.json` makes `sea-prep.blob`.
4. Copy `node.exe` to `dist\Flip7yoke-server.exe` and remove its signature with `signtool remove /s` if signtool is installed. Without it, the now-invalid Node.js signature is left in place; postject warns about it, and Windows still runs the exe.
5. Inject the blob with `postject`, using the SEA sentinel fuse.
6. Smoke test:
   - `--version` matches `package.json`.
   - Started on a spare port with a throwaway data folder, it answers `/api/status` with the token from `server.pid.json` and serves the board.
   - It stops cleanly through the control channel, with `saved: true` and exit code 0.

**Size:** 82 MB as an exe; expected about 30 MB inside the compressed installer.

### Supervisor and lifecycle

The control window is a remote control, not a babysitter. Closing it leaves the game running, as now.

- **Crash restarts:** `Flip7yoke-server.exe` started normally acts as a small supervisor. It starts a second copy of itself with `--serve` and restarts it within about 2 seconds if it crashes, the same job `run.js` does in development. It gives up after 5 crashes in a minute and logs why. It never runs as a Windows service.
- **The supervisor owns stopping.** The child is spawned with an IPC channel (`stdio: ['ignore', out, out, 'ipc']`). Every intentional stop goes through the supervisor:
  1. The supervisor sets "stopping", so no restart can happen from here on.
  2. It sends the child `{ stop: true }` over IPC.
  3. The child stops accepting actions, awaits `flush()`, replies `{ stopped: true, saved: true|false, error }`, and exits.
  4. The supervisor writes the result to the log, deletes `server.pid.json`, and exits.

  If the child hasn't exited 5 seconds after the request, the supervisor kills it. Any child exit while not "stopping" counts as a crash.
- **Child never outlives the supervisor:** if the supervisor dies (killed, crashed), Node closes the IPC channel. The child sees `disconnect`, awaits `flush()`, and exits, which frees port 7777. On Windows a killed parent doesn't take its children with it, so this is how the child knows.
- **The record of what's running:** on start, the supervisor writes `server.pid.json` to the data folder. It holds the supervisor PID, the child PID, each one's start time, the exe path, the ports, a random instance token and the supervisor's control port. `/api/status` returns the same token.
- **Control channel:** the supervisor listens on `127.0.0.1` on a random port (recorded in `server.pid.json`) and accepts exactly one request, `POST /stop`, carrying the token. It answers once the stop above has finished, with the saved/error result.
- **Is this ours?** The control window treats the server as running only if all of these hold:
  - The PID in `server.pid.json` exists.
  - Its start time and exe path match the record.
  - `/api/status` answers with the same token.

  A response on port 7777 with no matching token is someone else's program, and the status says "Port 7777 is in use by another program".
- **Stop (control window):**
  1. Call the supervisor's `POST /stop` and wait up to 10 seconds for its answer. If the answer reports `saved: false`, show "Last scores may not have saved: <error>".
  2. If there's no answer, stop the recorded supervisor PID and child PID, each only after checking its start time and exe path still match the record.
  3. Delete `server.pid.json` if it's still there.

  There's no shutdown endpoint on the game server, so no phone can stop it.
- **One copy only:** Start does nothing if a valid record exists. A stale record (PIDs gone, or now belonging to a different program) is deleted and Start carries on.
- **Port taken:** if the main port is taken, the server exits with a clear message, and the control window shows it with a pointer to the Ports setting. If port 80 is taken, the server carries on with 7777, as now.
  - **As built:** the server exits with code 2 when it can't start (port taken, data folder not writable). The supervisor treats that as final rather than a crash, writes the message to `server.error.txt` in the data folder, and exits. The control window shows "Last start failed: <message>". A good start deletes the file.
  - The control window also names another program on the port before Start is pressed. It does this when the port answers without our token.
- **Second copy (revised after audit round 4):** a supervisor claims the instance before starting anything, by creating `server.pid.json` exclusively (`wx`). Of two started at the same moment only one can, and the other exits ("already running").
  - An existing record means "running" if its control port answers `/ping` with its token, or if its supervisor is alive and started under 15 seconds ago (it may not be listening yet). Otherwise the record is stale: it's removed and the claim is retried.
  - A supervisor only deletes the record if it still holds its own token. The first version let a losing second copy delete the winner's record, so the control window lost track of a running server. `tests/lifecycle.test.js` now covers this.
  - Replacing the record retries for about 2 seconds when Windows refuses because another process has it open (the control window reads it every 2 seconds). It never crashes the supervisor: testing caught one doing exactly that under load.
- **A record that can't be written (audit round 5):**
  - If the first full record (with the control port) can't be written, no server is started. A server nothing could stop properly is worse than none. The reason goes in `server.error.txt`.
  - Later failures are retried every 5 seconds. Until one works, the supervisor tells the server, `/api/status` carries `recordError`, and the control window says so. `tests/lifecycle.test.js` covers this by making the record read-only mid-game.
- **No usable record, but running (audit round 5, installed copies only):** the control window also looks for `Flip7yoke-server.exe` processes started from its exact install folder.
  - Status shows them as "Running without its record".
  - Stop ends their supervisors, and each server saves and exits when its supervisor goes. Stop then exits with 2 (save not confirmed), so the installer asks before replacing anything, or with 3 if anything is still there.
  - From the repo this check is off: test servers run the same `main.js` as the real game, so only the record can tell them apart.
- **Logs (as built):** the supervisor writes its own and the server's output to `logs\server.log` in the data folder. It moves it to `server.old.log` once it passes 5 MB.
- **Development:** from the repo, `run.js` (which loads `main.js`) is the supervisor. It writes the same `server.pid.json`, uses the same IPC stop and control channel, and keeps its file-watching restarts. A watch restart is a supervisor-initiated stop then start, not a crash. The control window works the same way in both setups, and the command-line matching in `Get-FlipProcs` is gone.

### Same behaviour check

The gameplay and lifecycle tests run twice: from the repo (`npm test`) and against `dist\Flip7yoke-server.exe` (`FLIP7_TEST_EXE` set). In exe mode, the server tests start the exe with `--serve` and stop it over IPC. The lifecycle tests run the exe as the supervisor. `tools/eval-scans.js --url` runs against the exe as well.

## Stage 4: build the installer

Inno Setup 6, version pinned in the README's build notes. `installer\Flip7yoke.iss`:

- **Per-user** (`PrivilegesRequired=lowest`), installing to `%LOCALAPPDATA%\Programs\Flip7yoke\`: `Flip7yoke-server.exe`, `Flip7yoke.ps1`, icon, `LICENSE`, third-party licences.
- **Fixed `AppId`,** so a later installer recognises an existing install as an upgrade.
- **Start menu shortcut,** plus a desktop shortcut as a ticked option. Both run `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<install>\Flip7yoke.ps1"`. `Bypass` applies to this one script only, so a normal machine policy doesn't block it; it doesn't change any system setting. Where Group Policy forbids PowerShell scripts outright, the control window won't open. The README says so, and the server can still be started by running `Flip7yoke-server.exe` directly.
- **Firewall:** an inbound rule named "Flip7yoke" for the program `<install>\Flip7yoke-server.exe`, TCP, Private networks only.
  - It's tied to the program, not to port numbers, so changing ports in Settings doesn't need a new rule.
  - Added with `netsh advfirewall firewall add rule` run elevated, so there's one UAC prompt.
  - If the user says no, the install carries on and the finish page says phones can't connect yet. Windows may or may not ask by itself later, so nothing relies on that.
  - Uninstall removes the rule, with one more UAC prompt.
- **Firewall in the control window:**
  - On Start it checks whether the rule exists and points at this install's exe. `netsh advfirewall firewall show rule name=Flip7yoke verbose` needs no admin.
  - If the rule is missing or points elsewhere (for example, after moving the install), the status line says "Phones may be blocked by the firewall" with an "Allow phones" button. The button runs the same elevated `netsh` (one UAC prompt) and checks again.
  - The check can't see third-party firewalls or a router that isolates Wi-Fi clients, so the message says "may".
- **Optional task, "Set up the card reader":** downloads about 4 GB, and needs a graphics card with 6 GB or more for good speed.
  - If Ollama answers on 11434 or is installed, skip installing it.
  - Otherwise download the official `OllamaSetup.exe` from ollama.com (not bundled) and run it.
  - If the model is already pulled, skip the download.
  - Otherwise run `ollama pull qwen3-vl:4b-instruct` in a visible console with its progress.
  - Any failure leaves the install complete, with the card reader off. The control window's status line offers the same steps later.
- **Finish page:** "Launch Flip7yoke" ticked by default.

### Upgrades

- **Detection:** Inno finds the existing install by `AppId` and installs over it in the same folder.
- **Stopping the server:**
  - Before copying files, the installer runs `Flip7yoke.ps1 -Action stop`. That's a clean shutdown, so the current game is saved.
  - It then checks that `Flip7yoke-server.exe` isn't running, using the PID in `server.pid.json`.
  - If the server won't stop, the installer stops with "Close Flip7yoke and try again" and changes nothing.
- **Data is never touched by the installer.** Scores and settings live in `%LOCALAPPDATA%\Flip7yoke`, outside the program folder, so a failed or cancelled upgrade can't remove them.
- **Interrupted upgrades: repair, not rollback.**
  - If the user presses Cancel, Inno Setup undoes what it can.
  - If setup is killed or the PC loses power halfway, the program folder may be half old, half new, and the app may not start. The fix is to run the installer again (it repairs over the top). Older installers stay on GitHub Releases as a way back.
  - No transactional update system.
- **Detecting a broken install:** the control window checks that `Flip7yoke-server.exe` exists and that `Flip7yoke-server.exe --version` matches the version stamped into `Flip7yoke.ps1` (`$AppVersion`) at build time. If either fails, it says "Flip7yoke didn't finish installing. Run the installer again." and doesn't start. **As built:** "installed" is decided by the version stamp (the repo's copy says `dev`), not by the exe being present. The first version decided it by the exe, so a missing exe made the window treat the install folder as a repo copy; testing caught that.
- **Settings changes between versions:**
  - `config.json` has a `version` number. The new server migrates old versions on first start, after saving a copy as `config.v<old>.json`. **As built:** there is only version 1 so far, so no migration code exists yet; it gets written alongside the first change of shape.
  - `state.json` and `history.json` get the same treatment if their shape ever changes. They're backed up as `*.v<old>.json` before migrating, and the old copy is never overwritten.
- **Running game:** after an upgrade, Start resumes the saved game where it left off (the auto-finish timer resets, as it does now on restart).

### Uninstall

- Stops the server the same way.
- Removes the program, shortcuts and firewall rule.
- Asks whether to delete `%LOCALAPPDATA%\Flip7yoke` (score history and settings); the default is to keep it.
- It never uninstalls Ollama or the model.

### Stage 4 as built

- **Script:** `installer/Flip7yoke.iss`, built by `npm run installer` with Inno Setup 6.7.3 (the build looks for `ISCC.exe` in the `ISCC` env var and the usual install folders). The build:
  - Builds and smoke-tests the exe first (`--skip-exe` reuses `dist\Flip7yoke-server.exe` if its `--version` matches).
  - Stamps the version into a copy of `Flip7.ps1` (installed as `Flip7yoke.ps1`), checking it's ASCII only.
  - Writes `dist\Flip7yoke-Setup-<version>.exe`, 22 MB, and its `.sha256`.
- **Install:** per-user (`PrivilegesRequired=lowest`) into `%LOCALAPPDATA%\Programs\Flip7yoke`, with a fixed `AppId`. It creates a Start menu shortcut, plus a desktop shortcut (ticked by default). The welcome page carries the disclaimer.
- **Tasks:**
  - **Firewall** (ticked): runs `Flip7yoke.ps1 -Action allow-phones`. The window's "Allow phones" button is the same code.
  - **Card reader** (unticked): runs `Flip7yoke.ps1 -Action setup-reader` in a visible console without holding up the installer. The window's "Install Ollama" and "Download model" buttons run the same thing.
- **Firewall check:** `Get-NetFirewallApplicationFilter -Program <exe>` with the rules it belongs to, which needs no admin. That replaces parsing `netsh show rule`, whose labels are translated on non-English Windows.
  - It accepts **any** enabled inbound Allow rule covering Private networks, including the ones Windows makes itself from its "Allow access?" prompt.
  - A Block rule covering Private networks is reported as blocked, with a pointer to Windows Security.
  - In the window it's refreshed every 30 seconds, and after Start or Allow phones.
- **Windows' own prompt:** the first time an exe at a new path listens, Windows Defender Firewall may show its own "Allow access?" prompt.
  - With no `rcedit`, the prompt calls the program "Node.js JavaScript Runtime".
  - The rule it makes can cover Public networks too, if both boxes are ticked.
  - Uninstall removes only our own "Flip7yoke" rule (`-Action remove-firewall`, one UAC prompt only if that rule exists). Rules Windows made from its prompt are left alone.
- **Upgrades (revised after audit round 4):** `PrepareToInstall` runs the installed `Flip7yoke.ps1 -Action stop`, and only a verified clean stop lets files be replaced. The stop action exits with:

  | Code | Meaning | Installer |
  |---|---|---|
  | 0 | Stopped cleanly with every save confirmed, or nothing was running | Goes ahead |
  | 2 | Stopped, but the last save wasn't confirmed (it failed, or the server had to be ended) | Asks, default **No**. A silent install takes No and stops |
  | 3 | Something recorded is still running | Stops |
  | anything else, or PowerShell couldn't be started | Not verified | Stops |

  Each stop leaves "Nothing was changed". Uninstall uses the same check. Tested: with saving broken mid-game, a silent upgrade refused (setup exit code 7) and left the installed files untouched.
- **Uninstall:**
  - `InitializeUninstall` stops the server the same way.
  - `[UninstallDelete]` removes the program folder if it's left empty.
  - The keep-or-delete question uses No as its default. A silent uninstall never deletes data.

## Stage 5: validate and release

### Checked so far (Ryan's PC, 6 Nov 2026, silent installs with no desktop, firewall or reader tasks)

Passed:
- **Install:** files, licences, uninstall entry, Start menu shortcut and stamped version all correct, with no admin rights needed. The existing desktop shortcut was untouched.
- **Upgrade with a game in progress:** setup stopped the running copy through its supervisor. The in-progress game (a player with 7+8 entered) was saved and came back after Start.
- **Exe missing:** the control window says "didn't finish installing" and refuses to start (exit code 1), and writes nothing into the program folder. That's the second version; the first one failed this check, as noted above.
- **Setup killed, then run again:** the kill landed after the files had been copied, so it didn't make a half-copied folder. Rerunning setup repaired over the top and the app worked.
- **Uninstall (silent):** program, shortcut and uninstall entry gone, the program folder removed, and the data kept.
- **Settings Save** (`tests/control-window.test.js`): it writes a `config.json` the server accepts without corrections, keeps a one-player list as a list, writes `.bak`, and refuses duplicates and clashing ports without touching the file.

### Clean-PC acceptance test (to do before any release)

On a Windows 10/11 PC or VM without Node or Ollama, using `dist\Flip7yoke-Setup-<version>.exe`. Fill in the last column. Use a fresh PC or VM, or Windows Sandbox, which needs enabling first.

| # | Do | Expect | Result |
|---|---|---|---|
| 1 | Run Setup, leave the defaults, say **Yes** to the Windows Command Processor prompt | Installs without asking for an admin password; desktop and Start menu shortcuts; finish page with "Launch Flip7yoke" ticked | |
| 2 | Finish with Launch ticked | The Flip7yoke window opens; card reader says Ollama isn't installed | |
| 3 | Press Start | Board opens in the browser; "Firewall: ok" (no "Phones may be blocked") | |
| 4 | Scan the board's QR with a phone on the same Wi-Fi, join, score a round | Works; no camera button on the phone | |
| 5 | Settings: add names, a subtitle, Wi-Fi (try **Detect** and **From Windows**), Save | The board updates without reloading; Wi-Fi QR appears | |
| 6 | Uninstall from Windows Settings, answer **No** to deleting scores | Program and shortcuts gone; `%LOCALAPPDATA%\Flip7yoke` still there | |
| 7 | Install again, but say **No** to the Windows prompt | Install still completes; window shows "Phones may be blocked" with **Allow phones**; pressing it and saying Yes fixes it | |
| 8 | Card reader: press **Install Ollama** (needs about 4 GB and time) | A console installs Ollama and downloads the model; the camera button appears on phones without a restart | |
| 9 | Run the same Setup again while a game is running | Game saved and still there after Start | |
| 10 | Uninstall, answer **Yes** to deleting scores | `%LOCALAPPDATA%\Flip7yoke` gone; firewall rule gone (Windows Security > Firewall > Allowed apps); Ollama still installed | |

### Release checklist (manual)

Run on a Windows 11 VM with no Node or Ollama, unless a line says otherwise.

| Check | Expected |
|---|---|
| Fresh install, no Ollama | Shortcut works, board opens, a phone joins over Wi-Fi, the camera button is hidden |
| Card-reader task on a PC with Ollama already running | No reinstall, model pulled only if missing, camera appears |
| Ollama installed, model missing | Status says "Download model", manual scoring works |
| Ollama stopped mid-game | Camera hides within about 30 seconds without anyone trying a photo, game carries on; starting Ollama brings it back within about 30 seconds |
| Firewall UAC declined | Install completes, finish page explains, control window shows "Phones may be blocked" and "Allow phones" fixes it |
| Port 7777 taken by another program | Clear message, no false "Running" |
| Port 80 taken | Runs on 7777 |
| Wi-Fi disconnected, or wired-only PC | Server runs, board shows the address it has, Settings Wi-Fi read fails politely |
| VPN or Hyper-V adapter present | Auto join address is the home network one; picker can override |
| Bad `config.json` (broken JSON, duplicate ports, duplicate names) | Understandable message, game still starts |
| Upgrade with a game in progress | Game and history intact afterwards, settings kept |
| Installer cancelled halfway | Data intact; the old install still runs |
| Installer killed halfway | Data intact; the control window says to run the installer again, and rerunning it gives a working install |
| Stop from the control window right after a score is entered | That score is in `state.json` after Stop |
| Kill the supervisor PID by hand | The child saves and exits within a few seconds, and port 7777 is free |
| Stop, then Start straight away | No restart race, one server running |
| Uninstall, keep data, reinstall | History is back |
| Uninstall, delete data | Folder gone, firewall rule gone |
| Close the control window, kill the `--serve` process | Supervisor restarts it, phones reconnect |
| Older phones (handover list) | Phone page works; no `??`, `||=`, `createImageBitmap`, bare `color-mix()` |
| Gameplay tests against the exe | Pass |
| `eval-scans.js --url` against the exe (needs the photos) | 15/15, exit code 0 |

### Release

- Version number in one place (`package.json` `version`, now 0.9.0), used by the build (`--version`), the control window stamp and the installer.
- `README.md` with screenshots (board, phone, scoring sheet), install steps and build notes. **Done:**
  - The screenshots are in `docs/images/`, made from a demo game with invented names and Wi-Fi details.
  - It covers Windows' own firewall rules that uninstall leaves, how to check the SHA-256, privacy of card photos, who can change the game, and troubleshooting.
  - **Unsigned installer:** the first release is unsigned, so Windows SmartScreen shows "Windows protected your PC". The README says why, says to download only from the project's GitHub Releases page, and lists the file's SHA-256 so people can check it's the real one. Only then does it say that **More info**, then **Run anyway**, proceeds. It doesn't present warnings in general as something to click past.
- `LICENSE` (MIT), plus OFL for Big Shoulders and Barlow and MIT for qrcode-generator 1.4.4.
- Disclaimer on the board footer, the README and the installer's first page: "Unofficial score keeper for Flip 7. Not affiliated with The Op." Our own design, with no card art from the published game.
- The build produces `dist\Flip7yoke-Setup-<version>.exe` and its SHA-256, uploaded to GitHub Releases.
- **Ask Ryan before making the repo or a release public.** Consider a fresh single-commit public repo. The only personal data in code today is `REGULARS`, which Stage 2 removes.

### Code signing

Later, if it's shared beyond friends: Azure Trusted Signing (about $10 a month). The build gets one extra `signtool` step, for both the server exe and the installer.

## Open questions for Ryan

- Name on the Start menu and installer: "Flip7yoke"?
- Should a new install start with no players, or with example names?
- Should the desktop shortcut be ticked by default? (Spec assumes yes.)
- **Host PIN:** should New game, Delete history and Remove player need a PIN typed on the phone? Recommendation: no, at least for the friends release. Anyone at the table can already fix scores, the server is only reachable on Private networks, and the Host check covers the web-page route. A PIN adds a step on game night to guard against your own friends.
