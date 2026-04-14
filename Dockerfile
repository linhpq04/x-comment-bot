# ── Stage 1: Build TypeScript ──────────────────────────────
FROM node:22-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ── Stage 2: Install prod deps + Playwright Chromium ───────
FROM node:22-slim AS installer
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
RUN npm run db:generate
RUN PLAYWRIGHT_BROWSERS_PATH=/pw-browsers \
    npx playwright install --with-deps chromium && \
    rm -rf /pw-browsers/chromium_headless_shell-* \
           /pw-browsers/ffmpeg-* && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# ── Stage 3: Runner (slim) ─────────────────────────────────
FROM node:22-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 botuser && \
    useradd --system --uid 1001 --gid 1001 botuser && \
    mkdir -p /home/botuser/.cache/ms-playwright && \
    chown -R botuser:botuser /home/botuser

WORKDIR /app

COPY --from=installer --chown=botuser:botuser /app .
COPY --from=installer --chown=botuser:botuser /pw-browsers /home/botuser/.cache/ms-playwright

ENV PLAYWRIGHT_BROWSERS_PATH=/home/botuser/.cache/ms-playwright

CMD ["sh", "-c", "mkdir -p /data && npm run db:push && npm start"]