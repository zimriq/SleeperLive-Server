FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.js ./
ENV NODE_ENV=production
CMD ["node", "server.js"]
