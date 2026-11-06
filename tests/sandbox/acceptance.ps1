# Clean-PC acceptance test, run inside Windows Sandbox by tools/sandbox-test.js (a clean Windows with no Node or
# Ollama). Part A is automatic; parts B and C ask the person at the sandbox window to click through the normal
# installer and uninstaller, and check what happened. Results go to C:\fy\results (a folder on the host).
# Keep this file ASCII only (Windows PowerShell 5.1).
# -PartAOnly -NoHost: the automatic part only, without asking the host anything. That's for a dry run of this
# script on a developer PC (it installs into the current user's profile; uninstall and remove the data after).
param([string]$ResDir = 'C:\fy\results', [string]$Dist = 'C:\fy\dist', [switch]$PartAOnly, [switch]$NoHost)
$ErrorActionPreference = 'Continue'
# (PowerShell variable names ignore case, so the results folder is $ResDir, never $R: $r holds a step's result.)
New-Item -ItemType Directory -Force -Path $ResDir | Out-Null
# Everything this window shows, errors included, also goes to the host.
Start-Transcript -Path "$ResDir\transcript.txt" -Force | Out-Null
$setupSrc = Get-ChildItem $Dist -Filter 'Flip7yoke-Setup-*.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
if ($PartAOnly) { $setup = $setupSrc.FullName } else {
  $setup = Join-Path ([Environment]::GetFolderPath('Desktop')) $setupSrc.Name # for part B, double-clicked by hand
  Copy-Item $setupSrc.FullName $setup -Force
}
$app = Join-Path $env:LOCALAPPDATA 'Programs\Flip7yoke'
$data = Join-Path $env:LOCALAPPDATA 'Flip7yoke'
$ps1 = Join-Path $app 'Flip7yoke.ps1'
$base = 'http://127.0.0.1:7777'
$results = New-Object System.Collections.ArrayList

# The host reads these files while we write them, so retry briefly if it has one open at that moment.
function Write-Shared($path, $text, [switch]$Append) {
  for ($i = 0; $i -lt 20; $i++) {
    try { if ($Append) { [IO.File]::AppendAllText($path, $text) } else { [IO.File]::WriteAllText($path, $text) }; return } catch { Start-Sleep -Milliseconds 100 }
  }
}
function Say($m) { $line = "$(Get-Date -Format HH:mm:ss) $m"; Write-Host $line; Write-Shared "$ResDir\log.txt" "$line`r`n" -Append }
function Save { Write-Shared "$ResDir\results.json" (ConvertTo-Json -InputObject @($results) -Depth 4) }
function Check($step, $ok, $detail) {
  [void]$results.Add([ordered]@{ step = $step; ok = [bool]$ok; detail = [string]$detail })
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Say "$mark  $step : $detail"
  Save
}
function Note($step, $detail) { [void]$results.Add([ordered]@{ step = $step; ok = $null; detail = [string]$detail }); Say "NOTE  $step : $detail"; Save }
# Run the installed control window's command-line action in its own process, with its output in files and a
# time limit, so nothing it starts (the server) can hold this script's console or pipes open.
$psN = 0
# (Not called "Ps": that's PowerShell's built-in alias for Get-Process, and an alias beats a function.)
function Invoke-Window($action, $extra = @(), $seconds = 90) {
  $script:psN++
  $o = "$ResDir\ps-$psN-$action.out.txt"; $e = "$ResDir\ps-$psN-$action.err.txt"
  $p = Start-Process powershell.exe -ArgumentList (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ps1`"", '-Action', $action) + $extra) `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
  $null = $p.Handle # PowerShell 5.1 only reports ExitCode later if the handle was opened now
  if (-not $p.WaitForExit($seconds * 1000)) { Say "  ($action took over $seconds s; ended it)"; try { $p.Kill() } catch {}; return @{ code = -1; out = 'TIMED OUT' } }
  $out = ((Get-Content $o -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $e -Raw -ErrorAction SilentlyContinue)).Trim()
  return @{ code = $p.ExitCode; out = $out }
}
function Get-Api($path) { try { return Invoke-RestMethod -Uri "$base$path" -TimeoutSec 3 } catch { return $null } }
function Post-Action($body) { try { return Invoke-RestMethod -Uri "$base/api/action" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5 } catch { return $null } }
function Wait-Until([scriptblock]$cond, $seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { $v = & $cond; if ($v) { return $v }; Start-Sleep -Milliseconds 500 }
  return $null
}
function Record { try { return [IO.File]::ReadAllText("$data\server.pid.json") | ConvertFrom-Json } catch { return $null } }
function Running { $r = Record; $s = Get-Api '/api/status'; if ($r -and $s -and $s.token -eq $r.token) { return $s } return $null }
# Ask the host (tools/sandbox-test.js) to try reaching $url from outside the sandbox, through its firewall.
function Host-Check($name, $url) {
  if ($NoHost) { return @{ reachable = $false; error = 'not asked (-NoHost)' } }
  @{ url = $url } | ConvertTo-Json | Set-Content -Path "$ResDir\host-$name.request.json" -Encoding ASCII
  $res = Wait-Until { if (Test-Path "$ResDir\host-$name.result.json") { Get-Content "$ResDir\host-$name.result.json" -Raw | ConvertFrom-Json } } 30
  return $res
}
function Network-Category {
  $p = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)
  return ($p | ForEach-Object { "$($_.InterfaceAlias)=$($_.NetworkCategory)" }) -join ', '
}
function Firewall-Line($statusOut) { return (($statusOut -split "`r?`n") | Where-Object { $_ -match '^Firewall:' }) -join '' }

Say "Flip7yoke clean-PC acceptance test, $($setupSrc.Name)"
Say "Windows $([Environment]::OSVersion.Version); network: $(Network-Category)"

# ---------------- Part A: automatic ----------------
Check 'A0 clean PC' (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Test-Path "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")) 'no Node.js and no Ollama installed'

$p = Start-Process $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=""', "/LOG=`"$ResDir\setup-A1.log`"" -Wait -PassThru
$files = @('Flip7yoke-server.exe', 'Flip7yoke.ps1', 'flip7yoke.ico', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'licenses\Node.js-LICENSE.txt') | Where-Object { -not (Test-Path (Join-Path $app $_)) }
$uninst = Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D666137D-4314-4D87-8F41-51FD6EF34C2F}_is1'
$startMenu = Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Flip7yoke.lnk"
Check 'A1 silent install, no admin' ($p.ExitCode -eq 0 -and -not $files -and $uninst -and $startMenu) "exit $($p.ExitCode); missing files: $($files -join ', '); uninstall entry $uninst; Start menu $startMenu"
$v = & (Join-Path $app 'Flip7yoke-server.exe') --version
Check 'A1 exe runs without Node' ($v -match '^\d+\.\d+\.\d+$') "Flip7yoke-server.exe --version = $v"

Say 'Starting the score keeper (if Windows asks "Allow access?" for it, click Cancel, so part A tests the no-firewall case)'
$r = Invoke-Window 'start'
$s = Wait-Until { Running } 30
Check 'A2 Start' ([bool]$s) "start exit $($r.code); round $($s.round), join $($s.joinUrl)"
$page = try { (Invoke-WebRequest -Uri "$base/board" -UseBasicParsing -TimeoutSec 5).Content } catch { '' }
$font = try { (Invoke-WebRequest -Uri "$base/fonts/barlow-condensed-600.woff2" -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 0 }
Check 'A2 board served from inside the exe' ($page -match 'Flip<span class="seven">7</span>yoke' -and $font -eq 200) "page $($page.Length) bytes, font $font"
$info = Get-Api '/api/info'
Check 'A2 no camera without Ollama' ($info.reader -eq 'no-ollama') "reader state: $($info.reader)"
$st = Invoke-Window 'status'
Check 'A2 window: reader line' ($st.out -match "Ollama isn't installed") (($st.out -split "`r?`n") | Where-Object { $_ -match '^Card reader' })
Note 'A3 firewall without the rule' "$(Firewall-Line $st.out); network: $(Network-Category)"
if ($s.joinUrl) { $h = Host-Check 'A3' $s.joinUrl; Note 'A3 reached from the host PC' "$($s.joinUrl): $(if ($h.reachable) { 'reachable' } else { "not reachable ($($h.error))" })" }

$a = (Post-Action '{"type":"addPlayer","name":"Sandbox A"}').id
$b = (Post-Action '{"type":"addPlayer","name":"Sandbox B"}').id
Post-Action ('{"type":"setEntry","id":"' + $a + '","entry":{"cards":[3,9,12],"mods":[]}}') | Out-Null
Post-Action ('{"type":"setEntry","id":"' + $b + '","entry":{"cards":[5,8],"mods":[4]}}') | Out-Null
$done = Wait-Until { $x = Get-Api '/api/status'; if ($x.round -eq 2) { $x } } 15
Check 'A4 a round finishes by itself' ([bool]$done) "round now $($done.round)"

@{ players = @('Sandbox A', 'Sandbox B', 'Sandbox C'); subtitle = 'Sandbox night'; main = 7777; also = 80 } | ConvertTo-Json | Set-Content "$ResDir\settings-input.json" -Encoding ASCII
$out = (Invoke-Window 'selftest' @('-Out', "`"$ResDir\settings-input.json`"")).out
$live = Wait-Until { $i = Get-Api '/api/info'; if ($i.subtitle -eq 'Sandbox night') { $i } } 10
Check 'A5 Settings Save, applied live' ($out -eq 'SAVED' -and $live -and @($live.names).Count -eq 3) "selftest: $out; subtitle now '$($live.subtitle)', $(@($live.names).Count) names"

$p = Start-Process $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=""', "/LOG=`"$ResDir\setup-A6.log`"" -Wait -PassThru
$stopped = -not (Running)
Invoke-Window 'start' | Out-Null
$s = Wait-Until { Running } 30
$g = try { [IO.File]::ReadAllText("$data\state.json") | ConvertFrom-Json } catch { $null }
Check 'A6 upgrade during a game' ($p.ExitCode -eq 0 -and $stopped -and $s -and $s.round -eq 2 -and @($g.players).Count -eq 2) "setup exit $($p.ExitCode); stopped first $stopped; after Start: round $($s.round), players $(@($g.players.name) -join ', ')"

$r = Invoke-Window 'stop'
$p = Start-Process "$app\unins000.exe" -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
Start-Sleep 2
Check 'A7 silent uninstall keeps scores' ($r.code -eq 0 -and $p.ExitCode -eq 0 -and -not (Test-Path $app) -and (Test-Path "$data\state.json")) "stop exit $($r.code); uninstall exit $($p.ExitCode); program left $(Test-Path $app); scores kept $(Test-Path "$data\state.json")"

if ($PartAOnly) {
  $failed = @($results | Where-Object { $_.ok -eq $false }).Count
  Say "Part A finished: $failed failed."
  Stop-Transcript | Out-Null
  return
}

# ---------------- Part B: the normal installer, clicked through ----------------
$bar = '=' * 70
Write-Host "`n$bar" -ForegroundColor Yellow
Write-Host ' YOUR TURN (part B of 2)' -ForegroundColor Yellow
Write-Host " 1. On this sandbox's desktop, double-click $($setupSrc.Name)."
Write-Host '    (If Windows says "Windows protected your PC": More info, then Run anyway.)'
Write-Host '    Keep the defaults and click through.'
Write-Host ' 2. When Windows asks to let "Windows Command Processor" make changes, click Yes.'
Write-Host ' 3. Leave "Launch Flip7yoke" ticked and click Finish.'
Write-Host ' 4. In the Flip7yoke window that opens, press Start. The board opens in the browser.'
Write-Host "    Leave everything open; this window carries on by itself.`n$bar" -ForegroundColor Yellow
Say 'Waiting for part B (up to 20 minutes)'
$installed = Wait-Until { if (Test-Path "$app\Flip7yoke-server.exe") { $true } } 1200
Say "  installed: $([bool]$installed); now waiting for the Flip7yoke window (up to 5 minutes)"
$windowUp = Wait-Until { @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'Flip7yoke\.ps1' -and $_.CommandLine -notmatch '-Action' }).Count -gt 0 } 300
Check 'B1 normal install' ([bool]$installed -and (Test-Path ([Environment]::GetFolderPath('Desktop') + '\Flip7yoke.lnk'))) "installed $([bool]$installed); desktop shortcut $(Test-Path ([Environment]::GetFolderPath('Desktop') + '\Flip7yoke.lnk'))"
Check 'B2 finish page launches the window' ([bool]$windowUp) "control window running $([bool]$windowUp)"
$st = Invoke-Window 'status'
$rule = @(Get-NetFirewallRule -DisplayName 'Flip7yoke' -ErrorAction SilentlyContinue | Where-Object { $_.Action -eq 'Allow' }).Count -gt 0
$public = (Network-Category) -match 'Public'
# On a Public network the Private-only rule doesn't apply, and the window must say so rather than "ok".
$expect = if ($public) { 'Public' } else { 'ok' }
Check 'B3 firewall rule from Setup, and what the window says' ($rule -and (Firewall-Line $st.out) -match $expect) "rule added $rule; $(Firewall-Line $st.out); network: $(Network-Category)"
$rules = @(Get-NetFirewallRule -DisplayName 'Flip7yoke' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Action)/$($_.Profile)" })
Note 'B3 rules named Flip7yoke' ($rules -join ', ')
Say '  now waiting for Start to be pressed in the Flip7yoke window (up to 10 minutes)'
$s = Wait-Until { Running } 600
Check 'B4 Start from the window; history kept from part A' ($s -and @($s.players).Count -eq 2 -and $s.round -eq 2) "running $([bool]$s); players $(@($s.players) -join ', '); round $($s.round)"
if ($s.joinUrl) { $h = Host-Check 'B4' $s.joinUrl; Note 'B4 reached from the host PC' "$($s.joinUrl): $(if ($h.reachable) { 'reachable' } else { "not reachable ($($h.error))" }); network: $(Network-Category)" }
# Make the network Private (as the window advises) and check the rule then lets the host, like a phone, in.
if ($s.joinUrl -and $public) {
  try {
    Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction Stop
    Start-Sleep 3
    $st = Invoke-Window 'status'
    $h = Host-Check 'B5' $s.joinUrl
    Check 'B5 on a Private network, the rule lets the host in' ($h.reachable -and (Firewall-Line $st.out) -match 'ok') "network now $(Network-Category); $(Firewall-Line $st.out); host: $(if ($h.reachable) { 'reachable' } else { "not reachable ($($h.error))" })"
  } catch { Note 'B5 making the network Private' "couldn't (needs admin): $($_.Exception.Message)" }
}

# ---------------- Part C: the normal uninstaller ----------------
Write-Host "`n$bar" -ForegroundColor Yellow
Write-Host ' YOUR TURN (part C of 2)' -ForegroundColor Yellow
Write-Host ' 1. Start menu > Settings > Apps > Installed apps > Flip7yoke > ... > Uninstall.'
Write-Host '    (Leave Flip7yoke running: the uninstaller stops it.)'
Write-Host ' 2. If Windows asks to let "Windows Command Processor" or "netsh" make changes, click Yes.'
Write-Host ' 3. When it asks "Also delete your Flip7yoke score history and settings?", click Yes.'
Write-Host "$bar" -ForegroundColor Yellow
Say 'Waiting for part C (up to 20 minutes)'
$gone = Wait-Until { if (-not (Test-Path "$app\Flip7yoke-server.exe")) { $true } } 1200
Start-Sleep 5
$serverLeft = @(Get-CimInstance Win32_Process -Filter "Name='Flip7yoke-server.exe'").Count
$rulesLeft = @(Get-NetFirewallRule -DisplayName 'Flip7yoke' -ErrorAction SilentlyContinue).Count
Check 'C1 uninstall stops the game and removes the program' ([bool]$gone -and $serverLeft -eq 0 -and -not (Test-Path $app)) "program gone $([bool]$gone); server processes left $serverLeft"
Check 'C2 delete scores when asked' (-not (Test-Path $data)) "data folder left: $(Test-Path $data)"
Check 'C3 firewall rule removed' ($rulesLeft -eq 0) "rules named Flip7yoke left: $rulesLeft"
Note 'card reader setup' 'not run here: Windows Sandbox has no graphics card for the model, and it means a 4 GB download'

$failed = @($results | Where-Object { $_.ok -eq $false }).Count
Say "Finished: $failed failed."
Set-Content -Path "$ResDir\done.txt" -Value "failed=$failed"
Write-Host "`nAll done. You can close the sandbox." -ForegroundColor Green
