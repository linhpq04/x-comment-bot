import { TwitterApi } from "twitter-api-v2";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { generateComment } from "../generator/comment-generator.js";
import {
  ensureLogin,
  postCommentOnTweet,
} from "../commenter/twitter-commenter.js";
import { likeTweet, extractTweetId } from "./post-watcher.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const DELAY_MIN_MS = 30 * 1000; // 30 giây  — delay sau khi comment thành công
const DELAY_MAX_MS = 2.25 * 60 * 1000; // 2 phút 25  — delay sau khi comment thành công
const RETRY_DELAY_MIN_MS = 15 * 1000; // 15 giây — delay giữa các lần retry khi lỗi
const RETRY_DELAY_MAX_MS = 60 * 1000; // 60 giây — delay giữa các lần retry khi lỗi
const MAX_RETRIES = 3; // số lần thử tối đa khi comment lỗi

// ── State — chỉ cho phép 1 urgent job chạy tại 1 thời điểm ──────────────────

let isRunning = false;

// ── Result tracking ───────────────────────────────────────────────────────────

type ItemStatus = "success" | "failed" | "skipped";

interface ItemResult {
  label: string; // URL hoặc @handle
  status: ItemStatus;
  reason?: string; // lý do thất bại/skip
  commentUrl?: string; // link comment nếu thành công
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Delay 3–8 phút sau khi comment thành công */
function randomDelay(): Promise<void> {
  const ms =
    DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
  logger.info(
    "urgent",
    `⏱ Delay ${Math.round(ms / 60000)} min trước khi tiếp tục...`,
  );
  return sleep(ms);
}

/** Delay 15–60 giây giữa các lần retry khi comment lỗi */
function retryDelay(): Promise<void> {
  const ms =
    RETRY_DELAY_MIN_MS +
    Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS));
  logger.info("urgent", `🔄 Retry sau ${Math.round(ms / 1000)}s...`);
  return sleep(ms);
}

/** Format thông báo tổng kết cuối job */
function buildSummary(
  results: ItemResult[],
  jobType: "urls" | "accounts",
): string {
  const failed = results.filter(
    (r) => r.status === "failed" || r.status === "skipped",
  );
  const succeeded = results.filter((r) => r.status === "success");

  let text = `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📊 *KẾT QUẢ CUỐI CÙNG*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  text += `✅ Thành công: *${succeeded.length}/${results.length}*\n`;
  text += `❌ Thất bại / Bỏ qua: *${failed.length}/${results.length}*\n\n`;

  if (failed.length === 0) {
    text += `🎉 Tất cả đều thành công!`;
    return text;
  }

  text += `*Danh sách thất bại:*\n`;
  for (const item of failed) {
    const icon = item.status === "failed" ? "❌" : "⏭";
    const label = jobType === "accounts" ? `@${item.label}` : item.label;
    text += `${icon} ${label}\n`;
    if (item.reason) {
      text += `   └ _${item.reason}_\n`;
    }
  }

  return text;
}

// ── Bearer client để resolve handle → userId → latest tweet ──────────────────

let bearerClient: TwitterApi | null = null;

function getBearerClient(): TwitterApi {
  if (!bearerClient) {
    if (!config.hasBearerToken)
      throw new Error("TWITTER_BEARER_TOKEN not configured");
    bearerClient = new TwitterApi(config.TWITTER_BEARER);
  }
  return bearerClient;
}

async function getLatestTweetByHandle(
  handle: string,
): Promise<{ tweetId: string; text: string } | null> {
  const client = getBearerClient();
  try {
    const cleanHandle = handle.replace("@", "");
    const user = await client.v2.userByUsername(cleanHandle);
    if (!user.data) {
      logger.warn("urgent", `@${cleanHandle} không tồn tại`);
      return null;
    }
    const timeline = await client.v2.userTimeline(user.data.id, {
      max_results: 5,
      "tweet.fields": ["created_at", "text"],
      exclude: ["retweets", "replies"],
    });
    const tweet = timeline.data?.data?.[0];
    if (!tweet) {
      logger.warn("urgent", `@${cleanHandle} không có tweet nào`);
      return null;
    }
    return { tweetId: tweet.id, text: tweet.text };
  } catch (err: any) {
    logger.error("urgent", `getLatestTweetByHandle @${handle}: ${err.message}`);
    return null;
  }
}

// ── Parse input: mỗi dòng hoặc cách nhau bằng dấu phẩy ─────────────────────

export function parseLines(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Job 1: Comment theo list URL tweet ───────────────────────────────────────

export async function urgentCommentUrls(
  rawInput: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  if (isRunning) {
    onProgress("⚠️ Đang có job khác chạy, vui lòng đợi xong rồi thử lại");
    return;
  }

  const urls = parseLines(rawInput);
  if (urls.length === 0) {
    onProgress("❌ Không tìm thấy URL nào hợp lệ");
    return;
  }

  // Validate & extract tweet IDs
  const items: Array<{ url: string; tweetId: string }> = [];
  for (const url of urls) {
    const tweetId = extractTweetId(url);
    if (!tweetId) {
      onProgress(`⚠️ Bỏ qua URL không hợp lệ: ${url}`);
      continue;
    }
    items.push({ url, tweetId });
  }

  if (items.length === 0) {
    onProgress("❌ Không có URL hợp lệ nào");
    return;
  }

  isRunning = true;
  const results: ItemResult[] = [];
  onProgress(
    `▶ Bắt đầu comment ${items.length} URL...\n(Delay 30 giây đến 2 phút sau thành công | retry tối đa 3 lần nếu lỗi)`,
  );

  try {
    const loggedIn = await ensureLogin();
    if (!loggedIn) {
      onProgress("❌ Không thể login Twitter — hủy job");
      // Đánh dấu tất cả là failed
      for (const { url } of items) {
        results.push({
          label: url,
          status: "failed",
          reason: "Không thể login Twitter",
        });
      }
      onProgress(buildSummary(results, "urls"));
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const { url, tweetId } = items[i];
      onProgress(`[${i + 1}/${items.length}] Đang xử lý: ${url}`);

      // Lấy nội dung tweet
      let tweetText = "";
      let authorHandle = "";
      let fetchError = "";
      try {
        const client = getBearerClient();
        const resp = await client.v2.singleTweet(tweetId, {
          "tweet.fields": ["text", "author_id"],
          expansions: ["author_id"],
          "user.fields": ["username"],
        });
        tweetText = resp.data?.text ?? "";
        authorHandle = resp.includes?.users?.[0]?.username ?? "";
      } catch (err: any) {
        fetchError = err.message ?? "Không lấy được nội dung tweet";
        logger.warn(
          "urgent",
          `Không lấy được nội dung tweet ${tweetId}: ${err.message}`,
        );
      }

      // Generate AI comment
      const commentText = await generateComment(tweetText, authorHandle, "en");
      if (!commentText) {
        const reason = "AI không generate được comment";
        onProgress(`❌ [${i + 1}/${items.length}] ${reason}`);
        results.push({ label: url, status: "failed", reason });
        if (i < items.length - 1) await randomDelay();
        continue;
      }

      // Post comment — retry tối đa MAX_RETRIES lần, delay 15–60s giữa mỗi lần
      let postedId: string | null = null;
      let lastError = fetchError;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        postedId = await postCommentOnTweet(tweetId, commentText);
        if (postedId) break;

        lastError =
          "postCommentOnTweet trả về null (có thể bị rate limit hoặc tweet bị xóa)";
        if (attempt < MAX_RETRIES) {
          onProgress(
            `⚠️ [${i + 1}/${items.length}] Lần ${attempt}/${MAX_RETRIES} thất bại, thử lại sau...`,
          );
          await retryDelay();
        }
      }

      // Like tweet (chỉ khi thành công)
      if (postedId) {
        await likeTweet(tweetId);
        const commentUrl = `https://x.com/i/web/status/${postedId}`;
        onProgress(
          `✅ [${i + 1}/${items.length}] Done!\n` +
            `💬 "${commentText.slice(0, 80)}..."\n` +
            `🔗 ${commentUrl}`,
        );
        results.push({ label: url, status: "success", commentUrl });
        if (i < items.length - 1) await randomDelay();
      } else {
        const reason = lastError || "Thất bại sau 3 lần thử";
        onProgress(
          `❌ [${i + 1}/${items.length}] Comment thất bại sau ${MAX_RETRIES} lần thử, chuyển sang URL tiếp theo`,
        );
        results.push({ label: url, status: "failed", reason });
        // Không delay — chuyển sang cái tiếp theo luôn
      }
    }
  } finally {
    isRunning = false;
    // Gửi tổng kết sau khi hoàn thành (kể cả khi crash)
    onProgress(buildSummary(results, "urls"));
  }
}

// ── Job 2: Comment theo list @handle ─────────────────────────────────────────

export async function urgentCommentAccounts(
  rawInput: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  if (isRunning) {
    onProgress("⚠️ Đang có job khác chạy, vui lòng đợi xong rồi thử lại");
    return;
  }

  const handles = parseLines(rawInput).map((h) => h.replace("@", ""));
  if (handles.length === 0) {
    onProgress("❌ Không tìm thấy @handle nào");
    return;
  }

  isRunning = true;
  const results: ItemResult[] = [];
  onProgress(
    `▶ Bắt đầu comment ${handles.length} tài khoản...\n(Delay 3-8 phút sau thành công | retry tối đa 3 lần nếu lỗi)`,
  );

  try {
    const loggedIn = await ensureLogin();
    if (!loggedIn) {
      onProgress("❌ Không thể login Twitter — hủy job");
      for (const handle of handles) {
        results.push({
          label: handle,
          status: "failed",
          reason: "Không thể login Twitter",
        });
      }
      onProgress(buildSummary(results, "accounts"));
      return;
    }

    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      onProgress(`[${i + 1}/${handles.length}] Đang xử lý @${handle}...`);

      // Lấy tweet mới nhất
      const latest = await getLatestTweetByHandle(handle);
      if (!latest) {
        const reason =
          "Không tìm thấy tweet (account không tồn tại hoặc chưa có tweet)";
        onProgress(
          `⚠️ [${i + 1}/${handles.length}] @${handle} không có tweet mới, bỏ qua`,
        );
        results.push({ label: handle, status: "skipped", reason });
        if (i < handles.length - 1) await randomDelay();
        continue;
      }

      // Generate AI comment
      const commentText = await generateComment(latest.text, handle, "en");
      if (!commentText) {
        const reason = "AI không generate được comment";
        onProgress(`❌ [${i + 1}/${handles.length}] ${reason} cho @${handle}`);
        results.push({ label: handle, status: "failed", reason });
        if (i < handles.length - 1) await randomDelay();
        continue;
      }

      // Post comment — retry tối đa MAX_RETRIES lần, delay 15–60s giữa mỗi lần
      let postedId: string | null = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        postedId = await postCommentOnTweet(latest.tweetId, commentText);
        if (postedId) break;

        if (attempt < MAX_RETRIES) {
          onProgress(
            `⚠️ [${i + 1}/${handles.length}] @${handle} lần ${attempt}/${MAX_RETRIES} thất bại, thử lại sau...`,
          );
          await retryDelay();
        }
      }

      // Like tweet (chỉ khi thành công)
      if (postedId) {
        await likeTweet(latest.tweetId);
        const commentUrl = `https://x.com/i/web/status/${postedId}`;
        onProgress(
          `✅ [${i + 1}/${handles.length}] @${handle} done!\n` +
            `💬 "${commentText.slice(0, 80)}..."\n` +
            `🔗 ${commentUrl}`,
        );
        results.push({ label: handle, status: "success", commentUrl });
        if (i < handles.length - 1) await randomDelay();
      } else {
        const reason =
          "postCommentOnTweet thất bại sau 3 lần thử (có thể bị rate limit hoặc tweet bị xóa)";
        onProgress(
          `❌ [${i + 1}/${handles.length}] Comment @${handle} thất bại sau ${MAX_RETRIES} lần thử, chuyển sang tài khoản tiếp theo`,
        );
        results.push({ label: handle, status: "failed", reason });
        // Không delay — chuyển sang cái tiếp theo luôn
      }
    }
  } finally {
    isRunning = false;
    onProgress(buildSummary(results, "accounts"));
  }
}

export function isUrgentRunning(): boolean {
  return isRunning;
}
