/**
 * hunet-session.js
 * 로그인된 Hunet 브라우저 세션을 유지하고 재사용하는 싱글톤
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE, 'Library', 'Application Support', 'HunetMessenger', 'config.json');
// hunet_mail_v2.js 와 동일한 프로필 사용 → 이미 로그인된 Chrome 세션 재사용
const PROFILE_DIR = path.join(__dirname, '..', '.profiles', 'hunet-mail');

let context  = null;
let mainPage = null;
let baseUrl  = null;
let config   = null;
let starting = false;
let queue    = [];   // 동시 요청 직렬화

function unlockProfile(dir) {
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(
        `wmic process where "CommandLine like '%user-data-dir=${dir.replace(/\\/g, '\\\\')}%'" delete`,
        { stdio: 'ignore', shell: true }
      );
    } else {
      require('child_process').execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch {}
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket'])
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
}

async function launch() {
  config  = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  baseUrl = config.protocol + '://' + config.host;

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  unlockProfile(PROFILE_DIR);

  // 실제 Chrome 사용 → 기존 로그인 세션 그대로 재사용
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: true,
    ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--no-first-run', '--disable-extensions'],
  });

  mainPage = context.pages()[0] || await context.newPage();

  // tokenlogin 없이 바로 메일 페이지로 이동 (이미 로그인된 세션)
  await mainPage.goto(`${baseUrl}/app/mail`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // 로그인 페이지로 리다이렉트 됐으면 → tokenlogin으로 재시도
  if (!mainPage.url().includes('/app/')) {
    console.log('[session] 세션 만료 → tokenlogin 재시도');
    await mainPage.goto(
      `${baseUrl}/tokenlogin?token=${config.token}&companyId=${config.companyId || ''}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await new Promise(r => setTimeout(r, 1000));
    await mainPage.goto(`${baseUrl}/app/mail`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
  }

  // 세션 만료 감지 → 자동 재시작
  context.on('page', () => {});
  mainPage.on('close', () => { context = null; mainPage = null; });

  // 30분마다 ping으로 세션 유지
  setInterval(async () => {
    try {
      if (mainPage && !mainPage.isClosed()) {
        await mainPage.evaluate(() =>
          fetch('/api/mail/message/count', { method: 'POST', body: 'flag=U&folder=Inbox' })
        ).catch(() => {});
      }
    } catch {}
  }, 30 * 60 * 1000);

  console.log('[session] Hunet 세션 준비 완료');
}

async function getPage() {
  if (mainPage && !mainPage.isClosed()) return mainPage;
  if (starting) {
    // 이미 시작 중이면 대기
    await new Promise(r => setTimeout(r, 3000));
    return getPage();
  }
  starting = true;
  try {
    await launch();
  } finally {
    starting = false;
  }
  return mainPage;
}

// 직렬 실행 큐 — 동시 요청이 세션을 충돌시키지 않도록
async function withSession(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (queue.length === 1) drainQueue();
  });
}

async function drainQueue() {
  while (queue.length > 0) {
    const { fn, resolve, reject } = queue[0];
    try {
      const page = await getPage();
      resolve(await fn(page, context, baseUrl, config));
    } catch (e) {
      // 세션 오류면 초기화 후 재시도
      if (context) { try { await context.close(); } catch {} }
      context = null; mainPage = null;
      reject(e);
    } finally {
      queue.shift();
    }
  }
}

// ── 공개 API ────────────────────────────────────────────────────────────────

async function markRead(mailId, folder = 'Inbox') {
  return withSession(async (page, ctx, url, cfg) => {
    const userSeq = String(cfg.userSeq || '0');
    const result = await page.evaluate(async ({ url, mailId, folder, userSeq }) => {
      // 방법 1: JSON body
      const r = await fetch(url + '/api/mail/message/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, uid: mailId, sharedFlag: 'user', sharedUserSeq: userSeq, sharedFolderName: '' }),
      });
      const d = await r.json();
      return { status: r.status, code: d.code, message: d.message };
    }, { url, mailId, folder, userSeq });

    if (result.code !== '200' && result.code !== 200) {
      // 방법 2: form-encoded body 로 재시도
      const result2 = await page.evaluate(async ({ url, mailId, folder, userSeq }) => {
        const r = await fetch(url + '/api/mail/message/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `folder=${folder}&uid=${mailId}&sharedFlag=user&sharedUserSeq=${userSeq}&sharedFolderName=`,
        });
        const d = await r.json();
        return { status: r.status, code: d.code, message: d.message };
      }, { url, mailId, folder, userSeq });

      if (result2.code !== '200' && result2.code !== 200) {
        throw new Error(result2.message || result.message || '읽음 처리 실패');
      }
    }
    return { ok: true, mailId };
  });
}

async function sendMail({ to, subject, body, originalMailId, originalFolder }) {
  return withSession(async (page, ctx, url, cfg) => {
    let composePage = null;
    const onPage = p => { composePage = p; };
    ctx.on('page', onPage);

    try {
      // 메일쓰기 팝업 열기
      const mailFrame = page.frames().find(f => f.url().includes('/app/mail/home'));
      if (!mailFrame) throw new Error('메일 iframe 없음');

      await mailFrame.evaluate(() => {
        document.querySelectorAll('#advancedGuideLayer,[class*="welcome"]').forEach(el => el.remove());
        document.querySelector('.btn_function')?.click();
      });

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (composePage && composePage.url().includes('popup')) break;
      }
      if (!composePage) throw new Error('작성 팝업이 열리지 않았습니다');
      await new Promise(r => setTimeout(r, 2000));

      const result = await composePage.evaluate(({ to, subject, body }) => {
        const base = mailControl.getSendData();
        return new Promise((resolve) => {
          ActionLoader.postGoJsonLoadAction(
            mailControl.sendAction,
            { ...base, sendType:'normal', to, toName:to, cc:'', bcc:'', subject,
              content: body, contentType:'text/html', attachList:'',
              bigAttachContent:'', bigAttachMode:false, bigAttachLinks:[] },
            d => resolve({ ok: true, data: d }),
            'json'
          );
          setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 10000);
        });
      }, { to, subject, body: body || '' });

      if (!result.ok) throw new Error(result.reason || '발송 실패');
      const data = result.data;
      if (!data || data.sendError !== false) throw new Error(JSON.stringify(data));

      // 원본 메일 읽음 처리
      if (originalMailId) {
        await composePage.evaluate(async ({ url, uid, folder }) => {
          await fetch(url + '/api/mail/message/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder, uid, sharedFlag:'user', sharedUserSeq:'0', sharedFolderName:'' }),
          });
        }, { url, uid: originalMailId, folder: originalFolder || 'Inbox' }).catch(() => {});
      }

      // 팝업 항상 닫기 (다음 발송을 위해)
      await composePage.close().catch(() => {});

      return { ok: true, messageId: data.messageId };

    } finally {
      ctx.off('page', onPage);
    }
  });
}

async function close() {
  if (context) { try { await context.close(); } catch {} }
  context = null; mainPage = null;
}

module.exports = { markRead, sendMail, close, getPage };
