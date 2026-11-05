@echo off
title Flip 7 score keeper
rem Card reader: start Ollama inside WSL (does nothing if it is already running)
start "Flip 7 card reader" /min wsl.exe -e bash -lc "~/ollama/bin/ollama serve"
start "" cmd /c "timeout /t 2 >nul & start http://localhost:7777/board"
rem run.js restarts the server by itself whenever its code is updated
node "\\wsl.localhost\Ubuntu\home\facepipe\flip7\run.js"
pause
