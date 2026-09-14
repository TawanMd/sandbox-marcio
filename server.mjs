import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carrega variáveis do arquivo .env caso exista
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch {
  // Arquivo .env não encontrado ou vazio, prossegue com process.env
}

const PORT = process.env.PORT || 3000;
const PLUGGY_API_URL = 'https://api.pluggy.ai';

// Cache do token da API Pluggy e do último resultado consultado
let cachedApiKey = null;
let apiKeyExpiresAt = 0;
let lastFetchedSummary = null;

/**
 * Calcula o período de M-1 (mês anterior completo)
 */
export function getMMinusOnePeriod(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);

  const pad = (n) => String(n).padStart(2, '0');
  const format = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const label = firstDay.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  return {
    from: format(firstDay),
    to: format(lastDay),
    label: label.charAt(0).toUpperCase() + label.slice(1)
  };
}

/**
 * Obtém API Key da Pluggy via /auth
 */
async function getApiKey(overrideClientId, overrideClientSecret) {
  const clientId = overrideClientId || process.env.PLUGGY_CLIENT_ID;
  const clientSecret = overrideClientSecret || process.env.PLUGGY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Credenciais da Pluggy não configuradas. Preencha o .env ou informe na tela.');
  }

  // Utiliza cache se válido (margem de 5 minutos)
  if (cachedApiKey && Date.now() < apiKeyExpiresAt - 300000 && !overrideClientId) {
    return cachedApiKey;
  }

  const response = await fetch(`${PLUGGY_API_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro na autenticação da Pluggy (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  cachedApiKey = data.apiKey;
  // Expira em 2 horas
  apiKeyExpiresAt = Date.now() + 2 * 60 * 60 * 1000;
  return cachedApiKey;
}

/**
 * Gera o Connect Token para o Widget
 */
async function createConnectToken(apiKey, clientUserId = 'sandbox-mvp-user') {
  const response = await fetch(`${PLUGGY_API_URL}/connect_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey
    },
    body: JSON.stringify({
      options: {
        clientUserId,
        clientTypes: ['BUSINESS'] // Mostra apenas contas PJ (BUSINESS_BANK)
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro ao gerar connect token (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.accessToken;
}

/**
 * Coleta os dados completos de um Item na Pluggy
 */
async function fetchItemSummary(apiKey, itemId, customPeriod = null) {
  const headers = { 'X-API-KEY': apiKey };

  // 1. Consulta o status do Item (com breve espera se estiver finalizando sync)
  let itemRes = await fetch(`${PLUGGY_API_URL}/items/${itemId}`, { headers });
  let item = itemRes.ok ? await itemRes.json() : { id: itemId, status: 'UNKNOWN' };

  if (item.status === 'UPDATING' || item.status === 'CREATING') {
    // Aguarda até 3 segundos para o conector sandbox/produção processar os dados iniciais
    await new Promise((r) => setTimeout(r, 2500));
    const recheck = await fetch(`${PLUGGY_API_URL}/items/${itemId}`, { headers });
    if (recheck.ok) item = await recheck.json();
  }

  // 2. Consulta as Contas (com retry caso a sincronização ainda esteja finalizando)
  let accountsRes = await fetch(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`, { headers });
  let accountsData = accountsRes.ok ? await accountsRes.json() : { results: [] };
  let accounts = accountsData.results || [];

  if (accounts.length === 0 && item.status !== 'LOGIN_ERROR' && item.status !== 'OUTDATED') {
    await new Promise((r) => setTimeout(r, 2000));
    accountsRes = await fetch(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`, { headers });
    accountsData = accountsRes.ok ? await accountsRes.json() : { results: [] };
    accounts = accountsData.results || [];
  }

  // Identifica contas de cartão de crédito
  const creditAccounts = accounts.filter(
    (acc) => acc.type === 'CREDIT' || acc.subtype === 'CREDIT_CARD'
  );

  // 3. Transações de Cartão de Crédito via /v2/transactions
  const period = customPeriod || getMMinusOnePeriod();
  const cardStatements = [];

  for (const card of creditAccounts) {
    let txUrl = `${PLUGGY_API_URL}/v2/transactions?accountId=${card.id}`;
    if (period?.from && period?.to) {
      txUrl += `&dateFrom=${period.from}&dateTo=${period.to}`;
    }
    let txRes = await fetch(txUrl, { headers });
    let txData = txRes.ok ? await txRes.json() : { results: [] };
    let transactions = txData.results || [];

    // Se o filtro de data fechada M-1 não encontrar lançamentos no sandbox, busca os lançamentos recentes
    if (transactions.length === 0) {
      const allTxRes = await fetch(`${PLUGGY_API_URL}/v2/transactions?accountId=${card.id}`, { headers });
      if (allTxRes.ok) {
        const allTxData = await allTxRes.json();
        transactions = allTxData.results || [];
      }
    }

    cardStatements.push({
      account: card,
      period,
      transactions,
      totalTransactions: transactions.length
    });
  }

  // 3.1 Transações de Conta Corrente via /v2/transactions
  const checkingAccounts = accounts.filter((acc) => acc.type === 'BANK');
  const checkingTransactions = [];
  for (const bank of checkingAccounts) {
    let txUrl = `${PLUGGY_API_URL}/v2/transactions?accountId=${bank.id}`;
    if (period?.from && period?.to) {
      txUrl += `&dateFrom=${period.from}&dateTo=${period.to}`;
    }
    let txRes = await fetch(txUrl, { headers });
    let txData = txRes.ok ? await txRes.json() : { results: [] };
    let txs = txData.results || [];

    // Se o filtro de data fechada M-1 não encontrar lançamentos no sandbox, busca os lançamentos recentes
    if (txs.length === 0) {
      const allTxRes = await fetch(`${PLUGGY_API_URL}/v2/transactions?accountId=${bank.id}`, { headers });
      if (allTxRes.ok) {
        const allTxData = await allTxRes.json();
        txs = allTxData.results || [];
      }
    }
    checkingTransactions.push(...txs);
  }

  // 4. Consulta de Aplicações / Investimentos
  const invRes = await fetch(`${PLUGGY_API_URL}/investments?itemId=${itemId}`, { headers });
  const invData = invRes.ok ? await invRes.json() : { results: [] };
  const investments = invData.results || [];

  // 5. Consulta de Empréstimos
  const loansRes = await fetch(`${PLUGGY_API_URL}/loans?itemId=${itemId}`, { headers });
  const loansData = loansRes.ok ? await loansRes.json() : { results: [] };
  const loans = loansData.results || [];

  return {
    item,
    period,
    accounts,
    cardStatements,
    checkingTransactions,
    investments,
    loans,
    timestamp: new Date().toISOString()
  };
}

/**
 * Dados simulados do Sandbox para validação imediata da UI
 */
function getMockSandboxData(customFrom = null, customTo = null, customLabel = null) {
  const defaultPeriod = getMMinusOnePeriod();
  const period = (customFrom && customTo)
    ? { from: customFrom, to: customTo, label: customLabel || `${customFrom} até ${customTo}` }
    : defaultPeriod;
  return {
    item: {
      id: 'mock-sandbox-item-001',
      connectorId: 0,
      connector: { name: 'Pluggy Bank (Sandbox)', imageUrl: 'https://cdn.pluggy.ai/assets/pluggy-bank.png' },
      status: 'UPDATED',
      executionStatus: 'SUCCESS',
      createdAt: new Date().toISOString()
    },
    period,
    accounts: [
      {
        id: 'acc-checking-01',
        type: 'BANK',
        subtype: 'CHECKING_ACCOUNT',
        name: 'Conta Corrente Sandbox',
        balance: 21544.60,
        currencyCode: 'BRL',
        bankData: {
          transferNumber: '123/0001/12345-0',
          closingBalance: 21544.60
        }
      },
      {
        id: 'acc-card-01',
        type: 'CREDIT',
        subtype: 'CREDIT_CARD',
        name: 'Cartão Pluggy Black',
        balance: -2480.90,
        currencyCode: 'BRL',
        creditData: {
          brand: 'MASTERCARD',
          level: 'BLACK',
          creditLimit: 25000.00,
          availableCreditLimit: 22519.10,
          balanceCloseDate: `${period.to}`,
          balanceDueDate: `${period.from.slice(0, 7)}-10`
        }
      }
    ],
    cardStatements: [
      {
        account: {
          id: 'acc-card-01',
          name: 'Cartão Pluggy Black',
          creditData: {
            brand: 'MASTERCARD',
            level: 'BLACK',
            creditLimit: 25000.00,
            availableCreditLimit: 22519.10,
            balanceCloseDate: `${period.to}`,
            balanceDueDate: `${period.from.slice(0, 7)}-10`
          }
        },
        period,
        totalTransactions: 8,
        transactions: [
          {
            id: 'tx-001',
            date: `${period.from.slice(0, 8)}04`,
            description: 'NETFLIX.COM',
            descriptionRaw: 'NETFLIX.COM',
            amount: -55.90,
            currencyCode: 'BRL',
            category: 'Serviços e Streaming',
            type: 'DEBIT',
            classification: '3.1.1.02.0.00008',
            accountCode: '5',
            creditCardMetadata: { installmentNumber: 1, totalInstallments: 1, totalAmount: -55.90 }
          },
          {
            id: 'tx-002',
            date: `${period.from.slice(0, 8)}06`,
            description: 'UBER *TRIP BR',
            descriptionRaw: 'UBER *TRIP BR',
            amount: -34.80,
            currencyCode: 'BRL',
            category: 'Transporte e Mobilidade',
            type: 'DEBIT',
            classification: '3.1.1.04.0.00012',
            accountCode: '5'
          },
          {
            id: 'tx-003',
            date: `${period.from.slice(0, 8)}10`,
            description: 'IFOOD *RESTAURANTE 4402',
            descriptionRaw: 'IFOOD *RESTAURANTE 4402',
            amount: -89.50,
            currencyCode: 'BRL',
            category: 'Alimentação e Refeições',
            type: 'DEBIT',
            classification: '3.1.1.02.0.00015',
            accountCode: '5'
          },
          {
            id: 'tx-004',
            date: `${period.from.slice(0, 8)}12`,
            description: 'AMAZON.COM.BR MARKETPLACE',
            descriptionRaw: 'AMAZON.COM.BR MARKETPLACE',
            amount: -249.90,
            currencyCode: 'BRL',
            category: 'Compras e Suprimentos',
            type: 'DEBIT',
            classification: '3.1.1.02.0.00020',
            accountCode: '5',
            creditCardMetadata: { installmentNumber: 1, totalInstallments: 3, totalAmount: -749.70 }
          },
          {
            id: 'tx-005',
            date: `${period.from.slice(0, 8)}15`,
            description: 'POSTO IPIRANGA COMBUSTIVEL',
            descriptionRaw: 'POSTO IPIRANGA COMBUSTIVEL',
            amount: -220.00,
            currencyCode: 'BRL',
            category: 'Transporte e Combustível',
            type: 'DEBIT',
            classification: '3.1.1.04.0.00012',
            accountCode: '5'
          },
          {
            id: 'tx-006',
            date: `${period.from.slice(0, 8)}18`,
            description: 'DROGASIL FARMACIA 441',
            descriptionRaw: 'DROGASIL FARMACIA 441',
            amount: -112.40,
            currencyCode: 'BRL',
            category: 'Saúde e Medicamentos',
            type: 'DEBIT',
            classification: '3.1.1.02.0.00025',
            accountCode: '5'
          },
          {
            id: 'tx-007',
            date: `${period.from.slice(0, 8)}22`,
            description: 'SMART FIT ACADEMIA',
            descriptionRaw: 'SMART FIT ACADEMIA',
            amount: -129.90,
            currencyCode: 'BRL',
            category: 'Serviços e Bem-Estar',
            type: 'DEBIT',
            classification: '3.1.1.02.0.00030',
            accountCode: '5'
          },
          {
            id: 'tx-008',
            date: `${period.from.slice(0, 8)}28`,
            description: 'PAGAMENTO DE FATURA CARTAO DE CREDITO',
            descriptionRaw: 'PAGAMENTO DE FATURA CARTAO DE CREDITO',
            amount: 1500.00,
            currencyCode: 'BRL',
            category: 'Pagamento de Fatura',
            type: 'CREDIT',
            classification: '2.1.2.01.0.00002',
            accountCode: '5'
          }
        ]
      }
    ],
    checkingTransactions: [
      {
        id: 'tx-chk-001',
        date: `${period.from.slice(0, 8)}01`,
        description: 'SALARIO EMPRESA XYZ LTDA',
        descriptionRaw: 'SALARIO EMPRESA XYZ LTDA',
        amount: 8500.00,
        currencyCode: 'BRL',
        category: 'Salário / Proventos',
        type: 'CREDIT',
        classification: '1.1.1.01.0.00001',
        accountCode: '5'
      },
      {
        id: 'tx-chk-002',
        date: `${period.from.slice(0, 8)}05`,
        description: 'PAGAMENTO DE BOLETO - CONDOMINIO RESIDENCIAL',
        descriptionRaw: 'PAGAMENTO DE BOLETO - CONDOMINIO RESIDENCIAL',
        amount: -650.00,
        currencyCode: 'BRL',
        category: 'Moradia / Contas',
        type: 'DEBIT',
        classification: '3.1.2.01.0.00001',
        accountCode: '5',
        paymentData: {
          receiver: { name: 'Condomínio Residencial Central' },
          paymentMethod: 'BOLETO'
        }
      },
      {
        id: 'tx-chk-003',
        date: `${period.from.slice(0, 8)}10`,
        description: 'ENERGIA ELETRICA ENEL SAO PAULO',
        descriptionRaw: 'ENERGIA ELETRICA ENEL SAO PAULO',
        amount: -185.40,
        currencyCode: 'BRL',
        category: 'Serviços Públicos',
        type: 'DEBIT',
        classification: '3.1.2.01.0.00002',
        accountCode: '5'
      },
      {
        id: 'tx-chk-004',
        date: `${period.from.slice(0, 8)}15`,
        description: 'TRANSFERENCIA PIX RECEBIDA - CLIENTE JOAO SILVA',
        descriptionRaw: 'TRANSFERENCIA PIX RECEBIDA - CLIENTE JOAO SILVA',
        amount: 1200.00,
        currencyCode: 'BRL',
        category: 'Transferência Recebida',
        type: 'CREDIT',
        classification: '1.1.1.01.0.00001',
        accountCode: '5'
      }
    ],
    investments: [
      {
        id: 'inv-001',
        name: 'CDB DI Liquidez Diária',
        type: 'FIXED_INCOME',
        subtype: 'CDB',
        balance: 45000.00,
        currencyCode: 'BRL',
        annualRate: 100,
        rateType: 'CDI',
        dueDate: '2027-12-31',
        institution: 'Pluggy Invest'
      },
      {
        id: 'inv-002',
        name: 'Tesouro Selic 2029',
        type: 'FIXED_INCOME',
        subtype: 'TREASURY',
        balance: 15500.00,
        currencyCode: 'BRL',
        annualRate: 100,
        rateType: 'SELIC',
        dueDate: '2029-03-01',
        institution: 'Tesouro Direto'
      },
      {
        id: 'inv-003',
        name: 'Fundo Multimercado Macro FIC',
        type: 'MUTUAL_FUND',
        subtype: 'MULTIMARKET',
        balance: 28350.75,
        currencyCode: 'BRL',
        institution: 'Pluggy Asset'
      }
    ],
    loans: [
      {
        id: 'loan-001',
        contractNumber: 'CTR-884920-2024',
        type: 'PERSONAL_LOAN',
        contractAmount: 30000.00,
        outstandingBalance: 14500.00,
        currencyCode: 'BRL',
        interestRate: 1.89,
        interestRateType: 'MONTHLY',
        installmentsTotal: 24,
        installmentsPaid: 13,
        installmentsRemaining: 11,
        installmentAmount: 1620.50,
        dueDate: '2026-10-15'
      }
    ],
    timestamp: new Date().toISOString()
  };
}

// Helpers para tratamento de requisição HTTP
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Mapeamento de tipos MIME para arquivos estáticos
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // --- Rotas da API ---

  // 1. Configuração e período M-1
  if (pathname === '/api/config' && req.method === 'GET') {
    const hasEnvKeys = Boolean(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
    sendJson(res, 200, {
      hasEnvKeys,
      period: getMMinusOnePeriod()
    });
    return;
  }

  // 2. Geração do Connect Token
  if (pathname === '/api/connect-token' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const apiKey = await getApiKey(body.clientId, body.clientSecret);
      const accessToken = await createConnectToken(apiKey, body.clientUserId || 'sandbox-user');
      sendJson(res, 200, { accessToken });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 3. Consulta completa dos dados do Item (Cartão, Investimentos, Empréstimos)
  if (pathname === '/api/item-data' && req.method === 'GET') {
    try {
      const itemId = parsedUrl.searchParams.get('itemId');
      const overrideClientId = parsedUrl.searchParams.get('clientId');
      const overrideClientSecret = parsedUrl.searchParams.get('clientSecret');
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      const label = parsedUrl.searchParams.get('label');

      if (!itemId) {
        sendJson(res, 400, { error: 'O parâmetro itemId é obrigatório.' });
        return;
      }

      const customPeriod = (from && to) ? { from, to, label: label || `${from} a ${to}` } : null;
      const apiKey = await getApiKey(overrideClientId, overrideClientSecret);
      const summary = await fetchItemSummary(apiKey, itemId, customPeriod);
      lastFetchedSummary = summary;
      sendJson(res, 200, summary);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 4. Dados mockados para testes da UI sem credenciais
  if (pathname === '/api/mock-data' && req.method === 'GET') {
    const from = parsedUrl.searchParams.get('from');
    const to = parsedUrl.searchParams.get('to');
    const label = parsedUrl.searchParams.get('label');
    sendJson(res, 200, getMockSandboxData(from, to, label));
    return;
  }

  // 5. Retorna o último JSON retornado da API da Pluggy
  if (pathname === '/api/last-data' && req.method === 'GET') {
    if (lastFetchedSummary) {
      sendJson(res, 200, lastFetchedSummary);
    } else {
      sendJson(res, 200, {
        status: 'AGUARDANDO_CONEXAO',
        message: 'Nenhum Item conectado ainda. Conecte sua conta via Pluggy Connect Widget para consultar os dados reais da API.',
        data: null
      });
    }
    return;
  }

  // --- Servidor de Arquivos Estáticos ---
  let filePath = (pathname === '/' || pathname === '/simulado')
    ? path.join(__dirname, 'public', 'index.html')
    : path.join(__dirname, 'public', pathname);

  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'Arquivo não encontrado' });
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 500, { error: 'Erro ao carregar arquivo estático' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

// Suporte ao flag --test para validação sem subir porta
if (process.argv.includes('--test')) {
  console.log('✅ Sintaxe do server.mjs validada com sucesso.');
  console.log('Período M-1 calculado:', getMMinusOnePeriod());
  process.exit(0);
}

server.listen(PORT, () => {
  console.log(`🚀 Pluggy Sandbox MVP rodando em http://localhost:${PORT}`);
  console.log(`Período M-1 ativo: ${getMMinusOnePeriod().label} (${getMMinusOnePeriod().from} até ${getMMinusOnePeriod().to})`);
});
