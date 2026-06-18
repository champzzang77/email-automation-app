#!/bin/bash
# 이메일 자동화 서비스 — 시작 스크립트 (Mac)
# Finder에서 더블클릭으로 실행하세요

# 이 스크립트가 있는 폴더로 이동
cd "$(dirname "$0")"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  이메일 자동화 서비스 시작"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Node.js 확인 ─────────────────────────────
if ! command -v node &>/dev/null; then
  echo "✗ Node.js가 설치되어 있지 않습니다."
  echo ""
  echo "  아래 주소에서 Node.js LTS를 설치하세요:"
  echo "  https://nodejs.org"
  echo ""
  open "https://nodejs.org"
  read -p "설치 후 엔터를 누르세요..."
  if ! command -v node &>/dev/null; then
    echo "✗ Node.js를 찾을 수 없습니다. 터미널을 닫고 다시 시도하세요."
    read -p "엔터를 눌러 종료..."
    exit 1
  fi
fi
echo "✓ Node.js $(node -v)"

# ── 2. npm install ───────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "▶ 패키지 설치 중... (최초 1회, 1~2분 소요)"
  npm install
  if [ $? -ne 0 ]; then
    echo "✗ npm install 실패"
    read -p "엔터를 눌러 종료..."
    exit 1
  fi
  echo "✓ 패키지 설치 완료"
fi

# ── 3. Playwright Chromium 확인 ──────────────────
node -e "
const { chromium } = require('playwright');
const fs = require('fs');
const execPath = chromium.executablePath();
if (!fs.existsSync(execPath)) { process.exit(1); }
" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "▶ Chromium 설치 중... (~300MB, 시간이 걸릴 수 있습니다)"
  npx playwright install chromium
  echo "✓ Chromium 설치 완료"
fi

# ── 4. 기존 서버 종료 (포트 3412 충돌 방지) ──────
lsof -ti:3412 | xargs kill -9 2>/dev/null || true

# ── 5. 서버 시작 ────────────────────────────────
echo ""
echo "▶ 서버 시작 중..."
node server.js &
SERVER_PID=$!

# 서버가 뜰 때까지 대기
for i in {1..10}; do
  sleep 1
  if curl -s http://localhost:3412 &>/dev/null; then
    break
  fi
done

# ── 6. Chrome에서 자동 오픈 ─────────────────────
echo "✓ 서버 시작 완료"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ 앱 시작: http://localhost:3412"
echo "  이 창을 닫으면 서버가 종료됩니다."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Chrome → 기본 브라우저 순서로 오픈
if open -a "Google Chrome" "http://localhost:3412" 2>/dev/null; then
  :
elif open -a "Safari" "http://localhost:3412" 2>/dev/null; then
  :
else
  open "http://localhost:3412"
fi

# 서버 프로세스 유지 (창 닫으면 종료)
wait $SERVER_PID
