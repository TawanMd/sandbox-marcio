# Pluggy Integration & Agent Skills

Este projeto está conectado ao servidor MCP oficial da **Pluggy** (`https://docs.pluggy.ai/mcp`) e configurado com as **Pluggy Agent Skills** oficiais.

---

## 🚀 O que foi instalado e configurado

### 1. Claude MCP (`claude mcp add`)
Executado e registrado no arquivo `~/.claude.json` do projeto:
```bash
claude mcp add --transport http pluggy-docs https://docs.pluggy.ai/mcp
```
- **Nome do servidor:** `pluggy-docs`
- **Transporte:** HTTP
- **URL:** `https://docs.pluggy.ai/mcp`

---

### 2. Pluggy Agent Skills (`npx skills add pluggyai/agent-skills`)
Instaladas em [`.agents/skills/`](file:///c:/Users/Windows%20Lite%20BR/Documents/pluggy-marcio/.agents/skills):

| Skill | Descrição e Recursos |
| :--- | :--- |
| **`pluggy-doctor`** | Diagnóstico, troubleshooting e resolução rápida de erros da API e conectores Pluggy. |
| **`pluggy-integration`** | Autenticação (API keys e token refresh), ciclo de vida de Item, integração com Widget, tratamento de MFA e webhooks. |
| **`pluggy-open-finance`** | Leitura de saldos e transações, conectores bancários, sandbox, paginação, enriquecimento de dados e investimentos. |
| **`pluggy-payments`** | Iniciação de pagamentos Pix (Open Finance), ambiente sandbox Pix, boletos, agendamento de pagamentos e pré-autorização inteligente. |

---

### 3. Servidor MCP Pluggy (Antigravity, Cursor, VS Code)
Configurado em:
- Global Antigravity: `C:\Users\Windows Lite BR\.gemini\config\mcp_config.json`
- Projeto: [`.agents/mcp_config.json`](file:///c:/Users/Windows%20Lite%20BR/Documents/pluggy-marcio/.agents/mcp_config.json)
- Cursor: [`.cursor/mcp.json`](file:///c:/Users/Windows%20Lite%20BR/Documents/pluggy-marcio/.cursor/mcp.json)
- VS Code: [`.vscode/mcp.json`](file:///c:/Users/Windows%20Lite%20BR/Documents/pluggy-marcio/.vscode/mcp.json)

---

## 🛠️ Ferramentas MCP Disponíveis

| Ferramenta | Descrição |
| :--- | :--- |
| `list-specs` | Lista as especificações OpenAPI disponíveis (`Pluggy API`, `enrichment-api`). |
| `list-endpoints` | Lista todos os paths e métodos HTTP disponíveis em uma especificação. |
| `get-endpoint` | Obtém detalhes completos, esquemas de payload, parâmetros e respostas de uma rota. |
| `search-endpoints` | Busca textual profunda por rotas, modelos e parâmetros na documentação da API. |
| `search` | Pesquisa na base de conhecimento e documentação oficial da Pluggy por tema. |
| `fetch` | Recupera a página completa da documentação através do ID obtido no `search`. |
| `execute-request` | Executa requisições diretas contra a API da Pluggy no formato HAR. |

---

## 🧪 Teste Rápido de Conexão

Para testar a conexão com o servidor MCP a qualquer momento:

```bash
node test-pluggy-mcp.mjs
```

---

## 💼 MVP Pluggy Sandbox — Mister Contador / Conta Azul

Aplicação leve em **HTML5 + CSS + JavaScript Vanilla** (sem dependências externas) com backend nativo em **Node.js** (`server.mjs`) reproduzindo fielmente a interface de conciliação e registro contábil em partidas dobradas do **Mister Contador**.

### 🎯 Casos de Uso Validados
1. **Extrato de Cartão de Crédito PJ:** Padrão mês fechado (M-1) com filtro interativo por data, faturas e parcelamentos.
2. **Conta de Aplicação / Investimentos PJ:** CDBs, Tesouro Selic, Fundos Multimercado/DI, indexadores (CDI/SELIC) e saldo atual.
3. **Conta de Empréstimo PJ (Open Finance):** Contratos de crédito (Giro/Pronampe), saldo devedor, CET/taxas e acompanhamento de parcelas pagas e a vencer.

### 🌐 Rotas Disponíveis

| Rota | Descrição |
| :--- | :--- |
| `http://localhost:3000/` | **Fluxo Real:** Abre o **Widget Pluggy Connect** em primeiro plano sobre o layout do Mister para conectar a conta Sandbox (`Pluggy Bank` com `user-ok` / `password-ok`) e carregar os dados reais. |
| `http://localhost:3000/simulado` | **Apresentação ao Sócio:** Abre diretamente a tela do Mister no formato Excel preenchida com o JSON simulado (sem atrito de login). |

### ⚙️ Como Executar

1. Preencher as credenciais da Pluggy no arquivo `.env` (solicitado ao Thiago):
   ```env
   PLUGGY_CLIENT_ID=seu_client_id
   PLUGGY_CLIENT_SECRET=seu_client_secret
   PORT=3000
   ```
2. Iniciar o servidor nativo (zero `npm install` necessário):
   ```bash
   node server.mjs
   ```
3. Acessar `http://localhost:3000` ou `http://localhost:3000/simulado` no navegador.

