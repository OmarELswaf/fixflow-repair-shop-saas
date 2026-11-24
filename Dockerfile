# Single-image build for free hosting (e.g. Render): API + built web app on one origin.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run prisma:generate && npm run build
ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app/apps/api
CMD ["sh", "scripts/migrate-and-start.sh"]
