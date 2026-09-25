FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts react-router.config.ts ./
COPY src ./src
COPY app ./app
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.14.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY server.mjs ./
RUN mkdir -p /var/lib/favor && chown node:node /var/lib/favor && chmod 700 /var/lib/favor
USER node
CMD ["/bin/sh", "-c", "umask 077; exec node server.mjs"]
