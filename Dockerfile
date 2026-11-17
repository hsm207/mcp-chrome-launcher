FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY mcp-chrome-launcher.mjs ./
COPY src/ ./src/

# Pre-cache chrome-devtools-mcp so the stdio handshake and tools/list respond immediately
RUN npx -y chrome-devtools-mcp@latest --help >/dev/null 2>&1 || true

ENTRYPOINT ["node", "/app/mcp-chrome-launcher.mjs"]
