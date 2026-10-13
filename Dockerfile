FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/extractor && /opt/extractor/bin/pip install --no-cache-dir yt-dlp
ENV PATH="/opt/extractor/bin:${PATH}"
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 10000
CMD ["node", "server.mjs"]
