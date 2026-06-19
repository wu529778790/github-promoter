FROM node:22-alpine AS base

# --- Build stage ---
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Production stage ---
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# 创建非 root 用户
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/config ./config

# 创建数据和日志目录
RUN mkdir -p /app/data /app/logs && \
    chown -R appuser:appgroup /app/data /app/logs

USER appuser

# 健康检查（定期检查进程是否存活）
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD pgrep -f "node.*dist" > /dev/null || exit 1

CMD ["node", "dist/index.js"]
