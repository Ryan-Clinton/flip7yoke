@echo off
rem Double-click in the sandbox to check an uninstall done after acceptance.ps1 stopped waiting.
rem Shows the result and saves it to the results folder for the host.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$app = \"$env:LOCALAPPDATA\Programs\Flip7yoke\"; $data = \"$env:LOCALAPPDATA\Flip7yoke\";" ^
  "$l = @(\"$(Get-Date -Format HH:mm:ss) uninstall checked by hand\"," ^
  "\"program folder left: $(Test-Path $app)\"," ^
  "\"data folder left: $(Test-Path $data)\"," ^
  "\"rules named Flip7yoke left: $(@(Get-NetFirewallRule -DisplayName Flip7yoke -ErrorAction SilentlyContinue).Count)\"," ^
  "\"server processes left: $(@(Get-Process Flip7yoke-server -ErrorAction SilentlyContinue).Count)\");" ^
  "$l | Write-Host; try { $l | Set-Content C:\fy\results\check-uninstall.txt -ErrorAction Stop; Write-Host 'Saved for the host.' } catch { Write-Host $_ }"
pause
