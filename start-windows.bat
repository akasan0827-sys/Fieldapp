@echo off
REM Double-click to start the stock manager on this PC.
REM Other PCs and phones on the office network open http://THIS-PC-IP:3000
cd /d "%~dp0"
set TZ=Asia/Seoul
node server\index.js
pause
