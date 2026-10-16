# Doorbound: the self-hosted MCP server for Alexa+, as a small, locked-down container.
#
# Build stage: install, test the pages build, and bundle the server into one file.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: nothing downloads browsers or runs code from the dependency tree.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Run stage: Node and the built files. No sources, no node_modules, no package manager.
FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3939 DATA_DIR=/data
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir -p /data && chown node:node /data
COPY --from=build --chown=root:root /app/dist ./dist
USER node
VOLUME /data
EXPOSE 3939
# Listening beyond loopback, the server will not start without AUTH_TOKEN (32+ characters) and ALLOWED_HOSTS.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3939/healthz || exit 1
CMD ["node", "dist/server.mjs"]
