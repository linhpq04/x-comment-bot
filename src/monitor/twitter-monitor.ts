import { TwitterApi } from "twitter-api-v2";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import type { Lang } from "../scheduler/timeslots.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Chỉ comment tweet trong vòng N giờ qua — tweet cũ hơn bỏ qua */
const MAX_TWEET_AGE_HOURS = 6;

/** Bỏ qua tweet ngắn hơn N ký tự */
const MIN_TWEET_LENGTH = 15;

/** Số account crawl song song cùng lúc */
const PARALLEL_LIMIT = 5;

// ── In-memory cache since_id & userId — tránh query DB mỗi cycle ────────────

const sinceIdCache = new Map<string, string>(); // handle → since_id
const userIdCache = new Map<string, string>(); // handle → userId

// ── Twitter client singleton ─────────────────────────────────────────────────

let bearerClient: TwitterApi | null = null;

function getBearerClient(): TwitterApi {
  if (!bearerClient) {
    if (!config.hasBearerToken) {
      throw new Error("TWITTER_BEARER_TOKEN not configured");
    }
    bearerClient = new TwitterApi(config.TWITTER_BEARER);
  }
  return bearerClient;
}

// ── Setting helpers (với in-memory cache) ────────────────────────────────────

async function getSinceId(handle: string): Promise<string> {
  if (sinceIdCache.has(handle)) return sinceIdCache.get(handle)!;

  const key = `monitor_since_${handle}`;
  const row = await db.setting.findUnique({ where: { key } });
  const value = row?.value ?? "";
  sinceIdCache.set(handle, value);
  return value;
}

async function saveSinceId(handle: string, id: string): Promise<void> {
  sinceIdCache.set(handle, id);
  const key = `monitor_since_${handle}`;
  await db.setting.upsert({
    where: { key },
    create: { key, value: id },
    update: { value: id },
  });
}

async function getUserId(handle: string): Promise<string> {
  if (userIdCache.has(handle)) return userIdCache.get(handle)!;

  const acc = await db.targetAccount.findUnique({
    where: { handle },
    select: { userId: true },
  });
  const cached = acc?.userId ?? "";
  if (cached) {
    userIdCache.set(handle, cached);
    return cached;
  }
  return "";
}

async function saveUserId(
  handle: string,
  id: string,
  accountId: string,
): Promise<void> {
  userIdCache.set(handle, id);
  await db.targetAccount.update({
    where: { id: accountId },
    data: { userId: id },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Lọc tweet không phù hợp để comment */
function shouldSkipTweet(text: string, createdAt?: string): boolean {
  // Quá ngắn
  if (text.trim().length < MIN_TWEET_LENGTH) return true;

  // Quá cũ
  if (createdAt) {
    const age = Date.now() - new Date(createdAt).getTime();
    if (age > MAX_TWEET_AGE_HOURS * 3_600_000) return true;
  }

  // Chỉ toàn URL, không có nội dung
  const stripped = text.replace(/https?:\/\/\S+/gi, "").trim();
  if (stripped.length < MIN_TWEET_LENGTH) return true;

  return false;
}

// ── Main export ──────────────────────────────────────────────────────────────

/** Crawl tweet mới từ tất cả account active theo lang */
export async function monitorAccounts(lang: Lang): Promise<number> {
  const accounts = await db.targetAccount.findMany({
    where: { lang, isActive: true },
    orderBy: { priority: "desc" },
  });

  if (accounts.length === 0) return 0;

  const client = getBearerClient();
  let totalNew = 0;
  let rateLimited = false;

  // Chạy PARALLEL_LIMIT account cùng lúc thay vì tuần tự
  const batches = chunk(accounts, PARALLEL_LIMIT);

  for (const batch of batches) {
    if (rateLimited) break;

    const results = await Promise.allSettled(
      batch.map((acc) =>
        monitorOne(
          client,
          acc as { id: string; handle: string; userId: string },
        ),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        totalNew += result.value;
      } else {
        const err = result.reason as any;
        if (err?.code === 429) {
          rateLimited = true;
          const resetAt = err?.rateLimit?.reset;
          const waitMs = resetAt
            ? Math.max(0, resetAt * 1000 - Date.now()) + 1000
            : 60_000;
          logger.warn(
            "monitor",
            `Rate limited! Chờ ${Math.round(waitMs / 1000)}s rồi tiếp...`,
          );
          await sleep(waitMs);
        } else {
          logger.error("monitor", `Monitor error: ${err?.message}`);
        }
      }
    }
  }

  if (totalNew > 0) {
    logger.info(
      "monitor",
      `[${lang.toUpperCase()}] Phát hiện ${totalNew} tweet mới`,
    );
  }

  return totalNew;
}

// ── Single account crawl ─────────────────────────────────────────────────────

async function monitorOne(
  client: TwitterApi,
  account: { id: string; handle: string; userId: string },
): Promise<number> {
  const handle = account.handle.replace("@", "");

  // 1. Resolve userId (cache → DB → API)
  let userId = await getUserId(handle);

  if (!userId) {
    try {
      const user = await client.v2.userByUsername(handle);
      if (!user.data) {
        logger.warn("monitor", `@${handle} không tồn tại, tắt theo dõi`);
        await db.targetAccount.update({
          where: { id: account.id },
          data: { isActive: false },
        });
        return 0;
      }
      userId = user.data.id;
      await saveUserId(handle, userId, account.id);
    } catch (err: any) {
      logger.error("monitor", `Không tìm được @${handle}: ${err.message}`);
      return 0;
    }
  }

  // 2. Lấy since_id từ cache (tránh query DB mỗi cycle)
  const sinceId = await getSinceId(handle);

  // 3. Lần đầu: chỉ lưu mốc, không comment tweet cũ
  if (!sinceId) {
    try {
      const first = await client.v2.userTimeline(userId, {
        max_results: 5,
        "tweet.fields": ["created_at"],
        exclude: ["retweets", "replies"],
      });
      const newest = first.data?.data?.[0];
      if (newest) {
        await saveSinceId(handle, newest.id);
        logger.info("monitor", `@${handle}: khởi tạo mốc #${newest.id}`);
      }
    } catch (err: any) {
      logger.error("monitor", `@${handle} init error: ${err.message}`);
    }
    return 0;
  }

  // 4. Fetch tweet mới hơn since_id, kèm public_metrics để sort engagement
  let rawTweets: any[] = [];
  try {
    const resp = await client.v2.userTimeline(userId, {
      max_results: 10,
      "tweet.fields": ["created_at", "text", "public_metrics"],
      exclude: ["retweets", "replies"],
      since_id: sinceId,
    });
    rawTweets = resp.data?.data ?? [];
  } catch (err: any) {
    if (err.code === 429) throw err; // re-throw để xử lý ở tầng trên
    logger.error("monitor", `@${handle} fetch error: ${err.message}`);
    return 0;
  }

  if (rawTweets.length === 0) return 0;

  // 5. Lọc tweet không phù hợp (cũ, ngắn, chỉ URL)
  const validTweets = rawTweets.filter(
    (t) => !shouldSkipTweet(t.text ?? "", t.created_at),
  );

  // Dù không có tweet valid, vẫn cập nhật since_id để không crawl lại
  const newestId = rawTweets.reduce(
    (max, t) => (BigInt(t.id) > BigInt(max) ? t.id : max),
    sinceId,
  );
  if (newestId !== sinceId) await saveSinceId(handle, newestId);

  if (validTweets.length === 0) return 0;

  // 6. Sort theo engagement — ưu tiên tweet đang hot (nhiều like/reply)
  validTweets.sort((a, b) => {
    const scoreA =
      (a.public_metrics?.like_count ?? 0) +
      (a.public_metrics?.reply_count ?? 0);
    const scoreB =
      (b.public_metrics?.like_count ?? 0) +
      (b.public_metrics?.reply_count ?? 0);
    return scoreB - scoreA;
  });

  // 7. Batch check exists — 1 query thay vì N queries
  const tweetIds = validTweets.map((t) => t.id);
  const existingSet = new Set(
    (
      await db.monitoredTweet.findMany({
        where: { tweetId: { in: tweetIds } },
        select: { tweetId: true },
      })
    ).map((r: { tweetId: string }) => r.tweetId),
  );

  const toInsert = validTweets.filter((t) => !existingSet.has(t.id));
  if (toInsert.length === 0) return 0;

  // 8. Insert từng tweet (SQLite không support createMany + skipDuplicates)
  let newCount = 0;
  for (const tweet of toInsert) {
    try {
      await db.monitoredTweet.create({
        data: {
          tweetId: tweet.id,
          accountId: account.id,
          authorHandle: handle,
          text: tweet.text,
          tweetCreatedAt: tweet.created_at
            ? new Date(tweet.created_at)
            : new Date(),
          status: "pending",
        },
      });
      newCount++;
    } catch (err: any) {
      // P2002 = unique constraint violation (race condition) — bình thường
      if (err.code !== "P2002") {
        logger.error("monitor", `DB insert error @${handle}: ${err.message}`);
      }
    }
  }

  if (newCount > 0) {
    logger.info(
      "monitor",
      `@${handle}: +${newCount} tweet mới (bỏ qua ${validTweets.length - newCount} trùng)`,
    );
  }

  return newCount;
}

// ── Cache invalidation (gọi khi xóa/thêm account qua Telegram bot) ───────────

export function clearMonitorCache(handle?: string): void {
  if (handle) {
    sinceIdCache.delete(handle);
    userIdCache.delete(handle);
  } else {
    sinceIdCache.clear();
    userIdCache.clear();
  }
}
