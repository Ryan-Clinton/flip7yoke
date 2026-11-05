# Flip 7 control window: start and stop the score keeper (Windows Node) and the card reader (Ollama in WSL).
# Runs standalone, so Start works when nothing else is running. Closing the window leaves the game running.
# Also usable without the window: Flip7.ps1 -Action start | stop | status
param([ValidateSet('gui', 'start', 'stop', 'status')] [string]$Action = 'gui')

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunJs = Join-Path $Root 'run.js'
$LogDir = Join-Path $Root 'logs'
$ScoreUrl = 'http://127.0.0.1:7777'
$ReaderUrl = 'http://127.0.0.1:11434'

function Get-Json($url) {
  try {
    $req = [System.Net.WebRequest]::Create($url)
    $req.Timeout = 800
    $resp = $req.GetResponse()
    $text = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    $resp.Close()
    return $text | ConvertFrom-Json
  } catch { return $null }
}

# The launcher (run.js) and the server it runs (server.js), launcher first so it can't respawn the server.
function Get-FlipProcs {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'flip7' -and $_.CommandLine -match '(run|server)\.js' } |
    Sort-Object { $_.CommandLine -notmatch 'run\.js' }
}

function Start-Flip {
  if (-not (Get-Json "$ReaderUrl/api/version")) {
    # exec makes Ollama take over bash's PID, so the PID file points at Ollama itself for Stop.
    Start-Process wsl.exe -WindowStyle Hidden -ArgumentList '-e bash -lc "echo $$ > ~/ollama/serve.pid; exec ~/ollama/bin/ollama serve >> ~/ollama/serve.log 2>&1"'
  }
  if (-not (Get-FlipProcs)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $log = Join-Path $LogDir 'server.log'
    Start-Process cmd.exe -WindowStyle Hidden -WorkingDirectory $env:USERPROFILE -ArgumentList "/c node `"$RunJs`" > `"$log`" 2>&1"
  }
}

function Stop-Flip {
  Get-FlipProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Get-Json "$ReaderUrl/api/version") {
    Start-Process wsl.exe -WindowStyle Hidden -Wait -ArgumentList '-e bash -lc "test -f ~/ollama/serve.pid && kill $(cat ~/ollama/serve.pid); rm -f ~/ollama/serve.pid"'
  }
}

function Get-FlipStatus {
  $s = Get-Json "$ScoreUrl/api/status"
  $score = if ($s) {
    $who = if ($s.players.Count) { "$($s.players.Count) players, round $($s.round)" } else { 'no players yet' }
    @{ On = $true; Text = "Running: $($s.devices) device(s) connected, $who ($($s.mode))" }
  } elseif (Get-FlipProcs) { @{ On = $null; Text = 'Starting...' } } else { @{ On = $false; Text = 'Stopped' } }

  $phone = if ($s) { @($s.urls | Where-Object { $_ -match '//(192\.168|10\.)' })[0] } else { $null }

  $reader = if (Get-Json "$ReaderUrl/api/version") {
    $ps = Get-Json "$ReaderUrl/api/ps"
    if ($ps -and $ps.models.Count) {
      $gb = [math]::Round($ps.models[0].size_vram / 1GB, 1)
      @{ On = $true; Text = "Running: model loaded on the GPU ($gb GB)" }
    } else { @{ On = $true; Text = 'Running: model loads on the first photo' } }
  } else { @{ On = $false; Text = 'Stopped' } }

  return @{ Score = $score; Reader = $reader; Phone = $phone }
}

switch ($Action) {
  'start'  { Start-Flip; return }
  'stop'   { Stop-Flip; return }
  'status' { $st = Get-FlipStatus; "Score keeper: $($st.Score.Text)"; "Card reader:  $($st.Reader.Text)"; "Phones:       $($st.Phone)"; return }
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
$form.ClientSize = New-Object System.Drawing.Size(460, 330)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.BackColor = $navy
$form.ForeColor = $ink
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

function New-Label($text, $x, $y, $w, $h, $size = 10, $bold = $false, $color = $ink) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.Size = New-Object System.Drawing.Size($w, $h)
  $l.ForeColor = $color
  $l.Font = New-Object System.Drawing.Font('Segoe UI', $size, $(if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }))
  $form.Controls.Add($l); return $l
}
function New-Button($text, $x, $y, $w, $h, $back, $fore) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, $h)
  $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0; $b.BackColor = $back; $b.ForeColor = $fore
  $b.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $b.Cursor = 'Hand'
  $form.Controls.Add($b); return $b
}

New-Label 'Flip7yoke' 20 14 260 34 18 $true $gold | Out-Null
New-Label 'Thursday game night' 210 24 230 22 10 $false $muted | Out-Null
New-Label 'SCORE KEEPER' 20 62 420 18 8 $true $muted | Out-Null
$scoreLbl = New-Label '...' 20 80 420 22 10
New-Label 'CARD READER' 20 112 420 18 8 $true $muted | Out-Null
$readerLbl = New-Label '...' 20 130 420 22 10
New-Label 'PHONES JOIN AT' 20 162 420 18 8 $true $muted | Out-Null
$phoneLbl = New-Label '-' 20 180 420 26 12 $true $gold

$startBtn = New-Button 'Start' 20 220 205 46 $green $navy
$stopBtn = New-Button 'Stop' 235 220 205 46 $red ([System.Drawing.Color]::White)
$boardBtn = New-Button 'Open scoreboard' 20 276 205 36 $panel $ink
$photosBtn = New-Button 'Open photos folder' 235 276 205 36 $panel $ink
$boardBtn.Font = $photosBtn.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$busy = $false
function Update-Status {
  if ($script:busy) { return }
  $st = Get-FlipStatus
  foreach ($pair in @(@($scoreLbl, $st.Score), @($readerLbl, $st.Reader))) {
    $pair[0].Text = $pair[1].Text
    $pair[0].ForeColor = if ($pair[1].On -eq $true) { $green } elseif ($pair[1].On -eq $false) { $red } else { $gold }
  }
  $phoneLbl.Text = if ($st.Phone) { $st.Phone } else { '-' }
  $running = $st.Score.On -or $st.Reader.On
  $startBtn.Enabled = -not ($st.Score.On -and $st.Reader.On)
  $stopBtn.Enabled = [bool]$running
  $boardBtn.Enabled = [bool]$st.Score.On
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

$startBtn.Add_Click({
  Invoke-Busy 'Starting...' { Start-Flip }
  # Give both a moment to come up, then open the board on this screen.
  for ($i = 0; $i -lt 30 -and -not (Get-Json "$ScoreUrl/api/status"); $i++) { Start-Sleep -Milliseconds 300 }
  if (Get-Json "$ScoreUrl/api/status") { Start-Process "$ScoreUrl/board".Replace('127.0.0.1', 'localhost') }
  Update-Status
})
$stopBtn.Add_Click({ Invoke-Busy 'Stopping...' { Stop-Flip }; Start-Sleep -Milliseconds 500; Update-Status })
$boardBtn.Add_Click({ Start-Process 'http://localhost:7777/board' })
$photosBtn.Add_Click({
  $dir = Join-Path $Root 'scans'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Start-Process explorer.exe $dir
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-Status })
$form.Add_Shown({ Update-Status; $timer.Start() })
$form.Add_FormClosed({ $timer.Stop() })

[System.Windows.Forms.Application]::Run($form)
