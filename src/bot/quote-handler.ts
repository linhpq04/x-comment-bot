import TelegramBot from "node-telegram-bot-api";
import { createWriteStream } from "fs";
import { resolve as pathResolve } from "path";
import https from "https";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { extractTweetId } from "../watcher/post-watcher.js";
import {
  createJob,
  generateQuoteContent,
  scheduleQuoteJob,
  type QuoteJob,
} from "../quoter/quote-tweeter.js";
import { TwitterApi } from "twitter-api-v2";

// ── State machine per user ────────────────────────────────────────────────────

type Step =
  | "await_content_mode"
  | "await_content"
  | "await_ai_confirm"
  | "await_media_choice"
  | "await_media";

interface QuoteState {
  step: Step;
  tweetId?: string;
  tweetUrl?: string;
  scheduledAt?: Date;
  aiContent?: string;
  content?: string;
}

const states = new Map<number, QuoteState>(); // userId → state

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeSend(
  bot: TelegramBot,
  chatId: number,
  text: string,
  markdown = false,
) {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: markdown ? "Markdown" : undefined,
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    if (err.message?.includes("parse entities")) {
      await bot.sendMessage(chatId, text.replace(/[*_`[\]]/g, ""), {
        disable_web_page_preview: true,
      });
    }
  }
}

async function getTweetInfo(
  tweetId: string,
): Promise<{ text: string; handle: string } | null> {
  try {
    const client = new TwitterApi(config.TWITTER_BEARER);
    const resp = await client.v2.singleTweet(tweetId, {
      "tweet.fields": ["text", "author_id"],
      expansions: ["author_id"],
      "user.fields": ["username"],
    });
    return {
      text: resp.data?.text ?? "",
      handle: resp.includes?.users?.[0]?.username ?? "",
    };
  } catch {
    return null;
  }
}

async function downloadTelegramFile(
  bot: TelegramBot,
  fileId: string,
  ext: string,
): Promise<string> {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${fileInfo.file_path}`;
  const destPath = pathResolve(`/tmp/quote_media_${Date.now()}.${ext}`);

  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(destPath);
    https
      .get(fileUrl, (res) => {
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", reject);
  });

  return destPath;
}

async function dispatchJob(
  bot: TelegramBot,
  chatId: number,
  state: QuoteState,
  mediaPath?: string,
): Promise<void> {
  const jobId = `quote_${Date.now()}`;
  const job = createJob({
    id: jobId,
    tweetId: state.tweetId,
    tweetUrl: state.tweetUrl,
    contentMode: "manual",
    content: state.content!,
    mediaPath,
    scheduledAt: state.scheduledAt,
  });

  const scheduleInfo = state.scheduledAt
    ? `⏰ Sẽ đăng lúc *${state.scheduledAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}*`
    : "⚡ Đang đăng ngay...";

  await safeSend(
    bot,
    chatId,
    `✅ *Job đã tạo!*\n\n${scheduleInfo}\n` +
      `📝 _${job.content.slice(0, 100)}${job.content.length > 100 ? "…" : ""}_\n` +
      `${mediaPath ? "🖼 Có media đính kèm" : ""}`,
    true,
  );

  await scheduleQuoteJob(job, async (doneJob: QuoteJob) => {
    if (doneJob.status === "done") {
      const label = job.tweetId
        ? "🎉 *Quote tweet đã đăng!*"
        : "🎉 *Bài đã đăng!*";
      await safeSend(
        bot,
        chatId,
        `${label}\n🔗 https://x.com/i/web/status/${doneJob.postedId}`,
        true,
      );
    } else {
      await safeSend(bot, chatId, "❌ Đăng thất bại, kiểm tra /logs nhé");
    }
  });
}

// ── Register handlers ─────────────────────────────────────────────────────────

export function registerQuoteHandlers(
  bot: TelegramBot,
  isAdmin: (id: number) => boolean,
): void {
  // /quotetweet [url] [HH:MM]  — url là optional
  //   Có link  → quote tweet
  //   Không link → đăng bài thường
  bot.onText(/\/quotetweet(.*)/, async (msg, match) => {
    if (!isAdmin(msg.from!.id)) return;
    const userId = msg.from!.id;
    const chatId = msg.chat.id;
    const args = match![1].trim().split(/\s+/).filter(Boolean);

    let url: string | undefined;
    let tweetId: string | undefined;
    let timeArg: string | undefined;

    for (const arg of args) {
      if (/^\d{1,2}:\d{2}$/.test(arg)) {
        timeArg = arg;
      } else if (!url) {
        url = arg;
      }
    }

    // Nếu có url thì parse tweetId, báo lỗi nếu url sai
    if (url) {
      tweetId = extractTweetId(url) ?? undefined;
      if (!tweetId) {
        await safeSend(
          bot,
          chatId,
          "❌ URL không hợp lệ.\n" +
            "Ví dụ có link: /quotetweet https://x.com/user/status/123\n" +
            "Đăng bài thường: /quotetweet",
        );
        return;
      }
    }

    // Parse giờ hẹn
    let scheduledAt: Date | undefined;
    if (timeArg) {
      const [h, m] = timeArg.split(":").map(Number);
      scheduledAt = new Date();
      scheduledAt.setHours(h, m, 0, 0);
      if (scheduledAt <= new Date())
        scheduledAt.setDate(scheduledAt.getDate() + 1);
    }

    states.set(userId, {
      step: "await_content_mode",
      tweetId,
      tweetUrl: url,
      scheduledAt,
    });

    const scheduleInfo = scheduledAt
      ? `\n⏰ Sẽ đăng lúc *${scheduledAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}*`
      : "\n⚡ Sẽ đăng ngay";

    const modeInfo = tweetId
      ? `🔗 *Quote tweet:* ${url}${scheduleInfo}`
      : `📝 *Đăng bài thường* (không quote)${scheduleInfo}`;

    await safeSend(
      bot,
      chatId,
      `${modeInfo}\n\n` +
        `📝 *Nội dung bài?*\n\n` +
        `1️⃣  Tự viết\n` +
        `2️⃣  Để AI generate`,
      true,
    );
  });

  // Xử lý tất cả message theo state
  bot.on("message", async (msg) => {
    if (!msg.from || !isAdmin(msg.from.id)) return;
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const state = states.get(userId);
    if (!state) return;

    // Lệnh / → hủy flow
    if (msg.text?.startsWith("/")) {
      states.delete(userId);
      return;
    }

    // ── await_content_mode ────────────────────────────────────────────────
    if (state.step === "await_content_mode") {
      const choice = msg.text?.trim();
      if (choice === "1") {
        states.set(userId, { ...state, step: "await_content" });
        await safeSend(bot, chatId, "✏️ Nhập nội dung bài trích dẫn:");
      } else if (choice === "2") {
        await safeSend(bot, chatId, "🤖 AI đang generate...");
        const info = state.tweetId ? await getTweetInfo(state.tweetId) : null;
        const aiContent = await generateQuoteContent(
          info?.text ?? "",
          info?.handle ?? "",
        );
        if (!aiContent) {
          await safeSend(bot, chatId, "❌ AI thất bại. Bạn tự nhập nhé:");
          states.set(userId, { ...state, step: "await_content" });
          return;
        }
        states.set(userId, { ...state, step: "await_ai_confirm", aiContent });
        await safeSend(
          bot,
          chatId,
          `🤖 *AI generate:*\n\n_${aiContent}_\n\n` +
            `✅ *ok* — dùng ngay\n✏️ *edit* — tự viết lại\n🔄 *retry* — generate lại`,
          true,
        );
      } else {
        await safeSend(bot, chatId, "⚠️ Gõ *1* hoặc *2* nhé!", true);
      }
      return;
    }

    // ── await_content ─────────────────────────────────────────────────────
    if (state.step === "await_content") {
      const content = msg.text?.trim() ?? "";
      if (!content) {
        await safeSend(bot, chatId, "⚠️ Nội dung không được để trống");
        return;
      }
      states.set(userId, { ...state, step: "await_media_choice", content });
      await safeSend(
        bot,
        chatId,
        `✅ Đã lưu nội dung:\n_${content}_\n\n` +
          `🖼 *Đính kèm ảnh/video không?*\n\n1️⃣  Có\n2️⃣  Không`,
        true,
      );
      return;
    }

    // ── await_ai_confirm ──────────────────────────────────────────────────
    if (state.step === "await_ai_confirm") {
      const choice = msg.text?.trim().toLowerCase();
      if (choice === "ok") {
        states.set(userId, {
          ...state,
          step: "await_media_choice",
          content: state.aiContent!,
        });
        await safeSend(
          bot,
          chatId,
          `✅ Dùng nội dung AI!\n\n🖼 *Đính kèm ảnh/video không?*\n\n1️⃣  Có\n2️⃣  Không`,
          true,
        );
      } else if (choice === "edit") {
        states.set(userId, { ...state, step: "await_content" });
        await safeSend(bot, chatId, "✏️ Nhập nội dung của bạn:");
      } else if (choice === "retry") {
        await safeSend(bot, chatId, "🔄 Generate lại...");
        const info = state.tweetId ? await getTweetInfo(state.tweetId) : null;
        const aiContent = await generateQuoteContent(
          info?.text ?? "",
          info?.handle ?? "",
        );
        if (!aiContent) {
          await safeSend(bot, chatId, "❌ AI thất bại lần nữa. Tự nhập đi:");
          states.set(userId, { ...state, step: "await_content" });
          return;
        }
        states.set(userId, { ...state, aiContent });
        await safeSend(
          bot,
          chatId,
          `🤖 *Generate mới:*\n\n_${aiContent}_\n\n✅ *ok* — ✏️ *edit* — 🔄 *retry*`,
          true,
        );
      } else {
        await safeSend(bot, chatId, "⚠️ Gõ *ok*, *edit* hoặc *retry*", true);
      }
      return;
    }

    // ── await_media_choice ────────────────────────────────────────────────
    if (state.step === "await_media_choice") {
      const choice = msg.text?.trim();
      if (choice === "1") {
        states.set(userId, { ...state, step: "await_media" });
        await safeSend(bot, chatId, "📎 Gửi ảnh hoặc video:");
      } else if (choice === "2") {
        states.delete(userId);
        await dispatchJob(bot, chatId, state, undefined);
      } else {
        await safeSend(bot, chatId, "⚠️ Gõ *1* hoặc *2*", true);
      }
      return;
    }

    // ── await_media ───────────────────────────────────────────────────────
    if (state.step === "await_media") {
      let fileId: string | undefined;
      let ext = "jpg";

      if (msg.photo) {
        fileId = msg.photo[msg.photo.length - 1].file_id;
        ext = "jpg";
      } else if (msg.video) {
        fileId = msg.video.file_id;
        ext = "mp4";
      } else if (msg.document) {
        fileId = msg.document.file_id;
        ext = msg.document.file_name?.split(".").pop() ?? "bin";
      } else {
        await safeSend(bot, chatId, "⚠️ Vui lòng gửi ảnh hoặc video");
        return;
      }

      await safeSend(bot, chatId, "⏬ Đang tải file...");
      try {
        const mediaPath = await downloadTelegramFile(bot, fileId, ext);
        states.delete(userId);
        await dispatchJob(bot, chatId, state, mediaPath);
      } catch (err: any) {
        await safeSend(bot, chatId, `❌ Tải file thất bại: ${err.message}`);
      }
      return;
    }
  });
}
