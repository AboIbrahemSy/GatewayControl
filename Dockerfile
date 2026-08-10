# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS web-dependencies
WORKDIR /build/web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM web-dependencies AS web-build
COPY index.html postcss.config.js tailwind.config.js tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS server-dependencies
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM server-dependencies AS server-build
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_ROOT=/app/public
WORKDIR /app/server
RUN apk add --no-cache ca-certificates dumb-init postgresql17-client tar
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=server-build /build/server/dist ./dist
COPY server/migrations ./migrations
COPY --from=web-build /build/web/dist /app/public
COPY docker/control-plane-entrypoint.sh /usr/local/bin/control-plane-entrypoint
RUN chmod 0755 /usr/local/bin/control-plane-entrypoint \
    && chown -R node:node /app
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/control-plane-entrypoint"]
