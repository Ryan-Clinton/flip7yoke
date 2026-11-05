@echo off
title Flip 7 score keeper
start "" cmd /c "timeout /t 2 >nul & start http://localhost:7777/board"
node "\\wsl.localhost\Ubuntu\home\facepipe\flip7\server.js"
pause
