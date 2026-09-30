# Mister Contador + Pluggy (Open Finance PJ)

Protótipo (MVP) que integra a interface do **Mister Contador** à **API da Pluggy** para ler dados bancários de contas de **Pessoa Jurídica (PJ)** via Open Finance e apresentá-los em telas voltadas à conciliação e escrituração contábil.

## Objetivo

Validar de ponta a ponta o fluxo de integração com a Pluggy:

1. O usuário autoriza a conexão bancária pelo **Pluggy Connect Widget** (contas **PJ, pessoa física e corretoras**; pessoa física atende contabilidade de CAEPF/produtor rural).
2. O backend autentica na API da Pluggy, consolida os dados do *Item* conectado e os entrega ao frontend.
3. O frontend exibe os dados em visões contábeis (comprovantes, extrato, cartão, investimentos, empréstimos) e um dashboard com inspetor de JSON, permitindo conferir exatamente o que a API retorna.

## Casos de uso

* **Extrato de conta corrente PJ** e **cartão de crédito PJ**, com regra padrão de **mês anterior fechado (M-1)**, filtro de período e detalhamento de parcelas.
* **Comprovantes** de pagamento (PIX, boleto, TED) a partir do `paymentData` das transações.
* **Registro contábil** com partidas dobradas (débito/crédito) geradas a partir dos lançamentos.
* **Investimentos PJ** (CDB, Tesouro Direto, Fundos) com indexador, taxa e saldo.
* **Empréstimos PJ** (Capital de Giro/Pronampe) com saldo devedor, taxa e parcelas.
* **Estatísticas**: KPIs (fatura do cartão, patrimônio investido, dívida de empréstimos, saldo em conta) e **JSON Inspector** para inspecionar o payload por seção.

## Arquitetura

* **Frontend**: HTML, CSS e JavaScript puro (`public/`), sem build nem framework.
* **Backend**: Node.js nativo (`server.mjs`), sem dependências externas. Serve os arquivos estáticos e faz proxy para `https://api.pluggy.ai`, mantendo `clientId`/`clientSecret` fora do navegador.
* **Fluxo**: `POST /auth` (API Key, com cache de ~2h) → `POST /connect_token` → widget devolve o `itemId` → o backend consulta `/items`, `/accounts`, `/v2/transactions`, `/investments` e `/loans`.
* O `itemId` conectado fica salvo no `localStorage` do navegador para restaurar a sessão.
* Se o filtro do período não retornar lançamentos (comum no sandbox), o servidor busca os lançamentos recentes sem filtro de data.

## Telas

Início · Registro Contábil · Extrato Bancário · Cartão de Crédito · Comprovantes · Investimentos · Empréstimos · Estatísticas · Empresa · Permissões (consentimento Open Finance).

Todos os dados exibidos vêm da API da Pluggy; não há dados simulados. Sem conexão, as telas mostram estados vazios. Razão social e CNPJ (topo e tela **Empresa**) vêm do endpoint `/identity`; se a instituição não informar, aparece "Não informado".

### Estatísticas (data viz)

Gráficos em SVG/CSS puros, no padrão visual do Mister (azul = entradas, vermelho = saídas, escolhidos para serem distinguíveis por daltônicos):

* KPIs: saldo em conta, entradas, saídas, fatura do cartão, investimentos e saldo devedor.
* Entradas e saídas por dia (barras divergentes, com tabela alternativa "Ver dados do gráfico").
* Gastos por categoria, evolução do saldo, uso do limite do cartão, investimentos por tipo e saldo devedor por contrato.
* Tooltip ao passar o mouse e JSON Inspector com o payload real de cada seção.

## Entrega para o Márcio (usuário não técnico)

O Márcio não deve instalar Node, editar `.env` nem rodar comandos. A melhor forma de entregar o MVP é **hospedar o app na nuvem, com login, e enviar um link**. Ele abre no navegador, entra com usuário e senha, conecta o banco pelo widget da Pluggy e visualiza tudo.

### Por que essa abordagem

* **Zero instalação:** basta um link (ex.: `https://mister-contador-pluggy.onrender.com`) e uma senha.
* **Credenciais seguras:** `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET` ficam nas variáveis de ambiente da hospedagem; o Márcio nunca as vê.
* **Dados financeiros protegidos:** o app exige usuário e senha (`APP_USER`/`APP_PASSWORD`) e **recusa subir em produção sem senha**.
* **Você atualiza sem ele fazer nada:** cada `git push` republica a versão nova no mesmo link.

### Passo a passo (para quem publica — você)

1. Suba o repositório para o GitHub (o `.env` já está no `.gitignore`).
2. No [Render](https://render.com), crie um serviço a partir do repositório (**New → Blueprint**, que lê o `render.yaml`). Railway ou Fly.io também servem: o app é só `node server.mjs`.
3. Preencha as variáveis secretas no painel: `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` e `APP_PASSWORD` (escolha uma senha forte).
4. Mantenha `PLUGGY_INCLUDE_SANDBOX=true` para o teste com o banco fictício. Para dados reais do Márcio, troque para `false`.
5. Confirme no [Dashboard da Pluggy](https://dashboard.pluggy.ai) se a aplicação está habilitada para conectores reais (Open Finance). Use uma aplicação separada da de desenvolvimento.
6. Envie ao Márcio o **link** e o **usuário/senha** por canais separados. Se usar o plano gratuito do Render, avise que a primeira abertura após um período parado pode levar cerca de um minuto.

### Opções de deploy (o app não tem dependências)

| Opção | Como |
| :--- | :--- |
| **Render** (recomendado) | *New → Blueprint* apontando para o repositório; usa `render.yaml` e o health check `/healthz`. |
| **Docker** (Railway, Fly.io, VPS) | `docker build -t mister-pluggy .` e `docker run -p 3000:3000 --env-file .env mister-pluggy`. A imagem já roda como usuário não-root e define `NODE_ENV=production` (exige `APP_PASSWORD`). |
| **Node direto** | `NODE_ENV=production node server.mjs` com as variáveis de ambiente definidas. |

**Checklist antes de enviar o link**

- [ ] `APP_PASSWORD` forte definida na hospedagem (e o app abre só depois do login).
- [ ] `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET` cadastrados como segredos (não no git).
- [ ] HTTPS ativo (Render, Railway e Fly.io já fornecem; o login básico só é seguro sobre HTTPS).
- [ ] `PLUGGY_INCLUDE_SANDBOX` conforme o teste (`true` = banco fictício, `false` = bancos reais).
- [ ] Aplicação Pluggy habilitada para Open Finance/conectores reais, se for usar contas reais.
- [ ] `GET /healthz` responde `ok` e a página pede usuário e senha.

### Guia rápido para o Márcio

1. Abra o link e entre com o usuário e a senha recebidos.
2. Clique em **Conectar Conta com Pluggy** (ou **Carregar**, no topo).
3. Escolha o banco da empresa e autorize o acesso. Para teste use **Pluggy Bank Business** (PJ), **Pluggy Bank** (pessoa física) ou **Pluggy Bank Investment** (corretora) com usuário `user-ok` e senha `password-ok`.
4. Aguarde a sincronização. As telas passam a mostrar os dados: **Extrato**, **Cartão de Crédito**, **Comprovantes**, **Investimentos**, **Empréstimos** e **Estatísticas** (gráficos).
5. Use o seletor de período no topo (padrão: mês anterior fechado) e o botão **Relatório** para imprimir ou salvar em PDF.
6. Em **Permissões** ele pode reconectar ou revogar o acesso a qualquer momento.

### Limitações atuais do MVP (combinar com o Márcio)

* **Um único acesso compartilhado** (um usuário/senha) e **uma conexão bancária por navegador**: o vínculo fica salvo no navegador. Se ele trocar de computador ou limpar os dados, basta reconectar.
* **Sem webhooks:** os dados são buscados quando ele abre ou atualiza a tela, não em segundo plano.
* **Sem banco de dados:** nada é gravado no servidor além do que a Pluggy já guarda. A tela "Registro Contábil" gera as partidas dobradas na hora, sem persistir.

### Próximos passos recomendados

1. **Piloto (agora):** hospedagem simples com login único, sandbox primeiro e depois uma conta real do Márcio.
2. **Login por usuário e persistência:** guardar o `itemId` de cada usuário em banco de dados (usando o id do usuário como `clientUserId`), para a conexão sobreviver a trocas de navegador.
3. **Webhooks da Pluggy** (`item/created`, `item/updated`, `item/error`) para manter os dados atualizados sozinhos e tratar erros de login do banco.
4. **Integração real com o Mister Contador:** exportar os lançamentos conciliados (CSV/API) em vez de apenas visualizá-los.

## Rotas

### Páginas

| Rota | Descrição |
| :--- | :--- |
| `/` | Interface principal com o widget da Pluggy Connect para conectar a conta. |

### API do backend

| Método | Rota | Descrição |
| :--- | :--- | :--- |
| GET | `/api/config` | Indica se há credenciais configuradas, o período M-1 e `includeSandbox` (`PLUGGY_INCLUDE_SANDBOX`). |
| GET | `/healthz` | Health check da hospedagem (sem autenticação e sem dados). |
| POST | `/api/connect-token` | Gera o Connect Token. Exige `clientUserId`; aceita `clientId`/`clientSecret` no corpo (guardados só na memória do servidor) como alternativa ao `.env`. |
| GET | `/api/item-data` | Consolida contas, cartões, extrato (com paginação por cursor), investimentos, empréstimos e identidade da empresa (`/identity`). Parâmetros: `itemId` (obrigatório), `from`, `to`, `label`. |
| GET | `/api/last-data` | Último JSON consolidado retornado pela Pluggy (útil para depuração). |

## Como executar

Requer **Node.js v20.6+** (necessário para carregar o `.env` automaticamente). Não é necessário `npm install`.

### 1. Configurar o `.env`

Copie `.env.example` para `.env` (ignorado pelo git) e preencha com as credenciais do [Dashboard da Pluggy](https://dashboard.pluggy.ai):

| Variável | Obrigatória | Descrição |
| :--- | :--- | :--- |
| `PLUGGY_CLIENT_ID` / `PLUGGY_CLIENT_SECRET` | Sim* | Credenciais da aplicação Pluggy. *Em `localhost` podem ser digitadas na tela. |
| `APP_PASSWORD` | Em produção | Senha do login (HTTP Basic). Com `NODE_ENV=production` o servidor não sobe sem ela. |
| `APP_USER` | Não | Usuário do login (padrão `marcio`). |
| `PLUGGY_INCLUDE_SANDBOX` | Não | `false` remove os conectores sandbox do widget (padrão `true`). |
| `PORT` | Não | Porta HTTP (a hospedagem costuma definir sozinha; padrão `3000`). |

Sem o `.env`, a interface pede as credenciais na hora de conectar. Sem `APP_PASSWORD`, o app abre sem senha (use só em `localhost`).

### 2. Iniciar o servidor

```bash
node server.mjs
```

Acesse `http://localhost:3000`.

### 3. Testes

```bash
npm test
```

Valida a sintaxe e roda um teste de fumaça (`test/smoke.mjs`) que sobe o servidor e confere login, validação de entradas, bloqueio de path traversal e cabeçalhos de segurança. Não chama a Pluggy nem precisa de credenciais.

## Dados de teste no Sandbox

No widget, use o conector de testes:

* Instituição: Pluggy Bank Business (banco PJ) ou Pluggy Bank Investment (corretora)
* Usuário: `user-ok`
* Senha: `password-ok`

## Conectores PJ reais (Open Finance)

Para testar empréstimos PJ junto com cartões e investimentos, use os conectores Open Finance (`[OF]`):

* Itaú Empresas, Banco do Brasil Empresas, Bradesco Empresas, Santander Empresas
* BTG Pactual Empresas, Banco Inter PJ, C6 Bank Empresas
* Sicoob, Sicredi, Unicred

### Corretoras (tipo `INVESTMENT`)

O widget lista `BUSINESS_BANK`, `PERSONAL_BANK` e `INVESTMENT` (`connectorTypes` em `public/app.js`). Hoje a Pluggy oferece, entre outras: XP Investimentos, BTG Pactual Investimentos, Rico, Clear, Ágora, Toro, Avenue, Necton, EQI, Monte Bravo, Santander Corretora (inclui Empresas), Investimentos BB, Íon, Mercado Bitcoin e Caixa Previdência. A lista completa e atual vem da própria Pluggy (`GET /connectors?types=INVESTMENT`), então novas corretoras aparecem sem mudar o código.

## Estrutura do projeto

```
├── .agents/skills/        # Skills/regras de integração Pluggy (auth, widget, webhooks, pagamentos, open finance)
├── public/
│   ├── index.html         # Interface (sidebar, filtros, modal de conexão)
│   ├── style.css          # Layout
│   └── app.js             # Widget, filtros de período, renderização das visões e JSON Inspector
├── server.mjs             # Servidor HTTP nativo + login + integração com a API da Pluggy
├── render.yaml            # Blueprint de deploy no Render
├── Dockerfile             # Imagem para Railway/Fly.io/VPS
├── .env.example           # Modelo das variáveis de ambiente
├── test/smoke.mjs         # Teste de fumaça (npm test)
├── test-pluggy-mcp.mjs    # Script auxiliar para testar o MCP de documentação da Pluggy
├── package.json           # Scripts `start` e `test`
└── README.md
```

## Segurança (revisão de código)

* Login por senha com comparação em tempo constante e bloqueio por IP após 10 tentativas erradas em 10 minutos.
* `itemId` (UUID) e datas são validados antes de ir para a URL da Pluggy; corpo das requisições limitado a ~100 KB.
* Chamadas à Pluggy têm timeout de 20 s; erros 401/403/429/5xx aparecem como erro, nunca como "lista vazia".
* Cabeçalhos `X-Content-Type-Options`, `X-Frame-Options` e `Referrer-Policy`; respostas da API com `Cache-Control: no-store`.
* Todo texto vindo da API é escapado antes de ir para o HTML (nomes de contas, descrições etc.).
* Erros não tratados não derrubam o servidor; `SIGTERM` encerra de forma limpa.

## Observações

* Nunca versione o `.env` nem exponha o `clientSecret` no frontend. As credenciais nunca trafegam em URL e a API do backend não habilita CORS (mesma origem).
* Os presets de período (M-1, mês atual, M-2, M-3) são calculados a partir da data atual.
* Se o período escolhido não tiver lançamentos (comum no sandbox), o servidor busca os mais recentes e a tela avisa com um banner (`periodFallback`).
* O `clientUserId` enviado à Pluggy é um UUID gerado por navegador. Para produção, use o id real do usuário logado.
* Ainda não há webhooks (`item/created`, `item/updated`, `item/error`): os dados são consultados sob demanda. Recomendado antes de ir para produção.
* Para produção, defina `PLUGGY_INCLUDE_SANDBOX=false` e use credenciais de uma aplicação separada da de desenvolvimento.
