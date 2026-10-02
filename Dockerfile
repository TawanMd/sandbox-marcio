# Node 24 LTS (mesma major do .node-version usado pelo Render). O Node 20 está sem correções
# de segurança desde 30/04/2026. Para builds 100% reproduzíveis, fixe a versão exata ou o digest
# (ex.: node:24.x.y-alpine@sha256:...); a tag "24-alpine" recebe os patches a cada rebuild.
FROM node:24-alpine

WORKDIR /app
# Produção: o servidor recusa subir sem APP_PASSWORD (mín. 12 caracteres) ou sem PLUGGY_CLIENT_ID/
# PLUGGY_CLIENT_SECRET, desliga o sandbox por padrão e não aceita credenciais digitadas na tela.
ENV NODE_ENV=production
# Dentro do container é preciso escutar em todas as interfaces para o mapeamento de porta funcionar.
ENV HOST=0.0.0.0

# Sem dependências externas: basta copiar o código
COPY package.json server.mjs ./
COPY public ./public

# Roda sem privilégios de root (os arquivos copiados ficam somente leitura para este usuário)
USER node
EXPOSE 3000

# /healthz responde "ok" sem login. O wget vem do BusyBox do Alpine; o shell expande ${PORT}.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -T 3 -O /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "server.mjs"]
