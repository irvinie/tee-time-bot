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
  windowEnd: process.env.WINDOW_END || '09:00',
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
  // --- Auth / nav ---
  loginLink:   (page) => page.getByRole('link', { name: /^login$/i }),
  logoutLink:  (page) => page.getByRole('link', { name: /^logout$/i }),
  loginUser:   (page) => page.getByLabel('Username'),
  loginPass:   (page) => page.getByLabel('Password'),
  loginSubmit: (page) => page.getByRole('button', { name: /^login$/i }),
  continueLink:(page) => page.getByRole('link', { name: /continue|enter|home|my account/i }),
  continueBtn: (page) => page.getByRole('button', { name: /continue|enter/i }),

  // --- Search form (use explicit IDs where available) ---
  courseSelect:    (page) => page.getByLabel('Course'),
  playersSelect:   (page) => page.getByLabel('Number Of Players'),
  holesSelect:     (page) => page.getByLabel('Number Of Holes'),

  // WebTrac has both a Date textbox and a Date button; target the textbox (id=begindate)
  dateInput:       (page) => page.locator('#begindate'),

  // Begin Time often has id=begintime; try label first, then fallback to #begintime
  beginTimeSelect: async (page) => {
    const byLabel = page.getByLabel('Begin Time');
    if (await byLabel.count().then(c=>c>0).catch(()=>false)) return byLabel;
    return page.locator('#begintime');
  },

  searchBtn:   (page) => page.getByRole('button', { name: /^search$/i }),

  // --- Results ---
  rowRole:     (page) => page.getByRole('row'),
  addToCartIn: (row)  => row.getByRole('button', { name: /Add To Cart/i }),
  confirmBtn:  (page) => page.getByRole('button', { name: /Confirm|Checkout|Pay/i }),
};

// ---------- Core actions ----------
async function isLoggedIn(page) {
  // If there's a Logout link, you're logged in
  return await S.logoutLink(page).isVisible().catch(()=>false);
}

async function login(page) {
  console.log('[auth] navigating to LOGIN_URL…');
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });

  console.log('[auth] filling username/password…');
  await S.loginUser(page).fill(cfg.user);
  await S.loginPass(page).fill(cfg.pass);

  console.log('[auth] submitting login…');
  await Promise.all([
    page.waitForLoadState('networkidle'),
    S.loginSubmit(page).click(),
  ]);

  // If a splash shows, click through (best effort)
  if (await S.continueLink(page).isVisible().catch(()=>false)) {
    console.log('[auth] splash link found → continuing…');
    await Promise.all([ page.waitForLoadState('networkidle'), S.continueLink(page).click() ]);
  } else if (await S.continueBtn(page).isVisible().catch(()=>false)) {
    console.log('[auth] splash button found → continuing…');
    await Promise.all([ page.waitForLoadState('networkidle'), S.continueBtn(page).click() ]);
  }

  console.log('[auth] going to tee sheet…');
  await page.goto(cfg.courseUrl, { waitUntil: 'domcontentloaded' });
}

async function gotoSearch(page) {
  if (!page.url().includes('/search.html')) {
    await page.goto(cfg.courseUrl, { waitUntil: 'domcontentloaded' });
  }
  console.log('[search] setting Course/Players/Holes…');
  await S.courseSelect(page).selectOption({ label: cfg.courseName }).catch(()=>{});
  await S.playersSelect(page).selectOption(String(cfg.players)).catch(()=>{});
  await S.holesSelect(page).selectOption({ label: cfg.holesLabel }).catch(()=>{});
}




function parseForcedDateFromEnv() {
  const s = process.env.TARGET_DATE; // expect MM/DD/YYYY
  if (!s) return null;
  const [mm, dd, yyyy] = s.split('/');
  if (!mm || !dd || !yyyy) return null;
  const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
  return isNaN(d) ? null : d;
}


function mdy(dateObj) {
  const yyyy = dateObj.toLocaleString('en-US', { timeZone: cfg.tz, year:'numeric' });
  const mm   = dateObj.toLocaleString('en-US', { timeZone: cfg.tz, month:'2-digit' });
  const dd   = dateObj.toLocaleString('en-US', { timeZone: cfg.tz, day:'2-digit' });
  return `${mm}/${dd}/${yyyy}`;
}



async function typeDateLikeHuman(inp, value) {
  await inp.scrollIntoViewIfNeeded();
  await inp.focus();
  // Select-all + clear thoroughly
  await inp.press('ControlOrMeta+a').catch(()=>{});
  await inp.press('Backspace').catch(()=>{});
  // Slow type so the mask/validator reacts
  await inp.type(value, { delay: 60 });
  // Nudge change/blur events
  await inp.press('Enter').catch(()=>{});
  await inp.blur().catch(()=>{});
}

async function pickDateViaCalendar(page, dateObj) {
  // Open the datepicker button next to #begindate
  const calendarBtn = page.locator('#begindate_vm_4_button'); // seen in your error output
  if (!(await calendarBtn.isVisible().catch(()=>false))) return false;
  await calendarBtn.click();

  // Target month/year header & nav arrows (common CivicRec datepicker roles/labels)
  const targetMonth = dateObj.toLocaleString('en-US', { month:'long' });
  const targetYear  = dateObj.toLocaleString('en-US', { year:'numeric' });

  // Try up to 12 steps to reach the right month/year
  for (let i = 0; i < 12; i++) {
    const header = page.getByRole('heading', { name: new RegExp(`${targetMonth}\\s+${targetYear}`,'i') });
    if (await header.isVisible().catch(()=>false)) break;
    // Click "Next" arrow
    const next = page.getByRole('button', { name: /next|›|»/i });
    await next.click().catch(()=>{});
    await page.waitForTimeout(150);
  }

  // Click the day number
  const day = dateObj.toLocaleString('en-US', { day:'numeric' }); // e.g., "24"
  const dayBtn = page.getByRole('button', { name: new RegExp(`^${day}$`) });
  await dayBtn.click();
  return true;
}

async function setDateAndSearch(page, dateObj) {
  const dateStr = mdy(dateObj);
  console.log(`[search] setting Date=${dateStr} fast…`);

  // 1) Set date instantly via direct value set + events
  const dateOk = await setInputValueAndDispatch(page, '#begindate', dateStr);
  const cur = (await page.locator('#begindate').inputValue()).trim();
  console.log(`[search] Date now reads: ${cur}`);
  if (!dateOk) console.warn('[search] Warning: date didn’t stick on first try');

  // --- Force Begin Time (timepicker input) ---
try {
  const startHHMM = (process.env.WINDOW_START || cfg.windowStart); // e.g. "17:00"
  const [hh, mm] = startHHMM.split(':').map(Number);
  const h12 = ((hh % 12) || 12);
  const ampm = hh >= 12 ? 'pm' : 'am';
  const timeLabel = `${String(h12)}:${String(mm).padStart(2,'0')} ${ampm}`; // "5:00 pm"
  console.log(`[search] forcing Begin Time=${timeLabel}…`);

  const ok = await setInputValueAndDispatch(page, '#begintime', timeLabel);
  if (!ok) console.warn('[search] Begin Time did not stick on first try');
} catch (e) {
  console.warn('[search] Begin Time force failed:', e?.message);
}


  // 3) Search
  console.log('[search] clicking Search…');
  await Promise.all([
    page.waitForLoadState('networkidle'),
    S.searchBtn(page).click(),
  ]);
}

  // (Optional) set Begin Time to a sane lower bound (helps paging)
  // Find/select an option in a <select> by visible text (case/space-insensitive)
async function selectOptionByLooseText(selectLocator, wantedLabel) {
  const norm = s => s.toLowerCase().replace(/\s+/g, '');
  const want = norm(wantedLabel);
  const handle = await selectLocator.elementHandle();
  if (!handle) return false;

  const success = await selectLocator.selectOption({ label: new RegExp(`^\\s*${wantedLabel.replace(/[:/\\^$.*+?()[\]{}|-]/g,'\\$&')}\\s*$`, 'i') }).catch(()=>null);
  if (success && success.length) return true;

  // fallback: scan options manually and set by value
  const chosen = await selectLocator.evaluate((sel, want) => {
    const norm = s => (s || '').toLowerCase().replace(/\s+/g,'');
    const opts = Array.from(sel.options || []);
    const found = opts.find(o => norm(o.textContent) === want) || opts.find(o => norm(o.label) === want);
    if (found) {
      sel.value = found.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, want);
  return chosen;
}

// Map "17:00" -> "5:00 PM" etc.
function hhmmToLabel(hhmm) {
  const [hhStr, mmStr] = hhmm.split(':');
  const hh = parseInt(hhStr,10);
  const h12 = ((hh % 12) || 12);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  return `${h12}:${mmStr} ${ampm}`;
}


async function findCandidates(page) {
  const rows = await page.getByRole('row').all();
  console.log(`[results] rows=${rows.length} (course=${cfg.courseName}) window=${cfg.windowStart}-${cfg.windowEnd}`);

  // (debug) show first few rows
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const t = (await rows[i].innerText()).slice(0, 140).replace(/\s+/g,' ');
    console.log(`[results] row${i}: ${t}`);
  }

  const hits = [];
  for (const r of rows) {
    const txt = (await r.innerText()).trim();
    if (!txt) continue;
    if (!txt.includes(cfg.courseName)) continue;

    // extract "5:21 pm"
    const m = txt.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
    if (!m) continue;

    // normalize to "HH:MM" 24h
    const t24 = normalizeTimeLabel(m[1]);
    if (!t24 || !timeInRange(t24, cfg.windowStart, cfg.windowEnd)) continue;

    // Prefer button inside the same visual row; if not found, fall back to page-wide match filtered by row text.
    let addBtn = r.locator('button:has-text("Add To Cart"), a:has-text("Add To Cart")');
    if (await addBtn.count() === 0) {
      // fallback: find a nearby Add To Cart whose ancestor contains the same time text
      addBtn = page.locator('button:has-text("Add To Cart"), a:has-text("Add To Cart")')
                   .filter({ hasText: '' }); // keep
    }

    // Only accept if the button exists (visible or not—some skins hide until hover)
    if (await addBtn.count() > 0) {
      hits.push({ t: t24, row: r, addBtn: addBtn.first(), rawText: txt });
    }
  }

  console.log(`[results] matching hits: ${hits.map(h => h.t).join(', ') || 'none'}`);
  hits.sort((a,b)=> a.t.localeCompare(b.t));
  return hits;
}


// Set input value via JS and dispatch input/change/blur so the site reacts.
async function setInputValueAndDispatch(page, selector, value) {
  await page.evaluate(({ selector, value }) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }, { selector, value });
  return (await page.locator(selector).inputValue()).trim().toLowerCase() === value.toLowerCase();
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

// If you previously saved auth.json, reuse it; otherwise log in fresh
if (fs.existsSync(AUTH_STATE_FILE)) {
  console.log('[session] using saved session → tee sheet…');
  await page.goto(cfg.courseUrl, { waitUntil: 'domcontentloaded' });
  if (!(await isLoggedIn(page))) {
    console.log('[session] saved session invalid; logging in again…');
    await login(page);
    await ctx.storageState({ path: AUTH_STATE_FILE });
  }
} else {
  console.log('[session] no saved session; logging in…');
  await login(page);
  await ctx.storageState({ path: AUTH_STATE_FILE });
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

const forced = parseForcedDateFromEnv();
const targets = forced ? [forced] : nextWeekendDates();
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
        await best.row.scrollIntoViewIfNeeded().catch(()=>{});
for (let i = 0; i < 3; i++) {
  try {
    // first a trial click (helps Playwright wait for the button to be interactable)
    await best.addBtn.click({ trial: true }).catch(()=>{});
    await best.addBtn.click();
    break;
  } catch (e) {
    console.warn(`[click] retry ${i+1} on Add To Cart:`, e?.message);
    await page.waitForTimeout(150);
  }
}
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
