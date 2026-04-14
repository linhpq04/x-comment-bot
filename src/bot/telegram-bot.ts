import TelegramBot from "node-telegram-bot-api";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";
import {
  getActiveSlotNames,
  formatTimeSlotsTable,
} from "../scheduler/timeslots.js";
import { getCommentStats } from "../commenter/twitter-commenter.js";
import {
  triggerMonitor,
  triggerComment,
  enableMonitor,
  disableMonitor,
  isMonitorEnabled,
} from "../scheduler/index.js";
import { extractTweetId } from "../watcher/post-watcher.js";
import { triggerWatcherNow } from "../watcher/watcher-cycle.js";
import {
  urgentCommentUrls,
  urgentCommentAccounts,
  isUrgentRunning,
} from "../watcher/urgent-commenter.js";
import { registerQuoteHandlers } from "./quote-handler.js";
import {
  registerScannerListener,
  scanTopics,
  getCacheStats,
  getAllGroups,
  addGroup,
  addTopic,
  removeTopic,
  removeGroup,
} from "../scanner/topic-scanner.js";

let bot: TelegramBot;

export function getBot(): TelegramBot {
  return bot;
}

function isAdmin(userId: number): boolean {
  if (config.ADMIN_IDS.length === 0) return true;
  return config.ADMIN_IDS.includes(userId);
}

async function safeSend(chatId: number, text: string, markdown = false) {
  try {
    if (markdown) {
      await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } else {
      await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
    }
  } catch (err: any) {
    if (err.message?.includes("parse entities")) {
      const plain = text.replace(/[*_`[\]]/g, "");
      await bot.sendMessage(chatId, plain, { disable_web_page_preview: true });
    } else {
      logger.error("bot", `Send failed: ${err.message}`);
    }
  }
}

export function startBot(): TelegramBot {
  bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

  bot.on("polling_error", (err: any) => {
    logger.error("bot", `Polling error: ${err.code || err.message}`);
  });

  logger.info("bot", "Telegram bot started");

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    await safeSend(
      msg.chat.id,
      `🤖 *Comment Bot* is ready!\n\n` +
        `*📋 Account management:*\n` +
        `➕ /addaccount <@handle> [name] — Add an English account\n` +
        `➖ /removeaccount <@handle> — Remove account\n` +
        `📋 /accounts — List accounts\n\n` +
        `*👁 Watch My Post:*\n` +
        `🔗 /watchpost <url> [label] — Watch a post of yours\n` +
        `🗑 /unwatchpost <url> — Stop watching a post\n` +
        `📋 /watchedposts — List watched posts\n` +
        `📜 /watcherhistory — Recent auto-reactions\n` +
        `🔄 /watchernow — Run watcher cycle now\n\n` +
        `*⚡ Urgent Comment:*\n` +
        `🔗 /commenturls — Comment ngay theo list URL\n` +
        `👤 /commentaccounts — Comment bài mới nhất của list account\n\n` +
        `*✍️ Quote Tweet:*\n` +
        `🔁 /quotetweet <url> [HH:MM] — Trích dẫn tweet (hẹn giờ hoặc đăng ngay)\n\n` +
        `*📊 Stats & controls:*\n` +
        `📈 /status — Current status\n` +
        `📜 /history — Recent comment history\n` +
        `⏰ /timeslots — View time slots\n` +
        `🔄 /monitornow — Monitor tweets now\n` +
        `💬 /commentnow — Comment now (if in active hours)\n` +
        `▶️ /monitoron — Bật monitor\n` +
        `⏸ /monitoroff — Tắt monitor\n` +
        `📝 /logs — View recent logs\n\n` +
        `*📡 Topic Scanner:*\n` +
        `➕ /addgroup <chat_id> <tên> — Đăng ký group\n` +
        `➕ /addtopic <chat_id> <thread_id> <tên> — Thêm topic\n` +
        `📋 /listtopics — Xem danh sách group & topic\n` +
        `🔎 /detecttopic — Gửi trong topic để lấy thread_id\n` +
        `🔍 /scantopics <chat_id> HH:MM HH:MM [ids...] — Quét link X`,
      true,
    );
  });

  // ── /addaccount @handle [name] — add English account ─────────────────────
  bot.onText(/\/addaccount (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const args = match![1].trim().split(/\s+/);
    const handle = args[0].replace("@", "").toLowerCase();
    const name = args.slice(1).join(" ") || handle;

    try {
      await db.targetAccount.upsert({
        where: { handle },
        create: { handle, lang: "en", name, isActive: true },
        update: { lang: "en", name, isActive: true },
      });
      await safeSend(
        msg.chat.id,
        `✅ Added @${handle} (🇺🇸 EN) to the watch list`,
      );
      logger.info("bot", `Admin added EN account: @${handle}`);
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // ── /removeaccount @handle ────────────────────────────────────────────────
  bot.onText(/\/removeaccount (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const handle = match![1].trim().replace("@", "").toLowerCase();

    try {
      const acc = await db.targetAccount.findUnique({ where: { handle } });
      if (!acc) {
        await safeSend(msg.chat.id, `⚠️ @${handle} not found`);
        return;
      }
      await db.targetAccount.update({
        where: { handle },
        data: { isActive: false },
      });
      await safeSend(msg.chat.id, `✅ Stopped watching @${handle}`);
      logger.info("bot", `Admin removed account: @${handle}`);
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // ── /accounts — list ──────────────────────────────────────────────────────
  bot.onText(/\/accounts/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;

    const all = await db.targetAccount.findMany({
      orderBy: [{ priority: "desc" }, { handle: "asc" }],
    });

    if (all.length === 0) {
      await safeSend(
        msg.chat.id,
        "📭 No accounts yet.\n\nUse /addaccount @handle to add an account",
      );
      return;
    }

    let text = `📋 *Watch list (${all.length} accounts)*\n\n`;
    text += `🇺🇸 *English (${all.length}):*\n`;
    for (const a of all) {
      const status = a.isActive ? "✅" : "⏸";
      text += `  ${status} @${a.handle}${a.name && a.name !== a.handle ? ` (${a.name})` : ""}\n`;
    }

    await safeSend(msg.chat.id, text, true);
  });

  // ── /status ───────────────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;

    const [stats, pendingCount, totalAccounts] = await Promise.all([
      getCommentStats(),
      db.monitoredTweet.count({ where: { status: "pending" } }),
      db.targetAccount.count({ where: { isActive: true } }),
    ]);

    const activeSlot = getActiveSlotNames();

    let text = `📊 *Comment Bot Status*\n\n`;
    text += `⏰ Current time slot: ${activeSlot}\n\n`;
    text += `👥 Accounts watched: ${totalAccounts}\n`;
    text += `📥 Tweets pending comment: ${pendingCount}\n\n`;
    text += `*📈 Today:*\n`;
    text += `  💬 Comments posted: ${stats.todayTotal}\n`;

    if (stats.todayBySlot.length > 0) {
      for (const s of stats.todayBySlot) {
        text += `    • ${s.slot}: ${s.count}\n`;
      }
    }

    text += `\n*📅 All time:* ${stats.allTime} comments\n`;

    await safeSend(msg.chat.id, text, true);
  });

  // ── /timeslots ────────────────────────────────────────────────────────────
  bot.onText(/\/timeslots/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    const active = getActiveSlotNames();
    const table = formatTimeSlotsTable();
    await safeSend(
      msg.chat.id,
      `${table}\n\n🟢 *Currently active:* ${active}`,
      true,
    );
  });

  // ── /history — comment history ────────────────────────────────────────────
  bot.onText(/\/history/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;

    const recent = await db.postedComment.findMany({
      orderBy: { postedAt: "desc" },
      take: 10,
      include: { account: true },
    });

    if (recent.length === 0) {
      await safeSend(msg.chat.id, "📭 No comments yet");
      return;
    }

    let text = `📜 *10 most recent comments:*\n\n`;
    for (const c of recent) {
      const time = c.postedAt.toISOString().replace("T", " ").slice(0, 16);
      text += `🇺🇸 *@${c.account.handle}* — ${time}\n`;
      text += `_${c.commentText.slice(0, 80)}${c.commentText.length > 80 ? "…" : ""}_\n`;
      text += `🔗 https://x.com/i/web/status/${c.commentId}\n\n`;
    }

    await safeSend(msg.chat.id, text, true);
  });

  // ── /monitornow — trigger monitor manually ────────────────────────────────
  bot.onText(/\/monitornow/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    await safeSend(msg.chat.id, "🔄 Monitoring for new tweets...");
    try {
      await triggerMonitor();
      const pending = await db.monitoredTweet.count({
        where: { status: "pending" },
      });
      await safeSend(
        msg.chat.id,
        `✅ Done! ${pending} tweets waiting for comment`,
      );
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // ── /commentnow — trigger comment manually ────────────────────────────────
  bot.onText(/\/commentnow/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    const activeSlot = getActiveSlotNames();
    await safeSend(
      msg.chat.id,
      `💬 Running comment cycle...\n⏰ Slot: ${activeSlot}`,
    );
    try {
      await triggerComment();
      await safeSend(msg.chat.id, "✅ Comment cycle complete!");
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // ── /logs — recent logs ───────────────────────────────────────────────────
  bot.onText(/\/logs/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;

    const logs = await db.log.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (logs.length === 0) {
      await safeSend(msg.chat.id, "📭 No logs");
      return;
    }

    const lines = logs
      .reverse()
      .map(
        (l: {
          level: string;
          createdAt: Date;
          module: string;
          message: string;
        }) => {
          const icon =
            l.level === "error" ? "🔴" : l.level === "warn" ? "🟡" : "⚪";
          const time = l.createdAt.toISOString().slice(11, 19);
          return `${icon} [${time}] [${l.module}] ${l.message}`;
        },
      )
      .join("\n");

    await safeSend(
      msg.chat.id,
      `📝 *Recent logs:*\n\`\`\`\n${lines}\n\`\`\``,
      true,
    );
  });

  // ── /watchpost <url> [label] — add a post to watch ───────────────────────
  bot.onText(/\/watchpost (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const args = match![1].trim().split(/\s+/);
    const url = args[0];
    const label = args.slice(1).join(" ");

    const tweetId = extractTweetId(url);
    if (!tweetId) {
      await safeSend(
        msg.chat.id,
        "❌ Invalid URL. Example:\n/watchpost https://x.com/yourhandle/status/1234567890",
      );
      return;
    }

    try {
      await db.watchedPost.upsert({
        where: { tweetId },
        create: { tweetId, url, label, isActive: true },
        update: { url, label, isActive: true },
      });
      await safeSend(
        msg.chat.id,
        `✅ Now watching post:\n🔗 ${url}${label ? `\n🏷 ${label}` : ""}\n\n` +
          `Bot will auto-comment on the latest tweet of anyone who comments on this post.`,
      );
      logger.info("bot", `Admin added watched post: ${tweetId}`);
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // ── /unwatchpost <url or tweetId> — stop watching ─────────────────────────
  bot.onText(/\/unwatchpost (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const input = match![1].trim();
    const tweetId = extractTweetId(input) ?? input;

    try {
      const post = await db.watchedPost.findUnique({ where: { tweetId } });
      if (!post) {
        await safeSend(
          msg.chat.id,
          `⚠️ Post ${tweetId} not found in watch list`,
        );
        return;
      }
      await db.watchedPost.update({
        where: { tweetId },
        data: { isActive: false },
      });
      await safeSend(msg.chat.id, `✅ Stopped watching post ${tweetId}`);
      logger.info("bot", `Admin removed watched post: ${tweetId}`);
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // ── /watchedposts — list all watched posts ────────────────────────────────
  bot.onText(/\/watchedposts/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;

    const posts = await db.watchedPost.findMany({
      orderBy: { createdAt: "desc" },
    });
    if (posts.length === 0) {
      await safeSend(
        msg.chat.id,
        "📭 No watched posts yet.\n\nUse /watchpost <url> to start watching a post.",
      );
      return;
    }

    let text = `👁 *Watched Posts (${posts.length}):*\n\n`;
    for (const p of posts) {
      const status = p.isActive ? "✅" : "⏸";
      const reactionCount = await db.watcherReaction.count({
        where: { watchedPostId: p.id },
      });
      text += `${status} ${p.label || p.tweetId}\n`;
      text += `   🔗 ${p.url}\n`;
      text += `   💬 ${reactionCount} reactions\n\n`;
    }

    await safeSend(msg.chat.id, text, true);
  });

  // ── /watcherhistory — recent watcher reactions ────────────────────────────
  bot.onText(/\/watcherhistory/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;

    const recent = await db.watcherReaction.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { watchedPost: true },
    });

    if (recent.length === 0) {
      await safeSend(msg.chat.id, "📭 No watcher reactions yet");
      return;
    }

    let text = `📜 *Recent watcher reactions (${recent.length}):*\n\n`;
    for (const r of recent) {
      const time = r.createdAt.toISOString().replace("T", " ").slice(0, 16);
      const icon =
        r.status === "commented" ? "✅" : r.status === "skipped" ? "⏭" : "❌";
      text += `${icon} *@${r.commenterHandle}* — ${time}\n`;
      if (r.status === "commented") {
        text += `   _"${r.commentText.slice(0, 80)}${r.commentText.length > 80 ? "…" : ""}"_\n`;
        text += `   ${r.liked ? "❤️ Liked" : "🤍 Not liked"}\n`;
        if (r.postedCommentId) {
          text += `   🔗 https://x.com/i/web/status/${r.postedCommentId}\n`;
        }
      } else if (r.status === "skipped") {
        text += `   ⏭ Skipped: ${r.skipReason}\n`;
      }
      text += "\n";
    }

    await safeSend(msg.chat.id, text, true);
  });

  // ── /watchernow — trigger watcher manually ───────────────────────────────
  bot.onText(/\/watchernow/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    await safeSend(msg.chat.id, "👁 Running watcher cycle now...");
    try {
      await triggerWatcherNow();
      await safeSend(msg.chat.id, "✅ Watcher cycle complete!");
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // ── /commenturls — urgent comment theo list URL ───────────────────────────
  //
  // Cách dùng:
  //   /commenturls
  //   https://x.com/user1/status/111
  //   https://x.com/user2/status/222
  //
  // Hoặc cách nhau bằng dấu phẩy:
  //   /commenturls https://x.com/user1/status/111, https://x.com/user2/status/222

  bot.onText(/\/commenturls([\s\S]*)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;

    const input = match![1].trim();
    if (!input) {
      await safeSend(
        msg.chat.id,
        `📋 *Cách dùng /commenturls:*\n\n` +
          `Gửi kèm list URL, mỗi dòng 1 URL:\n` +
          `\`\`\`\n/commenturls\nhttps://x.com/user1/status/111\nhttps://x.com/user2/status/222\n\`\`\`\n\n` +
          `Hoặc cách nhau bằng dấu phẩy:\n` +
          `\`\`\`\n/commenturls url1, url2, url3\n\`\`\``,
        true,
      );
      return;
    }

    if (isUrgentRunning()) {
      await safeSend(
        msg.chat.id,
        "⚠️ Đang có urgent job chạy rồi, đợi xong nhé!",
      );
      return;
    }

    // Chạy async — gửi progress update realtime qua Telegram
    urgentCommentUrls(input, async (progressMsg) => {
      await safeSend(msg.chat.id, progressMsg);
    }).catch(async (err) => {
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    });
  });

  // ── /commentaccounts — urgent comment theo list @handle ───────────────────
  //
  // Cách dùng:
  //   /commentaccounts
  //   @handle1
  //   @handle2
  //
  // Hoặc:
  //   /commentaccounts @handle1, @handle2, handle3

  bot.onText(/\/commentaccounts([\s\S]*)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;

    const input = match![1].trim();
    if (!input) {
      await safeSend(
        msg.chat.id,
        `📋 *Cách dùng /commentaccounts:*\n\n` +
          `Gửi kèm list @handle, mỗi dòng 1 handle:\n` +
          `\`\`\`\n/commentaccounts\n@handle1\n@handle2\n\`\`\`\n\n` +
          `Hoặc cách nhau bằng dấu phẩy:\n` +
          `\`\`\`\n/commentaccounts @handle1, @handle2, @handle3\n\`\`\``,
        true,
      );
      return;
    }

    if (isUrgentRunning()) {
      await safeSend(
        msg.chat.id,
        "⚠️ Đang có urgent job chạy rồi, đợi xong nhé!",
      );
      return;
    }

    urgentCommentAccounts(input, async (progressMsg) => {
      await safeSend(msg.chat.id, progressMsg);
    }).catch(async (err) => {
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    });
  });

  // ── /monitoron — bật monitor ──────────────────────────────────────────────
  bot.onText(/\/monitoron/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    if (isMonitorEnabled()) {
      await safeSend(
        msg.chat.id,
        "✅ Monitor đang *BẬT* rồi, không cần làm gì thêm.",
        true,
      );
      return;
    }
    enableMonitor();
    await safeSend(
      msg.chat.id,
      "✅ *Monitor đã BẬT!*\nBot sẽ tiếp tục crawl tweet theo lịch.",
      true,
    );
    logger.info("bot", "Admin bật monitor");
  });

  // ── /monitoroff — tắt monitor ─────────────────────────────────────────────
  bot.onText(/\/monitoroff/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    if (!isMonitorEnabled()) {
      await safeSend(msg.chat.id, "⏸ Monitor đang *TẮT* rồi.", true);
      return;
    }
    disableMonitor();
    await safeSend(
      msg.chat.id,
      "⏸ *Monitor đã TẮT!*\nBot sẽ không crawl tweet cho đến khi bật lại bằng /monitoron.",
      true,
    );
    logger.info("bot", "Admin tắt monitor");
  });

  // ── /addgroup <chat_id> <tên> — đăng ký group ────────────────────────────
  //
  // Cách lấy chat_id:
  //   1. Thêm bot vào group
  //   2. Gửi 1 tin nhắn bất kỳ
  //   3. Vào https://api.telegram.org/bot<TOKEN>/getUpdates → xem "chat.id"
  //
  // Ví dụ: /addgroup -1001234567890 Chéo X

  bot.onText(/\/addgroup (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const parts = match![1].trim().split(/\s+/);
    const chatId = parts[0];
    const name = parts.slice(1).join(" ") || chatId;

    if (!chatId.match(/^-?\d+$/)) {
      await safeSend(
        msg.chat.id,
        `❌ Chat ID không hợp lệ. Phải là số, VD: \`-1001234567890\`\n\n` +
          `*Cách lấy chat_id:*\n` +
          `1. Thêm bot vào group\n` +
          `2. Gửi 1 tin nhắn bất kỳ trong group\n` +
          `3. Mở: \`https://api.telegram.org/bot<TOKEN>/getUpdates\`\n` +
          `4. Tìm trường \`"chat":{"id":...\``,
        true,
      );
      return;
    }

    try {
      await addGroup(chatId, name);
      await safeSend(
        msg.chat.id,
        `✅ Đã đăng ký group *${name}* (ID: \`${chatId}\`)`,
        true,
      );
      logger.info("bot", `Admin đăng ký group: ${chatId} — ${name}`);
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // ── /removegroup <chat_id> — xóa group ───────────────────────────────────

  bot.onText(/\/removegroup (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const chatId = match![1].trim();
    try {
      await removeGroup(chatId);
      await safeSend(msg.chat.id, `✅ Đã xóa group \`${chatId}\``, true);
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // ── /addtopic <chat_id> <thread_id> <tên> — đăng ký topic ────────────────
  //
  // Cách lấy thread_id (message_thread_id):
  //   Gửi tin nhắn vào topic đó → getUpdates → xem "message_thread_id"
  //   Hoặc dùng /detecttopic trong topic đó
  //
  // Ví dụ: /addtopic -1001234567890 101 POST 1 ĐÓNG 9H30

  bot.onText(/\/addtopic (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const parts = match![1].trim().split(/\s+/);
    if (parts.length < 3) {
      await safeSend(
        msg.chat.id,
        `📋 *Cách dùng /addtopic:*\n\n` +
          `\`/addtopic <chat_id> <thread_id> <tên topic>\`\n\n` +
          `*Ví dụ:*\n` +
          `\`/addtopic -1001234567890 101 POST 1 ĐÓNG 9H30\`\n\n` +
          `*Cách lấy thread_id:* Vào topic đó và dùng lệnh /detecttopic`,
        true,
      );
      return;
    }
    const chatId = parts[0];
    const threadId = parseInt(parts[1]);
    const name = parts.slice(2).join(" ");

    if (isNaN(threadId)) {
      await safeSend(msg.chat.id, `❌ thread_id phải là số nguyên`);
      return;
    }

    try {
      await addTopic(chatId, threadId, name);
      await safeSend(
        msg.chat.id,
        `✅ Đã thêm topic *${name}*\n` +
          `  📌 Group: \`${chatId}\`\n` +
          `  🧵 Thread ID: \`${threadId}\``,
        true,
      );
      logger.info(
        "bot",
        `Admin thêm topic: group ${chatId} thread ${threadId} — ${name}`,
      );
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // ── /removetopic <chat_id> <thread_id> ───────────────────────────────────

  bot.onText(/\/removetopic (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const parts = match![1].trim().split(/\s+/);
    if (parts.length < 2) {
      await safeSend(
        msg.chat.id,
        `📋 Cách dùng: \`/removetopic <chat_id> <thread_id>\``,
        true,
      );
      return;
    }
    const chatId = parts[0];
    const threadId = parseInt(parts[1]);
    try {
      await removeTopic(chatId, threadId);
      await safeSend(
        msg.chat.id,
        `✅ Đã xóa topic \`${threadId}\` khỏi group \`${chatId}\``,
      );
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // ── /listtopics — xem danh sách group và topic ────────────────────────────

  bot.onText(/\/listtopics/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    try {
      const groups = await getAllGroups();
      if (groups.length === 0) {
        await safeSend(
          msg.chat.id,
          `📭 Chưa có group nào.\n\nDùng /addgroup để thêm.`,
          true,
        );
        return;
      }
      const cacheStats = getCacheStats();
      const cacheMap = new Map(cacheStats.map((s) => [s.key, s.count]));

      let text = `🗂 *Danh sách Group & Topic:*\n\n`;
      for (const g of groups) {
        text += `📁 *${g.name}*\n`;
        text += `   ID: \`${g.chatId}\`\n`;
        if (g.topics.length === 0) {
          text += `   _(chưa có topic)_\n`;
        } else {
          for (const t of g.topics) {
            const cached = cacheMap.get(`${g.chatId}:${t.threadId}`) ?? 0;
            text += `   🧵 \`${t.threadId}\` — *${t.name}*`;
            text +=
              cached > 0
                ? ` _(${cached} links cached)_\n`
                : ` _(chưa có cache)_\n`;
          }
        }
        text += "\n";
      }
      text += `_Dùng /addtopic để thêm topic, /scantopics để quét link_`;
      await safeSend(msg.chat.id, text, true);
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // ── /detecttopic — gửi trong topic để lấy thread_id tự động ──────────────
  //
  // Admin vào đúng topic trong group rồi gửi lệnh này
  // Bot sẽ trả về chat_id và thread_id của topic đó

  bot.onText(/\/detecttopic/, async (msg) => {
    if (!isAdmin(msg.from!.id)) return;
    const threadId = msg.message_thread_id;
    const chatId = msg.chat.id;
    const chatTitle = msg.chat.title ?? "(không có tên)";

    if (!threadId) {
      await safeSend(
        msg.chat.id,
        `⚠️ Lệnh này phải gửi *bên trong một topic* của supergroup, không phải chat thường.`,
        true,
      );
      return;
    }

    await safeSend(
      msg.chat.id,
      `✅ *Thông tin topic này:*\n\n` +
        `📁 Group: *${chatTitle}*\n` +
        `🆔 Chat ID: \`${chatId}\`\n` +
        `🧵 Thread ID: \`${threadId}\`\n\n` +
        `*Copy lệnh để thêm topic này:*\n` +
        `\`/addtopic ${chatId} ${threadId} Tên Topic\``,
      true,
    );
  });

  // ── /scantopics <chat_id> HH:MM HH:MM [thread_id ...] ────────────────────
  //
  // Ví dụ:
  //   /scantopics -1001234567890 07:00 19:00           → quét hết topic
  //   /scantopics -1001234567890 07:00 19:00 101 102   → chỉ quét topic 101, 102

  bot.onText(/\/scantopics(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;

    const args = (match![1] ?? "").trim().split(/\s+/).filter(Boolean);
    const timeRegex = /^\d{1,2}:\d{2}$/;

    if (
      args.length < 3 ||
      !args[0].match(/^-?\d+$/) ||
      !timeRegex.test(args[1]) ||
      !timeRegex.test(args[2])
    ) {
      const groups = await getAllGroups().catch(() => []);
      let groupList =
        groups.length === 0
          ? "_Chưa có group nào — dùng /addgroup để thêm_"
          : groups
              .map(
                (g: { chatId: string; name: string; topics: unknown[] }) =>
                  `  \`${g.chatId}\` — *${g.name}* (${g.topics.length} topics)`,
              )
              .join("\n");

      await safeSend(
        msg.chat.id,
        `📋 *Cách dùng /scantopics:*\n\n` +
          `\`/scantopics <chat_id> HH:MM HH:MM [thread_id ...]\`\n\n` +
          `*Ví dụ:*\n` +
          `\`/scantopics -1001234567890 07:00 19:00\` — quét hết topic\n` +
          `\`/scantopics -1001234567890 07:00 19:00 101 102\` — chỉ quét topic 101, 102\n\n` +
          `*📁 Groups đã đăng ký:*\n${groupList}\n\n` +
          `_Xem chi tiết topic: /listtopics_`,
        true,
      );
      return;
    }

    const chatId = args[0];
    const fromTime = args[1];
    const toTime = args[2];
    const filterIds = args
      .slice(3)
      .map(Number)
      .filter((n) => !isNaN(n));

    await safeSend(
      msg.chat.id,
      `🔍 Đang quét group \`${chatId}\` từ *${fromTime}* đến *${toTime}*...`,
      true,
    );

    try {
      const results = await scanTopics(chatId, filterIds, fromTime, toTime);

      if (results.length === 0) {
        await safeSend(
          msg.chat.id,
          `📭 Không tìm thấy link X.com nào trong khoảng *${fromTime}* — *${toTime}*\n\n` +
            `💡 _Bot chỉ cache tin nhắn kể từ lúc khởi động. Nếu link được gửi trước đó sẽ không lấy được._`,
          true,
        );
        return;
      }

      let totalLinks = 0;
      for (const result of results) {
        totalLinks += result.links.length;
        let text = `📌 *${result.topicName}* (thread \`${result.threadId}\`)\n`;
        text += `🔗 *${result.links.length} link X.com:*\n\n`;
        text += result.links.map((l, i) => `${i + 1}. ${l}`).join("\n");
        await safeSend(msg.chat.id, text, true);
      }

      await safeSend(
        msg.chat.id,
        `✅ *Tổng kết:* ${totalLinks} link X.com từ ${results.length} topic\n` +
          `⏰ *${fromTime}* → *${toTime}*\n\n` +
          `_Dùng /commenturls + paste các link trên để comment ngay_`,
        true,
      );
    } catch (err: any) {
      await safeSend(msg.chat.id, `❌ Lỗi: ${err.message}`);
    }
  });

  // ── Unknown command ───────────────────────────────────────────────────────
  bot.onText(/\/(.+)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const cmd = match![1].split(" ")[0];
    const knownCmds = [
      "start",
      "addaccount",
      "removeaccount",
      "accounts",
      "status",
      "timeslots",
      "history",
      "monitornow",
      "commentnow",
      "logs",
      "watchpost",
      "unwatchpost",
      "watchedposts",
      "watcherhistory",
      "watchernow",
      "commenturls",
      "commentaccounts",
      "quotetweet",
      "monitoron",
      "monitoroff",
      "addgroup",
      "removegroup",
      "addtopic",
      "removetopic",
      "listtopics",
      "detecttopic",
      "scantopics",
    ];
    if (!knownCmds.includes(cmd)) {
      await safeSend(
        msg.chat.id,
        `❓ Command /${cmd} not found. Type /start to see available commands.`,
      );
    }
  });

  // ── Quote tweet handlers ──────────────────────────────────────────────────
  registerQuoteHandlers(bot, isAdmin);

  // ── Topic scanner listener — lắng nghe tin nhắn từ các topic ─────────────
  registerScannerListener(bot);

  return bot;
}
