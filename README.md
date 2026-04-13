# Comment Bot — Tài liệu chức năng

---

## Tổng quan hệ thống

Comment Bot là một bot tự động đăng comment lên Twitter/X. Bot hoạt động theo chu kỳ: crawl tweet mới từ các tài khoản được theo dõi → sinh comment bằng AI (DeepSeek) → đăng reply bằng trình duyệt tự động (Playwright). Toàn bộ hoạt động được điều khiển qua Telegram.

**Kiến trúc gồm 7 module chính:**

| Module       | File                                 | Chức năng                                      |
| ------------ | ------------------------------------ | ---------------------------------------------- |
| Entry point  | `src/index.ts`                       | Khởi động toàn bộ hệ thống                     |
| Config       | `src/config.ts`                      | Quản lý biến môi trường                        |
| Scheduler    | `src/scheduler/`                     | Điều phối lịch crawl & comment                 |
| Monitor      | `src/monitor/twitter-monitor.ts`     | Crawl tweet mới từ Twitter API                 |
| Commenter    | `src/commenter/twitter-commenter.ts` | Đăng comment qua Playwright                    |
| Generator    | `src/generator/comment-generator.ts` | Sinh nội dung comment bằng DeepSeek AI         |
| Telegram Bot | `src/bot/telegram-bot.ts`            | Giao diện điều khiển qua Telegram              |
| Watcher      | `src/watcher/`                       | Theo dõi & phản hồi người comment vào bài mình |
| Quoter       | `src/quoter/quote-tweeter.ts`        | Đăng Quote Tweet                               |
| Scanner      | `src/scanner/topic-scanner.ts`       | Quét link X.com từ các topic Telegram          |

**Database:** SQLite qua Prisma ORM, lưu tại `data/comment-bot.db`.

---

## 1. Entry Point — `src/index.ts`

### Chức năng khởi động

Khi chạy, hệ thống thực hiện tuần tự:

1. **Kết nối database** — mở kết nối Prisma đến SQLite. Nếu thất bại, thoát chương trình.
2. **Seed tài khoản mặc định** — tự động thêm vào DB 8 tài khoản Twitter có sẵn (faytuks, sentdefender, kobeissiletter, elerianm, lizannsonders, nicktimiraos, warmonitors, sprinterpress). Nếu tài khoản đã tồn tại thì đặt lại `isActive = true`.
3. **Kiểm tra config** — log cảnh báo nếu thiếu DeepSeek API key, Bearer Token, hoặc Twitter OAuth credentials.
4. **Khởi động Telegram Bot** — bắt đầu lắng nghe lệnh từ admin.
5. **Khởi động Scheduler** — bắt đầu vòng lặp crawl & comment tự động.
6. **Graceful shutdown** — khi nhận tín hiệu `SIGINT`/`SIGTERM`, dừng scheduler và đóng kết nối DB sạch sẽ.

---

## 2. Config — `src/config.ts`

### Quản lý biến môi trường

Đọc toàn bộ cấu hình từ file `.env`. Các biến **bắt buộc** (thiếu thì thoát ngay):

- `TELEGRAM_BOT_TOKEN` — token bot Telegram để nhận lệnh admin.

Các biến **tùy chọn** (có giá trị mặc định hoặc tắt tính năng nếu thiếu):

| Biến                              | Mặc định                     | Mô tả                                               |
| --------------------------------- | ---------------------------- | --------------------------------------------------- |
| `ADMIN_USER_IDS`                  | (rỗng = tất cả đều là admin) | Danh sách Telegram user ID được phép điều khiển bot |
| `TWITTER_API_KEY/SECRET`          | —                            | OAuth 1.0a để like tweet                            |
| `TWITTER_ACCESS_TOKEN/SECRET`     | —                            | OAuth 1.0a access token                             |
| `TWITTER_USERNAME/PASSWORD/EMAIL` | —                            | Thông tin đăng nhập trình duyệt                     |
| `TWITTER_BEARER_TOKEN`            | —                            | Dùng để crawl tweet qua API                         |
| `DEEPSEEK_API_KEY`                | —                            | API key cho DeepSeek AI                             |
| `DEEPSEEK_MODEL`                  | `deepseek-chat`              | Model DeepSeek sử dụng                              |
| `COMMENTS_PER_HOUR_MIN`           | `5`                          | Số comment tối thiểu mỗi giờ                        |
| `COMMENTS_PER_HOUR_MAX`           | `8`                          | Số comment tối đa mỗi giờ                           |
| `COMMENT_DELAY_MIN_MS`            | `60000` (1 phút)             | Thời gian chờ tối thiểu giữa 2 comment              |
| `COMMENT_DELAY_MAX_MS`            | `180000` (3 phút)            | Thời gian chờ tối đa giữa 2 comment                 |
| `PROXY_SERVER`                    | —                            | Proxy cho trình duyệt (http:// hoặc socks5://)      |
| `CRAWL_EMPTY_WAIT`                | `300` (5 phút)               | Thời gian chờ khi không tìm thấy tweet mới (giây)   |
| `DISABLE_TIMESLOT`                | `false`                      | Tắt giới hạn giờ hoạt động (bật 24/7)               |

### Feature flags (computed)

- `config.hasTwitter` — true nếu đủ 4 OAuth credentials.
- `config.hasBearerToken` — true nếu có Bearer Token.
- `config.hasDeepSeek` — true nếu có DeepSeek API key.

---

## 3. Scheduler — `src/scheduler/`

### 3.1 Time Slots — `timeslots.ts`

Định nghĩa khung giờ bot được phép hoạt động. Hiện tại chỉ có 1 slot:

| Slot ID         | Nhãn          | Giờ GMT+7   | Tương đương     |
| --------------- | ------------- | ----------- | --------------- |
| `en_us_morning` | 🇺🇸 US Morning | 02:00–05:00 | 07:00–11:00 EST |

**Các hàm chính:**

- `getHourGmt7()` — trả về giờ hiện tại theo múi giờ GMT+7.
- `getActiveSlots()` — trả về danh sách slot đang trong giờ hoạt động. Nếu `DISABLE_TIMESLOT=true`, trả về tất cả slot bất kể giờ.
- `getMonitorState()` — trả về trạng thái hoạt động + interval crawl (mặc định 5 phút khi active).
- `formatTimeSlotsTable()` — trả về chuỗi text mô tả lịch hoạt động để hiển thị trong Telegram.

### 3.2 Main Scheduler — `index.ts`

#### Vòng lặp chính (Main Loop)

Bot chạy vòng lặp liên tục, mỗi iteration:

1. **Kiểm tra monitor có bị tắt thủ công không** — nếu có, ngủ 60 giây rồi lặp lại.
2. **Kiểm tra có đang trong giờ hoạt động không** — nếu ngoài giờ, ngủ 60 giây rồi lặp lại.
3. **Đăng nhập Twitter** — gọi `ensureLogin()`. Nếu thất bại, thử lại sau 30 giây.
4. **Crawl tweet mới** — gọi `monitorAccounts("en")` để lấy tweet mới từ tất cả tài khoản đang theo dõi.
5. **Nếu không có tweet mới** — chờ `CRAWL_EMPTY_WAIT` giây (mặc định 5 phút) rồi crawl lại.
6. **Nếu có tweet mới** — với mỗi slot đang active:
   - Kiểm tra quota giờ hiện tại.
   - Nếu quota đã hết, chờ đến đầu giờ tiếp theo rồi tiếp tục.
   - Lấy danh sách tweet `pending` trong DB (theo thứ tự mới nhất).
   - Comment từng tweet một, giữa mỗi tweet có delay ngẫu nhiên (1–3 phút).
   - Khi quota giờ đạt giới hạn, dừng slot đó.
7. **Sau khi xong tất cả slot** — crawl lại ngay (không ngủ).

#### Quản lý monitor

- `enableMonitor()` / `disableMonitor()` — bật/tắt monitor thủ công (dùng qua lệnh Telegram).
- `isMonitorEnabled()` — trả về trạng thái hiện tại.

#### Watcher độc lập

Khi scheduler khởi động, `startWatcher()` được gọi song song — Watcher chạy độc lập mỗi 1 giờ, không phụ thuộc vào giờ hoạt động của scheduler.

#### Trigger thủ công

- `triggerMonitor()` — chạy crawl ngay lập tức (dùng khi admin ra lệnh `/monitornow`).
- `triggerComment()` — chạy một vòng comment ngay lập tức (dùng khi admin ra lệnh `/commentnow`).

---

## 4. Monitor — `src/monitor/twitter-monitor.ts`

### Chức năng crawl tweet

Crawl tweet mới từ tất cả tài khoản đang active, dùng **Twitter Bearer Token** (read-only, không cần login).

#### Các hằng số

| Hằng                  | Giá trị | Ý nghĩa                               |
| --------------------- | ------- | ------------------------------------- |
| `MAX_TWEET_AGE_HOURS` | 6       | Bỏ qua tweet cũ hơn 6 giờ             |
| `MIN_TWEET_LENGTH`    | 15      | Bỏ qua tweet ngắn hơn 15 ký tự        |
| `PARALLEL_LIMIT`      | 5       | Số tài khoản crawl song song cùng lúc |

#### Bộ nhớ cache in-memory

- `sinceIdCache` — lưu `since_id` theo handle (tránh query DB mỗi cycle).
- `userIdCache` — lưu `userId` Twitter theo handle.

#### Luồng xử lý cho từng tài khoản (`monitorOne`)

1. **Resolve userId** — tìm trong cache → DB → Twitter API. Nếu tài khoản không tồn tại, tự động `isActive = false`.
2. **Lấy since_id** — lần đầu tiên crawl, chỉ lưu mốc tweet mới nhất, không comment tweet cũ.
3. **Fetch tweet mới** — lấy tối đa 10 tweet mới hơn `since_id`, bao gồm `public_metrics`.
4. **Lọc tweet không hợp lệ** — bỏ qua nếu: quá ngắn, quá cũ, hoặc chỉ toàn URL không có nội dung.
5. **Cập nhật since_id** — luôn cập nhật mốc kể cả khi tất cả tweet bị lọc (tránh crawl lại).
6. **Sắp xếp theo engagement** — ưu tiên tweet nhiều like + reply trước.
7. **Batch check DB** — một query duy nhất kiểm tra tweetId nào đã có trong DB.
8. **Insert vào DB** — chỉ insert các tweet chưa tồn tại, bỏ qua lỗi duplicate (race condition).

#### Xử lý rate limit

Nếu nhận lỗi 429 từ Twitter API, tính thời gian chờ theo header `reset` và nghỉ đúng thời gian đó trước khi tiếp tục.

#### Cache invalidation

`clearMonitorCache(handle?)` — xóa cache của một hoặc tất cả tài khoản (gọi tự động khi thêm/xóa account qua Telegram).

---

## 5. Commenter — `src/commenter/twitter-commenter.ts`

### Đăng comment bằng trình duyệt

Dùng **Playwright** (Chromium headless) để điều khiển trình duyệt đăng reply, thay vì Twitter API (để tránh giới hạn API).

#### Quản lý session trình duyệt

- Chỉ khởi tạo browser một lần (singleton), tái sử dụng qua các lần comment.
- Hỗ trợ proxy qua `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD`.
- User-agent được giả lập là Chrome 122 trên Windows để tránh bị phát hiện automation.

#### Hệ thống cookie

Bot ưu tiên dùng cookie thay vì đăng nhập bằng username/password mỗi lần:

1. **Tải cookie từ file** `twitter-cookies.json` — nếu file tồn tại và còn hạn.
2. **Xác minh cookie** — truy cập `x.com/home`, nếu redirect về `/home` thì cookie còn hợp lệ.
3. **Fallback đăng nhập** — nếu cookie hết hạn hoặc không có, đăng nhập bằng `TWITTER_USERNAME`/`TWITTER_PASSWORD`.
4. **Xử lý xác minh bổ sung** — nếu Twitter hỏi thêm email, dùng `TWITTER_EMAIL`.
5. **Lưu cookie mới** sau mỗi lần đăng nhập và sau mỗi lần comment thành công.

#### Luồng đăng comment (`postReply`)

1. Mở URL tweet: `https://x.com/i/web/status/{tweetId}`.
2. Bấm nút Reply.
3. Gõ nội dung comment vào textarea (type với delay 30ms/ký tự để giống người thật).
4. Lắng nghe response `CreateTweet` từ network để lấy ID của tweet vừa đăng.
5. Bấm nút Submit.
6. Trả về ID tweet comment (nếu không lấy được từ network, trả về `browser_{timestamp}`).

Nếu reply thất bại lần đầu, bot tự động re-login và thử lại một lần nữa.

#### Hệ thống quota

- Mỗi giờ, bot chọn ngẫu nhiên một số giới hạn trong khoảng `COMMENTS_PER_HOUR_MIN`–`COMMENTS_PER_HOUR_MAX` (mặc định 5–8). Giới hạn này cố định trong suốt giờ đó.
- `checkQuota(slot)` — trả về số comment đã đăng trong giờ hiện tại, số còn lại, và giới hạn. Scheduler dựa vào đây để quyết định có comment tiếp không.

#### Luồng comment một tweet (`commentOneTweet`)

1. **Lock tweet** — cập nhật status từ `pending` → `processing` (atomic update, tránh race condition).
2. **Sinh comment** — gọi `generateComment()`.
3. **Đăng comment** — gọi `postReply()`.
4. **Lưu kết quả** — transaction: cập nhật `MonitoredTweet.status = "commented"` + tạo record `PostedComment`.

#### Thống kê (`getCommentStats`)

Trả về:

- Tổng số comment hôm nay.
- Số comment hôm nay theo từng slot.
- Tổng số comment mọi thời điểm.

---

## 6. Generator — `src/generator/comment-generator.ts`

### Sinh comment bằng DeepSeek AI

Gọi DeepSeek API (tương thích OpenAI SDK) để tạo nội dung comment.

#### System prompt (tiếng Anh)

Bot được cấu hình để viết comment theo phong cách **nhà bình luận tài chính/địa chính trị sắc sảo trên Twitter**, với chiến lược cụ thể:

- **Mở đầu bằng hook**: góc nhìn trái chiều, hàm ý bất ngờ, hoặc nhận định đanh thép. Không mở đầu bằng "Great point", "Interesting", hoặc nhắc lại tweet.
- **Có quan điểm rõ ràng**: không trung lập. Dùng góc độ như "What this actually means is...", "Everyone's missing the real story here..."
- **Kích thích tương tác**: kết bằng dự đoán táo bạo, câu hỏi khiêu khích, hoặc hàm ý sắc bén.
- **Thay đổi phong cách mỗi lần**: xen kẽ giữa góc nhìn trái chiều / dữ liệu bất ngờ / dự đoán / câu hỏi tu từ.

**Giới hạn định dạng:** tối đa 220 ký tự, tối đa 2 emoji, không có URL/mention/hashtag.

#### Tham số AI

- Model: `deepseek-chat` (hoặc cấu hình qua `DEEPSEEK_MODEL`).
- Temperature: 0.9 (sáng tạo cao).
- Max tokens: 300.

Nếu kết quả vượt 240 ký tự, tự động cắt bớt và thêm dấu `…`.

---

## 7. Watcher — `src/watcher/`

### 7.1 Post Watcher — `post-watcher.ts`

Theo dõi người dùng comment vào các bài tweet của chính mình, sau đó tự động đến trang của họ và comment lại bài viết mới nhất.

#### Chức năng Twitter API

- **`fetchNewCommenters(watchedPostId)`** — dùng Twitter Search API tìm tất cả reply mới trong conversation của bài tweet được theo dõi (lọc theo `since_id` để không lấy lại comment cũ). Trả về danh sách `{commentId, commenterHandle, commenterUserId}`.
- **`getLatestTweetOfUser(userId)`** — lấy tweet gốc mới nhất (không phải retweet, không phải reply) của một user. Trả về `{tweetId, text, handle}`.
- **`likeTweet(tweetId)`** — like tweet bằng OAuth 1.0a. Nếu đã like rồi (lỗi 403) thì coi như thành công.
- **`extractTweetId(url)`** — trích xuất tweet ID từ URL `x.com` hoặc `twitter.com`.

### 7.2 Watcher Cycle — `watcher-cycle.ts`

#### Chu kỳ kiểm tra (mỗi 1 giờ)

Một chu kỳ thực hiện:

1. Lấy danh sách tất cả `WatchedPost` đang active.
2. Với mỗi bài: gọi `fetchNewCommenters()`, lọc ra những người chưa được xử lý (check DB `WatcherReaction`).
3. Gom tất cả người comment mới từ tất cả bài.
4. Đăng nhập Twitter.
5. Với mỗi người comment mới:
   - Lấy tweet mới nhất của họ.
   - Sinh comment AI từ nội dung tweet đó.
   - Đăng comment qua Playwright.
   - Like tweet của họ qua API.
   - Lưu kết quả vào `WatcherReaction`.
   - Delay 3–10 phút trước khi xử lý người tiếp theo.
6. Ngủ cho đến khi đủ 1 giờ, rồi kiểm tra lại.

Watcher hoạt động **độc lập**, không bị ảnh hưởng bởi giờ hoạt động của scheduler chính.

### 7.3 Urgent Commenter — `urgent-commenter.ts`

Cho phép admin ra lệnh comment **ngay lập tức** mà không cần đợi scheduler, theo 2 cách:

- **`urgentCommentUrls(input, onProgress)`** — nhận danh sách URL tweet trực tiếp, sinh comment AI và đăng ngay lên từng URL đó. Báo cáo tiến độ qua callback.
- **`urgentCommentAccounts(input, onProgress)`** — nhận danh sách @handle, lấy tweet mới nhất của từng người, rồi comment ngay.

Chỉ cho phép một urgent job chạy tại một thời điểm (`isUrgentRunning()` để kiểm tra).

---

## 8. Quoter — `src/quoter/quote-tweeter.ts`

### Đăng Quote Tweet

Cho phép đăng quote tweet (retweet kèm bình luận) thông qua Playwright, có thể hẹn giờ hoặc đăng ngay.

#### Quản lý job

Các job được lưu trong bộ nhớ (Map), không lưu vào DB:

- `createJob(partial)` — tạo job mới với status `pending`.
- `getJob(id)` — lấy thông tin job theo ID.
- `updateJob(id, patch)` — cập nhật trạng thái job.

#### Hai chế độ nội dung

- `contentMode: "manual"` — nội dung do admin nhập thủ công.
- `contentMode: "ai"` — nội dung do AI sinh từ nội dung tweet gốc.

#### Luồng đăng Quote Tweet (`postQuoteTweet`)

1. Mở URL tweet gốc.
2. Click nút Retweet → Click "Quote".
3. Gõ nội dung vào textarea.
4. Nếu có `mediaPath`, upload file ảnh/video đính kèm.
5. Click Submit, lắng nghe response để lấy ID tweet mới.

Hỗ trợ hẹn giờ: nếu `scheduledAt` được cung cấp, bot chờ đúng thời điểm rồi mới đăng.

---

## 9. Topic Scanner — `src/scanner/topic-scanner.ts`

### Quét link X.com từ Telegram Groups

Bot lắng nghe tin nhắn trong các topic của Telegram Supergroup, cache lại các link X.com/Twitter tìm thấy, sau đó cho phép admin truy vấn theo khung giờ.

#### Cache in-memory

Bot chỉ cache tin nhắn có chứa link X.com (tiết kiệm RAM). Cache được giữ tối đa 24 giờ, tự động dọn dẹp mỗi 1 giờ. Giới hạn 1000 tin nhắn mỗi topic.

#### Các hàm DB

- `addGroup(chatId, name)` — đăng ký một Telegram group để theo dõi.
- `addTopic(chatId, threadId, name)` — thêm một topic (thread) trong group vào danh sách theo dõi.
- `removeTopic(chatId, threadId)` — tắt theo dõi một topic.
- `removeGroup(chatId)` — tắt theo dõi toàn bộ group.
- `getAllGroups()` — lấy tất cả group và topic đang active.

#### Hàm quét chính (`scanTopics`)

Nhận `chatId`, danh sách `threadId` (hoặc rỗng = tất cả), `fromTime` và `toTime` (định dạng HH:MM). Trả về danh sách link X.com tìm thấy trong cache, theo từng topic.

#### `extractXLinks(text)`

Trích xuất tất cả URL từ một đoạn text, lọc chỉ lấy URL có `/status/` (URL tweet cụ thể), loại bỏ trùng lặp.

---

## 10. Telegram Bot — `src/bot/telegram-bot.ts`

### Bảng lệnh đầy đủ

Tất cả lệnh chỉ cho phép admin (được cấu hình qua `ADMIN_USER_IDS`). Nếu không cấu hình, mọi user đều có quyền.

#### Quản lý tài khoản theo dõi

| Lệnh             | Tham số         | Chức năng                                                                           |
| ---------------- | --------------- | ----------------------------------------------------------------------------------- |
| `/addaccount`    | `@handle [tên]` | Thêm tài khoản Twitter vào danh sách theo dõi. Nếu đã tồn tại thì kích hoạt lại.    |
| `/removeaccount` | `@handle`       | Tắt theo dõi tài khoản (đặt `isActive = false`).                                    |
| `/accounts`      | —               | Hiển thị toàn bộ danh sách tài khoản đang theo dõi, kèm trạng thái active/inactive. |

#### Theo dõi bài tweet của mình (Watcher)

| Lệnh              | Tham số         | Chức năng                                                                                                                  |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/watchpost`      | `<url> [label]` | Thêm một URL tweet của mình vào danh sách theo dõi. Bot sẽ tự động comment lại vào trang của những ai comment vào bài này. |
| `/unwatchpost`    | `<url>`         | Dừng theo dõi một bài tweet.                                                                                               |
| `/watchedposts`   | —               | Liệt kê các bài đang được theo dõi kèm số lần đã phản ứng.                                                                 |
| `/watcherhistory` | —               | Xem 20 phản ứng gần nhất của watcher (ai đã được comment lại, trạng thái, nội dung).                                       |
| `/watchernow`     | —               | Chạy ngay một chu kỳ watcher mà không cần đợi 1 giờ.                                                                       |

#### Comment khẩn cấp (Urgent)

| Lệnh               | Tham số                                 | Chức năng                                                         |
| ------------------ | --------------------------------------- | ----------------------------------------------------------------- |
| `/commenturls`     | Danh sách URL (mỗi dòng một URL)        | Comment ngay vào các URL tweet được liệt kê, không đợi scheduler. |
| `/commentaccounts` | Danh sách @handle (mỗi dòng một handle) | Lấy tweet mới nhất của từng account rồi comment ngay.             |

Chỉ một urgent job được chạy tại một thời điểm. Nếu đang chạy, bot thông báo và từ chối lệnh mới.

#### Quote Tweet

| Lệnh          | Tham số         | Chức năng                                                                                                                    |
| ------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/quotetweet` | `<url> [HH:MM]` | Quote tweet URL đã cho. Nếu có `HH:MM`, hẹn giờ đăng. Nếu không, đăng ngay. Bot sẽ hỏi chọn AI-generated hay manual content. |

#### Thống kê & điều khiển

| Lệnh          | Chức năng                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/status`     | Hiển thị tổng quan: slot đang active, số tài khoản theo dõi, tweet đang pending, số comment hôm nay và mọi thời điểm. |
| `/timeslots`  | Hiển thị bảng các khung giờ hoạt động.                                                                                |
| `/history`    | Xem 20 comment gần nhất đã đăng (nội dung, tài khoản, thời gian).                                                     |
| `/monitornow` | Crawl tweet ngay lập tức.                                                                                             |
| `/commentnow` | Chạy vòng comment ngay (chỉ hoạt động nếu đang trong giờ active).                                                     |
| `/monitoron`  | Bật lại monitor nếu đã tắt thủ công.                                                                                  |
| `/monitoroff` | Tắt monitor thủ công (bot dừng crawl & comment cho đến khi bật lại).                                                  |
| `/logs`       | Xem 30 dòng log gần nhất từ DB.                                                                                       |

#### Quản lý Topic Scanner

| Lệnh           | Tham số                                 | Chức năng                                                                                                                    |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/addgroup`    | `<chat_id> <tên>`                       | Đăng ký Telegram group để bot lắng nghe link. Chat ID là số âm dạng `-100xxxxxxxxxx`.                                        |
| `/removegroup` | `<chat_id>`                             | Xóa group khỏi danh sách theo dõi.                                                                                           |
| `/addtopic`    | `<chat_id> <thread_id> <tên>`           | Thêm một topic cụ thể trong group.                                                                                           |
| `/removetopic` | `<chat_id> <thread_id>`                 | Xóa một topic.                                                                                                               |
| `/listtopics`  | —                                       | Liệt kê tất cả group và topic đang theo dõi, kèm số link đang cache.                                                         |
| `/detecttopic` | —                                       | Gửi lệnh này **bên trong topic** để bot tự động trả về `chat_id` và `thread_id` của topic đó.                                |
| `/scantopics`  | `<chat_id> HH:MM HH:MM [thread_ids...]` | Quét tất cả link X.com trong cache của group/topic từ giờ này đến giờ kia. Nếu không truyền `thread_ids`, quét tất cả topic. |

---

## 11. Database Schema

### Các bảng chính

| Bảng              | Mô tả                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| `TargetAccount`   | Tài khoản Twitter đang được theo dõi để crawl tweet.                                 |
| `MonitoredTweet`  | Tweet đã phát hiện, lưu trạng thái xử lý (`pending / commented / skipped / failed`). |
| `PostedComment`   | Comment đã đăng thành công, kèm nội dung, slot, thời gian.                           |
| `WatchedPost`     | Bài tweet của mình được theo dõi để phản ứng với người comment.                      |
| `WatcherReaction` | Phản ứng với từng người đã comment vào bài mình.                                     |
| `TelegramGroup`   | Telegram group đã đăng ký để quét link.                                              |
| `TelegramTopic`   | Topic trong group đã đăng ký.                                                        |
| `Setting`         | Key-value store dạng chung (lưu `since_id` của từng tài khoản, v.v.).                |
| `Log`             | Log hệ thống (level, module, message, timestamp).                                    |

### Trạng thái vòng đời của tweet

```
[Crawl] → pending → processing → commented ✅
                              ↘ failed ❌
                   → skipped ⏭
```

---

## 12. Logger — `src/utils/logger.ts`

Ghi log ra console và lưu vào bảng `Log` trong DB. Mỗi entry gồm `level` (info/warn/error), `module` (tên module gọi), `message`, và `createdAt`. Lệnh `/logs` trong Telegram hiển thị 30 entry gần nhất.
