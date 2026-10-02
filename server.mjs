import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rodando como servidor (node server.mjs) ou importado pelos testes (só as funções exportadas)?
const IS_MAIN = (() => {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(process.argv[1]) === norm(__filename);
})();

// Carrega variáveis do arquivo .env caso exista (não sobrescreve o que já veio do ambiente)
if (IS_MAIN) {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile();
    }
  } catch {
    // Arquivo .env não encontrado ou vazio, prossegue com process.env
  }
}

const IS_PROD = process.env.NODE_ENV === 'production';
// O Render define RENDER=true em todo serviço: lá a senha é obrigatória mesmo se faltar NODE_ENV
const REQUIRE_PASSWORD = IS_PROD || Boolean(process.env.RENDER);
const PORT = Number(process.env.PORT) || 3000;

// Acesso protegido por usuário/senha (HTTP Basic) quando APP_PASSWORD está definida.
// Obrigatório em produção, pois o app exibe dados financeiros reais.
const APP_USER = process.env.APP_USER || 'marcio';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MIN_PASSWORD_LENGTH = 12;
// Sem senha, o app só escuta no próprio computador
const HOST = process.env.HOST || (APP_PASSWORD ? '0.0.0.0' : '127.0.0.1');
// Quantos proxies confiáveis acrescentam o IP real ao X-Forwarded-For (0 = usa o IP da conexão)
const TRUST_PROXY_HOPS = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY_HOPS) || 0));
// App single-tenant: o dono das conexões na Pluggy é o usuário do login (volta nos webhooks item/*)
const CLIENT_USER_ID = APP_PASSWORD ? APP_USER : 'local-dev';

// Ajustes só para desenvolvimento/testes (ignorados em produção): Pluggy falsa, timeout e espera menores
const devSetting = (name) => (IS_PROD ? '' : process.env[name] || '');
const numberSetting = (name, fallback) => {
  const n = Number(devSetting(name));
  return devSetting(name) !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};
const PLUGGY_API_URL = (devSetting('PLUGGY_API_URL') || 'https://api.pluggy.ai').replace(/\/+$/, '');
const PLUGGY_TIMEOUT_MS = numberSetting('PLUGGY_TIMEOUT_MS', 20000) || 20000;
// Espera máxima (com backoff) por um Item em UPDATING antes de responder com syncing: true
const ITEM_POLL_MAX_MS = numberSetting('PLUGGY_POLL_MAX_MS', 25000);

const API_KEY_TTL_MS = 2 * 60 * 60 * 1000; // API Key da Pluggy vale 2 horas
const API_KEY_MARGIN_MS = 5 * 60 * 1000;
const CATEGORY_TTL_MS = 24 * 60 * 60 * 1000;
const CATEGORY_RETRY_MS = 5 * 60 * 1000;
const MAX_TX_PAGES = 50; // por conta, /v2/transactions (cursor)
const MAX_LIST_PAGES = 20; // listas paginadas por número de página
const MAX_PERIOD_DAYS = 366;
const SANDBOX_FALLBACK_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = 'America/Sao_Paulo';

// Último resumo consultado (só para /api/last-data, e só para o mesmo itemId)
let lastFetched = null; // { itemId, summary }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Mensagens mostradas ao Márcio (sem jargão). O detalhe técnico vai só para o console do servidor.
const MSG = {
  notConfigured: 'A integração com a Pluggy ainda não foi configurada neste servidor. Peça ao suporte para concluir a configuração.',
  credsNeededDev: 'Informe o Client ID e o Client Secret da Pluggy para continuar.',
  runtimeRefused: 'A Pluggy não aceitou o Client ID e o Client Secret informados. Confira os dados e tente novamente.',
  pluggyAuth: 'A Pluggy recusou o acesso deste servidor. Peça ao suporte para conferir a configuração.',
  rateLimit: 'Foram feitas muitas consultas à Pluggy em pouco tempo. Aguarde um minuto e tente novamente.',
  unavailable: 'Não foi possível falar com a Pluggy agora. Tente novamente em instantes.',
  timeout: 'A Pluggy demorou demais para responder. Tente novamente em instantes.',
  itemNotFound: 'Esta conexão com o banco não existe mais (foi removida ou expirou). Conecte a conta novamente.',
  invalidItem: 'Não foi possível identificar a conexão com o banco. Conecte a conta novamente.',
  invalidRequest: 'Requisição inválida. Recarregue a página e tente novamente.',
  internal: 'Algo deu errado no servidor. Tente novamente em instantes.',
  notFound: 'Página ou recurso não encontrado.'
};

/**
 * Erro com status HTTP e código do contrato ({ error, code }).
 * pluggyStatus guarda o status original da Pluggy, quando o erro veio de lá.
 */
class AppError extends Error {
  constructor(status, code, message, pluggyStatus = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.pluggyStatus = pluggyStatus;
  }
}

const validationError = (message) => new AppError(400, 'VALIDATION', message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

// --- Datas e período -------------------------------------------------------------------------

// Hoje (AAAA-MM-DD) no fuso de Brasília, independente do fuso do servidor (UTC no Render)
function todayInBrazil(referenceDate = new Date()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(referenceDate)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// AAAA-MM-DD → número do dia (UTC); null se a data não existir no calendário (ex.: 2026-02-30)
function parseDay(value) {
  const m = DATE_RE.exec(value || '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime() / DAY_MS;
}

function formatDay(dayNumber) {
  const dt = new Date(dayNumber * DAY_MS);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

const addDays = (isoDate, n) => formatDay(parseDay(isoDate) + n);
const toBrDate = (isoDate) => isoDate.split('-').reverse().join('/');

/**
 * Calcula o período de M-1 (mês anterior completo) no fuso America/Sao_Paulo
 */
export function getMMinusOnePeriod(referenceDate = new Date()) {
  const [year, month] = todayInBrazil(referenceDate).split('-').map(Number); // month: 1-12
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return {
    from: `${y}-${pad(m)}-01`,
    to: `${y}-${pad(m)}-${pad(lastDay)}`,
    label: label.charAt(0).toUpperCase() + label.slice(1)
  };
}

// Lê from/to/label da query. Sem datas → M-1. Valida datas reais, from <= to e no máximo 366 dias.
function parsePeriod(params) {
  const from = params.get('from');
  const to = params.get('to');
  if (!from && !to) return getMMinusOnePeriod();
  if (!from || !to) throw validationError('Informe a data inicial e a data final do período.');

  const start = parseDay(from);
  const end = parseDay(to);
  if (start === null || end === null) throw validationError('Uma das datas do período não existe. Confira e tente novamente.');
  if (start > end) throw validationError('A data inicial precisa ser anterior ou igual à data final.');
  if (end - start + 1 > MAX_PERIOD_DAYS) throw validationError(`O período pode ter no máximo ${MAX_PERIOD_DAYS} dias. Escolha um intervalo menor.`);

  const label = (params.get('label') || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  const mMinusOne = getMMinusOnePeriod();
  const defaultLabel = from === mMinusOne.from && to === mMinusOne.to ? mMinusOne.label : `${toBrDate(from)} a ${toBrDate(to)}`;
  return { from, to, label: label || defaultLabel };
}

function requireItemId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw validationError(MSG.invalidItem);
  return value;
}

const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// --- Comunicação com a Pluggy ------------------------------------------------------------------

// Chamada HTTP crua (lê o corpo inteiro dentro do mesmo timeout). Timeout/rede viram erro amigável.
async function pluggyFetch(url, { method = 'GET', apiKey, body, context }) {
  const headers = {};
  if (apiKey) headers['X-API-KEY'] = apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(PLUGGY_TIMEOUT_MS)
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    return { ok: res.ok, status: res.status, data, text };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      console.error(`[pluggy] ${context}: sem resposta em ${PLUGGY_TIMEOUT_MS} ms`);
      throw new AppError(504, 'TIMEOUT', MSG.timeout);
    }
    console.error(`[pluggy] ${context}: falha de rede (${err?.cause?.code || err?.message || err})`);
    throw new AppError(502, 'PLUGGY_UNAVAILABLE', MSG.unavailable);
  }
}

// Registra no console o que a Pluggy respondeu (code/codeDescription/message), sem segredos
function logPluggyFailure(context, res) {
  const d = res.data && typeof res.data === 'object' ? res.data : {};
  const detail = [d.codeDescription, d.message].filter(Boolean).join(' - ') || String(res.text || '').slice(0, 200);
  console.error(`[pluggy] ${context}: HTTP ${res.status}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`);
}

// Converte uma resposta de erro da Pluggy em erro do contrato (e registra o detalhe)
function pluggyError(res, context) {
  logPluggyFailure(context, res);
  if (res.status === 401 || res.status === 403) return new AppError(502, 'PLUGGY_AUTH', MSG.pluggyAuth, res.status);
  if (res.status === 429) return new AppError(429, 'RATE_LIMIT', MSG.rateLimit, res.status);
  return new AppError(502, 'PLUGGY_UNAVAILABLE', MSG.unavailable, res.status);
}

/**
 * Credenciais e API Key da Pluggy.
 * Credenciais digitadas na tela só valem fora de produção e sem chaves no ambiente; ficam apenas
 * na memória do servidor e só são gravadas depois que o /auth as aceita.
 */
let runtimeCreds = null; // { clientId, clientSecret }
let apiKeyCache = null; // { apiKey, clientId, expiresAt }
let authInFlight = null; // { clientId, promise } — evita vários /auth simultâneos

const hasEnvKeys = () => Boolean(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
const allowRuntimeCreds = () => !IS_PROD && !hasEnvKeys();

function activeCreds() {
  if (hasEnvKeys()) return { clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET };
  if (allowRuntimeCreds() && runtimeCreds) return runtimeCreds;
  return null;
}

async function requestApiKey(creds, refusedMessage) {
  const res = await pluggyFetch(`${PLUGGY_API_URL}/auth`, {
    method: 'POST',
    body: { clientId: creds.clientId, clientSecret: creds.clientSecret },
    context: 'POST /auth'
  });
  if (res.ok && typeof res.data?.apiKey === 'string') return res.data.apiKey;
  logPluggyFailure('POST /auth', res);
  // 400 (ex.: clientId fora do formato), 401 CLIENT_KEYS_UNAUTHORIZED, 403 CLIENT_DISABLED.
  // Sem pluggyStatus de propósito: falha de autenticação nunca vira "produto indisponível" (optionalProduct).
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new AppError(502, 'PLUGGY_AUTH', refusedMessage);
  if (res.status === 429) throw new AppError(429, 'RATE_LIMIT', MSG.rateLimit);
  throw new AppError(502, 'PLUGGY_UNAVAILABLE', MSG.unavailable);
}

async function getApiKey() {
  const creds = activeCreds();
  if (!creds) throw new AppError(502, 'PLUGGY_AUTH', allowRuntimeCreds() ? MSG.credsNeededDev : MSG.notConfigured);

  // Utiliza cache se válido (margem de 5 minutos) e se foi gerado pelas mesmas credenciais
  if (apiKeyCache && apiKeyCache.clientId === creds.clientId && Date.now() < apiKeyCache.expiresAt - API_KEY_MARGIN_MS) {
    return apiKeyCache.apiKey;
  }
  if (authInFlight && authInFlight.clientId === creds.clientId) return authInFlight.promise;

  const promise = requestApiKey(creds, MSG.pluggyAuth)
    .then((apiKey) => {
      // Só grava se as credenciais ativas não mudaram enquanto o /auth estava em andamento
      if (activeCreds()?.clientId === creds.clientId) {
        apiKeyCache = { apiKey, clientId: creds.clientId, expiresAt: Date.now() + API_KEY_TTL_MS };
      }
      return apiKey;
    })
    .finally(() => {
      if (authInFlight?.promise === promise) authInFlight = null;
    });
  authInFlight = { clientId: creds.clientId, promise };
  return promise;
}

// Descarta a API Key só se ainda for a que falhou (outra chamada pode já ter renovado)
function invalidateApiKey(apiKey) {
  if (apiKeyCache?.apiKey === apiKey) apiKeyCache = null;
}

// Credenciais digitadas na tela (só em desenvolvimento): valida no /auth ANTES de gravar
async function setRuntimeCredentials(clientId, clientSecret) {
  const apiKey = await requestApiKey({ clientId, clientSecret }, MSG.runtimeRefused);
  runtimeCreds = { clientId, clientSecret };
  apiKeyCache = { apiKey, clientId, expiresAt: Date.now() + API_KEY_TTL_MS };
}

// Chamada autenticada. Em 401/403 (API Key vencida ou revogada) autentica de novo e repete uma única vez.
async function pluggyCall(pathAndQuery, { method = 'GET', body, context } = {}) {
  const ctx = context || `${method} ${pathAndQuery.split('?')[0]}`;
  let apiKey = await getApiKey();
  let res = await pluggyFetch(PLUGGY_API_URL + pathAndQuery, { method, body, apiKey, context: ctx });
  if (res.status === 401 || res.status === 403) {
    logPluggyFailure(`${ctx} (reautenticando)`, res);
    invalidateApiKey(apiKey);
    apiKey = await getApiKey();
    res = await pluggyFetch(PLUGGY_API_URL + pathAndQuery, { method, body, apiKey, context: ctx });
  }
  return res;
}

// GET que devolve o JSON; erro da Pluggy vira AppError. allow404: devolve null em 404 (sem log).
async function pluggyGetJson(pathAndQuery, { allow404 = false } = {}) {
  const ctx = `GET ${pathAndQuery.split('?')[0]}`;
  const res = await pluggyCall(pathAndQuery, { context: ctx });
  if (res.ok && res.data && typeof res.data === 'object') return res.data;
  if (res.status === 404 && allow404) return null;
  throw pluggyError(res, ctx);
}

// Listas paginadas por número de página (page/totalPages): accounts, investments, loans, bills, categories
async function fetchAllPages(basePath, params, state, { allow404 = false } = {}) {
  const all = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    if (page > MAX_LIST_PAGES) {
      state.truncated = true;
      break;
    }
    const qs = new URLSearchParams(params);
    if (page > 1) qs.set('page', String(page));
    const query = qs.toString();
    const data = await pluggyGetJson(query ? `${basePath}?${query}` : basePath, { allow404 });
    if (data === null) break;
    if (Array.isArray(data.results)) all.push(...data.results);
    totalPages = Number(data.totalPages) || 1;
  }
  return all;
}

/**
 * Lista as transações de uma conta no intervalo (/v2/transactions, paginação por cursor).
 * dateFrom/dateTo vão como AAAA-MM-DD: o campo date da Pluggy representa o dia (meia-noite UTC), por isso
 * o app usa a data "pura" (slice(0, 10)). Converter para o fuso de Brasília jogaria o lançamento para o dia anterior.
 */
async function fetchTransactions(accountId, range, state) {
  const params = new URLSearchParams({ accountId, dateFrom: range.from, dateTo: range.to });
  const all = [];
  let query = `?${params}`;
  for (let page = 0; query; page++) {
    if (page >= MAX_TX_PAGES) {
      state.truncated = true;
      break;
    }
    const data = await pluggyGetJson(`/v2/transactions${query}`);
    if (Array.isArray(data.results)) all.push(...data.results);
    // next já é a query pronta da próxima página (filtros + cursor), ou null na última
    query = typeof data.next === 'string' && data.next.startsWith('?') ? data.next : null;
  }
  return all;
}

// Nomes das categorias em português (GET /categories), em memória por 24 h
let categoryCache = { names: null, expiresAt: 0 };
let categoryInFlight = null;

async function getCategoryNames() {
  if (Date.now() < categoryCache.expiresAt) return categoryCache.names;
  if (categoryInFlight) return categoryInFlight;
  categoryInFlight = (async () => {
    try {
      const list = await fetchAllPages('/categories', {}, { truncated: false });
      const names = new Map();
      for (const c of list) {
        if (c?.id && typeof c.descriptionTranslated === 'string' && c.descriptionTranslated) names.set(String(c.id), c.descriptionTranslated);
      }
      categoryCache = { names, expiresAt: Date.now() + CATEGORY_TTL_MS };
    } catch (err) {
      // Só cosmético: segue sem tradução e tenta de novo em alguns minutos (mantém a lista antiga, se houver)
      console.error(`[pluggy] GET /categories: categorias sem tradução desta vez (${err.code || err.message})`);
      categoryCache = { names: categoryCache.names, expiresAt: Date.now() + CATEGORY_RETRY_MS };
    } finally {
      categoryInFlight = null;
    }
    return categoryCache.names;
  })();
  return categoryInFlight;
}

// --- Item, avisos e resumo ---------------------------------------------------------------------

async function getItem(itemId) {
  const item = await pluggyGetJson(`/items/${itemId}`, { allow404: true });
  if (!item) throw new AppError(404, 'ITEM_NOT_FOUND', MSG.itemNotFound, 404);
  return item;
}

// Enquanto o Item estiver UPDATING, consulta de novo com backoff (1 s, 2 s, 4 s, 8 s, 10 s...) até ~25 s
async function waitWhileUpdating(itemId) {
  let item = await getItem(itemId);
  let waited = 0;
  for (let i = 0; item.status === 'UPDATING'; i++) {
    const delay = Math.min(1000 * 2 ** i, 10_000);
    if (waited + delay > ITEM_POLL_MAX_MS) break;
    await sleep(delay);
    waited += delay;
    item = await getItem(itemId);
  }
  return item;
}

// Nomes dos produtos (chaves de statusDetail e das leituras opcionais), com artigo, para as mensagens
const PRODUCT_LABELS = {
  accounts: 'as contas',
  creditCards: 'os cartões de crédito',
  transactions: 'os lançamentos',
  investments: 'os investimentos',
  investmentsTransactions: 'as movimentações de investimentos',
  identity: 'os dados cadastrais',
  paymentData: 'os dados de pagamento',
  loans: 'os empréstimos',
  accountStatements: 'os extratos',
  bills: 'as faturas do cartão'
};

function addWarning(warnings, product, message) {
  if (!warnings.some((w) => w.product === product && w.message === message)) warnings.push({ product, message });
}

// Avisos de sincronização parcial: executionStatus PARTIAL_SUCCESS e statusDetail.<produto>
function itemWarnings(item) {
  const warnings = [];
  const detail = item.statusDetail && typeof item.statusDetail === 'object' ? item.statusDetail : {};
  for (const [product, info] of Object.entries(detail)) {
    if (!info || typeof info !== 'object') continue;
    const label = PRODUCT_LABELS[product] || 'parte dos dados';
    if (info.isUpdated === false) {
      addWarning(warnings, product, `Na última sincronização com o banco, não foi possível atualizar ${label}. Essas informações podem estar desatualizadas ou incompletas.`);
    }
    for (const w of Array.isArray(info.warnings) ? info.warnings : []) {
      const providerMessage = typeof w?.providerMessage === 'string' ? w.providerMessage.trim().slice(0, 300) : '';
      addWarning(warnings, product, providerMessage
        ? `Aviso do banco sobre ${label}: ${providerMessage}`
        : `O banco limitou o compartilhamento de ${label} (por exemplo, por falta de permissão). Algumas informações podem não aparecer.`);
    }
  }
  if (item.executionStatus === 'PARTIAL_SUCCESS' && warnings.length === 0) {
    addWarning(warnings, 'item', 'A última sincronização com o banco terminou só em parte: alguns dados podem estar incompletos.');
  }
  return warnings;
}

// Produtos opcionais (faturas, investimentos, empréstimos, identidade): um 4xx da Pluggy (produto
// indisponível neste conector) não derruba a consulta; vira valor vazio + aviso. 429/5xx/timeout seguem como erro.
async function optionalProduct(task, { product, fallback, warnings }) {
  try {
    return await task();
  } catch (err) {
    const status = err instanceof AppError ? err.pluggyStatus : null;
    if (status && status >= 400 && status < 500 && status !== 429) {
      addWarning(warnings, product, `Não foi possível ler ${PRODUCT_LABELS[product]} desta conexão agora. As outras informações foram carregadas normalmente.`);
      return fallback;
    }
    throw err;
  }
}

/**
 * Coleta os dados completos de um Item na Pluggy (somente dados reais da API)
 */
async function fetchItemSummary(itemId, period) {
  const state = { truncated: false };

  // 1. Status do Item (aguarda enquanto sincroniza) e avisos de sincronização parcial
  const item = await waitWhileUpdating(itemId);
  const syncing = item.status === 'UPDATING';
  const warnings = itemWarnings(item);

  // 2. Contas
  const accounts = await fetchAllPages('/accounts', { itemId }, state);
  const cards = accounts.filter((acc) => acc.type === 'CREDIT' || acc.subtype === 'CREDIT_CARD');
  const banks = accounts.filter((acc) => acc.type === 'BANK' && !cards.includes(acc));
  const txAccounts = [...cards, ...banks];

  // 3. Lançamentos no período. Fallback (últimos 90 dias) só em conector sandbox e só quando TODAS
  //    as contas vieram vazias: em banco real, um período sem movimento é informação, não falha.
  const loadTransactions = async () => {
    const loadAll = (range) => Promise.all(txAccounts.map((acc) => fetchTransactions(acc.id, range, state)));
    const inPeriod = await loadAll(period);
    if (item.connector?.isSandbox === true && txAccounts.length > 0 && inPeriod.every((list) => list.length === 0)) {
      const today = todayInBrazil();
      const range = { from: addDays(today, -SANDBOX_FALLBACK_DAYS), to: today };
      const recent = await loadAll(range);
      if (recent.some((list) => list.length > 0)) return { lists: recent, fallbackRange: range };
    }
    return { lists: inPeriod, fallbackRange: null };
  };

  // 4. Faturas dos cartões, investimentos, empréstimos, identidade e categorias (em paralelo)
  const [txResult, billsByCard, investments, loans, identity, categoryNames] = await Promise.all([
    loadTransactions(),
    Promise.all(cards.map((card) => optionalProduct(
      () => fetchAllPages('/bills', { accountId: card.id }, state, { allow404: true }),
      { product: 'bills', fallback: [], warnings }
    ))),
    optionalProduct(() => fetchAllPages('/investments', { itemId }, state), { product: 'investments', fallback: [], warnings }),
    optionalProduct(() => fetchAllPages('/loans', { itemId }, state), { product: 'loans', fallback: [], warnings }),
    optionalProduct(() => pluggyGetJson(`/identity?itemId=${itemId}`, { allow404: true }), { product: 'identity', fallback: null, warnings }),
    getCategoryNames()
  ]);

  // Descrição da categoria em português (categoryId → GET /categories); omitida se não houver
  const translate = (tx) => {
    const name = tx?.categoryId ? categoryNames?.get(String(tx.categoryId)) : null;
    if (name) tx.categoryTranslated = name;
    return tx;
  };
  const txLists = txResult.lists.map((list) => list.map(translate));

  const cardStatements = cards.map((card, i) => ({
    account: card,
    period,
    transactions: txLists[i],
    totalTransactions: txLists[i].length,
    bills: billsByCard[i]
  }));
  const checkingTransactions = txLists.slice(cards.length).flat();

  return {
    item,
    syncing,
    warnings,
    period,
    periodFallback: Boolean(txResult.fallbackRange),
    fallbackRange: txResult.fallbackRange,
    truncated: state.truncated,
    identity: identity || null,
    accounts,
    cardStatements,
    checkingTransactions,
    investments,
    loans,
    timestamp: new Date().toISOString()
  };
}

/**
 * Gera o Connect Token para o Widget. Com itemId, o token permite ATUALIZAR esse Item (updateItem no widget).
 * Não usamos avoidDuplicates: o app guarda o itemId só no navegador e, se ele se perder, a reconexão
 * do mesmo banco precisa continuar possível.
 */
async function createConnectToken(itemId) {
  const options = { clientUserId: CLIENT_USER_ID };
  const payload = itemId ? { itemId, options } : { options };
  const res = await pluggyCall('/connect_token', { method: 'POST', body: payload, context: 'POST /connect_token' });
  if (res.ok && typeof res.data?.accessToken === 'string') return res.data.accessToken;
  if (res.status === 404 && itemId) {
    logPluggyFailure('POST /connect_token', res);
    throw new AppError(404, 'ITEM_NOT_FOUND', MSG.itemNotFound, 404);
  }
  throw pluggyError(res, 'POST /connect_token');
}

// --- HTTP: corpo, respostas e arquivos estáticos -----------------------------------------------

const MAX_BODY_BYTES = 10_000;

// Lê o corpo JSON (já com Content-Type conferido). Precisa ser um objeto.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
      req.resume();
      reject(validationError(MSG.invalidRequest));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return reject(validationError(MSG.invalidRequest));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return reject(validationError(MSG.invalidRequest));
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return reject(validationError(MSG.invalidRequest));
      resolve(data);
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

// Erro no formato do contrato. Erros inesperados: detalhe só no console, mensagem genérica ao usuário.
function sendError(res, err, context) {
  if (err instanceof AppError) {
    sendJson(res, err.status, { error: err.message, code: err.code }, err.code === 'RATE_LIMIT' ? { 'Retry-After': '60' } : {});
    return;
  }
  console.error(`[${context}] erro inesperado:`, err);
  sendJson(res, 500, { error: MSG.internal, code: 'INTERNAL' });
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

// --- Login (HTTP Basic) e limite de tentativas --------------------------------------------------

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
const APP_USER_DIGEST = sha256(APP_USER);
const APP_PASSWORD_DIGEST = sha256(APP_PASSWORD);

// Compara digests de tamanho fixo (não vaza o tamanho) e sempre avalia usuário E senha
function isAuthorized(req) {
  if (!APP_PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!/^Basic /i.test(header)) return false;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
  const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
  const okUser = crypto.timingSafeEqual(sha256(user), APP_USER_DIGEST);
  const okPass = crypto.timingSafeEqual(sha256(pass), APP_PASSWORD_DIGEST);
  return okUser && okPass;
}

// Limita tentativas de senha errada por IP (força bruta): 10 falhas a cada 10 minutos.
// Acima de 30 falhas no total (todos os IPs), cada nova falha demora mais para responder,
// sem bloquear quem acerta a senha.
const failedLogins = new Map(); // ip → { count, first } (ordem de inserção = mais antigo primeiro)
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const LOGIN_MAP_MAX = 10_000;
const GLOBAL_FAIL_THRESHOLD = 30;
const GLOBAL_DELAY_STEP_MS = 250;
const GLOBAL_MAX_DELAY_MS = 5000;
let globalFails = { count: 0, first: 0 };

// IP do cliente: o valor do X-Forwarded-For anexado pelo proxy confiável mais externo
// (TRUST_PROXY_HOPS posições a partir da direita). Nunca o primeiro valor, que o cliente controla.
function clientIp(req) {
  if (TRUST_PROXY_HOPS > 0) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const idx = parts.length - TRUST_PROXY_HOPS;
    if (idx >= 0 && parts[idx]) return parts[idx];
  }
  return req.socket.remoteAddress || 'unknown';
}

// Segundos restantes de bloqueio para o IP (0 = liberado)
function blockedSeconds(ip) {
  const entry = failedLogins.get(ip);
  if (!entry) return 0;
  const elapsed = Date.now() - entry.first;
  if (elapsed > LOGIN_WINDOW_MS) {
    failedLogins.delete(ip);
    return 0;
  }
  return entry.count >= LOGIN_MAX_FAILS ? Math.ceil((LOGIN_WINDOW_MS - elapsed) / 1000) : 0;
}

// Registra a falha e devolve o atraso (ms) a aplicar antes de responder
function registerFailure(ip) {
  const now = Date.now();
  const entry = failedLogins.get(ip);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    failedLogins.delete(ip);
    if (failedLogins.size >= LOGIN_MAP_MAX) failedLogins.delete(failedLogins.keys().next().value);
    failedLogins.set(ip, { count: 1, first: now });
  } else {
    entry.count++;
  }
  if (now - globalFails.first > LOGIN_WINDOW_MS) globalFails = { count: 0, first: now };
  globalFails.count++;
  const excess = globalFails.count - GLOBAL_FAIL_THRESHOLD;
  return excess > 0 ? Math.min(GLOBAL_MAX_DELAY_MS, excess * GLOBAL_DELAY_STEP_MS) : 0;
}

// Limpeza periódica das entradas vencidas (não segura o processo aberto)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failedLogins) {
    if (now - entry.first > LOGIN_WINDOW_MS) failedLogins.delete(ip);
  }
}, 60_000).unref();

// --- Cabeçalhos e checagens de origem -----------------------------------------------------------

const CSP = "default-src 'self'; script-src 'self' https://cdn.pluggy.ai; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src https://*.pluggy.ai; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // HSTS só em produção (atrás de HTTPS); em localhost forçaria https:// no navegador
  ...(IS_PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
};

const normalizeHost = (h) => String(h || '').trim().toLowerCase().replace(/:(80|443)$/, '');

// Pedido vindo de outro site (CSRF)? Compara o host do Origin com o header Host — não o esquema,
// porque atrás do proxy do Render o Node recebe http.
function isCrossOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return true;
  try {
    return normalizeHost(new URL(origin).host) !== normalizeHost(req.headers.host);
  } catch {
    return true;
  }
}

const isJsonRequest = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';

// Sem senha, só atende pelo próprio computador (barra acesso pela rede e DNS rebinding)
function isLocalHostHeader(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

// --- Servidor ------------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('Erro não tratado:', err);
    if (!res.headersSent) sendJson(res, 500, { error: MSG.internal, code: 'INTERNAL' });
    else res.end();
  }
});

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url || '/', 'http://localhost');
  const pathname = parsedUrl.pathname;
  const isApi = pathname.startsWith('/api/');

  // Health check da hospedagem (sem dados)
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }

  if (!APP_PASSWORD && !isLocalHostHeader(req.headers.host)) {
    sendJson(res, 403, { error: 'Sem senha configurada, o app só pode ser aberto neste computador (localhost).', code: 'FORBIDDEN_ORIGIN' });
    return;
  }

  const ip = clientIp(req);
  const blocked = APP_PASSWORD ? blockedSeconds(ip) : 0;
  if (blocked) {
    const msg = 'Muitas tentativas de senha errada. Aguarde alguns minutos e tente de novo.';
    if (isApi) {
      sendJson(res, 429, { error: msg, code: 'RATE_LIMIT' }, { 'Retry-After': String(blocked) });
    } else {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(blocked) });
      res.end(msg);
    }
    return;
  }

  if (!isAuthorized(req)) {
    if (req.headers.authorization) {
      const delay = registerFailure(ip);
      if (delay) await sleep(delay);
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Mister Contador", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso restrito. Informe usuário e senha.');
    return;
  }

  // Proteção contra CSRF: métodos que alteram estado só da própria página; POST só com JSON
  // (form de outro site não consegue mandar application/json sem preflight, que não é atendido).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (isCrossOrigin(req)) {
      sendJson(res, 403, { error: 'Pedido recusado: ele não veio da página do app.', code: 'FORBIDDEN_ORIGIN' });
      return;
    }
    if (req.method === 'POST' && !isJsonRequest(req)) {
      req.resume();
      sendJson(res, 415, { error: 'Formato de pedido não suportado. Recarregue a página e tente novamente.', code: 'UNSUPPORTED_MEDIA_TYPE' });
      return;
    }
  }

  // --- Rotas da API (mesma origem; sem CORS aberto, pois retornam dados financeiros) ---

  // 1. Configuração, período M-1 e ambiente do widget
  if (pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, {
      hasEnvKeys: hasEnvKeys(),
      allowRuntimeCreds: allowRuntimeCreds(),
      // Sandbox no widget: padrão ligado fora de produção e desligado em produção (PLUGGY_INCLUDE_SANDBOX=true/false força)
      includeSandbox: process.env.PLUGGY_INCLUDE_SANDBOX === 'true' || (process.env.PLUGGY_INCLUDE_SANDBOX !== 'false' && !IS_PROD),
      period: getMMinusOnePeriod()
    });
    return;
  }

  // 2. Geração do Connect Token (conexão nova ou atualização de um Item, com itemId)
  if (pathname === '/api/connect-token' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      // clientUserId não vem mais do navegador (ver CLIENT_USER_ID); se vier, é ignorado
      const itemId = body.itemId === undefined || body.itemId === null || body.itemId === '' ? null : requireItemId(body.itemId);

      const { clientId, clientSecret } = body;
      if (clientId || clientSecret) {
        if (!allowRuntimeCreds()) {
          console.warn('[connect-token] clientId/clientSecret enviados pela tela foram ignorados: aqui as credenciais vêm só do ambiente.');
        } else {
          if (typeof clientId !== 'string' || !UUID_RE.test(clientId.trim())) {
            throw validationError('O Client ID deve ser copiado do painel da Pluggy (formato 00000000-0000-0000-0000-000000000000).');
          }
          if (typeof clientSecret !== 'string' || !clientSecret.trim() || clientSecret.length > 200) {
            throw validationError('Informe o Client Secret da Pluggy.');
          }
          await setRuntimeCredentials(clientId.trim(), clientSecret.trim());
        }
      }

      const accessToken = await createConnectToken(itemId);
      sendJson(res, 200, { accessToken });
    } catch (err) {
      sendError(res, err, 'connect-token');
    }
    return;
  }

  // 3. Consulta completa dos dados do Item (contas, cartão, extrato, investimentos, empréstimos, identidade)
  if (pathname === '/api/item-data' && req.method === 'GET') {
    try {
      const itemId = requireItemId(parsedUrl.searchParams.get('itemId'));
      const period = parsePeriod(parsedUrl.searchParams);
      const summary = await fetchItemSummary(itemId, period);
      // Enquanto o Item sincroniza os dados podem estar incompletos: não guarda como "último resumo"
      if (!summary.syncing) lastFetched = { itemId, summary };
      sendJson(res, 200, summary);
    } catch (err) {
      sendError(res, err, 'item-data');
    }
    return;
  }

  // 4. Revoga o consentimento: DELETE /items/{id} na Pluggy (404 = já não existia)
  if (pathname === '/api/item' && req.method === 'DELETE') {
    try {
      const itemId = requireItemId(parsedUrl.searchParams.get('itemId'));
      const pluggyRes = await pluggyCall(`/items/${itemId}`, { method: 'DELETE', context: 'DELETE /items/{id}' });
      if (!pluggyRes.ok && pluggyRes.status !== 404) throw pluggyError(pluggyRes, 'DELETE /items/{id}');
      if (lastFetched && sameId(lastFetched.itemId, itemId)) lastFetched = null;
      sendJson(res, 200, { revoked: true });
    } catch (err) {
      sendError(res, err, 'delete-item');
    }
    return;
  }

  // 5. Último resumo consultado, só para o mesmo itemId (suporte/depuração)
  if (pathname === '/api/last-data' && req.method === 'GET') {
    try {
      const itemId = requireItemId(parsedUrl.searchParams.get('itemId'));
      if (lastFetched && sameId(lastFetched.itemId, itemId)) {
        sendJson(res, 200, lastFetched.summary);
      } else {
        sendJson(res, 404, { error: 'Ainda não há uma consulta recente desta conexão. Abra os dados da conta primeiro.', code: 'NOT_FOUND' });
      }
    } catch (err) {
      sendError(res, err, 'last-data');
    }
    return;
  }

  if (isApi || !['GET', 'HEAD'].includes(req.method)) {
    sendJson(res, 404, { error: MSG.notFound, code: 'NOT_FOUND' });
    return;
  }

  // --- Servidor de Arquivos Estáticos ---
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: MSG.invalidRequest, code: 'VALIDATION' });
    return;
  }
  const filePath = decodedPath === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, decodedPath);

  // Impede path traversal para fora de /public
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: MSG.notFound, code: 'NOT_FOUND' });
    return;
  }

  const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.error('[static] erro ao ler arquivo:', err.message);
      sendJson(res, 500, { error: MSG.internal, code: 'INTERNAL' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

// Problemas de configuração que impedem subir com segurança
function startupProblems() {
  const problems = [];
  if (REQUIRE_PASSWORD && !APP_PASSWORD) {
    problems.push('Defina APP_PASSWORD para rodar em produção (o app expõe dados financeiros).');
  } else if (REQUIRE_PASSWORD && APP_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    problems.push(`APP_PASSWORD precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres em produção.`);
  }
  if (IS_PROD && !hasEnvKeys()) {
    problems.push('Defina PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET: em produção as credenciais da Pluggy vêm só do ambiente.');
  }
  return problems;
}

if (IS_MAIN) {
  // Suporte ao flag --test para validação sem subir porta
  if (process.argv.includes('--test')) {
    console.log('✅ Sintaxe do server.mjs validada com sucesso.');
    console.log('Período M-1 calculado:', getMMinusOnePeriod());
    process.exit(0);
  }

  const problems = startupProblems();
  if (problems.length) {
    for (const p of problems) console.error(`❌ ${p}`);
    process.exit(1);
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`${signal} recebido, encerrando...`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }

  server.on('error', (err) => {
    console.error(`❌ Não foi possível abrir ${HOST}:${PORT} (${err.code || err.message}).`);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    if (!APP_PASSWORD) console.warn('⚠️  APP_PASSWORD não definida: acesso sem senha, só por este computador (localhost).');
    if (IS_PROD && TRUST_PROXY_HOPS === 0) {
      console.warn('⚠️  TRUST_PROXY_HOPS=0: o limite de tentativas de senha usa o IP da conexão. Atrás de proxy (Render), configure TRUST_PROXY_HOPS.');
    }
    const period = getMMinusOnePeriod();
    console.log(`🚀 Mister Contador + Pluggy rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Período M-1 ativo: ${period.label} (${period.from} até ${period.to})`);
  });
}
