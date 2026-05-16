/**
 * hunet_mail_v2.js
 * 사용자가 직접 로그인 → 내부 API 자동 감지 → 메일 목록/본문/첨부파일/읽음 상태 추출
 *
 * 사용법:
 *   node scripts/hunet_mail_v2.js                  # 기본 (최대 50개, headful)
 *   node scripts/hunet_mail_v2.js --limit=20        # 최대 20개
 *   node scripts/hunet_mail_v2.js --output=out.json # 저장 경로 지정
 *   node scripts/hunet_mail_v2.js --headless        # 헤드리스 (로그인 세션 있을 때만)
 *   node scripts/hunet_mail_v2.js --save-raw        # 캡처된 원본 API 응답도 저장
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://hug.hunet.co.kr';
const MAIL_URL = `${BASE_URL}/app/mail`;
const PROFILE_DIR = path.join(__dirname, '..', '.profiles', 'hunet-mail');
const AUTH_DIR = path.join(__dirname, '..', '.auth');
const OUTPUT_DIR = path.join(__dirname, '..', '.mail-output');

// ─── CLI 파싱 ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix) => {
    const found = args.find(a => a.startsWith(prefix + '='));
    return found ? found.split('=').slice(1).join('=') : null;
  };
  return {
    headless: args.includes('--headless'),
    saveRaw: args.includes('--save-raw'),
    limit: parseInt(get('--limit') || '50', 10),
    outputFile: get('--output'),
    inbox: get('--folder') || 'inbox',
  };
}

// ─── 네트워크 응답 분석 ───────────────────────────────────────────────────────

const MAIL_KEYWORDS = ['subject', 'title', 'from', 'sender', 'receive', 'read', 'unread', 'date', 'mail', 'message', 'attach'];

function findMailArray(data) {
  const candidates = [
    data,
    data?.list, data?.data, data?.items, data?.mails,
    data?.mailList, data?.result, data?.content,
    data?.response, data?.body,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0 && typeof c[0] === 'object') {
      const keys = Object.keys(c[0]).join(',').toLowerCase();
      const hits = MAIL_KEYWORDS.filter(k => keys.includes(k)).length;
      if (hits >= 2) return c;
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

  const readRaw = get('readYn', 'isRead', 'read', 'readFlag', 'readStatus');
  const isRead = readRaw === 'Y' || readRaw === true || readRaw === 1 ||
    (typeof readRaw === 'string' && readRaw.toLowerCase() === 'true');

  const replyRaw = get('replyYn', 'answerYn', 'isReplied', 'replyFlag', 'answerFlag', 'replied');
  const isReplied = replyRaw === 'Y' || replyRaw === true || replyRaw === 1 ||
    (typeof replyRaw === 'string' && replyRaw.toLowerCase() === 'true');

  return {
    id: get('mailId', 'id', 'mailNo', 'messageId', 'uid', 'no'),
    subject: get('subject', 'title', 'mailTitle', 'subjectText', 'mailSubject'),
    from: get('fromName', 'senderName', 'senderNm', 'from', 'sender'),
    fromEmail: get('fromEmail', 'senderEmail', 'fromAddr', 'senderAddr'),
    date: get('receiveDate', 'sendDate', 'regDate', 'date', 'receivedAt', 'sendDt', 'receiveDt'),
    isRead,
    isReplied,
    hasAttachment: !!(get('attachYn', 'hasAttach', 'attachFlag') === 'Y' ||
      get('attachCount', 'attachCnt') > 0),
    body: get('body', 'content', 'mailContent', 'mailBody', 'text'),
    attachments: get('attachList', 'attachments', 'fileList') || [],
  };
}

// ─── 메일 본문 가져오기 (개별 API 호출) ─────────────────────────────────────

async function fetchMailDetail(page, mail, capturedApis, baseUrl) {
  if (mail.body) return mail;

  // 이미 캡처된 응답 중 이 메일 ID가 포함된 것 찾기
  const id = mail.id;
  if (!id) return mail;

  const existing = capturedApis.find(r =>
    r.type === 'detail' && (r.url.includes(String(id)) || JSON.stringify(r.data).includes(String(id)))
  );
  if (existing) {
    const detail = existing.data;
    mail.body = detail?.body || detail?.content || detail?.mailContent ||
      detail?.data?.body || detail?.data?.content || mail.body;
    mail.attachments = detail?.attachList || detail?.attachments ||
      detail?.data?.attachList || mail.attachments;
    return mail;
  }

  // 새 응답 캡처를 위해 클릭 시도
  const detailCapture = new Promise((resolve) => {
    const handler = async (response) => {
      const u = response.url();
      if (!u.startsWith(baseUrl)) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const data = await response.json();
        const bodyText = data?.body || data?.content || data?.mailContent ||
          data?.data?.body || data?.data?.content;
        if (bodyText) {
          page.off('response', handler);
          capturedApis.push({ type: 'detail', url: u, data });
          resolve({ body: bodyText, attachments: data?.attachList || data?.attachments || [] });
        }
      } catch {}
    };
    page.on('response', handler);
    setTimeout(() => {
      page.off('response', handler);
      resolve(null);
    }, 4000);
  });

  // 메일 행 클릭 (ID로 찾기)
  try {
    const clicked = await page.evaluate((mailId) => {
      const els = document.querySelectorAll('[data-id], [data-mail-id], [data-no], [data-seq]');
      for (const el of els) {
        const v = el.dataset.id || el.dataset.mailId || el.dataset.no || el.dataset.seq;
        if (String(v) === String(mailId)) {
          el.click();
          return true;
        }
      }
      return false;
    }, id);

    if (clicked) {
      const result = await detailCapture;
      if (result) {
        mail.body = result.body;
        mail.attachments = result.attachments;
        await page.goBack({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
      }
    }
  } catch {}

  return mail;
}

// ─── 로그인 대기 ─────────────────────────────────────────────────────────────

async function waitForLogin(page) {
  const url = page.url();
  const needsLogin = !url.includes('/app/') ||
    url.includes('login') || url.includes('sso') || url.includes('otp');

  if (!needsLogin) return;

  console.log('\n' + '━'.repeat(50));
  console.log('  브라우저에서 로그인을 완료해주세요.');
  console.log('  (최대 5분 대기)');
  console.log('━'.repeat(50) + '\n');

  await page.waitForFunction(
    () => {
      const u = location.href;
      return u.includes('/app/') && !u.includes('login') && !u.includes('otp') && !u.includes('sso');
    },
    null,
    { timeout: 300_000, polling: 1500 }
  );

  console.log('로그인 완료!\n');
}

// ─── DOM 폴백 파싱 ────────────────────────────────────────────────────────────

async function parseMailFromDom(page, limit) {
  return page.evaluate((limit) => {
    const selectors = [
      'tbody > tr', 'tr[class*="mail"]', 'tr[class*="row"]',
      'li[class*="mail"]', 'div[class*="mail-item"]',
      'div[class*="mailItem"]', '[data-type="mail"]',
      '[class*="list-item"]', '[class*="listItem"]',
    ];
    let rows = [];
    for (const sel of selectors) {
      rows = Array.from(document.querySelectorAll(sel));
      if (rows.length > 2) break;
    }
    return rows.slice(0, limit).map(r => ({
      text: (r.innerText || r.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 400),
      dataId: r.dataset?.id || r.dataset?.mailId || r.dataset?.no || null,
    })).filter(r => r.text.length > 5);
  }, limit);
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const outputFile = opts.outputFile ||
    path.join(OUTPUT_DIR, `mail_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`Hunet 메일 읽기 시작 (최대 ${opts.limit}개)`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: opts.headless,
    viewport: { width: 1440, height: 960 },
    ignoreHTTPSErrors: true,
  });

  const page = context.pages()[0] || await context.newPage();

  // ── 네트워크 캡처 설정 ──────────────────────────────────────────────────────
  const capturedApis = [];
  let listApiUrl = null;

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.startsWith(BASE_URL)) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;

      const data = await response.json();
      const mailArr = findMailArray(data);

      if (mailArr && mailArr.length > 0) {
        if (!listApiUrl) {
          listApiUrl = url;
          console.log(`[API 감지] 메일 목록: ${url.replace(BASE_URL, '')}`);
        }
        capturedApis.push({ type: 'list', url, data, mailArr });
      } else {
        capturedApis.push({ type: 'other', url, data });
      }
    } catch {}
  });

  // ── 페이지 이동 및 로그인 대기 ────────────────────────────────────────────
  await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForLogin(page);

  if (!page.url().includes('/mail')) {
    console.log('메일함으로 이동 중...');
    await page.goto(MAIL_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  } else {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  // 세션 저장
  await context.storageState({ path: path.join(AUTH_DIR, 'hunet-mail-storage.json') });
  console.log('세션 저장 완료');

  // 스크롤로 lazy loading 유발
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // ── 메일 목록 파싱 ────────────────────────────────────────────────────────
  let mails = [];

  if (listApiUrl) {
    const listCapture = capturedApis.filter(c => c.type === 'list').pop();
    mails = listCapture.mailArr.slice(0, opts.limit).map(extractMailFields);
    console.log(`API 기반 파싱: ${mails.length}개\n`);
  } else {
    console.log('내부 API 미감지 → DOM 파싱 시도...');
    const domItems = await parseMailFromDom(page, opts.limit);
    mails = domItems.map(item => ({ subject: item.text, id: item.dataId }));

    if (mails.length === 0) {
      console.log('\n[경고] DOM 파싱도 실패했습니다.');
      const htmlFile = path.join(OUTPUT_DIR, 'page_structure.html');
      fs.writeFileSync(htmlFile, await page.content(), 'utf8');
      console.log(`페이지 HTML 저장 (분석용): ${htmlFile}`);
      console.log('캡처된 API 목록:');
      capturedApis.slice(0, 20).forEach(r => console.log(`  ${r.type} ${r.url.replace(BASE_URL, '')}`));
    } else {
      console.log(`DOM 파싱: ${mails.length}개\n`);
    }
  }

  // ── 본문 가져오기 (API 감지된 경우에만 자동 시도) ─────────────────────────
  if (listApiUrl && !opts.headless) {
    console.log('메일 본문 가져오는 중...');
    for (let i = 0; i < Math.min(mails.length, opts.limit); i++) {
      if (!mails[i].body && mails[i].id) {
        process.stdout.write(`  ${i + 1}/${mails.length}\r`);
        mails[i] = await fetchMailDetail(page, mails[i], capturedApis, BASE_URL);
      }
    }
    console.log('');
  }

  // ── 결과 저장 ─────────────────────────────────────────────────────────────
  const output = {
    timestamp: new Date().toISOString(),
    url: page.url(),
    listApiUrl: listApiUrl || null,
    count: mails.length,
    mails,
    ...(opts.saveRaw ? { capturedApis } : {}),
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');

  // ── 콘솔 출력 ─────────────────────────────────────────────────────────────
  console.log('━'.repeat(60));
  console.log(`메일 ${mails.length}개  →  ${outputFile}`);
  console.log('━'.repeat(60));

  mails.forEach((mail, i) => {
    if (mail.subject) {
      const status = mail.isRead ? '읽음 ' : '미읽음';
      const attach = mail.hasAttachment ? '[첨부]' : '      ';
      const from = (mail.from || mail.fromEmail || '?').substring(0, 15).padEnd(15);
      const subject = (mail.subject || '').substring(0, 40);
      const date = (mail.date || '').substring(0, 16);
      console.log(`[${String(i + 1).padStart(2)}] ${status} ${attach} ${from} ${subject} ${date}`);
    } else {
      console.log(`[${String(i + 1).padStart(2)}] ${JSON.stringify(mail).substring(0, 100)}`);
    }
  });

  if (!opts.headless) {
    await page.waitForTimeout(3000);
  }
  await context.close();
}

main().catch(err => { console.error(err); process.exit(1); });
