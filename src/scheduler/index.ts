import { logger } from "../utils/logger.js";
import { monitorAccounts } from "../monitor/twitter-monitor.js";
import {
  ensureLogin,
  checkQuota,
  commentOneTweet,
  randomDelay,
  runCommentCycle,
} from "../commenter/twitter-commenter.js";
import {
  getActiveSlots,
  getActiveSlotNames,
  getMonitorState,
} from "./timeslots.js";
import type { TimeSlot } from "./timeslots.js";
import { db } from "../db.js";
import { startWatcher, stopWatcher, triggerWatcherNow } from "../watcher/watcher-cycle.js";

// ── State ─────────────────────────────────────────────────────────────────────

let running = false;
let stopRequested = false;
let statusTimer: NodeJS.Timeout | null = null;
let monitorEnabled = true; // Có thể tắt/bật qua Telegram

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function crawlOnce(): Promise<number> {
  const slots = getActiveSlots();
  if (slots.length === 0) return 0;
  let total = 0;
  try {
    const n = await monitorAccounts("en");
    total += n;
  } catch (err: any) {
    logger.error("scheduler", `Crawl [en] error: ${err.message}`);
  }
  return total;
}

async function fetchPendingForSlot(slot: TimeSlot, limit: number) {
  return db.monitoredTweet.findMany({
    where: { status: "pending", account: { lang: slot.lang, isActive: true } },
    orderBy: { tweetCreatedAt: "desc" },
    take: limit,
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────
//
// Each loop iteration:
//   1. Check active hours -> sleep 60s if not active
//   2. Ensure login
//   3. Crawl new tweets
//   4a. No new tweets -> wait CRAWL_EMPTY_WAIT seconds then crawl again
//   4b. New tweets found -> comment each one, delay between each, then crawl again

async function mainLoop(): Promise<void> {
  logger.info("scheduler", "Main loop started");

  let lastPausedReason: string | null = null;

  while (!stopRequested) {
    // Step 1: monitor bị tắt thủ công?
    if (!monitorEnabled) {
      if (lastPausedReason !== "disabled") {
        logger.info("scheduler", "Monitor đã bị tắt thủ công — chờ lệnh /monitoron");
        lastPausedReason = "disabled";
      }
      await sleep(60_000);
      continue;
    }

    // Step 1b: active hours?
    const state = getMonitorState();
    if (!state.active) {
      if (lastPausedReason !== "outside_hours") {
        logger.info("scheduler", `Ngoài giờ hoạt động — tạm dừng (${getActiveSlotNames()})`);
        lastPausedReason = "outside_hours";
      }
      await sleep(60_000);
      continue;
    }

    // Đang hoạt động bình thường — reset trạng thái pause
    lastPausedReason = null;

    const activeSlots = getActiveSlots();

    // Step 2: login
    const loggedIn = await ensureLogin();
    if (!loggedIn) {
      logger.error("scheduler", "Cannot login — retrying in 30s");
      await sleep(30_000);
      continue;
    }

    // Step 3: crawl
    logger.info("scheduler", "Crawling for new tweets...");
    const newCount = await crawlOnce();
    logger.info("scheduler", newCount > 0
      ? `Crawl done: ${newCount} new tweets`
      : `No new tweets`
    );

    // Step 4a: no new tweets -> wait then crawl again
    if (newCount === 0) {
      const waitSec = parseInt(process.env.CRAWL_EMPTY_WAIT ?? "300");
      logger.info("scheduler", `No new tweets — crawling again in ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }

    // Step 4b: new tweets -> comment each one per slot
    for (const slot of activeSlots) {
      if (stopRequested) break;

      const quota = await checkQuota(slot);
      if (!quota.canComment) {
        const now = new Date();
        const msUntilNextHour = (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1000;
        const waitMs = Math.max(msUntilNextHour, 60_000);
        logger.info("scheduler",
          `${slot.label}: quota full this hour (${quota.doneThisHour}/${quota.hourlyLimit}/hour) — waiting ${Math.round(waitMs / 60000)} min`
        );
        await sleep(waitMs);
        continue;
      }

      const pending = await fetchPendingForSlot(slot, quota.canDo);
      if (pending.length === 0) {
        logger.info("scheduler", `${slot.label}: no pending tweets`);
        continue;
      }

      logger.info("scheduler",
        `${slot.label}: commenting on ${pending.length} tweets (quota remaining: ${quota.canDo}/hour)`
      );

      for (const tweet of pending) {
        if (stopRequested) break;

        await commentOneTweet(tweet.id, slot);

        // Delay after each comment (including last) — then crawl again immediately
        await randomDelay();

        // Check quota, stop slot if full
        const updatedQuota = await checkQuota(slot);
        if (!updatedQuota.canComment) {
          logger.info("scheduler",
            `${slot.label}: quota reached (${updatedQuota.doneThisHour}/${updatedQuota.hourlyLimit}/hour) — stopping slot`
          );
          break;
        }
      }
    }

    // All slots done -> crawl again immediately (no sleep)
    logger.info("scheduler", "Comment round complete — crawling again immediately");
  }

  logger.info("scheduler", "Main loop stopped");
  running = false;
}


// ── Hourly status log ─────────────────────────────────────────────────────────

async function statusCycle() {
  logger.info("scheduler", `Active slots: ${getActiveSlotNames()}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startScheduler() {
  if (running) {
    logger.warn("scheduler", "Scheduler already running");
    return;
  }

  logger.info("scheduler", "Starting scheduler...");
  logger.info("scheduler", "  Flow: crawl -> comment tweet 1 -> delay -> comment tweet 2 -> crawl again");
  logger.info("scheduler", "  Quota: 5-8 tweets/hour (resets each hour)");
  logger.info("scheduler", "  Active only during: US Peak (19-23)");

  running = true;
  stopRequested = false;

  setTimeout(() => {
    mainLoop().catch((err) => {
      logger.error("scheduler", `Main loop crash: ${err.message}`);
      running = false;
    });
  }, 15_000);

  // Start watcher independently — runs every 1 hour regardless of active hours
  startWatcher();

  statusTimer = setInterval(statusCycle, 60 * 60 * 1000);
  logger.info("scheduler", "Scheduler started");
}

export function stopScheduler() {
  stopRequested = true;
  stopWatcher();
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  logger.info("scheduler", "Scheduler stopping...");
}

export async function triggerMonitor() {
  logger.info("scheduler", "Manual monitor trigger");
  await crawlOnce();
}

export async function triggerComment() {
  logger.info("scheduler", "Manual comment trigger");
  await runCommentCycle();
}

export function enableMonitor(): void {
  monitorEnabled = true;
  logger.info("scheduler", "Monitor đã được BẬT");
}

export function disableMonitor(): void {
  monitorEnabled = false;
  logger.info("scheduler", "Monitor đã được TẮT");
}

export function isMonitorEnabled(): boolean {
  return monitorEnabled;
}
