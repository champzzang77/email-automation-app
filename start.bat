@echo off
chcp 65001 >nul
title 이메일 자동화 서비스

cd /d "%~dp0"

echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   이메일 자동화 서비스 시작
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

:: ── 1. Node.js 확인 ─────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo  X  Node.js가 설치되어 있지 않습니다.
  echo.
  echo     아래 주소에서 Node.js LTS를 설치하세요:
  echo     https://nodejs.org
  echo.
  start https://nodejs.org
  pause
  where node >nul 2>&1
  if %errorlevel% neq 0 (
    echo  X  Node.js를 찾을 수 없습니다. 설치 후 다시 실행하세요.
    pause
    exit /b 1
  )
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo  V  Node.js %NODE_VER%

:: ── 2. npm install ───────────────────────────────
if not exist "node_modules\" (
  echo  ^>  패키지 설치 중... 최초 1회, 1~2분 소요
  call npm.cmd install
  if %errorlevel% neq 0 (
    echo  X  npm install 실패
    pause
    exit /b 1
  )
  echo  V  패키지 설치 완료
)

:: ── 3. Playwright Chromium 확인 ──────────────────
node -e "try{const {chromium}=require('playwright');const fs=require('fs');if(!fs.existsSync(chromium.executablePath()))process.exit(1);}catch{process.exit(1);}" >nul 2>&1
if %errorlevel% neq 0 (
  echo  ^>  Chromium 설치 중... 약 300MB, 시간이 걸릴 수 있습니다
  call npx.cmd playwright install chromium
  echo  V  Chromium 설치 완료
)

:: ── 4. 기존 서버 종료 (포트 3412 충돌 방지) ──────
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3412 "') do (
  taskkill /f /pid %%a >nul 2>&1
)

:: ── 5. 서버 시작 ────────────────────────────────
echo.
echo  ^>  서버 시작 중...
start /b node server.js

:: 서버 뜰 때까지 대기
timeout /t 3 /nobreak >nul

:: ── 6. Chrome에서 자동 오픈 ─────────────────────
echo  V  서버 시작 완료
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   V  앱 시작: http://localhost:3412
echo   이 창을 닫으면 서버가 종료됩니다.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

:: Chrome → Edge → 기본 브라우저 순서
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
set CHROME86="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
set EDGE="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

if exist %CHROME% (
  start "" %CHROME% "http://localhost:3412"
) else if exist %CHROME86% (
  start "" %CHROME86% "http://localhost:3412"
) else if exist %EDGE% (
  start "" %EDGE% "http://localhost:3412"
) else (
  start "" "http://localhost:3412"
)

:: 서버 프로세스 유지
node server.js
pause
