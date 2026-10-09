# Card-art mock backend (server.mjs) — the fast pipeline (one Gemini call) plus the Python cut-out for the 2.5D portrait.
# Build context = tools/cardgen. Steps and platform files: DEPLOY.md.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages rembg onnxruntime "pillow<12" numpy
# bake the segmentation model (179 MB) so the first card never waits for a download
ENV U2NET_HOME=/opt/cardgen-models
RUN python3 -c "from rembg import new_session; new_session('isnet-general-use')"
WORKDIR /app
COPY --chown=node:node prompts.md server.mjs server-config.mjs serial-task-queue.mjs ./
COPY --chown=node:node harness ./harness
COPY --chown=node:node refs ./refs
RUN mkdir -p /app/out/server-cache && chown -R node:node /app/out
ARG CARD_SOURCE_REVISION=unversioned
LABEL org.opencontainers.image.source="https://github.com/DonutLabs-ai/kol-identity-h5" \
      org.opencontainers.image.revision=$CARD_SOURCE_REVISION
ENV CARD_SOURCE_REVISION=$CARD_SOURCE_REVISION
ENV HOST=0.0.0.0 PORT=3022 CARD_PIPELINE=fast NODE_ENV=production
USER node
EXPOSE 3022
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3022/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
