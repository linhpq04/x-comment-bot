import { TwitterApi } from "twitter-api-v2";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";

// ── OAuth 1.0a client (dùng để like tweet) ───────────────────────────────────

let userClient: TwitterApi | null = null;
let myUserId: string | null = null;

function getUserClient(): TwitterApi {
  if (!userClient) {
    if (!config.hasTwitter)
      throw new Error("Twitter OAuth credentials not configured");
    userClient = new TwitterApi({
      appKey: config.TWITTER_API_KEY,
      appSecret: config.TWITTER_API_SECRET,
      accessToken: config.TWITTER_ACCESS_TOKEN,
      accessSecret: config.TWITTER_ACCESS_SECRET,
    });
  }
  return userClient;
}

/** Lấy userId của tài khoản mình (cache lại, không gọi API mỗi lần) */
async function getMyUserId(): Promise<string> {
  if (myUserId) return myUserId;
  const client = getUserClient();
  const me = await client.v2.me();
  myUserId = me.data.id;
  return myUserId;
}

/** Like một tweet bằng OAuth 1.0a. Trả về true nếu thành công. */
export async function likeTweet(tweetId: string): Promise<boolean> {
  if (!config.hasTwitter) {
    logger.warn("watcher", "Twitter OAuth not configured — cannot like");
    return false;
  }
  try {
    const client = getUserClient();
    const userId = await getMyUserId();
    await client.v2.like(userId, tweetId);
    logger.info("watcher", `❤️ Liked tweet ${tweetId}`);
    return true;
  } catch (err: any) {
    // 403 = đã like rồi → coi như thành công
    if (err?.code === 403 || err?.data?.status === 403) {
      logger.info("watcher", `Tweet ${tweetId} already liked`);
      return true;
    }
    logger.error("watcher", `likeTweet error: ${err.message}`);
    return false;
  }
}

// ── Bearer client (dùng để đọc tweet) ────────────────────────────────────────

let bearerClient: TwitterApi | null = null;

function getBearerClient(): TwitterApi {
  if (!bearerClient) {
    if (!config.hasBearerToken)
      throw new Error("TWITTER_BEARER_TOKEN not configured");
    bearerClient = new TwitterApi(config.TWITTER_BEARER);
  }
  return bearerClient;
}

// ── Extract tweet ID từ URL ───────────────────────────────────────────────────

export function extractTweetId(url: string): string | null {
  const match = url.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  return match ? match[1] : null;
}

// ── Since-ID cache ────────────────────────────────────────────────────────────

const sinceIdCache = new Map<string, string>();

async function getSinceId(tweetId: string): Promise<string> {
  if (sinceIdCache.has(tweetId)) return sinceIdCache.get(tweetId)!;
  const key = `watcher_since_${tweetId}`;
  const row = await db.setting.findUnique({ where: { key } });
  const value = row?.value ?? "";
  sinceIdCache.set(tweetId, value);
  return value;
}

async function saveSinceId(tweetId: string, id: string): Promise<void> {
  sinceIdCache.set(tweetId, id);
  const key = `watcher_since_${tweetId}`;
  await db.setting.upsert({
    where: { key },
    create: { key, value: id },
    update: { value: id },
  });
}

// ── Fetch new commenters trên bài viết của mình ───────────────────────────────

export async function fetchNewCommenters(
  watchedPostId: string,
): Promise<
  Array<{ commentId: string; commenterHandle: string; commenterUserId: string }>
> {
  const client = getBearerClient();
  const sinceId = await getSinceId(watchedPostId);

  try {
    const query = `conversation_id:${watchedPostId} is:reply`;
    const searchParams: any = {
      max_results: 20,
      "tweet.fields": ["created_at", "author_id", "conversation_id"],
      expansions: ["author_id"],
      "user.fields": ["username"],
    };
    if (sinceId) searchParams.since_id = sinceId;

    const resp = await client.v2.search(query, searchParams);
    const replies = resp.data?.data ?? [];

    if (replies.length === 0) return [];

    // Cập nhật since_id → lần sau chỉ lấy comment mới hơn
    const newestId = replies.reduce(
      (max, t) => (BigInt(t.id) > BigInt(max) ? t.id : max),
      sinceId || replies[0].id,
    );
    if (newestId !== sinceId) await saveSinceId(watchedPostId, newestId);

    // Build user map từ expansions
    const users: Record<string, string> = {};
    for (const u of resp.data?.includes?.users ?? []) {
      users[u.id] = u.username;
    }

    return replies.map((r) => ({
      commentId: r.id,
      commenterHandle: users[r.author_id ?? ""] ?? "",
      commenterUserId: r.author_id ?? "",
    }));
  } catch (err: any) {
    logger.error("watcher", `fetchNewCommenters error: ${err.message}`);
    return [];
  }
}

// ── Lấy tweet mới nhất của một user ──────────────────────────────────────────

export async function getLatestTweetOfUser(
  userId: string,
): Promise<{ tweetId: string; text: string; handle: string } | null> {
  const client = getBearerClient();
  try {
    const resp = await client.v2.userTimeline(userId, {
      max_results: 5,
      "tweet.fields": ["created_at", "text"],
      exclude: ["retweets", "replies"],
    });
    const tweet = resp.data?.data?.[0];
    if (!tweet) return null;

    const userResp = await client.v2.user(userId, {
      "user.fields": ["username"],
    });
    const handle = userResp.data?.username ?? "";

    return { tweetId: tweet.id, text: tweet.text, handle };
  } catch (err: any) {
    logger.error("watcher", `getLatestTweetOfUser error: ${err.message}`);
    return null;
  }
}
