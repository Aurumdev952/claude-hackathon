FROM node:22-slim AS build
# pnpm is the frontend package manager (version pinned by "packageManager" in frontend/package.json)
RUN corepack enable
WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend .
# widget contract shared with the agent backend (frontend alias @agent/widgets -> ../agent/src/widgets/specs.ts)
COPY agent/src/widgets /app/agent/src/widgets
RUN pnpm build

FROM nginx:1.27-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
