// reserve-teetime.mjs
// Usage: node reserve-teetime.mjs
//
// Requires: npm i playwright dotenv && npx playwright install
// .env must define at least LOGIN_URL, COURSE_URL, USERNAME, PASSWORD, COURSE_NAME
// Example COURSE_NAME: "Roy Kizer Golf Course" or "Jimmy Clay Golf Course"

import 'dotenv/config';
import fs from 'fs';
import { chromium } from 'playwright';

// ---------- Config helpers ----------
const bool = (v, d=false)=> (v==null?d:/^(1|true|yes)$/i.test(v));
const int  = (v, d)=> (v==null?d:parseInt(v,10));
const parseJitter = (s, d=[1500,2500])=>{
  try {
    const [a,b] = (s||'').split(',').map(x=>parseInt(x,10));
    return (Number.isFinite(a)&&Number.isFinite(b) ? [a,b] : d);
  } catch { return d; }
};

// ---------- Env/config ----------
const cfg = {
  loginUrl: process.env.LOGIN_URL || 'https://txaustinweb.myvscloud.com/webtrac/web/login.html',
  courseUrl: process.env.COURSE_URL || 'https://txaustinweb.myvscloud.com/webtrac/web/search.html?display=detail&module=GR&secondarycode=2',
  user: process.env.USERNAME,
  pass: process.env.PASSWORD,
  courseName: process.env.COURSE_NAME || 'Roy Kizer Golf Course', // or "Jimmy Clay Golf Course"

  players: int(process.env.PLAYERS, 2),
  holesLabel: process.env.HOLES_LABEL || '18 Holes',

  windowStart: process.env.WINDOW_START || '07:00',
  windowEnd: process.env_WINDOW_END || process.env.WINDOW_END || '09:00',
  preferredDays: (process.env.PREFERRED_DAYS || 'Sat,Sun').split(',').map(s=>s.trim()),
  tz: process.env.TIMEZONE || 'America/Chicago',

  headless: bool(process.env.HEADLESS, false),
  autoConfirm: bool(process.env.AUTO_CONFIRM, false),
  searchSeconds: int(process.env.SEARCH_SECONDS, 240),
  refreshJitter: parseJitter(process.env.REFRESH_JITTER_MS, [1700, 2600]),
};

function assertEnv() {
  const required = ['loginUrl','courseUrl','user','pass','courseName'];
  const missing = required.filter(k => !cfg[k]);
  if (missing.length) throw new Error(`Missing required envs: ${missing.join(', ')}`);
}

// ---------- Utils ----------
function toMin(hhmm) { const [h,m] = hhmm.split(':').map(Number); return h*60+m; }
function timeInRange(hhmm, start, end) {
  const t=toMin(hhmm), s=toMin(start), e=toMin(end);
  return t>=s && t<=e;
}
function normalizeTimeLabel(label='') {
  const m = label.trim().match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return '';
  let [ ,hh,mm,ampm ] = m; hh = parseInt(hh,10);
  if (/pm/i.test(ampm) && hh !== 12) hh += 12;
  if (/am/i.test(ampm) && hh === 12) hh = 0;
  return String(hh).padStart(2,'0')+':'+mm;
}
function fmt(d) { return d.toLocaleString('en-US', { timeZone: cfg.tz }); }

function nextWeekendDates() {
  const out = [];
  const now = new Date();
  for (let i=0;i<14;i++) {
    const d = new Date(now); d.setDate(d.getDate()+i);
    const dow = d.toLocaleDateString('en-US',{weekday:'short', timeZone:cfg.tz});
    if (cfg.preferredDays.some(x => dow.toLowerCase().startsWith(x.toLowerCase()))) out.push(d);
  }
  return out.slice(0, 2); // next Sat & Sun (first occurrence of each)
}

function jitteredDelay([min,max]) {
  const ms = Math.floor(Math.random()*(max-min)+min);
  return new Promise(r=>setTimeout(r, ms));
}

// Optional wait-until 5:00 PM CT alignment (you can start ~4:59 CT)
function msUntilCT(hour=17, minute=0) {
  const now = new Date();
  const nowCT = new Date(now.toLocaleString('en-US', { timeZone: cfg.tz }));
  const tgtCT = new Date(nowCT);
  tgtCT.setHours(hour, minute, 0, 0);

  // Translate CT target back to local/UTC by delta
  const delta = tgtCT.getTime() - nowCT.getTime();
  const tgt = new Date(now.getTime() + delta);
  return Math.max(0, tgt - now);
}

// ---------- Selectors (accessible-first for CivicRec/WebTrac) ----------
const S = {
  loginUser: (page) => page.getByLabel('Username'),
  loginPass: (page) => page.getByLabel('Password'),
  loginSubmit: (page) => page.getByRole('button', { name: /^login$/i }),

  courseSelect: (page) => page.getByLabel('Course'),
  beginTimeSelect: (page) => page.getByLabel('Begin Time'), // optional if present
  dateInput: (page) => page.getByRole('textbox', { name: /^date$/i }),
  playersSelect: (page) => page.getByLabel('Number Of Players'),
  holesSelect: (page) => page.getByLabel('Number Of Holes'),
  searchBtn: (page) => page.getByRole('button', { name: /^search$/i }),

  // Results
  rowRole: (page) => page.getByRole('row'),
  addToCartIn: (row) => row.getByRole('button', { name: /Add To Cart/i }),

  // Potential confirm/checkout
  confirmBtn: (page) => page.getByRole('button', { name: /Confirm|Checkout|Pay/i }),
  continueLink: (page) => page.getByRole('link', { name: /continue|enter|home|my account/i }),
  continueBtn: (page) => page.getByRole('button', { name: /continue|enter/i }),
};

// ---------- Core actions ----------
async function login(page) {
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });

  await S.loginUser(page).fill(cfg.user);
  await S.loginPass(page).fill(cfg.pass);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    S.loginSubmit(page).click(),
  ]);

  // Some sites show a splash page; try to click through if visible
  const contLink = S.continueLink(page);
  const contBtn = S.continueBtn(page);
  if (await contLink.isVisible().catch(()=>false)) {
    await Promise.all([ page.waitForLoadState('networkidle'), contLink.click() ]);
  } else if (await contBtn.isVisible().catch(()=>false)) {
    await Promise.all([ page.waitForLoadState('networkidle'), contBtn.click() ]);
  }

  // Jump straight to tee sheet
  await page.goto(cfg.courseUrl, { waitUntil: 'domcontentloaded' });
}

async function gotoSearch(page) {
  if (!page.url().includes('/search.html')) {
    await page.goto(cfg.courseUrl, { waitUntil: 'domcontentloaded' });
  }
  // Set course & preferences
  await S.courseSelect(page).selectOption({ label: cfg.courseName }).catch(()=>{});
  await S.playersSelect(page).selectOption(String(cfg.players)).catch(()=>{});
  await S.holesSelect(page).selectOption({ label: cfg.holesLabel }).catch(()=>{});
}

function mdy(dateObj) {
  const yyyy = dateObj.toLocaleString('en-US', { timeZone: cfg.tz, year:'numeric' });
  const mm   = dateObj.toLocaleString('en-US', { timeZone: cfg.tz, month:'2-digit' });
  const dd   = dateObj.toLocaleString('en-US', { timeZone: cfg.tz, day:'2-digit' });
  return `${mm}/${dd}/${yyyy}`;
}

async function setDateAndSearch(page, dateObj) {
  await S.dateInput(page).fill(mdy(dateObj));
  await Promise.all([
    page.waitForLoadState('networkidle'),
    S.searchBtn(page).click(),
  ]);
}

async function findCandidates(page) {
  const rows = await S.rowRole(page).all(); // includes header row(s)
  const hits = [];

  for (const r of rows) {
    const txt = (await r.innerText()).trim();
    if (!txt) continue;

    // Ensure row is for our chosen course
    if (!txt.includes(cfg.courseName)) continue;

    // Extract time like "7:12 am"
    const m = txt.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
    if (!m) continue;
    const t24 = normalizeTimeLabel(m[1]);

    if (t24 && timeInRange(t24, cfg.windowStart, cfg.windowEnd)) {
      const addBtn = S.addToCartIn(r);
      if (await addBtn.isVisible().catch(()=>false)) {
        hits.push({ t: t24, row: r, addBtn });
      }
    }
  }
  hits.sort((a,b)=> a.t.localeCompare(b.t));
  return hits;
}

// ---------- Main ----------
(async ()=>{
  assertEnv();

  console.log('Starting tee-time bot with config:', {
    courseName: cfg.courseName,
    tz: cfg.tz,
    window: `${cfg.windowStart}-${cfg.windowEnd}`,
    preferredDays: cfg.preferredDays,
    players: cfg.players,
    headless: cfg.headless,
    autoConfirm: cfg.autoConfirm
  });

  const AUTH_STATE_FILE = 'auth.json';
  const contextArgs = fs.existsSync(AUTH_STATE_FILE)
    ? { storageState: AUTH_STATE_FILE }
    : {};

  const browser = await chromium.launch({ headless: cfg.headless });
  const ctx = await browser.newContext(contextArgs);
  const page = await ctx.newPage();

  // If no saved session, login and save it
  if (!fs.existsSync(AUTH_STATE_FILE)) {
    console.log('No saved session found — logging in…');
    await login(page);
    await ctx.storageState({ path: AUTH_STATE_FILE });
    console.log('Session saved to auth.json');
  } else {
    console.log('Using saved session — going to tee sheet…');
    await page.goto(cfg.courseUrl, { waitUntil: 'domcontentloaded' });
  }

  await gotoSearch(page);

  // Align near 5:00 PM CT if desired; run the script ~4:59 PM CT
  const ms = msUntilCT(17,0);
  if (ms > 0 && ms < 120000) {
    console.log(`Waiting ~${Math.round(ms/1000)}s for 5:00 PM CT (${fmt(new Date(Date.now()+ms))})…`);
    await new Promise(r=>setTimeout(r, ms));
  } else {
    console.log('It is already near/after 5:00 PM CT — searching now.');
  }

  const targets = nextWeekendDates();
  console.log('Target dates:', targets.map(d=>d.toDateString()).join(' | '));

  const start = Date.now();
  let booked = false;

  while (!booked && (Date.now() - start) < cfg.searchSeconds*1000) {
    for (const d of targets) {
      await setDateAndSearch(page, d);
      const hits = await findCandidates(page);

      if (hits.length) {
        const best = hits[0];
        console.log(`FOUND ${cfg.courseName} on ${d.toDateString()} at ${best.t}`);
        await best.row.scrollIntoViewIfNeeded();

        // Click Add To Cart
        await best.addBtn.click();
        await page.waitForLoadState('networkidle').catch(()=>{});

        if (cfg.autoConfirm) {
          const confirm = S.confirmBtn(page);
          if (await confirm.isVisible().catch(()=>false)) {
            await confirm.click();
            console.log('Submitted confirm (AUTO_CONFIRM=true).');
          } else {
            console.log('Confirm/Checkout not visible — manual finish required.');
          }
          booked = true;
          break;
        } else {
          console.log('\n🚨 Added to cart. Manually complete checkout in the open browser.\n');
          process.stdout.write('\x07');
          booked = true;
          break;
        }
      }
    }
    if (!booked) {
      await jitteredDelay(cfg.refreshJitter);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{});
    }
  }

  if (!booked) {
    console.log('No matching tee times found within search window.');
  } else {
    console.log('Flow completed (paused for manual checkout or auto-confirmed).');
  }

  // Keep the browser open so you can complete checkout or review
  // await browser.close();
})().catch(err=>{
  console.error('Fatal error:', err);
  //process.exit(1);
});
