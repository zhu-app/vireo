FROM node:24-alpine AS deps
WORKDIR /app
# 用 lockfile 做确定性安装，避免 ^ 范围在构建时漂移
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
# 非 root 运行（Alpine 无 groupadd/useradd，须用 busybox 的 addgroup/adduser）
RUN addgroup -S nodeapp && adduser -S -D -G nodeapp nodeapp
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/api ./apps/api
RUN mkdir -p /app/data && chown -R nodeapp:nodeapp /app
USER nodeapp
EXPOSE 8080
VOLUME /app/data
CMD ["node", "apps/api/src/index.js"]
