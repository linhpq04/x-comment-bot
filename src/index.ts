import { config } from "./config.js";
import { db } from "./db.js";
import { logger } from "./utils/logger.js";
import { startBot } from "./bot/telegram-bot.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";

// Default accounts seed — English only
const DEFAULT_ACCOUNTS: { handle: string; lang: "en"; name: string }[] = [
  { handle: "faytuks", lang: "en", name: "Faytuks" },
  { handle: "sentdefender", lang: "en", name: "Sentdefender" },
  { handle: "kobeissiletter", lang: "en", name: "KobeissiLetter" },
  { handle: "elerianm", lang: "en", name: "Mohamed El-Erian" },
  { handle: "lizannsonders", lang: "en", name: "Liz Ann Sonders" },
  { handle: "nicktimiraos", lang: "en", name: "Nick Timiraos" },
  { handle: "warmonitors", lang: "en", name: "WarMonitors" },
  { handle: "sprinterpress", lang: "en", name: "SprinterPress" },
];

async function seedDefaultAccounts() {
  for (const acc of DEFAULT_ACCOUNTS) {
    await db.targetAccount.upsert({
      where: { handle: acc.handle },
      create: {
        handle: acc.handle,
        lang: acc.lang,
        name: acc.name,
        isActive: true,
      },
      update: { isActive: true },
    });
  }
  logger.info("main", `Seeded ${DEFAULT_ACCOUNTS.length} default accounts`);
}

async function main() {
  console.log("================================================");
  console.log("       COMMENT BOT - Auto Comment on X          ");
  console.log("================================================\n");

  // Connect DB
  try {
    await db.$connect();
    logger.info("main", "Database connected (SQLite)");
  } catch (err: any) {
    console.error("Database connection failed:", err.message);
    console.error("Run: pnpm db:push");
    process.exit(1);
  }

  // Seed default accounts
  await seedDefaultAccounts();

  // Check config
  if (!config.hasDeepSeek) {
    logger.warn("main", "DeepSeek not configured — comments will not be generated");
  }
  if (!config.hasBearerToken) {
    logger.warn("main", "TWITTER_BEARER_TOKEN not configured — cannot crawl tweets");
  }
  if (config.hasTwitter) {
    logger.info("main", "Twitter account (commenter): OK");
  } else {
    logger.warn("main", "Twitter account not configured — cannot post comments");
  }

  // Start Telegram Bot
  startBot();
  logger.info("main", "Telegram Bot started");

  // Start Scheduler
  startScheduler();

  logger.info("main", "Bot is running! Type /start on Telegram to begin.");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("main", "Shutting down...");
    stopScheduler();
    await db.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
