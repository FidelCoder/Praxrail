FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apk add --no-cache git && corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/client/package.json ./packages/client/package.json
COPY packages/cli/package.json ./packages/cli/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apk add --no-cache git && corepack enable && addgroup -S praxrail && adduser -S -G praxrail praxrail
WORKDIR /app
RUN mkdir -p /app/.praxrail/workspaces /app/.praxrail/repositories \
    && chown -R praxrail:praxrail /app/.praxrail \
    && chmod -R 0700 /app/.praxrail
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/migrations ./migrations
COPY package.json ./
USER praxrail
EXPOSE 3000
CMD ["node", "dist/index.js"]
