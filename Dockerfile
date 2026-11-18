FROM scratch AS npm_cache
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg zip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=bind,from=npm_cache,target=/tmp/npm-cache \
    if [ -d /tmp/npm-cache/_cacache ]; then mkdir -p /root/.npm && cp -R /tmp/npm-cache/_cacache /root/.npm/ && export npm_config_offline=true; fi \
    && npm ci --omit=dev --no-audit --no-fund --fetch-retries=1 --fetch-timeout=20000 \
    && mkdir -p /var/data/ai-bridge \
    && chown -R node:node /app /var/data/ai-bridge \
    && rm -rf /root/.npm
COPY --chown=node:node docker-start.mjs local-server.mjs media-bridge.mjs media-store.mjs cloud-control.mjs cloud-objects.mjs prompt-instructions.mjs tool-calls.mjs ai-bridge.settings.json ./
COPY --chown=node:node extension ./extension
COPY --chown=node:node prompt-instructions ./prompt-instructions
COPY --chown=node:node cloud-ui ./cloud-ui
ENV NODE_ENV=production BRIDGE_MODE=cloud BRIDGE_DATA_DIR=/var/data/ai-bridge
EXPOSE 10000
CMD ["node", "docker-start.mjs"]
