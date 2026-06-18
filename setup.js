#!/usr/bin/env node
/**
 * setup.js — Mac / Windows 공통 설치 스크립트
 *
 * 실행:
 *   node setup.js
 */

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const ROOT  = __dirname;

const npm  = isWin ? 'npm.cmd'  : 'npm';
const npx  = isWin ? 'npx.cmd'  : 'npx';
const node = process.execPath;

// ─── 출력 헬퍼 ──────────────────────────────────────────────────────────────

const c = {
  ok:    s => `\x1b[32m${s}\x1b[0m`,
  err:   s => `\x1b[31m${s}\x1b[0m`,
  warn:  s => `\x1b[33m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`,
  dim:   s => `\x1b[2m${s}\x1b[0m`,
};

function log(msg)  { console.log(msg); }
function ok(msg)   { console.log(c.ok('  ✓ ' + msg)); }
function err(msg)  { console.log(c.err('  ✗ ' + msg)); }
function warn(msg) { console.log(c.warn('  ! ' + msg)); }
function step(msg) { console.log(c.bold('\n▶ ' + msg)); }

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWin, ...opts });
    cp.on('close', code => resolve(code === 0));
    cp.on('error', () => resolve(false));
  });
}

function cmdExists(cmd) {
  try { execSync(`${cmd} --version`, { stdio: 'ignore', shell: isWin }); return true; }
  catch { return false; }
}

// ─── HunetMessenger config 경로 ─────────────────────────────────────────────

function getHunetConfigPath() {
  if (isWin) {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'HunetMessenger', 'config.json');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'HunetMessenger', 'config.json');
}

// ─── 메인 ───────────────────────────────────────────────────────────────────

async function main() {
  log('');
  log(c.bold('━'.repeat(52)));
  log(c.bold('  휴넷 이메일 자동화 — 설치 / 상태 확인'));
  log(c.bold(`  플랫폼: ${isMac ? 'macOS' : isWin ? 'Windows' : process.platform}`));
  log(c.bold('━'.repeat(52)));

  // ── 1. Node.js ──────────────────────────────────────────────────────────
  step('Node.js 확인');
  ok(`Node.js ${process.version}  (${process.execPath})`);

  // ── 2. npm 의존성 ────────────────────────────────────────────────────────
  step('npm 의존성 설치');
  const pkgFile = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    warn('package.json 없음 → 기본 package.json 생성');
    fs.writeFileSync(pkgFile, JSON.stringify({
      name: 'hunet-mail-automation', version: '1.0.0', private: true,
      dependencies: { playwright: '^1.40.0' },
    }, null, 2));
  }
  const nmOk = await run(npm, ['install']);
  if (nmOk) ok('npm install 완료');
  else { err('npm install 실패'); process.exit(1); }

  // ── 3. Playwright / Chromium ─────────────────────────────────────────────
  step('Playwright Chromium 확인');
  let chromiumOk = false;
  try {
    const { chromium } = require('playwright');
    const execPath = chromium.executablePath();
    if (fs.existsSync(execPath)) { ok('Chromium 이미 설치됨'); chromiumOk = true; }
  } catch {}

  if (!chromiumOk) {
    warn('Chromium 없음 → 다운로드 시작 (~300 MB, 시간이 걸릴 수 있습니다)');
    const dlOk = await run(npx, ['playwright', 'install', 'chromium']);
    if (dlOk) ok('Chromium 설치 완료');
    else err('Chromium 설치 실패 — 네트워크 연결 상태를 확인하세요');
  }

  // ── 4. HunetMessenger 설정 ───────────────────────────────────────────────
  step('HunetMessenger 설정 확인');
  const cfgPath = getHunetConfigPath();
  log(c.dim('  경로: ' + cfgPath));
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.token && cfg.host) ok('HunetMessenger 로그인 정보 확인됨');
      else warn('config.json은 있지만 token/host 없음 — HunetMessenger에서 로그인해주세요');
    } catch { warn('config.json 파싱 실패'); }
  } else {
    err('HunetMessenger 설정 파일 없음');
    warn('HunetMessenger 앱을 먼저 설치하고 로그인 후 다시 실행하세요');
    warn('다운로드: https://messenger.hunet.co.kr');
  }

  // ── 5. 출력 디렉터리 ─────────────────────────────────────────────────────
  step('.mail-output / .profiles 폴더 확인');
  fs.mkdirSync(path.join(ROOT, '.mail-output'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, '.profiles', 'hunet-mail'), { recursive: true });
  ok('폴더 준비 완료');

  // ── 6. 자동 시작 등록 ────────────────────────────────────────────────────
  step('서버 자동 시작 등록');
  const serverPath = path.join(ROOT, 'server.js');

  if (isMac) {
    const plistDir  = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plistPath = path.join(plistDir, 'co.hunet.mail-server.plist');
    fs.mkdirSync(plistDir, { recursive: true });
    if (fs.existsSync(plistPath)) {
      ok('macOS LaunchAgent 이미 등록됨');
    } else {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>co.hunet.mail-server</string>
  <key>ProgramArguments</key><array>
    <string>${node}</string>
    <string>${serverPath}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(ROOT, '.server.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(ROOT, '.server.error.log')}</string>
</dict></plist>`;
      fs.writeFileSync(plistPath, plist);
      const loaded = await run('launchctl', ['load', plistPath]);
      if (loaded) ok('LaunchAgent 등록 완료 — 로그인 시 서버 자동 시작');
      else warn('LaunchAgent 등록 실패 — 수동으로 node server.js 실행하세요');
    }
  } else if (isWin) {
    const taskName = 'HunetMailServer';
    let exists = false;
    try { execSync(`schtasks /query /tn ${taskName}`, { stdio: 'ignore', shell: true }); exists = true; } catch {}
    if (exists) {
      ok('Windows 작업 스케줄러 이미 등록됨');
    } else {
      const ok2 = await run('schtasks', [
        '/create', '/tn', taskName,
        '/tr', `"${node}" "${serverPath}"`,
        '/sc', 'onlogon', '/ru', process.env.USERNAME || os.userInfo().username, '/f',
      ]);
      if (ok2) ok('작업 스케줄러 등록 완료 — 로그인 시 서버 자동 시작');
      else warn('작업 스케줄러 등록 실패 — 관리자 권한으로 다시 실행하거나 수동 시작하세요');
    }
  }

  // ── 7. 서버 상태 확인 ────────────────────────────────────────────────────
  step('서버 연결 확인 (http://localhost:3412)');
  try {
    const http = require('http');
    await new Promise((resolve, reject) => {
      const req = http.get('http://localhost:3412', r => {
        if (r.statusCode === 200) { ok('서버 실행 중'); resolve(); }
        else { warn(`서버 응답 코드: ${r.statusCode}`); resolve(); }
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch {
    warn('서버가 실행 중이지 않습니다');
    log(c.dim('  → node server.js 로 서버를 먼저 시작하세요'));
  }

  // ── 완료 ─────────────────────────────────────────────────────────────────
  log('');
  log(c.bold('━'.repeat(52)));
  log(c.ok(c.bold('  설치 완료!')));
  log('');
  log(`  서버 시작:  ${c.bold('node server.js')}`);
  log(`  앱 열기:    ${c.bold('http://localhost:3412')}`);
  log(c.bold('━'.repeat(52)));
  log('');
}

main().catch(e => { console.error(c.err('\n[오류] ' + e.message)); process.exit(1); });
