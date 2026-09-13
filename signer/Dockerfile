# Self-hosted signer gateway (spec 2.1). Runs on the VPS next to the
# Playwright posting worker.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN corepack enable && npm install --no-save tsx typescript fastify puppeteer-core
COPY tsconfig.json ./
COPY src ./src

ENV PORT=8788 \
    CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    SIGNER_HEADLESS=1 \
    SIGNER_PAGE_POOL_SIZE=2

EXPOSE 8788
CMD ["npx", "tsx", "src/index.ts"]
