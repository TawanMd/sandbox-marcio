/**
 * Mister Contador — Open Finance Pluggy Integration Controller
 * Visualização e gestão completa com suporte às novas funcionalidades:
 * Início, Registro Contábil, Extrato, Cartão de Crédito, Comprovantes, Estatísticas, Empresa e Permissões.
 * DADOS SEMPRE CARREGADOS DA PLUGGY API (sem mocks).
 */

const state = {
  currentView: 'comprovantes', // 'inicio' | 'registro' | 'extrato' | 'cartao' | 'comprovantes' | 'estatisticas' | 'empresa' | 'permissoes'
  activeData: null,            // Nulo até que haja conexão real com o widget
  connectedItemId: null,
  config: null,
  subTypeFilter: 'all',
  jsonSubTab: 'all',
  currentFilter: null,         // definido em buildPresets() (M-1 por padrão)
  presets: {},
  currentAccount: 'all'
};

// Disponibiliza no escopo global para depuração
window.misterState = state;
window.getPluggyData = () => state.activeData;

// --- Formatadores Úteis ---
function formatMoney(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return 'R$ 0,00';
  const num = Number(amount);
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const [y, m, d] = dateStr.split('T')[0].split('-');
    return `${d}/${m}/${y}`;
  } catch {
    return dateStr;
  }
}

function escapeHtml(string) {
  if (string === null || string === undefined) return '';
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- Normalização dos dados da Pluggy para as telas ---
// Empréstimos: o schema real traz saldo em payments.contractOutstandingBalance, parcelas em installments
// e taxas em interestRates[].
function normalizeLoan(l) {
  const inst = l.installments || {};
  const rate = (l.interestRates || []).find(r => r.preFixedRate != null || r.postFixedRate != null) || {};
  const ratePct = rate.preFixedRate != null ? rate.preFixedRate * 100 : (rate.postFixedRate != null ? rate.postFixedRate * 100 : null);
  const total = inst.totalNumberOfInstallments ?? null;
  const paid = inst.paidInstallments ?? null;
  return {
    id: l.id,
    contract: l.contractNumber || l.ipocCode || l.id,
    name: l.productName || l.type || '—',
    type: l.type || l.kind || '—',
    contractAmount: l.contractAmount ?? null,
    outstanding: l.payments?.contractOutstandingBalance ?? l.outstandingBalance ?? null,
    ratePct,
    ratePeriod: rate.taxPeriodicity === 'MONTHLY' ? 'a.m.' : (rate.taxPeriodicity === 'YEARLY' ? 'a.a.' : ''),
    cet: l.CET != null ? l.CET * 100 : null,
    totalInstallments: total,
    paidInstallments: paid,
    dueInstallments: inst.dueInstallments ?? null,
    dueDate: l.dueDate || null
  };
}

const investmentBalance = (i) => Number(i.balance) || 0;
const isActiveInvestment = (i) => i.status !== 'TOTAL_WITHDRAWAL';

function formatPct(n) {
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

// --- Períodos (calculados a partir da data atual) ---
function monthRange(offset) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    from: iso(first),
    to: iso(last),
    label: first.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  };
}

function buildPresets() {
  state.presets = {
    'm-1': monthRange(-1),
    current: monthRange(0),
    'm-2': monthRange(-2),
    'm-3': monthRange(-3)
  };
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const names = {
    'm-1': `M-1 Fechado (${cap(state.presets['m-1'].label)})`,
    current: `Mês Atual (${cap(state.presets.current.label)})`,
    'm-2': `${cap(state.presets['m-2'].label)} (M-2)`,
    'm-3': `${cap(state.presets['m-3'].label)} (M-3)`
  };
  document.querySelectorAll('.preset-btn').forEach(btn => {
    if (names[btn.dataset.preset]) btn.textContent = names[btn.dataset.preset];
  });
  state.currentFilter = { ...state.presets['m-1'] };
  updatePeriodUI();
  const fromInput = document.getElementById('filterDateFrom');
  const toInput = document.getElementById('filterDateTo');
  if (fromInput) fromInput.value = state.currentFilter.from;
  if (toInput) toInput.value = state.currentFilter.to;
}

// Identificador estável do usuário final (vai no connect token como clientUserId)
function getClientUserId() {
  let id = localStorage.getItem('pluggy_client_user_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('pluggy_client_user_id', id);
  }
  return id;
}

// --- Inicialização da Aplicação ---
async function init() {
  buildPresets();
  setupEventListeners();

  try {
    const configRes = await fetch('/api/config');
    state.config = await configRes.json();
  } catch (err) {
    console.warn('Não foi possível carregar /api/config:', err);
  }

  // Restaura sessão conectada caso o usuário já tenha conectado via widget
  const savedItemId = localStorage.getItem('pluggy_connected_item_id');
  if (savedItemId) {
    state.connectedItemId = savedItemId;
    const ok = await fetchItemData(savedItemId, { silent: true });
    if (!ok) {
      state.connectedItemId = null;
      localStorage.removeItem('pluggy_connected_item_id');
      switchView('comprovantes');
    }
  } else {
    switchView('comprovantes');
  }
}

// --- Configuração dos Listeners da Interface ---
function setupEventListeners() {
  // Navegação pelos itens do Navbar Lateral
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view) switchView(view);
    });
  });

  // Botão Carregar / Conectar no Header
  document.getElementById('reopenPluggyBtn')?.addEventListener('click', () => {
    launchPluggyWidget();
  });

  // Botão Filtros ▼ (recarrega a visualização ou alterna popover)
  document.getElementById('btnFilterToggle')?.addEventListener('click', () => {
    const popover = document.getElementById('dateFilterPopover');
    if (popover) {
      popover.style.display = popover.style.display === 'none' ? 'block' : 'none';
    }
  });

  // Seletor de Período
  const periodBtn = document.getElementById('periodBtn');
  const datePopover = document.getElementById('dateFilterPopover');
  const closePopoverBtn = document.getElementById('closeDatePopoverBtn');

  periodBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    datePopover.style.display = datePopover.style.display === 'none' ? 'block' : 'none';
  });

  closePopoverBtn?.addEventListener('click', () => {
    datePopover.style.display = 'none';
  });

  document.addEventListener('click', (e) => {
    if (datePopover && !datePopover.contains(e.target) && e.target !== periodBtn && !periodBtn?.contains(e.target)) {
      datePopover.style.display = 'none';
    }
  });

  // Atalhos de Período
  const presetButtons = document.querySelectorAll('.preset-btn');
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      presetButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const preset = btn.dataset.preset;
      const { from, to, label } = state.presets[preset];

      document.getElementById('filterDateFrom').value = from;
      document.getElementById('filterDateTo').value = to;
      reloadWithFilter(from, to, label);
    });
  });

  // Aplicar Intervalo Personalizado
  document.getElementById('applyDateFilterBtn')?.addEventListener('click', () => {
    const from = document.getElementById('filterDateFrom').value;
    const to = document.getElementById('filterDateTo').value;
    if (!from || !to || from > to) {
      alert('Selecione um intervalo de datas válido.');
      return;
    }
    presetButtons.forEach(b => b.classList.remove('active'));
    const label = `${formatDate(from)} até ${formatDate(to)}`;
    reloadWithFilter(from, to, label);
  });

  // Restaurar M-1
  document.getElementById('resetDateFilterBtn')?.addEventListener('click', () => {
    presetButtons.forEach(b => b.classList.remove('active'));
    document.querySelector('.preset-btn[data-preset="m-1"]')?.classList.add('active');
    const p = state.presets['m-1'];
    document.getElementById('filterDateFrom').value = p.from;
    document.getElementById('filterDateTo').value = p.to;
    reloadWithFilter(p.from, p.to, p.label);
  });

  // Filtro de Subtipo (Todos, Débitos, Créditos, PIX, Boleto)
  document.getElementById('subTypeSelect')?.addEventListener('change', (e) => {
    state.subTypeFilter = e.target.value;
    renderCurrentView();
  });

  // Filtro de Conta
  document.getElementById('accountSelect')?.addEventListener('change', (e) => {
    state.currentAccount = e.target.value;
    renderCurrentView();
  });

  // Botão Flutuante Central Mister
  document.getElementById('btnCentralMister')?.addEventListener('click', () => {
    alert('Central Mister Contador — Suporte contábil & Open Finance integrado via Pluggy API.');
  });

  // Botão Relatório
  document.getElementById('btnReport')?.addEventListener('click', () => {
    window.print();
  });

  // Fechar Modal Connect
  document.getElementById('closeOverlayBtn')?.addEventListener('click', () => {
    document.getElementById('connectOverlay').style.display = 'none';
  });
  document.getElementById('btnCancelConnect')?.addEventListener('click', () => {
    document.getElementById('connectOverlay').style.display = 'none';
  });
  document.getElementById('startWidgetBtn')?.addEventListener('click', launchPluggyWidget);
}

// Atualiza Textos do Período no Header
function updatePeriodUI() {
  const f = state.currentFilter;
  const periodBtnText = document.getElementById('periodBtnText');
  if (periodBtnText) periodBtnText.textContent = f.label;
}

// Recarrega os dados com as datas filtradas
async function reloadWithFilter(from, to, label) {
  state.currentFilter = { from, to, label };
  updatePeriodUI();
  document.getElementById('dateFilterPopover').style.display = 'none';

  if (state.connectedItemId) {
    await fetchItemData(state.connectedItemId);
  } else {
    renderCurrentView();
  }
}

// --- Roteamento entre Visões (Abas da Sidebar) ---
function switchView(viewName) {
  state.currentView = viewName;

  // Atualiza classe ativa nos botões da Sidebar
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // Atualiza título do cabeçalho de controle
  const titleEl = document.getElementById('viewHeadingTitle');
  const titles = {
    inicio: 'Início',
    registro: 'Registro Contábil',
    extrato: 'Extrato Bancário',
    cartao: 'Cartão de Crédito & Maquininha (Recebíveis)',
    comprovantes: 'Comprovantes',
    investimentos: 'Investimentos',
    emprestimos: 'Empréstimos e Financiamentos',
    estatisticas: 'Estatísticas (Dashboard)',
    empresa: 'Empresa',
    permissoes: 'Permissões & Gestão de Acesso'
  };
  if (titleEl) titleEl.textContent = titles[viewName] || viewName;

  renderCurrentView();
}

// Renderiza a view selecionada
function renderCurrentView() {
  const container = document.getElementById('viewContainer');
  if (!container) return;

  updateHeaderTxCount();

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
    case 'comprovantes':
      container.innerHTML = renderComprovantesHtml();
      break;
    case 'investimentos':
      container.innerHTML = renderInvestimentosHtml();
      break;
    case 'emprestimos':
      container.innerHTML = renderEmprestimosHtml();
      break;
    case 'estatisticas':
      container.innerHTML = renderEstatisticasDashboardHtml();
      setupJsonInspectorEvents();
      setupVizTooltips();
      break;
    case 'empresa':
      container.innerHTML = renderEmpresaHtml();
      break;
    case 'permissoes':
      container.innerHTML = renderPermissoesHtml();
      break;
    default:
      container.innerHTML = renderComprovantesHtml();
  }
}

function accountName(accountId) {
  const acc = state.activeData?.accounts?.find(a => a.id === accountId);
  return acc ? acc.name : '—';
}

// Atualiza contador de lançamentos no badge central do header
function updateHeaderTxCount() {
  const badge = document.getElementById('headerTxCount');
  if (!badge) return;

  if (!state.activeData) {
    badge.textContent = '0';
    return;
  }

  const allFiltered = getFilteredTransactions();
  const chkCount = getFilteredTransactions('checking').length;
  const cardCount = getFilteredTransactions('card').length;

  if (state.currentView === 'comprovantes') {
    badge.textContent = String(allFiltered.length);
  } else if (state.currentView === 'registro') {
    badge.textContent = `${(allFiltered.length) * 2}/${allFiltered.length}`;
  } else if (state.currentView === 'extrato') {
    badge.textContent = String(chkCount);
  } else if (state.currentView === 'cartao') {
    badge.textContent = String(cardCount);
  } else {
    badge.textContent = String(allFiltered.length);
  }
}

// =========================================================
// VIEW 1: COMPROVANTES (EXATAMENTE FIEL AO PRINT DO USUÁRIO)
// Colunas: Dt Pgto | Cliente/Fornecedor | CPF/CNPJ | Doc | Dt Vcto | Vl Docto | Valor | Juros | Multa | Desconto | Observação
// =========================================================
function renderComprovantesHtml() {
  const txs = getFilteredTransactions();

  let rowsHtml = '';
  if (txs.length === 0) {
    rowsHtml = `
      <tr>
        <td colspan="11" class="mister-empty-state-row">
          <div class="empty-table-box">
            <span class="empty-table-icon">🧾</span>
            <span>Nenhum Comprovante encontrado</span>
            ${!state.connectedItemId ? '<button type="button" class="btn-table-connect" onclick="window.launchPluggyWidget()">🔌 Conectar Conta com Pluggy</button>' : ''}
          </div>
        </td>
      </tr>
    `;
  } else {
    rowsHtml = txs.map(tx => {
      const p = tx.paymentData || {};
      const receiver = p.receiver || {};
      const payer = p.payer || {};
      const party = receiver.name || payer.name || tx.description || '—';
      const docNumber = receiver.documentNumber?.value || payer.documentNumber?.value || '—';
      const boleto = p.boletoMetadata || {};
      const docCode = boleto.digitableLine || p.authenticationCode || String(tx.id).slice(0, 10);
      const dueDate = boleto.dueDate ? formatDate(boleto.dueDate) : '—';
      const money = (v) => (v === null || v === undefined ? '—' : formatMoney(v));
      const payDate = formatDate(tx.date);
      const isDebit = tx.type === 'DEBIT' || Number(tx.amount) < 0;
      const amountFormatted = (isDebit ? '- ' : '+ ') + formatMoney(Math.abs(tx.amount));
      const amountColor = isDebit ? 'color: var(--mister-debit-red);' : 'color: var(--mister-success-green);';

      return `
        <tr>
          <td>${payDate}</td>
          <td><strong>${escapeHtml(party)}</strong></td>
          <td>${escapeHtml(docNumber)}</td>
          <td><code style="font-size: 11px;">${escapeHtml(docCode)}</code></td>
          <td>${dueDate}</td>
          <td>${boleto.baseAmount != null ? formatMoney(boleto.baseAmount) : formatMoney(Math.abs(tx.amount))}</td>
          <td style="${amountColor} font-weight: 600;">${amountFormatted}</td>
          <td>${money(boleto.interestAmount)}</td>
          <td>${money(boleto.penaltyAmount)}</td>
          <td>${money(boleto.discountAmount)}</td>
          <td>${escapeHtml(tx.category || tx.description || '—')}</td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="mister-table-card">
      <table class="mister-table">
        <thead>
          <tr>
            <th><span class="sortable">Dt Pgto ⇅</span></th>
            <th><span class="sortable">Cliente/Fornecedor ⇅</span></th>
            <th><span>CPF/CNPJ</span></th>
            <th><span>Doc</span></th>
            <th><span class="sortable">Dt Vcto ⇅</span></th>
            <th><span class="sortable">Vl Docto ⇅</span></th>
            <th><span class="sortable">Valor ⇅</span></th>
            <th><span>Juros</span></th>
            <th><span>Multa</span></th>
            <th><span>Desconto</span></th>
            <th><span class="sortable">Observação ⇅</span></th>
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
// =========================================================
function renderRegistroContabilHtml() {
  const txs = getFilteredTransactions();

  let rowsHtml = '';
  if (txs.length === 0) {
    rowsHtml = `
      <tr>
        <td colspan="10" class="mister-empty-state-row">
          <div class="empty-table-box">
            <span class="empty-table-icon">📑</span>
            <span>Nenhum Registro Contábil encontrado</span>
            ${!state.connectedItemId ? '<button type="button" class="btn-table-connect" onclick="window.launchPluggyWidget()">🔌 Conectar Conta com Pluggy</button>' : ''}
          </div>
        </td>
      </tr>
    `;
  } else {
    rowsHtml = txs.map((tx, idx) => {
      const isDebit = tx.type === 'DEBIT' || Number(tx.amount) < 0;
      const absAmount = formatMoney(Math.abs(tx.amount));
      const dateStr = formatDate(tx.date);
      const desc = escapeHtml(tx.description || 'Lançamento');

      return `
        <!-- Linha 1: Débito (Branca) -->
        <tr class="debit-line">
          <td>${dateStr}</td>
          <td>${escapeHtml(tx.category || '—')}</td>
          <td>${escapeHtml(accountName(tx.accountId))}</td>
          <td style="color: var(--mister-debit-red); font-weight: 600;">${isDebit ? absAmount : ''}</td>
          <td style="color: var(--mister-blue-btn); font-weight: 600;">${isDebit ? '' : absAmount}</td>
          <td>${desc}</td>
          <td>—</td>
          <td>—</td>
          <td>${escapeHtml(tx.paymentData?.receiver?.name || tx.paymentData?.payer?.name || '—')}</td>
          <td>Pluggy Open Finance</td>
        </tr>
        <!-- Linha 2: Crédito (Amarela #fffde7) -->
        <tr class="credit-line">
          <td></td>
          <td>a definir</td>
          <td>a definir</td>
          <td style="color: #111827; font-weight: 600;">${isDebit ? '' : absAmount}</td>
          <td style="color: #111827; font-weight: 600;">${isDebit ? absAmount : ''}</td>
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
    <div class="mister-table-card">
      <table class="mister-table">
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
  const chkTxs = getFilteredTransactions('checking');

  let rowsHtml = '';
  if (chkTxs.length === 0) {
    rowsHtml = `
      <tr>
        <td colspan="7" class="mister-empty-state-row">
          <div class="empty-table-box">
            <span class="empty-table-icon">🏦</span>
            <span>Nenhum lançamento no extrato bancário encontrado</span>
            ${!state.connectedItemId ? '<button type="button" class="btn-table-connect" onclick="window.launchPluggyWidget()">🔌 Conectar Conta com Pluggy</button>' : ''}
          </div>
        </td>
      </tr>
    `;
  } else {
    rowsHtml = chkTxs.map(tx => {
      const isDebit = tx.type === 'DEBIT' || Number(tx.amount) < 0;
      const desc = String(tx.description || '').toUpperCase();
      const method = tx.paymentData?.paymentMethod || tx.operationType || (desc.includes('PIX') ? 'PIX' : (desc.includes('TED') ? 'TED' : 'OUTROS'));
      const amountColor = isDebit ? 'color: var(--mister-debit-red);' : 'color: var(--mister-success-green);';
      const formatted = (isDebit ? '- ' : '+ ') + formatMoney(Math.abs(tx.amount));
      const party = tx.paymentData?.receiver?.name || tx.paymentData?.payer?.name || '—';

      return `
        <tr>
          <td>${formatDate(tx.date)}</td>
          <td><strong>${escapeHtml(tx.description)}</strong></td>
          <td><span style="background: #f1f5f9; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${escapeHtml(method)}</span></td>
          <td style="${amountColor} font-weight: 600;">${formatted}</td>
          <td>${escapeHtml(tx.category || 'Geral')}</td>
          <td>${escapeHtml(party)}</td>
          <td><code style="font-size: 11px;">${escapeHtml(String(tx.id).slice(0, 10))}</code></td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="mister-table-card">
      <table class="mister-table">
        <thead>
          <tr>
            <th>Data</th>
            <th>Descrição da Movimentação</th>
            <th>Método</th>
            <th>Valor</th>
            <th>Categoria</th>
            <th>Favorecido / Pagador</th>
            <th>ID da Transação</th>
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
// VIEW 4: CARTÃO DE CRÉDITO & RECEBÍVEIS (MAQUININHA)
// =========================================================
function renderCartaoHtml() {
  const cardTxs = getFilteredTransactions('card');

  let rowsHtml = '';
  if (cardTxs.length === 0) {
    rowsHtml = `
      <tr>
        <td colspan="7" class="mister-empty-state-row">
          <div class="empty-table-box">
            <span class="empty-table-icon">💳</span>
            <span>Nenhum lançamento de cartão de crédito ou recebíveis encontrado</span>
            ${!state.connectedItemId ? '<button type="button" class="btn-table-connect" onclick="window.launchPluggyWidget()">🔌 Conectar Conta com Pluggy</button>' : ''}
          </div>
        </td>
      </tr>
    `;
  } else {
    rowsHtml = cardTxs.map(tx => {
      const meta = tx.creditCardMetadata || {};
      const installment = meta.installmentNumber ? `${meta.installmentNumber}/${meta.totalInstallments || 1}` : 'À Vista';
      const isDebit = tx.type === 'DEBIT' || Number(tx.amount) < 0;
      const formatted = (isDebit ? '- ' : '+ ') + formatMoney(Math.abs(tx.amount));
      const typeLabel = isDebit ? 'Compra Cartão' : 'Recebível / Estorno';

      return `
        <tr>
          <td>${formatDate(tx.date)}</td>
          <td><strong>${escapeHtml(tx.description)}</strong></td>
          <td><span style="background: #e8f0fe; color: #002b80; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${typeLabel}</span></td>
          <td><span style="background: #e2e8f0; padding: 1px 6px; border-radius: 4px; font-weight: 600; font-size: 10.5px;">${installment}</span></td>
          <td>${escapeHtml(tx.category || 'Geral')}</td>
          <td style="color: ${isDebit ? 'var(--mister-debit-red)' : 'var(--mister-success-green)'}; font-weight: 600;">${formatted}</td>
          <td><code style="font-size: 11px;">${escapeHtml(String(tx.id).slice(0, 10))}</code></td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="mister-table-card">
      <table class="mister-table">
        <thead>
          <tr>
            <th>Data da Compra</th>
            <th>Descrição / Estabelecimento</th>
            <th>Tipo do Lançamento</th>
            <th>Parcela</th>
            <th>Categoria</th>
            <th>Valor</th>
            <th>ID Transação</th>
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
function renderInvestimentosHtml() {
  const investments = state.activeData?.investments || [];

  let rowsHtml = '';
  if (investments.length === 0) {
    rowsHtml = `
      <tr>
        <td colspan="6" class="mister-empty-state-row">
          <div class="empty-table-box">
            <span class="empty-table-icon">📈</span>
            <span>Nenhum investimento encontrado</span>
            ${!state.connectedItemId ? '<button type="button" class="btn-table-connect" onclick="window.launchPluggyWidget()">🔌 Conectar Conta com Pluggy</button>' : ''}
          </div>
        </td>
      </tr>
    `;
  } else {
    rowsHtml = investments.map(inv => {
      return `
        <tr>
          <td><strong>${escapeHtml(inv.name)}</strong></td>
          <td><span style="background: #e8f0fe; color: #002b80; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${escapeHtml(inv.type)}</span></td>
          <td>${inv.subtype ? escapeHtml(inv.subtype) : '—'}</td>
          <td style="color: var(--mister-success-green); font-weight: 600;">${formatMoney(inv.balance)}</td>
          <td>${inv.rate != null ? `${formatPct(inv.rate)}% ${escapeHtml(inv.rateType || '')}` : (inv.annualRate != null ? `${formatPct(inv.annualRate)}% a.a.` : '—')}</td>
          <td>${formatDate(inv.dueDate)}</td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="mister-table-card">
      <table class="mister-table">
        <thead>
          <tr>
            <th>Nome do Ativo</th>
            <th>Tipo</th>
            <th>Subtipo</th>
            <th>Saldo / Valor</th>
            <th>Rentabilidade</th>
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
// VIEW 6: EMPRÉSTIMOS
// =========================================================
function renderEmprestimosHtml() {
  const loans = state.activeData?.loans || [];

  let rowsHtml = '';
  if (loans.length === 0) {
    rowsHtml = `
      <tr>
        <td colspan="7" class="mister-empty-state-row">
          <div class="empty-table-box">
            <span class="empty-table-icon">🤝</span>
            <span>Nenhum empréstimo ou financiamento encontrado</span>
            ${!state.connectedItemId ? '<button type="button" class="btn-table-connect" onclick="window.launchPluggyWidget()">🔌 Conectar Conta com Pluggy</button>' : ''}
          </div>
        </td>
      </tr>
    `;
  } else {
    rowsHtml = loans.map(raw => {
      const loan = normalizeLoan(raw);
      const money = (v) => (v === null ? '—' : formatMoney(v));
      const rateText = loan.ratePct !== null ? `${formatPct(loan.ratePct)}% ${loan.ratePeriod}` : (loan.cet !== null ? `CET ${formatPct(loan.cet)}% a.a.` : '—');
      const parcels = loan.totalInstallments !== null
        ? `${loan.paidInstallments ?? '?'} pagas de ${loan.totalInstallments}${loan.dueInstallments != null ? ` · ${loan.dueInstallments} a vencer` : ''}`
        : '—';
      return `
        <tr>
          <td><strong>${escapeHtml(String(loan.contract).slice(0, 24))}</strong><br><span style="color: var(--mister-text-muted); font-size: 11px;">${escapeHtml(loan.name)}</span></td>
          <td><span style="background: #fef08a; color: #854d0e; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${escapeHtml(loan.type)}</span></td>
          <td>${money(loan.contractAmount)}</td>
          <td style="color: var(--mister-debit-red); font-weight: 600;">${money(loan.outstanding)}</td>
          <td>${rateText}</td>
          <td>${parcels}</td>
          <td>${formatDate(loan.dueDate)}</td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="mister-table-card">
      <table class="mister-table">
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
// VIEW 7: ESTATÍSTICAS (DASHBOARD ANALÍTICO + JSON INSPECTOR)
// =========================================================
const isDebitTx = (tx) => tx.type === 'DEBIT' || Number(tx.amount) < 0;

function formatCompactMoney(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
}

function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// Barra horizontal (ranking / composição) — um único matiz, ordenada por valor
function renderHBars(items, { color = 'blue' } = {}) {
  if (!items.length) return '<div class="viz-empty">Sem dados no período.</div>';
  const max = Math.max(...items.map(i => i.value), 1);
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return `
    <ul class="viz-hbars">
      ${items.map(i => `
        <li data-tip="${escapeHtml(i.label)}: ${formatMoney(i.value)} (${(i.value / total * 100).toFixed(1).replace('.', ',')}%)">
          <span class="viz-hbar-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span>
          <span class="viz-hbar-track"><span class="viz-hbar-fill viz-${color}" style="width:${Math.max(i.value / max * 100, 1.5)}%"></span></span>
          <span class="viz-hbar-value">${formatMoney(i.value)}</span>
        </li>`).join('')}
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
function renderDailyFlowChart(days) {
  if (!days.length) return '<div class="viz-empty">Sem movimentações de conta corrente no período.</div>';
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
    return `<g data-tip="${escapeHtml(tip)}">${up}${down}<rect x="${L + slot * i}" y="${T}" width="${slot}" height="${plotH}" class="viz-hit"/></g>`;
  }).join('');

  const xIdx = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  const xLabels = xIdx.map(i => {
    const anchor = i === 0 ? 'start' : (i === days.length - 1 ? 'end' : 'middle');
    const x = anchor === 'start' ? L : (anchor === 'end' ? W - R : L + slot * i + slot / 2);
    return `<text x="${x}" y="${H - 8}" text-anchor="${anchor}" class="viz-axis-text">${shortDate(days[i].date)}</text>`;
  }).join('');

  const yTop = maxIn > 0 ? `<line x1="${L}" x2="${W - R}" y1="${T}" y2="${T}" class="viz-grid"/><text x="${L - 8}" y="${T + 4}" text-anchor="end" class="viz-axis-text">${formatCompactMoney(maxIn)}</text>` : '';
  const yBot = maxOut > 0 ? `<line x1="${L}" x2="${W - R}" y1="${T + plotH}" y2="${T + plotH}" class="viz-grid"/><text x="${L - 8}" y="${T + plotH + 4}" text-anchor="end" class="viz-axis-text">-${formatCompactMoney(maxOut)}</text>` : '';

  return `
    <svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="Entradas e saídas por dia na conta corrente">
      ${yTop}${yBot}
      <line x1="${L}" x2="${W - R}" y1="${base}" y2="${base}" class="viz-baseline"/>
      <text x="${L - 8}" y="${base + 4}" text-anchor="end" class="viz-axis-text">0</text>
      ${bars}${xLabels}
    </svg>`;
}

// Evolução do saldo (último saldo informado em cada dia)
function renderBalanceChart(points) {
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
  const hits = points.map((p, i) => (i % step === 0 || i === points.length - 1)
    ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.balance).toFixed(1)}" r="10" class="viz-hit" data-tip="${formatDate(p.date)} · Saldo ${formatMoney(p.balance)}"/>` : '').join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="Evolução do saldo da conta corrente">
      <line x1="${L}" x2="${W - R}" y1="${T}" y2="${T}" class="viz-grid"/>
      <line x1="${L}" x2="${W - R}" y1="${T + plotH}" y2="${T + plotH}" class="viz-grid"/>
      <text x="${L - 8}" y="${T + 4}" text-anchor="end" class="viz-axis-text">${formatCompactMoney(max)}</text>
      <text x="${L - 8}" y="${T + plotH + 4}" text-anchor="end" class="viz-axis-text">${formatCompactMoney(min)}</text>
      <path d="${area}" class="viz-area"/>
      <path d="${line}" class="viz-line"/>
      <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.balance).toFixed(1)}" r="4" class="viz-dot"/>
      <text x="${L}" y="${H - 8}" class="viz-axis-text">${shortDate(points[0].date)}</text>
      <text x="${W - R}" y="${H - 8}" text-anchor="end" class="viz-axis-text">${shortDate(last.date)}</text>
      ${hits}
    </svg>`;
}

// Uso do limite dos cartões (medidor)
function renderLimitMeters(cardStatements) {
  const cards = cardStatements.filter(cs => cs.account?.creditData?.creditLimit);
  if (!cards.length) return '<div class="viz-empty">Limite de crédito não informado pela instituição.</div>';
  return cards.map(cs => {
    const cd = cs.account.creditData;
    const limit = Number(cd.creditLimit) || 0;
    const available = Number(cd.availableCreditLimit) || 0;
    const used = Math.max(limit - available, 0);
    const pct = limit ? Math.min(used / limit * 100, 100) : 0;
    return `
      <div class="viz-meter" data-tip="${escapeHtml(cs.account.name || 'Cartão')}: ${formatMoney(used)} usados de ${formatMoney(limit)}">
        <div class="viz-meter-head">
          <strong>${escapeHtml(cs.account.name || 'Cartão de crédito')}</strong>
          <span>${pct.toFixed(0)}% usado</span>
        </div>
        <div class="viz-hbar-track"><span class="viz-hbar-fill viz-blue" style="width:${pct}%"></span></div>
        <div class="viz-meter-foot"><span>Usado ${formatMoney(used)}</span><span>Disponível ${formatMoney(available)}</span></div>
      </div>`;
  }).join('');
}

// Tabela alternativa (acessibilidade) dos dados do gráfico diário
function renderDailyTable(days) {
  if (!days.length) return '';
  return `
    <details class="viz-table-view">
      <summary>Ver dados do gráfico</summary>
      <table class="mister-table">
        <thead><tr><th>Data</th><th>Entradas</th><th>Saídas</th></tr></thead>
        <tbody>${days.map(d => `<tr><td>${formatDate(d.date)}</td><td>${formatMoney(d.inflow)}</td><td>${formatMoney(d.outflow)}</td></tr>`).join('')}</tbody>
      </table>
    </details>`;
}

function computeDashboardMetrics(data) {
  const chk = data?.checkingTransactions || [];
  const cardTxs = data?.cardStatements?.flatMap(cs => cs.transactions || []) || [];

  const dayMap = new Map();
  let inflow = 0, outflow = 0;
  chk.forEach(tx => {
    const day = String(tx.date).slice(0, 10);
    const abs = Math.abs(Number(tx.amount) || 0);
    const row = dayMap.get(day) || { date: day, inflow: 0, outflow: 0 };
    if (isDebitTx(tx)) { row.outflow += abs; outflow += abs; } else { row.inflow += abs; inflow += abs; }
    dayMap.set(day, row);
  });
  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const catMap = new Map();
  let cardSpend = 0;
  [...chk, ...cardTxs].forEach(tx => {
    if (!isDebitTx(tx)) return;
    const abs = Math.abs(Number(tx.amount) || 0);
    const cat = tx.category || 'Sem categoria';
    catMap.set(cat, (catMap.get(cat) || 0) + abs);
  });
  cardTxs.forEach(tx => { if (isDebitTx(tx)) cardSpend += Math.abs(Number(tx.amount) || 0); });

  // Último saldo informado por dia
  const balByDay = new Map();
  [...chk].filter(tx => tx.balance !== null && tx.balance !== undefined)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.order || 0) - (b.order || 0))
    .forEach(tx => balByDay.set(String(tx.date).slice(0, 10), Number(tx.balance)));
  const balancePoints = [...balByDay.entries()].map(([date, balance]) => ({ date, balance }));

  const invMap = new Map();
  (data?.investments || []).forEach(inv => {
    if (!isActiveInvestment(inv)) return;
    const key = inv.subtype || inv.type || 'Outros';
    invMap.set(key, (invMap.get(key) || 0) + investmentBalance(inv));
  });

  const loanMap = new Map();
  (data?.loans || []).map(normalizeLoan).forEach((l, i) => {
    loanMap.set(l.contract || `Contrato ${i + 1}`, Number(l.outstanding) || 0);
  });

  return { chk, cardTxs, days, inflow, outflow, cardSpend, catMap, balancePoints, invMap, loanMap };
}

// Avisos quando a conexão bancária precisa de ação do usuário
function itemStatusNotice(item) {
  if (!item) return '';
  const messages = {
    LOGIN_ERROR: 'As credenciais do banco não foram aceitas. Reconecte a conta para voltar a sincronizar.',
    OUTDATED: 'A conexão está desatualizada. Reconecte a conta para atualizar os dados.',
    WAITING_USER_INPUT: 'O banco pediu uma confirmação adicional (ex.: código MFA). Abra a conexão e conclua a autorização.',
    WAITING_USER_ACTION: 'O banco pediu uma ação sua no app/site do banco para liberar o acesso.',
    UPDATING: 'A sincronização ainda está em andamento. Atualize em alguns instantes para ver todos os dados.',
    CREATING: 'A conexão está sendo criada. Atualize em alguns instantes para ver os dados.'
  };
  const msg = messages[item.status];
  return msg ? `<div class="stats-notice">⚠️ ${escapeHtml(msg)}</div>` : '';
}

function renderEstatisticasDashboardHtml() {
  const data = state.activeData;
  const m = computeDashboardMetrics(data);

  const availableCreditLimit = (data?.cardStatements || []).reduce((s, cs) => s + (Number(cs.account?.creditData?.availableCreditLimit) || 0), 0);
  const investments = (data?.investments || []).filter(isActiveInvestment);
  const investTotal = investments.reduce((sum, i) => sum + investmentBalance(i), 0);
  const loans = data?.loans || [];
  const loanDebt = loans.map(normalizeLoan).reduce((sum, l) => sum + (Number(l.outstanding) || 0), 0);
  const bankBalance = (data?.accounts || []).filter(a => a.type === 'BANK').reduce((s, a) => s + (Number(a.balance) || 0), 0);
  const connectorName = data?.item?.connector?.name || 'Instituição conectada';
  const net = m.inflow - m.outflow;

  // JSON a exibir no inspector
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
      <div class="stats-kpi-title-row"><span>${title}</span><span>${icon}</span></div>
      <div class="stats-kpi-value" ${color ? `style="color: ${color};"` : ''}>${value}</div>
      <div class="stats-kpi-footer"><span>${footL}</span><span>${footR}</span></div>
    </div>`;

  const period = data?.period?.label || state.currentFilter?.label || '';
  const subtab = (id, label) => `<button type="button" class="json-subtab-btn ${state.jsonSubTab === id ? 'active' : ''}" data-subtab="${id}">${label}</button>`;

  return `
    <div class="stats-dashboard-view">
      <div class="stats-sync-banner">
        <div>
          <strong>Status da Sincronização Open Finance:</strong>
          <span>${data ? `🟢 Dados da Pluggy API · período ${escapeHtml(period)} · atualizado às ${new Date(data.timestamp).toLocaleTimeString('pt-BR')}` : '⚪ Aguardando autenticação da conta bancária'}</span>
        </div>
        <button type="button" class="btn-mister-action" onclick="window.launchPluggyWidget()">
          <span>${data ? 'Sincronizar Novamente' : 'Conectar Agora'}</span>
          <span>🔌</span>
        </button>
      </div>
      ${itemStatusNotice(data?.item)}
      ${data?.periodFallback ? '<div class="stats-notice">⚠️ Nenhum lançamento foi encontrado no período selecionado; exibindo os lançamentos mais recentes disponíveis na Pluggy.</div>' : ''}

      <div class="stats-kpi-grid">
        ${kpi('Saldo em Conta Corrente', '🏦', formatMoney(bankBalance), `${m.chk.length} movimentações`, escapeHtml(connectorName))}
        ${kpi('Entradas no período', '⬆️', formatMoney(m.inflow), 'Resultado do período', `${net >= 0 ? '+' : '-'} ${formatMoney(Math.abs(net))}`, 'var(--mister-blue-btn)')}
        ${kpi('Saídas no período', '⬇️', formatMoney(m.outflow), 'Conta corrente', `${m.days.length} dia(s) com movimento`, 'var(--mister-debit-red)')}
        ${kpi('Fatura Cartão (M-1)', '💳', formatMoney(m.cardSpend), `${m.cardTxs.length} transações`, `Limite disp: ${formatMoney(availableCreditLimit)}`)}
        ${kpi('Patrimônio em Investimentos', '📈', formatMoney(investTotal), `${investments.length} aplicação(ões)`, `${m.invMap.size} tipo(s)`, 'var(--mister-success-green)')}
        ${kpi('Saldo Devedor Empréstimos', '📑', formatMoney(loanDebt), `${loans.length} contrato(s)`, 'Open Finance', 'var(--mister-debit-red)')}
      </div>

      <div class="viz-grid-2">
        <section class="viz-card viz-span-2">
          <header class="viz-card-head">
            <h3>Entradas e saídas por dia</h3>
            <div class="viz-legend">
              <span><i class="viz-swatch viz-blue"></i>Entradas</span>
              <span><i class="viz-swatch viz-red"></i>Saídas</span>
            </div>
          </header>
          ${renderDailyFlowChart(m.days)}
          ${renderDailyTable(m.days)}
        </section>

        <section class="viz-card">
          <header class="viz-card-head"><h3>Gastos por categoria</h3><span class="viz-sub">conta + cartão</span></header>
          ${renderHBars(topWithOthers(m.catMap))}
        </section>

        <section class="viz-card">
          <header class="viz-card-head"><h3>Evolução do saldo</h3><span class="viz-sub">conta corrente</span></header>
          ${renderBalanceChart(m.balancePoints)}
        </section>

        <section class="viz-card">
          <header class="viz-card-head"><h3>Uso do limite do cartão</h3></header>
          ${renderLimitMeters(data?.cardStatements || [])}
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

      <div class="json-inspector-box">
        <div class="json-inspector-header">
          <div class="json-subtabs">
            ${subtab('all', 'Payload Completo')}
            ${subtab('card', 'Cartão')}
            ${subtab('investments', 'Investimentos')}
            ${subtab('loans', 'Empréstimos')}
            ${subtab('checking', 'Extrato')}
            ${subtab('item', 'Item &amp; Empresa')}
          </div>
          <button type="button" class="btn-copy-code" id="btnCopyJson">📋 Copiar JSON</button>
        </div>
        <pre class="json-pre-code" id="jsonPreBlock"><code>${escapeHtml(jsonString)}</code></pre>
      </div>
    </div>
  `;
}

// Tooltip compartilhado para todos os gráficos ([data-tip])
function setupVizTooltips() {
  let tip = document.getElementById('vizTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'vizTip';
    tip.className = 'viz-tip';
    document.body.appendChild(tip);
  }
  const container = document.getElementById('viewContainer');
  if (container.dataset.tipBound) return; // container é persistente: registra os listeners uma única vez
  container.dataset.tipBound = '1';
  container.addEventListener('mousemove', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) { tip.style.display = 'none'; return; }
    tip.textContent = target.dataset.tip;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY + 16}px`;
  });
  container.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

function setupJsonInspectorEvents() {
  document.querySelectorAll('.json-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.jsonSubTab = btn.dataset.subtab;
      renderCurrentView();
    });
  });

  document.getElementById('btnCopyJson')?.addEventListener('click', () => {
    const code = document.getElementById('jsonPreBlock')?.innerText;
    if (code) {
      navigator.clipboard.writeText(code).then(() => {
        alert('JSON copiado para a área de transferência!');
      });
    }
  });
}

// =========================================================
// VIEW 6: EMPRESA
// =========================================================
function renderEmpresaHtml() {
  const item = state.activeData?.item || {};
  const connector = item.connector || {};
  const identity = state.activeData?.identity || null;
  const dash = '<span style="color: var(--mister-text-muted);">Não informado pela instituição</span>';
  const val = (v) => (v ? escapeHtml(v) : dash);
  const address = identity?.addresses?.[0]?.fullAddress;
  const email = identity?.emails?.[0]?.value;
  const phone = identity?.phoneNumbers?.[0]?.value;
  const statusColor = item.status === 'UPDATED' ? 'background: #dcfce7; color: #15803d;' : 'background: #fef3c7; color: #b45309;';

  const card = (title, body) => `
    <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: var(--mister-radius-md); padding: 22px;">
      <h3 style="color: #002b80; font-size: 15px; margin-bottom: 14px; border-bottom: 1px solid var(--mister-border-subtle); padding-bottom: 8px;">${title}</h3>
      ${body}
    </div>`;
  const row = (label, value) => `<p style="margin-bottom: 8px;"><strong>${label}:</strong> ${value}</p>`;

  const companyBody = identity
    ? row('Razão Social', val(identity.companyName || identity.fullName)) +
      row('CNPJ', val(identity.taxNumber || identity.document)) +
      row('Endereço', val(address)) +
      row('E-mail', val(email)) +
      row('Telefone', val(phone))
    : '<p style="color: var(--mister-text-muted);">Conecte uma conta PJ para carregar os dados da empresa (endpoint /identity da Pluggy).</p>';

  const connBody =
    row('Instituição', val(connector.name)) +
    row('Status do Conector', item.status ? `<span style="${statusColor} padding: 2px 8px; border-radius: 10px; font-weight: 600;">${escapeHtml(item.status)}</span>` : 'DESCONECTADO') +
    row('ID da Conexão (Item ID)', `<code>${escapeHtml(item.id || state.connectedItemId || 'Nenhum item conectado')}</code>`) +
    row('Última atualização', item.updatedAt ? formatDate(item.updatedAt) : '—') +
    '<button type="button" class="btn-mister-filter" style="margin-top: 10px;" onclick="window.launchPluggyWidget()">Gerenciar Conexão</button>';

  return `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px;">
      ${card('🏢 Identificação da Empresa Conectada', companyBody)}
      ${card('🔌 Conexão Bancária Open Finance', connBody)}
    </div>
  `;
}

// =========================================================
// VIEW 7: PERMISSÕES
// =========================================================
function renderPermissoesHtml() {
  const isConn = Boolean(state.connectedItemId || state.activeData);

  return `
    <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: var(--mister-radius-md); padding: 24px; max-width: 800px;">
      <h3 style="color: #002b80; font-size: 15px; margin-bottom: 12px;">
        🔒 Gestão de Consentimento & Permissões Open Finance
      </h3>
      <p style="color: var(--mister-text-muted); font-size: 12.5px; margin-bottom: 20px; line-height: 1.5;">
        Em conformidade com a regulação de Open Finance do Banco Central do Brasil, a empresa concede acesso aos dados estritamente para fins de conciliação e escrituração contábil no Mister Contador.
      </p>

      <div style="border: 1px solid var(--mister-border-subtle); border-radius: 8px; padding: 16px; margin-bottom: 20px; background: #f8fafc;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <strong>Consentimento de Dados Bancários:</strong>
          <span style="background: ${isConn ? '#dcfce7' : '#fef3c7'}; color: ${isConn ? '#15803d' : '#b45309'}; padding: 3px 10px; border-radius: 12px; font-weight: 700; font-size: 11px;">
            ${isConn ? 'ATIVO & AUTORIZADO' : 'PENDENTE DE AUTORIZAÇÃO'}
          </span>
        </div>
        <p style="font-size: 12px; color: #475569;">
          <strong>Escopos Autorizados:</strong> Consulta de saldo, extratos de conta corrente, comprovantes de pagamento (paymentData), faturas de cartão de crédito PJ, recebíveis de maquininha, contratos de empréstimo e investimentos.
        </p>
      </div>

      <div style="display: flex; gap: 10px;">
        <button type="button" class="btn-mister-filter" onclick="window.launchPluggyWidget()">
          <span>${isConn ? 'Renovar / Reconectar Permissão' : 'Autorizar Conexão Pluggy'}</span>
        </button>
        ${isConn ? '<button type="button" class="btn-cancel" onclick="window.misterState.activeData=null; window.misterState.connectedItemId=null; localStorage.removeItem(\'pluggy_connected_item_id\'); updateCompanyPills(); switchView(\'inicio\');">Revogar Acesso</button>' : ''}
      </div>
    </div>
  `;
}

// =========================================================
// VIEW 8: INÍCIO
// =========================================================
function renderInicioViewHtml() {
  const isConn = Boolean(state.connectedItemId || state.activeData);

  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div style="background: linear-gradient(135deg, #002b80 0%, #1a56c4 100%); color: #fff; border-radius: var(--mister-radius-md); padding: 28px; box-shadow: var(--mister-shadow-md);">
        <h2 style="font-size: 20px; margin-bottom: 8px;">Bem-vindo ao Mister Contador Open Finance</h2>
        <p style="opacity: 0.9; font-size: 13.5px; max-width: 650px; line-height: 1.5; margin-bottom: 20px;">
          Sincronização bancária direta e conciliação contábil automatizada. Conecte suas contas corporativas via Pluggy para visualizar comprovantes, extratos, faturas de cartão e estatísticas em tempo real.
        </p>
        <button type="button" class="btn-mister-action" style="background: #ffffff; color: #002b80; font-weight: 700; font-size: 13px; padding: 10px 20px;" onclick="window.launchPluggyWidget()">
          <span>${isConn ? 'Reconectar / Atualizar Dados' : '🔌 Conectar Conta com Pluggy'}</span>
        </button>
      </div>

      <!-- Grade de Atalhos das Novas Funcionalidades -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px;">
        <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: 8px; padding: 16px; cursor: pointer;" onclick="switchView('comprovantes')">
          <div style="font-size: 22px; margin-bottom: 6px;">🧾</div>
          <strong style="color: #002b80;">Comprovantes</strong>
          <p style="color: var(--mister-text-muted); font-size: 11.5px; margin-top: 4px;">Detalhamento de pagamentos, boletos e PIX com paymentData.</p>
        </div>

        <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: 8px; padding: 16px; cursor: pointer;" onclick="switchView('registro')">
          <div style="font-size: 22px; margin-bottom: 6px;">📑</div>
          <strong style="color: #002b80;">Registro Contábil</strong>
          <p style="color: var(--mister-text-muted); font-size: 11.5px; margin-top: 4px;">Partidas dobradas automáticas (débito/crédito).</p>
        </div>

        <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: 8px; padding: 16px; cursor: pointer;" onclick="switchView('extrato')">
          <div style="font-size: 22px; margin-bottom: 6px;">🏦</div>
          <strong style="color: #002b80;">Extrato Bancário</strong>
          <p style="color: var(--mister-text-muted); font-size: 11.5px; margin-top: 4px;">Movimentações de conta corrente em tempo real.</p>
        </div>

        <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: 8px; padding: 16px; cursor: pointer;" onclick="switchView('cartao')">
          <div style="font-size: 22px; margin-bottom: 6px;">💳</div>
          <strong style="color: #002b80;">Cartão de Crédito</strong>
          <p style="color: var(--mister-text-muted); font-size: 11.5px; margin-top: 4px;">Faturas M-1 fechado e recebíveis de maquininha.</p>
        </div>

        <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: 8px; padding: 16px; cursor: pointer;" onclick="switchView('investimentos')">
          <div style="font-size: 22px; margin-bottom: 6px;">📈</div>
          <strong style="color: #002b80;">Investimentos</strong>
          <p style="color: var(--mister-text-muted); font-size: 11.5px; margin-top: 4px;">Acompanhamento de saldo e rentabilidade.</p>
        </div>

        <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: 8px; padding: 16px; cursor: pointer;" onclick="switchView('emprestimos')">
          <div style="font-size: 22px; margin-bottom: 6px;">🤝</div>
          <strong style="color: #002b80;">Empréstimos</strong>
          <p style="color: var(--mister-text-muted); font-size: 11.5px; margin-top: 4px;">Contratos e saldo devedor.</p>
        </div>

        <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: 8px; padding: 16px; cursor: pointer;" onclick="switchView('estatisticas')">
          <div style="font-size: 22px; margin-bottom: 6px;">📊</div>
          <strong style="color: #002b80;">Estatísticas</strong>
          <p style="color: var(--mister-text-muted); font-size: 11.5px; margin-top: 4px;">Dashboard executivo, KPIs de limites e JSON Inspector.</p>
        </div>
      </div>
    </div>
  `;
}

// Atualiza o dropdown de contas
function updateAccountsDropdown() {
  const select = document.getElementById('accountSelect');
  if (!select) return;

  if (!state.activeData || !state.activeData.accounts || state.activeData.accounts.length === 0) {
    select.innerHTML = '<option value="all">Todas as Contas</option>';
    return;
  }

  let html = '<option value="all">Todas as Contas</option>';
  state.activeData.accounts.forEach(acc => {
    html += `<option value="${escapeHtml(acc.id)}">${escapeHtml(acc.name)}${acc.number ? ` - ${escapeHtml(acc.number)}` : ''}</option>`;
  });
  select.innerHTML = html;
  
  if (state.currentAccount !== 'all' && state.activeData.accounts.find(a => a.id === state.currentAccount)) {
    select.value = state.currentAccount;
  } else {
    select.value = 'all';
    state.currentAccount = 'all';
  }
}

// Retorna todas as transações consolidadas aplicando filtro de subtipo
function getFilteredTransactions(source = 'all') {
  if (!state.activeData) return [];

  const chkTxs = state.activeData.checkingTransactions || [];
  const cardTxs = state.activeData.cardStatements?.flatMap(c => c.transactions || []) || [];
  let all = source === 'checking' ? [...chkTxs] : (source === 'card' ? [...cardTxs] : [...chkTxs, ...cardTxs]);

  if (state.currentAccount !== 'all') {
    all = all.filter(t => t.accountId === state.currentAccount);
  }

  if (state.subTypeFilter === 'debit') {
    all = all.filter(t => t.type === 'DEBIT' || Number(t.amount) < 0);
  } else if (state.subTypeFilter === 'credit') {
    all = all.filter(t => t.type === 'CREDIT' || Number(t.amount) > 0);
  } else if (state.subTypeFilter === 'pix') {
    all = all.filter(t => (t.description || '').toUpperCase().includes('PIX') || t.paymentData?.paymentMethod === 'PIX');
  } else if (state.subTypeFilter === 'boleto') {
    all = all.filter(t => (t.description || '').toUpperCase().includes('BOLETO') || t.paymentData?.paymentMethod === 'BOLETO');
  }

  return all;
}

// =========================================================
// INTEGRAÇÃO COM O PLUGGY CONNECT WIDGET (DADOS REAIS)
// =========================================================
async function launchPluggyWidget() {
  const overlay = document.getElementById('connectOverlay');
  const loadingState = document.getElementById('modalLoadingState');
  const loadingText = document.getElementById('modalLoadingText');
  const startBtn = document.getElementById('startWidgetBtn');
  const credsBox = document.getElementById('credentialsPrompt');

  overlay.style.display = 'flex';
  loadingState.style.display = 'block';
  startBtn.style.display = 'none';
  if (credsBox) credsBox.style.display = 'none';
  loadingText.textContent = 'Gerando Connect Token seguro...';

  try {
    const clientId = document.getElementById('modalClientId')?.value?.trim();
    const clientSecret = document.getElementById('modalClientSecret')?.value?.trim();

    const payload = { clientUserId: getClientUserId() };
    if (clientId && clientSecret) {
      payload.clientId = clientId;
      payload.clientSecret = clientSecret;
    }

    const tokenRes = await fetch('/api/connect-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json();
      if (!state.config?.hasEnvKeys) {
        loadingState.style.display = 'none';
        startBtn.style.display = 'block';
        if (credsBox) credsBox.style.display = 'block';
        return;
      }
      throw new Error(err.error || 'Falha ao autenticar na Pluggy');
    }

    const data = await tokenRes.json();
    loadingText.textContent = 'Abrindo Pluggy Connect Widget...';

    await ensurePluggyConnect();

    const pluggyConnect = new window.PluggyConnect({
      connectToken: data.accessToken,
      includeSandbox: state.config?.includeSandbox !== false,
      // Empresas (PJ), pessoas físicas (ex.: contabilidade CAEPF/produtor rural) e corretoras
      connectorTypes: ['BUSINESS_BANK', 'PERSONAL_BANK', 'INVESTMENT'],
      onOpen: () => {
        overlay.style.display = 'none';
        loadingState.style.display = 'none';
        startBtn.style.display = 'block';
      },
      onSuccess: async (itemData) => {
        const itemId = itemData.item?.id || itemData.itemId;
        state.connectedItemId = itemId;
        localStorage.setItem('pluggy_connected_item_id', itemId);
        console.log('✅ Item Conectado:', itemId);

        overlay.style.display = 'flex';
        loadingState.style.display = 'block';
        loadingText.textContent = `Sincronizando dados reais do Item ${itemId}...`;

        await fetchItemData(itemId);

        overlay.style.display = 'none';
        loadingState.style.display = 'none';
        startBtn.style.display = 'block';
      },
      onError: (err) => {
        console.error('Erro no widget:', err);
        alert('Erro no widget da Pluggy: ' + (err.message || 'Falha ao conectar'));
        overlay.style.display = 'none';
        loadingState.style.display = 'none';
        startBtn.style.display = 'block';
      },
      onClose: () => {
        overlay.style.display = 'none';
        loadingState.style.display = 'none';
        startBtn.style.display = 'block';
      }
    });

    pluggyConnect.init();
  } catch (err) {
    alert(err.message);
    overlay.style.display = 'none';
    loadingState.style.display = 'none';
    startBtn.style.display = 'block';
  }
}

// Nome e CNPJ da empresa no topo (vindos do /identity da Pluggy)
function updateCompanyPills() {
  const identity = state.activeData?.identity;
  const name = document.getElementById('empresaPillName');
  const cnpj = document.getElementById('cnpjPill');
  if (name) name.textContent = identity?.companyName || identity?.fullName || (state.activeData ? 'Empresa não identificada' : 'Aguardando conexão');
  if (cnpj) cnpj.textContent = (identity?.taxNumber || identity?.document || '—').replace(/\D/g, '') || '—';
}

// Garante o script do widget: cópia local primeiro, CDN da Pluggy como reserva
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`falha ao carregar ${src}`));
    document.head.appendChild(el);
  });
}

async function ensurePluggyConnect() {
  if (typeof window.PluggyConnect === 'function') return;
  const sources = ['/vendor/pluggy-connect-2.11.0.js', 'https://cdn.pluggy.ai/pluggy-connect/v2.11.0/pluggy-connect.js'];
  for (const src of sources) {
    try {
      await loadScript(src);
      if (typeof window.PluggyConnect === 'function') return;
    } catch (err) {
      console.warn(err.message);
    }
  }
  throw new Error('Não foi possível carregar o Pluggy Connect. Desative bloqueadores de anúncios/privacidade para este site (ou libere cdn.pluggy.ai e connect.pluggy.ai) e tente novamente.');
}

// Busca os dados consolidados do Item na API da Pluggy
async function fetchItemData(itemId, { silent = false } = {}) {
  const f = state.currentFilter;
  try {
    const res = await fetch(`/api/item-data?itemId=${encodeURIComponent(itemId)}&from=${f.from}&to=${f.to}&label=${encodeURIComponent(f.label)}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Erro ao carregar dados do item');
    }

    state.activeData = await res.json();
    console.log('📦 DADOS REAIS RETORNADOS DA PLUGGY:', state.activeData);

    // Atualiza status do topo
    const statusDot = document.getElementById('topbarStatusDot');
    const statusText = document.getElementById('topbarStatusText');
    const btnLabel = document.getElementById('btnConnectLabel');

    if (statusDot) statusDot.classList.remove('disconnected');
    if (statusText) statusText.textContent = `${state.activeData.item?.connector?.name || 'Conta conectada'} (Item: ${itemId.slice(0, 8)}...)`;
    updateCompanyPills();
    if (btnLabel) btnLabel.textContent = 'Atualizar';

    updateAccountsDropdown();
    renderCurrentView();
    return true;
  } catch (fetchErr) {
    if (silent) console.warn('Não foi possível restaurar a conexão salva:', fetchErr.message);
    else alert('Erro ao consolidar dados da conta: ' + fetchErr.message);
    return false;
  }
}

// Torna launchPluggyWidget acessível globalmente
window.launchPluggyWidget = launchPluggyWidget;
window.updateCompanyPills = updateCompanyPills;
window.switchView = switchView;

document.addEventListener('DOMContentLoaded', init);
