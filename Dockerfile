# ---- build stage ----
# Debian slim (glibc) — reliable prebuilt binaries for native deps (sharp).
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Local-storage upload dir (STORAGE_DRIVER=local). Mount a host volume here so
# uploaded screenshots survive container rebuilds:  -v /srv/samity/uploads:/app/uploads
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
VOLUME ["/app/uploads"]

# Run as the built-in non-root node user.
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
