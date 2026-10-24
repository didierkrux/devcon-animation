FROM node:22-bookworm-slim

# Shared libraries Remotion's headless Chrome needs on Debian.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libxrandr2 \
      libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
      libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
RUN pnpm exec remotion browser ensure

COPY . .

# Database, cards, renders: mount a persistent volume here.
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data

# SYNC_EVERY_MINUTES (default 30) sets the schedule.
CMD ["sh", "-c", "exec pnpm sync --every ${SYNC_EVERY_MINUTES:-30}"]
