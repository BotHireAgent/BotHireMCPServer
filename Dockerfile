# BotHire MCP server (bothire-mcp) — stdio transport.
# Used by directory checkers (Glama, Smithery) to build + start the server and introspect its tools.
# Builds from source so it works whether or not dist/ is committed.
FROM node:20-alpine

WORKDIR /app

# Install deps (dev deps included: TypeScript is needed for the build step).
COPY package.json package-lock.json ./
RUN npm ci

# Build TS -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev deps for a lean runtime image.
RUN npm prune --omit=dev

ENV NODE_ENV=production

# stdio MCP server: speaks JSON-RPC over stdin/stdout; no ports.
ENTRYPOINT ["node", "dist/index.js"]
