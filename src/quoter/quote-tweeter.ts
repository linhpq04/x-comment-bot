import { Page } from "playwright";
import { existsSync, unlinkSync } from "fs";
import { ensureLogin, getContextForQuoter } from "../commenter/twitter-commenter.js";
import { generateComment } from "../generator/comment-generator.js";
import { logger } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QuoteJob {
  id: string;
  tweetId?: string;         // undefined = đăng bài thường (không quote)
  tweetUrl?: string;        // undefined = đăng bài thường (không quote)
  contentMode: "manual" | "ai";
  content: string;
  mediaPath?: string;
  scheduledAt?: Date;       // undefined = đăng ngay
  status: "pending" | "done" | "failed";
  postedId?: string;
}

// ── In-memory job store ───────────────────────────────────────────────────────

const jobs = new Map<string, QuoteJob>();

export function createJob(partial: Omit<QuoteJob, "status">): QuoteJob {
  const job: QuoteJob = { ...partial, status: "pending" };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): QuoteJob | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<QuoteJob>): void {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}

// ── AI generate content ───────────────────────────────────────────────────────

export async function generateQuoteContent(
  tweetText: string,
  authorHandle: string,
): Promise<string | null> {
  return generateComment(tweetText, authorHandle, "en");
}

// ── Playwright: post quote tweet ──────────────────────────────────────────────

export async function postQuoteTweet(
  tweetId: string,
  content: string,
  mediaPath?: string,
): Promise<string | null> {
  const ctx = await getContextForQuoter();
  const page = await ctx.newPage();

  try {
    const tweetUrl = `https://x.com/i/web/status/${tweetId}`;
    logger.info("quoter", `Navigating to tweet ${tweetId}...`);
    await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);

    await dismissBanner(page);

    // Click nút Retweet/Đăng lại
    const retweetBtn = await page
      .waitForSelector('[data-testid="retweet"]', { timeout: 15000 })
      .catch(() => null);
    if (!retweetBtn) {
      logger.warn("quoter", "Retweet button not found");
      return null;
    }
    await retweetBtn.click();
    await page.waitForTimeout(1500);

    // Click "Quote" / "Trích dẫn"
    const quoteBtn = await page
      .waitForSelector('[data-testid="quoteTweet"]', { timeout: 8000 })
      .catch(() => null);
    if (!quoteBtn) {
      logger.warn("quoter", "Quote button not found");
      return null;
    }
    await quoteBtn.click();
    await page.waitForTimeout(2000);

    // Nhập nội dung
    const textarea = await page
      .waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 })
      .catch(() => null);
    if (!textarea) {
      logger.warn("quoter", "Textarea not found");
      return null;
    }
    await textarea.click();
    await page.waitForTimeout(500);
    await textarea.type(content, { delay: 25 });
    await page.waitForTimeout(1000);

    // Upload media nếu có
    if (mediaPath && existsSync(mediaPath)) {
      logger.info("quoter", `Uploading media: ${mediaPath}`);
      const fileInput = await page.$('input[data-testid="fileInput"]');
      if (fileInput) {
        await fileInput.setInputFiles(mediaPath);
        await page
          .waitForSelector('[data-testid="attachments"]', { timeout: 30000 })
          .catch(() => logger.warn("quoter", "Media preview not detected, continuing anyway"));
        await page.waitForTimeout(2000);
      } else {
        logger.warn("quoter", "File input not found — skipping media");
      }
    }

    // Capture tweet ID từ API response
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

    // Submit
    const submitBtn = await page
      .waitForSelector('[data-testid="tweetButton"]', { timeout: 8000 })
      .catch(() => null);
    if (!submitBtn) {
      logger.warn("quoter", "Submit button not found");
      return null;
    }
    await submitBtn.click();
    await page.waitForTimeout(4000);

    if (!newTweetId) newTweetId = `browser_${Date.now()}`;
    logger.info("quoter", `✅ Quote tweet posted: ${newTweetId}`);
    return newTweetId;
  } catch (err: any) {
    logger.error("quoter", `postQuoteTweet error: ${err.message}`);
    return null;
  } finally {
    await page.close();
    // Xóa file media tạm
    if (mediaPath && existsSync(mediaPath)) {
      try { unlinkSync(mediaPath); } catch {}
    }
  }
}

// ── Playwright: post plain tweet (no quote) ───────────────────────────────────

export async function postPlainTweet(
  content: string,
  mediaPath?: string,
): Promise<string | null> {
  const ctx = await getContextForQuoter();
  const page = await ctx.newPage();

  try {
    logger.info("quoter", "Navigating to X home to post plain tweet...");
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);

    await dismissBanner(page);

    // Click vào compose box
    const textarea = await page
      .waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 })
      .catch(() => null);
    if (!textarea) {
      logger.warn("quoter", "Compose textarea not found");
      return null;
    }
    await textarea.click();
    await page.waitForTimeout(500);
    await textarea.type(content, { delay: 25 });
    await page.waitForTimeout(1000);

    // Upload media nếu có
    if (mediaPath && existsSync(mediaPath)) {
      logger.info("quoter", `Uploading media: ${mediaPath}`);
      const fileInput = await page.$('input[data-testid="fileInput"]');
      if (fileInput) {
        await fileInput.setInputFiles(mediaPath);
        await page
          .waitForSelector('[data-testid="attachments"]', { timeout: 30000 })
          .catch(() => logger.warn("quoter", "Media preview not detected, continuing anyway"));
        await page.waitForTimeout(2000);
      } else {
        logger.warn("quoter", "File input not found — skipping media");
      }
    }

    // Capture tweet ID từ API response
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

    // Submit
    const submitBtn = await page
      .waitForSelector('[data-testid="tweetButtonInline"]', { timeout: 8000 })
      .catch(() => null);
    if (!submitBtn) {
      logger.warn("quoter", "Submit button not found");
      return null;
    }
    await submitBtn.click();
    await page.waitForTimeout(4000);

    if (!newTweetId) newTweetId = `browser_${Date.now()}`;
    logger.info("quoter", `✅ Plain tweet posted: ${newTweetId}`);
    return newTweetId;
  } catch (err: any) {
    logger.error("quoter", `postPlainTweet error: ${err.message}`);
    return null;
  } finally {
    await page.close();
    if (mediaPath && existsSync(mediaPath)) {
      try { unlinkSync(mediaPath); } catch {}
    }
  }
}

// ── Dismiss cookie/consent banner ────────────────────────────────────────────

async function dismissBanner(page: Page): Promise<void> {
  const selectors = [
    '[data-testid="confirmationSheetConfirm"]',
    'div[role="button"]:has-text("Accept all cookies")',
    'div[role="button"]:has-text("Refuse non-essential cookies")',
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }
}

// ── Schedule job: đợi đến giờ hẹn rồi chạy ──────────────────────────────────

export async function scheduleQuoteJob(
  job: QuoteJob,
  onDone: (job: QuoteJob) => void,
): Promise<void> {
  const now = Date.now();
  const runAt = job.scheduledAt ? job.scheduledAt.getTime() : now;
  const delayMs = Math.max(0, runAt - now);

  if (delayMs > 0) {
    logger.info(
      "quoter",
      `Job ${job.id} scheduled in ${Math.round(delayMs / 60000)} min`,
    );
  }

  setTimeout(async () => {
    logger.info("quoter", `Running job ${job.id}...`);

    const loggedIn = await ensureLogin();
    if (!loggedIn) {
      updateJob(job.id, { status: "failed" });
      onDone({ ...job, status: "failed" });
      return;
    }

    // Có tweetId → quote tweet | Không có → đăng bài thường
    const postedId = job.tweetId
      ? await postQuoteTweet(job.tweetId, job.content, job.mediaPath)
      : await postPlainTweet(job.content, job.mediaPath);

    if (postedId) {
      updateJob(job.id, { status: "done", postedId });
      onDone({ ...job, status: "done", postedId });
    } else {
      updateJob(job.id, { status: "failed" });
      onDone({ ...job, status: "failed" });
    }
  }, delayMs);
}
