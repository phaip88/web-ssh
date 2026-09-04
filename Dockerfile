# syntax=docker/dockerfile:1.7
# Multi-stage, non-root, minimal runtime image (standalone output not used so
# `next start` keeps the instrumentation hook + pg/ssh2 externals intact).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build --chown=nonroot:nonroot /app/package.json ./package.json
COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/.next ./.next
COPY --from=build --chown=nonroot:nonroot /app/public ./public
COPY --from=build --chown=nonroot:nonroot /app/next.config.ts ./next.config.ts
COPY --from=build --chown=nonroot:nonroot /app/drizzle ./drizzle
COPY --from=build --chown=nonroot:nonroot /app/drizzle.config.json ./drizzle.config.json
USER nonroot
EXPOSE 3000
# Distroless has no shell; healthchecks are performed by the orchestrator (compose/k8s probes).
CMD ["node_modules/next/dist/bin/next", "start", "-p", "3000"]
