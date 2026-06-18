/**
 * launch.js
 * HunetMessenger config.json의 토큰으로 자동 로그인 → 메일 수집 → 앱에 주입
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function getHunetConfigPath() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'HunetMessenger', 'config.json');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'HunetMessenger', 'config.json');
}
const CONFIG_PATH = getHunetConfigPath();
const HTML_PATH   = path.resolve(__dirname, 'email-automation-app.html');
const OUTPUT_DIR  = path.join(__dirname, '.mail-output');
const PROFILE_DIR = path.join(__dirname, '.profiles', 'hunet-mail');
const LIMIT       = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '200', 10);
const FOLDER      = process.argv.find(a => a.startsWith('--folder='))?.split('=').slice(1).join('=')
                  || '부서메일(edulab, edu, aca).교육운영1팀(acaedu1, aca1).박차민';
const SHARED_FLAG = 'user';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function unlockProfile(dir) {
  // 해당 프로필을 사용 중인 Chromium 프로세스 종료
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(
        `wmic process where "CommandLine like '%user-data-dir=${dir.replace(/\\/g, '\\\\')}%'" delete`,
        { stdio: 'ignore', shell: true }
      );
    } else {
      require('child_process').execSync(
        `pkill -f "user-data-dir=${dir}" 2>/dev/null || true`,
        { stdio: 'ignore' }
      );
    }
  } catch {}
  // 잠금 파일 제거
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
  // LevelDB 잠금 해제
  for (const db of ['Default/Cache', 'Default/Code Cache', 'Default']) {
    const lockFile = path.join(dir, db, 'LOCK');
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

// ─── 메일 배열 탐지 ────────────────────────────────────────────────────────────
const MAIL_KEYS = ['subject','title','from','sender','receive','read','unread','date','mail','message'];

function findMailArray(data) {
  const candidates = [
    data,
    data?.data?.messageList,  // Hunet /api/mail/message/list 구조
    data?.list, data?.data, data?.items, data?.mails,
    data?.mailList, data?.result, data?.content, data?.response, data?.body,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0 && typeof c[0] === 'object') {
      const keys = Object.keys(c[0]).join(',').toLowerCase();
      if (MAIL_KEYS.filter(k => keys.includes(k)).length >= 2) return c;
    }
  }
  return null;
}

function extractMailFields(item) {
  const get = (...keys) => {
    for (const k of keys) {
      const v = item[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };
  const readRaw = get('readYn','isRead','read','readFlag','readStatus');
  const isRead  = readRaw === 'Y' || readRaw === true || readRaw === 1 ||
    (typeof readRaw === 'string' && readRaw.toLowerCase() === 'true');
  // Hunet API: from 필드가 '"이름"<email>' 형태일 수 있음
  const fromRaw = get('fromToSimple','fromName','senderName','senderNm','from','sender');
  const fromEmailRaw = get('fromEmail','senderEmail','fromAddr','senderAddr','from');
  const fromEmailParsed = typeof fromEmailRaw === 'string'
    ? (fromEmailRaw.match(/<([^>]+)>/) || [])[1] || fromEmailRaw
    : fromEmailRaw;
  return {
    id:            get('id','mailId','mailNo','messageId','uid','no'),
    subject:       get('subject','title','mailTitle','subjectText','mailSubject'),
    from:          fromRaw,
    fromEmail:     fromEmailParsed,
    date:          get('dateUtc','sentDateUtc','receiveDate','sendDate','regDate','date','receivedAt'),
    isRead:        get('seen') === true || isRead,
    hasAttachment: !!(get('attachYn','hasAttach','attachFlag') === 'Y' || get('attachCount','attachCnt') > 0),
    body:          get('preview','body','content','mailContent','mailBody','text') || '',
    attachments:   get('attachList','attachments','fileList') || [],
  };
}

async function parseMailFromDom(page, limit) {
  return page.evaluate((limit) => {
    const selectors = [
      'tbody > tr','tr[class*="mail"]','tr[class*="row"]',
      'li[class*="mail"]','div[class*="mail-item"]',
      'div[class*="mailItem"]','[data-type="mail"]',
      '[class*="list-item"]','[class*="listItem"]',
    ];
    let rows = [];
    for (const sel of selectors) {
      rows = Array.from(document.querySelectorAll(sel));
      if (rows.length > 2) break;
    }
    return rows.slice(0, limit).map(r => ({
      subject:  (r.innerText || r.textContent || '').trim().replace(/\s+/g,' ').substring(0, 200),
      id:       r.dataset?.id || r.dataset?.mailId || r.dataset?.no || null,
      isRead:   r.classList.contains('read') || r.dataset?.read === 'Y',
      from: '', fromEmail: '', date: '', body: '', hasAttachment: false, attachments: [],
    })).filter(r => r.subject.length > 3);
  }, limit);
}

// ─── 메인 ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('\n이메일 자동화 서비스 — Hunet 메일 수집\n');

  // HunetMessenger config.json에서 인증 정보 읽기
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('HunetMessenger가 설치되어 있지 않습니다: ' + CONFIG_PATH);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const { protocol, host, token, companyId, userName, loginId } = config;
  if (!token || !host) {
    throw new Error('HunetMessenger에 로그인이 필요합니다. 먼저 HunetMessenger에서 로그인 해주세요.');
  }

  const BASE_URL    = `${protocol}://${host}`;
  const LOGIN_URL   = `${BASE_URL}/tokenlogin?token=${token}&companyId=${companyId || ''}`;
  console.log(`사용자: ${userName || loginId}`);
  const MAIL_URL    = `${BASE_URL}/app/mail`;

  console.log(`접속 서버: ${BASE_URL}`);

  unlockProfile(PROFILE_DIR);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    ignoreHTTPSErrors: true,
    args: ['--no-first-run', '--no-default-browser-check', '--no-sandbox'],
  });

  const page = context.pages()[0] || await context.newPage();

  // 네트워크 캡처
  const capturedApis = [];
  let listApiUrl = null;

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.includes(host)) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data    = await response.json();
      // 박차민 폴더 API만 캡처
      if (url.includes('/api/mail/message/list')) {
        const folderType = data?.data?.folderType;
        const folderName = data?.data?.folderFullName || data?.data?.folderName || '';
        const mailArr = findMailArray(data);
        if (mailArr?.length > 0 && (folderName.includes('박차민') || listApiUrl)) {
          if (!listApiUrl) {
            listApiUrl = url;
            console.log(`[API 감지] 폴더: ${folderName || folderType}`);
          }
          capturedApis.push({ type: 'list', url, data, mailArr });
        }
      }
    } catch {}
  });

  // 토큰으로 로그인
  console.log('로그인 중...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(1000);

  const afterLoginUrl = page.url();
  if (afterLoginUrl.includes('login') || afterLoginUrl.includes('error')) {
    console.log('토큰 로그인 실패 — 브라우저에서 수동 로그인 후 엔터를 눌러주세요...');
    await new Promise(r => process.stdin.once('data', r));
  } else {
    console.log('로그인 완료!\n');
  }

  // 메일함으로 이동 (API 캡처 리셋)
  console.log('메일함 이동 중...');
  capturedApis.length = 0;
  listApiUrl = null;
  await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(1500);

  // 박차민 폴더 클릭 (iframe 내부)
  console.log(`폴더 이동 중: ${FOLDER}`);

  // mail/home iframe에서 박차민 클릭
  const mailFrame = page.frames().find(f => f.url().includes('/app/mail/home'));
  let clickedFolder = false;
  if (mailFrame) {
    clickedFolder = await mailFrame.evaluate((folderName) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (node.nodeValue?.trim() === folderName) {
          let el = node.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!el) break;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) { el.click(); return true; }
            el = el.parentElement;
          }
        }
      }
      return false;
    }, '박차민');
  }

  if (!clickedFolder) {
    // 직접 API 호출로 폴더 로드
    console.log('  → 직접 API 호출로 폴더 로드');
    const apiData = await page.evaluate(async ({ base, folder, sharedFlag }) => {
      try {
        const r = await fetch(`${base}/api/mail/message/list`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder, sharedFlag }),
        });
        return await r.json();
      } catch(e) { return { error: e.message }; }
    }, { base: BASE_URL, folder: FOLDER, sharedFlag: SHARED_FLAG });

    const mailArr = findMailArray(apiData);
    if (mailArr?.length > 0) {
      listApiUrl = `${BASE_URL}/api/mail/message/list`;
      capturedApis.push({ type: 'list', url: listApiUrl, data: apiData, mailArr });
      console.log(`  → 직접 API로 ${mailArr.length}건 로드`);
    }
  } else {
    console.log('  → 클릭 성공: 박차민')
  }

  // 메일 목록 API 대기 (최대 30초)
  console.log('메일 목록 로딩 중...');
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (listApiUrl) break;
  }

  if (!listApiUrl) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (listApiUrl) break;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  // 메일 파싱 (페이지네이션 포함)
  let rawMails = [];
  if (listApiUrl) {
    const latest = capturedApis.filter(c => c.type === 'list').pop();
    const firstPage = latest.mailArr;
    const totalCount = latest.data?.data?.total || firstPage.length;
    const pageBase   = latest.data?.data?.pageBase || 80;

    console.log(`받은편지함: 총 ${totalCount}건 중 최대 ${LIMIT}건 수집`);

    rawMails = [...firstPage];

    // 추가 페이지 fetch (세션 쿠키 사용)
    if (rawMails.length < LIMIT && rawMails.length < totalCount) {
      let pageNum = 2;
      while (rawMails.length < LIMIT && rawMails.length < totalCount) {
        process.stdout.write(`  페이지 ${pageNum} 로딩 중... (${rawMails.length}/${Math.min(LIMIT, totalCount)})\r`);
        const extra = await page.evaluate(async ({ base, pg, folder, sharedFlag }) => {
          try {
            const body = { page: pg };
            if (folder) { body.folder = folder; body.sharedFlag = sharedFlag; }
            const r = await fetch(`${base}/api/mail/message/list`, {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const d = await r.json();
            return d?.data?.messageList || [];
          } catch { return []; }
        }, { base: BASE_URL, pg: pageNum, folder: FOLDER, sharedFlag: SHARED_FLAG });

        if (!extra || extra.length === 0) break;
        rawMails.push(...extra);
        pageNum++;
      }
      console.log('');
    }

    rawMails = rawMails.slice(0, LIMIT).map(extractMailFields);
    console.log(`API 파싱: ${rawMails.length}개`);
  } else {
    console.log('API 미감지 → DOM 파싱...');
    rawMails = await parseMailFromDom(page, LIMIT);
    console.log(`DOM 파싱: ${rawMails.length}개`);
  }

  if (rawMails.length === 0) {
    console.log('[경고] 메일을 찾지 못했습니다.');
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'debug.png') });
    console.log('스크린샷: .mail-output/debug.png');
  }

  // JSON 저장
  const outputFile = path.join(OUTPUT_DIR, `mail_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.json`);
  const mailData = {
    timestamp: new Date().toISOString(),
    user: userName || loginId,
    folder: FOLDER.split('.').pop(),
    folderFull: FOLDER,
    sharedFlag: SHARED_FLAG,
    count: rawMails.length,
    mails: rawMails,
  };
  fs.writeFileSync(outputFile, JSON.stringify(mailData, null, 2), 'utf8');
  console.log(`\nJSON 저장: ${outputFile}`);

  // Playwright 브라우저 종료
  await context.close();

  console.log(`\n메일 ${rawMails.length}건 수집 완료`);
}

main().catch(err => { console.error('\n[오류]', err.message); process.exit(1); });
