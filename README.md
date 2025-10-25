# Tee-Time Bot — README

Automation script to grab Austin CivicRec/WebTrac golf tee times (e.g., Roy Kizer, Jimmy Clay) using Playwright. It logs in, sets the date/time window, searches, clicks **Add To Cart**, then stops so you can manually finish on the “One Click To Finish” page.
Implementation lives in `reserve-teetime.mjs` and is configurable via `.env`.  

---

## Requirements

* Node.js (18+ recommended)
* NPM
* Playwright + browsers
* Ubuntu/WSL users may need system deps for a visible browser window

Install deps:

```bash
npm install
npm install playwright dotenv
npx playwright install
# If needed for WSL/Ubuntu GUI deps:
# npx playwright install-deps
```

---

## Project files

* `reserve-teetime.mjs` — main script (ESM). Minimal flow: **login → set date/time → search → Add To Cart → beep & stop**. 
* `.env` — credentials + defaults (see below). 
* `auth.json` — saved session (auto-created after successful login). 

---

## Configure via `.env`

```ini
LOGIN_URL=https://txaustinweb.myvscloud.com/webtrac/web/login.html
COURSE_URL=https://txaustinweb.myvscloud.com/webtrac/web/search.html?display=detail&module=GR&secondarycode=2
USERNAME=yourUsername
PASSWORD=yourPassword
COURSE_NAME=Roy Kizer Golf Course   # or "Jimmy Clay Golf Course"
PLAYERS=2
WINDOW_START=07:00                  # "HH:MM" 24h
WINDOW_END=09:00
PREFERRED_DAYS=Sat,Sun              # For auto target (next Sat/Sun)
TIMEZONE=America/Chicago
HEADLESS=false                      # true = headless
AUTO_CONFIRM=false                  # kept for future use; script stops before finishing
SEARCH_SECONDS=240                  # search loop budget
REFRESH_JITTER_MS=1700,2600         # random reload delay (ms,min,max)
```



> **Tip:** Keep `HEADLESS=false` while debugging so you can see the browser.

---

## Quick start

From the repo root:

```bash
# Typical dev test: force a specific date + afternoon window (4–7 PM)
TARGET_DATE=10/26/2025 WINDOW_START=16:00 WINDOW_END=19:00 HEADLESS=false node reserve-teetime.mjs
```

* The script logs the target date, sets **Begin Time** to match `WINDOW_START`, searches, then selects the first matching tee time for `COURSE_NAME`. 
* After “Add To Cart,” it **beeps** and **stops** so you can click “One Click To Finish” manually. 

---

## How to change day & time

You can **override per-run** (recommended) or edit `.env`.

### Option A — Override per run (recommended)

* **Target a specific date** (MM/DD/YYYY):

  ```bash
  TARGET_DATE=11/02/2025 node reserve-teetime.mjs
  ```

  The script uses `TARGET_DATE` if set; otherwise it auto-picks the **next weekend days** based on `PREFERRED_DAYS`. 

* **Change the time window** (24h format):

  ```bash
  WINDOW_START=16:00 WINDOW_END=19:00 node reserve-teetime.mjs
  ```

* **Run in headless mode** (CI or no GUI):

  ```bash
  HEADLESS=true node reserve-teetime.mjs
  ```

### Option B — Edit `.env`

Adjust `WINDOW_START`, `WINDOW_END`, `PREFERRED_DAYS`, then run:

```bash
node reserve-teetime.mjs
```

---

## What the script actually does (flow)

1. **Session check / login** → Navigate to login, fill credentials, bypass “continue” splash, go to tee sheet. Session saved to `auth.json` for reuse. 
2. **Form setup** → Select Course, Players, Holes. 
3. **Date & time** → Sets `#begindate` directly (with input/change/blur events) and forces `#begintime` from `WINDOW_START` (“HH:MM” → “h:mm am/pm”). 
4. **Search & parse** → Clicks Search, waits, reads result rows, matches rows for `COURSE_NAME`, pulls times like “5:21 pm,” converts to 24h, filters by window. 
5. **Reserve** → Scrolls to the row, attempts **Add To Cart** (trial click + real click, with retries), then **beeps** and stops for manual finish. 

---

## Advanced options

* **Release-time alignment**
  If you launch just before 5:00 PM CT, the script will optionally pause to sync and start right at release:
  it computes milliseconds until `17:00` in your timezone (`TIMEZONE`) and waits if the window is short. 

* **Search loop budget**
  `SEARCH_SECONDS` caps how long it keeps refreshing and searching before quitting. 

* **Randomized refresh**
  `REFRESH_JITTER_MS` adds a small random delay to reloads to look less bot-like. 

---

## Troubleshooting

* **“Missing required envs: …”** → Fill `USERNAME`, `PASSWORD`, `COURSE_NAME` in `.env`. 
* **Browser won’t open on WSL** → Ensure browsers are installed:

  ```bash
  npx playwright install
  # If GUI libs missing:
  # npx playwright install-deps
  ```
* **No matches found** → Verify:

  * `COURSE_NAME` exactly matches the site’s label.
  * `WINDOW_START/END` cover a time actually offered that day.
  * `TARGET_DATE` is a valid MM/DD/YYYY date for the chosen course.

---

## Safety & etiquette

* Use for personal automation only; don’t hammer the servers.
* Keep `SEARCH_SECONDS` modest and `REFRESH_JITTER_MS` enabled. 
* Finish manually on the Member Selection page (the script intentionally stops there).

---

## File map

* `reserve-teetime.mjs` — main script (drop-in). 
* `.env` — configuration template/values. 

---

## Example commands

```bash
# Dev test with visible browser, fixed date & afternoon window
TARGET_DATE=10/26/2025 WINDOW_START=16:00 WINDOW_END=19:00 HEADLESS=false node reserve-teetime.mjs

# Morning window via overrides
TARGET_DATE=11/02/2025 WINDOW_START=07:00 WINDOW_END=09:00 node reserve-teetime.mjs

# Use .env defaults, headless
HEADLESS=true node reserve-teetime.mjs
```
