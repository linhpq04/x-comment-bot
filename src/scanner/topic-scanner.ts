import TelegramBot from "node-telegram-bot-api";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";

// ── Regex lọc link X.com / twitter.com ───────────────────────────────────────

const X_LINK_REGEX =
  /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s<>"')\],]+/gi;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parseTimeToday(timeStr: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

export function extractXLinks(text: string): string[] {
  const regex = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s<>"')\],]+/gi;
  const matches = text.match(regex) ?? [];
  return [
    ...new Set(
      matches
        .map((url) => url.replace(/[.,;!?)]+$/, "").trim())
        .filter((url) => url.includes("/status/")),
    ),
  ];
}

// ── In-memory message cache ───────────────────────────────────────────────────

interface CachedMessage {
  date: Date;
  text: string;
  fromName: string;
}

const messageCache = new Map<string, CachedMessage[]>();

function cacheKey(chatId: number | string, threadId: number): string {
  return `${chatId}:${threadId}`;
}

export function cacheMessage(
  chatId: number,
  threadId: number,
  text: string,
  date: number,
  fromName: string,
): void {
  const key = cacheKey(chatId, threadId);
  if (!messageCache.has(key)) messageCache.set(key, []);
  const arr = messageCache.get(key)!;
  arr.push({ date: new Date(date * 1000), text, fromName });
  if (arr.length > 1000) arr.splice(0, arr.length - 1000);
}

export function pruneOldMessages(): void {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [key, arr] of messageCache.entries()) {
    const filtered = arr.filter((m) => m.date.getTime() > cutoff);
    if (filtered.length === 0) messageCache.delete(key);
    else messageCache.set(key, filtered);
  }
}

export function getCacheStats(): { key: string; count: number }[] {
  return [...messageCache.entries()].map(([key, arr]) => ({ key, count: arr.length }));
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function getAllGroups() {
  return db.telegramGroup.findMany({
    where: { isActive: true },
    include: {
      topics: { where: { isActive: true }, orderBy: { threadId: "asc" } },
    },
    orderBy: { name: "asc" },
  });
}

export async function addGroup(chatId: string, name: string) {
  return db.telegramGroup.upsert({
    where: { chatId },
    create: { chatId, name, isActive: true },
    update: { name, isActive: true },
  });
}

export async function addTopic(chatId: string, threadId: number, name: string) {
  const group = await db.telegramGroup.findUnique({ where: { chatId } });
  if (!group) throw new Error(`Group ${chatId} chưa đăng ký. Dùng /addgroup trước.`);
  return db.telegramTopic.upsert({
    where: { groupId_threadId: { groupId: group.id, threadId } },
    create: { groupId: group.id, threadId, name, isActive: true },
    update: { name, isActive: true },
  });
}

export async function removeTopic(chatId: string, threadId: number) {
  const group = await db.telegramGroup.findUnique({ where: { chatId } });
  if (!group) throw new Error(`Group ${chatId} không tìm thấy`);
  return db.telegramTopic.updateMany({
    where: { groupId: group.id, threadId },
    data: { isActive: false },
  });
}

export async function removeGroup(chatId: string) {
  return db.telegramGroup.update({
    where: { chatId },
    data: { isActive: false },
  });
}

// ── Core scan ─────────────────────────────────────────────────────────────────

export interface ScanResult {
  groupName: string;
  topicName: string;
  threadId: number;
  links: string[];
}

export async function scanTopics(
  chatId: string,
  threadIds: number[],
  fromTime: string,
  toTime: string,
): Promise<ScanResult[]> {
  const from = parseTimeToday(fromTime);
  const to = parseTimeToday(toTime);
  if (to <= from) to.setDate(to.getDate() + 1);

  const group = await db.telegramGroup.findUnique({
    where: { chatId },
    include: {
      topics: {
        where: {
          isActive: true,
          ...(threadIds.length > 0 ? { threadId: { in: threadIds } } : {}),
        },
      },
    },
  });

  if (!group) throw new Error(`Group ${chatId} chưa được đăng ký`);

  const results: ScanResult[] = [];

  for (const topic of group.topics) {
    const key = cacheKey(chatId, topic.threadId);
    const msgs = messageCache.get(key) ?? [];
    const linksSet = new Set<string>();

    for (const msg of msgs) {
      if (msg.date >= from && msg.date <= to) {
        extractXLinks(msg.text).forEach((l) => linksSet.add(l));
      }
    }

    if (linksSet.size > 0) {
      results.push({
        groupName: group.name,
        topicName: topic.name,
        threadId: topic.threadId,
        links: [...linksSet],
      });
    }
  }

  return results;
}

// ── Register listener ─────────────────────────────────────────────────────────

export function registerScannerListener(bot: TelegramBot): void {
  bot.on("message", (msg) => {
    const threadId = msg.message_thread_id;
    const chatId = msg.chat.id;
    if (!threadId) return;

    const text = msg.text ?? msg.caption ?? "";
    if (!text) return;

    // Chỉ cache tin nhắn có chứa link X — tiết kiệm RAM
    const hasLink = /https?:\/\/(?:x\.com|twitter\.com)/i.test(text);
    if (!hasLink) return;

    const fromName = msg.from?.username
      ? `@${msg.from.username}`
      : (msg.from?.first_name ?? "unknown");

    cacheMessage(chatId, threadId, text, msg.date, fromName);
    logger.info("scanner", `Cached link từ ${fromName} | chat ${chatId} | thread ${threadId}`);
  });

  setInterval(pruneOldMessages, 60 * 60 * 1000);
  logger.info("scanner", "Topic scanner listener đã đăng ký");
}
