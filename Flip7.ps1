# Flip 7 control window: start and stop the score keeper and the card reader (Ollama for Windows), and settings.
# Runs standalone, so Start works when nothing else is running. Closing the window leaves the game running.
# Also usable without the window: Flip7.ps1 -Action start | stop | status
# Keep this file ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#   Flip7.ps1 -Action snapshot -Out <folder> draws the window and Settings to PNGs without showing them.
#   Flip7.ps1 -Action allow-phones          adds the firewall rule if it's missing (one UAC prompt)
#   Flip7.ps1 -Action setup-reader          installs Ollama if missing and downloads the card model (console window)
#   Flip7.ps1 -Action selftest -Out <json>  fills Settings off-screen from a JSON file and presses Save (tests)
#   Flip7.ps1 -Action remove-firewall       removes our firewall rule (the uninstaller uses it)
param([ValidateSet('gui', 'start', 'stop', 'status', 'snapshot', 'allow-phones', 'remove-firewall', 'setup-reader', 'selftest')] [string]$Action = 'gui', [string]$Out = '')
$ScriptPath = $MyInvocation.MyCommand.Path

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunJs = Join-Path $Root 'run.js'
$ServerExe = Join-Path $Root 'Flip7yoke-server.exe'
# The installer build stamps the release version here. Installed copies are stamped, the repo's says 'dev'.
# "Installed" goes by the stamp, not by the exe being there, so a half-finished install is still recognised as one.
$AppVersion = 'dev'
$Installed = $AppVersion -ne 'dev'

# Data and settings: FLIP7_DATA, else %LOCALAPPDATA%\Flip7yoke when installed, else the project folder (same rule
# as lib/paths.js).
$DataDir = if ($env:FLIP7_DATA) { $env:FLIP7_DATA } elseif ($Installed) { Join-Path $env:LOCALAPPDATA 'Flip7yoke' } else { $Root }
$LogDir = Join-Path $DataDir 'logs'
$ConfigFile = Join-Path $DataDir 'config.json'
$OllamaExe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$OllamaPidFile = Join-Path $LogDir 'ollama.pid'
$Utf8 = New-Object System.Text.UTF8Encoding $false

# ---- settings (config.json); the server checks every value too, this is the same set of defaults ----
function Get-Config {
  $c = [ordered]@{
    version = 1; players = @(); subtitle = ''
    wifi = [ordered]@{ ssid = ''; password = ''; auth = 'WPA'; showOnBoard = $true }
    cardReader = [ordered]@{ enabled = 'auto'; model = 'qwen3-vl:4b-instruct'; url = 'http://127.0.0.1:11434' }
    network = [ordered]@{ address = 'auto' }
    ports = [ordered]@{ main = 7777; also = 80 }
  }
  $script:ConfigError = $null
  if (Test-Path $ConfigFile) {
    try {
      $raw = [IO.File]::ReadAllText($ConfigFile) | ConvertFrom-Json
      if ($raw.players) { $c.players = @($raw.players | ForEach-Object { [string]$_ }) }
      if ($null -ne $raw.subtitle) { $c.subtitle = [string]$raw.subtitle }
      foreach ($sect in 'wifi', 'cardReader', 'network', 'ports') {
        if ($raw.$sect) { foreach ($k in @($c[$sect].Keys)) { if ($null -ne $raw.$sect.$k) { $c[$sect][$k] = $raw.$sect.$k } } }
      }
    } catch { $script:ConfigError = "config.json has an error: $($_.Exception.Message)" }
  }
  return $c
}

function Save-Config($c) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  if (Test-Path $ConfigFile) { Copy-Item $ConfigFile "$ConfigFile.bak" -Force }
  $json = $c | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText("$ConfigFile.tmp", $json + "`n", $Utf8)
  Move-Item "$ConfigFile.tmp" $ConfigFile -Force
}

$Cfg = Get-Config
$ScoreUrl = "http://127.0.0.1:$($Cfg.ports.main)"
$ReaderUrl = [string]$Cfg.cardReader.url
$ReaderModel = [string]$Cfg.cardReader.model

function Get-Json($url, $timeout = 800) {
  try {
    $req = [System.Net.WebRequest]::Create($url)
    $req.Timeout = $timeout
    $resp = $req.GetResponse()
    $text = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    $resp.Close()
    return $text | ConvertFrom-Json
  } catch { return $null }
}
function Post-Json($url, $body = '{}') {
  try { return Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15 } catch { return $null }
}

# ---- what's running: server.pid.json, written by the supervisor (lib/supervisor.js) ----
$PidFile = Join-Path $DataDir 'server.pid.json'
$ErrorFile = Join-Path $DataDir 'server.error.txt'

# Is process $id the one recorded: same exe, started within a few seconds of the recorded time?
function Test-Recorded($id, $exe, $started) {
  if (-not $id) { return $false }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { return $false }
  try {
    if ($p.Path -ne $exe) { return $false }
    $want = [datetime]::Parse($started).ToUniversalTime()
    return [math]::Abs(($p.StartTime.ToUniversalTime() - $want).TotalSeconds) -lt 10
  } catch { return $false }
}

# The running server's record, or $null. A stale record (PIDs gone or reused) is deleted.
function Get-FlipServer {
  if (-not (Test-Path $PidFile)) { return $null }
  try { $r = [IO.File]::ReadAllText($PidFile) | ConvertFrom-Json } catch { return $null }
  if (Test-Recorded $r.supervisorPid $r.exe $r.supervisorStart) { return $r }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  return $null
}

# Ollama for Windows. If it's already running (the Ollama tray app usually starts it), we use it and leave it
# running; we only ever stop an ollama.exe that we started ourselves, recorded by PID in logs\ollama.pid.
function Get-OurOllama {
  if (-not (Test-Path $OllamaPidFile)) { return $null }
  $id = [int](Get-Content $OllamaPidFile -TotalCount 1)
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.Path -eq $OllamaExe) { return $p }
  Remove-Item $OllamaPidFile -ErrorAction SilentlyContinue
  return $null
}

function Start-Flip {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $readerOn = $Cfg.cardReader.enabled -ne $false
  if ($readerOn -and -not (Get-Json "$ReaderUrl/api/version") -and (Test-Path $OllamaExe)) {
    $p = Start-Process $OllamaExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
      -RedirectStandardError (Join-Path $LogDir 'ollama.log') -RedirectStandardOutput (Join-Path $LogDir 'ollama.out.log')
    Set-Content -Path $OllamaPidFile -Value $p.Id -Encoding ascii
  }
  if (Get-FlipServer) { return } # one copy only
  Remove-Item $ErrorFile -ErrorAction SilentlyContinue
  # The supervisor writes its own log (logs\server.log) and server.pid.json.
  if ($Installed) {
    Start-Process $ServerExe -WindowStyle Hidden -WorkingDirectory $DataDir
  } else {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Set-Content -Path $ErrorFile -Value 'Node.js is not installed (needed when running from the project folder).'; return }
    Start-Process $node -ArgumentList "`"$RunJs`"" -WindowStyle Hidden -WorkingDirectory $Root
  }
}

# Installed copies only: Flip7yoke-server.exe processes started from this exact install folder, found without the
# record (it may be missing or broken). From the repo there's no safe equivalent: test servers run the same
# main.js as the real one, so there it's the record or nothing.
function Get-UnrecordedServers {
  if (-not $Installed) { return @() }
  return @(Get-CimInstance Win32_Process -Filter "Name='Flip7yoke-server.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $ServerExe })
}

# Stop through the supervisor so the last scores are saved. Returns the error text if saving failed, else $null.
function Stop-Flip {
  $result = $null
  $r = Get-FlipServer
  if ($r) {
    try {
      $answer = Invoke-RestMethod -Uri "http://127.0.0.1:$($r.controlPort)/stop" -Method Post -Headers @{ 'x-flip7-token' = $r.token } -TimeoutSec 10
      if (-not $answer.saved) { $result = "Last scores may not have saved: $($answer.error)" }
    } catch {
      # No answer: stop the recorded processes, each only if it is still the one recorded.
      foreach ($p in @(@($r.childPid, $r.childStart), @($r.supervisorPid, $r.supervisorStart))) {
        if (Test-Recorded $p[0] $r.exe $p[1]) { Stop-Process -Id $p[0] -Force -ErrorAction SilentlyContinue }
      }
      $result = "The score keeper didn't answer, so it was ended. Scores saved up to its last save."
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }
  # Safety net: anything from this install still running without a usable record. End the supervisors (no
  # --serve): each server saves and exits when its supervisor goes. Wait up to 10s for them all to go.
  $left = Get-UnrecordedServers
  if ($left.Count) {
    $left | Where-Object { $_.CommandLine -notmatch '--serve' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 40 -and (Get-UnrecordedServers).Count; $i++) { Start-Sleep -Milliseconds 250 }
    if (-not $result) { $result = "Flip7yoke was running without its record, so it was ended. It saves before it exits, but that couldn't be confirmed." }
  }
  # Free the GPU: if the card reader is on and our model is loaded, unload just that model (other models, and an
  # Ollama started by something else, are left running; ours reloads on its next use). Then stop Ollama only if
  # we started it.
  if ($Cfg.cardReader.enabled -ne $false) {
    $loaded = Get-Json "$ReaderUrl/api/ps" 1500
    if ($loaded -and @($loaded.models | Where-Object { $_.name -eq $ReaderModel -or $_.model -eq $ReaderModel }).Count) {
      Post-Json "$ReaderUrl/api/generate" ('{"model":"' + $ReaderModel + '","keep_alive":0}') | Out-Null
    }
  }
  $ours = Get-OurOllama
  if ($ours) { Stop-Process -Id $ours.Id -Force -ErrorAction SilentlyContinue; Remove-Item $OllamaPidFile -ErrorAction SilentlyContinue }
  return $result
}

# A half-finished install or upgrade: the exe is missing, or isn't the version this script came with.
function Get-InstallProblem {
  if (-not $Installed) { return $null }
  $v = $null
  if (Test-Path $ServerExe) { try { $v = (& $ServerExe --version 2>$null | Select-Object -First 1) } catch { $v = $null } }
  if ($v -ne $AppVersion) { return "Flip7yoke didn't finish installing. Run the installer again." }
  return $null
}

# ---- Windows firewall: can phones reach the program that listens? ----
# The listening program is the exe when installed, node.exe from the repo. Reading rules needs no admin.
function Get-ServerProgram { if ($Installed) { return $ServerExe } else { return (Get-Command node -ErrorAction SilentlyContinue).Source } }

# 'ok' (an enabled inbound Allow rule covers networks of this kind: Private, Public or Domain), 'blocked' (a Block
# rule does), 'missing', 'unknown'.
# It can't see third-party firewalls or a router that keeps Wi-Fi devices apart, so the window says "may".
function Test-Firewall($kind = 'Private') {
  $prog = Get-ServerProgram
  if (-not $prog) { return 'unknown' }
  try {
    $rules = @(Get-NetFirewallApplicationFilter -Program $prog -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' -and ([string]$_.Profile) -match "$kind|Any" })
  } catch { return 'unknown' }
  if ($rules | Where-Object { $_.Action -eq 'Block' }) { return 'blocked' }
  if ($rules | Where-Object { $_.Action -eq 'Allow' }) { return 'ok' }
  return 'missing'
}

# Windows' category for the network the join address is on: 'Private', 'Public', 'DomainAuthenticated', or $null.
# Before Start there's no join address, so it uses the network the PC's internet route goes through, which is the
# one Automatic picks. A rule for Private networks doesn't apply on a Public one, and Windows makes a network Public
# whenever someone answers No to "make this PC discoverable". Reading it needs no admin.
function Get-NetworkCategory($url) {
  $if = $null
  if ($url) {
    try { $ip = ([Uri]$url).Host } catch { $ip = $null }
    if ($ip) { $a = Get-NetIPAddress -IPAddress $ip -ErrorAction SilentlyContinue | Select-Object -First 1; if ($a) { $if = $a.InterfaceIndex } }
  }
  if (-not $if) {
    $r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
    if ($r) { $if = $r.InterfaceIndex }
  }
  if (-not $if) { return $null }
  $p = Get-NetConnectionProfile -InterfaceIndex $if -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p) { return [string]$p.NetworkCategory } else { return $null }
}

# The firewall state shown to the user, for the kind of network phones would come in on. On a Public network that
# isn't allowed, but with Setup's Private rule in place, it's 'public': the fix is making the network Private, not
# another rule. That includes a Block rule for Public, which Windows adds when its "Allow access?" prompt is cancelled.
function Get-PhoneAccess($url) {
  if ((Get-NetworkCategory $url) -ne 'Public') { return (Test-Firewall) }
  $fw = Test-Firewall 'Public'
  if ($fw -ne 'ok' -and (Test-Firewall) -eq 'ok') { return 'public' }
  return $fw
}

# Add the "Flip7yoke" rule (inbound TCP, this program, Private networks only). One UAC prompt; declining is fine.
function Grant-Firewall {
  $prog = Get-ServerProgram
  if (-not $prog) { return $false }
  $cmd = "netsh advfirewall firewall delete rule name=`"Flip7yoke`" program=`"$prog`" >nul 2>&1 & " +
         "netsh advfirewall firewall add rule name=`"Flip7yoke`" dir=in action=allow program=`"$prog`" enable=yes profile=private protocol=TCP"
  try { Start-Process cmd.exe -ArgumentList "/c $cmd" -Verb RunAs -WindowStyle Hidden -Wait } catch { return $false } # UAC declined
  return (Test-Firewall) -eq 'ok'
}

# ---- card reader setup: install Ollama if missing, then download the model. Runs in its own console window. ----
function Invoke-ReaderSetup {
  Write-Host 'Flip7yoke card reader setup'
  Write-Host 'Needs about 4 GB of downloads, and a graphics card with 6 GB or more for good speed.'
  Write-Host ''
  if (-not (Test-Path $OllamaExe)) {
    Write-Host 'Installing Ollama for Windows (from ollama.com)...'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install --id Ollama.Ollama -e
    } else {
      $setup = Join-Path $env:TEMP 'OllamaSetup.exe'
      Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $setup -UseBasicParsing
      Start-Process $setup -Wait
    }
    if (-not (Test-Path $OllamaExe)) { Write-Host "Ollama didn't install. You can try again from the Flip7yoke window."; return 1 }
  }
  # Downloading a model needs Ollama's server. The tray app usually starts it; otherwise start our own.
  $u = [Uri]$ReaderUrl
  $env:OLLAMA_HOST = "$($u.Host):$($u.Port)"
  for ($i = 0; $i -lt 30 -and -not (Get-Json "$ReaderUrl/api/version" 1500); $i++) {
    if ($i -eq 5 -and -not (Get-OurOllama)) {
      New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
      $p = Start-Process $OllamaExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
        -RedirectStandardError (Join-Path $LogDir 'ollama.log') -RedirectStandardOutput (Join-Path $LogDir 'ollama.out.log')
      Set-Content -Path $OllamaPidFile -Value $p.Id -Encoding ascii
    }
    Start-Sleep -Seconds 1
  }
  $tags = Get-Json "$ReaderUrl/api/tags" 5000
  if (-not $tags) { Write-Host "Ollama isn't answering at $ReaderUrl. Try again from the Flip7yoke window."; return 1 }
  if (@($tags.models | Where-Object { $_.name -eq $ReaderModel -or $_.model -eq $ReaderModel }).Count) {
    Write-Host "The card model ($ReaderModel) is already downloaded."
  } else {
    Write-Host "Downloading the card model ($ReaderModel, 3.3 GB)..."
    & $OllamaExe pull $ReaderModel
    if ($LASTEXITCODE -ne 0) { Write-Host "The download didn't finish. You can try again from the Flip7yoke window."; return 1 }
  }
  # If the score keeper is running, tell it to look again so the camera button appears straight away.
  $r = Get-FlipServer
  if ($r -and $r.port) { Post-Json "http://127.0.0.1:$($r.port)/api/reader/check" | Out-Null }
  Write-Host 'Card reader ready.'
  return 0
}

# What the reader line says, and what its button offers, for each state the server reports.
function Get-ReaderView($state) {
  switch ($state) {
    'ready'     { return @{ On = $true; Text = 'Ready: phones show the camera button'; Fix = $null } }
    'checking'  { return @{ On = $null; Text = 'Checking...'; Fix = $null } }
    'off'       { return @{ On = $null; Text = 'Turned off in Settings (no camera button)'; Fix = $null } }
    'no-model'  { return @{ On = $false; Text = "Ollama is running, but the card model isn't downloaded"; Fix = 'Download model (3.3 GB)' } }
    'no-ollama' {
      if (-not (Test-Path $OllamaExe)) { return @{ On = $false; Text = "Ollama isn't installed (no camera button)"; Fix = 'Install Ollama' } }
      return @{ On = $false; Text = "Ollama isn't answering (no camera button)"; Fix = 'Check again' }
    }
  }
  return @{ On = $false; Text = 'Starts with the score keeper'; Fix = $null }
}

function Get-FlipStatus {
  $r = Get-FlipServer
  $url = if ($r -and $r.port) { "http://127.0.0.1:$($r.port)" } else { $ScoreUrl }
  $s = Get-Json "$url/api/status"
  # Only trust an answer carrying our server's token: anything else on the port is another program.
  $ours = $s -and $r -and $s.token -eq $r.token
  $score = if ($ours) {
    $who = if ($s.players.Count) { "$($s.players.Count) players, round $($s.round)" } else { 'no players yet' }
    if ($s.saveError) { @{ On = $false; Text = "NOT SAVING SCORES: $($s.saveError)"; Running = $true } }
    else { @{ On = $true; Text = "Running: $($s.devices) device(s) connected, $who ($($s.mode))"; Running = $true } }
  } elseif ($r) { @{ On = $null; Text = 'Starting...'; Running = $true } }
  elseif ((Get-UnrecordedServers).Count) { @{ On = $null; Text = 'Running without its record: Stop will end it (it saves first)'; Running = $true } }
  elseif ($s) { @{ On = $false; Text = "Port $($Cfg.ports.main) is in use by another program (see Settings > Ports)"; Running = $false } }
  else { @{ On = $false; Text = 'Stopped'; Running = $false } }
  if (-not $ours) { $s = $null }
  $reader = if ($s) { Get-ReaderView $s.reader } else { Get-ReaderView '' }
  $note = $script:ConfigError
  if (-not $r -and (Test-Path $ErrorFile)) { $note = "Last start failed: $((Get-Content $ErrorFile -TotalCount 1))" }
  if ($s -and $s.recordError) { $note = "Flip7yoke $($s.recordError) and keeps retrying. Until it works, Stop may need a second press." }
  elseif ($s -and $s.configError) { $note = "Settings: $($s.configError)" }
  elseif ($s -and @($s.restartNeeded).Count) { $note = 'Settings changed: press Stop, then Start, to apply them.' }
  return @{ Score = $score; Reader = $reader; Phone = $(if ($s) { $s.joinUrl } else { $null }); Note = $note }
}

$FirewallText = @{
  missing = 'Phones may be blocked by the Windows firewall.'
  blocked = 'The Windows firewall blocks Flip7yoke on this network: allow it in Windows Security > Firewall.'
  public  = 'Windows treats this network as Public, which blocks phones. Make it Private in Settings > Network & internet.'
}

switch ($Action) {
  'start'  { $p = Get-InstallProblem; if ($p) { $p; exit 1 }; Start-Flip; return }
  'stop'   {
    # Exit codes, which the installer relies on before it replaces any files:
    #   0  stopped cleanly with every save confirmed, or nothing was running
    #   2  stopped, but the last save wasn't confirmed (it failed, or the server had to be ended)
    #   3  something recorded is still running
    $r = Get-FlipServer
    $msg = Stop-Flip
    if ($msg) { $msg } else { 'Stopped.' }
    if ($r -and ((Test-Recorded $r.supervisorPid $r.exe $r.supervisorStart) -or (Test-Recorded $r.childPid $r.exe $r.childStart))) { exit 3 }
    if ((Get-UnrecordedServers).Count) { exit 3 }
    if ($msg) { exit 2 }
    exit 0
  }
  'status' {
    $st = Get-FlipStatus; "Score keeper: $($st.Score.Text)"; "Card reader:  $($st.Reader.Text)"; "Phones:       $($st.Phone)"
    $fw = Get-PhoneAccess $st.Phone; "Firewall:     $(if ($FirewallText[$fw]) { $FirewallText[$fw] } else { $fw })"
    if ($st.Note) { $st.Note }
    return
  }
  'allow-phones' {
    if ((Test-Firewall) -eq 'ok') { 'Phones are already allowed through the Windows firewall.'; exit 0 }
    if (Grant-Firewall) { 'Phones are now allowed through the Windows firewall (private networks only).'; exit 0 }
    "Not allowed yet: phones can't connect until it is. Use 'Allow phones' in the Flip7yoke window to try again."
    exit 1
  }
  'remove-firewall' {
    # Used by the uninstaller: remove our own "Flip7yoke" rule for this program, if there is one (one UAC prompt).
    $prog = Get-ServerProgram
    $ours = @(Get-NetFirewallRule -DisplayName 'Flip7yoke' -ErrorAction SilentlyContinue | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -eq $prog })
    if (-not $ours.Count) { 'No Flip7yoke firewall rule to remove.'; exit 0 }
    try { Start-Process netsh.exe -ArgumentList "advfirewall firewall delete rule name=`"Flip7yoke`" program=`"$prog`"" -Verb RunAs -WindowStyle Hidden -Wait } catch { 'Left the firewall rule in place (permission declined).'; exit 1 }
    'Removed the Flip7yoke firewall rule.'
    exit 0
  }
  'setup-reader' {
    $code = Invoke-ReaderSetup
    Write-Host ''
    Read-Host 'Press Enter to close' | Out-Null
    exit $code
  }
}

# ---- the window ----
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$navy = [System.Drawing.Color]::FromArgb(20, 33, 61)
$panel = [System.Drawing.Color]::FromArgb(29, 45, 80)
$ink = [System.Drawing.Color]::FromArgb(246, 241, 231)
$muted = [System.Drawing.Color]::FromArgb(159, 176, 208)
$gold = [System.Drawing.Color]::FromArgb(255, 203, 71)
$green = [System.Drawing.Color]::FromArgb(61, 220, 151)
$red = [System.Drawing.Color]::FromArgb(255, 93, 115)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Flip7yoke'
$form.ClientSize = New-Object System.Drawing.Size(460, 410)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.BackColor = $navy
$form.ForeColor = $ink
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

function New-Label($text, $x, $y, $w, $h, $size = 10, $bold = $false, $color = $ink, $parent = $form) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.Size = New-Object System.Drawing.Size($w, $h)
  $l.ForeColor = $color
  $l.Font = New-Object System.Drawing.Font('Segoe UI', $size, $(if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }))
  $parent.Controls.Add($l); return $l
}
function New-Button($text, $x, $y, $w, $h, $back, $fore, $parent = $form) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, $h)
  $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0; $b.BackColor = $back; $b.ForeColor = $fore
  $b.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $b.Cursor = 'Hand'
  $parent.Controls.Add($b); return $b
}

New-Label 'Flip7yoke' 20 14 180 34 18 $true $gold | Out-Null
$subLbl = New-Label ([string]$Cfg.subtitle) 200 24 240 22 10 $false $muted
New-Label 'SCORE KEEPER' 20 62 420 18 8 $true $muted | Out-Null
$scoreLbl = New-Label '...' 20 80 420 22 10
New-Label 'CARD READER' 20 112 420 18 8 $true $muted | Out-Null
$readerLbl = New-Label '...' 20 130 420 22 10
$fixBtn = New-Button 'Fix' 20 154 200 28 $panel $gold
$fixBtn.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$fixBtn.Visible = $false
New-Label 'PHONES JOIN AT' 20 192 260 18 8 $true $muted | Out-Null
$fwBtn = New-Button 'Allow phones' 300 186 140 26 $panel $gold
$fwBtn.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$fwBtn.Visible = $false
$phoneLbl = New-Label '-' 20 210 420 26 12 $true $gold
$noteLbl = New-Label '' 20 240 420 36 9 $false $gold

$startBtn = New-Button 'Start' 20 280 205 46 $green $navy
$stopBtn = New-Button 'Stop' 235 280 205 46 $red ([System.Drawing.Color]::White)
$boardBtn = New-Button 'Open scoreboard' 20 336 135 36 $panel $ink
$settingsBtn = New-Button 'Settings' 162 336 135 36 $panel $ink
$dataBtn = New-Button 'Open data folder' 305 336 135 36 $panel $ink
$boardBtn.Font = $settingsBtn.Font = $dataBtn.Font = New-Object System.Drawing.Font('Segoe UI', 10)
New-Label "Data: $DataDir" 20 380 420 20 8 $false $muted | Out-Null

$busy = $false
function Update-Status {
  if ($script:busy) { return }
  $st = Get-FlipStatus
  foreach ($pair in @(@($scoreLbl, $st.Score), @($readerLbl, $st.Reader))) {
    $pair[0].Text = $pair[1].Text
    $pair[0].ForeColor = if ($pair[1].On -eq $true) { $green } elseif ($pair[1].On -eq $false) { $red } else { $gold }
  }
  $fixBtn.Visible = [bool]$st.Reader.Fix
  if ($st.Reader.Fix) { $fixBtn.Text = $st.Reader.Fix }
  $phoneLbl.Text = if ($st.Phone) { $st.Phone } else { '-' }
  # The firewall check takes a moment, so refresh it every 30s (and after Start or Allow phones), not every tick.
  if (-not $script:FwAt -or ((Get-Date) - $script:FwAt).TotalSeconds -gt 30) { $script:Fw = Get-PhoneAccess $st.Phone; $script:FwAt = Get-Date }
  $fwBtn.Visible = $script:Fw -eq 'missing'
  $note = $st.Note
  if (-not $note -and $FirewallText[$script:Fw]) { $note = $FirewallText[$script:Fw] }
  $noteLbl.Text = if ($note) { $note } else { '' }
  $running = [bool]$st.Score.Running
  $startBtn.Enabled = -not $running
  $stopBtn.Enabled = [bool]$running
  $boardBtn.Enabled = [bool]$running
  # Flat buttons don't grey out on their own, so show which one is usable.
  $startBtn.BackColor = if ($startBtn.Enabled) { $green } else { $panel }
  $startBtn.ForeColor = if ($startBtn.Enabled) { $navy } else { $muted }
  $stopBtn.BackColor = if ($stopBtn.Enabled) { $red } else { $panel }
  $stopBtn.ForeColor = if ($stopBtn.Enabled) { [System.Drawing.Color]::White } else { $muted }
}

function Invoke-Busy($label, [scriptblock]$work) {
  $script:busy = $true
  $startBtn.Enabled = $stopBtn.Enabled = $false
  $scoreLbl.Text = $readerLbl.Text = $label
  $scoreLbl.ForeColor = $readerLbl.ForeColor = $gold
  $form.Refresh()
  try { & $work } finally { $script:busy = $false }
}

function Reload-Config {
  $script:Cfg = Get-Config
  $script:ScoreUrl = "http://127.0.0.1:$($Cfg.ports.main)"
  $script:ReaderUrl = [string]$Cfg.cardReader.url
  $script:ReaderModel = [string]$Cfg.cardReader.model
  $subLbl.Text = [string]$Cfg.subtitle
}

$startBtn.Add_Click({
  Reload-Config
  $problem = Get-InstallProblem
  if ($problem) { [System.Windows.Forms.MessageBox]::Show($form, $problem, 'Flip7yoke') | Out-Null; return }
  Invoke-Busy 'Starting...' { Start-Flip }
  $script:FwAt = $null
  # Give it a moment to come up, then open the board on this screen (only if it's ours that answered).
  $ok = $false
  for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
    Start-Sleep -Milliseconds 300
    $r = Get-FlipServer
    if ($r -and $r.port) { $s = Get-Json "http://127.0.0.1:$($r.port)/api/status"; $ok = $s -and $s.token -eq $r.token }
    elseif (Test-Path $ErrorFile) { break }
  }
  if ($ok) { Start-Process "http://localhost:$($r.port)/board" }
  Update-Status
})
$stopBtn.Add_Click({
  $msg = $null
  Invoke-Busy 'Stopping...' { $script:stopMsg = Stop-Flip }
  if ($script:stopMsg) { [System.Windows.Forms.MessageBox]::Show($form, $script:stopMsg, 'Flip7yoke') | Out-Null }
  Reload-Config; Update-Status
})
$boardBtn.Add_Click({ Start-Process "http://localhost:$($Cfg.ports.main)/board" })
$dataBtn.Add_Click({
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Start-Process explorer.exe $DataDir
})
$fixBtn.Add_Click({
  # Install Ollama / Download model: the same setup the installer offers, in a visible console window.
  # It ends by asking the score keeper to check again. Check again just asks for that check now.
  if ($fixBtn.Text -ne 'Check again') {
    Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ScriptPath`"", '-Action', 'setup-reader'
  }
  $r = Get-FlipServer
  if ($r -and $r.port) { Post-Json "http://127.0.0.1:$($r.port)/api/reader/check" | Out-Null }
  Update-Status
})
$fwBtn.Add_Click({
  $ok = Grant-Firewall
  $script:FwAt = $null
  if (-not $ok) { [System.Windows.Forms.MessageBox]::Show($form, "Phones still can't get through the Windows firewall. Press Allow phones and answer Yes to let it add the rule.", 'Flip7yoke') | Out-Null }
  Update-Status
})

# ---- settings window ----
function Get-WifiNow {
  # The network this PC is on now. netsh output is in the Windows display language; we read the SSID line by shape.
  $out = netsh wlan show interfaces 2>$null
  foreach ($line in $out) { if ($line -match '^\s*SSID\s*:\s*(.+?)\s*$') { return $Matches[1] } }
  return $null
}
function Get-WifiKey($ssid) {
  # Needs the profile to be readable by this user; can fail on policy, permissions or non-English Windows.
  $out = netsh wlan show profile name="$ssid" key=clear 2>$null
  foreach ($line in $out) { if ($line -match '^\s*Key Content\s*:\s*(.*?)\s*$') { return $Matches[1] } }
  return $null
}

# The settings window. With -SnapshotPath it is drawn to that image file instead of shown (README screenshots, checks).
# With -AutoSave (a hashtable of field values) it is filled in off-screen and Save is pressed (selftest); problems
# land in $script:SettingsProblems instead of a message box.
function Show-Settings($SnapshotPath, $AutoSave) {
  $c = Get-Config
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Flip7yoke settings'; $f.ClientSize = New-Object System.Drawing.Size(480, 600)
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.StartPosition = 'CenterParent'
  $f.BackColor = $navy; $f.ForeColor = $ink; $f.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $tb = {
    param($x, $y, $w, $h, $text, $multi = $false)
    $t = New-Object System.Windows.Forms.TextBox
    $t.Location = New-Object System.Drawing.Point($x, $y); $t.Size = New-Object System.Drawing.Size($w, $h)
    $t.Multiline = $multi; if ($multi) { $t.ScrollBars = 'Vertical' }
    $t.Text = $text; $f.Controls.Add($t); return $t
  }

  New-Label 'PLAYERS (one per line, shown as "Played before? Tap your name")' 16 12 450 18 8 $true $muted $f | Out-Null
  $players = & $tb 16 32 448 110 (($c.players) -join "`r`n") $true
  New-Label 'SUBTITLE (under the name on the board)' 16 152 450 18 8 $true $muted $f | Out-Null
  $sub = & $tb 16 172 448 26 ([string]$c.subtitle)

  New-Label 'WI-FI QR ON THE BOARD' 16 210 450 18 8 $true $muted $f | Out-Null
  New-Label 'Network' 16 234 80 22 10 $false $ink $f | Out-Null
  $ssid = & $tb 100 232 250 26 ([string]$c.wifi.ssid)
  $detect = New-Button 'Detect' 358 231 106 28 $panel $ink $f; $detect.Font = $form.Font
  New-Label 'Password' 16 268 80 22 10 $false $ink $f | Out-Null
  $pw = & $tb 100 266 250 26 ([string]$c.wifi.password)
  $readKey = New-Button 'From Windows' 358 265 106 28 $panel $ink $f; $readKey.Font = $form.Font
  $show = New-Object System.Windows.Forms.CheckBox
  $show.Text = 'Show the network and password on the board'; $show.Checked = [bool]$c.wifi.showOnBoard
  $show.Location = New-Object System.Drawing.Point(16, 298); $show.Size = New-Object System.Drawing.Size(448, 24); $f.Controls.Add($show)
  $wifiNote = New-Label 'When ticked, every phone that opens the game is sent the password too (that is how the QR works).' 16 322 448 34 8 $false $muted $f

  New-Label 'CARD READER' 16 362 450 18 8 $true $muted $f | Out-Null
  $reader = New-Object System.Windows.Forms.CheckBox
  $reader.Text = 'Use the card reader (camera button on phones; needs Ollama)'; $reader.Checked = ($c.cardReader.enabled -ne $false)
  $reader.Location = New-Object System.Drawing.Point(16, 382); $reader.Size = New-Object System.Drawing.Size(448, 24); $f.Controls.Add($reader)

  New-Label 'JOIN ADDRESS (the one in the QR code)' 16 414 450 18 8 $true $muted $f | Out-Null
  $addr = New-Object System.Windows.Forms.ComboBox
  $addr.DropDownStyle = 'DropDownList'; $addr.Location = New-Object System.Drawing.Point(16, 434); $addr.Size = New-Object System.Drawing.Size(448, 26)
  [void]$addr.Items.Add('Automatic')
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' })
  foreach ($ip in $ips) { [void]$addr.Items.Add("$($ip.IPAddress)  ($($ip.InterfaceAlias))") }
  $addr.SelectedIndex = 0
  for ($i = 1; $i -lt $addr.Items.Count; $i++) { if ($addr.Items[$i] -like "$($c.network.address) *") { $addr.SelectedIndex = $i } }
  $f.Controls.Add($addr)

  New-Label 'PORTS' 16 472 80 18 8 $true $muted $f | Out-Null
  New-Label 'Main' 16 494 40 22 10 $false $ink $f | Out-Null
  $pMain = & $tb 60 492 80 26 ([string]$c.ports.main)
  New-Label 'Also (0 = off)' 160 494 100 22 10 $false $ink $f | Out-Null
  $pAlso = & $tb 262 492 80 26 ([string]$c.ports.also)
  New-Label 'Join address, ports and the card reader connection apply on the next Start.' 16 524 448 20 8 $false $muted $f | Out-Null

  $save = New-Button 'Save' 254 556 100 34 $green $navy $f
  $cancel = New-Button 'Cancel' 364 556 100 34 $panel $ink $f
  $cancel.Add_Click({ $f.Close() })
  $detect.Add_Click({
    $n = Get-WifiNow
    if ($n) { $ssid.Text = $n } else { [System.Windows.Forms.MessageBox]::Show($f, "Couldn't find a Wi-Fi connection on this PC. Type the network name instead.", 'Flip7yoke') | Out-Null }
  })
  $readKey.Add_Click({
    if (-not $ssid.Text) { $n = Get-WifiNow; if ($n) { $ssid.Text = $n } }
    $k = if ($ssid.Text) { Get-WifiKey $ssid.Text } else { $null }
    if ($k) { $pw.Text = $k } else { [System.Windows.Forms.MessageBox]::Show($f, "Windows didn't give the password for this network (it can refuse, or word it differently on non-English Windows). Type it in, or leave it blank.", 'Flip7yoke') | Out-Null }
  })
  $save.Add_Click({
    # Same checks as the server, so mistakes never reach the file.
    $problems = @()
    $names = @(); $seen = @{}
    foreach ($n in ($players.Text -split "`r?`n")) {
      $n = $n.Trim(); if ($n.Length -gt 20) { $n = $n.Substring(0, 20) }
      if (-not $n) { continue }
      if ($seen.ContainsKey($n.ToLower())) { $problems += "'$n' is listed twice."; continue }
      $seen[$n.ToLower()] = $true; $names += $n
    }
    $m = 0; $a = 0
    if (-not [int]::TryParse($pMain.Text.Trim(), [ref]$m) -or $m -lt 1 -or $m -gt 65535) { $problems += 'Main port must be a whole number from 1 to 65535.' }
    if (-not [int]::TryParse($pAlso.Text.Trim(), [ref]$a) -or $a -lt 0 -or $a -gt 65535) { $problems += 'Also port must be 0 (off) or a whole number from 1 to 65535.' }
    if ($m -eq $a -and $a -ne 0) { $problems += 'The two ports must be different.' }
    if ($ssid.Text.Length -gt 32) { $problems += 'The network name is longer than 32 characters.' }
    if ($pw.Text.Length -gt 63) { $problems += 'The Wi-Fi password is longer than 63 characters.' }
    $script:SettingsProblems = $problems
    if ($problems.Count) {
      if ($AutoSave) { return }
      [System.Windows.Forms.MessageBox]::Show($f, ($problems -join "`r`n"), 'Flip7yoke settings') | Out-Null; return
    }

    $c.players = @($names)
    $c.subtitle = $sub.Text.Trim()
    $c.wifi.ssid = $ssid.Text; $c.wifi.password = $pw.Text; $c.wifi.showOnBoard = $show.Checked
    $c.cardReader.enabled = if ($reader.Checked) { 'auto' } else { $false }
    $c.network.address = if ($addr.SelectedIndex -le 0) { 'auto' } else { ($addr.SelectedItem -split '\s+')[0] }
    $c.ports.main = $m; $c.ports.also = $a
    try { Save-Config $c } catch { [System.Windows.Forms.MessageBox]::Show($f, "Couldn't save settings: $($_.Exception.Message)", 'Flip7yoke') | Out-Null; return }
    $f.Close()
  })
  if ($SnapshotPath) { Save-Snapshot $f $SnapshotPath; $f.Dispose(); return }
  if ($AutoSave) {
    Show-OffScreen $f
    if ($AutoSave.ContainsKey('players')) { $players.Text = ($AutoSave.players -join "`r`n") }
    if ($AutoSave.ContainsKey('subtitle')) { $sub.Text = $AutoSave.subtitle }
    if ($AutoSave.ContainsKey('ssid')) { $ssid.Text = $AutoSave.ssid }
    if ($AutoSave.ContainsKey('password')) { $pw.Text = $AutoSave.password }
    if ($AutoSave.ContainsKey('showOnBoard')) { $show.Checked = [bool]$AutoSave.showOnBoard }
    if ($AutoSave.ContainsKey('reader')) { $reader.Checked = [bool]$AutoSave.reader }
    if ($AutoSave.ContainsKey('main')) { $pMain.Text = [string]$AutoSave.main }
    if ($AutoSave.ContainsKey('also')) { $pAlso.Text = [string]$AutoSave.also }
    $save.PerformClick()
    $f.Dispose()
    return
  }
  [void]$f.ShowDialog($form)
  $subLbl.Text = [string](Get-Config).subtitle
  Update-Status
}
$settingsBtn.Add_Click({ Show-Settings })

# Controls only exist once a window is shown, so show it off-screen and fully transparent for a moment.
function Show-OffScreen($win) {
  $win.StartPosition = 'Manual'; $win.Location = New-Object System.Drawing.Point(-20000, -20000)
  $win.ShowInTaskbar = $false; $win.Opacity = 0
  $win.Show(); [System.Windows.Forms.Application]::DoEvents()
}

# Draw a window to a PNG without putting it on screen.
function Save-Snapshot($win, $path) {
  Show-OffScreen $win
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $win.Width, $win.Height
  $win.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $win.Width, $win.Height))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $win.Hide()
}

if ($Action -eq 'snapshot') {
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  Update-Status
  Save-Snapshot $form (Join-Path $Out 'control-window.png')
  Show-Settings (Join-Path $Out 'settings-window.png')
  "Saved control-window.png and settings-window.png in $Out"
  return
}

if ($Action -eq 'selftest') {
  # $Out is a JSON file of field values, e.g. {"players":["A","B"],"main":7790,"also":0}.
  $vals = @{}
  ([IO.File]::ReadAllText($Out) | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $vals[$_.Name] = $_.Value }
  Show-Settings $null $vals
  if (@($script:SettingsProblems).Count) { "PROBLEMS: $($script:SettingsProblems -join ' | ')"; exit 1 }
  'SAVED'
  exit 0
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-Status })
$form.Add_Shown({ Update-Status; $timer.Start() })
$form.Add_FormClosed({ $timer.Stop() })

[System.Windows.Forms.Application]::Run($form)
