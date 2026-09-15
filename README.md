# Mister Contador + Pluggy

Este projeto integra o Mister Contador à API da Pluggy (Open Finance) para contas de Pessoa Jurídica (PJ).

## Casos de uso

* Extrato de cartão de crédito PJ com regra de mês anterior fechado (M-1), filtro de período e detalhamento de parcelamentos e faturas.
* Posições de investimentos PJ (CDBs, Tesouro Direto, Fundos) com indexadores (CDI/SELIC), taxas e saldo atualizado.
* Contratos de empréstimo PJ (Capital de Giro/Pronampe) via Open Finance, mostrando saldo devedor, taxa de juros e parcelas pagas e a vencer.

## Rotas

| Rota | Descrição |
| :--- | :--- |
| `http://localhost:3000/` | Abre a tela do Mister Contador com o widget da Pluggy Connect para conectar a conta real. |
| `http://localhost:3000/simulado` | Abre a tela com dados simulados, sem pedir login. |

## Como executar

O projeto usa HTML, CSS, JavaScript puro no frontend e Node.js nativo (`server.mjs`) no backend. Você não precisa rodar `npm install`.

### 1. Configurar o `.env`
Adicione as credenciais obtidas no [Dashboard da Pluggy](https://dashboard.pluggy.ai):

```env
PLUGGY_CLIENT_ID=seu_client_id_aqui
PLUGGY_CLIENT_SECRET=seu_client_secret_aqui
PORT=3000
```

### 2. Iniciar o servidor
Requer Node.js v18+.

```bash
node server.mjs
```

O servidor responde em `http://localhost:3000`.

## Dados de teste no Sandbox

Na rota inicial (`/`), use o conector de testes:
* Instituição: Pluggy Bank (Sandbox)
* Usuário: `user-ok`
* Senha: `password-ok`

## Conectores PJ reais (Open Finance)

Para testar empréstimos PJ (`/loans`) junto com cartões e investimentos em produção, use os conectores Open Finance (`[OF]`):
* Itaú Empresas
* Banco do Brasil Empresas
* Bradesco Empresas
* Santander Empresas
* BTG Pactual Empresas
* Banco Inter PJ
* C6 Bank Empresas
* Sicoob, Sicredi, Unicred

## Estrutura do projeto

```
├── .agents/skills/      # Regras de integração
├── public/
│   ├── index.html       # Interface visual
│   ├── style.css        # Layout
│   └── app.js           # Lógica do widget, filtros e renderização
├── .env                 # Configurações de ambiente
├── .env.example         # Exemplo de configuração
├── server.mjs           # Servidor HTTP nativo
└── README.md            # Documentação
```

