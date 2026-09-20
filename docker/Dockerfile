# 소문: 컨테이너 하나. Node 서버가 API와 정적 웹을 함께 서빙, SQLite는 /data 볼륨.
#   docker build -f docker/Dockerfile -t somun .
#   docker run -p 8790:8790 -v somun-data:/data -e SOMUN_TOKEN=... -e GITHUB_TOKEN=... -e GEMINI_API_KEYS='{"free-1":"..."}' somun
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_AUTH_URL
ARG VITE_AUTH_AUDIENCE=somun
ENV VITE_AUTH_URL=${VITE_AUTH_URL} VITE_AUTH_AUDIENCE=${VITE_AUTH_AUDIENCE}
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8790 WEB_DIST=/app/dist/web
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s CMD node -e "fetch('http://localhost:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/src/server/main.js"]
