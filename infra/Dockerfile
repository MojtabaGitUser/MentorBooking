FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --no-fund --no-audit

FROM dependencies AS api
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY infra/db infra/db
RUN npm run build -w @mentor/api
CMD ["sh", "-ec", "node infra/db/bootstrap.mjs migrate && exec node apps/api/dist/main.js"]

FROM dependencies AS web
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @mentor/web
WORKDIR /app/apps/web
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0"]
