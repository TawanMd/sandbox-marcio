# Mister Contador + Pluggy (Open Finance)

Protótipo (MVP) que liga a interface do **Mister Contador** à **API da Pluggy** para ler, via Open Finance, os dados de contas **PJ**, de **pessoa física** (ex.: CAEPF/produtor rural) e de **corretoras**, e apresentá-los em telas voltadas à conciliação e à escrituração contábil.

* **Dados sempre reais:** tudo o que aparece vem da API da Pluggy. Não há dados simulados nem valores inventados; sem conexão, as telas ficam vazias.
* **Single-tenant:** um login (HTTP Basic) e uma conexão bancária por vez. Sem banco de dados e sem webhooks no MVP (ver [Próximos passos](#próximos-passos)).
* **Sem dependências:** backend em Node.js nativo (`server.mjs`) e frontend em HTML/CSS/JS puro (`public/`), sem build.

---

## Guia do Márcio (sem termos técnicos)

### Primeiro acesso

1. Abra o link recebido e entre com o **usuário** e a **senha** (a senha chega por outro canal).
2. Clique em **Conectar** (botão azul, no alto à direita) e depois em **Continuar**. Na janela da Pluggy, escolha o banco da empresa, a conta pessoa física ou a corretora, entre com o acesso do internet banking e autorize o compartilhamento no app ou no site do banco.
3. **Enquanto estivermos no modo de teste**, a própria tela mostra como entrar no banco fictício da Pluggy:
   * **Pluggy Bank Business** (empresa), **Pluggy Bank** (pessoa física) ou **Pluggy Bank Investment** (corretora);
   * usuário `user-ok`, senha `password-ok` e, se pedir um código, `123456`.
4. Aguarde a sincronização. Enquanto o banco envia os dados, aparece o aviso de "sincronizando" no topo. Em seguida as telas se preenchem: **Extrato**, **Cartão de Crédito**, **Comprovantes**, **Investimentos**, **Empréstimos**, **Registro Contábil** e **Estatísticas**.

### No dia a dia

| O que fazer | Como |
| :--- | :--- |
| Escolher o período | Botão de data no topo. O padrão é **M-1 Fechado** (mês anterior completo, horário de Brasília). Há atalhos (Mês Atual, M-2, M-3) e datas livres de até 366 dias. |
| Buscar dados novos | Botão **Atualizar** no topo (o mesmo botão azul, depois de conectado). Ele recarrega tudo o que a Pluggy já tem, sem abrir a janela do banco. |
| Banco pediu nova autorização | Aparece um aviso com o botão **Reconectar** (senha alterada, autorização vencida ou confirmação pendente no app do banco). Ele abre a janela da Pluggy já na conexão atual, sem criar outra. |
| Imprimir ou salvar em PDF | Botão **Imprimir / PDF**. |
| Ordenar uma tabela | Clique no título da coluna **Data** ou **Valor** em Comprovantes, Extrato e Cartão. |
| Abrir/fechar o menu (celular) | Botão **☰**. |
| Ver este passo a passo | **Precisa de ajuda?** (topo) ou **Central Mister** (canto inferior). |
| Algo não funcionou | Avise quem configurou o sistema e informe o que aparece em **Detalhes técnicos (suporte)**, na tela **Empresa**. |

### Avisos que podem aparecer

Os avisos ficam num bloco no topo de **todas** as telas de dados:

* **Sincronizando:** o banco ainda está enviando os dados. Clique em **Atualizar** daqui a pouco.
* **A conexão precisa de atenção:** o banco pediu nova autorização. Use **Reconectar**.
* **Dados parciais:** alguma parte (ex.: cartão ou investimentos) não foi atualizada pelo banco desta vez. O resto está correto.
* **Mostrando os últimos 90 dias:** só no banco fictício de teste, quando o período escolhido veio sem nenhum lançamento.
* **Lista muito grande:** o período tem mais lançamentos do que o app consegue mostrar de uma vez. Escolha um período menor.
* **Falha temporária:** o banco ou a Pluggy não responderam. Use **Tentar novamente**.

### Permissões

* **Conectar outra conta:** abre uma conexão nova. O app guarda **uma conexão por vez**, então a nova substitui a atual (o app avisa antes).
* **Revogar acesso:** pede confirmação, apaga a autorização também na Pluggy e volta para a tela **Início** sem dados.

### O que combinar com o Márcio

* Um único usuário e senha, e uma conexão bancária por vez, lembrada **neste navegador**. Se trocar de computador ou limpar os dados do navegador, basta conectar de novo.
* O app busca os dados quando ele abre a tela ou clica em **Atualizar** (quem sincroniza com o banco é a Pluggy); o app não recebe avisos em segundo plano.
* Nada fica gravado em banco de dados no servidor. O **Registro Contábil** é montado na hora, com a contrapartida "a definir" para ele classificar.
* No modo de teste, conexões com o banco fictício que ficam mais de 30 dias sem atualizar são apagadas pela Pluggy.

---

## O que cada tela mostra

| Tela | Conteúdo |
| :--- | :--- |
| **Início** | Situação da conexão, botão de conectar e resumo do período. |
| **Registro Contábil** | Partidas dobradas geradas a partir dos lançamentos (regras abaixo). |
| **Extrato Bancário** | Lançamentos da conta corrente no período, com saldo. |
| **Cartão de Crédito** | Compras do período (com parcelas) e as **faturas reais** da Pluggy (vencimento, fechamento, valor total, pagamentos e encargos). |
| **Comprovantes** | Pagamentos PIX, boleto e TED com pagador e recebedor, quando o banco informa esses dados. |
| **Investimentos** | Todas as aplicações (CDB, Tesouro, fundos, previdência, ações...) com indexador, taxa e saldo. |
| **Empréstimos** | Todos os contratos (ex.: capital de giro, Pronampe) com saldo devedor, taxa e parcelas. |
| **Estatísticas** | KPIs (saldo, entradas, saídas, fatura, investimentos, saldo devedor) e gráficos em SVG/CSS no padrão Mister (azul = entradas, vermelho = saídas), com tabela alternativa "Ver dados do gráfico". |
| **Empresa** | Dados do titular vindos da Pluggy (`/identity`); "Não informado" quando a instituição não envia. |
| **Permissões** | Consentimento Open Finance: reconectar, conectar outra conta e revogar. |

### Regras de cálculo e de exibição

* **Entrada x saída:** saída é `type === 'DEBIT'` (a Pluggy normaliza o sinal, inclusive no cartão). Só quando `type` falta o app usa o sinal do valor conforme o tipo da conta.
* **Pagamento de fatura** (lançamento `CREDIT` no cartão ou `operationType === 'PAGAMENTO_FATURA'`) **não** entra nos gastos do cartão nem em "Gastos por categoria".
* **Moeda:** os totais somam `amountInAccountCurrency` quando existe; o código da moeda aparece ao lado do valor quando `currencyCode` não é `BRL`.
* **Registro Contábil** (visão dos livros da empresa):
  * saída de caixa → **D** contrapartida "a definir" / **C** conta bancária;
  * entrada de caixa → **D** conta bancária / **C** "a definir";
  * compra no cartão → **D** "a definir" / **C** "Cartão a pagar — <nome do cartão>";
  * pagamento da fatura → **D** cartão / **C** "a definir".
  * A linha de crédito mantém o fundo amarelo do Mister.
* **Categorias em português:** cada transação recebe `categoryTranslated` (campo `descriptionTranslated` do `GET /categories`, consultado uma vez e guardado em cache). Se a Pluggy não traduzir, o campo é omitido e vale a categoria original.
* **Pessoa física x jurídica:** identidade com CPF mostra "Nome"/"CPF" e "Titular:" no topo; com CNPJ, "Razão Social"/"CNPJ" e "Empresa:". CPF e CNPJ aparecem sempre mascarados.
* **Datas:** o campo `date` da Pluggy representa o dia (meia-noite UTC). O app usa os 10 primeiros caracteres (`AAAA-MM-DD`) sem converter fuso, pois converter para o horário de Brasília jogaria o lançamento para o dia anterior. Já o período M-1 é calculado no fuso `America/Sao_Paulo`, independente do fuso do servidor.
* **Coluna "Dt Vcto"** (mantida por fidelidade ao Mister): mostra o vencimento só quando existe um campo real; caso contrário, "—".
* **Detalhes técnicos (suporte):** termos técnicos (ID da conexão, JSON da API, etc.) ficam apenas no bloco recolhido **Detalhes técnicos (suporte)**, que inclui o **JSON Inspector** com o retorno real de cada seção.

---

## Publicar no Render (Web Service)

O Márcio não instala nada: o app fica hospedado com login e ele recebe só um link. As credenciais da Pluggy ficam nas variáveis de ambiente do Render e nunca chegam ao navegador. Cada `git push` na branch publica a nova versão no mesmo link.

### Opção A: Blueprint (recomendado)

1. Suba o repositório para o GitHub (`.env` e variantes estão no `.gitignore`).
2. No [Render](https://render.com): **New → Blueprint**, escolha o repositório. O `render.yaml` cria o Web Service `mister-contador-pluggy` com health check em `/healthz`.
3. Preencha os segredos pedidos no painel: `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` e `APP_PASSWORD` (mínimo de **12 caracteres**). Em produção, se faltar algum deles ou a senha for curta, o servidor não sobe e o log do Render mostra o motivo.
4. Confira no log do build a linha `v24.x.x` (o `buildCommand` é `node --version`), que confirma a versão do Node.
5. Teste: `https://<app>.onrender.com/healthz` responde `ok`, e a página principal pede usuário e senha.
6. Ajuste `TRUST_PROXY_HOPS`, se necessário (ver [abaixo](#descobrir-trust_proxy_hops)).
7. Envie ao Márcio o **link** e o **usuário/senha** por canais diferentes.

### Opção B: Web Service criado à mão

**New → Web Service**, com o repositório, e os mesmos valores do `render.yaml`:

| Campo | Valor |
| :--- | :--- |
| Runtime | Node |
| Build Command | `node --version` |
| Start Command | `node server.mjs` |
| Health Check Path | `/healthz` |
| Variáveis | `NODE_ENV=production`, `HOST=0.0.0.0`, `APP_USER=marcio`, `APP_PASSWORD` (segredo, 12+), `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET` (segredos), `PLUGGY_INCLUDE_SANDBOX=true`, `TRUST_PROXY_HOPS=1` |

Não esqueça `NODE_ENV=production`: sem ele o app roda em modo de desenvolvimento (sandbox ligado por padrão, sem HSTS e com os campos de Client ID/Secret na tela quando faltam as chaves). A senha é exigida de qualquer forma no Render, porque o servidor reconhece a variável `RENDER` que o próprio Render define. Sem `APP_PASSWORD` de 12+ caracteres (ou, em produção, sem as chaves da Pluggy), o servidor se recusa a subir, o log mostra o motivo e o deploy não fica no ar (falha fechada, de propósito).

### Versão do Node

* O arquivo **`.node-version`** (conteúdo `24`) fixa o Render na última **24.x LTS**. Ordem de precedência no Render: `NODE_VERSION` (painel) > `.node-version` > `.nvmrc` > `engines` do `package.json`. Não defina `NODE_VERSION` no painel, para não sobrepor o arquivo.
* O `engines` (`>=22 <27`) tem limite superior, como a [documentação do Render](https://render.com/docs/node-version) pede: um intervalo aberto (`>=20`) pegaria sempre a versão mais nova do Node e trocaria de major sozinho.
* O `Dockerfile` usa a mesma major (`node:24-alpine`).

### Modo de teste (sandbox) x produção

* `PLUGGY_INCLUDE_SANDBOX` fica **`"true"`** no `render.yaml` enquanto a Pluggy não libera a aplicação para conectores reais. Com isso o widget lista os bancos fictícios e a tela mostra as instruções `user-ok`/`password-ok`.
* Quando a produção for liberada (confira no [Dashboard da Pluggy](https://dashboard.pluggy.ai), com uma aplicação separada da de desenvolvimento), troque para **`"false"`** no `render.yaml` (é a fonte do Blueprint) e faça o push. Sem a variável, o padrão em produção já é desligado.

### Descobrir `TRUST_PROXY_HOPS`

O limite de senhas erradas conta as falhas por IP. Atrás de um proxy (Render, Railway, Fly.io), o IP da conexão é o do proxy, e o IP real vem no cabeçalho `X-Forwarded-For`, em que o próprio usuário pode escrever o que quiser à esquerda. `TRUST_PROXY_HOPS` diz quantas posições, contadas **da direita**, foram acrescentadas por proxies confiáveis.

1. Descubra o seu IP público (ex.: <https://ifconfig.me>).
2. Registre uma vez no log o cabeçalho que chega ao servidor (ex.: um `console.log(req.headers['x-forwarded-for'])` temporário) e mande `curl -H "X-Forwarded-For: 1.1.1.1" https://<app>.onrender.com/healthz`.
3. Veja a posição do seu IP real contando da direita: `1.1.1.1, <seu IP>` → `1`; `1.1.1.1, <seu IP>, <IP do proxy>` → `2`.
4. Atualize o valor no `render.yaml` e remova o log temporário.

O padrão `1` é seguro: nunca lê o valor forjado. Se houver mais saltos, as falhas só passam a ser contadas juntas (mais restritivo). **Nunca** use um número maior que o real, pois aí quem ataca volta a escolher o próprio IP. Use `0` quando não há proxy na frente (Docker/VPS expostos diretamente).

### Checklist antes de enviar o link

- [ ] `APP_PASSWORD` com 12+ caracteres cadastrada como segredo, e a página pede login.
- [ ] `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET` cadastrados como segredos (nunca no git).
- [ ] HTTPS ativo (o Render já fornece; o login HTTP Basic só é seguro sobre HTTPS).
- [ ] `PLUGGY_INCLUDE_SANDBOX` conforme a fase: `"true"` no teste, `"false"` com contas reais.
- [ ] Aplicação da Pluggy habilitada para Open Finance/conectores reais, se for usar contas reais.
- [ ] `GET /healthz` responde `ok` e o log do build mostra Node 24.
- [ ] `TRUST_PROXY_HOPS` conferido.

No plano **free** o serviço "dorme" sem uso: avise o Márcio que a primeira abertura depois de um tempo parado leva cerca de um minuto.

### Outras hospedagens

| Opção | Como |
| :--- | :--- |
| **Docker** (Railway, Fly.io, VPS) | `docker build -t mister-pluggy .` e `docker run -p 3000:3000 --env-file .env mister-pluggy`. A imagem (`node:24-alpine`) roda como usuário não-root, define `NODE_ENV=production` e `HOST=0.0.0.0` e tem `HEALTHCHECK` em `/healthz`. O `.env` precisa de `APP_PASSWORD` (12+) e das chaves da Pluggy; ajuste `TRUST_PROXY_HOPS` ao proxy da plataforma (`0` se exposto direto). |
| **Node direto** | `NODE_ENV=production HOST=0.0.0.0 node server.mjs`, com as variáveis de ambiente definidas e um proxy HTTPS na frente. |

---

## Rodar localmente (desenvolvimento)

Requer **Node.js 22 ou mais novo** (recomendado: **24 LTS**; os testes também passam no 26). Não precisa de `npm install`.

> O mínimo técnico é o 20.12, primeira versão com `process.loadEnvFile` (usado para ler o `.env`; adicionado na v20.12.0/v21.7.0). Mas o Node 20 está sem correções de segurança desde 30/04/2026, por isso o `engines` pede 22+.

1. Copie `.env.example` para `.env` e preencha (ver [Variáveis de ambiente](#variáveis-de-ambiente)).
2. Rode `node server.mjs` (ou `npm start`) e acesse `http://localhost:3000`.

Comportamentos de desenvolvimento:

* **Sem `APP_PASSWORD`:** sem login. O servidor escuta em `127.0.0.1` e só atende pedidos endereçados a `localhost`/`127.0.0.1` (outras máquinas da rede e sites com DNS rebinding recebem 403).
* **Sem chaves da Pluggy no ambiente** (só fora de produção): a janela de conexão pede Client ID e Client Secret. Eles são validados no `POST /auth` da Pluggy **antes** de serem guardados, e ficam só na memória do servidor.
* **Sandbox:** ligado por padrão fora de produção.

### Testes

```bash
npm test
```

Roda `node server.mjs --test` (validação de sintaxe e do cálculo do período M-1) e `test/smoke.mjs`:

* **Fumaça:** sobe o servidor com senha e confere login, validações de entrada, cabeçalhos de segurança, proteção contra CSRF, limite de tentativas e as travas de produção.
* **Integração** (`test/integration.mjs`): aponta `PLUGGY_API_URL` para uma Pluggy falsa local (`test/fake-pluggy.mjs`) e cobre connect token, item-data completo, paginação, avisos, fallback do sandbox, espera em `UPDATING`, mapeamento de erros, reautenticação, revogação e credenciais digitadas na tela.

Nunca chama a Pluggy real nem precisa de credenciais. Ao editar arquivos `.js`/`.mjs`, rode também `node --check <arquivo>`.

---

## Variáveis de ambiente

Modelo comentado em [`.env.example`](.env.example). Variáveis já definidas no ambiente têm precedência sobre o `.env`.

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `NODE_ENV` | (vazio) | `production` exige `APP_PASSWORD` (12+) e as chaves da Pluggy para subir, desliga o sandbox por padrão, ativa HSTS, recusa Client ID/Secret digitados na tela e ignora as variáveis só de desenvolvimento. |
| `APP_USER` | `marcio` | Usuário do login. Também é o `clientUserId` enviado à Pluggy (sem senha: `local-dev`). |
| `APP_PASSWORD` | (vazio) | Senha do login HTTP Basic. Obrigatória em produção e no Render (variável `RENDER`), com no mínimo 12 caracteres. Vazia = sem login, só para uso local. |
| `PLUGGY_CLIENT_ID` / `PLUGGY_CLIENT_SECRET` | (vazio) | Credenciais da aplicação no [Dashboard da Pluggy](https://dashboard.pluggy.ai). Em produção são obrigatórias e só valem por aqui. |
| `PLUGGY_INCLUDE_SANDBOX` | `true` fora de produção, `false` em produção | Mostra os conectores de teste no widget. `true`/`false` explícito vale em qualquer ambiente. |
| `TRUST_PROXY_HOPS` | `0` | Proxies confiáveis no `X-Forwarded-For` (ver [Descobrir `TRUST_PROXY_HOPS`](#descobrir-trust_proxy_hops)). `render.yaml`: `1`. Em produção com `0`, o servidor avisa no log. |
| `HOST` | `127.0.0.1` sem senha, `0.0.0.0` com senha | Interface de escuta (`Dockerfile` e `render.yaml` definem `0.0.0.0`). Sem senha, mesmo com outro `HOST`, só pedidos para `localhost` são atendidos. |
| `PORT` | `3000` | Porta HTTP. O Render define sozinho. |
| `PLUGGY_API_URL`, `PLUGGY_TIMEOUT_MS`, `PLUGGY_POLL_MAX_MS` | `https://api.pluggy.ai`, `20000`, `25000` | **Só desenvolvimento/testes** (ignoradas em produção): Pluggy falsa local, timeout das chamadas e espera máxima por um item em `UPDATING`, em ms. |

---

## API do backend

Todas as rotas, exceto `/healthz`, exigem o login quando `APP_PASSWORD` está definida (sem senha, só pedidos para `localhost` são atendidos). Métodos que alteram estado (`POST`, `DELETE`) só são aceitos da própria página: `Origin`/`Sec-Fetch-Site` de outro site → **403 `FORBIDDEN_ORIGIN`**. Respostas da API usam `Cache-Control: no-store` e não há CORS (mesma origem).

| Método | Rota | Descrição |
| :--- | :--- | :--- |
| GET | `/healthz` | `ok` em texto, sem login e sem dados (health check). |
| GET | `/api/config` | `{ hasEnvKeys, allowRuntimeCreds, includeSandbox, period: { from, to, label } }`. |
| POST | `/api/connect-token` | Gera o connect token do widget → `{ accessToken }`. |
| GET | `/api/item-data` | Consolida os dados da conexão no período. |
| DELETE | `/api/item` | Revoga a conexão na Pluggy → `{ revoked: true }`. |
| GET | `/api/last-data` | Último resumo consultado, só para o mesmo `itemId`. |

### `GET /api/config`

* `hasEnvKeys`: há `PLUGGY_CLIENT_ID`/`PLUGGY_CLIENT_SECRET` no ambiente (só `process.env`).
* `allowRuntimeCreds`: `true` só fora de produção **e** sem chaves no ambiente; libera os campos de Client ID/Secret na tela.
* `includeSandbox`: ver `PLUGGY_INCLUDE_SANDBOX`. A tela só mostra as instruções `user-ok`/`password-ok` quando é `true`.
* `period`: mês anterior fechado (M-1) no fuso `America/Sao_Paulo`.

### `POST /api/connect-token`

* Exige `Content-Type: application/json` (senão **415**) e mesma origem (senão **403**).
* Corpo: objeto JSON de até 10 KB, `{ itemId?, clientId?, clientSecret? }`.
  * `itemId` (UUID) gera o token para **atualizar** uma conexão existente (botão Reconectar, widget em modo `updateItem`). O servidor envia à Pluggy `{ itemId, options: { clientUserId } }`; item inexistente → **404 `ITEM_NOT_FOUND`**.
  * `clientId`/`clientSecret` só são aceitos quando `allowRuntimeCreds` é `true`, e são validados no `/auth` antes de gravar (recusados → **502 `PLUGGY_AUTH`**). Fora disso são ignorados (com aviso no log).
* O `clientUserId` não vem do navegador (se vier, é ignorado): o servidor usa `APP_USER` (ou `local-dev` sem senha).

### `GET /api/item-data?itemId=<uuid>&from=AAAA-MM-DD&to=AAAA-MM-DD&label=...`

Validações (**400 `VALIDATION`**): `itemId` UUID; datas reais, `from <= to`, intervalo de até 366 dias (sem `from`/`to`, vale o M-1). Conexão inexistente ou removida → **404 `ITEM_NOT_FOUND`**.

| Campo | Conteúdo |
| :--- | :--- |
| `item` | Objeto do `GET /items/{id}`. |
| `syncing` | `true` se, depois de ~25 s de consultas com espera crescente, a conexão ainda estiver `UPDATING`. |
| `warnings` | `[{ product, message }]` vindos de `executionStatus` `PARTIAL_SUCCESS`, `statusDetail.<produto>.isUpdated === false` e `statusDetail.<produto>.warnings`. Também entra aqui um produto opcional (faturas, investimentos, empréstimos, identidade) que a Pluggy recusou com 4xx: ele vem vazio e o resto carrega normalmente. |
| `period` | `{ from, to, label }` usado na consulta. |
| `periodFallback` / `fallbackRange` | Só em conector sandbox (`item.connector.isSandbox`) com **todas** as contas vazias no período: busca os últimos 90 dias e informa a janela `{ from, to }` (senão `false` / `null`). Nunca acontece em conectores reais. |
| `truncated` | `true` se algum limite de páginas foi atingido (50 páginas de transações por conta; 20 páginas nas demais listas). |
| `identity` | Retorno do `/identity` ou `null`. |
| `accounts` | Contas da conexão. |
| `cardStatements` | `[{ account, period, transactions, totalTransactions, bills }]`; `bills` vem do `GET /bills?accountId=` (`[]` se indisponível). |
| `checkingTransactions` | Lançamentos das contas `BANK`. |
| `investments` / `loans` | Todas as páginas. |
| `timestamp` | Momento da consulta. |

Cada transação recebe `categoryTranslated` (descrição da categoria em português) quando a Pluggy a fornece.

### `DELETE /api/item?itemId=<uuid>`

Mesma checagem de origem do POST. Chama `DELETE /items/{id}` na Pluggy; um 404 da Pluggy conta como já revogado. Responde `{ revoked: true }` e limpa o último resumo guardado se for do mesmo item. No navegador, o app limpa o estado, o `localStorage` e o topo (status, pills e botão) e volta para **Início**.

### `GET /api/last-data?itemId=<uuid>`

Devolve o último resumo consultado **somente** se o `itemId` for o mesmo; caso contrário, **404 `NOT_FOUND`**. Resumos com `syncing: true` não são guardados.

### Formato de erro

Todo erro da API é JSON: `{ "error": "<mensagem amigável em português>", "code": "<CODE>" }`. Detalhes técnicos (resposta crua da Pluggy, stack) vão só para o `console.error` do servidor, sem segredos. O pedido de senha (401 com `WWW-Authenticate`) é o do próprio HTTP Basic, que o navegador mostra como janela de login.

| HTTP | `code` | Quando |
| :--- | :--- | :--- |
| 400 | `VALIDATION` | Parâmetro, data ou corpo inválido (JSON malformado ou acima de 10 KB). |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | POST sem `Content-Type: application/json`. |
| 403 | `FORBIDDEN_ORIGIN` | Pedido de outra origem (CSRF) ou, sem senha, endereçado a algo que não é `localhost`. |
| 404 | `ITEM_NOT_FOUND` | Conexão inexistente ou removida na Pluggy. |
| 404 | `NOT_FOUND` | Rota, arquivo ou resumo inexistente. |
| 429 | `RATE_LIMIT` | Muitas senhas erradas deste IP, ou limite de requisições da Pluggy. Vem com `Retry-After`. |
| 502 | `PLUGGY_AUTH` | A Pluggy recusou as credenciais do servidor, ou elas não foram configuradas. |
| 502 | `PLUGGY_UNAVAILABLE` | A Pluggy está fora do ar, instável ou inacessível. |
| 504 | `TIMEOUT` | A Pluggy não respondeu a tempo (20 s por chamada). |
| 500 | `INTERNAL` | Erro inesperado no servidor. |

---

## Como o servidor usa a API da Pluggy

1. `POST /auth` com `clientId`/`clientSecret` → API Key (cache de ~2 h). Se uma chamada voltar 401/403, o servidor autentica de novo e repete a chamada uma vez.
2. `POST /connect_token` com `{ options: { clientUserId } }` (conexão nova) ou `{ itemId, options: { clientUserId } }` (Reconectar) → token para o widget **Pluggy Connect v2.11.0**, servido localmente em `public/vendor/` (não edite esse arquivo; para atualizar, troque-o inteiro por uma versão oficial). O widget lista `BUSINESS_BANK`, `PERSONAL_BANK` e `INVESTMENT` e devolve o `itemId`, que o navegador guarda no `localStorage`.
3. `GET /items/{id}`: status da conexão. Enquanto estiver `UPDATING`, consulta de novo com espera crescente (1, 2, 4, 8, 10 s) até ~25 s. Status `LOGIN_ERROR`, `OUTDATED`, `WAITING_USER_INPUT` ou `WAITING_USER_ACTION` levam ao botão **Reconectar**.
4. `GET /accounts?itemId=` → `GET /v2/transactions?accountId=&dateFrom=&dateTo=` (paginação por cursor `next`) para cada conta.
5. Em paralelo: `GET /bills?accountId=` para cada cartão (faturas reais), `GET /investments` e `GET /loans` (todas as páginas), `GET /identity` e `GET /categories` (tradução das categorias, em cache por 24 h; se falhar, segue sem tradução e tenta de novo em 5 min).
6. `DELETE /items/{id}` ao revogar.

Referências: [Sandbox](https://docs.pluggy.ai/en/docs/guides/sandbox) · [Ambientes do widget](https://docs.pluggy.ai/pt/docs/connect-widget/environments) · [Webhooks](https://docs.pluggy.ai/pt/docs/developer-tools/webhooks-ref).

---

## Segurança

* **Login HTTP Basic:** usuário e senha comparados sempre os dois, por digest SHA-256 em tempo constante (não vaza o tamanho). Em produção (e no Render) o servidor não sobe sem `APP_PASSWORD` ou com senha de menos de 12 caracteres; em produção também não sobe sem as chaves da Pluggy.
* **Sem senha, só local:** sem `APP_PASSWORD` o servidor escuta em `127.0.0.1` e recusa (403) pedidos cujo `Host` não seja `localhost`/`127.0.0.1`/`[::1]`, o que barra acesso pela rede e DNS rebinding.
* **Limite contra força bruta:** 10 senhas erradas em 10 minutos bloqueiam o IP até o fim da janela (429 com `Retry-After`). O IP vem de `TRUST_PROXY_HOPS`, nunca do primeiro valor do `X-Forwarded-For`, que o cliente controla. Acima de 30 falhas no total (todos os IPs), cada nova falha demora mais para responder (até 5 s), sem bloquear quem acerta a senha. O registro de falhas é limpo a cada minuto e tem tamanho máximo.
* **CSRF:** `POST /api/connect-token` e `DELETE /api/item` exigem mesma origem (`Origin`/`Sec-Fetch-Site`, senão 403) e o POST exige `Content-Type: application/json` (senão 415). Em produção, credenciais da Pluggy só vêm do ambiente.
* **Cabeçalhos:**
  * `Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.pluggy.ai; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src https://*.pluggy.ai; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. Por isso o HTML/JS não usa `<script>` inline nem atributos `on*` (`onclick` etc.); atributos `style=""` continuam permitidos.
  * `Strict-Transport-Security` só em produção.
  * `Permissions-Policy` (câmera, microfone e geolocalização desligados), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
* **Entradas validadas:** `itemId` (UUID) e datas antes de ir para a URL da Pluggy; corpo das requisições limitado a 10 KB.
* **Erros:** chamadas à Pluggy têm timeout de 20 s; 401/403/429/5xx aparecem como erro com mensagem amigável, nunca como "lista vazia". Detalhes só no log do servidor.
* **Escape de HTML:** todo texto vindo da API é escapado antes de ir para a tela.
* **Segredos:** nunca versione o `.env` (o `.gitignore` cobre `.env` e `.env.*`, mantendo só o `.env.example`). Credenciais nunca trafegam em URL.
* Erros não tratados não derrubam o servidor; `SIGTERM` encerra de forma limpa.

---

## Estrutura do projeto

```
├── .agents/skills/        # Skills/regras de integração Pluggy (auth, widget, webhooks, open finance)
├── public/
│   ├── index.html         # Interface (sidebar, filtros, avisos, modais)
│   ├── style.css          # Layout no padrão visual Mister
│   ├── app.js             # Widget, período, telas, ordenação, Registro Contábil e JSON Inspector
│   └── vendor/            # Pluggy Connect v2.11.0 (arquivo oficial, não editar)
├── server.mjs             # Servidor HTTP nativo + login + integração com a API da Pluggy
├── test/
│   ├── smoke.mjs          # Teste de fumaça (npm test); chama a integração no final
│   ├── integration.mjs    # Integração com a Pluggy falsa
│   ├── fake-pluggy.mjs    # Pluggy falsa local (formato documentado da API)
│   └── helpers.mjs        # Sobe o servidor em porta livre e registra os resultados
├── render.yaml            # Blueprint do Render (Web Service)
├── .node-version          # Versão do Node no Render (24 LTS)
├── Dockerfile             # Imagem para Railway/Fly.io/VPS
├── .env.example           # Modelo comentado das variáveis de ambiente
├── test-pluggy-mcp.mjs    # Script auxiliar para testar o MCP de documentação da Pluggy
├── package.json           # Scripts `start` e `test`
└── README.md
```

---

## Próximos passos

O MVP é de propósito single-tenant, sem banco de dados e sem webhooks. Isso deixa de fora: a conexão sobreviver à troca de navegador (o `itemId` fica no `localStorage`), avisos em segundo plano (ex.: banco que pede nova autorização, autorização pendente da Caixa) e a detecção de conexões apagadas pela Pluggy enquanto o app está fechado.

1. **Login por usuário + banco de dados:** contas individuais no lugar do HTTP Basic único e, para cada usuário, as conexões (`itemId`) guardadas no servidor, usando o id do usuário como `clientUserId`.
2. **Webhooks da Pluggy** (`item/created`, `item/updated`, `item/error`, `item/deleted`):
   * criar `POST /api/webhooks/pluggy` (fora do login HTTP Basic, protegido por um segredo) e registrá-lo com `POST /webhooks` ou com `options.webhookUrl` no connect token;
   * responder `2xx` em até 10 s e processar depois, começando por `GET /items/{id}`; ignorar eventos repetidos pelo `eventId`; em `item/deleted`, desfazer o vínculo;
   * usar um plano do Render que não "dorme": no free, a primeira entrega após um período parado passa dos 10 s, falha e só chega na nova tentativa (~15 min depois).
3. **Exportação para o Mister Contador:** enviar os lançamentos conciliados, com as contrapartidas definidas no Registro Contábil, por CSV ou API, em vez de apenas visualizá-los.
