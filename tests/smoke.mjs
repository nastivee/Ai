/*
  Real-browser smoke test for Nastivee AI.

  Serves this folder locally, opens it in Chromium with the
  server API faked, and clicks through the things that must
  always work. Any page error, or any check that fails,
  makes the run fail, which emails the repo owner.

  Run locally:  npm i -D playwright && npx playwright install chromium
                node tests/smoke.mjs
*/

import { chromium, devices } from 'playwright';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

/* ---- 1. static checks, no browser needed ---- */

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };

const html = await readFile(path.join(root, 'index.html'), 'utf8');
const app = await readFile(path.join(root, 'js/app.js'), 'utf8');

const scriptAt = html.indexOf('js/app.js');
const ids = [...new Set([...app.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(m => m[1]))];
const missing = ids.filter(id => !html.includes(`id="${id}"`));
const afterScript = ids.filter(id => { const at = html.indexOf(`id="${id}"`); return at > scriptAt; });

/*
  Allowed to be missing: made by the code at run time, or
  removed from the page on purpose with every use guarded.
*/
const madeAtRunTime = ['imageModal', 'toast', 'userEmail', 'creditsRow', 'creditsCount', 'creditsSub', 'topUpButton'];
check(missing.filter(id => !madeAtRunTime.includes(id)).length === 0, `every element the code looks up exists (${missing.join(', ') || 'all found'})`);
check(afterScript.length === 0, `no element sits after the script that wires it (${afterScript.join(', ') || 'none'})`);

/* ---- 2. the browser ---- */

const server = http.createServer(async (req, res) => {
  try {
    let file = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (file.endsWith('/')) file += 'index.html';
    const full = path.join(root, file);
    await stat(full);
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
    res.end(await readFile(full));
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(0);

const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();

async function openApp(options = {}, account = { signedIn: false, admin: false }) {

  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];

  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/ai-8vlt.onrender.com/api/**', route => {
    const url = route.request().url();
    if (url.includes('/api/chat')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"text":"Hello from the smoke test"}\n\ndata: [DONE]\n\n' });
    }
    let body = {};
    if (url.includes('/api/account')) body = account;
    if (url.includes('/api/admin/overview')) body = { settings: { paywall_enabled: true, pack_price_pence: 500, pack_images: 100, coupon_code: 'X', starter_credits: 0, rules: [], lessons: { auto: true, items: [] } }, accounts: 1, testMode: true, configured: {} };
    if (url.includes('/api/admin/alerts')) body = { alerts: [] };
    if (url.includes('/api/admin/uploads')) body = { items: [], total: 0, done: true };
    if (url.includes('/api/prompt/improve')) body = { text: 'A clearer request', note: '' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  return { page, context, errors };

}

for (const [label, options] of [['desktop', { viewport: { width: 1200, height: 800 } }], ['phone', { ...devices['iPhone 13'] }]]) {

  const { page, context, errors } = await openApp(options);

  /* guest mode, so no real account is needed */
  const guest = await page.$('#guestButton, .guestButton, [data-action="guest"]');
  if (guest) { await guest.click(); await page.waitForTimeout(1000); }

  await page.fill('#messageInput', 'what is the capital of France?');
  await page.waitForTimeout(100);
  check(await page.$eval('#wordButton', b => b.classList.contains('show')), `${label}: wand shows once there is text`);

  await page.click('#sendButton');
  await page.waitForTimeout(1200);
  const reply = await page.evaluate(() => [...document.querySelectorAll('.messageRow.assistant')].map(r => r.innerText).join(' '));
  check(reply.includes('Hello from the smoke test'), `${label}: sending a message gets a reply`);
  check(await page.$$eval('.replyTools .replyTool', t => t.length) === 3, `${label}: reply has copy, try again and save`);
  check(await page.$$eval('.bubbleWrap.noTools', w => w.length) === 0, `${label}: a real answer shows its tools`);

  /* small talk: a "hey" gets no tools */
  await page.fill('#messageInput', 'hey');
  await page.click('#sendButton');
  await page.waitForTimeout(1200);
  check(await page.$$eval('.bubbleWrap', w => w[w.length - 1].classList.contains('noTools')), `${label}: small talk gets no tools`);

  /* My artwork opens and closes */
  await page.evaluate(() => document.getElementById('artworkButton').click());
  await page.waitForTimeout(600);
  check(await page.$eval('#artworkPage', e => e.classList.contains('show')), `${label}: My artwork opens`);
  await page.click('#artworkClose');

  check(errors.length === 0, `${label}: no page errors (${errors.join(' | ') || 'none'})`);

  await context.close();

}

/* an admin, for the admin page */
{
  const { page, context, errors } = await openApp(
    { viewport: { width: 1200, height: 800 } },
    { signedIn: true, admin: true, unlimited: true, canVideo: true, canVoice: true, videoAccess: 'admins', voiceAccess: 'admins' }
  );

  await page.evaluate(() => {
    document.querySelectorAll('.authScreen, .bootOverlay, #bootOverlay').forEach(e => { e.style.display = 'none'; });
    document.querySelector('.app').style.display = 'flex';
    account.admin = true;
    document.getElementById('adminButton').classList.add('show');
    document.getElementById('adminButton').click();
  });
  await page.waitForTimeout(800);

  await page.click('#adminBurger');
  await page.waitForTimeout(300);
  const sections = await page.$$eval('.adminNavItem', items => items.length);
  check(sections >= 8, `admin: menu lists the sections (${sections})`);

  await page.click('.adminNavItem[data-target="adminRules"]');
  await page.waitForTimeout(300);
  const before = await page.$$eval('.ruleCard', c => c.length);
  await page.click('#addRule');
  check(await page.$$eval('.ruleCard', c => c.length) === before + 1, 'admin: Add a rule adds one');

  check(errors.length === 0, `admin: no page errors (${errors.join(' | ') || 'none'})`);

  await context.close();
}

await browser.close();
server.close();

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
