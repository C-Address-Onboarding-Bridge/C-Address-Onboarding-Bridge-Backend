FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY api/ api/
COPY sdk/ sdk/
RUN npm ci && npm run build --workspaces

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY sdk/package.json sdk/
RUN npm ci --production --workspace=api
COPY --from=build /app/api/dist/ api/dist/
EXPOSE 3001
CMD ["node", "api/dist/index.js"]
