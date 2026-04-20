# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
WORKDIR /app

# Full deps (includes tsx, typescript, @types/*) for the build stage.
FROM base AS deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Prod-only deps for the runtime stage. Runs in parallel with `build` under BuildKit.
FROM base AS prod-deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Compile TypeScript → dist/.
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Slim runtime: prod node_modules + compiled JS + config.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist          ./dist
COPY                  package.json       ./package.json

USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
