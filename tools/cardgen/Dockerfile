# Card-art worker: Gemini image, AWS foreground, lightweight Python plate.
# Build context = tools/cardgen. Steps and platform files: DEPLOY.md.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages "pillow==11.3.0"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node prompts.md server.mjs worker.mjs server-config.mjs serial-task-queue.mjs bedrock-cutout.mjs openrouter-image.mjs job-queue.mjs card-art-service.mjs ./
COPY --chown=node:node harness ./harness
COPY --chown=node:node refs ./refs
RUN mkdir -p /app/out/server-cache && chown -R node:node /app/out
ARG CARD_SOURCE_REVISION=unversioned
LABEL org.opencontainers.image.source="https://github.com/DonutLabs-ai/kol-identity-h5" \
      org.opencontainers.image.revision=$CARD_SOURCE_REVISION
ENV CARD_SOURCE_REVISION=$CARD_SOURCE_REVISION
ENV HOST=0.0.0.0 PORT=3022 CARD_PIPELINE=fast NODE_ENV=production
USER node
RUN python3 -c "from PIL import Image, ImageFilter, ImageStat"
EXPOSE 3022
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3022/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "worker.mjs"]
