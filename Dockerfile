FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Sem dependências externas: basta copiar o código
COPY package.json server.mjs ./
COPY public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "server.mjs"]
