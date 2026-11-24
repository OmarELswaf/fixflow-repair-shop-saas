FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --ignore-scripts
COPY . .
WORKDIR /app/apps/api
RUN npm run prisma:generate && npm run build
CMD ["node", "dist/main.js"]
