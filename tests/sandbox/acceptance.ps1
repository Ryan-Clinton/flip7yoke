# Clean-PC acceptance test, run inside Windows Sandbox by tools/sandbox-test.js (a clean Windows with no Node or
# Ollama). It's all automatic: nobody needs to click anything. The sandbox runs this script with admin rights, so
# Setup's firewall step and the uninstaller's rule removal go through without Windows asking. Results go to
# C:\fy\results (a folder on the host). Keep this file ASCII only (Windows PowerShell 5.1).
# -PartAOnly -NoHost: part A only, without asking the host anything. That's for a dry run of this script on a
# developer PC (it installs into the current user's profile; uninstall and remove the data after).
param([string]$ResDir = 'C:\fy\results', [string]$Dist = 'C:\fy\dist', [switch]$PartAOnly, [switch]$NoHost)
$ErrorActionPreference = 'Continue'
# (PowerShell variable names ignore case, so the results folder is $ResDir, never $R: $r holds a step's result.)
New-Item -ItemType Directory -Force -Path $ResDir | Out-Null
# Everything this window shows, errors included, also goes to the host.
Start-Transcript -Path "$ResDir\transcript.txt" -Force | Out-Null
$setupSrc = Get-ChildItem $Dist -Filter 'Flip7yoke-Setup-*.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
$setup = $setupSrc.FullName
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

Say 'Starting the score keeper (Windows may show "Allow access?" for it: nobody answers it, so no rule is made)'
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

@{ subtitle = 'Sandbox night'; main = 7777; also = 80 } | ConvertTo-Json | Set-Content "$ResDir\settings-input.json" -Encoding ASCII
$out = (Invoke-Window 'selftest' @('-Out', "`"$ResDir\settings-input.json`"")).out
$live = Wait-Until { $i = Get-Api '/api/info'; if ($i.subtitle -eq 'Sandbox night') { $i } } 10
Check 'A5 Settings Save, applied live' ($out -eq 'SAVED' -and $live) "selftest: $out; subtitle now '$($live.subtitle)'"

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

# ---------------- Part B: install with the firewall and desktop options, as most people will ----------------
$exe = "$app\Flip7yoke-server.exe"
function Exe-Rules { return @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' }) }
function Rule-List { return ((Exe-Rules) | ForEach-Object { "$($_.DisplayName): $($_.Action)/$($_.Profile)" }) -join '; ' }
function Reach($h) { if ($h.reachable) { 'reachable' } else { "not reachable ($($h.error))" } }

# Setup's firewall step asks Windows for admin rights; this script already has them, so it goes through unasked.
$p = Start-Process $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS="desktopicon,firewall"', "/LOG=`"$ResDir\setup-B1.log`"" -Wait -PassThru
$lnk = Test-Path ([Environment]::GetFolderPath('Desktop') + '\Flip7yoke.lnk')
$rule = @(Get-NetFirewallRule -DisplayName 'Flip7yoke' -ErrorAction SilentlyContinue | Where-Object { $_.Action -eq 'Allow' -and [string]$_.Profile -eq 'Private' }).Count -gt 0
Check 'B1 install with the desktop and firewall options' ($p.ExitCode -eq 0 -and $lnk -and $rule) "exit $($p.ExitCode); desktop shortcut $lnk; Private rule added $rule"
Note 'B1 all inbound rules for the exe' (Rule-List)

# The control window itself (what the finish page and the shortcuts open): it should come up and stay up.
$gui = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ps1`"" -PassThru
Start-Sleep 8
Check 'B2 the Flip7yoke window opens' (-not $gui.HasExited) "window process running $(-not $gui.HasExited)"

$public = (Network-Category) -match 'Public'
Note 'B network' "$(Network-Category)"
# Before Start, on a Public network with only Setup's Private rule, the window must say the network is Public.
$st = Invoke-Window 'status'
$expect = if ($public) { 'Public' } else { 'ok' }
Check 'B3 firewall line before Start' ((Firewall-Line $st.out) -match $expect) "$(Firewall-Line $st.out) (expected '$expect')"

if ($public) {
  # Cancelling Windows' "Allow access?" prompt adds Block rules for Public networks. The advice must still be to
  # make the network Private, since Setup's rule then applies.
  New-NetFirewallRule -DisplayName 'flip7yoke-server.exe (test block)' -Direction Inbound -Action Block -Profile Public -Program $exe | Out-Null
  $st = Invoke-Window 'status'
  Check 'B3 firewall line with a Public block rule too' ((Firewall-Line $st.out) -match 'Public') "$(Firewall-Line $st.out); rules: $(Rule-List)"
}

$r = Invoke-Window 'start'
$s = Wait-Until { Running } 30
Check 'B4 Start; the game from part A is still there' ($s -and @($s.players).Count -eq 2 -and $s.round -eq 2) "start exit $($r.code); players $(@($s.players) -join ', '); round $($s.round)"
$st = Invoke-Window 'status'
Note 'B4 firewall line after Start' (Firewall-Line $st.out)
if ($s.joinUrl -and $public) {
  $h = Host-Check 'B4' $s.joinUrl
  Check 'B4 on the Public network, the host is kept out' (-not $h.reachable) "$($s.joinUrl): $(Reach $h)"
  # Make the network Private (as the window advises) and check the rule then lets the host, like a phone, in.
  try {
    Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction Stop
    Start-Sleep 3
    $st = Invoke-Window 'status'
    $h = Host-Check 'B5' $s.joinUrl
    Check 'B5 made Private: the rule lets the host in and the window says ok' ($h.reachable -and (Firewall-Line $st.out) -match 'ok') "network now $(Network-Category); $(Firewall-Line $st.out); host: $(Reach $h)"
  } catch { Check 'B5 making the network Private' $false $_.Exception.Message }
} elseif ($s.joinUrl) {
  $h = Host-Check 'B4' $s.joinUrl
  Check 'B4 on a Private network, the host gets in' ($h.reachable) "$($s.joinUrl): $(Reach $h)"
}
if (-not $gui.HasExited) { $gui.Kill() } # closing the window leaves the game running, as it does for people

# ---------------- Part C: uninstall while a game is running, deleting the scores ----------------
# /DELETEDATA answers "Also delete your score history and settings?" with Yes (the question defaults to No).
$p = Start-Process "$app\unins000.exe" -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/DELETEDATA' -Wait -PassThru
$null = Wait-Until { if (-not (Test-Path $app) -and -not (Test-Path $data)) { $true } } 60
Start-Sleep 3
$serverLeft = @(Get-CimInstance Win32_Process -Filter "Name='Flip7yoke-server.exe'").Count
$rulesLeft = @(Get-NetFirewallRule -DisplayName 'Flip7yoke' -ErrorAction SilentlyContinue).Count
$uninst = Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D666137D-4314-4D87-8F41-51FD6EF34C2F}_is1'
$shortcuts = (Test-Path ([Environment]::GetFolderPath('Desktop') + '\Flip7yoke.lnk')) -or (Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Flip7yoke.lnk")
Check 'C1 uninstall stops the game and removes the program' ($p.ExitCode -eq 0 -and $serverLeft -eq 0 -and -not (Test-Path $app) -and -not $uninst -and -not $shortcuts) "exit $($p.ExitCode); program folder left $(Test-Path $app); server processes left $serverLeft; uninstall entry left $uninst; shortcuts left $shortcuts"
Check 'C2 scores deleted when asked' (-not (Test-Path $data)) "data folder left: $(Test-Path $data)"
Check 'C3 Setup''s firewall rule removed' ($rulesLeft -eq 0) "rules named Flip7yoke left: $rulesLeft"
Note 'not tested here' 'card reader setup (no graphics card in the sandbox, and a 4 GB download); the wizard pages themselves (clicked through by hand in earlier runs)'

$failed = @($results | Where-Object { $_.ok -eq $false }).Count
Say "Finished: $failed failed."
Stop-Transcript | Out-Null
Set-Content -Path "$ResDir\done.txt" -Value "failed=$failed"
