import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ Missing required env: ${key}`);
    process.exit(1);
  }
  return val;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

export const config = {
  // Telegram Bot
  BOT_TOKEN: required("TELEGRAM_BOT_TOKEN"),
  ADMIN_IDS: optional("ADMIN_USER_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n)),

  // Twitter - 1 tài khoản dùng để comment cả JA lẫn EN
  TWITTER_API_KEY: optional("TWITTER_API_KEY"),
  TWITTER_API_SECRET: optional("TWITTER_API_SECRET"),
  TWITTER_ACCESS_TOKEN: optional("TWITTER_ACCESS_TOKEN"),
  TWITTER_ACCESS_SECRET: optional("TWITTER_ACCESS_SECRET"),

  // Twitter login cho Playwright (browser automation)
  TWITTER_USERNAME: optional("TWITTER_USERNAME"),
  TWITTER_PASSWORD: optional("TWITTER_PASSWORD"),
  TWITTER_EMAIL: optional("TWITTER_EMAIL"), // dùng khi Twitter hỏi xác minh

  // Bearer token dùng để đọc tweet (crawl)
  TWITTER_BEARER: optional("TWITTER_BEARER_TOKEN"),

  // DeepSeek AI
  DEEPSEEK_API_KEY: optional("DEEPSEEK_API_KEY"),
  DEEPSEEK_MODEL: optional("DEEPSEEK_MODEL", "deepseek-chat"),

  // Giới hạn comment mỗi GIỜ trong slot (reset mỗi giờ)
  COMMENTS_PER_HOUR_MIN: parseInt(optional("COMMENTS_PER_HOUR_MIN", "5")),
  COMMENTS_PER_HOUR_MAX: parseInt(optional("COMMENTS_PER_HOUR_MAX", "8")),

  // Delay giữa các comment (ms) - chống ban
  COMMENT_DELAY_MIN_MS: parseInt(optional("COMMENT_DELAY_MIN_MS", "60000")), // 1 phút
  COMMENT_DELAY_MAX_MS: parseInt(optional("COMMENT_DELAY_MAX_MS", "180000")), // 3 phút

  // Proxy (bắt buộc nếu server bị Twitter block IP)
  // Format: "http://host:port" hoặc "socks5://host:port"
  PROXY_SERVER: optional("PROXY_SERVER"),
  PROXY_USERNAME: optional("PROXY_USERNAME"),
  PROXY_PASSWORD: optional("PROXY_PASSWORD"),

  LOG_LEVEL: optional("LOG_LEVEL", "info"),

  // Feature checks
  get hasTwitter() {
    return !!(
      this.TWITTER_API_KEY &&
      this.TWITTER_API_SECRET &&
      this.TWITTER_ACCESS_TOKEN &&
      this.TWITTER_ACCESS_SECRET
    );
  },
  get hasBearerToken() {
    return !!this.TWITTER_BEARER;
  },
  get hasDeepSeek() {
    return !!this.DEEPSEEK_API_KEY;
  },
};
