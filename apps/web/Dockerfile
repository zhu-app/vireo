FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps ./apps
RUN npm ci --no-audit --no-fund && npm run build -w @vireo/web

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
