# MVP Pluggy Sandbox — Mister Contador / Conta Azul

Ambiente de validação e demonstração da integração com a API da **Pluggy** (Open Finance & Sandbox) focado no fluxo contábil de contas **Pessoa Jurídica (PJ)**, reproduzindo a interface de conciliação e partidas dobradas do **Mister Contador**.

---

## 🎯 Casos de Uso PJ Validados

1. **Extrato de Cartão de Crédito PJ:**
   * Regra padrão de **mês anterior fechado (M-1)**.
   * Filtro interativo por período (atalhos rápidos de meses ou intervalo personalizado "De" / "Até").
   * Lançamentos com despesas, valores, faturas e parcelamentos.

2. **Conta de Aplicação / Investimentos PJ:**
   * Consulta de posições de CDBs com liquidez diária, Tesouro Direto e Fundos de Investimento PJ.
   * Exibição de indexadores (CDI / SELIC), taxas e saldo atualizado.

3. **Conta de Empréstimo PJ (Open Finance):**
   * Contratos de crédito empresarial (Capital de Giro / Pronampe).
   * Acompanhamento de saldo devedor, CET / taxa de juros mensal e parcelas pagas vs. a vencer.

---

## 🌐 Rotas Disponíveis

| Rota | Descrição |
| :--- | :--- |
| `http://localhost:3000/` | **Fluxo com Widget:** Abre o widget oficial da Pluggy Connect em primeiro plano sobre a tela do Mister para conectar a conta e carregar os dados reais. |
| `http://localhost:3000/simulado` | **Apresentação Direta:** Abre diretamente a tela do Mister no formato Excel preenchida com o JSON simulado, sem atrito de login. |

---

## 🚀 Como Executar

O projeto foi desenvolvido em **HTML5 + CSS + JavaScript Vanilla** no frontend e **Node.js nativo** (`server.mjs`) no backend, sem necessidade de dependências externas (`node_modules` ou `npm install`).

### 1. Configuração do `.env`
Preencha as credenciais da Pluggy obtidas no [Dashboard da Pluggy](https://dashboard.pluggy.ai):

```env
PLUGGY_CLIENT_ID=seu_client_id_aqui
PLUGGY_CLIENT_SECRET=seu_client_secret_aqui
PORT=3000
```

### 2. Iniciar o Servidor
Certifique-se de ter o Node.js instalado (v18+) e execute:

```bash
node server.mjs
```

O servidor iniciará em `http://localhost:3000`.

---

## 🧪 Dados de Teste no Sandbox

Ao utilizar o Widget na rota inicial (`/`), utilize o conector de testes:

* **Instituição:** `Pluggy Bank (Sandbox)`
* **Usuário:** `user-ok`
* **Senha:** `password-ok`

---

## 🏛️ Conectores Reais PJ Recomendados (Open Finance)

Para testes futuros em ambiente real com dados PJ, recomenda-se utilizar os conectores via **Open Finance** (`[OF]`), pois são os únicos que suportam **Empréstimos PJ (`/loans`)** em conjunto com **Cartão** e **Investimentos**:

* **Itaú Empresas**
* **Banco do Brasil Empresas**
* **Bradesco Empresas**
* **Santander Empresas**
* **BTG Pactual Empresas**
* **Banco Inter PJ**
* **C6 Bank Empresas**
* **Cooperativas (Sicoob, Sicredi, Unicred)**

---

## 📁 Estrutura do Projeto

```
├── .agents/skills/      # Skills e regras de integração Pluggy
├── public/
│   ├── index.html       # Interface visual do Mister Contador
│   ├── style.css        # Identidade visual e layout Excel
│   └── app.js           # Lógica do widget, filtros e renderização
├── .env                 # Configurações de ambiente (credenciais)
├── .env.example         # Exemplo de configuração
├── server.mjs           # Servidor HTTP nativo e endpoints de API
└── README.md            # Documentação do projeto
```

