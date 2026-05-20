FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3847
ENV TAB_SWITCH_LOG_PATH=/data/tab-switch-log.jsonl
ENV TAB_EVENT_LOG_PATH=/data/tabcoach-events.jsonl

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 3847

CMD ["node", "dist/index.js"]

