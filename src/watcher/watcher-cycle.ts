import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import { generateComment } from "../generator/comment-generator.js";
import {
  fetchNewCommenters,
  getLatestTweetOfUser,
  likeTweet,
} from "./post-watcher.js";
import {
  ensureLogin,
  postCommentOnTweet,
} from "../commenter/twitter-commenter.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Check for new commenters every 1 hour */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Delay between each comment action: 3–10 minutes */
const DELAY_MIN_MS = 3 * 60 * 1000;
const DELAY_MAX_MS = 10 * 60 * 1000;

// ── State ─────────────────────────────────────────────────────────────────────

let watcherRunning = false;
let watcherStopRequested = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(): Promise<void> {
  const ms =
    DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
  logger.info(
    "watcher",
    `⏱ Waiting ${Math.round(ms / 60000)} min before next comment...`,
  );
  return sleep(ms);
}

// ── One check cycle ───────────────────────────────────────────────────────────
//
// Flow per cycle:
//   1. Fetch all active watched posts
//   2. For each post → get NEW commenters (skip already-reacted ones)
//   3. For each new commenter → get their latest tweet → AI comment → post
//   4. Delay 3–10 min between each comment
//   5. Sleep 1 hour, repeat

async function runOneCheckCycle(): Promise<void> {
  const posts = await db.watchedPost.findMany({ where: { isActive: true } });
  if (posts.length === 0) {
    logger.info("watcher", "No watched posts — skipping cycle");
    return;
  }

  // Collect all NEW commenters across all watched posts
  const toProcess: Array<{
    postId: string;
    postTweetId: string;
    commentId: string;
    commenterHandle: string;
    commenterUserId: string;
  }> = [];

  for (const post of posts) {
    logger.info(
      "watcher",
      `🔍 Checking new comments on post ${post.tweetId}...`,
    );

    let newCommenters: Array<{
      commentId: string;
      commenterHandle: string;
      commenterUserId: string;
    }>;

    try {
      newCommenters = await fetchNewCommenters(post.tweetId);
    } catch (err: any) {
      logger.error("watcher", `fetchNewCommenters error: ${err.message}`);
      continue;
    }

    if (newCommenters.length === 0) {
      logger.info("watcher", `No new comments on post ${post.tweetId}`);
      continue;
    }

    // DB check — filter out already-reacted comment IDs
    const commentIds = newCommenters.map((c) => c.commentId);
    const alreadyDone = new Set(
      (
        await db.watcherReaction.findMany({
          where: { commentId: { in: commentIds } },
          select: { commentId: true },
        })
      ).map((r: { commentId: string }) => r.commentId),
    );

    const fresh = newCommenters.filter((c) => !alreadyDone.has(c.commentId));

    logger.info(
      "watcher",
      `Post ${post.tweetId}: ${fresh.length} new commenter(s) ` +
        `(${newCommenters.length - fresh.length} already processed)`,
    );

    for (const c of fresh) {
      toProcess.push({ postId: post.id, postTweetId: post.tweetId, ...c });
    }
  }

  if (toProcess.length === 0) {
    logger.info("watcher", "No new commenters to react to — sleeping 1 hour");
    return;
  }

  logger.info(
    "watcher",
    `▶ Found ${toProcess.length} new commenter(s) — starting comment run`,
  );

  // Login before comment run
  const loggedIn = await ensureLogin();
  if (!loggedIn) {
    logger.error("watcher", "Cannot login — skipping comment run");
    return;
  }

  // Comment on each person's latest tweet, delay 3–10 min between each
  for (let i = 0; i < toProcess.length; i++) {
    if (watcherStopRequested) break;

    const commenter = toProcess[i];
    logger.info(
      "watcher",
      `[${i + 1}/${toProcess.length}] Processing @${commenter.commenterHandle || commenter.commenterUserId}`,
    );

    // No handle → skip
    if (!commenter.commenterHandle) {
      logger.warn(
        "watcher",
        `No handle for userId ${commenter.commenterUserId}, skipping`,
      );
      await db.watcherReaction.create({
        data: {
          watchedPostId: commenter.postId,
          commentId: commenter.commentId,
          commenterHandle: commenter.commenterUserId,
          targetTweetId: "",
          targetTweetText: "",
          status: "skipped",
          skipReason: "no_handle",
        },
      });
      continue;
    }

    // Get their latest tweet
    const latestTweet = await getLatestTweetOfUser(commenter.commenterUserId);
    if (!latestTweet) {
      logger.warn(
        "watcher",
        `@${commenter.commenterHandle} has no recent tweet, skipping`,
      );
      await db.watcherReaction.create({
        data: {
          watchedPostId: commenter.postId,
          commentId: commenter.commentId,
          commenterHandle: commenter.commenterHandle,
          targetTweetId: "",
          targetTweetText: "",
          status: "skipped",
          skipReason: "no_recent_tweet",
        },
      });
      continue;
    }

    // AI generate comment from their tweet content
    const commentText = await generateComment(
      latestTweet.text,
      latestTweet.handle,
      "en",
    );
    if (!commentText) {
      logger.warn("watcher", `AI failed for @${latestTweet.handle}, skipping`);
      continue;
    }

    // Post comment on their latest tweet via Playwright
    logger.info(
      "watcher",
      `💬 Commenting on @${latestTweet.handle}'s tweet ${latestTweet.tweetId}...`,
    );
    const postedId = await postCommentOnTweet(latestTweet.tweetId, commentText);

    // Like their tweet (dùng API, không cần Playwright)
    const liked = await likeTweet(latestTweet.tweetId);

    // Save result
    await db.watcherReaction.create({
      data: {
        watchedPostId: commenter.postId,
        commentId: commenter.commentId,
        commenterHandle: commenter.commenterHandle,
        targetTweetId: latestTweet.tweetId,
        targetTweetText: latestTweet.text.slice(0, 500),
        commentText,
        postedCommentId: postedId ?? "",
        liked,
        status: postedId ? "commented" : "failed",
      },
    });

    if (postedId) {
      logger.info(
        "watcher",
        `✅ Done @${latestTweet.handle}: "${commentText.slice(0, 60)}..."`,
      );
    } else {
      logger.warn("watcher", `❌ Failed to comment on @${latestTweet.handle}`);
    }

    // Delay 3–10 min before NEXT comment (skip after last one)
    const isLast = i === toProcess.length - 1;
    if (!isLast && !watcherStopRequested) {
      await randomDelay();
    }
  }

  logger.info(
    "watcher",
    `✅ Cycle done — processed ${toProcess.length} commenter(s)`,
  );
}

// ── Independent watcher loop ──────────────────────────────────────────────────
//
//   [check] → [comment 1] → delay 3-10min → [comment 2] → delay → ... → [all done]
//   → sleep remaining time until 1 hour is up → [check again]

async function watcherLoop(): Promise<void> {
  logger.info("watcher", "Watcher loop started — checks every 1 hour");

  while (!watcherStopRequested) {
    const cycleStart = Date.now();

    try {
      await runOneCheckCycle();
    } catch (err: any) {
      logger.error("watcher", `Cycle crashed: ${err.message}`);
    }

    if (watcherStopRequested) break;

    // Wait out the remainder of the 1-hour window
    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(0, CHECK_INTERVAL_MS - elapsed);

    logger.info(
      "watcher",
      `💤 Next check in ${Math.round(waitMs / 60000)} min`,
    );
    await sleep(waitMs);
  }

  logger.info("watcher", "Watcher loop stopped");
  watcherRunning = false;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startWatcher(): void {
  if (watcherRunning) {
    logger.warn("watcher", "Watcher already running");
    return;
  }
  watcherRunning = true;
  watcherStopRequested = false;

  watcherLoop().catch((err) => {
    logger.error("watcher", `Watcher loop crash: ${err.message}`);
    watcherRunning = false;
  });

  logger.info("watcher", "Watcher started");
}

export function stopWatcher(): void {
  watcherStopRequested = true;
  logger.info("watcher", "Watcher stopping...");
}

/** Manual trigger from Telegram /watchernow */
export async function triggerWatcherNow(): Promise<void> {
  logger.info("watcher", "Manual watcher trigger");
  await runOneCheckCycle();
}
