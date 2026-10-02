/**
 * Mister Contador — Open Finance Pluggy Integration Controller
 * Visualização e gestão completa com suporte às novas funcionalidades:
 * Início, Registro Contábil, Extrato, Cartão de Crédito, Comprovantes, Estatísticas, Empresa e Permissões.
 * DADOS SEMPRE CARREGADOS DA PLUGGY API (sem mocks).
 *
 * Sem handlers inline (onclick etc.): toda ação usa data-action + um listener delegado em document,
 * o que permite a CSP do servidor sem 'unsafe-inline' em script-src.
 */

const STORAGE_KEY = 'pluggy_connected_item_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOBILE_QUERY = '(max-width: 900px)';
const WIDGET_LOCAL_SRC = 'vendor/pluggy-connect-2.11.0.js';
const WIDGET_CDN_SRC = 'https://cdn.pluggy.ai/pluggy-connect/v2.11.0/pluggy-connect.js';
// sha384 da cópia local em public/vendor (o arquivo do CDN v2.11.0 tem o mesmo hash e responde com
// Access-Control-Allow-Origin: *, conferido em 01/10/2026). Se o CDN mudar o arquivo, o navegador bloqueia.
const WIDGET_CDN_SRI = 'sha384-rDtJqPxBmZdyFCZ0p2es0NV3LAJtP1T7bhxJEKTYrz1QNNQVeOjf1AJX46jG6GDh';
// Status do Item que exigem o usuário entrar de novo no banco (widget em modo updateItem)
const RECONNECT_STATUSES = ['LOGIN_ERROR', 'OUTDATED', 'WAITING_USER_INPUT', 'WAITING_USER_ACTION'];

const state = {
  currentView: 'comprovantes', // 'inicio' | 'registro' | 'extrato' | 'cartao' | 'comprovantes' | 'estatisticas' | 'empresa' | 'permissoes'
  activeData: null,            // Nulo até que haja conexão real com o widget
  connectedItemId: null,
  config: null,
  subTypeFilter: 'all',
  jsonSubTab: 'all',
  currentFilter: null,         // definido em buildPresets() (M-1 por padrão); só muda depois de uma busca com sucesso
  presets: {},
  currentAccount: 'all',
  sort: {                      // ordenação clicável das tabelas (data ou valor)
    comprovantes: { key: 'date', dir: 'desc' },
    extrato: { key: 'date', dir: 'desc' },
    cartao: { key: 'date', dir: 'desc' }
  },
  loading: false,
  loadingFilter: null,         // período sendo buscado (para o aviso "Buscando...")
  loadError: null,             // { message, code, filter } da última busca que falhou (erro transitório)
  requestSeq: 0,               // descarta respostas antigas quando o usuário troca de período várias vezes
  connecting: false,
  runtimeCredsAccepted: false, // Client ID/Secret digitados já aceitos pelo servidor nesta sessão
  openDetails: {}              // <details> abertos sobrevivem ao re-render
};

// Disponibiliza no escopo global para depuração (nenhuma ação da tela depende disso)
window.misterState = state;
window.getPluggyData = () => state.activeData;

// --- Armazenamento local (pode falhar em janela anônima / bloqueio de cookies) ---
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* armazenamento indisponível */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* armazenamento indisponível */ } }
};

// --- Formatadores Úteis ---
function formatMoney(amount, currency = 'BRL') {
  const num = Number(amount);
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(num)) return 'R$ 0,00';
  try {
    return num.toLocaleString('pt-BR', { style: 'currency', currency: currency || 'BRL' });
  } catch {
    return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
}

// O campo date da Pluggy representa o DIA do lançamento (meia-noite UTC). Converter para o fuso de
// Brasília deslocaria para o dia anterior, por isso usamos só a parte AAAA-MM-DD, sem conversão.
// A regex também garante que só dígitos cheguem ao HTML (valor fora do formato vira '—').
function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

function shortDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  return m ? `${m[3]}/${m[2]}` : '—';
}

const dayKey = (value) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''));
  return m ? m[1] : null;
};

// Instantes reais (última sincronização, validade do consentimento): exibidos no horário de Brasília
function formatDateTime(value) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatInstantDate(value) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Número inteiro vindo da API (parcelas): qualquer coisa que não seja número vira null
const safeInt = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : String(Math.trunc(Number(v))));

function escapeHtml(string) {
  if (string === null || string === undefined) return '';
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatPct(n) {
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

// CPF (11 dígitos) e CNPJ (14 dígitos) sempre com máscara; outros formatos (ex.: já mascarados com *) ficam como vieram
function formatDoc(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return value ? String(value) : '';
}

// Fallback para códigos sem tradução: 'CAPITAL_GIRO' → 'Capital giro'
function humanizeCode(code) {
  if (!code) return '';
  const text = String(code).toLowerCase().replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const translate = (dict, code) => (code ? (dict[code] || humanizeCode(code)) : '');

// --- Traduções dos códigos da Pluggy / Open Finance ---
const ITEM_STATUS_LABELS = {
  UPDATED: 'Atualizada',
  UPDATING: 'Sincronizando',
  LOGIN_ERROR: 'Precisa reconectar',
  OUTDATED: 'Desatualizada',
  WAITING_USER_INPUT: 'Aguardando confirmação',
  WAITING_USER_ACTION: 'Aguardando ação no banco',
  CREATING: 'Sendo criada'
};

const INVESTMENT_TYPE_LABELS = {
  FIXED_INCOME: 'Renda fixa',
  MUTUAL_FUND: 'Fundo de investimento',
  EQUITY: 'Renda variável',
  ETF: 'ETF',
  COE: 'COE',
  SECURITY: 'Previdência',
  OTHER: 'Outros'
};

const INVESTMENT_SUBTYPE_LABELS = {
  STRUCTURED_NOTE: 'COE',
  STOCK: 'Ações',
  ETF: 'ETF',
  REAL_ESTATE_FUND: 'Fundo imobiliário (FII)',
  BDR: 'BDR',
  DERIVATIVES: 'Derivativos',
  OPTION: 'Opções',
  TREASURY: 'Tesouro Direto',
  LCI: 'LCI',
  LCA: 'LCA',
  LF: 'Letra Financeira (LF)',
  CDB: 'CDB',
  CRI: 'CRI',
  CRA: 'CRA',
  CORPORATE_DEBT: 'Título de dívida corporativa',
  LC: 'Letra de Câmbio (LC)',
  DEBENTURES: 'Debêntures',
  INVESTMENT_FUND: 'Fundo de investimento',
  MULTIMARKET_FUND: 'Fundo multimercado',
  FIXED_INCOME_FUND: 'Fundo de renda fixa',
  STOCK_FUND: 'Fundo de ações',
  ETF_FUND: 'Fundo de ETF',
  OFFSHORE_FUND: 'Fundo no exterior',
  FIP_FUND: 'Fundo de participações (FIP)',
  EXCHANGE_FUND: 'Fundo cambial',
  FI_INFRA: 'Fundo de infraestrutura',
  FI_AGRO: 'Fiagro',
  RETIREMENT: 'Previdência (PGBL/VGBL)',
  OTHER: 'Outros'
};

// Modalidades de crédito do Open Finance (campo type) e famílias (campo kind)
const LOAN_TYPE_LABELS = {
  HOME_EQUITY: 'Crédito com garantia de imóvel',
  CHEQUE_ESPECIAL: 'Cheque especial',
  CONTA_GARANTIDA: 'Conta garantida',
  CAPITAL_GIRO_TETO_ROTATIVO: 'Capital de giro rotativo',
  CAPITAL_GIRO_PRAZO_VENCIMENTO_ATE_365_DIAS: 'Capital de giro (até 365 dias)',
  CAPITAL_GIRO_PRAZO_VENCIMENTO_SUPERIOR_365_DIAS: 'Capital de giro (mais de 365 dias)',
  CREDITO_PESSOAL_SEM_CONSIGNACAO: 'Crédito pessoal',
  CREDITO_PESSOAL_COM_CONSIGNACAO: 'Crédito consignado',
  MICROCREDITO_PRODUTIVO_ORIENTADO: 'Microcrédito produtivo',
  MICROCREDITO: 'Microcrédito',
  AQUISICAO_BENS_VEICULOS_AUTOMOTORES: 'Financiamento de veículo',
  AQUISICAO_BENS_OUTROS_BENS: 'Financiamento de bens',
  FINANCIAMENTO_HABITACIONAL_SFH: 'Financiamento imobiliário (SFH)',
  FINANCIAMENTO_HABITACIONAL_EXCETO_SFH: 'Financiamento imobiliário',
  CUSTEIO: 'Crédito rural (custeio)',
  INVESTIMENTO: 'Crédito rural (investimento)',
  INDUSTRIALIZACAO: 'Crédito rural (industrialização)',
  COMERCIALIZACAO: 'Crédito rural (comercialização)',
  DESCONTO_DUPLICATAS: 'Desconto de duplicatas',
  DESCONTO_CHEQUES: 'Desconto de cheques',
  ANTECIPACAO_FATURA_CARTAO_CREDITO: 'Antecipação de recebíveis de cartão',
  OUTROS_DIREITOS_CREDITORIOS_DESCONTADOS: 'Outros direitos creditórios descontados',
  OUTROS_TITULOS_DESCONTADOS: 'Outros títulos descontados',
  ADIANTAMENTO_A_DEPOSITANTES: 'Adiantamento a depositante'
};

const LOAN_KIND_LABELS = {
  LOAN: 'Empréstimo',
  FINANCING: 'Financiamento',
  INVOICE_FINANCING: 'Antecipação de recebíveis',
  UNARRANGED_ACCOUNT_OVERDRAFT: 'Adiantamento a depositante'
};

// Método de pagamento (paymentData.paymentMethod) e tipo de operação Open Finance (operationType)
const PAYMENT_METHOD_LABELS = {
  PIX: 'PIX',
  TED: 'TED',
  DOC: 'DOC',
  TEV: 'Transferência entre contas',
  BOLETO: 'Boleto',
  TRANSFERENCIA_MESMA_INSTITUICAO: 'Transferência no mesmo banco',
  CONVENIO_ARRECADACAO: 'Convênio / arrecadação',
  PACOTE_TARIFA_SERVICOS: 'Pacote de tarifas',
  TARIFA_SERVICOS_AVULSOS: 'Tarifa avulsa',
  FOLHA_PAGAMENTO: 'Folha de pagamento',
  DEPOSITO: 'Depósito',
  SAQUE: 'Saque',
  CARTAO: 'Cartão',
  ENCARGOS_JUROS_CHEQUE_ESPECIAL: 'Juros do cheque especial',
  RENDIMENTO_APLIC_FINANCEIRA: 'Rendimento de aplicação',
  RESGATE_APLIC_FINANCEIRA: 'Resgate de aplicação',
  PORTABILIDADE_SALARIO: 'Portabilidade de salário',
  OPERACAO_CREDITO: 'Operação de crédito',
  PAGAMENTO: 'Compra',
  PAGAMENTO_FATURA: 'Pagamento de fatura',
  TARIFA: 'Tarifa',
  OPERACOES_CREDITO_CONTRATADAS_CARTAO: 'Crédito contratado no cartão',
  ESTORNO: 'Estorno',
  CASHBACK: 'Cashback',
  OUTROS: 'Outros'
};

const BILL_CHARGE_LABELS = {
  LATE_PAYMENT_REMUNERATIVE_INTEREST: 'juros remuneratórios por atraso',
  LATE_PAYMENT_FEE: 'multa por atraso',
  LATE_PAYMENT_INTEREST: 'juros de mora',
  IOF: 'IOF',
  OTHER: 'outros encargos'
};

// Produtos do Item (item.products) e chaves de statusDetail
const PRODUCT_LABELS = {
  ACCOUNTS: 'Contas e saldos',
  CREDIT_CARDS: 'Cartões de crédito',
  TRANSACTIONS: 'Lançamentos (extratos)',
  PAYMENT_DATA: 'Dados de pagamento (comprovantes)',
  INVESTMENTS: 'Investimentos',
  INVESTMENTS_TRANSACTIONS: 'Movimentações de investimentos',
  IDENTITY: 'Dados cadastrais',
  BROKERAGE_NOTE: 'Notas de corretagem',
  MOVE_SECURITY: 'Portabilidade de previdência',
  LOANS: 'Empréstimos e financiamentos',
  accounts: 'contas e saldos',
  creditCards: 'cartões de crédito',
  transactions: 'lançamentos',
  investments: 'investimentos',
  investmentsTransactions: 'movimentações de investimentos',
  identity: 'dados cadastrais',
  paymentData: 'comprovantes',
  loans: 'empréstimos',
  accountStatements: 'extratos',
  bills: 'faturas do cartão',
  item: 'parte dos dados'
};

const productLabel = (p) => PRODUCT_LABELS[p] || PRODUCT_LABELS[String(p || '').toUpperCase()] || humanizeCode(p);

// --- Configuração de cada tela (título e controles da barra que fazem sentido nela) ---
const VIEW_CONFIG = {
  inicio:        { title: 'Início', period: false, txFilters: false, account: false, badge: false, print: false },
  registro:      { title: 'Registro Contábil', period: true, txFilters: true, account: true, badge: true, print: true },
  extrato:       { title: 'Extrato Bancário', period: true, txFilters: true, account: true, badge: true, print: true },
  cartao:        { title: 'Cartão de Crédito', period: true, txFilters: true, account: true, badge: true, print: true },
  comprovantes:  { title: 'Comprovantes', period: true, txFilters: true, account: true, badge: true, print: true },
  investimentos: { title: 'Investimentos', period: false, txFilters: false, account: false, badge: false, print: true },
  emprestimos:   { title: 'Empréstimos e Financiamentos', period: false, txFilters: false, account: false, badge: false, print: true },
  estatisticas:  { title: 'Estatísticas (Dashboard)', period: true, txFilters: false, account: true, badge: false, print: true },
  empresa:       { title: 'Empresa', period: false, txFilters: false, account: false, badge: false, print: true },
  permissoes:    { title: 'Permissões e Acesso', period: false, txFilters: false, account: false, badge: false, print: false }
};

// --- Erros: mensagem amigável para o usuário, detalhe técnico só no console ---
const FRIENDLY_ERRORS = {
  VALIDATION: 'Algum dado enviado não está correto. Confira o período escolhido e tente de novo.',
  UNSUPPORTED_MEDIA_TYPE: 'O navegador enviou o pedido de um jeito inesperado. Recarregue a página e tente de novo.',
  FORBIDDEN_ORIGIN: 'O pedido foi bloqueado por segurança. Recarregue a página e tente de novo.',
  ITEM_NOT_FOUND: 'Essa conexão com o banco não existe mais. Conecte o banco de novo.',
  NOT_FOUND: 'Não encontramos o que você pediu.',
  PLUGGY_AUTH: 'O servidor não conseguiu se identificar no serviço de conexão bancária. Avise o suporte.',
  RATE_LIMIT: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.',
  PLUGGY_UNAVAILABLE: 'O serviço de conexão bancária está instável agora. Tente de novo em alguns minutos.',
  TIMEOUT: 'O banco demorou demais para responder. Tente de novo em alguns minutos.',
  INTERNAL: 'Algo deu errado do nosso lado. Tente de novo; se continuar, avise o suporte.',
  NETWORK: 'Não conseguimos falar com o servidor. Verifique a internet e tente de novo.',
  AUTH: 'Sua sessão expirou. Recarregue a página e entre de novo com usuário e senha.'
};

class ApiError extends Error {
  constructor(code, status, userMessage, detail) {
    super(userMessage);
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
    this.detail = detail;
  }
}

function codeFromStatus(status) {
  const map = { 400: 'VALIDATION', 401: 'AUTH', 403: 'FORBIDDEN_ORIGIN', 404: 'NOT_FOUND', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMIT', 502: 'PLUGGY_UNAVAILABLE', 503: 'PLUGGY_UNAVAILABLE', 504: 'TIMEOUT' };
  return map[status] || 'INTERNAL';
}

// Lê o corpo sem quebrar quando a resposta não é JSON (ex.: 401 do login, página de erro do proxy)
async function readJson(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function toApiError(res, body) {
  const status = res?.status || 0;
  const code = (body && typeof body.code === 'string' && body.code) || codeFromStatus(status);
  const serverMsg = body && typeof body.error === 'string' && body.error.trim() ? body.error.trim().slice(0, 300) : null;
  const message = status === 401 ? FRIENDLY_ERRORS.AUTH : (serverMsg || FRIENDLY_ERRORS[code] || FRIENDLY_ERRORS.INTERNAL);
  console.error('[api] falha', status, code, body);
  return new ApiError(code, status, message, body);
}

async function apiFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
  } catch (err) {
    console.error('[rede] falha em', url, err);
    throw new ApiError('NETWORK', 0, FRIENDLY_ERRORS.NETWORK);
  }
  const body = await readJson(res);
  if (!res.ok) throw toApiError(res, body);
  if (body === null) throw toApiError(res, null);
  return body;
}

const userMessageOf = (err) => err?.userMessage || FRIENDLY_ERRORS.INTERNAL;

// =========================================================
// AVISOS (toast) E MODAIS PRÓPRIOS — substituem alert()/confirm()
// =========================================================
function notify(message, type = 'info', { timeout } = {}) {
  const region = document.getElementById('toastRegion');
  if (!region) return;
  const kind = ['success', 'error', 'info'].includes(type) ? type : 'info';
  const el = document.createElement('div');
  el.className = `toast is-${kind}`;
  if (kind === 'error') el.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.dataset.action = 'toast-close';
  close.setAttribute('aria-label', 'Fechar aviso');
  close.textContent = '✕';
  el.append(text, close);
  region.appendChild(el);
  setTimeout(() => el.remove(), timeout ?? (kind === 'error' ? 10000 : 5000));
}

const modalStack = [];

// getClientRects também funciona para elementos position: fixed (offsetParent seria null)
const isVisible = (el) => Boolean(el && el.getClientRects().length);

function focusableIn(root) {
  return [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
    .filter(isVisible);
}

function restoreFocus(target) {
  if (target && document.contains(target) && isVisible(target)) target.focus();
  else document.getElementById('viewHeadingTitle')?.focus();
}

function openModal(overlay, { initialFocus, onDismiss, trigger } = {}) {
  if (!overlay || modalStack.some(m => m.el === overlay)) return;
  modalStack.push({ el: overlay, trigger: trigger || document.activeElement, onDismiss });
  overlay.style.display = 'flex';
  const target = (typeof initialFocus === 'string' ? overlay.querySelector(initialFocus) : initialFocus) || focusableIn(overlay)[0];
  target?.focus();
}

function closeModal(overlay, { returnFocus = true } = {}) {
  if (!overlay) return null;
  overlay.style.display = 'none';
  const idx = modalStack.findIndex(m => m.el === overlay);
  if (idx === -1) return null;
  const [entry] = modalStack.splice(idx, 1);
  if (returnFocus) restoreFocus(entry.trigger);
  return entry;
}

function dismissTopModal() {
  const top = modalStack[modalStack.length - 1];
  if (!top) return;
  if (top.onDismiss) top.onDismiss();
  else closeModal(top.el);
}

// Mantém o Tab dentro do modal aberto
function trapFocus(e, overlay) {
  const items = focusableIn(overlay);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

let confirmResolver = null;

// Confirmação própria: resolve true (confirmou) ou false (cancelou, Esc)
function confirmDialog({ title, message, confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false } = {}) {
  if (confirmResolver) settleConfirm(false);
  const overlay = document.getElementById('confirmOverlay');
  document.getElementById('confirmTitle').textContent = title || 'Confirmar';
  document.getElementById('confirmMessage').textContent = message || '';
  const okBtn = document.getElementById('confirmOkBtn');
  okBtn.textContent = confirmText;
  okBtn.classList.toggle('is-danger', danger);
  document.getElementById('confirmCancelBtn').textContent = cancelText;
  return new Promise(resolve => {
    confirmResolver = resolve;
    // Em ações destrutivas o foco inicial fica em "Cancelar"
    openModal(overlay, { initialFocus: danger ? '#confirmCancelBtn' : '#confirmOkBtn', onDismiss: () => settleConfirm(false) });
  });
}

function settleConfirm(result) {
  const resolve = confirmResolver;
  confirmResolver = null;
  closeModal(document.getElementById('confirmOverlay'));
  resolve?.(result);
}

function openHelp(trigger) {
  openModal(document.getElementById('helpOverlay'), { trigger, initialFocus: '.modal-close-btn' });
}

// =========================================================
// PERÍODOS (calculados no fuso America/Sao_Paulo, como o servidor)
// =========================================================
function todayInSaoPaulo() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type) => Number(parts.find(p => p.type === type)?.value);
  return { y: get('year'), m: get('month') };
}

function monthLabel(isoFrom) {
  const d = new Date(`${isoFrom}T00:00:00Z`);
  return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function monthRange(offset) {
  const { y, m } = todayInSaoPaulo();
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const from = first.toISOString().slice(0, 10);
  return { from, to: last.toISOString().slice(0, 10), label: monthLabel(from) };
}

const capitalize = (t) => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);

function refreshPresetNames() {
  const names = {
    'm-1': `M-1 Fechado (${capitalize(state.presets['m-1'].label)})`,
    current: `Mês Atual (${capitalize(state.presets.current.label)})`,
    'm-2': `${capitalize(state.presets['m-2'].label)} (M-2)`,
    'm-3': `${capitalize(state.presets['m-3'].label)} (M-3)`
  };
  document.querySelectorAll('.preset-btn').forEach(btn => {
    if (names[btn.dataset.preset]) btn.textContent = names[btn.dataset.preset];
  });
}

function buildPresets() {
  state.presets = {
    'm-1': monthRange(-1),
    current: monthRange(0),
    'm-2': monthRange(-2),
    'm-3': monthRange(-3)
  };
  refreshPresetNames();
  state.currentFilter = { ...state.presets['m-1'] };
  syncPeriodControls();
}

// Deixa botão, atalhos e campos de data coerentes com o período que está NA TELA
function syncPeriodControls() {
  const f = state.currentFilter;
  if (!f) return;
  const periodBtnText = document.getElementById('periodBtnText');
  if (periodBtnText) periodBtnText.textContent = capitalize(f.label);
  document.querySelectorAll('.preset-btn').forEach(btn => {
    const p = state.presets[btn.dataset.preset];
    const active = Boolean(p && p.from === f.from && p.to === f.to);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const fromInput = document.getElementById('filterDateFrom');
  const toInput = document.getElementById('filterDateTo');
  if (fromInput) fromInput.value = f.from;
  if (toInput) toInput.value = f.to;
}

function validateRange(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) return 'Informe as duas datas.';
  if (from > to) return 'A data inicial precisa ser anterior (ou igual) à data final.';
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > 366) return 'Escolha um intervalo de no máximo 366 dias.';
  return null;
}

function showRangeError(message) {
  const el = document.getElementById('dateFilterError');
  if (el) {
    el.textContent = message || '';
    el.hidden = !message;
  }
  ['filterDateFrom', 'filterDateTo'].forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  });
}

// --- Inicialização da Aplicação ---
async function init() {
  storage.remove('pluggy_client_user_id'); // clientUserId agora é definido pelo servidor (APP_USER)
  buildPresets();
  setupEventListeners();
  syncSidebarAria();
  await loadConfig();

  // Restaura a conexão salva. Só é esquecida se o servidor disser que o Item não existe (404 ITEM_NOT_FOUND)
  const savedItemId = storage.get(STORAGE_KEY);
  if (savedItemId && UUID_RE.test(savedItemId)) {
    state.connectedItemId = savedItemId;
    updateTopbar();
    updateCompanyPills();
    switchView('comprovantes');
    await fetchItemData(savedItemId, { silent: true });
  } else {
    if (savedItemId) storage.remove(STORAGE_KEY);
    updateTopbar();
    switchView('comprovantes');
  }
}

async function loadConfig() {
  try {
    state.config = await apiFetch('/api/config');
    // M-1 oficial do servidor (fuso America/Sao_Paulo)
    const p = state.config?.period;
    if (p && isIsoDate(p.from) && isIsoDate(p.to)) {
      const wasDefault = state.currentFilter?.from === state.presets['m-1'].from && state.currentFilter?.to === state.presets['m-1'].to;
      state.presets['m-1'] = { from: p.from, to: p.to, label: monthLabel(p.from) };
      refreshPresetNames();
      if (wasDefault) state.currentFilter = { ...state.presets['m-1'] };
      syncPeriodControls();
    }
  } catch (err) {
    console.warn('Não foi possível carregar /api/config:', err);
    state.config = null;
  }
}

// --- Configuração dos Listeners da Interface ---
function setupEventListeners() {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
  // 'toggle' não borbulha: captura para lembrar quais <details> o usuário abriu
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.dataset.detailsId) state.openDetails[d.dataset.detailsId] = d.open;
  }, true);

  // Filtro de Subtipo (Todos, Saídas, Entradas, PIX, Boleto)
  document.getElementById('subTypeSelect')?.addEventListener('change', (e) => {
    state.subTypeFilter = e.target.value;
    renderCurrentView();
  });

  // Filtro de Conta
  document.getElementById('accountSelect')?.addEventListener('change', (e) => {
    state.currentAccount = e.target.value;
    renderCurrentView();
  });

  ['filterDateFrom', 'filterDateTo'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => showRangeError(null));
  });

  // Enter nos campos de data aplica o intervalo
  document.getElementById('dateFilterPopover')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      applyCustomRange();
    }
  });

  // Ctrl+P também recebe o cabeçalho de impressão; depois de imprimir ele é esvaziado
  window.addEventListener('beforeprint', fillPrintHeader);
  window.addEventListener('afterprint', () => {
    const el = document.getElementById('printHeader');
    if (el) el.innerHTML = '';
  });

  const mq = window.matchMedia(MOBILE_QUERY);
  const onMqChange = () => {
    document.body.classList.remove('sidebar-open');
    syncSidebarAria();
  };
  if (mq.addEventListener) mq.addEventListener('change', onMqChange);

  setupVizTooltips();
}

// Um único listener para todos os botões com data-action (inclusive os gerados por innerHTML)
function onDocumentClick(e) {
  // Fecha o popover de período ao clicar fora (os botões que abrem o popover ficam de fora)
  const popover = document.getElementById('dateFilterPopover');
  if (isPeriodPopoverOpen() && !popover.contains(e.target) && !e.target.closest('[data-action="toggle-period"]')) {
    closePeriodPopover();
  }

  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const action = el.dataset.action;

  switch (action) {
    case 'view': {
      // No celular a sidebar fecha depois da escolha, então o foco vai para o título da tela
      const mobile = isMobile();
      switchView(el.dataset.view, { focusHeading: mobile || !el.classList.contains('nav-item') });
      if (mobile) closeSidebar();
      break;
    }
    case 'connect':
      if (state.connectedItemId) connectNewAccount(el);
      else openConnectModal({ mode: 'new', trigger: el });
      break;
    case 'connect-new':
      connectNewAccount(el);
      break;
    case 'reconnect':
      openConnectModal({ mode: 'update', trigger: el });
      break;
    case 'refresh':
      refreshData();
      break;
    case 'retry':
      retryLoad();
      break;
    case 'revoke':
      revokeAccess();
      break;
    case 'help':
      openHelp(el);
      break;
    case 'close-help':
      closeModal(document.getElementById('helpOverlay'));
      break;
    case 'toggle-sidebar':
      toggleSidebar(el);
      break;
    case 'close-sidebar':
      closeSidebar({ returnFocus: true });
      break;
    case 'toggle-period':
      togglePeriodPopover(el);
      break;
    case 'open-period':
      openPeriodPopover(document.getElementById('periodBtn'));
      break;
    case 'close-period':
      closePeriodPopover({ returnFocus: true });
      break;
    case 'preset': {
      const p = state.presets[el.dataset.preset];
      if (p) reloadWithFilter({ ...p });
      break;
    }
    case 'apply-range':
      applyCustomRange();
      break;
    case 'reset-range':
      reloadWithFilter({ ...state.presets['m-1'] });
      break;
    case 'clear-filters':
      clearFilters();
      break;
    case 'sort':
      toggleSort(el.dataset.table, el.dataset.sortKey);
      break;
    case 'json-subtab':
      state.jsonSubTab = el.dataset.subtab || 'all';
      renderCurrentView();
      document.querySelector(`[data-action="json-subtab"][data-subtab="${CSS.escape(state.jsonSubTab)}"]`)?.focus();
      break;
    case 'copy-json':
      copyJson();
      break;
    case 'print':
      fillPrintHeader();
      window.print();
      break;
    case 'close-connect':
      cancelConnect();
      break;
    case 'start-widget':
      startWidget();
      break;
    case 'confirm-ok':
      settleConfirm(true);
      break;
    case 'confirm-cancel':
      settleConfirm(false);
      break;
    case 'toast-close':
      el.closest('.toast')?.remove();
      break;
    default:
      break;
  }
}

function onDocumentKeydown(e) {
  if (e.key === 'Escape') {
    if (modalStack.length) { e.preventDefault(); dismissTopModal(); return; }
    if (isPeriodPopoverOpen()) { e.preventDefault(); closePeriodPopover({ returnFocus: true }); return; }
    if (document.body.classList.contains('sidebar-open')) { closeSidebar({ returnFocus: true }); return; }
  }
  if (e.key === 'Tab' && modalStack.length) trapFocus(e, modalStack[modalStack.length - 1].el);
}

// --- Sidebar: no celular abre por cima (body.sidebar-open); no computador recolhe (body.sidebar-collapsed) ---
let sidebarTrigger = null;
const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;

function toggleSidebar(trigger) {
  if (isMobile()) {
    if (document.body.classList.contains('sidebar-open')) closeSidebar({ returnFocus: true });
    else openSidebar(trigger);
  } else {
    document.body.classList.toggle('sidebar-collapsed');
    syncSidebarAria();
  }
}

function openSidebar(trigger) {
  sidebarTrigger = trigger;
  document.body.classList.add('sidebar-open');
  syncSidebarAria();
  document.querySelector('.sidebar-nav .nav-item.active, .sidebar-nav .nav-item')?.focus();
}

function closeSidebar({ returnFocus = false } = {}) {
  if (!document.body.classList.contains('sidebar-open')) return;
  document.body.classList.remove('sidebar-open');
  syncSidebarAria();
  if (returnFocus) restoreFocus(sidebarTrigger?.id === 'btnSidebarMenu' ? document.getElementById('btnTopbarMenu') : (sidebarTrigger || document.getElementById('btnTopbarMenu')));
}

function syncSidebarAria() {
  const expanded = isMobile() ? document.body.classList.contains('sidebar-open') : !document.body.classList.contains('sidebar-collapsed');
  document.querySelectorAll('[data-action="toggle-sidebar"]').forEach(btn => {
    btn.setAttribute('aria-expanded', String(expanded));
    btn.setAttribute('aria-label', expanded ? 'Fechar menu' : 'Abrir menu');
  });
}

// --- Popover de período ---
let periodTrigger = null;
const isPeriodPopoverOpen = () => document.getElementById('dateFilterPopover')?.style.display === 'block';

function setPeriodExpanded(expanded) {
  document.querySelectorAll('[data-action="toggle-period"]').forEach(btn => btn.setAttribute('aria-expanded', String(expanded)));
}

function openPeriodPopover(trigger) {
  const popover = document.getElementById('dateFilterPopover');
  if (!popover) return;
  periodTrigger = trigger || document.getElementById('periodBtn');
  syncPeriodControls();
  showRangeError(null);
  popover.style.display = 'block';
  setPeriodExpanded(true);
  (popover.querySelector('.preset-btn.active') || popover.querySelector('.preset-btn'))?.focus();
}

function closePeriodPopover({ returnFocus = false } = {}) {
  const popover = document.getElementById('dateFilterPopover');
  if (!popover || popover.style.display === 'none') return;
  popover.style.display = 'none';
  setPeriodExpanded(false);
  if (returnFocus) restoreFocus(periodTrigger || document.getElementById('periodBtn'));
}

function togglePeriodPopover(trigger) {
  if (isPeriodPopoverOpen()) closePeriodPopover({ returnFocus: true });
  else openPeriodPopover(trigger);
}

function applyCustomRange() {
  const from = document.getElementById('filterDateFrom')?.value;
  const to = document.getElementById('filterDateTo')?.value;
  const problem = validateRange(from, to);
  if (problem) {
    showRangeError(problem);
    document.getElementById('filterDateFrom')?.focus();
    return;
  }
  reloadWithFilter({ from, to, label: `${formatDate(from)} até ${formatDate(to)}` });
}

// Recarrega os dados com as datas filtradas. O rótulo só muda depois que a busca dá certo;
// se falhar, os controles voltam ao período que continua na tela.
async function reloadWithFilter(filter) {
  closePeriodPopover({ returnFocus: true });
  if (!state.connectedItemId) {
    state.currentFilter = filter;
    syncPeriodControls();
    renderCurrentView();
    return;
  }
  const result = await fetchItemData(state.connectedItemId, { filter });
  if (!result.ok && !result.stale) syncPeriodControls();
}

function clearFilters() {
  state.subTypeFilter = 'all';
  state.currentAccount = 'all';
  const sub = document.getElementById('subTypeSelect');
  const acc = document.getElementById('accountSelect');
  if (sub) sub.value = 'all';
  if (acc) acc.value = 'all';
  renderCurrentView();
}

function toggleSort(table, key) {
  const current = state.sort[table];
  if (!current || !['date', 'amount'].includes(key)) return;
  state.sort[table] = current.key === key
    ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: 'desc' };
  renderCurrentView();
  document.querySelector(`[data-action="sort"][data-table="${CSS.escape(table)}"][data-sort-key="${CSS.escape(key)}"]`)?.focus();
}

// --- Roteamento entre Visões (Abas da Sidebar) ---
function switchView(viewName, { focusHeading = false } = {}) {
  if (!VIEW_CONFIG[viewName]) viewName = 'comprovantes';
  state.currentView = viewName;

  // Atualiza classe ativa e aria-current nos botões da Sidebar
  document.querySelectorAll('.nav-item').forEach(btn => {
    const active = btn.dataset.view === viewName;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  const titleEl = document.getElementById('viewHeadingTitle');
  if (titleEl) titleEl.textContent = VIEW_CONFIG[viewName].title;
  document.title = `${VIEW_CONFIG[viewName].title} — Mister Contador`;

  updateControlsForView();
  renderCurrentView();
  if (focusHeading) titleEl?.focus();
}

// Mostra só os filtros que fazem efeito na tela atual
function updateControlsForView() {
  const cfg = VIEW_CONFIG[state.currentView];
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  };
  show('btnFilterToggle', cfg.period);
  show('periodWrapper', cfg.period);
  show('subTypeWrapper', cfg.txFilters);
  show('accountPill', cfg.account);
  show('txBadgeRow', cfg.badge);
  show('btnReport', cfg.print);
  if (!cfg.period) closePeriodPopover();
}

// Renderiza a view selecionada
function renderCurrentView() {
  const container = document.getElementById('viewContainer');
  if (!container) return;

  updateHeaderTxCount();
  renderNotices();

  switch (state.currentView) {
    case 'inicio':
      container.innerHTML = renderInicioViewHtml();
      break;
    case 'registro':
      container.innerHTML = renderRegistroContabilHtml();
      break;
    case 'extrato':
      container.innerHTML = renderExtratoHtml();
      break;
    case 'cartao':
      container.innerHTML = renderCartaoHtml();
      break;
    case 'investimentos':
      container.innerHTML = renderInvestimentosHtml();
      break;
    case 'emprestimos':
      container.innerHTML = renderEmprestimosHtml();
      break;
    case 'estatisticas':
      container.innerHTML = renderEstatisticasDashboardHtml();
      break;
    case 'empresa':
      container.innerHTML = renderEmpresaHtml();
      break;
    case 'permissoes':
      container.innerHTML = renderPermissoesHtml();
      break;
    case 'comprovantes':
    default:
      container.innerHTML = renderComprovantesHtml();
  }
}

// Estado de carregamento: tela atual esmaecida (is-loading), aria-busy e controles de período/atualizar travados
function setLoading(on, filter = null, { render = true } = {}) {
  state.loading = on;
  state.loadingFilter = on ? filter : null;
  const container = document.getElementById('viewContainer');
  if (container) {
    container.classList.toggle('is-loading', on);
    container.setAttribute('aria-busy', String(on));
  }
  document.querySelectorAll('.preset-btn, #applyDateFilterBtn, #resetDateFilterBtn, #reopenPluggyBtn').forEach(btn => { btn.disabled = on; });
  updateTopbar();
  if (!render) return;
  // Sem dados na tela (restauração da sessão): re-renderiza para trocar "Nenhum..." por "Buscando..."
  if (!state.activeData) renderCurrentView();
  else renderNotices();
}

// =========================================================
// AJUDANTES DE DADOS (contas, direção, valores, contraparte)
// =========================================================
const accountById = (id) => state.activeData?.accounts?.find(a => a.id === id) || null;
const isCardAccount = (acc) => acc?.type === 'CREDIT' || acc?.subtype === 'CREDIT_CARD';
const isCardTx = (tx) => {
  const acc = accountById(tx.accountId);
  return acc ? isCardAccount(acc) : Boolean(tx.creditCardMetadata);
};

function accountName(accountId) {
  return accountById(accountId)?.name || '—';
}

// Saída de dinheiro: a Pluggy normaliza type (DEBIT = saída, inclusive compra no cartão).
// Só se type faltar usamos o sinal conforme o tipo da conta (BANK: negativo = saída; CREDIT: positivo = saída).
function isOutflow(tx) {
  if (tx.type === 'DEBIT') return true;
  if (tx.type === 'CREDIT') return false;
  const n = Number(tx.amount) || 0;
  return isCardAccount(accountById(tx.accountId)) ? n > 0 : n < 0;
}

// Pagamento de fatura (no cartão ou saindo da conta): não é gasto, a compra já entrou pelo cartão
function isBillPayment(tx) {
  if (tx.operationType === 'PAGAMENTO_FATURA') return true;
  if (tx.category === 'Credit card payment') return true;
  return isCardTx(tx) && tx.type === 'CREDIT';
}

// Valor na moeda da conta (amountInAccountCurrency só vem quando a transação é em outra moeda)
const txAmount = (tx) => Number(tx.amountInAccountCurrency ?? tx.amount) || 0;
const accountCurrency = (tx) => accountById(tx.accountId)?.currencyCode || 'BRL';
const catLabel = (tx) => tx.categoryTranslated || tx.category || '';

function paymentMethodOf(tx) {
  const explicit = tx.paymentData?.paymentMethod || tx.operationType;
  if (explicit) return explicit;
  const desc = String(tx.description || '').toUpperCase();
  if (/\bPIX\b/.test(desc)) return 'PIX';
  if (/\bBOLETO\b/.test(desc)) return 'BOLETO';
  if (/\bTED\b/.test(desc)) return 'TED';
  return null;
}

// Contraparte pela direção: na saída é quem recebeu; na entrada é quem pagou (o outro lado é o próprio titular)
function counterparty(tx) {
  const p = tx.paymentData || {};
  const cp = (isOutflow(tx) ? p.receiver : p.payer) || {};
  const m = tx.merchant || {};
  return {
    name: cp.name || m.businessName || m.name || null,
    doc: cp.documentNumber?.value || m.cnpj || null
  };
}

const compareByDate = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (Number(a.order) || 0) - (Number(b.order) || 0);

function sortTransactions(list, table) {
  const { key, dir } = state.sort[table] || { key: 'date', dir: 'desc' };
  const mul = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const c = key === 'amount' ? Math.abs(txAmount(a)) - Math.abs(txAmount(b)) : 0;
    return (c || compareByDate(a, b)) * mul;
  });
}

// Retorna as transações consolidadas aplicando os filtros de conta e de tipo, mais recentes primeiro
function getFilteredTransactions(source = 'all') {
  if (!state.activeData) return [];

  const chkTxs = state.activeData.checkingTransactions || [];
  const cardTxs = state.activeData.cardStatements?.flatMap(c => c.transactions || []) || [];
  let all = source === 'checking' ? [...chkTxs] : (source === 'card' ? [...cardTxs] : [...chkTxs, ...cardTxs]);

  if (state.currentAccount !== 'all') {
    all = all.filter(t => t.accountId === state.currentAccount);
  }

  if (state.subTypeFilter === 'debit') {
    all = all.filter(isOutflow);
  } else if (state.subTypeFilter === 'credit') {
    all = all.filter(t => !isOutflow(t));
  } else if (state.subTypeFilter === 'pix') {
    all = all.filter(t => paymentMethodOf(t) === 'PIX');
  } else if (state.subTypeFilter === 'boleto') {
    all = all.filter(t => paymentMethodOf(t) === 'BOLETO');
  }

  return all.sort((a, b) => compareByDate(b, a));
}

const filtersActive = () => state.subTypeFilter !== 'all' || state.currentAccount !== 'all';

// Faturas (GET /bills) indexadas por id, para ligar a transação do cartão (creditCardMetadata.billId) à fatura
function billsById() {
  const map = new Map();
  (state.activeData?.cardStatements || []).forEach(cs => (cs.bills || []).forEach(b => { if (b?.id) map.set(b.id, b); }));
  return map;
}

// Período dos dados que estão na tela
const loadedPeriod = () => state.activeData?.period || state.currentFilter;

function inLoadedPeriod(dateValue) {
  const day = dayKey(dateValue);
  const f = loadedPeriod();
  return Boolean(day && f && day >= f.from && day <= f.to);
}

const needsReconnect = (item) => Boolean(item && RECONNECT_STATUSES.includes(item.status));

// Valor com sinal e cor de caixa (vermelho = saída, verde = entrada) e a moeda original quando não é BRL
function amountCellHtml(tx) {
  const out = isOutflow(tx);
  const value = formatMoney(Math.abs(txAmount(tx)), accountCurrency(tx));
  const foreign = tx.currencyCode && tx.currencyCode !== 'BRL'
    ? `<br><span class="muted-note">${escapeHtml(formatMoney(Math.abs(Number(tx.amount) || 0), tx.currencyCode))} (${escapeHtml(tx.currencyCode)})</span>`
    : '';
  const color = out ? 'var(--mister-debit-red)' : 'var(--mister-success-green)';
  return `<td style="color: ${color}; font-weight: 600; white-space: nowrap;">${out ? '- ' : '+ '}${escapeHtml(value)}${foreign}</td>`;
}

// Cabeçalho clicável com aria-sort (só data e valor ordenam)
function sortableTh(table, key, label) {
  const s = state.sort[table];
  const active = s.key === key;
  const ariaSort = active ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = active ? (s.dir === 'asc' ? '▲' : '▼') : '↕';
  const hint = active ? (s.dir === 'asc' ? ' (crescente)' : ' (decrescente)') : '';
  return `<th aria-sort="${ariaSort}"><button type="button" class="th-sort" data-action="sort" data-table="${table}" data-sort-key="${key}" title="Ordenar por ${escapeHtml(label.toLowerCase())}${hint}">${escapeHtml(label)} <span class="th-sort-icon" aria-hidden="true">${arrow}</span></button></th>`;
}

// Linha de tabela vazia, com a mensagem certa para cada situação
function emptyStateRow(colspan, icon, text, { usesFilters = true } = {}) {
  let message = text;
  let action = '';
  if (!state.activeData && state.loading) {
    message = 'Buscando os dados do banco…';
  } else if (!state.connectedItemId) {
    action = '<button type="button" class="btn-table-connect" data-action="connect"><span aria-hidden="true">🔌</span> Conectar banco</button>';
  } else if (!state.activeData) {
    message = 'Os dados ainda não foram carregados. Veja o aviso acima da tabela.';
  } else if (usesFilters && filtersActive()) {
    message = `${text} com os filtros escolhidos.`;
    action = '<button type="button" class="btn-table-connect" data-action="clear-filters">Limpar filtros</button>';
  }
  return `
    <tr>
      <td colspan="${colspan}" class="mister-empty-state-row">
        <div class="empty-table-box">
          <span class="empty-table-icon" aria-hidden="true">${icon}</span>
          <span>${escapeHtml(message)}</span>
          ${action}
        </div>
      </td>
    </tr>
  `;
}

const detailsOpenAttr = (id) => (state.openDetails[id] ? ' open' : '');

// Atualiza contador de lançamentos no badge central do header
function updateHeaderTxCount() {
  const badge = document.getElementById('headerTxCount');
  const extra = document.getElementById('headerTxExtra');
  if (!badge) return;
  if (extra) { extra.hidden = true; extra.textContent = ''; }

  if (!state.activeData) {
    badge.textContent = '0';
    return;
  }

  if (state.currentView === 'extrato') {
    badge.textContent = String(getFilteredTransactions('checking').length);
  } else if (state.currentView === 'cartao') {
    badge.textContent = String(getFilteredTransactions('card').length);
  } else {
    const count = getFilteredTransactions().length;
    badge.textContent = String(count);
    // Registro: cada lançamento gera duas partidas (débito e crédito)
    if (state.currentView === 'registro' && extra) {
      extra.textContent = `· ${count * 2} partidas`;
      extra.hidden = false;
    }
  }
}

// =========================================================
// AVISOS COMUNS (#appNotices): aparecem em todas as telas
// =========================================================
let lastNoticesHtml = null;

function noticeHtml({ type = 'info', icon = 'ℹ️', title = '', text = '', actions = [], details = '' }) {
  const buttons = actions.map(a => `<button type="button" class="btn-mister-action" data-action="${escapeHtml(a.action)}">${escapeHtml(a.label)}</button>`).join('');
  return `
    <div class="app-notice is-${type}">
      <span class="app-notice-icon" aria-hidden="true">${icon}</span>
      <div class="app-notice-body">
        ${title ? `<strong class="app-notice-title">${escapeHtml(title)}</strong> ` : ''}<span>${escapeHtml(text)}</span>
        ${details}
      </div>
      ${buttons ? `<div class="app-notice-actions">${buttons}</div>` : ''}
    </div>`;
}

// Produtos que o banco não atualizou (warnings do servidor; na falta deles, o statusDetail do Item)
function partialWarnings(data) {
  if (Array.isArray(data?.warnings) && data.warnings.length) return data.warnings;
  const item = data?.item;
  if (!item?.statusDetail || typeof item.statusDetail !== 'object') return [];
  return Object.entries(item.statusDetail)
    .filter(([, d]) => d && d.isUpdated === false)
    .map(([product]) => ({ product, message: '' }));
}

function buildNotices() {
  const data = state.activeData;
  const item = data?.item;
  const notices = [];

  if (state.loading) {
    const f = state.loadingFilter || state.currentFilter;
    notices.push({ type: 'info', icon: '⏳', text: `Buscando os dados do banco${f?.label ? ` (${capitalize(f.label)})` : ''}… isso pode levar alguns segundos.` });
  }

  if (state.loadError && !state.loading) {
    notices.push({
      type: 'error', icon: '⚠️', title: 'Não foi possível carregar os dados.',
      text: `${state.loadError.message}${data ? ' Os dados que você vê são da última busca que deu certo.' : ''}`,
      actions: [{ action: 'retry', label: 'Tentar novamente' }]
    });
  }

  if (item) {
    const messages = {
      LOGIN_ERROR: 'O banco não aceitou o acesso salvo. Clique em "Reconectar" e entre de novo no banco para voltar a receber os dados.',
      OUTDATED: 'A última atualização com o banco falhou e os dados podem estar desatualizados. Clique em "Reconectar" para renovar.',
      WAITING_USER_INPUT: 'O banco pediu uma confirmação (por exemplo, um código). Clique em "Reconectar" para concluir.',
      WAITING_USER_ACTION: 'O banco pediu uma ação sua no app ou no site do banco. Depois de fazer, clique em "Reconectar".'
    };
    if (messages[item.status]) {
      notices.push({ type: 'warning', icon: '🔌', title: 'A conexão precisa de atenção.', text: messages[item.status], actions: [{ action: 'reconnect', label: 'Reconectar' }] });
    }
    if (item.executionStatus === 'USER_AUTHORIZATION_PENDING') {
      notices.push({ type: 'info', icon: '📱', text: 'O banco está aguardando sua autorização no app ou no aparelho. Depois de liberar (pode levar uns 30 minutos), clique em "Atualizar".', actions: [{ action: 'refresh', label: 'Atualizar' }] });
    }
    // Validade do consentimento Open Finance
    const expires = item.consentExpiresAt ? new Date(item.consentExpiresAt) : null;
    if (expires && !Number.isNaN(expires.getTime())) {
      const daysLeft = (expires.getTime() - Date.now()) / 86400000;
      if (daysLeft <= 0) {
        notices.push({ type: 'warning', icon: '🔒', text: `A autorização dada no banco venceu em ${formatInstantDate(item.consentExpiresAt)}. Clique em "Reconectar" para renovar.`, actions: [{ action: 'reconnect', label: 'Reconectar' }] });
      } else if (daysLeft <= 7) {
        notices.push({ type: 'info', icon: '🔒', text: `A autorização dada no banco vence em ${formatInstantDate(item.consentExpiresAt)}. Renove para não perder a conexão.`, actions: [{ action: 'reconnect', label: 'Renovar' }] });
      }
    }
  }

  // Dados parciais: o servidor já manda mensagens amigáveis por produto; sem elas, monta a partir do statusDetail
  const warnings = partialWarnings(data);
  if (warnings.length) {
    const messages = [...new Set(warnings.map(w => (typeof w.message === 'string' ? w.message.trim() : '')).filter(Boolean))];
    if (messages.length) {
      notices.push({
        type: 'warning', icon: '⚠️', title: 'Dados possivelmente incompletos.',
        text: messages.length === 1 ? messages[0] : 'Confira os pontos abaixo antes de fechar o mês:',
        details: messages.length > 1 ? `<ul class="app-notice-list">${messages.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>` : ''
      });
    } else {
      const names = [...new Set(warnings.map(w => productLabel(w.product).toLowerCase()).filter(Boolean))];
      notices.push({
        type: 'warning', icon: '⚠️', title: 'Dados possivelmente incompletos.',
        text: `O banco não atualizou tudo nesta sincronização${names.length ? `: ${names.join(', ')}` : ''}. Confira com o extrato do banco antes de fechar o mês.`
      });
    }
  }

  if (data?.syncing || (data && item?.status === 'UPDATING')) {
    notices.push({ type: 'info', icon: '🔄', text: 'O banco ainda está enviando os dados desta conexão. Clique em "Atualizar" daqui a pouco para ver tudo.', actions: [{ action: 'refresh', label: 'Atualizar' }] });
  }

  if (data?.periodFallback) {
    const r = data.fallbackRange;
    const range = r && isIsoDate(dayKey(r.from)) && isIsoDate(dayKey(r.to)) ? ` (de ${formatDate(r.from)} a ${formatDate(r.to)})` : '';
    notices.push({
      type: 'warning', icon: '🧪', title: 'Conta de teste sem lançamentos no período.',
      text: `Para você ver como funciona, estamos mostrando os últimos 90 dias${range} em vez de ${capitalize(data.period?.label || state.currentFilter?.label || 'o período escolhido')}.`,
      actions: [{ action: 'open-period', label: 'Escolher período' }]
    });
  }

  if (data?.truncated) {
    notices.push({ type: 'warning', icon: '✂️', text: 'Este período tem muitos lançamentos e só parte deles foi carregada. Escolha um período menor para ver tudo.', actions: [{ action: 'open-period', label: 'Escolher período' }] });
  }

  return notices;
}

function renderNotices() {
  const el = document.getElementById('appNotices');
  if (!el) return;
  const html = buildNotices().map(noticeHtml).join('');
  // Só reescreve quando muda: evita o leitor de tela repetir o mesmo aviso a cada re-render
  if (html !== lastNoticesHtml) {
    el.innerHTML = html;
    lastNoticesHtml = html;
  }
}

// =========================================================
// VIEW 1: COMPROVANTES (EXATAMENTE FIEL AO PRINT DO USUÁRIO)
// Colunas: Dt Pgto | Cliente/Fornecedor | CPF/CNPJ | Doc | Dt Vcto | Vl Docto | Valor | Juros | Multa | Desconto | Observação
// =========================================================
function renderComprovantesHtml() {
  const txs = sortTransactions(getFilteredTransactions(), 'comprovantes');
  const bills = billsById();

  let rowsHtml = '';
  if (txs.length === 0) {
    rowsHtml = emptyStateRow(11, '🧾', 'Nenhum comprovante encontrado');
  } else {
    rowsHtml = txs.map(tx => {
      const p = tx.paymentData || {};
      const boleto = p.boletoMetadata || {};
      const cp = counterparty(tx);
      const party = cp.name || tx.description || '—';
      const docNumber = cp.doc ? formatDoc(cp.doc) : '—';
      // Doc: só identificadores reais (linha digitável, autenticação, referência ou código do banco)
      const docCode = boleto.digitableLine || p.authenticationCode || p.referenceNumber || tx.providerCode || '—';
      // Dt Vcto: o boletoMetadata da Pluggy não tem vencimento; só a fatura do cartão (billId) tem vencimento real
      const bill = bills.get(tx.creditCardMetadata?.billId);
      const dueDate = bill ? formatDate(bill.dueDate) : '—';
      const money = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : escapeHtml(formatMoney(v)));
      const docValue = boleto.baseAmount != null && Number.isFinite(Number(boleto.baseAmount))
        ? formatMoney(boleto.baseAmount)
        : formatMoney(Math.abs(txAmount(tx)), accountCurrency(tx));

      return `
        <tr>
          <td>${formatDate(tx.date)}</td>
          <td><strong>${escapeHtml(party)}</strong></td>
          <td class="doc-mask">${escapeHtml(docNumber)}</td>
          <td><code style="font-size: 11px;">${escapeHtml(docCode)}</code></td>
          <td>${dueDate}</td>
          <td>${escapeHtml(docValue)}</td>
          ${amountCellHtml(tx)}
          <td>${money(boleto.interestAmount)}</td>
          <td>${money(boleto.penaltyAmount)}</td>
          <td>${money(boleto.discountAmount)}</td>
          <td>${escapeHtml(catLabel(tx) || tx.description || '—')}</td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="mister-table-card">
      <table class="mister-table">
        <caption class="visually-hidden">Comprovantes do período, ${escapeHtml(capitalize(loadedPeriod()?.label || ''))}</caption>
        <thead>
          <tr>
            ${sortableTh('comprovantes', 'date', 'Dt Pgto')}
            <th>Cliente/Fornecedor</th>
            <th>CPF/CNPJ</th>
            <th>Doc</th>
            <th>Dt Vcto</th>
            <th>Vl Docto</th>
            ${sortableTh('comprovantes', 'amount', 'Valor')}
            <th>Juros</th>
            <th>Multa</th>
            <th>Desconto</th>
            <th>Observação</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

// =========================================================
// VIEW 2: REGISTRO CONTÁBIL (PARTIDAS DOBRADAS DÉBITO / CRÉDITO)
// Visão dos livros da empresa:
//   conta bancária — saída: D contrapartida "a definir" / C banco; entrada: D banco / C "a definir"
//   cartão         — compra: D "a definir" / C "Cartão a pagar — <nome>"; pagamento/estorno: D cartão / C "a definir"
// =========================================================
function renderRegistroContabilHtml() {
  const txs = getFilteredTransactions();

  let rowsHtml = '';
  if (txs.length === 0) {
    rowsHtml = emptyStateRow(10, '📑', 'Nenhum registro contábil encontrado');
  } else {
    rowsHtml = txs.map((tx, idx) => {
      const out = isOutflow(tx);
      const card = isCardTx(tx);
      const absAmount = escapeHtml(formatMoney(Math.abs(txAmount(tx)), accountCurrency(tx)));
      const dateStr = formatDate(tx.date);
      const desc = escapeHtml(tx.description || 'Lançamento');
      const p = tx.paymentData || {};
      const docCode = p.boletoMetadata?.digitableLine || p.authenticationCode || p.referenceNumber || '—';
      const cp = counterparty(tx);
      const method = translate(PAYMENT_METHOD_LABELS, paymentMethodOf(tx)) || '—';

      const accLabel = card ? `Cartão a pagar — ${accountName(tx.accountId)}` : accountName(tx.accountId);
      const accClass = card ? 'Cartão a pagar' : 'Bancos';
      const counterClass = catLabel(tx) ? `Sugestão: ${catLabel(tx)}` : 'a definir';
      // Débito: saída de caixa (ou compra no cartão) debita a contrapartida; entrada debita a própria conta
      const debitIsAccount = !out;
      const cashColor = out ? 'var(--mister-debit-red)' : 'var(--mister-success-green)';

      const debitRow = {
        classif: debitIsAccount ? accClass : counterClass,
        conta: debitIsAccount ? accLabel : 'a definir',
        color: debitIsAccount ? cashColor : '#111827'
      };
      const creditRow = {
        classif: debitIsAccount ? counterClass : accClass,
        conta: debitIsAccount ? 'a definir' : accLabel,
        color: debitIsAccount ? '#111827' : cashColor
      };

      return `
        <!-- Linha 1: Débito (Branca) -->
        <tr class="debit-line">
          <td>${dateStr}</td>
          <td>${escapeHtml(debitRow.classif)}</td>
          <td>${escapeHtml(debitRow.conta)}</td>
          <td style="color: ${debitRow.color}; font-weight: 600; white-space: nowrap;">${absAmount}</td>
          <td></td>
          <td>${desc}</td>
          <td><code style="font-size: 11px;">${escapeHtml(docCode)}</code></td>
          <td>—</td>
          <td>${escapeHtml(cp.name || '—')}</td>
          <td>${escapeHtml(method)}</td>
        </tr>
        <!-- Linha 2: Crédito (Amarela #fffde7) -->
        <tr class="credit-line">
          <td></td>
          <td>${escapeHtml(creditRow.classif)}</td>
          <td>${escapeHtml(creditRow.conta)}</td>
          <td></td>
          <td style="color: ${creditRow.color}; font-weight: 600; white-space: nowrap;">${absAmount}</td>
          <td>Contrapartida: ${desc}</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>Partida dobrada #${idx + 1}</td>
        </tr>
      `;
    }).join('');
  }

  return `
    <p class="muted-note">Visão dos livros da empresa: saída de caixa credita a conta bancária e entrada debita. A contrapartida fica “a definir” para você classificar; a sugestão vem da categoria do banco.</p>
    <div class="mister-table-card">
      <table class="mister-table">
        <caption class="visually-hidden">Registro contábil em partidas dobradas</caption>
        <thead>
          <tr>
            <th>Data</th>
            <th>Classificação</th>
            <th>Conta</th>
            <th>Débito</th>
            <th>Crédito</th>
            <th>Histórico</th>
            <th>Comprovante</th>
            <th>NF</th>
            <th>Cliente/Fornecedor</th>
            <th>Informação extra</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

// =========================================================
// VIEW 3: EXTRATO BANCÁRIO
// =========================================================
function renderExtratoHtml() {
  const chkTxs = sortTransactions(getFilteredTransactions('checking'), 'extrato');
  const selected = accountById(state.currentAccount);

  let rowsHtml = '';
  if (chkTxs.length === 0) {
    rowsHtml = isCardAccount(selected)
      ? emptyStateRow(6, '🏦', 'A conta escolhida é um cartão. Veja os lançamentos dele em Cartão de Crédito', { usesFilters: false })
      : emptyStateRow(6, '🏦', 'Nenhum lançamento no extrato bancário encontrado');
  } else {
    rowsHtml = chkTxs.map(tx => {
      const method = translate(PAYMENT_METHOD_LABELS, paymentMethodOf(tx)) || 'Outros';
      const party = counterparty(tx).name || '—';

      return `
        <tr>
          <td>${formatDate(tx.date)}</td>
          <td><strong>${escapeHtml(tx.description || '—')}</strong></td>
          <td><span style="background: #f1f5f9; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${escapeHtml(method)}</span></td>
          ${amountCellHtml(tx)}
          <td>${escapeHtml(catLabel(tx) || 'Geral')}</td>
          <td>${escapeHtml(party)}</td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="mister-table-card">
      <table class="mister-table">
        <caption class="visually-hidden">Extrato bancário do período</caption>
        <thead>
          <tr>
            ${sortableTh('extrato', 'date', 'Data')}
            <th>Descrição da Movimentação</th>
            <th>Método</th>
            ${sortableTh('extrato', 'amount', 'Valor')}
            <th>Categoria</th>
            <th>Favorecido / Pagador</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

// =========================================================
// VIEW 4: CARTÃO DE CRÉDITO (FATURAS + LANÇAMENTOS)
// =========================================================
function cardTxTypeLabel(tx) {
  const meta = tx.creditCardMetadata || {};
  if (tx.operationType && PAYMENT_METHOD_LABELS[tx.operationType]) return PAYMENT_METHOD_LABELS[tx.operationType];
  if (meta.feeType) return 'Tarifa';
  if (meta.otherCreditsType) return 'Crédito contratado no cartão';
  return isOutflow(tx) ? 'Compra' : 'Pagamento ou estorno';
}

function renderBillCard(bill, cardName) {
  const inPeriod = inLoadedPeriod(bill.dueDate);
  const cur = bill.totalAmountCurrencyCode || 'BRL';
  const charges = Array.isArray(bill.financeCharges) ? bill.financeCharges : [];
  const payments = Array.isArray(bill.payments) ? bill.payments : [];
  const chargesTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const paidTotal = payments.reduce((s, pmt) => s + (Number(pmt.amount) || 0), 0);
  const chargeTypes = [...new Set(charges.map(c => translate(BILL_CHARGE_LABELS, c.type)).filter(Boolean))];
  const paidDates = [...new Set(payments.map(pmt => formatDate(pmt.paymentDate)).filter(d => d !== '—'))];
  const meta = [];
  if (bill.billClosingDate) meta.push(`Fechamento: ${formatDate(bill.billClosingDate)}`);
  if (bill.minimumPaymentAmount != null && Number.isFinite(Number(bill.minimumPaymentAmount))) meta.push(`Pagamento mínimo: ${formatMoney(bill.minimumPaymentAmount, cur)}`);
  if (charges.length) meta.push(`Encargos: ${formatMoney(chargesTotal, cur)}${chargeTypes.length ? ` (${chargeTypes.join(', ')})` : ''}`);
  meta.push(payments.length ? `Pago: ${formatMoney(paidTotal, cur)}${paidDates.length ? ` em ${paidDates.join(', ')}` : ''}` : 'Nenhum pagamento registrado pelo banco');

  return `
    <article class="bill-card${inPeriod ? ' is-current' : ''}">
      <header class="bill-card-head">
        <strong>${escapeHtml(cardName)}</strong>
        <span>Vencimento ${formatDate(bill.dueDate)}</span>
        ${inPeriod ? '<span class="bill-card-tag">Vence no período</span>' : ''}
      </header>
      <div class="bill-card-value">${escapeHtml(formatMoney(bill.totalAmount, cur))}</div>
      <ul class="bill-card-meta">${meta.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
    </article>`;
}

function renderBillsSection(cards) {
  if (!cards.length) return '';
  const blocks = cards.map(cs => {
    const name = cs.account?.name || 'Cartão de crédito';
    // Faturas mais recentes primeiro (até 6 por cartão)
    const bills = [...(cs.bills || [])].filter(b => b && b.id).sort((a, b) => String(b.dueDate || '').localeCompare(String(a.dueDate || ''))).slice(0, 6);
    return { name, bills };
  });
  const allBills = blocks.flatMap(b => b.bills.map(bill => renderBillCard(bill, b.name))).join('');
  const body = allBills
    ? `<div class="bill-grid">${allBills}</div>`
    : '<p class="muted-note">A instituição não enviou as faturas fechadas deste cartão. A tabela abaixo mostra as compras e pagamentos do período.</p>';
  return `
    <section class="viz-card bill-section" aria-labelledby="billsTitle">
      <header class="viz-card-head"><h3 id="billsTitle">Faturas</h3><span class="viz-sub">enviadas pelo banco</span></header>
      ${body}
    </section>`;
}

function renderCartaoHtml() {
  const cardTxs = sortTransactions(getFilteredTransactions('card'), 'cartao');
  const cards = (state.activeData?.cardStatements || []).filter(cs => state.currentAccount === 'all' || cs.account?.id === state.currentAccount);
  const selected = accountById(state.currentAccount);

  let rowsHtml = '';
  if (cardTxs.length === 0) {
    rowsHtml = selected && !isCardAccount(selected)
      ? emptyStateRow(6, '💳', 'A conta escolhida não é um cartão. Escolha um cartão ou "Todas as Contas"', { usesFilters: false })
      : emptyStateRow(6, '💳', 'Nenhum lançamento de cartão de crédito encontrado');
  } else {
    rowsHtml = cardTxs.map(tx => {
      const meta = tx.creditCardMetadata || {};
      const n = safeInt(meta.installmentNumber);
      const total = safeInt(meta.totalInstallments);
      const installment = n ? `${n}/${total || '?'}` : 'À vista';
      // Parcela de compra antiga: mostra a data original da compra
      const purchase = dayKey(meta.purchaseDate) && dayKey(meta.purchaseDate) !== dayKey(tx.date)
        ? `<br><span class="muted-note">compra em ${formatDate(meta.purchaseDate)}</span>` : '';

      return `
        <tr>
          <td>${formatDate(tx.date)}</td>
          <td><strong>${escapeHtml(tx.description || '—')}</strong></td>
          <td><span style="background: #e8f0fe; color: #002b80; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${escapeHtml(cardTxTypeLabel(tx))}</span></td>
          <td><span style="background: #e2e8f0; padding: 1px 6px; border-radius: 4px; font-weight: 600; font-size: 10.5px;">${escapeHtml(installment)}</span>${purchase}</td>
          <td>${escapeHtml(catLabel(tx) || 'Geral')}</td>
          ${amountCellHtml(tx)}
        </tr>
      `;
    }).join('');
  }

  return `
    ${renderBillsSection(cards)}
    <div class="mister-table-card">
      <table class="mister-table">
        <caption class="visually-hidden">Lançamentos de cartão de crédito do período</caption>
        <thead>
          <tr>
            ${sortableTh('cartao', 'date', 'Data')}
            <th>Descrição / Estabelecimento</th>
            <th>Tipo do Lançamento</th>
            <th>Parcela</th>
            <th>Categoria</th>
            ${sortableTh('cartao', 'amount', 'Valor')}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

// =========================================================
// VIEW 5: INVESTIMENTOS
// =========================================================
const investmentBalance = (i) => Number(i.balance) || 0;
const isActiveInvestment = (i) => i.status !== 'TOTAL_WITHDRAWAL';
const investmentLabel = (inv) => (inv.subtype ? translate(INVESTMENT_SUBTYPE_LABELS, inv.subtype) : translate(INVESTMENT_TYPE_LABELS, inv.type)) || 'Outros';

function investmentRateText(inv) {
  const parts = [];
  if (inv.rate != null && Number.isFinite(Number(inv.rate))) parts.push(`${formatPct(inv.rate)}% ${inv.rateType || ''}`.trim());
  if (inv.fixedAnnualRate != null && Number.isFinite(Number(inv.fixedAnnualRate))) parts.push(`${parts.length ? '+ ' : ''}${formatPct(inv.fixedAnnualRate)}% a.a.`);
  if (parts.length) return parts.join(' ');
  if (inv.annualRate != null && Number.isFinite(Number(inv.annualRate))) return `${formatPct(inv.annualRate)}% no último ano`;
  return '—';
}

function investmentRowHtml(inv) {
  return `
    <tr>
      <td><strong>${escapeHtml(inv.name || '—')}</strong>${inv.status === 'PENDING' ? '<br><span class="muted-note">em processamento</span>' : ''}</td>
      <td><span style="background: #e8f0fe; color: #002b80; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${escapeHtml(translate(INVESTMENT_TYPE_LABELS, inv.type) || '—')}</span></td>
      <td>${inv.subtype ? escapeHtml(translate(INVESTMENT_SUBTYPE_LABELS, inv.subtype)) : '—'}</td>
      <td style="color: var(--mister-success-green); font-weight: 600; white-space: nowrap;">${escapeHtml(formatMoney(inv.balance, inv.currencyCode))}</td>
      <td>${escapeHtml(investmentRateText(inv))}</td>
      <td>${formatDate(inv.dueDate)}</td>
    </tr>
  `;
}

function renderInvestimentosHtml() {
  const all = state.activeData?.investments || [];
  const active = all.filter(isActiveInvestment);
  const withdrawn = all.filter(i => !isActiveInvestment(i));

  const rowsHtml = active.length
    ? active.map(investmentRowHtml).join('')
    : emptyStateRow(6, '📈', 'Nenhum investimento ativo encontrado', { usesFilters: false });

  const head = `
        <thead>
          <tr>
            <th>Nome do Ativo</th>
            <th>Tipo</th>
            <th>Subtipo</th>
            <th>Saldo / Valor</th>
            <th>Rentabilidade</th>
            <th>Vencimento</th>
          </tr>
        </thead>`;

  return `
    <div class="mister-table-card">
      <table class="mister-table">
        <caption class="visually-hidden">Investimentos ativos</caption>
        ${head}
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
    ${withdrawn.length ? `
    <details class="viz-table-view" data-details-id="inv-withdrawn"${detailsOpenAttr('inv-withdrawn')}>
      <summary>Aplicações resgatadas (${withdrawn.length})</summary>
      <table class="mister-table">
        <caption class="visually-hidden">Aplicações totalmente resgatadas</caption>
        ${head}
        <tbody>${withdrawn.map(investmentRowHtml).join('')}</tbody>
      </table>
    </details>` : ''}
  `;
}

// =========================================================
// VIEW 6: EMPRÉSTIMOS
// =========================================================
// Empréstimos: o schema real traz saldo em payments.contractOutstandingBalance, parcelas em installments
// e taxas em interestRates[] (1 = 100%).
function normalizeLoan(l) {
  const inst = l.installments || {};
  const rate = (l.interestRates || []).find(r => r.preFixedRate != null || r.postFixedRate != null) || {};
  const ratePct = rate.preFixedRate != null ? rate.preFixedRate * 100 : (rate.postFixedRate != null ? rate.postFixedRate * 100 : null);
  const periodicity = String(rate.taxPeriodicity || '').toUpperCase();
  return {
    id: l.id,
    contract: l.contractNumber || l.ipocCode || l.id,
    name: l.productName || '—',
    typeLabel: translate(LOAN_TYPE_LABELS, l.type) || translate(LOAN_KIND_LABELS, l.kind) || '—',
    currency: l.currencyCode || 'BRL',
    contractAmount: l.contractAmount ?? null,
    outstanding: l.payments?.contractOutstandingBalance ?? null,
    ratePct: Number.isFinite(ratePct) ? ratePct : null,
    ratePeriod: ['MONTHLY', 'AM'].includes(periodicity) ? 'a.m.' : (['YEARLY', 'AA'].includes(periodicity) ? 'a.a.' : ''),
    cet: l.CET != null && Number.isFinite(Number(l.CET)) ? l.CET * 100 : null,
    totalInstallments: safeInt(inst.totalNumberOfInstallments),
    paidInstallments: safeInt(inst.paidInstallments),
    dueInstallments: safeInt(inst.dueInstallments),
    dueDate: l.dueDate || null
  };
}

function renderEmprestimosHtml() {
  const loans = state.activeData?.loans || [];

  let rowsHtml = '';
  if (loans.length === 0) {
    rowsHtml = emptyStateRow(7, '🤝', 'Nenhum empréstimo ou financiamento encontrado', { usesFilters: false });
  } else {
    rowsHtml = loans.map(raw => {
      const loan = normalizeLoan(raw);
      const money = (v) => (v === null || !Number.isFinite(Number(v)) ? '—' : escapeHtml(formatMoney(v, loan.currency)));
      const rateText = loan.ratePct !== null ? `${formatPct(loan.ratePct)}% ${loan.ratePeriod}` : (loan.cet !== null ? `CET ${formatPct(loan.cet)}% a.a.` : '—');
      const parcels = loan.totalInstallments !== null
        ? `${loan.paidInstallments ?? '?'} pagas de ${loan.totalInstallments}${loan.dueInstallments !== null ? ` · ${loan.dueInstallments} a vencer` : ''}`
        : '—';
      return `
        <tr>
          <td><strong>${escapeHtml(String(loan.contract).slice(0, 24))}</strong><br><span style="color: var(--mister-text-muted); font-size: 11px;">${escapeHtml(loan.name)}</span></td>
          <td><span style="background: #fef08a; color: #854d0e; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${escapeHtml(loan.typeLabel)}</span></td>
          <td>${money(loan.contractAmount)}</td>
          <td style="color: var(--mister-debit-red); font-weight: 600;">${money(loan.outstanding)}</td>
          <td>${escapeHtml(rateText.trim())}</td>
          <td>${escapeHtml(parcels)}</td>
          <td>${formatDate(loan.dueDate)}</td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="mister-table-card">
      <table class="mister-table">
        <caption class="visually-hidden">Empréstimos e financiamentos</caption>
        <thead>
          <tr>
            <th>Contrato</th>
            <th>Tipo</th>
            <th>Valor Contratado</th>
            <th>Saldo Devedor</th>
            <th>Taxa de Juros</th>
            <th>Parcelas</th>
            <th>Vencimento</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

// =========================================================
// VIEW 7: ESTATÍSTICAS (DASHBOARD ANALÍTICO + DETALHES TÉCNICOS)
// =========================================================
function formatCompactMoney(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
}

// Barra horizontal (ranking / composição) — um único matiz, ordenada por valor; focável com rótulo para leitor de tela
function renderHBars(items, { color = 'blue' } = {}) {
  if (!items.length) return '<div class="viz-empty">Sem dados no período.</div>';
  const max = Math.max(...items.map(i => i.value), 1);
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return `
    <ul class="viz-hbars">
      ${items.map(i => {
        const tip = `${i.label}: ${formatMoney(i.value)} (${(i.value / total * 100).toFixed(1).replace('.', ',')}%)`;
        return `
        <li class="viz-bar-focus" tabindex="0" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
          <span class="viz-hbar-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span>
          <span class="viz-hbar-track"><span class="viz-hbar-fill viz-${color}" style="width:${Math.max(i.value / max * 100, 1.5)}%"></span></span>
          <span class="viz-hbar-value">${escapeHtml(formatMoney(i.value))}</span>
        </li>`;
      }).join('')}
    </ul>`;
}

function topWithOthers(map, limit = 7) {
  const sorted = [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit).reduce((s, i) => s + i.value, 0);
  return [...sorted.slice(0, limit), { label: 'Outras categorias', value: rest }];
}

// Barra com 4px de arredondamento apenas na ponta do dado (ancorada na linha de zero)
function barPath(x, y0, w, h, up) {
  const r = Math.min(4, h, w / 2);
  const d = up ? -1 : 1;
  const yEnd = y0 + d * h;
  return `M${x},${y0} V${yEnd - d * r} Q${x},${yEnd} ${x + r},${yEnd} H${x + w - r} Q${x + w},${yEnd} ${x + w},${yEnd - d * r} V${y0} Z`;
}

// Entradas x saídas por dia — barras divergentes a partir da linha de zero
function renderDailyFlowChart(days, accountLabel) {
  if (!days.length) return '<div class="viz-empty">Sem movimentações de conta bancária no período.</div>';
  const W = 720, H = 240, L = 58, R = 12, T = 14, B = 28;
  const plotW = W - L - R, plotH = H - T - B;
  const maxIn = Math.max(...days.map(d => d.inflow), 0);
  const maxOut = Math.max(...days.map(d => d.outflow), 0);
  const span = (maxIn + maxOut) || 1;
  const base = T + plotH * (maxIn / span);
  const scale = plotH / span;
  const slot = plotW / days.length;
  const bw = Math.max(4, Math.min(20, slot * 0.6));

  const bars = days.map((d, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    const tip = `${formatDate(d.date)} · Entradas ${formatMoney(d.inflow)} · Saídas ${formatMoney(d.outflow)}`;
    const up = d.inflow > 0 ? `<path d="${barPath(x, base - 1, bw, d.inflow * scale, true)}" class="viz-fill-in"/>` : '';
    const down = d.outflow > 0 ? `<path d="${barPath(x, base + 1, bw, d.outflow * scale, false)}" class="viz-fill-out"/>` : '';
    return `<g class="viz-bar-focus" tabindex="0" role="img" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}">${up}${down}<rect x="${L + slot * i}" y="${T}" width="${slot}" height="${plotH}" class="viz-hit"/></g>`;
  }).join('');

  const xIdx = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  const xLabels = xIdx.map(i => {
    const anchor = i === 0 ? 'start' : (i === days.length - 1 ? 'end' : 'middle');
    const x = anchor === 'start' ? L : (anchor === 'end' ? W - R : L + slot * i + slot / 2);
    return `<text x="${x}" y="${H - 8}" text-anchor="${anchor}" class="viz-axis-text" aria-hidden="true">${shortDate(days[i].date)}</text>`;
  }).join('');

  const yTop = maxIn > 0 ? `<line x1="${L}" x2="${W - R}" y1="${T}" y2="${T}" class="viz-grid"/><text x="${L - 8}" y="${T + 4}" text-anchor="end" class="viz-axis-text" aria-hidden="true">${escapeHtml(formatCompactMoney(maxIn))}</text>` : '';
  const yBot = maxOut > 0 ? `<line x1="${L}" x2="${W - R}" y1="${T + plotH}" y2="${T + plotH}" class="viz-grid"/><text x="${L - 8}" y="${T + plotH + 4}" text-anchor="end" class="viz-axis-text" aria-hidden="true">-${escapeHtml(formatCompactMoney(maxOut))}</text>` : '';

  return `
    <svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="group" aria-label="Entradas e saídas por dia — ${escapeHtml(accountLabel)}">
      ${yTop}${yBot}
      <line x1="${L}" x2="${W - R}" y1="${base}" y2="${base}" class="viz-baseline"/>
      <text x="${L - 8}" y="${base + 4}" text-anchor="end" class="viz-axis-text" aria-hidden="true">0</text>
      ${bars}${xLabels}
    </svg>`;
}

// Evolução do saldo (último saldo informado em cada dia) de UMA conta
function renderBalanceChart(points, accountLabel) {
  if (points.length < 2) return '<div class="viz-empty">Saldo por lançamento indisponível neste período.</div>';
  const W = 440, H = 200, L = 58, R = 16, T = 14, B = 28;
  const plotW = W - L - R, plotH = H - T - B;
  const vals = points.map(p => p.balance);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => L + (plotW * i) / (points.length - 1);
  const y = (v) => T + plotH - ((v - min) / (max - min)) * plotH;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${T + plotH} L${L},${T + plotH} Z`;
  const last = points[points.length - 1];
  const step = Math.max(1, Math.ceil(points.length / 40));
  const hits = points.map((p, i) => {
    if (!(i % step === 0 || i === points.length - 1)) return '';
    const tip = `${formatDate(p.date)} · Saldo ${formatMoney(p.balance)}`;
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.balance).toFixed(1)}" r="10" class="viz-hit viz-bar-focus" tabindex="0" role="img" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}"/>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="group" aria-label="Evolução do saldo — ${escapeHtml(accountLabel)}">
      <line x1="${L}" x2="${W - R}" y1="${T}" y2="${T}" class="viz-grid"/>
      <line x1="${L}" x2="${W - R}" y1="${T + plotH}" y2="${T + plotH}" class="viz-grid"/>
      <text x="${L - 8}" y="${T + 4}" text-anchor="end" class="viz-axis-text" aria-hidden="true">${escapeHtml(formatCompactMoney(max))}</text>
      <text x="${L - 8}" y="${T + plotH + 4}" text-anchor="end" class="viz-axis-text" aria-hidden="true">${escapeHtml(formatCompactMoney(min))}</text>
      <path d="${area}" class="viz-area"/>
      <path d="${line}" class="viz-line"/>
      <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.balance).toFixed(1)}" r="4" class="viz-dot"/>
      <text x="${L}" y="${H - 8}" class="viz-axis-text" aria-hidden="true">${shortDate(points[0].date)}</text>
      <text x="${W - R}" y="${H - 8}" text-anchor="end" class="viz-axis-text" aria-hidden="true">${shortDate(last.date)}</text>
      ${hits}
    </svg>`;
}

// Uso do limite dos cartões (medidor). Limite disponível ausente = uso não informado (nunca "100% usado")
function renderLimitMeters(cardStatements) {
  const cards = cardStatements.filter(cs => Number(cs.account?.creditData?.creditLimit) > 0);
  if (!cards.length) return '<div class="viz-empty">Limite de crédito não informado pela instituição.</div>';
  return cards.map(cs => {
    const cd = cs.account.creditData;
    const name = cs.account.name || 'Cartão de crédito';
    const cur = cs.account.currencyCode || 'BRL';
    const limit = Number(cd.creditLimit) || 0;
    const hasAvailable = cd.availableCreditLimit !== null && cd.availableCreditLimit !== undefined && Number.isFinite(Number(cd.availableCreditLimit));
    if (!hasAvailable) {
      const tip = `${name}: limite de ${formatMoney(limit, cur)}; uso não informado pela instituição`;
      return `
      <div class="viz-meter viz-bar-focus" tabindex="0" role="img" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
        <div class="viz-meter-head">
          <strong>${escapeHtml(name)}</strong>
          <span>uso não informado</span>
        </div>
        <div class="viz-hbar-track"><span class="viz-hbar-fill viz-blue" style="width:0%"></span></div>
        <div class="viz-meter-foot"><span>Limite ${escapeHtml(formatMoney(limit, cur))}</span><span>Disponível não informado</span></div>
      </div>`;
    }
    const available = Number(cd.availableCreditLimit);
    const used = Math.max(limit - available, 0);
    const pct = limit ? Math.min(used / limit * 100, 100) : 0;
    const tip = `${name}: ${formatMoney(used, cur)} usados de ${formatMoney(limit, cur)} (${pct.toFixed(0)}%)`;
    return `
      <div class="viz-meter viz-bar-focus" tabindex="0" role="img" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
        <div class="viz-meter-head">
          <strong>${escapeHtml(name)}</strong>
          <span>${pct.toFixed(0)}% usado</span>
        </div>
        <div class="viz-hbar-track"><span class="viz-hbar-fill viz-blue" style="width:${pct}%"></span></div>
        <div class="viz-meter-foot"><span>Usado ${escapeHtml(formatMoney(used, cur))}</span><span>Disponível ${escapeHtml(formatMoney(available, cur))}</span></div>
      </div>`;
  }).join('');
}

// Tabelas alternativas (acessibilidade) dos gráficos
function renderDailyTable(days) {
  if (!days.length) return '';
  return `
    <details class="viz-table-view" data-details-id="daily-table"${detailsOpenAttr('daily-table')}>
      <summary>Ver dados do gráfico</summary>
      <table class="mister-table">
        <thead><tr><th>Data</th><th>Entradas</th><th>Saídas</th></tr></thead>
        <tbody>${days.map(d => `<tr><td>${formatDate(d.date)}</td><td>${escapeHtml(formatMoney(d.inflow))}</td><td>${escapeHtml(formatMoney(d.outflow))}</td></tr>`).join('')}</tbody>
      </table>
    </details>`;
}

function renderBalanceTable(points) {
  if (points.length < 2) return '';
  return `
    <details class="viz-table-view" data-details-id="balance-table"${detailsOpenAttr('balance-table')}>
      <summary>Ver dados do gráfico</summary>
      <table class="mister-table">
        <thead><tr><th>Data</th><th>Saldo no fim do dia</th></tr></thead>
        <tbody>${points.map(p => `<tr><td>${formatDate(p.date)}</td><td>${escapeHtml(formatMoney(p.balance))}</td></tr>`).join('')}</tbody>
      </table>
    </details>`;
}

// O dashboard respeita o filtro de conta (investimentos e empréstimos não dependem de conta)
function dashboardScope(data) {
  const acc = state.currentAccount;
  return {
    accounts: (data?.accounts || []).filter(a => acc === 'all' || a.id === acc),
    chk: (data?.checkingTransactions || []).filter(tx => acc === 'all' || tx.accountId === acc),
    cards: (data?.cardStatements || []).filter(cs => acc === 'all' || cs.account?.id === acc)
  };
}

// Conta usada na evolução do saldo: a selecionada (se for bancária) ou a primeira corrente/bancária
function pickBalanceAccount(data) {
  const banks = (data?.accounts || []).filter(a => a.type === 'BANK');
  if (state.currentAccount !== 'all') return banks.find(a => a.id === state.currentAccount) || null;
  return banks.find(a => a.subtype === 'CHECKING_ACCOUNT') || banks[0] || null;
}

function computeDashboardMetrics(data) {
  const { accounts, chk, cards } = dashboardScope(data);
  const cardTxs = cards.flatMap(cs => cs.transactions || []);

  const dayMap = new Map();
  let inflow = 0, outflow = 0;
  chk.forEach(tx => {
    const day = dayKey(tx.date);
    if (!day) return;
    const abs = Math.abs(txAmount(tx));
    const row = dayMap.get(day) || { date: day, inflow: 0, outflow: 0 };
    if (isOutflow(tx)) { row.outflow += abs; outflow += abs; } else { row.inflow += abs; inflow += abs; }
    dayMap.set(day, row);
  });
  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Gastos por categoria: saídas da conta + compras do cartão, sem pagamento de fatura (evita contar duas vezes)
  const catMap = new Map();
  [...chk, ...cardTxs].forEach(tx => {
    if (!isOutflow(tx) || isBillPayment(tx)) return;
    const cat = catLabel(tx) || 'Sem categoria';
    catMap.set(cat, (catMap.get(cat) || 0) + Math.abs(txAmount(tx)));
  });

  let cardSpend = 0, cardPurchases = 0;
  cardTxs.forEach(tx => {
    if (isOutflow(tx) && !isBillPayment(tx)) { cardSpend += Math.abs(txAmount(tx)); cardPurchases += 1; }
  });

  // Faturas com vencimento dentro do período carregado
  const periodBills = cards.flatMap(cs => (cs.bills || []).filter(b => b && inLoadedPeriod(b.dueDate)));
  const periodBillsTotal = periodBills.reduce((s, b) => s + (Number(b.totalAmount) || 0), 0);

  // Último saldo informado por dia, de uma única conta bancária
  const balanceAccount = pickBalanceAccount(data);
  const balByDay = new Map();
  if (balanceAccount) {
    (data?.checkingTransactions || [])
      .filter(tx => tx.accountId === balanceAccount.id && tx.balance !== null && tx.balance !== undefined && Number.isFinite(Number(tx.balance)))
      .sort(compareByDate)
      .forEach(tx => { const day = dayKey(tx.date); if (day) balByDay.set(day, Number(tx.balance)); });
  }
  const balancePoints = [...balByDay.entries()].map(([date, balance]) => ({ date, balance }));

  const invMap = new Map();
  (data?.investments || []).forEach(inv => {
    if (!isActiveInvestment(inv)) return;
    const key = investmentLabel(inv);
    invMap.set(key, (invMap.get(key) || 0) + investmentBalance(inv));
  });

  const loanMap = new Map();
  (data?.loans || []).map(normalizeLoan).forEach((l, i) => {
    loanMap.set(String(l.contract || `Contrato ${i + 1}`), Number(l.outstanding) || 0);
  });

  return { accounts, chk, cards, cardTxs, days, inflow, outflow, cardSpend, cardPurchases, periodBills, periodBillsTotal, catMap, balanceAccount, balancePoints, invMap, loanMap };
}

function renderEstatisticasDashboardHtml() {
  const data = state.activeData;
  const m = computeDashboardMetrics(data);
  const selected = accountById(state.currentAccount);

  // Limite disponível: soma só dos cartões que informam; avisa quando é parcial
  const limitCards = m.cards.filter(cs => Number(cs.account?.creditData?.creditLimit) > 0 || cs.account?.creditData?.availableCreditLimit != null);
  const knownLimit = limitCards.filter(cs => cs.account?.creditData?.availableCreditLimit != null && Number.isFinite(Number(cs.account.creditData.availableCreditLimit)));
  const availableCreditLimit = knownLimit.reduce((s, cs) => s + Number(cs.account.creditData.availableCreditLimit), 0);
  const limitText = knownLimit.length
    ? `Limite disp: ${formatMoney(availableCreditLimit)}${knownLimit.length < limitCards.length ? ' (parcial)' : ''}`
    : 'Limite disponível não informado';

  const investments = (data?.investments || []).filter(isActiveInvestment);
  const investTotal = investments.reduce((sum, i) => sum + investmentBalance(i), 0);
  const loans = data?.loans || [];
  const loanDebt = loans.map(normalizeLoan).reduce((sum, l) => sum + (Number(l.outstanding) || 0), 0);
  const bankAccounts = m.accounts.filter(a => a.type === 'BANK');
  const bankBalance = bankAccounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  const balanceTitle = bankAccounts.length === 1 ? `Saldo — ${bankAccounts[0].name || 'conta'}` : 'Saldo em contas bancárias';
  const connectorName = data?.item?.connector?.name || 'Instituição conectada';
  const net = m.inflow - m.outflow;
  const scopeLabel = selected ? (selected.name || 'conta selecionada') : 'todas as contas';
  const balanceLabel = m.balanceAccount ? (m.balanceAccount.name || 'conta bancária') : 'nenhuma conta bancária';

  // KPI honesto do cartão: fatura real (bills) quando vence no período; senão, gastos por data da compra
  const cardKpi = m.periodBills.length
    ? { title: 'Fatura do período', value: formatMoney(m.periodBillsTotal), footL: `${m.periodBills.length} fatura(s) com vencimento no período` }
    : { title: 'Gastos no cartão no período', value: formatMoney(m.cardSpend), footL: `${m.cardPurchases} compra(s), sem pagamentos de fatura` };

  // JSON a exibir no inspector (detalhes técnicos)
  let displayJson = data;
  if (data) {
    if (state.jsonSubTab === 'card') displayJson = data.cardStatements || [];
    else if (state.jsonSubTab === 'investments') displayJson = data.investments || [];
    else if (state.jsonSubTab === 'loans') displayJson = data.loans || [];
    else if (state.jsonSubTab === 'checking') displayJson = data.checkingTransactions || [];
    else if (state.jsonSubTab === 'item') displayJson = { item: data.item || {}, identity: data.identity || null };
  } else {
    displayJson = {
      status: 'AGUARDANDO_CONEXAO',
      mensagem: 'Conecte sua conta via Pluggy Connect Widget para inspecionar os dados reais da API.'
    };
  }
  const jsonString = JSON.stringify(displayJson, null, 2);

  const kpi = (title, icon, value, footL, footR, color = '') => `
    <div class="stats-kpi-card">
      <div class="stats-kpi-title-row"><span>${escapeHtml(title)}</span><span aria-hidden="true">${icon}</span></div>
      <div class="stats-kpi-value" ${color ? `style="color: ${color};"` : ''}>${escapeHtml(value)}</div>
      <div class="stats-kpi-footer"><span>${escapeHtml(footL)}</span><span>${escapeHtml(footR)}</span></div>
    </div>`;

  const period = capitalize(loadedPeriod()?.label || '');
  const updatedAt = data?.timestamp ? new Date(data.timestamp) : null;
  const updatedText = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  const subtab = (id, label) => `<button type="button" class="json-subtab-btn ${state.jsonSubTab === id ? 'active' : ''}" data-action="json-subtab" data-subtab="${id}" aria-pressed="${state.jsonSubTab === id}">${label}</button>`;

  return `
    <div class="stats-dashboard-view">
      <div class="stats-sync-banner">
        <div>
          <strong>Situação dos dados:</strong>
          <span>${data
            ? `<span aria-hidden="true">🟢</span> ${escapeHtml(connectorName)} · período ${escapeHtml(period)} · ${escapeHtml(scopeLabel)}${updatedText ? ` · carregado às ${escapeHtml(updatedText)}` : ''}${data.item?.lastUpdatedAt ? ` · banco sincronizado em ${escapeHtml(formatDateTime(data.item.lastUpdatedAt))}` : ''}`
            : '<span aria-hidden="true">⚪</span> Aguardando a conexão com o banco'}</span>
        </div>
        <button type="button" class="btn-mister-action" data-action="${data || state.connectedItemId ? 'refresh' : 'connect'}">
          <span>${data || state.connectedItemId ? 'Atualizar dados' : 'Conectar banco'}</span>
          <span aria-hidden="true">${data || state.connectedItemId ? '🔄' : '🔌'}</span>
        </button>
      </div>

      <div class="stats-kpi-grid">
        ${kpi(balanceTitle, '🏦', formatMoney(bankBalance), `${m.chk.length} movimentações`, `${bankAccounts.length} conta(s) bancária(s)`)}
        ${kpi('Entradas no período', '⬆️', formatMoney(m.inflow), 'Resultado do período', `${net >= 0 ? '+' : '-'} ${formatMoney(Math.abs(net))}`, 'var(--mister-blue-btn)')}
        ${kpi('Saídas no período', '⬇️', formatMoney(m.outflow), 'Contas bancárias', `${m.days.length} dia(s) com movimento`, 'var(--mister-debit-red)')}
        ${kpi(cardKpi.title, '💳', cardKpi.value, cardKpi.footL, limitText)}
        ${kpi('Patrimônio em Investimentos', '📈', formatMoney(investTotal), `${investments.length} aplicação(ões)`, `${m.invMap.size} tipo(s) · todas as contas`, 'var(--mister-success-green)')}
        ${kpi('Saldo Devedor Empréstimos', '📑', formatMoney(loanDebt), `${loans.length} contrato(s)`, 'todas as contas', 'var(--mister-debit-red)')}
      </div>

      <div class="viz-grid-2">
        <section class="viz-card viz-span-2">
          <header class="viz-card-head">
            <h3>Entradas e saídas por dia</h3>
            <div class="viz-legend">
              <span><i class="viz-swatch viz-blue" aria-hidden="true"></i>Entradas</span>
              <span><i class="viz-swatch viz-red" aria-hidden="true"></i>Saídas</span>
            </div>
          </header>
          ${renderDailyFlowChart(m.days, scopeLabel)}
          ${renderDailyTable(m.days)}
        </section>

        <section class="viz-card">
          <header class="viz-card-head"><h3>Gastos por categoria</h3><span class="viz-sub">conta + cartão, sem pagamento de fatura</span></header>
          ${renderHBars(topWithOthers(m.catMap))}
        </section>

        <section class="viz-card">
          <header class="viz-card-head"><h3>Evolução do saldo</h3><span class="viz-sub">${escapeHtml(balanceLabel)}</span></header>
          ${m.balanceAccount ? renderBalanceChart(m.balancePoints, balanceLabel) : '<div class="viz-empty">Escolha uma conta bancária (não cartão) para ver a evolução do saldo.</div>'}
          ${renderBalanceTable(m.balancePoints)}
        </section>

        <section class="viz-card">
          <header class="viz-card-head"><h3>Uso do limite do cartão</h3></header>
          ${renderLimitMeters(m.cards)}
        </section>

        <section class="viz-card">
          <header class="viz-card-head"><h3>Investimentos por tipo</h3></header>
          ${renderHBars(topWithOthers(m.invMap, 6))}
        </section>

        ${loans.length ? `
        <section class="viz-card">
          <header class="viz-card-head"><h3>Saldo devedor por contrato</h3></header>
          ${renderHBars(topWithOthers(m.loanMap, 6), { color: 'red' })}
        </section>` : ''}
      </div>

      <details class="tech-details" data-details-id="stats-json"${detailsOpenAttr('stats-json')}>
        <summary>Detalhes técnicos (suporte)</summary>
        <div class="json-inspector-box">
          <div class="json-inspector-header">
            <div class="json-subtabs" role="group" aria-label="Escolher dados técnicos">
              ${subtab('all', 'Todos os dados')}
              ${subtab('card', 'Cartão')}
              ${subtab('investments', 'Investimentos')}
              ${subtab('loans', 'Empréstimos')}
              ${subtab('checking', 'Extrato')}
              ${subtab('item', 'Conexão &amp; Empresa')}
            </div>
            <button type="button" class="btn-copy-code" data-action="copy-json"><span aria-hidden="true">📋</span> Copiar dados técnicos (JSON)</button>
          </div>
          <pre class="json-pre-code" id="jsonPreBlock" tabindex="0" aria-label="Dados técnicos em JSON"><code>${escapeHtml(jsonString)}</code></pre>
        </div>
      </details>
    </div>
  `;
}

// Tooltip compartilhado para todos os gráficos ([data-tip]): mouse e também foco por teclado
function setupVizTooltips() {
  let tip = document.getElementById('vizTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'vizTip';
    tip.className = 'viz-tip';
    tip.setAttribute('aria-hidden', 'true'); // o conteúdo já está no aria-label do elemento focado
    document.body.appendChild(tip);
  }
  const container = document.getElementById('viewContainer');
  if (!container || container.dataset.tipBound) return; // container é persistente: registra os listeners uma única vez
  container.dataset.tipBound = '1';
  const place = (left, top) => {
    tip.style.left = `${Math.max(8, Math.min(left, window.innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.min(top, window.innerHeight - tip.offsetHeight - 8)}px`;
  };
  container.addEventListener('mousemove', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) { tip.style.display = 'none'; return; }
    tip.textContent = target.dataset.tip;
    tip.style.display = 'block';
    place(e.clientX + 14, e.clientY + 16);
  });
  container.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  container.addEventListener('focusin', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (!target) { tip.style.display = 'none'; return; }
    const rect = target.getBoundingClientRect();
    tip.textContent = target.dataset.tip;
    tip.style.display = 'block';
    place(rect.left + rect.width / 2 - tip.offsetWidth / 2, rect.bottom + 8);
  });
  container.addEventListener('focusout', () => { tip.style.display = 'none'; });
}

function copyJson() {
  const code = document.getElementById('jsonPreBlock')?.innerText;
  if (!code) return;
  if (!navigator.clipboard?.writeText) {
    notify('Não foi possível copiar automaticamente. Selecione o texto e copie com Ctrl+C.', 'error');
    return;
  }
  navigator.clipboard.writeText(code)
    .then(() => notify('Dados técnicos copiados para a área de transferência.', 'success'))
    .catch(() => notify('Não foi possível copiar automaticamente. Selecione o texto e copie com Ctrl+C.', 'error'));
}

// =========================================================
// VIEW 8: EMPRESA
// =========================================================
// PF (CPF) x PJ (CNPJ): taxNumber é o CNPJ da conta empresarial; document é o documento do titular
function holderInfo(identity) {
  if (!identity) return null;
  const docDigits = String(identity.document || '').replace(/\D/g, '');
  const isPJ = Boolean(identity.taxNumber) || identity.documentType === 'CNPJ' || docDigits.length === 14;
  const rawDoc = isPJ ? (identity.taxNumber || identity.document) : identity.document;
  return {
    isPJ,
    name: isPJ ? (identity.companyName || identity.fullName || '') : (identity.fullName || identity.companyName || ''),
    doc: formatDoc(rawDoc),
    nameLabel: isPJ ? 'Razão Social' : 'Nome',
    docLabel: isPJ ? 'CNPJ' : 'CPF',
    topLabel: isPJ ? 'Empresa:' : 'Titular:'
  };
}

function statusBadgeHtml(item) {
  if (!item?.status) {
    const text = state.connectedItemId ? (state.loading ? 'Verificando…' : 'Não verificada agora') : 'Sem conexão';
    return `<span style="background: #f1f5f9; color: #475569; padding: 2px 8px; border-radius: 10px; font-weight: 600;">${text}</span>`;
  }
  const ok = item.status === 'UPDATED';
  const style = ok ? 'background: #dcfce7; color: #15803d;' : 'background: #fef3c7; color: #b45309;';
  return `<span style="${style} padding: 2px 8px; border-radius: 10px; font-weight: 600;">${escapeHtml(translate(ITEM_STATUS_LABELS, item.status))}</span>`;
}

function renderEmpresaHtml() {
  const item = state.activeData?.item || null;
  const connector = item?.connector || {};
  const identity = state.activeData?.identity || null;
  const holder = holderInfo(identity);
  const dash = '<span style="color: var(--mister-text-muted);">Não informado pela instituição</span>';
  const val = (v) => (v ? escapeHtml(v) : dash);
  const address = identity?.addresses?.[0]?.fullAddress;
  const email = identity?.emails?.[0]?.value;
  const phone = identity?.phoneNumbers?.[0]?.value;

  const card = (title, body) => `
    <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: var(--mister-radius-md); padding: 22px;">
      <h3 style="color: #002b80; font-size: 15px; margin-bottom: 14px; border-bottom: 1px solid var(--mister-border-subtle); padding-bottom: 8px;">${title}</h3>
      ${body}
    </div>`;
  const row = (label, value) => `<p style="margin-bottom: 8px;"><strong>${escapeHtml(label)}:</strong> ${value}</p>`;

  let companyBody;
  if (holder) {
    companyBody =
      row(holder.nameLabel, val(holder.name)) +
      row(holder.docLabel, holder.doc ? `<span class="doc-mask">${escapeHtml(holder.doc)}</span>` : dash) +
      row('Endereço', val(address)) +
      row('E-mail', val(email)) +
      row('Telefone', val(phone));
  } else if (!state.connectedItemId) {
    companyBody = '<p style="color: var(--mister-text-muted);">Conecte uma conta para ver os dados cadastrais da empresa (ou do titular).</p>';
  } else if (!state.activeData) {
    companyBody = `<p style="color: var(--mister-text-muted);">${state.loading ? 'Buscando os dados do banco…' : 'Os dados ainda não foram carregados.'}</p>`;
  } else {
    companyBody = '<p style="color: var(--mister-text-muted);">A instituição não enviou os dados cadastrais desta conta.</p>';
  }

  const actions = state.connectedItemId
    ? `<div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px;">
        <button type="button" class="btn-mister-filter" data-action="refresh">Atualizar dados</button>
        ${needsReconnect(item) ? '<button type="button" class="btn-mister-filter" data-action="reconnect">Reconectar</button>' : ''}
        <button type="button" class="btn-cancel" data-action="view" data-view="permissoes">Gerenciar permissões</button>
      </div>`
    : '<button type="button" class="btn-mister-filter" style="margin-top: 10px;" data-action="connect">Conectar banco</button>';

  const connBody =
    row('Instituição', val(connector.name)) +
    row('Situação da conexão', statusBadgeHtml(item)) +
    row('Última sincronização com o banco', item?.lastUpdatedAt ? escapeHtml(formatDateTime(item.lastUpdatedAt)) : '—') +
    (item?.nextAutoSyncAt ? row('Próxima atualização automática', escapeHtml(formatDateTime(item.nextAutoSyncAt))) : '') +
    (item?.consentExpiresAt ? row('Autorização válida até', escapeHtml(formatInstantDate(item.consentExpiresAt))) : '') +
    actions +
    `<details class="tech-details" data-details-id="empresa-tech"${detailsOpenAttr('empresa-tech')}>
      <summary>Detalhes técnicos (suporte)</summary>
      ${row('Código da conexão (Item ID)', `<code>${escapeHtml(item?.id || state.connectedItemId || 'nenhum')}</code>`)}
      ${row('Status / execução', `<code>${escapeHtml(item?.status || '—')} / ${escapeHtml(item?.executionStatus || '—')}</code>`)}
      ${row('Conector', `<code>${escapeHtml(connector.id ?? '—')}</code>${connector.isSandbox ? ' (teste)' : ''}`)}
    </details>`;

  return `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px;">
      ${card(`<span aria-hidden="true">🏢</span> ${holder && !holder.isPJ ? 'Identificação do Titular' : 'Identificação da Empresa Conectada'}`, companyBody)}
      ${card('<span aria-hidden="true">🔌</span> Conexão Bancária Open Finance', connBody)}
    </div>
  `;
}

// =========================================================
// VIEW 9: PERMISSÕES
// =========================================================
function renderPermissoesHtml() {
  const isConn = Boolean(state.connectedItemId);
  const item = state.activeData?.item || null;

  let badge = { text: 'PENDENTE DE AUTORIZAÇÃO', bg: '#fef3c7', color: '#b45309' };
  if (isConn && !item) badge = { text: state.loading ? 'VERIFICANDO…' : 'NÃO FOI POSSÍVEL VERIFICAR AGORA', bg: '#f1f5f9', color: '#475569' };
  else if (item) {
    const expired = item.consentExpiresAt && new Date(item.consentExpiresAt).getTime() <= Date.now();
    if (expired) badge = { text: 'AUTORIZAÇÃO VENCIDA', bg: '#fef3c7', color: '#b45309' };
    else if (needsReconnect(item)) badge = { text: 'PRECISA RECONECTAR', bg: '#fef3c7', color: '#b45309' };
    else if (item.status === 'UPDATING') badge = { text: 'SINCRONIZANDO', bg: '#e8f0fe', color: '#002b80' };
    else if (item.status === 'UPDATED') badge = { text: 'ATIVA E AUTORIZADA', bg: '#dcfce7', color: '#15803d' };
    else badge = { text: translate(ITEM_STATUS_LABELS, item.status).toUpperCase(), bg: '#f1f5f9', color: '#475569' };
  }

  const products = Array.isArray(item?.products) ? item.products : [];
  const scopes = products.length
    ? `<ul style="margin: 6px 0 0 18px;">${products.map(p => `<li>${escapeHtml(productLabel(p))}</li>`).join('')}</ul>`
    : `<span>${isConn ? 'A instituição ainda não informou quais dados foram autorizados.' : 'Nenhum dado autorizado.'}</span>`;

  const buttons = isConn
    ? `<button type="button" class="btn-mister-filter" data-action="reconnect"><span>Renovar autorização (reconectar)</span></button>
       <button type="button" class="btn-mister-filter" data-action="connect-new"><span>Conectar outra conta</span></button>
       <button type="button" class="btn-cancel" data-action="revoke">Revogar acesso</button>`
    : '<button type="button" class="btn-mister-filter" data-action="connect"><span>Autorizar conexão com o banco</span></button>';

  return `
    <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: var(--mister-radius-md); padding: 24px; max-width: 800px;">
      <h3 style="color: #002b80; font-size: 15px; margin-bottom: 12px;">
        <span aria-hidden="true">🔒</span> Gestão de Consentimento e Permissões Open Finance
      </h3>
      <p style="color: var(--mister-text-muted); font-size: 12.5px; margin-bottom: 20px; line-height: 1.5;">
        Em conformidade com a regulação de Open Finance do Banco Central do Brasil, a empresa concede acesso aos dados estritamente para fins de conciliação e escrituração contábil no Mister Contador.
      </p>

      <div style="border: 1px solid var(--mister-border-subtle); border-radius: 8px; padding: 16px; margin-bottom: 20px; background: #f8fafc;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;">
          <strong>Consentimento de dados bancários${item?.connector?.name ? ` — ${escapeHtml(item.connector.name)}` : ''}:</strong>
          <span style="background: ${badge.bg}; color: ${badge.color}; padding: 3px 10px; border-radius: 12px; font-weight: 700; font-size: 11px;">${escapeHtml(badge.text)}</span>
        </div>
        ${item?.consentExpiresAt ? `<p style="font-size: 12px; color: #475569; margin-bottom: 8px;"><strong>Autorização válida até:</strong> ${escapeHtml(formatInstantDate(item.consentExpiresAt))}</p>` : ''}
        <div style="font-size: 12px; color: #475569;">
          <strong>Dados autorizados:</strong> ${scopes}
        </div>
      </div>

      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
        ${buttons}
      </div>
      <p class="muted-note" style="margin-top: 14px;">“Conectar outra conta” substitui a conexão atual neste app (ele guarda uma conexão por vez). “Revogar acesso” encerra a autorização no banco e apaga os dados desta conexão. Para sair do app neste computador, feche o navegador.</p>
    </div>
  `;
}

// =========================================================
// VIEW 10: INÍCIO
// =========================================================
function renderInicioViewHtml() {
  const isConn = Boolean(state.connectedItemId);
  const item = state.activeData?.item;

  const shortcut = (view, icon, title, desc) => `
        <button type="button" class="home-shortcut" data-action="view" data-view="${view}">
          <span class="home-shortcut-icon" aria-hidden="true">${icon}</span>
          <strong class="home-shortcut-title">${title}</strong>
          <span class="home-shortcut-desc">${desc}</span>
        </button>`;

  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div style="background: linear-gradient(135deg, #002b80 0%, #1a56c4 100%); color: #fff; border-radius: var(--mister-radius-md); padding: 28px; box-shadow: var(--mister-shadow-md);">
        <h2 style="font-size: 20px; margin-bottom: 8px;">Bem-vindo ao Mister Contador Open Finance</h2>
        <p style="opacity: 0.9; font-size: 13.5px; max-width: 650px; line-height: 1.5; margin-bottom: 20px;">
          Sincronização bancária direta e conciliação contábil. Conecte as contas da empresa para ver comprovantes, extratos, faturas de cartão e estatísticas com os dados enviados pelo banco.
        </p>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
          <button type="button" class="btn-mister-action" style="background: #ffffff; color: #002b80; font-weight: 700; font-size: 13px; padding: 10px 20px;" data-action="${isConn ? 'refresh' : 'connect'}">
            <span>${isConn ? 'Atualizar dados' : '<span aria-hidden="true">🔌</span> Conectar banco'}</span>
          </button>
          ${needsReconnect(item) ? '<button type="button" class="btn-mister-action" style="background: #fef3c7; color: #92400e; font-weight: 700; font-size: 13px; padding: 10px 20px;" data-action="reconnect"><span>Reconectar</span></button>' : ''}
          <button type="button" class="btn-mister-action" style="background: transparent; color: #ffffff; border: 1px solid rgba(255,255,255,0.6); font-size: 13px; padding: 10px 20px;" data-action="help"><span>Como usar</span></button>
        </div>
      </div>

      <!-- Grade de Atalhos das Funcionalidades -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px;">
        ${shortcut('comprovantes', '🧾', 'Comprovantes', 'Pagamentos, boletos e PIX com pagador, recebedor e documento.')}
        ${shortcut('registro', '📑', 'Registro Contábil', 'Partidas dobradas (débito/crédito) com a contrapartida a definir.')}
        ${shortcut('extrato', '🏦', 'Extrato Bancário', 'Movimentações das contas bancárias no período.')}
        ${shortcut('cartao', '💳', 'Cartão de Crédito', 'Faturas enviadas pelo banco e lançamentos do cartão.')}
        ${shortcut('investimentos', '📈', 'Investimentos', 'Saldo e rentabilidade das aplicações.')}
        ${shortcut('emprestimos', '🤝', 'Empréstimos', 'Contratos e saldo devedor.')}
        ${shortcut('estatisticas', '📊', 'Estatísticas', 'Painel com totais do período, gráficos e limites.')}
      </div>
    </div>
  `;
}

// Atualiza o dropdown de contas (agrupado em contas bancárias e cartões)
function updateAccountsDropdown() {
  const select = document.getElementById('accountSelect');
  if (!select) return;

  const accounts = state.activeData?.accounts || [];
  if (!accounts.length) {
    select.innerHTML = '<option value="all">Todas as Contas</option>';
    select.value = 'all';
    state.currentAccount = 'all';
    return;
  }

  const option = (acc) => `<option value="${escapeHtml(acc.id)}">${escapeHtml(acc.name || 'Conta')}${acc.number ? ` - ${escapeHtml(acc.number)}` : ''}</option>`;
  const banks = accounts.filter(a => !isCardAccount(a));
  const cards = accounts.filter(isCardAccount);
  let html = '<option value="all">Todas as Contas</option>';
  if (banks.length) html += `<optgroup label="Contas bancárias">${banks.map(option).join('')}</optgroup>`;
  if (cards.length) html += `<optgroup label="Cartões de crédito">${cards.map(option).join('')}</optgroup>`;
  select.innerHTML = html;

  if (state.currentAccount !== 'all' && accounts.find(a => a.id === state.currentAccount)) {
    select.value = state.currentAccount;
  } else {
    select.value = 'all';
    state.currentAccount = 'all';
  }
}

// Status do topo: banco + situação, sem códigos técnicos
function updateTopbar() {
  const dot = document.getElementById('topbarStatusDot');
  const text = document.getElementById('topbarStatusText');
  const btn = document.getElementById('reopenPluggyBtn');
  const label = document.getElementById('btnConnectLabel');
  const item = state.activeData?.item;

  dot?.classList.remove('disconnected', 'is-warning', 'is-syncing');
  if (!state.connectedItemId) {
    dot?.classList.add('disconnected');
    if (text) text.textContent = 'Desconectado';
    if (label) label.textContent = 'Conectar';
    if (btn) { btn.dataset.action = 'connect'; btn.title = 'Conectar o banco da empresa'; }
    return;
  }

  const name = item?.connector?.name || 'Conexão salva';
  let suffix = 'conectado';
  if (!state.activeData) {
    // Bolinha azul pulsando só enquanto carrega; falha no carregamento fica em amarelo (o aviso está em #appNotices)
    suffix = state.loading ? 'carregando…' : 'dados não carregados';
    dot?.classList.add(state.loading ? 'is-syncing' : 'is-warning');
  } else if (needsReconnect(item)) {
    suffix = 'precisa reconectar';
    dot?.classList.add('is-warning');
  } else if (state.activeData.syncing || item?.status === 'UPDATING') {
    suffix = 'sincronizando';
    dot?.classList.add('is-syncing');
  } else if (state.loading) {
    suffix = 'atualizando…';
  }
  if (text) text.textContent = `${name} · ${suffix}`;
  if (label) label.textContent = 'Atualizar';
  if (btn) { btn.dataset.action = 'refresh'; btn.title = 'Recarregar os dados do banco (não abre a conexão de novo)'; }
}

// Nome e documento no topo (vindos do /identity da Pluggy), com rótulos de PF ou PJ
function updateCompanyPills() {
  const holder = holderInfo(state.activeData?.identity);
  const label = document.getElementById('empresaLabel');
  const name = document.getElementById('empresaPillName');
  const doc = document.getElementById('cnpjPill');
  if (label) label.textContent = holder ? holder.topLabel : 'Empresa:';
  if (name) {
    name.textContent = holder?.name || (state.activeData ? 'Não informado pelo banco' : (state.connectedItemId ? 'Carregando…' : 'Aguardando conexão'));
    name.title = holder ? holder.nameLabel : 'Razão Social da Empresa';
  }
  if (doc) {
    doc.textContent = holder?.doc || '—';
    doc.title = holder ? holder.docLabel : 'CNPJ ou CPF';
  }
}

// Cabeçalho só de impressão: tela, empresa/titular, documento e período
function fillPrintHeader() {
  const el = document.getElementById('printHeader');
  if (!el) return;
  const cfg = VIEW_CONFIG[state.currentView] || VIEW_CONFIG.comprovantes;
  const holder = holderInfo(state.activeData?.identity);
  const period = cfg.period ? capitalize(loadedPeriod()?.label || '') : '';
  const lines = [
    `<strong>${escapeHtml(cfg.title)}</strong>`,
    holder ? `${escapeHtml(holder.nameLabel)}: ${escapeHtml(holder.name || '—')} · ${escapeHtml(holder.docLabel)}: ${escapeHtml(holder.doc || '—')}` : '',
    period ? `Período: ${escapeHtml(period)}` : '',
    `Gerado em ${escapeHtml(formatDateTime(new Date().toISOString()))}`
  ].filter(Boolean);
  el.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
}

// =========================================================
// CONEXÃO, ATUALIZAÇÃO E REVOGAÇÃO
// =========================================================
function linkItem(itemId) {
  const changed = itemId !== state.connectedItemId;
  if (changed) {
    state.requestSeq++; // descarta respostas ainda em andamento do Item anterior
    state.activeData = null;
    state.currentAccount = 'all';
    state.loadError = null;
  }
  state.connectedItemId = itemId;
  storage.set(STORAGE_KEY, itemId);
  updateTopbar();
  if (changed) {
    updateCompanyPills();
    updateAccountsDropdown();
  }
}

// Esquece a conexão neste navegador e volta o topo para "Desconectado"
function clearConnection() {
  state.activeData = null;
  state.connectedItemId = null;
  state.currentAccount = 'all';
  state.loadError = null;
  storage.remove(STORAGE_KEY);
  // Invalida qualquer carregamento em andamento (ex.: "Atualizar" esperando a sincronização) e sai do modo carregando
  state.requestSeq++;
  setLoading(false, null, { render: false });
  updateTopbar();
  updateCompanyPills();
  updateAccountsDropdown();
}

// Busca os dados consolidados do Item na API da Pluggy (via servidor)
async function fetchItemData(itemId, { silent = false, filter = state.currentFilter } = {}) {
  const seq = ++state.requestSeq;
  setLoading(true, filter);
  try {
    const qs = new URLSearchParams({ itemId, from: filter.from, to: filter.to, label: filter.label });
    const data = await apiFetch(`/api/item-data?${qs.toString()}`);
    if (seq !== state.requestSeq) return { ok: false, stale: true }; // resposta antiga: o usuário já pediu outra coisa
    if (itemId !== state.connectedItemId) return { ok: false, stale: true }; // conexão revogada ou trocada no meio do caminho

    state.activeData = data;
    state.currentFilter = { ...filter };
    state.loadError = null;
    console.log('📦 DADOS REAIS RETORNADOS DA PLUGGY:', state.activeData);

    syncPeriodControls();
    updateCompanyPills();
    updateAccountsDropdown();
    return { ok: true };
  } catch (err) {
    if (seq !== state.requestSeq) return { ok: false, stale: true };
    if (err.code === 'ITEM_NOT_FOUND') {
      // Único caso em que a conexão salva é esquecida: o Item não existe mais na Pluggy
      clearConnection(); // invalida o seq: o finally abaixo não re-renderiza, então renderiza aqui
      renderCurrentView();
      notify('A conexão com o banco não existe mais (foi removida). Conecte o banco de novo.', 'error');
      return { ok: false, notFound: true };
    }
    // Erro passageiro: mantém a conexão e os dados anteriores, com aviso "Tentar novamente"
    state.loadError = { message: userMessageOf(err), code: err.code, filter: { ...filter } };
    if (!silent) notify(userMessageOf(err), 'error');
    return { ok: false, error: err };
  } finally {
    if (seq === state.requestSeq) {
      setLoading(false, null, { render: false });
      renderCurrentView();
    }
  }
}

async function refreshData() {
  if (!state.connectedItemId) {
    openConnectModal({ mode: 'new', trigger: document.getElementById('reopenPluggyBtn') });
    return;
  }
  const result = await fetchItemData(state.connectedItemId);
  if (result.ok) notify('Dados atualizados.', 'success');
}

function retryLoad() {
  if (!state.connectedItemId) return;
  fetchItemData(state.connectedItemId, { filter: state.loadError?.filter || state.currentFilter });
}

async function deleteItem(itemId) {
  const body = await apiFetch(`/api/item?itemId=${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  if (!body?.revoked) throw new ApiError('INTERNAL', 200, 'O serviço não confirmou a revogação. Tente de novo.');
}

// Revogar: confirma, chama DELETE /api/item (que faz DELETE /items/{id} na Pluggy) e limpa tudo
async function revokeAccess() {
  if (!state.connectedItemId) return;
  const bank = state.activeData?.item?.connector?.name;
  const ok = await confirmDialog({
    title: 'Revogar o acesso ao banco?',
    message: `Isso encerra a autorização dada ao Mister Contador${bank ? ` no ${bank}` : ''} e apaga os dados desta conexão. Para voltar a ver os lançamentos, será preciso conectar o banco de novo.`,
    confirmText: 'Sim, revogar acesso',
    cancelText: 'Cancelar',
    danger: true
  });
  if (!ok) return;
  try {
    await deleteItem(state.connectedItemId);
  } catch (err) {
    notify(`Não foi possível revogar agora. ${userMessageOf(err)}`, 'error');
    return;
  }
  clearConnection();
  notify('Acesso revogado. A autorização foi encerrada e os dados desta conexão foram apagados.', 'success');
  switchView('inicio', { focusHeading: true });
}

// "Conectar outra conta": o app guarda uma conexão por vez, então avisa que substitui a atual
async function connectNewAccount(trigger) {
  if (state.connectedItemId) {
    const bank = state.activeData?.item?.connector?.name;
    const ok = await confirmDialog({
      title: 'Conectar outra conta?',
      message: `O app trabalha com uma conexão por vez. A nova conta vai substituir a atual${bank ? ` (${bank})` : ''} nas telas. Depois de conectar, você poderá encerrar a autorização da anterior.`,
      confirmText: 'Continuar',
      cancelText: 'Cancelar'
    });
    if (!ok) return;
  }
  openConnectModal({ mode: 'new', trigger });
}

async function offerRevokePrevious(previousId, previousName) {
  const ok = await confirmDialog({
    title: 'Encerrar a conexão anterior?',
    message: `A conexão anterior${previousName ? ` (${previousName})` : ''} continua autorizada no banco, mas não aparece mais no app. Deseja revogar essa autorização agora? Recomendado se você não for mais usá-la.`,
    confirmText: 'Revogar a anterior',
    cancelText: 'Manter',
    danger: true
  });
  if (!ok) return;
  try {
    await deleteItem(previousId);
    notify('Autorização da conexão anterior revogada.', 'success');
  } catch (err) {
    notify(`Não foi possível revogar a conexão anterior. ${userMessageOf(err)}`, 'error');
  }
}

// =========================================================
// INTEGRAÇÃO COM O PLUGGY CONNECT WIDGET (DADOS REAIS)
// =========================================================
// errorLinkedId: Item vinculado por um onError nesta mesma abertura do widget (ex.: senha errada e nova tentativa)
const connectState = { mode: 'new', attempt: 0, trigger: null, errorLinkedId: null };

const needsRuntimeCreds = () => Boolean(state.config && !state.config.hasEnvKeys && state.config.allowRuntimeCreds && !state.runtimeCredsAccepted);
const integrationMissing = () => Boolean(state.config && !state.config.hasEnvKeys && !state.config.allowRuntimeCreds);

function renderConnectModal(phase, errorMessage = '') {
  const isUpdate = connectState.mode === 'update';
  const setDisplay = (id, visible, value = 'block') => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? value : 'none';
  };
  document.getElementById('connectModalTitle').textContent = isUpdate ? 'Reconectar o banco' : 'Conectar o banco';
  document.getElementById('connectModalDesc').textContent = isUpdate
    ? 'Você vai entrar de novo no banco para renovar esta conexão. Os dados não serão duplicados.'
    : 'Conexão segura via Open Finance, com autorização no próprio banco.';
  const list = document.getElementById('connectInstructionsList');
  if (list) {
    list.innerHTML = isUpdate
      ? '<li>Na próxima janela, confirme o acesso do internet banking e autorize no app ou no site do banco, se ele pedir.</li><li>Ao terminar, os dados são recarregados automaticamente.</li>'
      : '<li>Na próxima janela, escolha o banco da empresa (ou o seu, se for pessoa física).</li><li>Entre com o mesmo acesso do internet banking e autorize o compartilhamento no app ou no site do banco.</li><li>Ao terminar, os lançamentos aparecem aqui automaticamente.</li>';
  }

  const loading = phase === 'loading';
  setDisplay('connectInstructions', !loading);
  setDisplay('sandboxInstructions', !loading && state.config?.includeSandbox === true);
  setDisplay('credentialsPrompt', !loading && needsRuntimeCreds());
  const missing = document.getElementById('connectNotConfigured');
  if (missing) missing.hidden = loading || !integrationMissing();
  setDisplay('modalLoadingState', loading);

  const err = document.getElementById('connectError');
  if (err) {
    err.textContent = errorMessage;
    err.hidden = !errorMessage || loading;
  }

  const start = document.getElementById('startWidgetBtn');
  if (start) {
    start.style.display = loading ? 'none' : '';
    start.disabled = integrationMissing();
    start.textContent = isUpdate ? 'Continuar para o banco' : 'Continuar';
  }
}

function openConnectModal({ mode = 'new', trigger } = {}) {
  if (state.connecting) return;
  connectState.mode = mode === 'update' && state.connectedItemId ? 'update' : 'new';
  connectState.trigger = trigger || document.activeElement;
  renderConnectModal('intro');
  const overlay = document.getElementById('connectOverlay');
  openModal(overlay, {
    trigger: connectState.trigger,
    initialFocus: needsRuntimeCreds() ? '#modalClientId' : '#startWidgetBtn',
    onDismiss: cancelConnect
  });
  if (integrationMissing()) document.getElementById('btnCancelConnect')?.focus();
}

// Fechar o modal durante a preparação cancela a abertura do widget
function cancelConnect() {
  connectState.attempt += 1;
  state.connecting = false;
  closeModal(document.getElementById('connectOverlay'));
}

function handleConnectError(err, { updateId }) {
  if (err.code === 'ITEM_NOT_FOUND' && updateId) {
    // A conexão a atualizar não existe mais: oferece uma conexão nova
    clearConnection();
    connectState.mode = 'new';
    renderConnectModal('intro', 'A conexão anterior não existe mais. Clique em "Continuar" para conectar o banco de novo.');
    renderCurrentView();
    return;
  }
  if (err.code === 'PLUGGY_AUTH' && state.config?.allowRuntimeCreds) {
    state.runtimeCredsAccepted = false;
    // Usa a mensagem do servidor: ele distingue credenciais faltando (credsNeededDev) de recusadas (runtimeRefused)
    renderConnectModal('intro', userMessageOf(err));
    document.getElementById('modalClientId')?.focus();
    return;
  }
  renderConnectModal('intro', userMessageOf(err));
  document.getElementById('startWidgetBtn')?.focus();
}

async function startWidget() {
  if (state.connecting || integrationMissing()) return;
  const attempt = ++connectState.attempt;
  state.connecting = true;
  connectState.errorLinkedId = null;
  renderConnectModal('loading');
  document.getElementById('modalLoadingText').textContent = 'Preparando conexão segura…';
  document.getElementById('btnCancelConnect')?.focus();

  const updateId = connectState.mode === 'update' ? state.connectedItemId : null;
  try {
    // clientUserId não é enviado: o servidor usa o usuário do login (APP_USER)
    const payload = {};
    if (updateId) payload.itemId = updateId;
    const clientId = document.getElementById('modalClientId')?.value?.trim();
    const clientSecret = document.getElementById('modalClientSecret')?.value?.trim();
    const sentCreds = needsRuntimeCreds() && Boolean(clientId && clientSecret);
    if (sentCreds) {
      payload.clientId = clientId;
      payload.clientSecret = clientSecret;
    }

    const body = await apiFetch('/api/connect-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (attempt !== connectState.attempt) return; // modal fechado no meio do caminho
    if (!body?.accessToken) throw new ApiError('INTERNAL', 200, FRIENDLY_ERRORS.INTERNAL);
    if (sentCreds) {
      state.runtimeCredsAccepted = true;
      const secret = document.getElementById('modalClientSecret');
      if (secret) secret.value = ''; // não reenvia o segredo a cada abertura
    }

    document.getElementById('modalLoadingText').textContent = 'Abrindo a janela do banco…';
    await ensurePluggyConnect();
    if (attempt !== connectState.attempt) return;
    openPluggyWidget(body.accessToken, updateId, attempt);
  } catch (err) {
    if (attempt !== connectState.attempt) return;
    state.connecting = false;
    handleConnectError(err, { updateId });
  }
}

function openPluggyWidget(connectToken, updateId, attempt) {
  const overlay = document.getElementById('connectOverlay');
  const pluggyConnect = new window.PluggyConnect({
    connectToken,
    includeSandbox: state.config?.includeSandbox === true,
    // Empresas (PJ), pessoas físicas (ex.: contabilidade CAEPF/produtor rural) e corretoras
    connectorTypes: ['BUSINESS_BANK', 'PERSONAL_BANK', 'INVESTMENT'],
    // Modo atualização: o widget vai direto ao login do Item existente (não cria um Item novo)
    ...(updateId ? { updateItem: updateId } : {}),
    onOpen: () => {
      closeModal(overlay, { returnFocus: false });
    },
    onSuccess: async (data) => {
      state.connecting = false;
      closeModal(overlay, { returnFocus: false });
      await handleWidgetSuccess(data, updateId);
    },
    onError: async (err) => {
      state.connecting = false;
      closeModal(overlay, { returnFocus: false });
      await handleWidgetError(err, updateId);
    },
    onClose: () => {
      state.connecting = false;
      closeModal(overlay, { returnFocus: false });
      if (attempt === connectState.attempt) restoreFocus(connectState.trigger);
    }
  });

  Promise.resolve()
    .then(() => pluggyConnect.init())
    .catch((err) => {
      console.error('Erro ao iniciar o widget:', err);
      state.connecting = false;
      handleConnectError(new ApiError('WIDGET', 0, 'Não foi possível abrir a janela do banco. Tente de novo em instantes.'), { updateId });
    });
}

async function handleWidgetSuccess(data, updateId) {
  const itemId = data?.item?.id;
  if (!itemId || !UUID_RE.test(itemId)) {
    console.error('onSuccess sem item.id válido:', data);
    notify('A conexão terminou, mas não recebemos a identificação dela. Tente de novo.', 'error');
    return;
  }
  const previousId = state.connectedItemId;
  const previousName = state.activeData?.item?.connector?.name;
  linkItem(itemId);
  console.log('✅ Item Conectado:', itemId);
  notify(updateId ? 'Conexão renovada. Atualizando os dados…' : 'Banco conectado! Buscando os dados…', 'success');
  await fetchItemData(itemId);
  // Conta nova no lugar de outra: oferece encerrar a autorização antiga (evita conexão esquecida ativa).
  // Não pergunta sobre um Item que só falhou nesta mesma tentativa (ele não chegou a ser autorizado).
  if (previousId && previousId !== itemId && previousId !== connectState.errorLinkedId) {
    await offerRevokePrevious(previousId, previousName);
  }
  connectState.errorLinkedId = null;
}

// Mensagem amigável conforme o motivo informado pelo widget (item.executionStatus)
function widgetErrorMessage(item) {
  const messages = {
    INVALID_CREDENTIALS: 'O banco não aceitou o usuário ou a senha. Confira e tente de novo.',
    INVALID_CREDENTIALS_MFA: 'O código de confirmação não foi aceito ou expirou. Tente de novo.',
    USER_INPUT_TIMEOUT: 'O tempo para informar o código de confirmação acabou. Tente de novo.',
    ACCOUNT_LOCKED: 'O banco bloqueou o acesso desta conta. Fale com o banco para desbloquear.',
    ACCOUNT_NEEDS_ACTION: 'O banco pede uma ação sua (por exemplo, aceitar novos termos) no app ou site dele. Depois, tente de novo.',
    ACCOUNT_CREDENTIALS_RESET: 'O banco pediu para você trocar a senha. Troque no banco e tente de novo.',
    ALREADY_LOGGED_IN: 'Já existe uma sessão aberta no banco. Saia do internet banking e tente de novo.',
    SITE_NOT_AVAILABLE: 'O banco está fora do ar agora. Tente de novo mais tarde.',
    CONNECTION_ERROR: 'Não foi possível falar com o banco agora. Tente de novo mais tarde.',
    USER_AUTHORIZATION_NOT_GRANTED: 'A autorização não foi concedida no banco.',
    USER_AUTHORIZATION_REVOKED: 'A autorização foi cancelada no banco. Conecte de novo se quiser continuar.',
    USER_NOT_SUPPORTED: 'Este tipo de acesso ao banco não é aceito. Use o acesso principal da empresa.'
  };
  return messages[item?.executionStatus] || 'Não foi possível concluir a conexão com o banco. Tente de novo.';
}

async function handleWidgetError(err, updateId) {
  console.error('Erro no widget:', err);
  const item = err?.data?.item;
  const itemId = item?.id && UUID_RE.test(item.id) ? item.id : null;
  const pending = item?.executionStatus === 'USER_AUTHORIZATION_PENDING';
  // Só troca o vínculo se não houver Item salvo, se for o mesmo Item (modo updateItem) ou se for autorização pendente.
  // Assim uma tentativa com senha errada em outro banco não apaga a conexão boa que já existe.
  const canLink = itemId && (!state.connectedItemId || itemId === state.connectedItemId || pending);
  if (canLink) {
    if (pending && state.connectedItemId && state.connectedItemId !== itemId) {
      const ok = await confirmDialog({
        title: 'Usar a nova conexão?',
        message: 'A nova conexão está aguardando sua autorização no app do banco. Deseja usá-la no lugar da conexão atual?',
        confirmText: 'Usar a nova',
        cancelText: 'Manter a atual'
      });
      if (ok) linkItem(itemId);
    } else {
      if (!pending && itemId !== state.connectedItemId) connectState.errorLinkedId = itemId;
      linkItem(itemId);
    }
  }

  if (pending) {
    notify('O banco pediu uma autorização no app ou no aparelho. Assim que você liberar (pode levar uns 30 minutos), clique em "Atualizar".', 'info', { timeout: 15000 });
  } else {
    notify(item ? widgetErrorMessage(item) : 'Não foi possível abrir a conexão com o banco. Tente de novo.', 'error');
  }
  if (state.connectedItemId) await fetchItemData(state.connectedItemId, { silent: true });
  else renderCurrentView();
}

// Garante o script do widget: cópia local primeiro, CDN da Pluggy como reserva (com Subresource Integrity)
function loadScript(src, { integrity } = {}) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    if (integrity) {
      el.integrity = integrity;
      el.crossOrigin = 'anonymous';
    }
    el.onload = resolve;
    el.onerror = () => reject(new Error(`falha ao carregar ${src}`));
    document.head.appendChild(el);
  });
}

async function ensurePluggyConnect() {
  if (typeof window.PluggyConnect === 'function') return;
  const sources = [
    { src: WIDGET_LOCAL_SRC },
    { src: WIDGET_CDN_SRC, integrity: WIDGET_CDN_SRI }
  ];
  for (const { src, integrity } of sources) {
    try {
      await loadScript(src, { integrity });
      if (typeof window.PluggyConnect === 'function') return;
    } catch (err) {
      console.warn(err.message, '— se houver bloqueador, libere cdn.pluggy.ai e connect.pluggy.ai');
    }
  }
  throw new ApiError('WIDGET', 0, 'Não foi possível abrir a janela do banco. Desative bloqueadores de anúncios ou de privacidade para este site e tente de novo.');
}

document.addEventListener('DOMContentLoaded', init);
