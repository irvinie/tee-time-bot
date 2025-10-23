import 'dotenv/config';
import { chromium } from 'playwright';

// ---- Config helpers ----
const bool = (v, d=false)=> (v==null?d:/^(1|true|yes)$/i.test(v));
const int  = (v, d)=> (v==null?d:parseInt(v,10));
const parseJitter = (s, d=[1500,2500])=>{
  try {
    const [a,b] = (s||'').split(',').map(x=>parseInt(x,10));
    return (Number.isFinite(a)&&Number.isFinite(b) ? [a,b] : d);
  } catch { return d; }
};

const cfg = {
  courseUrl: process.env.COURSE_URL,
  loginUrl: process.env.LOGIN_URL || process.env.COURSE_URL,
  user: process.env.USERNAME,
  pass: process.env.PASSWORD,
  players: int(process.env.PLAYERS, 2),
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
  const required = ['courseUrl','user','pass'];
  for (const k of required) {
    if (!cfg[k]) throw new Error(`Missing required env: ${k}`);
  }
}

function toMin(hhmm) { const [h,m] = hhmm.split(':').map(Number); return h*60+m; }
function timeInRange(hhmm, start, end) {
  const t=toMin(hhmm), s=toMin(start), e=toMin(end);
  return t>=s && t<=e;
}
function fmt(d) { return d.toLocaleString('en-US', { timeZone: cfg.tz }); }
function nextWeekendDates() {
  // Return next Sat & Sun (dates at local tz) starting from today
  const out = [];
  const now = new Date();
  for (let i=0;i<10;i++) {
    const d = new Date(now); d.setDate(d.getDate()+i);
    const dow = d.toLocaleDateString('en-US',{weekday:'short', timeZone:cfg.tz});
    if (cfg.preferredDays.some(x => dow.toLowerCase().startsWith(x.toLowerCase()))) out.push(d);
  }
  return out.slice(0, 2); // keep first Sat/Sun
}

function jitteredDelay([min,max]) {
  const ms = Math.floor(Math.random()*(max-min)+min);
  return new Promise(r=>setTimeout(r, ms));
}

// ---- Selectors you MUST update after inspecting the site ----
// Use your browser DevTools to verify these:
const S = {
  loginEmail: 'input[type="email"], #email',
  loginPass: 'input[type="password"], #password',
  loginSubmit: 'button:has-text("Sign in"), button[type="submit"]',

  playersSelect: '#players, select[name="players"]',
  dateInput: '#datePicker, input[name="date"]',
  searchBtn: 'button:has-text("Search"), button[aria-label="Search"]',

  teeRow: '.tee-time-row',
  teeTimeCell: '.time',         // e.g., innerText '7:12 AM'
  teePriceCell: '.price',
  teeBookBtn: 'button.book, button:has-text("Book")',

  confirmBtn: 'button:has-text("Confirm"), button:has-text("Pay")',
};

// Parse a visible time string like '7:12 AM' to 'HH:MM'
function normalizeTimeLabel(label='') {
  const m = label.trim().match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return '';
  let [ ,hh,mm,ampm ] = m; hh = parseInt(hh,10);
  if (/pm/i.test(ampm) && hh !== 12) hh += 12;
  if (/am/i.test(ampm) && hh === 12) hh = 0;
  return String(hh).padStart(2,'0')+':'+mm;
}

async function login(page) {
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  if (await page.$(S.loginEmail)) {
    await page.fill(S.loginEmail, cfg.user);
    await page.fill(S.loginPass, cfg.pass);
    await Promise.all([
      page.waitForLoadState('networkidle'),
      page.click(S.loginSubmit),
    ]);
  }
}

async function gotoSearch(page) {
  await page.goto(cfg.courseUrl, { waitUntil: 'domcontentloaded' });
  if (await page.$(S.playersSelect)) {
    await page.selectOption(S.playersSelect, String(cfg.players)).catch(()=>{});
  }
}

async function setDateAndSearch(page, dateObj) {
  const yyyy = dateObj.toLocaleString('en-CA', { timeZone: cfg.tz, year:'numeric' });
  const mm = dateObj.toLocaleString('en-CA', { timeZone: cfg.tz, month:'2-digit' });
  const dd = dateObj.toLocaleString('en-CA', { timeZone: cfg.tz, day:'2-digit' });
  const iso = `${yyyy}-${mm}-${dd}`;

  if (await page.$(S.dateInput)) {
    await page.fill(S.dateInput, iso);
  }
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click(S.searchBtn)
  ]);
}

async function findCandidates(page) {
  const rows = await page.$$(S.teeRow);
  const hits = [];
  for (const r of rows) {
    const label = (await r.locator(S.teeTimeCell).first().textContent().catch(()=>'')) || '';
    const t = normalizeTimeLabel(label);
    const bookable = await r.locator(S.teeBookBtn).first().isVisible().catch(()=>false);
    if (bookable && t && timeInRange(t, cfg.windowStart, cfg.windowEnd)) {
      hits.push({ t, row: r });
    }
  }
  hits.sort((a,b)=> a.t.localeCompare(b.t));
  return hits;
}

// Wait until 4:59 PM CT then login; at 5:00:00 search spam with jitter
function msUntil(targetHour=17, targetMinute=0) {
  const now = new Date();
  // Compute next occurrence today in CT, adjusting by local offset
  const nowCT = new Date(now.toLocaleString('en-US', { timeZone: cfg.tz }));
  const tgtCT = new Date(nowCT);
  tgtCT.setHours(targetHour, targetMinute, 0, 0);

  let tgt = new Date(now);
  // Translate CT target back to local/UTC by difference
  const delta = tgtCT.getTime() - nowCT.getTime();
  tgt = new Date(now.getTime() + delta);

  if (tgt <= now) {
    // if past today 5pm CT, use next Monday 5pm CT; but we usually run on Monday
    tgt.setDate(tgt.getDate() + 7);
  }
  return Math.max(0, tgt - now);
}

(async ()=>{
  assertEnv();
  console.log('Starting tee bot with config:', {
    courseUrl: cfg.courseUrl, tz: cfg.tz, window: `${cfg.windowStart}-${cfg.windowEnd}`,
    preferredDays: cfg.preferredDays, players: cfg.players, headless: cfg.headless,
    autoConfirm: cfg.autoConfirm
  });

  const browser = await chromium.launch({ headless: cfg.headless });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1) Pre-login at ~4:59 PM CT (start the script a minute before 5:00)
  // If you're running much earlier, this will just log in now and sit ready.
  await login(page);
  await gotoSearch(page);

  // 2) Focus next Sat/Sun; we’ll toggle dates quickly after release
  const targets = nextWeekendDates();
  console.log('Will search dates:', targets.map(d=>d.toDateString()).join(' | '));

  // 3) Hammer the search right after 5:00:00 CT
  // If you start at 4:59:xx CT, this short sleep aligns you to the top of the hour.
  {
    const ms = msUntil(17,0);
    if (ms > 0 && ms < 120000) {
      console.log(`Waiting ~${Math.round(ms/1000)}s for 5:00 PM CT...`);
      await new Promise(r=>setTimeout(r, ms));
    } else {
      console.log('It is already near/after 5:00 PM CT—searching now.');
    }
  }

  const t0 = Date.now();
  let booked = false;

  while (!booked && (Date.now() - t0) < cfg.searchSeconds*1000) {
    for (const d of targets) {
      await setDateAndSearch(page, d);
      const hits = await findCandidates(page);

      if (hits.length) {
        const best = hits[0];
        console.log(`FOUND ${d.toDateString()} at ${best.t}. Bringing it into view...`);
        await best.row.scrollIntoViewIfNeeded();

        // Optional pre-selections (e.g., walking/riding) — add selectors here

        // Click "Book"
        await best.row.locator(S.teeBookBtn).first().click();
        await page.waitForLoadState('networkidle').catch(()=>{});

        if (cfg.autoConfirm) {
          // Only enable if explicitly allowed by the course ToS.
          if (await page.$(S.confirmBtn)) {
            await page.click(S.confirmBtn);
            console.log('Submitted confirm (AUTO_CONFIRM=true).');
          } else {
            console.log('Confirm button not found; manual step required.');
          }
          booked = true;
          break;
        } else {
          // Safe mode: stop here and alert user to click confirm manually.
          console.log('\n🚨 Tee time ready on review page. MANUALLY click the final Confirm/Pay.\n');
          process.stdout.write('\x07'); // terminal bell
          // Keep browser open for manual completion
          booked = true;
          break;
        }
      }
    }
    if (!booked) {
      await jitteredDelay(cfg.refreshJitter);
      // Optional: hard reload to bust caches
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{});
    }
  }

  if (!booked) {
    console.log('No matching tee times found within search window.');
  } else {
    console.log('Flow completed (either paused for manual confirm or auto-confirmed).');
  }
  // Do not close browser automatically; let you verify.
  // await browser.close();
})().catch(e=>{
  console.error('Fatal error:', e);
  process.exit(1);
});
