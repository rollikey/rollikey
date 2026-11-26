# Production image for a hosted Rollikey pilot airlock (dashboard + airlock worker).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY packages ./packages
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production DASHBOARD_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/',{headers:{host:'localhost:'+(process.env.PORT||3000)}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/dashboard/main.js"]
