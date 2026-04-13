import { chromium, Browser, BrowserContext } from "playwright";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import { generateComment } from "../generator/comment-generator.js";
import { getActiveSlots, TIME_SLOTS } from "../scheduler/timeslots.js";
import type { Lang, TimeSlot } from "../scheduler/timeslots.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// ── Constants ────────────────────────────────────────────────────────────────

const COOKIES_FILE = resolve("twitter-cookies.json");

// ── Browser singleton ────────────────────────────────────────────────────────

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let isLoggedIn = false;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    logger.info("commenter", "🌐 Starting browser...");

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    };

    if (config.PROXY_SERVER) {
      launchOptions.proxy = {
        server: config.PROXY_SERVER,
        username: config.PROXY_USERNAME,
        password: config.PROXY_PASSWORD,
      };
      logger.info("commenter", `🔀 Using proxy: ${config.PROXY_SERVER}`);
    }

    browser = await chromium.launch(launchOptions);
    context = null;
    isLoggedIn = false;
  }
  return browser;
}

async function getContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  if (!context) {
    context = await b.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
  }
  return context;
}

export async function getContextForQuoter(): Promise<BrowserContext> {
  return getContext();
}

// ── Cookie helpers ───────────────────────────────────────────────────────────

function loadCookies(): any[] | null {
  if (!existsSync(COOKIES_FILE)) return null;
  try {
    const raw = readFileSync(COOKIES_FILE, "utf-8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return null;
    logger.info(
      "commenter",
      `🍪 Loaded ${cookies.length} cookies from ${COOKIES_FILE}`,
    );
    return cookies;
  } catch {
    logger.warn("commenter", "⚠️ Failed to read cookies file, skipping");
    return null;
  }
}

function saveCookies(cookies: any[]): void {
  try {
    writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    logger.info(
      "commenter",
      `💾 Saved ${cookies.length} cookies → ${COOKIES_FILE}`,
    );
  } catch (err: any) {
    logger.warn("commenter", `⚠️ Could not save cookies: ${err.message}`);
  }
}

function isTwitterLoggedInCookie(cookies: any[]): boolean {
  // Has "auth_token" cookie = logged in
  return cookies.some(
    (c) =>
      (c.name === "auth_token" && c.domain?.includes("twitter.com")) ||
      c.domain?.includes("x.com"),
  );
}

// ── Login ────────────────────────────────────────────────────────────────────

async function login(): Promise<boolean> {
  if (isLoggedIn) return true;

  const ctx = await getContext();

  // Try loading cookies first
  const savedCookies = loadCookies();
  if (savedCookies) {
    await ctx.addCookies(savedCookies);

    // Verify cookies are still valid
    const page = await ctx.newPage();
    try {
      await page.goto("https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(3000);

      if (page.url().includes("/home")) {
        // Save refreshed cookies
        const freshCookies = await ctx.cookies();
        saveCookies(freshCookies);
        isLoggedIn = true;
        logger.info("commenter", "✅ Logged in via cookies!");
        return true;
      } else {
        logger.warn(
          "commenter",
          "⚠️ Cookies expired, trying username/password login...",
        );
        await ctx.clearCookies();
      }
    } finally {
      await page.close();
    }
  }

  // Fallback: login with username/password
  if (!config.TWITTER_USERNAME || !config.TWITTER_PASSWORD) {
    logger.error(
      "commenter",
      "❌ No cookies and missing TWITTER_USERNAME/PASSWORD in .env",
    );
    logger.error(
      "commenter",
      "👉 Run: node export-cookies.mjs to generate cookies file",
    );
    return false;
  }

  const page = await ctx.newPage();
  try {
    logger.info("commenter", "🔑 Logging in with username/password...");

    await page.goto("https://x.com/i/flow/login", {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    await page.waitForTimeout(6000);

    await page.waitForSelector('input[autocomplete="username"]', {
      timeout: 30000,
    });
    await page.fill('input[autocomplete="username"]', config.TWITTER_USERNAME);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    for (let i = 0; i < 3; i++) {
      if (await page.$('input[type="password"]')) break;
      const ocf = await page.$('input[data-testid="ocfEnterTextTextInput"]');
      if (ocf) {
        await ocf.fill(config.TWITTER_EMAIL || config.TWITTER_USERNAME);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(3000);
      } else {
        await page.waitForTimeout(2000);
      }
    }

    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    await page.fill('input[type="password"]', config.TWITTER_PASSWORD);
    await page.keyboard.press("Enter");

    await page.waitForURL(/x\.com\/(home|$)/, { timeout: 30000 });
    await page.waitForTimeout(2000);

    // Save cookies so we don't need to login next time
    const cookies = await ctx.cookies();
    saveCookies(cookies);

    isLoggedIn = true;
    logger.info("commenter", "✅ Login successful! Cookies saved.");
    return true;
  } catch (err: any) {
    logger.error("commenter", `❌ Login failed: ${err.message}`);
    isLoggedIn = false;
    return false;
  } finally {
    await page.close();
  }
}

// ── Dismiss cookie banner ────────────────────────────────────────────────────

async function dismissCookieBanner(
  page: import("playwright").Page,
): Promise<void> {
  try {
    const selectors = [
      '[data-testid="twc-cc-btn-accept"]',
      'div[data-testid="BottomBar"] [role="button"]',
      'span:has-text("Accept all cookies")',
      'span:has-text("Refuse non-essential cookies")',
    ];
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(800);
        logger.info("commenter", "🍪 Dismissed cookie banner");
        break;
      }
    }
    // Force-remove mask if still present
    await page
      .evaluate(() => {
        const mask = document.querySelector('[data-testid="twc-cc-mask"]');
        if (mask) (mask as HTMLElement).style.display = "none";
      })
      .catch(() => {});
  } catch {
    // No banner, skip
  }
}

// ── Post reply ───────────────────────────────────────────────────────────────

export async function postCommentOnTweet(
  tweetId: string,
  commentText: string,
): Promise<string | null> {
  return postReply(tweetId, commentText);
}

async function postReply(
  tweetId: string,
  commentText: string,
): Promise<string | null> {
  const ctx = await getContext();
  const page = await ctx.newPage();

  try {
    const tweetUrl = `https://x.com/i/web/status/${tweetId}`;
    await page.goto(tweetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);

    // Dismiss cookie consent overlay before interacting
    await dismissCookieBanner(page);

    // Wait for reply button (JS render can be slow)
    const replyButton = await page
      .waitForSelector('[data-testid="reply"]', { timeout: 15000 })
      .catch(() => null);
    if (!replyButton) {
      logger.warn("commenter", `Reply button not found for tweet ${tweetId}`);
      return null;
    }
    await replyButton.click();
    await page.waitForTimeout(1500);

    const replyBox = await page.waitForSelector(
      '[data-testid="tweetTextarea_0"]',
      { timeout: 10000 },
    );
    await replyBox.click();
    await page.waitForTimeout(500);

    await replyBox.type(commentText, { delay: 30 });
    await page.waitForTimeout(1000);

    let newTweetId: string | null = null;
    page.on("response", async (response) => {
      if (response.url().includes("CreateTweet") && response.status() === 200) {
        try {
          const json = await response.json();
          const id =
            json?.data?.create_tweet?.tweet_results?.result?.rest_id ||
            json?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str;
          if (id) newTweetId = id;
        } catch {}
      }
    });

    // Refresh cookies after reply
    const cookies = await ctx.cookies();
    if (cookies.length > 0) saveCookies(cookies);

    const submitBtn = await page.waitForSelector(
      '[data-testid="tweetButton"]',
      { timeout: 5000 },
    );
    await submitBtn.click();
    await page.waitForTimeout(3000);

    if (!newTweetId) newTweetId = `browser_${Date.now()}`;
    return newTweetId;
  } catch (err: any) {
    logger.error("commenter", `❌ postReply error: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomDelay(): Promise<void> {
  const ms =
    config.COMMENT_DELAY_MIN_MS +
    Math.random() * (config.COMMENT_DELAY_MAX_MS - config.COMMENT_DELAY_MIN_MS);
  logger.info(
    "commenter",
    `⏳ Waiting ${(ms / 1000).toFixed(0)}s before next comment...`,
  );
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random hourly limit per slot (5–8) */
function getHourlyLimit(): number {
  return (
    config.COMMENTS_PER_HOUR_MIN +
    Math.floor(
      Math.random() *
        (config.COMMENTS_PER_HOUR_MAX - config.COMMENTS_PER_HOUR_MIN + 1),
    )
  );
}

/** Comments posted in the CURRENT HOUR for this slot */
async function countThisHourComments(slotId: string): Promise<number> {
  const now = new Date();
  const startOfHour = new Date(now);
  startOfHour.setMinutes(0, 0, 0);
  return db.postedComment.count({
    where: { timeSlot: slotId, postedAt: { gte: startOfHour } },
  });
}

// ── Quota cache — consistent hourlyLimit within each hour ────────────────────

const hourlyLimitCache = new Map<string, { hourKey: string; limit: number }>();

function getHourlyLimitCached(slotId: string): number {
  const hourKey = new Date().toISOString().slice(0, 13); // "2025-04-03T14"
  const cached = hourlyLimitCache.get(slotId);
  if (cached && cached.hourKey === hourKey) return cached.limit;
  const limit = getHourlyLimit();
  hourlyLimitCache.set(slotId, { hourKey, limit });
  logger.info("commenter", `📋 New hourly limit for ${slotId}: ${limit}/hour`);
  return limit;
}

// ── Quota check (scheduler calls before each crawl loop) ─────────────────────

export interface QuotaStatus {
  canComment: boolean;
  canDo: number;
  remainingThisHour: number;
  hourlyLimit: number;
  doneThisHour: number;
}

export async function checkQuota(slot: TimeSlot): Promise<QuotaStatus> {
  const hourlyLimit = getHourlyLimitCached(slot.id);
  const doneThisHour = await countThisHourComments(slot.id);
  const remainingThisHour = Math.max(0, hourlyLimit - doneThisHour);
  const canDo = remainingThisHour;
  return { canComment: canDo > 0, canDo, remainingThisHour, hourlyLimit, doneThisHour };
}

// ── Ensure login (scheduler calls at slot start) ──────────────────────────────

export async function ensureLogin(): Promise<boolean> {
  return login();
}

// ── Comment a single tweet (scheduler calls per tweet after crawl) ────────────

/**
 * Comment on a specific tweet for the given slot.
 * Returns true on success.
 * Scheduler handles delay between tweets — this function does not delay.
 */
export async function commentOneTweet(tweetDbId: string, slot: TimeSlot): Promise<boolean> {
  const locked = await db.monitoredTweet.updateMany({
    where: { id: tweetDbId, status: "pending" },
    data: { status: "processing" },
  });
  if (locked.count === 0) return false;

  const tweet = await db.monitoredTweet.findUnique({ where: { id: tweetDbId } });
  if (!tweet) return false;

  const commentText = await generateComment(tweet.text, tweet.authorHandle, slot.lang);
  if (!commentText) {
    await db.monitoredTweet.update({ where: { id: tweetDbId }, data: { status: "failed" } });
    return false;
  }

  let commentId = await postReply(tweet.tweetId, commentText);

  if (!commentId) {
    logger.warn("commenter", "Reply failed, trying re-login...");
    isLoggedIn = false;
    context = null;
    const relogged = await login();
    if (relogged) commentId = await postReply(tweet.tweetId, commentText);
  }

  if (!commentId) {
    await db.monitoredTweet.update({ where: { id: tweetDbId }, data: { status: "failed" } });
    return false;
  }

  await db.$transaction([
    db.monitoredTweet.update({ where: { id: tweetDbId }, data: { status: "commented" } }),
    db.postedComment.create({
      data: {
        tweetId: tweet.id,
        accountId: tweet.accountId,
        commentId,
        commentText,
        lang: slot.lang,
        timeSlot: slot.id,
      },
    }),
  ]);

  logger.info(
    "commenter",
    `✅ [EN] Reply @${tweet.authorHandle}: "${commentText.slice(0, 60)}..."`,
  );
  return true;
}

export { randomDelay };

// ── Legacy: keep for /trigger from Telegram bot ───────────────────────────────

export async function runCommentCycle(): Promise<void> {
  const activeSlots = getActiveSlots();
  if (activeSlots.length === 0) {
    logger.info("commenter", "Outside active hours — skipping");
    return;
  }
  const ok = await ensureLogin();
  if (!ok) {
    logger.error("commenter", "Cannot login to Twitter — skipping cycle");
    return;
  }
  for (const slot of activeSlots) {
    const quota = await checkQuota(slot);
    if (!quota.canComment) {
      logger.info("commenter", `${slot.label}: quota full this hour (${quota.doneThisHour}/${quota.hourlyLimit}/hour)`);
      continue;
    }
    const pending = await db.monitoredTweet.findMany({
      where: { status: "pending", account: { lang: slot.lang, isActive: true } },
      orderBy: { tweetCreatedAt: "desc" },
      take: quota.canDo,
    });
    for (let i = 0; i < pending.length; i++) {
      await commentOneTweet(pending[i].id, slot);
      if (i < pending.length - 1) await randomDelay();
    }
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    isLoggedIn = false;
    logger.info("commenter", "Browser closed");
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

export async function getCommentStats(): Promise<{
  todayTotal: number;
  todayBySlot: { slot: string; count: number }[];
  allTime: number;
}> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [todayTotal, allTime] = await Promise.all([
    db.postedComment.count({ where: { postedAt: { gte: startOfDay } } }),
    db.postedComment.count(),
  ]);

  const todayBySlot = await Promise.all(
    TIME_SLOTS.map(async (slot) => ({
      slot: slot.label,
      count: await db.postedComment.count({
        where: { timeSlot: slot.id, postedAt: { gte: startOfDay } },
      }),
    })),
  );

  return {
    todayTotal,
    todayBySlot: todayBySlot.filter((s) => s.count > 0),
    allTime,
  };
}
