# Tee-Time Bot v1.2

A **Node.js + Playwright** automation script to grab Austin CivicRec/WebTrac golf tee times (e.g., Roy Kizer, Jimmy Clay).
It logs in, sets the date/time window, searches, clicks **Add To Cart**, then stops so you can manually finish on the “One Click To Finish” page.

It securely stores credentials in `.env`, saves browser sessions to `auth.json`, and runs with fully configurable day/time windows.

---

## Requirements

- Node.js (18+ recommended)
- NPM
- Playwright + browsers
- Ubuntu/WSL users may need system deps for a visible browser window

Install deps:

```bash
npm install
npm install playwright dotenv
npx playwright install chromium
# If needed for WSL/Ubuntu GUI deps:
# npx playwright install-deps
```

---

## Project Files

- `reserve-teetime.mjs` — main script (ESM). Minimal flow: **login → set date/time → search → Add To Cart → beep & stop**.
- `.env` — credentials + defaults (see below).
- `auth.json` — saved session (auto-created after login).

---

## Project Structure

```
tee-time-bot/
│
├── reserve-teetime.mjs     # Main Playwright automation script
├── .env                    # Environment variables (your credentials & config)
├── auth.json               # Saved cookies/session (auto-created)
├── .gitignore              # Excludes node_modules/, .env, and auth.json
└── package.json
```

---

## Configure via `.env`

```ini
# --- Login & URLs ---
LOGIN_URL=https://txaustinweb.myvscloud.com/webtrac/web/login.html
COURSE_URL=https://txaustinweb.myvscloud.com/webtrac/web/search.html?display=detail&module=GR&secondarycode=2
USERNAME=yourUsername
PASSWORD=yourPassword

# --- Course preferences ---
COURSE_NAME=Roy Kizer Golf Course   # or "Jimmy Clay Golf Course"
PLAYERS=2
HOLES_LABEL=18 Holes

# --- Search window ---
WINDOW_START=07:30
WINDOW_END=10:00
PREFERRED_DAYS=Sat
TIMEZONE=America/Chicago

# --- Behavior ---
HEADLESS=false
AUTO_CONFIRM=false
SEARCH_SECONDS=240
REFRESH_JITTER_MS=1700,2600
```

> **Tip:** Keep `HEADLESS=false` while debugging so you can see the browser.

---

## Quick Start

From the repo root:

```bash
# Example dev test: force a specific date + afternoon window (4–7 PM)
TARGET_DATE=10/26/2025 WINDOW_START=16:00 WINDOW_END=19:00 HEADLESS=false node reserve-teetime.mjs
```

- The script logs the target date, sets **Begin Time** to match `WINDOW_START`, searches, then selects the first available tee time.
- After “Add To Cart,” it **beeps** and **stops** so you can manually click “One Click To Finish.”

---

## How to Change Day & Time

You can **override per-run** (recommended) or edit `.env`.

### Option A — Override per run

**Target a specific date:**

```bash
TARGET_DATE=11/02/2025 node reserve-teetime.mjs
```

**Change the time window:**

```bash
WINDOW_START=16:00 WINDOW_END=19:00 node reserve-teetime.mjs
```

**Run headless:**

```bash
HEADLESS=true node reserve-teetime.mjs
```

### Option B — Edit `.env`

Change `WINDOW_START`, `WINDOW_END`, or `PREFERRED_DAYS`, then just:

```bash
node reserve-teetime.mjs
```

The script automatically finds the **next occurrence** of your preferred day (e.g., next Thursday or Saturday).

---

## Script Flow

1. **Session Handling (Fast Login)**

   - Loads `auth.json` if present.
   - If session is valid → **skips login instantly**.
   - If expired → logs in, saves fresh cookies.

2. **Form Setup**

   - Selects course, players, and holes.

3. **Date & Time**

   - Sets `#begindate` and `#begintime` directly (no typing).

4. **Search & Match**

   - Clicks Search, parses rows, filters by course name + time window.

5. **Race-Safe Add To Cart**

   - Scrolls, retries click up to 3 times, verifies success via URL/cart check.
   - If someone else snipes the slot, it refreshes and retries automatically.

6. **Finish**

   - Beeps and stops at the “One Click To Finish” screen (manual checkout).

---

## Advanced Options

- **Release-time alignment:**
  Waits until **5:00 PM CT** before searching if run early.
- **Search timeout:**
  Controlled by `SEARCH_SECONDS`.
- **Human-like jitter:**
  Random reload delay based on `REFRESH_JITTER_MS`.

---

## Troubleshooting

| Issue                        | Fix                                                            |
| ---------------------------- | -------------------------------------------------------------- |
| `Missing required envs: ...` | Fill `USERNAME`, `PASSWORD`, `COURSE_NAME` in `.env`           |
| Browser won’t open on WSL    | Run `npx playwright install` and `npx playwright install-deps` |
| No matching times            | Check course name, target date, and window                     |
| Re-login every run           | CivicRec expires sessions by design (2–3s delay)               |

---

## Safety & Etiquette

- Designed for **personal automation only** (do not spam or overrun CivicRec servers).
- The script **never completes payment** — you finish manually.
- Runs light, ethical, and indistinguishable from a fast human click.

---

## Example Commands

```bash
# Dev test (visible browser, fixed date)
TARGET_DATE=10/26/2025 WINDOW_START=16:00 WINDOW_END=19:00 HEADLESS=false node reserve-teetime.mjs

# Production (Saturday morning 7:30–10 AM)
WINDOW_START=07:30 WINDOW_END=10:00 PREFERRED_DAYS=Sat node reserve-teetime.mjs

# Use .env defaults, headless
HEADLESS=true node reserve-teetime.mjs
```

---

## Version

**v1.2 – Final Build**
Stable · Race-safe · Session-aware · CivicRec-optimized

---

## 🧾 Changelog

### v1.2 (Current)

- Added **race-check logic** to verify Add-to-Cart success and retry if another user wins the slot.
- Implemented **session persistence** with cookie validation (`auth.json`).
- Added **smart session skip** — only re-logs in if session truly expired.
- Cleaned up redundant helpers, extra selectors, and unnecessary waits.
- Finalized `.env` variable list and clarified time/day configuration.

### v1.1

- Improved DOM targeting for date/time fields.
- Added `AUTO_CONFIRM` toggle (manual vs. automatic checkout).
- Introduced `TARGET_DATE` override for testing specific days.
- Updated Playwright event dispatch for reliability.

### v1.0

- Initial stable release: core automation (login → date/time → search → Add to Cart → stop).

---
