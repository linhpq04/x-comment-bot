# 🤖 Comment Bot

> Automatically reply to tweets on Twitter/X on a schedule — fully controlled via Telegram.

🇻🇳 [Tiếng Việt](./README.md)

---

## Table of Contents

- [Overview](#overview)
- [Installation & Running](#installation--running)
  - [Docker](#-docker)
  - [Windows](#-windows)
  - [Linux](#-linux-ubuntudebian)
- [Usage](#usage)
  - [Follow Twitter Accounts](#-follow-twitter-accounts)
  - [Watcher](#-watcher--reply-to-people-who-reply-to-your-posts)
  - [Urgent Comment](#-urgent-comment)
  - [Quote Tweet](#-quote-tweet)
  - [Control & Statistics](#-control--statistics)
  - [Topic Scanner](#-topic-scanner--scan-xcom-links-from-telegram)

---

## Overview

The bot operates in a closed loop:

```
Crawl new tweets  →  Generate comment with AI (DeepSeek)  →  Post reply via browser (Playwright)
```

**Architecture of 10 modules:**

| Module       | File                                 | Function                          |
| ------------ | ------------------------------------ | --------------------------------- |
| Entry point  | `src/index.ts`                       | Bootstrap the system              |
| Config       | `src/config.ts`                      | Manage environment variables      |
| Scheduler    | `src/scheduler/`                     | Coordinate crawl & comment timing |
| Monitor      | `src/monitor/twitter-monitor.ts`     | Crawl new tweets from Twitter API |
| Commenter    | `src/commenter/twitter-commenter.ts` | Post comments via Playwright      |
| Generator    | `src/generator/comment-generator.ts` | Generate comments with DeepSeek   |
| Telegram Bot | `src/bot/telegram-bot.ts`            | Control interface                 |
| Watcher      | `src/watcher/`                       | Reply to people who reply to you  |
| Quoter       | `src/quoter/quote-tweeter.ts`        | Post Quote Tweets                 |
| Scanner      | `src/scanner/topic-scanner.ts`       | Scan X.com links from Telegram    |

**Database:** SQLite via Prisma ORM — `data/comment-bot.db`

---

## Installation & Running

> 📁 Full setup guide (including `.env` configuration): [Google Drive](https://drive.google.com/drive/u/2/folders/1YlRBtaJjqCU6t2_1zEGVUx6lBnbZeQim)

### 🐳 Docker

```bash
docker-compose up -d
```

### 🪟 Windows

Install Node.js **v22 or above** at: https://nodejs.org/en/download

```bash
npm install -g pnpm pm2 tsx
pnpm install
npx prisma generate && npx prisma db push   # Create database file on first run
pm2 start src\index.ts --name comment-bot --interpreter tsx
pm2 save
```

### 🐧 Linux (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm pm2 tsx
pnpm install
npx prisma generate && npx prisma db push   # Create database file on first run
pm2 start src/index.ts --name comment-bot --interpreter tsx
pm2 save && pm2 startup
```

### 🚫 Stop bot

```bash
pm2 stop comment-bot
```

### 🗑️ Delete bot

```bash
pm2 delete comment-bot
```

---

## Usage

> All commands are admin-only. If `ADMIN_USER_IDS` is not set, everyone can use the bot.

### 👥 Follow Twitter Accounts

The bot will crawl new tweets from these accounts and automatically comment on schedule.

| Command          | Syntax           | Description                    |
| ---------------- | ---------------- | ------------------------------ |
| `/addaccount`    | `@handle [name]` | Add account to the follow list |
| `/removeaccount` | `@handle`        | Unfollow an account            |
| `/accounts`      | —                | View list of followed accounts |

> `@` is optional — `/addaccount elonmusk` and `/addaccount @elonmusk` both work.

### 👁 Watcher — Reply to people who reply to your posts

The bot monitors one of your tweets. When someone replies to it, the bot will automatically visit that person's post and comment back.

| Command           | Syntax          | Description                     |
| ----------------- | --------------- | ------------------------------- |
| `/watchpost`      | `<url> [label]` | Start watching a tweet          |
| `/unwatchpost`    | `<url>`         | Stop watching a tweet           |
| `/watchedposts`   | —               | List of currently watched posts |
| `/watcherhistory` | —               | Last 20 watcher reactions       |
| `/watchernow`     | —               | Run a watcher cycle immediately |

### ⚡ Urgent Comment

Comment immediately without waiting for the scheduler window. Only one job runs at a time — if busy, the bot will reject new commands.

| Command            | Syntax                         | Description                                          |
| ------------------ | ------------------------------ | ---------------------------------------------------- |
| `/commenturls`     | List of URLs, one per line     | Comment immediately on specified tweets              |
| `/commentaccounts` | List of @handles, one per line | Fetch latest tweet from each account and comment now |

### 🔁 Quote Tweet

| Command       | Syntax          | Description                                                           |
| ------------- | --------------- | --------------------------------------------------------------------- |
| `/quotetweet` | `<url> [HH:MM]` | Quote tweet now or schedule — bot asks to choose AI content or manual |

### 📊 Control & Statistics

| Command       | Description                                            |
| ------------- | ------------------------------------------------------ |
| `/status`     | Overview: active slots, pending tweets, comments today |
| `/timeslots`  | View active time windows                               |
| `/history`    | Last 20 posted comments                                |
| `/monitornow` | Crawl tweets immediately                               |
| `/commentnow` | Run a comment cycle now (only during active hours)     |
| `/monitoron`  | Re-enable monitor                                      |
| `/monitoroff` | Disable monitor manually                               |
| `/logs`       | View last 30 log lines                                 |

### 📡 Topic Scanner — Scan X.com links from Telegram

Monitor Telegram groups/topics and automatically collect X.com links shared there.

| Command        | Syntax                                  | Description                                                         |
| -------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `/addgroup`    | `<chat_id> <name>`                      | Register a Telegram group to scan for links                         |
| `/removegroup` | `<chat_id>`                             | Remove a group                                                      |
| `/addtopic`    | `<chat_id> <thread_id> <name>`          | Add a topic inside a group                                          |
| `/removetopic` | `<chat_id> <thread_id>`                 | Remove a topic                                                      |
| `/listtopics`  | —                                       | List all monitored groups/topics                                    |
| `/detecttopic` | —                                       | Send this command _inside a topic_ to get `chat_id` and `thread_id` |
| `/scantopics`  | `<chat_id> HH:MM HH:MM [thread_ids...]` | Scan X.com links within a specified time range                      |
