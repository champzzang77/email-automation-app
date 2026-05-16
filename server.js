/**
 * server.js
 * 이메일 자동화 서비스 로컬 서버
 *
 * 역할:
 *   1. email-automation-app.html 정적 서빙
 *   2. GET  /api/mails        → 최신 .mail-output/*.json 반환
 *   3. POST /api/fetch        → hunet_mail_v2.js 실행 (Playwright 트리거)
 *   4. POST /api/reply        → 발송 이력 .mail-output/reply-log.json 에 기록
 *   5. GET  /api/reply-log    → 발송 이력 반환
 *
 * 실행:
 *   node server.js
 *   node server.js --port=3412
 */

const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { spawn }  = require('child_process');
const session    = require('./scripts/hunet-session');

// ─── 설정 ──────────────────────────────────────────────────────────────────

const PORT        = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3412', 10);
const ROOT        = __dirname;
const OUTPUT_DIR  = path.join(ROOT, '.mail-output');
const HTML_FILE   = path.join(ROOT, 'email-automation-app.html');
const REPLY_LOG   = path.join(OUTPUT_DIR, 'reply-log.json');
const APP_CONFIG  = path.join(ROOT, '.app-config.json');

function readAppConfig() {
  try { return JSON.parse(fs.readFileSync(APP_CONFIG, 'utf8')); } catch { return {}; }
}
function saveAppConfig(data) {
  fs.writeFileSync(APP_CONFIG, JSON.stringify({ ...readAppConfig(), ...data }, null, 2));
}

// ─── 헬퍼 ──────────────────────────────────────────────────────────────────

function getLatestMailFile() {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('mail_') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files[0] ? path.join(OUTPUT_DIR, files[0]) : null;
}

function readReplyLog() {
  if (!fs.existsSync(REPLY_LOG)) return [];
  try { return JSON.parse(fs.readFileSync(REPLY_LOG, 'utf8')); } catch { return []; }
}

function res_json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

// ─── 라우터 ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // 모든 응답에 CORS 허용 (file:// 포함)
  const origin = req.headers['origin'] || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET / → HTML ──────────────────────────────────────────────────────────
  if (url.pathname === '/' && method === 'GET') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('email-automation-app.html not found: ' + e.message);
    }
    return;
  }

  // ── GET /api/mails → 최신 수집 결과 반환 ─────────────────────────────────
  if (url.pathname === '/api/mails' && method === 'GET') {
    const file = getLatestMailFile();
    if (!file) {
      return res_json(res, 200, { mails: [], count: 0, timestamp: null });
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      res_json(res, 200, {
        mails:     data.mails     || [],
        count:     data.count     || 0,
        timestamp: data.timestamp || null,
      });
    } catch (e) {
      res_json(res, 500, { error: e.message });
    }
    return;
  }

  // ── POST /api/fetch → Playwright 실행 ────────────────────────────────────
  if (url.pathname === '/api/fetch' && method === 'POST') {
    const opts = await parseBody(req);
    const nodeBin = process.execPath;
    const args = ['launch.js'];
    if (opts.limit)    args.push(`--limit=${opts.limit}`);
    if (opts.folder)   args.push(`--folder=${opts.folder}`);

    console.log(`\n[fetch] node ${args.join(' ')}`);

    const child = spawn(nodeBin, args, { cwd: ROOT });
    let stdout = '', stderr = '';

    child.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d; process.stderr.write(d); });

    child.on('close', (code) => {
      if (code !== 0) {
        return res_json(res, 500, { ok: false, error: stderr || `exit ${code}` });
      }
      const file = getLatestMailFile();
      if (!file) return res_json(res, 200, { ok: true, mails: [], count: 0 });
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        res_json(res, 200, {
          ok:         true,
          mails:      data.mails      || [],
          count:      data.count      || 0,
          timestamp:  data.timestamp  || null,
          folderFull: data.folderFull || null,
          sharedFlag: data.sharedFlag || 'user',
        });
      } catch (e) {
        res_json(res, 500, { ok: false, error: e.message });
      }
    });

    // Playwright가 끝날 때까지 연결 유지 (최대 10분)
    req.socket.setTimeout(600_000);
    return;
  }

  // ── POST /api/reply → 발송 이력 기록 ─────────────────────────────────────
  if (url.pathname === '/api/reply' && method === 'POST') {
    const entry = await parseBody(req);
    if (!entry || !entry.to) return res_json(res, 400, { error: 'invalid body' });

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const log = readReplyLog();
    log.unshift({ ...entry, loggedAt: new Date().toISOString() });
    fs.writeFileSync(REPLY_LOG, JSON.stringify(log, null, 2), 'utf8');
    res_json(res, 200, { ok: true });
    return;
  }

  // ── GET /api/reply-log → 발송 이력 반환 ──────────────────────────────────
  if (url.pathname === '/api/reply-log' && method === 'GET') {
    res_json(res, 200, readReplyLog());
    return;
  }

  // ── POST /api/send → Hunet 메일 실제 발송 ─────────────────────────────────
  if (url.pathname === '/api/send' && method === 'POST') {
    const { to, subject, body, originalMailId, originalFolder } = await parseBody(req);
    if (!to || !subject) return res_json(res, 400, { ok: false, error: 'to, subject 필수' });
    try {
      console.log(`\n[send] to=${to} subject=${subject.substring(0, 30)}`);
      req.socket.setTimeout(120_000);
      const result = await session.sendMail({ to, subject, body, originalMailId, originalFolder });
      res_json(res, 200, result);
    } catch (e) {
      console.error('[send 오류]', e.message);
      res_json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ── POST /api/mark-read → 메일 읽음 처리 ──────────────────────────────────
  if (url.pathname === '/api/mark-read' && method === 'POST') {
    const { mailId, folder, sharedFlag } = await parseBody(req);
    if (!mailId) return res_json(res, 400, { ok: false, error: 'mailId 필수' });
    try {
      console.log(`\n[mark-read] mailId=${mailId} folder=${folder}`);
      const result = await session.markRead(mailId, folder || 'Inbox', sharedFlag || 'user');
      res_json(res, 200, result);
    } catch (e) {
      console.error('[mark-read 오류]', e.message);
      res_json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ── GET /api/config → 앱 설정 반환 ───────────────────────────────────────
  if (url.pathname === '/api/config' && method === 'GET') {
    const cfg = readAppConfig();
    res_json(res, 200, { claudeApiKeySet: !!cfg.claudeApiKey });
    return;
  }

  // ── POST /api/config → 앱 설정 저장 ──────────────────────────────────────
  if (url.pathname === '/api/config' && method === 'POST') {
    const body = await parseBody(req);
    if (body.claudeApiKey !== undefined) saveAppConfig({ claudeApiKey: body.claudeApiKey });
    res_json(res, 200, { ok: true });
    return;
  }

  // ── POST /api/classify → Claude AI로 메일 분류 ────────────────────────────
  if (url.pathname === '/api/classify' && method === 'POST') {
    const { mails } = await parseBody(req);
    const { claudeApiKey } = readAppConfig();
    if (!claudeApiKey) return res_json(res, 400, { ok: false, error: 'Claude API 키가 설정되지 않았습니다' });
    if (!mails || !mails.length) return res_json(res, 200, { ok: true, results: [] });

    try {
      const https = require('https');
      const prompt = `아래 이메일 목록을 분류해주세요. 각 메일의 id와 함께 유형을 반환하세요.
유형은 반드시 다음 중 하나여야 합니다: apply(교육 신청), change(일정 변경), cancel(취소/환불), other(기타 문의)

메일 목록:
${mails.map(m => `[id:${m.id}] 제목: ${m.subject}\n본문: ${(m.body||'').substring(0, 200)}`).join('\n\n')}

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이:
[{"id": 숫자, "type": "유형", "confidence": 0.0~1.0, "reason": "한줄 이유"}]`;

      const reqBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': claudeApiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(reqBody),
          },
        }, (r) => {
          let data = '';
          r.on('data', c => data += c);
          r.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) return reject(new Error(parsed.error.message));
              const text = parsed.content?.[0]?.text || '[]';
              const jsonMatch = text.match(/\[[\s\S]*\]/);
              resolve(JSON.parse(jsonMatch ? jsonMatch[0] : '[]'));
            } catch(e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(reqBody);
        req.end();
      });

      res_json(res, 200, { ok: true, results: result });
    } catch(e) {
      console.error('[classify 오류]', e.message);
      res_json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ── GET /api/setup → 사전 프로그램 설치 (SSE 스트리밍) ───────────────────────
  if (url.pathname === '/api/setup' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': req.headers['origin'] || '*',
    });

    const send = (msg, type = 'log') => {
      res.write(`data: ${JSON.stringify({ type, msg })}\n\n`);
    };

    const run = (cmd, args, label) => new Promise((resolve) => {
      send(`▶ ${label}...`);
      const cp = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, HOME: process.env.HOME } });
      cp.stdout.on('data', d => send(d.toString().trim()));
      cp.stderr.on('data', d => {
        const t = d.toString().trim();
        if (t) send(t);
      });
      cp.on('close', code => {
        if (code === 0) send(`✓ ${label} 완료`, 'ok');
        else send(`✗ ${label} 실패 (종료코드 ${code})`, 'error');
        resolve(code === 0);
      });
    });

    (async () => {
      const isMac = process.platform === 'darwin';
      const isWin = process.platform === 'win32';
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      const nodeBin = path.dirname(process.execPath);
      const npm  = path.join(nodeBin, isWin ? 'npm.cmd' : 'npm');
      const npx  = path.join(nodeBin, isWin ? 'npx.cmd' : 'npx');

      send(`=== 사전 프로그램 설치 시작 (${isMac ? 'macOS' : isWin ? 'Windows' : process.platform}) ===`);

      // 1. Node.js 확인
      send('▶ Node.js 확인...');
      send(`✓ Node.js ${process.version} 설치됨 (${process.execPath})`, 'ok');
      send('  ※ 이 서버 자체가 Node.js로 실행 중이므로 정상 설치된 상태입니다.');

      // 2. Playwright 설치 확인
      send('▶ Playwright 확인...');
      let playwrightOk = false;
      try { require.resolve('playwright'); playwrightOk = true; send('✓ Playwright 이미 설치됨', 'ok'); } catch {}

      if (!playwrightOk) {
        playwrightOk = await run(npm, ['install', 'playwright', '--save'], 'Playwright 설치');
      }

      // 3. Chromium 설치 확인
      if (playwrightOk) {
        send('▶ Chromium 설치 확인...');
        const { chromium } = require('playwright');
        const execPath = chromium.executablePath();
        if (fs.existsSync(execPath)) {
          send('✓ Chromium 이미 설치됨', 'ok');
        } else {
          await run(npx, ['playwright', 'install', 'chromium'], 'Chromium 다운로드 (~300MB, 시간이 걸릴 수 있습니다)');
        }
      }

      // 4. HunetMessenger config 확인
      send('▶ HunetMessenger 설정 확인...');
      const cfgPath = isMac
        ? path.join(homeDir, 'Library', 'Application Support', 'HunetMessenger', 'config.json')
        : path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'HunetMessenger', 'config.json');
      if (fs.existsSync(cfgPath)) {
        send('✓ HunetMessenger 설정 파일 확인됨', 'ok');
      } else {
        send('✗ HunetMessenger 설정 파일 없음 — HunetMessenger 앱을 먼저 설치하고 로그인해주세요', 'error');
      }

      // 5. 서버 자동 시작 등록
      send('▶ 서버 자동 시작 설정 확인...');
      if (isMac) {
        const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'co.hunet.mail-server.plist');
        if (fs.existsSync(plistPath)) {
          send('✓ macOS LaunchAgent 등록됨 (로그인 시 자동 시작)', 'ok');
        } else {
          const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>co.hunet.mail-server</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${path.join(ROOT, 'server.js')}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(ROOT, 'server.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(ROOT, 'server-error.log')}</string>
</dict></plist>`;
          fs.writeFileSync(plistPath, plist);
          await run('launchctl', ['load', plistPath], 'LaunchAgent 등록');
        }
      } else if (isWin) {
        const taskName = 'HunetMailServer';
        const checkResult = await new Promise(resolve => {
          const cp = spawn('schtasks', ['/query', '/tn', taskName], { shell: true });
          cp.on('close', code => resolve(code === 0));
        });
        if (checkResult) {
          send('✓ Windows 작업 스케줄러 등록됨 (로그인 시 자동 시작)', 'ok');
        } else {
          const serverPath = path.join(ROOT, 'server.js');
          const ok = await run('schtasks', [
            '/create', '/tn', taskName,
            '/tr', `"${process.execPath}" "${serverPath}"`,
            '/sc', 'onlogon',
            '/ru', process.env.USERNAME,
            '/f',
          ], 'Windows 작업 스케줄러 등록');
          if (!ok) send('  ※ 관리자 권한으로 실행하거나 수동으로 등록해주세요.');
        }
      }

      send('=== 설치 완료 ===', 'done');
      res.end();
    })();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n' + '━'.repeat(50));
  console.log(`  이메일 자동화 서비스`);
  console.log(`  http://localhost:${PORT}`);
  console.log('━'.repeat(50) + '\n');

  // 서버 시작 후 세션 사전 준비 (백그라운드)
  session.getPage().catch(e => console.error('[session 초기화 실패]', e.message));
});

process.on('exit',    () => session.close());
process.on('SIGTERM', () => session.close().then(() => process.exit(0)));
process.on('SIGINT',  () => session.close().then(() => process.exit(0)));
