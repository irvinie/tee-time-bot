// reserve-teetime.mjs
// Minimal flow: login → set date/time → search → click "Add To Cart" → beep & stop.

import "dotenv/config";
import fs from "fs";
import { chromium } from "playwright";

// ---------- Config helpers ----------
const bool = (v, d = false) => (v == null ? d : /^(1|true|yes)$/i.test(v));
const int = (v, d) => (v == null ? d : parseInt(v, 10));
const parseJitter = (s, d = [1700, 2600]) => {
	try {
		const [a, b] = (s || "").split(",").map((x) => parseInt(x, 10));
		return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : d;
	} catch {
		return d;
	}
};

// ---------- Env/config ----------
const cfg = {
	loginUrl:
		process.env.LOGIN_URL ||
		"https://txaustinweb.myvscloud.com/webtrac/web/login.html",
	courseUrl:
		process.env.COURSE_URL ||
		"https://txaustinweb.myvscloud.com/webtrac/web/search.html?display=detail&module=GR&secondarycode=2",
	user: process.env.USERNAME,
	pass: process.env.PASSWORD,
	courseName: process.env.COURSE_NAME || "Roy Kizer Golf Course",
	players: int(process.env.PLAYERS, 2),
	holesLabel: process.env.HOLES_LABEL || "18 Holes",
	windowStart: process.env.WINDOW_START || "07:00", // "HH:MM"
	windowEnd: process.env.WINDOW_END || "09:00", // "HH:MM"
	preferredDays: (process.env.PREFERRED_DAYS || "Sat,Sun")
		.split(",")
		.map((s) => s.trim()),
	tz: process.env.TIMEZONE || "America/Chicago",

	headless: bool(process.env.HEADLESS, false),
	searchSeconds: int(process.env.SEARCH_SECONDS, 240),
	refreshJitter: parseJitter(process.env.REFRESH_JITTER_MS, [1700, 2600]),
};

function assertEnv() {
	const required = ["loginUrl", "courseUrl", "user", "pass", "courseName"];
	const missing = required.filter((k) => !cfg[k]);
	if (missing.length)
		throw new Error(`Missing required envs: ${missing.join(", ")}`);
}

// ---------- Utils ----------
function toMin(hhmm) {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}
function timeInRange(hhmm, start, end) {
	const t = toMin(hhmm),
		s = toMin(start),
		e = toMin(end);
	return t >= s && t <= e;
}
function normalizeTimeLabel(label = "") {
	const m = label.trim().match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
	if (!m) return "";
	let [, hh, mm, ampm] = m;
	hh = parseInt(hh, 10);
	if (/pm/i.test(ampm) && hh !== 12) hh += 12;
	if (/am/i.test(ampm) && hh === 12) hh = 0;
	return String(hh).padStart(2, "0") + ":" + mm;
}
function mdy(dateObj) {
	const yyyy = dateObj.toLocaleString("en-US", {
		timeZone: cfg.tz,
		year: "numeric",
	});
	const mm = dateObj.toLocaleString("en-US", {
		timeZone: cfg.tz,
		month: "2-digit",
	});
	const dd = dateObj.toLocaleString("en-US", {
		timeZone: cfg.tz,
		day: "2-digit",
	});
	return `${mm}/${dd}/${yyyy}`;
}
async function setInputValueAndDispatch(page, selector, value) {
	await page.evaluate(
		({ selector, value }) => {
			const el = document.querySelector(selector);
			if (!el) return false;
			el.value = value;
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			el.dispatchEvent(new Event("blur", { bubbles: true }));
			return true;
		},
		{ selector, value }
	);
	const got = (await page.locator(selector).inputValue()).trim();
	return got.toLowerCase() === value.toLowerCase();
}
function nextWeekendDates() {
	const out = [],
		now = new Date();
	for (let i = 0; i < 14; i++) {
		const d = new Date(now);
		d.setDate(d.getDate() + i);
		const dow = d.toLocaleDateString("en-US", {
			weekday: "short",
			timeZone: cfg.tz,
		});
		if (
			cfg.preferredDays.some((x) =>
				dow.toLowerCase().startsWith(x.toLowerCase())
			)
		)
			out.push(d);
	}
	return out.slice(0, 2);
}
function jitteredDelay([min, max]) {
	const ms = Math.floor(Math.random() * (max - min) + min);
	return new Promise((r) => setTimeout(r, ms));
}
function msUntilCT(hour = 17, minute = 0) {
	const now = new Date();
	const nowCT = new Date(now.toLocaleString("en-US", { timeZone: cfg.tz }));
	const tgtCT = new Date(nowCT);
	tgtCT.setHours(hour, minute, 0, 0);
	const delta = tgtCT.getTime() - nowCT.getTime();
	const tgt = new Date(now.getTime() + delta);
	return Math.max(0, tgt - now);
}
function fmt(d) {
	return d.toLocaleString("en-US", { timeZone: cfg.tz });
}
function parseForcedDateFromEnv() {
	const s = process.env.TARGET_DATE;
	if (!s) return null;
	const [mm, dd, yyyy] = s.split("/");
	if (!mm || !dd || !yyyy) return null;
	const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
	return isNaN(d) ? null : d;
}

// ---------- Selectors ----------
const S = {
	logoutLink: (page) => page.getByRole("link", { name: /^logout$/i }),
	loginUser: (page) => page.getByLabel("Username"),
	loginPass: (page) => page.getByLabel("Password"),
	loginSubmit: (page) => page.getByRole("button", { name: /^login$/i }),
	continueLink: (page) =>
		page.getByRole("link", { name: /continue|enter|home|my account/i }),
	continueBtn: (page) => page.getByRole("button", { name: /continue|enter/i }),

	courseSelect: (page) => page.getByLabel("Course"),
	playersSelect: (page) => page.getByLabel("Number Of Players"),
	holesSelect: (page) => page.getByLabel("Number Of Holes"),
	dateInput: (page) => page.locator("#begindate"),
	beginTimeInput: (page) => page.locator("#begintime"),
	searchBtn: (page) => page.getByRole("button", { name: /^search$/i }),

	rowRole: (page) => page.getByRole("row"),
};

// ---------- Core actions ----------
async function isLoggedIn(page) {
	return await S.logoutLink(page)
		.isVisible()
		.catch(() => false);
}
async function login(page) {
	console.log("[auth] navigating to LOGIN_URL…");
	await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded" });

	console.log("[auth] filling username/password…");
	await S.loginUser(page).fill(cfg.user);
	await S.loginPass(page).fill(cfg.pass);

	console.log("[auth] submitting login…");
	await Promise.all([
		page.waitForLoadState("networkidle"),
		S.loginSubmit(page).click(),
	]);

	if (
		await S.continueLink(page)
			.isVisible()
			.catch(() => false)
	) {
		console.log("[auth] splash link found → continuing…");
		await Promise.all([
			page.waitForLoadState("networkidle"),
			S.continueLink(page).click(),
		]);
	} else if (
		await S.continueBtn(page)
			.isVisible()
			.catch(() => false)
	) {
		console.log("[auth] splash button found → continuing…");
		await Promise.all([
			page.waitForLoadState("networkidle"),
			S.continueBtn(page).click(),
		]);
	}

	console.log("[auth] going to tee sheet…");
	await page.goto(cfg.courseUrl, { waitUntil: "domcontentloaded" });
}
async function gotoSearch(page) {
	if (!page.url().includes("/search.html")) {
		await page.goto(cfg.courseUrl, { waitUntil: "domcontentloaded" });
	}
	console.log("[search] setting Course/Players/Holes…");
	await S.courseSelect(page)
		.selectOption({ label: cfg.courseName })
		.catch(() => {});
	await S.playersSelect(page)
		.selectOption(String(cfg.players))
		.catch(() => {});
	await S.holesSelect(page)
		.selectOption({ label: cfg.holesLabel })
		.catch(() => {});
}
async function setDateAndSearch(page, dateObj) {
	const dateStr = mdy(dateObj);
	console.log(`[search] setting Date=${dateStr}…`);
	const dateOk = await setInputValueAndDispatch(page, "#begindate", dateStr);
	if (!dateOk) console.warn("[search] date did not stick on first try");

	// Force Begin Time from WINDOW_START (e.g. "16:00" -> "4:00 pm")
	try {
		const [hh, mm] = (process.env.WINDOW_START || cfg.windowStart)
			.split(":")
			.map(Number);
		const h12 = hh % 12 || 12;
		const ampm = hh >= 12 ? "pm" : "am";
		const label = `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
		console.log(`[search] forcing Begin Time=${label}…`);
		await setInputValueAndDispatch(page, "#begintime", label);
	} catch {
		/* noop */
	}

	console.log("[search] clicking Search…");
	await Promise.all([
		S.searchBtn(page).click(),
		page.waitForLoadState("networkidle"),
	]);
}
async function findCandidates(page) {
	const rows = await S.rowRole(page).all();
	console.log(
		`[results] rows=${rows.length} (course=${cfg.courseName}) window=${cfg.windowStart}-${cfg.windowEnd}`
	);
	const hits = [];
	for (const r of rows) {
		const txt = (await r.innerText()).trim();
		if (!txt || !txt.includes(cfg.courseName)) continue;
		const m = txt.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
		if (!m) continue;
		const t24 = normalizeTimeLabel(m[1]);
		if (!t24 || !timeInRange(t24, cfg.windowStart, cfg.windowEnd)) continue;
		let addBtn = r.locator(
			'button:has-text("Add To Cart"), a:has-text("Add To Cart")'
		);
		if ((await addBtn.count()) > 0)
			hits.push({ t: t24, row: r, addBtn: addBtn.first(), rawText: txt });
	}
	hits.sort((a, b) => a.t.localeCompare(b.t));
	console.log(
		`[results] matching hits: ${hits.map((h) => h.t).join(", ") || "none"}`
	);
	return hits;
}

// ---------- Main ----------
(async () => {
	assertEnv();

	console.log("Starting tee-time bot with config:", {
		courseName: cfg.courseName,
		tz: cfg.tz,
		window: `${cfg.windowStart}-${cfg.windowEnd}`,
		preferredDays: cfg.preferredDays,
		players: cfg.players,
		headless: cfg.headless,
	});

	// ---------- Browser + session context setup ----------
	let contextArgs = {};
	const AUTH_STATE_FILE = "auth.json";

	if (fs.existsSync(AUTH_STATE_FILE)) {
		try {
			const savedState = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, "utf8"));
			if (savedState?.cookies?.length > 0) {
				contextArgs = { storageState: AUTH_STATE_FILE };
				console.log("[session] found valid cookies in auth.json");
			} else {
				console.warn("[session] auth.json empty — ignoring.");
			}
		} catch {
			console.warn("[session] could not parse auth.json — ignoring.");
		}
	}

	const browser = await chromium.launch({ headless: cfg.headless });
	const ctx = await browser.newContext(contextArgs);
	const page = await ctx.newPage();

	// ---------- Session handling (fast skip if already logged in) ----------
	if (fs.existsSync(AUTH_STATE_FILE)) {
		console.log("[session] using saved session → tee sheet…");
		await page.goto(cfg.courseUrl, { waitUntil: "domcontentloaded" });

		try {
			const loggedIn = await isLoggedIn(page);
			if (loggedIn) {
				console.log("[session] valid session detected — skipping login.");
			} else {
				console.log("[session] saved session invalid; re-logging in…");
				await login(page);
				await ctx.storageState({ path: AUTH_STATE_FILE });
				console.log("[session] cookies saved — next run should skip login.");
			}
		} catch (err) {
			console.warn(
				"[session] login check failed, re-logging in just in case:",
				err.message
			);
			await login(page);
			await ctx.storageState({ path: AUTH_STATE_FILE });
		}
	} else {
		console.log("[session] no saved session; logging in…");
		await login(page);
		await ctx.storageState({ path: AUTH_STATE_FILE });
		console.log("[session] new auth.json saved.");
	}

	await gotoSearch(page);

	// Optional: align close to 5:00 PM CT
	const ms = msUntilCT(17, 0);
	if (ms > 0 && ms < 120000) {
		console.log(
			`Waiting ~${Math.round(ms / 1000)}s for 5:00 PM CT (${fmt(
				new Date(Date.now() + ms)
			)})…`
		);
		await new Promise((r) => setTimeout(r, ms));
	} else {
		console.log("It is already near/after 5:00 PM CT — searching now.");
	}

	const forced = parseForcedDateFromEnv();
	const targets = forced ? [forced] : nextWeekendDates();
	console.log(
		"Target dates:",
		targets.map((d) => d.toDateString()).join(" | ")
	);

	const start = Date.now();
	let booked = false;

	while (!booked && Date.now() - start < cfg.searchSeconds * 1000) {
		for (const d of targets) {
			await setDateAndSearch(page, d);
			const hits = await findCandidates(page);
			if (!hits.length) continue;

			const best = hits[0];
			console.log(
				`FOUND ${cfg.courseName} on ${d.toDateString()} at ${best.t}`
			);
			// Scroll-into-view + robust click with retries + race verification
			await best.row.scrollIntoViewIfNeeded().catch(() => {});
			let added = false;

			for (let i = 0; i < 3; i++) {
				try {
					await best.addBtn.click({ trial: true }).catch(() => {});
					await best.addBtn.click();

					// ✅ Immediately check if we were actually redirected to the addtocart page
					await page
						.waitForLoadState("networkidle", { timeout: 3000 })
						.catch(() => {});
					const currentUrl = page.url();
					const onCartPage = currentUrl.includes("addtocart.html");

					// ✅ Alternative check: see if a cart badge exists somewhere
					const cartIndicator = page.locator(
						'a:has-text("Cart"), span:has-text("Cart")'
					);

					if (onCartPage || (await cartIndicator.count())) {
						added = true;
						console.log("[race-check] Reservation seems to have succeeded.");
						break; // stop retry loop
					} else {
						console.warn(
							"[race-check] Add To Cart may have failed (someone else got it). Retrying..."
						);
					}
				} catch (e) {
					console.warn(`[click] retry ${i + 1} on Add To Cart:`, e?.message);
					await page.waitForTimeout(200);
				}
			}

			if (!added) {
				console.warn(
					"[race-check] All attempts failed to secure slot — refreshing search..."
				);
				continue; // goes back to the outer search loop
			}

			console.log(
				'\n🚨 Added to cart. Finish manually (Click "One Click To Finish").\n'
			);
			process.stdout.write("\x07"); // beep
			booked = true;
			break;
		}
		if (!booked) {
			await jitteredDelay(cfg.refreshJitter);
			await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
		}
	}

	if (!booked) console.log("No matching tee times found within search window.");
	else console.log("Flow complete (paused for manual finish).");

	// Keep browser open for manual finish during testing
	// await browser.close();
})().catch((err) => {
	console.error("Fatal error:", err);
	// process.exit(1);
});
