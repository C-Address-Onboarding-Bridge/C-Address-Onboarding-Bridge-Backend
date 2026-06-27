FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY api/ api/
COPY sdk/ sdk/
RUN npm ci && npm run build --workspaces

FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY api/dist/ api/dist/
COPY api/node_modules/ api/node_modules/
COPY sdk/ sdk/
RUN npm ci --production --workspace=api
EXPOSE 3000
CMD ["node", "api/dist/index.js"]
