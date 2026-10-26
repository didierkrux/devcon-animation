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

# SYNC_EVERY_MINUTES (default 30) sets the schedule; POST /run on PORT starts
# a run on demand (needs TRIGGER_TOKEN, see scripts/lib/server.ts).
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "exec pnpm sync --every ${SYNC_EVERY_MINUTES:-30} --port ${PORT}"]
