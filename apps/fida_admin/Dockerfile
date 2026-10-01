# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --fund=false

FROM dependencies AS build
WORKDIR /app
ARG CORE_API_INTERNAL_URL=http://nestjs-core-api:3000
ARG NEXT_PUBLIC_ADMIN_STREAM_URL=ws://127.0.0.1:8090/admin/stream
ARG NEXT_PUBLIC_MAP_STYLE_URL=https://demotiles.maplibre.org/style.json
ENV CORE_API_INTERNAL_URL=${CORE_API_INTERNAL_URL}
ENV NEXT_PUBLIC_ADMIN_STREAM_URL=${NEXT_PUBLIC_ADMIN_STREAM_URL}
ENV NEXT_PUBLIC_MAP_STYLE_URL=${NEXT_PUBLIC_MAP_STYLE_URL}
COPY . .
RUN mkdir -p public && npm run typecheck && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
