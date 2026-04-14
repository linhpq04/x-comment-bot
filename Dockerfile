# ── Stage 1: Build TypeScript ──────────────────────────────
FROM node:22 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ── Stage 2: Install prod deps + Playwright ────────────────
FROM node:22 AS installer
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
RUN npm run db:generate
RUN npx playwright install --with-deps chromium

# ── Stage 3: Runner ────────────────────────────────────────
FROM node:22 AS runner
WORKDIR /app

RUN groupadd --system --gid 1001 botuser && \
    useradd --system --uid 1001 --gid 1001 botuser && \
    mkdir -p /data /home/botuser/.cache && \
    chown -R botuser:botuser /data /home/botuser/.cache

COPY --from=installer /app .
COPY --from=installer /root/.cache/ms-playwright /home/botuser/.cache/ms-playwright
RUN chown -R botuser:botuser /app /home/botuser/.cache

USER botuser

# db:push tạo/migrate SQLite lúc start, rồi chạy app
CMD ["sh", "-c", "npm run db:push && npm start"]