# Flip7yoke installer: spec

Status: planned. Written 5 Nov 2026.

## Goal

Someone who isn't technical can download one file, `Flip7yoke-Setup.exe`, click through it, and run a game night. They shouldn't need to install Node, use a terminal or edit files.

What they get:

- A Start menu entry and a desktop icon, "Flip7yoke", that open the control window (Start, Stop, Open board).
- The board opens in their browser, and phones join by QR code, as they do now.
- An optional card reader ("📷 Snap my cards"). Without it, the camera button is hidden and everything else works.
- An uninstall entry in Windows Settings. Uninstalling keeps their score history unless they tick a box to remove it.

Not in scope: Mac or Linux builds, an MSI, auto-update, or bundling Ollama or the model inside the installer.

## Order of work

1. Card reader on Windows (handover Step 1). Needed so the camera can be tested on this PC first.
2. Settings and data folder.
3. Single exe for the server.
4. Control window changes.
5. Installer script.
6. Build, test on a clean PC, publish a GitHub Release (repo stays private until Ryan says otherwise).

## 1. Card reader on Windows

As in `HANDOVER.md` Step 1:

- Install Ollama for Windows and run `ollama pull qwen3-vl:4b-instruct`.
- `Flip7.ps1` starts Windows `ollama serve` instead of `wsl.exe`, records the PID and stops only that PID. If Ollama is already running (the tray app often is), use it and don't stop it on Stop.
- Check: `node tools/eval-scans.js` gives 15/15. Then retire the WSL copy.

## 2. Settings and data folder

### Data folder

An installed program can't write to `C:\Program Files`. Everything the server writes moves to `%LOCALAPPDATA%\Flip7yoke\`:

| File | Now | Installed |
|---|---|---|
| Current game | `state.json` next to `server.js` | `%LOCALAPPDATA%\Flip7yoke\state.json` |
| Finished games | `history.json` | `...\history.json` |
| Last 30 photos | `scans/` | `...\scans\` |
| Server log | `logs/` | `...\logs\` |
| Settings | `.env` | `...\config.json` |

Rule: if `FLIP7_DATA` is set, use it. Otherwise, if running as the packaged exe, use `%LOCALAPPDATA%\Flip7yoke`. Otherwise (running from the repo), keep using the project folder, so development works as now. The existing `STATE_FILE`, `HISTORY_FILE` and `SCANS_DIR` overrides keep working.

### config.json

Replaces `.env` and the hard-coded values. Example:

```json
{
  "players": ["Ryan", "Gareth", "Rossi"],
  "subtitle": "Thursday game night",
  "wifi": { "ssid": "", "password": "", "auth": "WPA", "showOnBoard": true },
  "cardReader": { "enabled": "auto", "model": "qwen3-vl:4b-instruct", "url": "http://127.0.0.1:11434" },
  "ports": { "main": 7777, "also": 80 }
}
```

- `players` replaces `REGULARS` in `server.js` (line 47). Default for a new install: empty, so the phone page asks for a name.
- `subtitle` replaces the "Thursday game night" text in `public/index.html`. It's served through `/api/info`, not baked into the page.
- `wifi`: if `ssid` is empty, the server reads the current network with `netsh wlan show interfaces` and the password with `netsh wlan show profile name="<ssid>" key=clear`. No admin rights are needed. `showOnBoard: false` hides the join-the-Wi-Fi QR and the password.
- `cardReader.enabled`: `"auto"` means on if Ollama answers and has the model, `true` forces on, and `false` forces off. `/api/info` reports the result, and the phone page hides "📷 Snap my cards" when it's off.
- `ports.also`: already handled. If port 80 is taken, the server logs it and carries on with 7777 (`server.js` line 420).
- If `.env` exists and `config.json` doesn't, migrate the Wi-Fi values once.
- `config.json` is gitignored. The repo ships `config.example.json` with no personal data.
- The server re-reads `config.json` when it changes (same `fs.watchFile` polling as `run.js`), so Settings changes apply without a restart.

## 3. Single exe for the server

Use Node 22's single executable application (SEA) feature: `Flip7yoke-server.exe` is a copy of `node.exe` with our code injected. No Node install is needed on the target PC.

Changes needed, because a SEA can only `require` built-in modules and can't read files beside the script:

- `tools/build.js` writes one bundled script: `server.js` with `public/rules.js` inlined (no bundler needed; it's one file).
- `public/` (`index.html`, `style.css`, `rules.js`, `qrcode.min.js`, fonts) goes in as SEA assets (`sea-config.json` `assets`). The server reads them with `require('node:sea').getAsset()` when packaged, and from disk when not. One helper, `readPublic(name)`, covers both.
- Build steps (in `tools/build.js`, run with `node tools/build.js`):
  1. `node --experimental-sea-config sea-config.json` → `sea-prep.blob`
  2. Copy `node.exe` to `dist\Flip7yoke-server.exe`
  3. Inject the blob with `npx postject` (the only dev-time dependency)
  4. Set the icon and version info with `rcedit` (dev-time only)
- Expected size: about 80 MB as an exe, about 30 MB inside the compressed installer.
- `run.js` (auto-restart when files change) stays for development only and isn't shipped. The control window restarts the exe if it crashes.

## 4. Control window

`Flip7.ps1` stays as PowerShell 5.1 WinForms, ASCII only (handover gotcha).

- Start launches `Flip7yoke-server.exe` from the install folder when it's there, or `node run.js` when run from the repo.
- Stop stops the PIDs it started, never by name (no `pkill`-style kills).
- New **Settings** button: player names (one per line), subtitle, Wi-Fi (prefilled from `netsh`, with a "show on board" tick box), and the card reader on/off. Saves `config.json`.
- The status line shows whether the card reader is ready, missing Ollama, or missing the model, with a "Set up card reader" button that runs the same steps as the installer option.
- An "Open data folder" button opens `%LOCALAPPDATA%\Flip7yoke`.
- The installer ships it as `Flip7yoke.ps1`, and the shortcut runs `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<install>\Flip7yoke.ps1"` (hides the console, not the form).

## 5. Installer

Use Inno Setup 6 (free, scripted, makes a single `Setup.exe`). An MSI (WiX) isn't worth it unless the tool needs to go out across managed company PCs.

`installer\Flip7yoke.iss`:

- Installs to `C:\Program Files\Flip7yoke\`: `Flip7yoke-server.exe`, `Flip7yoke.ps1`, icon, `LICENSE`, third-party licences.
- Start menu and optional desktop shortcut.
- Windows Firewall rule for `Flip7yoke-server.exe`, inbound TCP, Private networks only (`netsh advfirewall firewall add rule ...`). Removed on uninstall.
- Optional task "Set up the card reader (downloads about 4 GB; needs a graphics card with 6 GB or more for good speed)":
  - If Ollama is missing, download and run the official `OllamaSetup.exe` from ollama.com (not bundled).
  - Then `ollama pull qwen3-vl:4b-instruct`, with progress shown in a console window.
  - Skippable; the control window can do it later.
- Finish page: "Launch Flip7yoke" ticked by default.
- Uninstall: removes the program and the firewall rule. It asks before deleting `%LOCALAPPDATA%\Flip7yoke` (score history), and the default is to keep it. It never uninstalls Ollama.

## 6. Release

- Version number in one place (`package.json` `version`), used by the build and the installer.
- `README.md` with screenshots (board, phone, scoring sheet), install steps and the SmartScreen note.
- `LICENSE` (MIT), plus OFL for Big Shoulders and Barlow and MIT for qrcode-generator 1.4.4.
- Disclaimer on the board footer, the README and the installer's first page: "Unofficial score keeper for Flip 7. Not affiliated with The Op." Our own design, no card art from the published game.
- The build produces `dist\Flip7yoke-Setup-<version>.exe`, uploaded to GitHub Releases.
- **Ask Ryan before making the repo or a release public.** Consider a fresh single-commit public repo; the only personal data in code today is `REGULARS`, which this spec removes.

### Code signing

The first release is unsigned. Windows SmartScreen will show "Windows protected your PC"; users click **More info**, then **Run anyway**. The README says so. If it's shared beyond friends, sign it with Azure Trusted Signing (about $10 a month); the build gets one extra `signtool` step.

## Testing

- Development: everything still runs from the repo with `node run.js` and the current `Flip7.ps1`, with no build needed.
- Packaged exe: on a spare port with a temp data folder (`PORT=7799 ALSO_PORT=0 FLIP7_DATA=<scratch>`), check `/board`, `/`, a full round, history, and `/api/info` with the card reader on and off.
- Card reader: `node tools/eval-scans.js` gives 15/15 against the packaged exe.
- Clean PC: install on a Windows 11 machine or VM with no Node or Ollama. Check that:
  - The shortcut works.
  - A phone joins over Wi-Fi (firewall rule).
  - Settings save.
  - The camera button is hidden without Ollama.
  - Uninstall keeps the history unless asked.
- Older phones: the front end rules in the handover still apply (no `??`, `||=`, `createImageBitmap`, bare `color-mix()`).

## Open questions for Ryan

- Name on the Start menu and installer: "Flip7yoke"?
- Should a new install start with no players, or with example names?
- Is a desktop shortcut ticked by default?
