FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/prisma.config.ts backend/
COPY backend/prisma/schema.prisma backend/prisma/
COPY frontend/package.json frontend/
COPY e2e/package.json e2e/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ARG APP_VERSION=unknown
ENV APP_VERSION=$APP_VERSION
ENV PORT=3000
EXPOSE 3000

USER node
WORKDIR /app/backend
CMD ["sh", "-c", "npx prisma migrate deploy && exec npm start"]
