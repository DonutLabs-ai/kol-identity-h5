# Card-art worker: Gemini image, resident IS-Net CPU foreground, Python plate.
# Build context = tools/cardgen. Steps and platform files: DEPLOY.md.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages "pillow==11.3.0" "rembg[cpu]==2.0.69" "onnxruntime==1.31.0"
# QEMU's detected ARM features differ from Graviton. Use the same portable
# compilation target at build and runtime so startup can load the baked cache.
ENV U2NET_HOME=/opt/cardgen-models NUMBA_CACHE_DIR=/opt/cardgen-numba NUMBA_CPU_NAME=generic OMP_NUM_THREADS=2
RUN mkdir -p "$U2NET_HOME" "$NUMBA_CACHE_DIR" && chown -R node:node "$U2NET_HOME" "$NUMBA_CACHE_DIR"
ADD --chown=node:node --checksum=sha256:60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx /opt/cardgen-models/isnet-general-use.onnx
USER node
RUN python3 -c "from rembg import new_session; new_session('isnet-general-use', providers=['CPUExecutionProvider'])"
USER root
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node prompts.md server.mjs worker.mjs server-config.mjs serial-task-queue.mjs bedrock-cutout.mjs isnet-cutout.mjs openrouter-image.mjs job-queue.mjs card-art-service.mjs ./
COPY --chown=node:node harness ./harness
COPY --chown=node:node refs ./refs
RUN mkdir -p /app/out/server-cache && chown -R node:node /app/out
ARG CARD_SOURCE_REVISION=unversioned
LABEL org.opencontainers.image.source="https://github.com/DonutLabs-ai/kol-identity-h5" \
      org.opencontainers.image.revision=$CARD_SOURCE_REVISION
ENV CARD_SOURCE_REVISION=$CARD_SOURCE_REVISION
ENV HOST=0.0.0.0 PORT=3022 CARD_PIPELINE=fast CARD_CUTOUT_PROVIDER=isnet NODE_ENV=production
USER node
RUN python3 -c "from PIL import Image, ImageFilter, ImageStat"
EXPOSE 3022
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3022/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "worker.mjs"]
