# Card-art mock backend (server.mjs) — the fast pipeline (one Gemini call) plus the Python cut-out for the 2.5D portrait.
# Build context = tools/cardgen. Steps and platform files: DEPLOY.md.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages rembg onnxruntime "pillow<12" numpy
# bake the segmentation model (179 MB) so the first card never waits for a download
RUN python3 -c "from rembg import new_session; new_session('isnet-general-use')"
WORKDIR /app
COPY prompts.md server.mjs ./
COPY harness ./harness
COPY refs ./refs
ENV HOST=0.0.0.0 PORT=3022 CARD_PIPELINE=fast NODE_ENV=production
EXPOSE 3022
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3022/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
