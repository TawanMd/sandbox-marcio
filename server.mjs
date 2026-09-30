import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
 * Obtém API Key da Pluggy via /auth.
 * Credenciais informadas na tela ficam apenas na memória do servidor (nunca em URL).
 */
let runtimeCreds = null;

async function getApiKey(overrideClientId, overrideClientSecret) {
  if (overrideClientId && overrideClientSecret) {
    runtimeCreds = { clientId: overrideClientId, clientSecret: overrideClientSecret };
    cachedApiKey = null;
  }

  const clientId = runtimeCreds?.clientId || process.env.PLUGGY_CLIENT_ID;
  const clientSecret = runtimeCreds?.clientSecret || process.env.PLUGGY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Credenciais da Pluggy não configuradas. Preencha o .env ou informe na tela.');
  }

  // Utiliza cache se válido (margem de 5 minutos)
  if (cachedApiKey && Date.now() < apiKeyExpiresAt - 300000) {
    return cachedApiKey;
  }

  const response = await pluggyFetch(`${PLUGGY_API_URL}/auth`, {
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
 * Gera o Connect Token para o Widget.
 * clientUserId identifica o usuário final e volta nos webhooks item/*.
 */
async function createConnectToken(apiKey, clientUserId) {
  const response = await pluggyFetch(`${PLUGGY_API_URL}/connect_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey
    },
    body: JSON.stringify({
      options: { clientUserId }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro ao gerar connect token (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.accessToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PluggyApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function pluggyFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
}

// 404 (ex.: identidade indisponível) vira o fallback; 401/403/429/5xx são erros reais e não podem
// aparecer como "sem dados".
async function getJson(url, headers, fallback) {
  const res = await pluggyFetch(url, { headers });
  if (res.ok) return res.json();
  if (res.status === 401 || res.status === 403) {
    cachedApiKey = null; // força reautenticação na próxima chamada
    throw new PluggyApiError('A Pluggy recusou a chamada (401/403). Confira as credenciais e tente novamente.', res.status);
  }
  if (res.status === 429) throw new PluggyApiError('Limite de requisições da Pluggy atingido. Aguarde um instante e tente novamente.', 429);
  if (res.status >= 500) throw new PluggyApiError(`A Pluggy está instável (${res.status}). Tente novamente em instantes.`, 502);
  return fallback;
}

/**
 * Lista todas as transações de uma conta (/v2/transactions, paginação por cursor)
 */
async function fetchAllTransactions(apiKey, accountId, period) {
  const headers = { 'X-API-KEY': apiKey };
  const params = new URLSearchParams({ accountId });
  if (period?.from && period?.to) {
    params.set('dateFrom', period.from);
    params.set('dateTo', period.to);
  }

  const all = [];
  let query = `?${params}`;
  for (let page = 0; query && page < 50; page++) {
    const data = await getJson(`${PLUGGY_API_URL}/v2/transactions${query}`, headers, { results: [], next: null });
    all.push(...(data.results || []));
    query = data.next || null;
  }
  return all;
}

/**
 * Coleta os dados completos de um Item na Pluggy (somente dados reais da API)
 */
async function fetchItemSummary(apiKey, itemId, customPeriod = null) {
  const headers = { 'X-API-KEY': apiKey };

  // 1. Status do Item (aguarda brevemente se ainda estiver sincronizando)
  let item = await getJson(`${PLUGGY_API_URL}/items/${itemId}`, headers, { id: itemId, status: 'UNKNOWN' });
  if (item.status === 'UPDATING' || item.status === 'CREATING') {
    await sleep(2500);
    item = await getJson(`${PLUGGY_API_URL}/items/${itemId}`, headers, item);
  }

  // 2. Contas (com uma nova tentativa caso a sincronização ainda esteja finalizando)
  let accounts = (await getJson(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`, headers, { results: [] })).results || [];
  if (accounts.length === 0 && item.status !== 'LOGIN_ERROR' && item.status !== 'OUTDATED') {
    await sleep(2000);
    accounts = (await getJson(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`, headers, { results: [] })).results || [];
  }

  const period = customPeriod || getMMinusOnePeriod();
  let periodFallback = false;

  // Busca transações no período; se vier vazio, usa os lançamentos mais recentes (comum no sandbox)
  const loadTransactions = async (account) => {
    let txs = await fetchAllTransactions(apiKey, account.id, period);
    if (txs.length === 0) {
      txs = await fetchAllTransactions(apiKey, account.id, null);
      if (txs.length > 0) periodFallback = true;
    }
    return txs;
  };

  // 3. Cartões de crédito
  const creditAccounts = accounts.filter((acc) => acc.type === 'CREDIT' || acc.subtype === 'CREDIT_CARD');
  const cardStatements = [];
  for (const card of creditAccounts) {
    const transactions = await loadTransactions(card);
    cardStatements.push({ account: card, period, transactions, totalTransactions: transactions.length });
  }

  // 4. Conta corrente
  const checkingTransactions = [];
  for (const bank of accounts.filter((acc) => acc.type === 'BANK')) {
    checkingTransactions.push(...(await loadTransactions(bank)));
  }

  // 5. Investimentos, empréstimos e identidade da empresa
  const [invData, loansData, identity] = await Promise.all([
    getJson(`${PLUGGY_API_URL}/investments?itemId=${itemId}`, headers, { results: [] }),
    getJson(`${PLUGGY_API_URL}/loans?itemId=${itemId}`, headers, { results: [] }),
    getJson(`${PLUGGY_API_URL}/identity?itemId=${itemId}`, headers, null)
  ]);

  return {
    item,
    period,
    periodFallback,
    identity,
    accounts,
    cardStatements,
    checkingTransactions,
    investments: invData.results || [],
    loans: loansData.results || [],
    timestamp: new Date().toISOString()
  };
}

// Helpers para tratamento de requisição HTTP
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error('Corpo da requisição muito grande.'));
        req.destroy();
      }
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
    'Cache-Control': 'no-store'
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

const PUBLIC_DIR = path.join(__dirname, 'public');

// Acesso protegido por usuário/senha (HTTP Basic) quando APP_PASSWORD está definida.
// Obrigatório em produção, pois o app exibe dados financeiros reais.
const APP_USER = process.env.APP_USER || 'marcio';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

function isAuthorized(req) {
  if (!APP_PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const safeEqual = (a, b) => {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };
  return safeEqual(user, APP_USER) && safeEqual(rest.join(':'), APP_PASSWORD);
}

// Limita tentativas de senha errada por IP (força bruta): 10 falhas a cada 10 minutos
const failedLogins = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function isBlocked(ip) {
  const entry = failedLogins.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    failedLogins.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILS;
}

function registerFailure(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) failedLogins.set(ip, { count: 1, first: Date.now() });
  else entry.count++;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('Erro não tratado:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erro interno do servidor.' });
    else res.end();
  }
});

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Health check da hospedagem (sem dados)
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const ip = clientIp(req);
  if (APP_PASSWORD && isBlocked(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600' });
    res.end('Muitas tentativas. Aguarde alguns minutos.');
    return;
  }

  if (!isAuthorized(req)) {
    if (req.headers.authorization) registerFailure(ip);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Mister Contador", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso restrito. Informe usuário e senha.');
    return;
  }

  // --- Rotas da API (mesma origem; sem CORS aberto, pois retornam dados financeiros) ---

  // 1. Configuração, período M-1 e ambiente do widget
  if (pathname === '/api/config' && req.method === 'GET') {
    const hasEnvKeys = Boolean(runtimeCreds || (process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET));
    sendJson(res, 200, {
      hasEnvKeys,
      // Remova o sandbox do widget em produção: PLUGGY_INCLUDE_SANDBOX=false
      includeSandbox: process.env.PLUGGY_INCLUDE_SANDBOX !== 'false',
      period: getMMinusOnePeriod()
    });
    return;
  }

  // 2. Geração do Connect Token
  if (pathname === '/api/connect-token' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.clientUserId || String(body.clientUserId).length > 100) {
        sendJson(res, 400, { error: 'clientUserId é obrigatório (até 100 caracteres).' });
        return;
      }
      const apiKey = await getApiKey(body.clientId, body.clientSecret);
      const accessToken = await createConnectToken(apiKey, String(body.clientUserId));
      sendJson(res, 200, { accessToken });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 3. Consulta completa dos dados do Item (contas, cartão, extrato, investimentos, empréstimos, identidade)
  if (pathname === '/api/item-data' && req.method === 'GET') {
    try {
      const itemId = parsedUrl.searchParams.get('itemId');
      const from = parsedUrl.searchParams.get('from');
      const to = parsedUrl.searchParams.get('to');
      const label = parsedUrl.searchParams.get('label');

      if (!itemId || !UUID_RE.test(itemId)) {
        sendJson(res, 400, { error: 'O parâmetro itemId é obrigatório e deve ser um UUID válido.' });
        return;
      }
      if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
        sendJson(res, 400, { error: 'Datas devem estar no formato AAAA-MM-DD.' });
        return;
      }

      const customPeriod = (from && to) ? { from, to, label: label || `${from} a ${to}` } : null;
      const apiKey = await getApiKey();
      const summary = await fetchItemSummary(apiKey, itemId, customPeriod);
      lastFetchedSummary = summary;
      sendJson(res, 200, summary);
    } catch (err) {
      sendJson(res, err instanceof PluggyApiError ? err.status : 500, { error: err.message });
    }
    return;
  }

  // 4. Retorna o último JSON retornado da API da Pluggy
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
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'Caminho inválido' });
    return;
  }
  const filePath = decodedPath === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, decodedPath);

  // Impede path traversal para fora de /public
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: 'Arquivo não encontrado' });
    return;
  }

  const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 500, { error: 'Erro ao carregar arquivo estático' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// Suporte ao flag --test para validação sem subir porta
if (process.argv.includes('--test')) {
  console.log('✅ Sintaxe do server.mjs validada com sucesso.');
  console.log('Período M-1 calculado:', getMMinusOnePeriod());
  process.exit(0);
}

if (process.env.NODE_ENV === 'production' && !APP_PASSWORD) {
  console.error('❌ Defina APP_PASSWORD para rodar em produção (o app expõe dados financeiros).');
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} recebido, encerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

server.listen(PORT, () => {
  if (!APP_PASSWORD) console.warn('⚠️  APP_PASSWORD não definida: acesso sem senha (use apenas em localhost).');
  console.log(`🚀 Mister Contador + Pluggy rodando em http://localhost:${PORT}`);
  console.log(`Período M-1 ativo: ${getMMinusOnePeriod().label} (${getMMinusOnePeriod().from} até ${getMMinusOnePeriod().to})`);
});
