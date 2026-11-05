@echo off
rem Opens the Flip 7 window (Start / Stop). The score keeper and card reader run in the background.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Flip7.ps1"
