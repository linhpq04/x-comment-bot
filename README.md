# 🤖 Comment Bot

> Tự động reply tweet trên Twitter/X theo lịch — điều khiển hoàn toàn qua Telegram.

---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Cài đặt & Chạy](#cài-đặt--chạy)
  - [Docker](#-docker)
  - [Windows](#-windows)
  - [Linux](#-linux-ubuntudebian)
- [Hướng dẫn sử dụng](#hướng-dẫn-sử-dụng)
  - [Theo dõi tài khoản Twitter](#-theo-dõi-tài-khoản-twitter)
  - [Watcher](#-watcher--phản-hồi-người-reply-bài-mình)
  - [Comment khẩn cấp](#-comment-khẩn-cấp)
  - [Quote Tweet](#-quote-tweet)
  - [Điều khiển & thống kê](#-điều-khiển--thống-kê)
  - [Topic Scanner](#-topic-scanner--quét-link-xcom-từ-telegram)

---

## Tổng quan

Bot hoạt động theo chu trình khép kín:

```
Crawl tweet mới  →  Sinh comment bằng AI (DeepSeek)  →  Đăng reply qua trình duyệt (Playwright)
```

**Kiến trúc gồm 10 module:**

| Module       | File                                 | Chức năng                         |
| ------------ | ------------------------------------ | --------------------------------- |
| Entry point  | `src/index.ts`                       | Khởi động hệ thống                |
| Config       | `src/config.ts`                      | Quản lý biến môi trường           |
| Scheduler    | `src/scheduler/`                     | Điều phối lịch crawl & comment    |
| Monitor      | `src/monitor/twitter-monitor.ts`     | Crawl tweet mới từ Twitter API    |
| Commenter    | `src/commenter/twitter-commenter.ts` | Đăng comment qua Playwright       |
| Generator    | `src/generator/comment-generator.ts` | Sinh comment bằng DeepSeek AI     |
| Telegram Bot | `src/bot/telegram-bot.ts`            | Giao diện điều khiển              |
| Watcher      | `src/watcher/`                       | Phản hồi người reply vào bài mình |
| Quoter       | `src/quoter/quote-tweeter.ts`        | Đăng Quote Tweet                  |
| Scanner      | `src/scanner/topic-scanner.ts`       | Quét link X.com từ Telegram       |

**Database:** SQLite qua Prisma ORM — `data/comment-bot.db`

---

## Cài đặt & Chạy

> 📁 Hướng dẫn cài đặt đầy đủ (bao gồm cấu hình `.env`): [Google Drive](https://drive.google.com/drive/u/2/folders/1YlRBtaJjqCU6t2_1zEGVUx6lBnbZeQim)

### 🐳 Docker

```bash
docker-compose up -d
```

### 🪟 Windows

Cài Node.js **v22 trở lên** tại: https://nodejs.org/en/download

```bash
npm install -g pnpm pm2 tsx
pnpm install
npx prisma generate && npx prisma db push   # Tạo file database lần đầu
pm2 start src\index.ts --name comment-bot --interpreter tsx
pm2 save
```

### 🐧 Linux (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm pm2 tsx
pnpm install
npx prisma generate && npx prisma db push   # Tạo file database lần đầu
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

## Hướng dẫn sử dụng

> Tất cả lệnh chỉ dành cho admin. Nếu không đặt `ADMIN_USER_IDS`, mọi người đều có quyền dùng.

### 👥 Theo dõi tài khoản Twitter

Bot sẽ crawl tweet mới từ các tài khoản này và tự động comment theo lịch.

| Lệnh             | Cú pháp         | Mô tả                                 |
| ---------------- | --------------- | ------------------------------------- |
| `/addaccount`    | `@handle [tên]` | Thêm tài khoản vào danh sách theo dõi |
| `/removeaccount` | `@handle`       | Bỏ theo dõi tài khoản                 |
| `/accounts`      | —               | Xem danh sách tài khoản đang theo dõi |

> `@` có thể bỏ qua — `/addaccount elonmusk` và `/addaccount @elonmusk` đều hợp lệ.

### 👁 Watcher — Phản hồi người reply bài mình

Bot theo dõi một bài tweet của bạn. Khi có người reply vào đó, bot sẽ tự động vào bài của người đó để comment lại.

| Lệnh              | Cú pháp         | Mô tả                            |
| ----------------- | --------------- | -------------------------------- |
| `/watchpost`      | `<url> [label]` | Bắt đầu theo dõi một bài tweet   |
| `/unwatchpost`    | `<url>`         | Dừng theo dõi bài tweet          |
| `/watchedposts`   | —               | Danh sách bài đang theo dõi      |
| `/watcherhistory` | —               | 20 phản ứng gần nhất của watcher |
| `/watchernow`     | —               | Chạy ngay một chu kỳ watcher     |

### ⚡ Comment khẩn cấp

Comment ngay lập tức, không cần đợi đến khung giờ scheduler. Chỉ một job được chạy tại một thời điểm — nếu đang bận, bot sẽ từ chối lệnh mới.

| Lệnh               | Cú pháp                                | Mô tả                                                |
| ------------------ | -------------------------------------- | ---------------------------------------------------- |
| `/commenturls`     | Danh sách URL, mỗi dòng một URL        | Comment ngay vào các tweet chỉ định                  |
| `/commentaccounts` | Danh sách @handle, mỗi dòng một handle | Lấy tweet mới nhất của từng account rồi comment ngay |

### 🔁 Quote Tweet

| Lệnh          | Cú pháp         | Mô tả                                                                 |
| ------------- | --------------- | --------------------------------------------------------------------- |
| `/quotetweet` | `<url> [HH:MM]` | Quote tweet ngay hoặc hẹn giờ — bot hỏi chọn nội dung AI hay nhập tay |

### 📊 Điều khiển & thống kê

| Lệnh          | Mô tả                                                      |
| ------------- | ---------------------------------------------------------- |
| `/status`     | Tổng quan: slot active, tweet đang chờ, số comment hôm nay |
| `/timeslots`  | Xem khung giờ hoạt động                                    |
| `/history`    | 20 comment gần nhất đã đăng                                |
| `/monitornow` | Crawl tweet ngay lập tức                                   |
| `/commentnow` | Chạy vòng comment ngay (chỉ khi đang trong giờ active)     |
| `/monitoron`  | Bật lại monitor                                            |
| `/monitoroff` | Tắt monitor thủ công                                       |
| `/logs`       | Xem 30 dòng log gần nhất                                   |

### 📡 Topic Scanner — Quét link X.com từ Telegram

Theo dõi các group/topic Telegram, tự động thu thập link X.com được chia sẻ trong đó.

| Lệnh           | Cú pháp                                 | Mô tả                                                          |
| -------------- | --------------------------------------- | -------------------------------------------------------------- |
| `/addgroup`    | `<chat_id> <tên>`                       | Đăng ký group Telegram để quét link                            |
| `/removegroup` | `<chat_id>`                             | Xóa group                                                      |
| `/addtopic`    | `<chat_id> <thread_id> <tên>`           | Thêm một topic trong group                                     |
| `/removetopic` | `<chat_id> <thread_id>`                 | Xóa topic                                                      |
| `/listtopics`  | —                                       | Danh sách group/topic đang theo dõi                            |
| `/detecttopic` | —                                       | Gửi lệnh này _bên trong topic_ để lấy `chat_id` và `thread_id` |
| `/scantopics`  | `<chat_id> HH:MM HH:MM [thread_ids...]` | Quét link X.com trong khoảng thời gian chỉ định                |
