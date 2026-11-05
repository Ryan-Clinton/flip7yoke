# Flip7yoke handover

Handover from Claude Code in WSL to Claude Code on Windows (PowerShell), 5 Nov 2026, after the first game night.
Ryan owns this. Read **How Ryan wants you to work** before anything else.

## What it is

A scorekeeper for Ryan's Thursday Flip 7 night (regulars: Ryan, Gareth, Rossi, Chris, Carlo, Jarvis, Rita).

- The PC shows a big scoreboard at `/board`, with QR codes for joining the Wi-Fi and opening the game.
- Everyone opens the game on their phone over the home Wi-Fi, taps their name, and enters their own score each round. They can tap cards in as they are dealt, type a score, or **photograph their hand**, which a local vision model reads.
- The round finishes by itself 5 seconds after everyone has saved a score. History, a leaderboard and three rule sets are built in.

It went down very well on the first night (5 Nov). It's an unofficial fan tool, not affiliated with The Op, who publish Flip 7.

Repo: `github.com/Ryan-Clinton/flip7yoke` (private). Branch `main`. Ryan's rule is to commit and push finished work to main without asking.

## Where things are right now (the WSL/Windows split)

| Part | Runs on | How |
|---|---|---|
| Project files and git | **WSL** `/home/facepipe/flip7` (copied to `C:\projects\flip7yoke` at handover) | |
| Score keeper `run.js` → `server.js` | **Windows** Node v22 | `node \\wsl.localhost\Ubuntu\home\facepipe\flip7\run.js`, started by the control window |
| Control window `Flip7.ps1` | **Windows** PowerShell 5.1 WinForms | Desktop shortcut "Flip7yoke" and `start.bat` |
| Card reader | **WSL**: Ollama 0.40.14 in `~/ollama`, model `qwen3-vl:4b-instruct` on the GTX 1080 (8 GB) | `Flip7.ps1` starts it with `wsl.exe -e bash -lc "... exec ~/ollama/bin/ollama serve"` and writes a PID file to `~/ollama/serve.pid`. Windows reaches it at `127.0.0.1:11434` |
| Board | Windows Chrome | `http://localhost:7777/board` |

Ollama is **not** installed on Windows yet (`Get-Command ollama` finds nothing). Windows has Node v22.20 and git 2.50.

## The job: make it Windows-only, then release it

### Step 1: run from `C:\projects\flip7yoke` with Ollama for Windows
1. Install Ollama for Windows (`winget install Ollama.Ollama`). It supports the GTX 1080 (compute 6.1) through its CUDA 12 build. On Linux the CUDA 13 build skipped the card and v12 picked it up; check the server log on Windows shows the GPU being found.
2. `ollama pull qwen3-vl:4b-instruct` (3.3 GB). **It must be the `-instruct` variant**; see the card reader section.
3. Change `Flip7.ps1` `Start-Flip`/`Stop-Flip` to start and stop Windows `ollama serve` instead of `wsl.exe`. Keep the PID-file approach, or stop `ollama.exe` by PID. Ryan's rule bans `pkill`; stopping specific PIDs that we started is fine. The Ollama tray app may also auto-start; handle "already running".
4. Repoint the desktop shortcut `Flip7yoke.lnk` (it currently runs the WSL path of `Flip7.ps1`). `start.bat` already uses `%~dp0`.
5. Check: Start → board opens → a phone joins → snap a photo → `node tools/eval-scans.js` gives 15/15.
6. Then stop the WSL Ollama for good (`kill $(cat ~/ollama/serve.pid)` in WSL) and tell Ryan the WSL copy is retired.

### Step 2: make it shareable
- **Settings instead of hard-coding:** `REGULARS` in `server.js` (Ryan's friends' names), the "Thursday game night" subtitle in `public/index.html`, the model name, whether to show the Wi-Fi password on the board. A small `config.json` (gitignored) plus a Settings panel in `Flip7.ps1` would suit.
- **Wi-Fi details:** read them automatically with `netsh wlan show interfaces` and `netsh wlan show profile name="<ssid>" key=clear`, the same way the current `.env` was made (the password needs no admin rights there).
- **Make the camera optional:** if Ollama isn't installed, hide "📷 Snap my cards". Everything else works without it.
- **`Install.ps1`:** winget Node LTS (+ Ollama optional), pull the model, add a firewall rule for node on Private networks, create the shortcut.
- **README** with screenshots, MIT `LICENSE`, plus the licences for the bundled fonts (OFL: Big Shoulders, Barlow) and `qrcode.min.js` (qrcode-generator 1.4.4, MIT).
- **Disclaimer:** "Unofficial score keeper for Flip 7. Not affiliated with The Op." The design is our own, inspired by the deck; don't use their card art.
- **Release:** zip on GitHub Releases. **Ask Ryan before making the repo public.** Consider a fresh single-commit public repo. Git history is clean (checked: no `.env`, state, photos or logs were ever committed); the only personal data in code is `REGULARS`.

## Files

| File | What |
|---|---|
| `run.js` | Launcher: runs `server.js` and restarts it within ~2s when `server.js`, `public/rules.js` or `.env` change (`fs.watchFile` polling, because change events don't fire on `\\wsl.localhost` paths). Restarts on crash. |
| `server.js` | Zero-dependency Node HTTP server. Shared state over SSE (`/events`), actions via `POST /api/action` (JSON only: a CORS preflight blocks cross-site posts), `/api/scan` (card reader), `/api/info`, `/api/status`, `/api/history`, static allow-list. Listens on 7777 **and port 80** (`ALSO_PORT`), because one Samsung's Chrome couldn't reach `:7777`. |
| `public/rules.js` | Scoring for classic, vengeance and brutal. Shared by server (`require`) and browser (`<script>`). |
| `public/index.html` | The whole front end: phone view `/`, board view `/board`, scoring sheet, menu, history. |
| `public/style.css` | "The deck on the felt" design: cream card stock, Deco frames, shell fans, a deck colour per player, royal-blue felt. Fonts self-hosted in `public/fonts/`. |
| `public/qrcode.min.js` | Local copy (sha384 matches the cdnjs 1.4.4 file), so the board works offline. |
| `Flip7.ps1` | WinForms control window with Start/Stop, live status and buttons. Also `-Action start|stop|status`. |
| `start.bat` | Opens `Flip7.ps1` hidden-console. |
| `tools/eval-scans.js` | Card-reader accuracy test against 15 real photos checked by eye. Sends `X-Flip7-Test` so test runs aren't saved to `scans/`. |
| `.env` | **gitignored.** `WIFI_SSID`, `WIFI_PASSWORD`, `WIFI_AUTH`, used for the board's join-the-Wi-Fi QR. |
| `state.json` / `history.json` / `scans/` / `logs/` | **gitignored** runtime data: the current game, finished games, the last 30 photos and readings, and server output (`logs/server.log` holds each device's user agent). |

Env overrides: `PORT` (7777), `ALSO_PORT` (80, 0 = off), `STATE_FILE`, `HISTORY_FILE`, `SCANS_DIR`, `OLLAMA_URL` (`http://127.0.0.1:11434`), `OLLAMA_MODEL` (`qwen3-vl:4b-instruct`).

## Rules as Ryan's group plays them
- **Classic** (original deck): 0-12, +2..+10, ×2, Flip 7 +15, Second Chance.
- **Vengeance**: 0-13, −2..−10, ÷2 (halve, round down, then subtract), round scores floor at 0. **The Zero: that round scores 0 unless you Flip 7.** This is the publisher's ruling, relayed on BoardGameGeek thread 3658512: "Only the current round score equals zero." Lucky 13 allows a second 13. Unlucky 7 discards the others and scores as 7.
- **Brutal**: Vengeance plus negative round scores, modifiers can hit busted players, a Flip 7 can give −15 to another player, and **The Zero wipes the whole game total** (Ryan's house rule, Brutal only).
- Target 200. History stores games by player name. Wins only count for games that reached the target.

## Card reader: hard-won details (don't undo these)
- **Model:** `qwen3-vl:4b-instruct`. The non-instruct Qwen3-VL "thinking" models took 15-60s and gave inconsistent results (they think even with `think:false`). The 8B didn't fit on the 1080 (12% on the CPU), was slower, and missed cards.
- **Speed:** about 3s a photo. Most of it is a fixed ~2.2s of image processing: Ollama resizes every image to ~1080 tokens, so a smaller upload doesn't help and flash attention didn't either. A compact one-line JSON answer halves the answer time. `keep_alive: -1` and a warm-up load at server start remove the ~4s first-photo load.
- **Prompt and schema:** list **each physical card once** as `{colour, kind, banner, big}`, then work out values in `readCards()`.
  - Red = modifier (in Vengeance every modifier is red and every number card is cream).
  - The **banner word** decides the number (SIX vs NINE fixes the sideways 6/9 problem).
  - Signed symbols are always modifiers.

  Plain `{numbers, modifiers}` lists scored 11/15 because the model counted a −8 as a number 8 too, causing false busts. The current version scores 15/15, twice.
- Specials are not asked for, because the model invented them. Two 13s in a Vengeance photo → Lucky 13. Unlucky 7 scores as a plain 7 (it has already discarded the rest). Second Chance doesn't affect a finished hand.
- Ollama `format` takes a JSON schema; keep `temperature: 0`.

## Gotchas found the hard way
- **Phones:** one Samsung (Android 10) got "site can't be reached" in **Chrome** but worked in **Samsung Internet**. It was on the right Wi-Fi (192.168.1.141) and the PC could ping it. Port 80 was added as a fallback. The page sets `<meta name="color-scheme" content="only light">` because Samsung Internet's forced dark mode inverts it.
- **Older browsers:** no `||=`, `??`, `createImageBitmap` or bare `color-mix()`/`inset` in the front end. Fallback declarations sit before the `color-mix` lines; keep that up.
- **WinForms:** launching `Flip7.ps1` with `Start-Process -WindowStyle Hidden` hides the **form** too. The shortcut uses `powershell -WindowStyle Hidden -File ...`, which only hides the console. Flat buttons don't grey out when disabled, so `Update-Status` recolours them.
- **Keep `Flip7.ps1` ASCII only** (PowerShell 5.1 reads BOM-less UTF-8 as ANSI).
- **Server changes need a restart** to take effect. The launcher does it automatically; pages and CSS are read fresh on every request. After changing anything, restart and **check the live result yourself**. Ryan was annoyed when told to restart things by hand.
- **Testing from WSL:** headless Chrome via playwright-core (`~/.npm/_npx/.../playwright-core`) against a spare port (`PORT=7799 ALSO_PORT=0 STATE_FILE=... HISTORY_FILE=... SCANS_DIR=...`) so the live game is untouched. On Windows, set up something equivalent.

## How Ryan wants you to work
- **Act, don't hand back.** Do restarts and follow-up steps yourself. "Try again" means retry now. He got angry about having to repeat himself.
- Commit and push finished work to `main` without asking. Add files by name. Never commit personal documents or photos.
- Never use `sed -i` (use the Edit tool). Never run `pkill`. Never write to `/tmp`.
- Plain, direct answers. Don't use blockquotes or em dashes in replies.
- Ask before anything outward-facing that's hard to undo, such as making the repo public.

## State at handover
- All commits on `main`, all pushed. The live game on the night was Vengeance; the lads have gone home.
- `scans/` holds the 15 photos from the night that `tools/eval-scans.js` uses (copied to Windows with the project).
- The WSL setup is still what's running until Step 1 is done.
