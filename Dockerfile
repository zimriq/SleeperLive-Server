FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.js ./
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch(\"http://127.0.0.1:\" + (process.env.PORT ?? 3000) + \"/health\", {signal: AbortSignal.timeout(4000)}).then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
