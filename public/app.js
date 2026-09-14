/**
 * Pluggy Open Finance — Data Explorer Controller
 * Visualização limpa, analítica e categorizada de todos os dados retornados pela API
 */

const state = {
  activeData: null,
  activeTab: 'overview', // 'overview' | 'card' | 'investments' | 'loans' | 'checking' | 'json-inspector'
  jsonSubTab: 'all',
  searchQuery: '',
  config: null,
  connectedItemId: null,
  currentFilter: {
    from: '2026-08-01',
    to: '2026-08-31',
    label: 'Agosto de 2026 (M-1)'
  }
};

// Disponibiliza no escopo global para inspeção no console do navegador (F12)
window.state = state;
window.getPluggyJson = () => state.activeData;

// --- Formatadores ---
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

function getCategoryClass(category = '') {
  const cat = category.toLowerCase();
  if (cat.includes('streaming') || cat.includes('serviço')) return 'category-streaming';
  if (cat.includes('transporte') || cat.includes('mobilidade') || cat.includes('combustível')) return 'category-transport';
  if (cat.includes('alimentação') || cat.includes('refeição') || cat.includes('restaurante')) return 'category-food';
  if (cat.includes('compra') || cat.includes('suprimento') || cat.includes('mercado')) return 'category-shopping';
  if (cat.includes('saúde') || cat.includes('farmácia') || cat.includes('medicamento')) return 'category-health';
  if (cat.includes('salário') || cat.includes('provento')) return 'category-salary';
  if (cat.includes('moradia') || cat.includes('conta') || cat.includes('condomínio')) return 'category-housing';
  return '';
}

// --- Inicialização ---
async function init() {
  setupEventListeners();

  try {
    // 1. Consulta configuração do backend (período padrão M-1)
    const configRes = await fetch('/api/config');
    state.config = await configRes.json();

    if (state.config.period) {
      state.currentFilter = {
        from: state.config.period.from,
        to: state.config.period.to,
        label: `${state.config.period.label} (M-1)`
      };
      updatePeriodUI();
    }

    // 2. Roteamento: /simulado vs /
    const isSimulado = window.location.pathname.startsWith('/simulado');

    if (isSimulado) {
      document.getElementById('connectOverlay').style.display = 'none';
      await loadData();
    } else {
      document.getElementById('connectOverlay').style.display = 'flex';
      if (state.config.hasEnvKeys) {
        document.getElementById('credentialsPrompt').style.display = 'none';
      } else {
        document.getElementById('credentialsPrompt').style.display = 'block';
      }
      await loadData(); // carrega em background para a tela não ficar vazia
    }
  } catch (err) {
    console.error('Erro na inicialização:', err);
    await loadData();
  }
}

// Configura listeners de eventos da interface
function setupEventListeners() {
  // Navegação entre Abas (Tabs)
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });

  // Clique nos Cards de KPI direciona para a respectiva aba
  document.querySelectorAll('.kpi-card').forEach(card => {
    card.addEventListener('click', () => {
      const targetTab = card.dataset.targetTab;
      if (targetTab) switchTab(targetTab);
    });
  });

  // Campo de Busca
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.toLowerCase().trim();
      renderTabContent();
    });
  }

  // Popover de Filtro de Período
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
      let from, to, label;

      if (preset === 'm-1') {
        from = '2026-08-01'; to = '2026-08-31'; label = 'Agosto de 2026 (M-1)';
      } else if (preset === 'current') {
        from = '2026-09-01'; to = '2026-09-30'; label = 'Setembro de 2026 (Mês Atual)';
      } else if (preset === 'm-2') {
        from = '2026-07-01'; to = '2026-07-31'; label = 'Julho de 2026 (M-2)';
      } else if (preset === 'm-3') {
        from = '2026-06-01'; to = '2026-06-30'; label = 'Junho de 2026 (M-3)';
      }

      document.getElementById('filterDateFrom').value = from;
      document.getElementById('filterDateTo').value = to;
      reloadWithFilter(from, to, label);
    });
  });

  // Aplicar Intervalo Customizado
  document.getElementById('applyDateFilterBtn')?.addEventListener('click', () => {
    const from = document.getElementById('filterDateFrom').value;
    const to = document.getElementById('filterDateTo').value;

    if (!from || !to) {
      alert('Informe as datas inicial e final.');
      return;
    }
    if (from > to) {
      alert('A data inicial não pode ser superior à final.');
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
    const from = '2026-08-01';
    const to = '2026-08-31';
    const label = 'Agosto de 2026 (M-1)';
    document.getElementById('filterDateFrom').value = from;
    document.getElementById('filterDateTo').value = to;
    reloadWithFilter(from, to, label);
  });

  // Botão Reabrir Widget Pluggy
  document.getElementById('reopenPluggyBtn')?.addEventListener('click', () => {
    document.getElementById('connectOverlay').style.display = 'flex';
  });

  // Fechar Modal
  document.getElementById('closeOverlayBtn')?.addEventListener('click', () => {
    document.getElementById('connectOverlay').style.display = 'none';
  });

  document.getElementById('btnCancelConnect')?.addEventListener('click', () => {
    document.getElementById('connectOverlay').style.display = 'none';
  });

  // Disparo do Widget
  document.getElementById('startWidgetBtn')?.addEventListener('click', launchPluggyWidget);
}

// Troca de Aba
function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Exibe/oculta a barra de busca dependendo da aba
  const searchWrapper = document.getElementById('searchWrapper');
  if (searchWrapper) {
    searchWrapper.style.display = tabName === 'json-inspector' ? 'none' : 'block';
  }

  renderTabContent();
}

// Atualiza Textos do Período no Header e no Banner
function updatePeriodUI() {
  const f = state.currentFilter;
  const periodBtnText = document.getElementById('periodBtnText');
  const bannerPeriodLabel = document.getElementById('bannerPeriodLabel');
  const bannerPeriodRange = document.getElementById('bannerPeriodRange');

  if (periodBtnText) periodBtnText.textContent = f.label;
  if (bannerPeriodLabel) bannerPeriodLabel.textContent = f.label;
  if (bannerPeriodRange) bannerPeriodRange.textContent = `${formatDate(f.from)} até ${formatDate(f.to)}`;
}

// Recarrega os dados com as datas filtradas
async function reloadWithFilter(from, to, label) {
  state.currentFilter = { from, to, label };
  updatePeriodUI();
  document.getElementById('dateFilterPopover').style.display = 'none';
  await loadData();
}

// Carrega os dados da API (Item real ou dados simulados)
async function loadData() {
  const f = state.currentFilter;
  try {
    let url = state.connectedItemId
      ? `/api/item-data?itemId=${state.connectedItemId}&from=${f.from}&to=${f.to}&label=${encodeURIComponent(f.label)}`
      : `/api/mock-data?from=${f.from}&to=${f.to}&label=${encodeURIComponent(f.label)}`;

    const res = await fetch(url);
    state.activeData = await res.json();

    console.log('📦 DADOS ATUALIZADOS:', state.activeData);
    renderDashboard();
  } catch (err) {
    console.error('Erro ao carregar dados:', err);
  }
}

// Inicia o Pluggy Connect Widget
async function launchPluggyWidget() {
  const loadingState = document.getElementById('modalLoadingState');
  const loadingText = document.getElementById('modalLoadingText');
  const startBtn = document.getElementById('startWidgetBtn');

  loadingState.style.display = 'block';
  startBtn.style.display = 'none';
  loadingText.textContent = 'Gerando Connect Token seguro...';

  try {
    const clientId = document.getElementById('modalClientId')?.value?.trim();
    const clientSecret = document.getElementById('modalClientSecret')?.value?.trim();

    const payload = {};
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
      throw new Error(err.error || 'Falha ao autenticar na Pluggy');
    }

    const data = await tokenRes.json();
    loadingText.textContent = 'Carregando widget Pluggy Connect...';

    if (typeof window.PluggyConnect === 'undefined') {
      throw new Error('Script do Pluggy Connect não carregado.');
    }

    const pluggyConnect = new window.PluggyConnect({
      connectToken: data.accessToken,
      includeSandbox: true,
      onOpen: () => {
        document.getElementById('connectOverlay').style.display = 'none';
      },
      onSuccess: async (itemData) => {
        const itemId = itemData.item?.id || itemData.itemId;
        state.connectedItemId = itemId;
        console.log('✅ Item Pluggy Conectado:', itemId);

        document.getElementById('connectOverlay').style.display = 'flex';
        loadingState.style.display = 'block';
        loadingText.textContent = `Sincronizando dados do Item ${itemId} via Pluggy API...`;

        const f = state.currentFilter;
        try {
          const itemRes = await fetch(`/api/item-data?itemId=${itemId}&from=${f.from}&to=${f.to}&label=${encodeURIComponent(f.label)}`);
          state.activeData = await itemRes.json();
          console.log('📦 JSON COMPLETO DA CONEXÃO REAL:', state.activeData);

          document.getElementById('connectOverlay').style.display = 'none';
          loadingState.style.display = 'none';
          startBtn.style.display = 'block';
          renderDashboard();
        } catch (fetchErr) {
          alert('Erro ao consolidar dados do Item: ' + fetchErr.message);
        }
      },
      onError: (err) => {
        console.error('Erro no widget:', err);
        alert('Erro no widget da Pluggy: ' + (err.message || 'Falha ao conectar'));
        loadingState.style.display = 'none';
        startBtn.style.display = 'block';
      },
      onClose: () => {
        loadingState.style.display = 'none';
        startBtn.style.display = 'block';
      }
    });

    pluggyConnect.init();
  } catch (err) {
    alert(err.message);
    loadingState.style.display = 'none';
    startBtn.style.display = 'block';
  }
}

// --- Renderização do Dashboard ---
function renderDashboard() {
  if (!state.activeData) return;

  renderHeaderCard();
  renderKPIs();
  renderTabBadges();
  renderTabContent();
}

// Atualiza Card de Conector no Header
function renderHeaderCard() {
  const item = state.activeData.item || {};
  const connector = item.connector || {};

  const nameEl = document.getElementById('connectorName');
  const idEl = document.getElementById('connectorItemId');
  const syncText = document.getElementById('lastSyncText');

  if (nameEl) nameEl.textContent = connector.name || 'Pluggy Bank (Sandbox)';
  if (idEl) idEl.textContent = `Item: ${item.id || 'mock-item'}`;
  if (syncText && state.activeData.timestamp) {
    const d = new Date(state.activeData.timestamp);
    syncText.textContent = `Atualizado às ${d.toLocaleTimeString('pt-BR')}`;
  }
}

// Renderiza KPIs
function renderKPIs() {
  const data = state.activeData;

  // 1. Cartão de Crédito
  const cardStmt = data.cardStatements?.[0] || {};
  const cardTxs = cardStmt.transactions || [];
  const cardAccount = cardStmt.account || data.accounts?.find(a => a.type === 'CREDIT') || {};
  const creditData = cardAccount.creditData || {};

  const totalCardSpend = cardTxs.reduce((sum, tx) => {
    return (tx.type === 'DEBIT' || Number(tx.amount) < 0) ? sum + Math.abs(Number(tx.amount)) : sum;
  }, 0);

  document.getElementById('kpiCardSpend').textContent = formatMoney(totalCardSpend);
  document.getElementById('kpiCardTxCount').textContent = `${cardTxs.length} transações`;
  document.getElementById('kpiCardLimitAvailable').textContent = formatMoney(creditData.availableCreditLimit || 22519.10);
  document.getElementById('kpiCardLimitTotal').textContent = `de ${formatMoney(creditData.creditLimit || 25000)}`;

  // 2. Investimentos
  const investments = data.investments || [];
  const totalInvest = investments.reduce((sum, inv) => sum + (Number(inv.balance || inv.value) || 0), 0);

  document.getElementById('kpiInvestTotal').textContent = formatMoney(totalInvest);
  document.getElementById('kpiInvestCount').textContent = `${investments.length} aplicações`;

  // 3. Empréstimos
  const loans = data.loans || [];
  const totalLoanDebt = loans.reduce((sum, l) => sum + (Number(l.outstandingBalance) || 0), 0);
  const nextInstallment = loans[0]?.installmentAmount || 1620.50;
  const loanRate = loans[0]?.interestRate ? `${loans[0].interestRate}% a.m.` : '1.89% a.m.';

  document.getElementById('kpiLoanOutstanding').textContent = formatMoney(totalLoanDebt);
  document.getElementById('kpiLoanInstallment').textContent = formatMoney(nextInstallment);
  document.getElementById('kpiLoanRate').textContent = loanRate;

  // 4. Conta Corrente
  const checkingAcc = data.accounts?.find(a => a.type === 'BANK') || {};
  const chkTxs = data.checkingTransactions || [];

  document.getElementById('kpiBankBalance').textContent = formatMoney(checkingAcc.balance || 21544.60);
  document.getElementById('kpiBankTxCount').textContent = `${chkTxs.length} movim.`;
  document.getElementById('kpiBankTransferNumber').textContent = checkingAcc.bankData?.transferNumber
    ? `Ag/Conta: ${checkingAcc.bankData.transferNumber}`
    : 'Conta Corrente Sandbox';
}

// Atualiza contadores nas abas
function renderTabBadges() {
  const data = state.activeData;
  const cardCount = data.cardStatements?.[0]?.transactions?.length || 0;
  const investCount = data.investments?.length || 0;
  const loanCount = data.loans?.length || 0;
  const checkingCount = data.checkingTransactions?.length || 0;

  document.getElementById('tabCardBadge').textContent = cardCount;
  document.getElementById('tabInvestBadge').textContent = investCount;
  document.getElementById('tabLoanBadge').textContent = loanCount;
  document.getElementById('tabCheckingBadge').textContent = checkingCount;
}

// --- Renderização de Abas de Conteúdo ---
function renderTabContent() {
  const container = document.getElementById('tabContentArea');
  if (!container) return;

  switch (state.activeTab) {
    case 'overview':
      container.innerHTML = renderOverviewHtml();
      break;
    case 'card':
      container.innerHTML = renderCardTabHtml();
      break;
    case 'investments':
      container.innerHTML = renderInvestmentsTabHtml();
      break;
    case 'loans':
      container.innerHTML = renderLoansTabHtml();
      break;
    case 'checking':
      container.innerHTML = renderCheckingTabHtml();
      break;
    case 'json-inspector':
      container.innerHTML = renderJsonInspectorHtml();
      setupJsonInspectorListeners();
      break;
    default:
      container.innerHTML = renderOverviewHtml();
  }

  // Registra botões de visualização rápida do JSON individual
  document.querySelectorAll('.btn-json-inspect').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const entity = btn.dataset.entity;
      const id = btn.dataset.id;
      inspectEntityJson(entity, id);
    });
  });
}

// --- ABA 1: VISÃO GERAL (TODOS OS DADOS) ---
function renderOverviewHtml() {
  const data = state.activeData;
  const cardStmt = data.cardStatements?.[0] || {};
  const cardTxs = (cardStmt.transactions || []).slice(0, 5);
  const investments = (data.investments || []).slice(0, 3);
  const loans = data.loans || [];
  const chkTxs = (data.checkingTransactions || []).slice(0, 4);

  return `
    <div class="overview-sections">
      <!-- Seção 1: Cartão de Crédito Destaque -->
      <div class="content-card">
        <div class="content-card-header">
          <h3 class="content-card-title">💳 Extrato de Cartão de Crédito (Período Fechado M-1)</h3>
          <button type="button" class="btn-control" onclick="window.state.activeTab='card'; renderDashboard();">Ver todas (${cardStmt.transactions?.length || 0}) →</button>
        </div>
        ${renderCardTransactionsTable(cardTxs)}
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 20px; margin-bottom: 20px;">
        <!-- Seção 2: Investimentos Destaque -->
        <div class="content-card" style="margin-bottom: 0;">
          <div class="content-card-header">
            <h3 class="content-card-title">📈 Posições em Investimentos</h3>
            <button type="button" class="btn-control" onclick="window.state.activeTab='investments'; renderDashboard();">Ver carteira (${data.investments?.length || 0}) →</button>
          </div>
          ${renderInvestmentsGrid(investments)}
        </div>

        <!-- Seção 3: Empréstimos Destaque -->
        <div class="content-card" style="margin-bottom: 0;">
          <div class="content-card-header">
            <h3 class="content-card-title">📑 Contratos de Empréstimo (Open Finance)</h3>
            <button type="button" class="btn-control" onclick="window.state.activeTab='loans'; renderDashboard();">Ver detalhes →</button>
          </div>
          ${renderLoansGrid(loans)}
        </div>
      </div>

      <!-- Seção 4: Conta Corrente Destaque -->
      <div class="content-card">
        <div class="content-card-header">
          <h3 class="content-card-title">🏦 Movimentações Recentes em Conta Corrente</h3>
          <button type="button" class="btn-control" onclick="window.state.activeTab='checking'; renderDashboard();">Ver extrato completo →</button>
        </div>
        ${renderCheckingTransactionsTable(chkTxs)}
      </div>
    </div>
  `;
}

// --- ABA 2: CARTÃO DE CRÉDITO ---
function renderCardTabHtml() {
  const data = state.activeData;
  const cardStmt = data.cardStatements?.[0] || {};
  const cardAccount = cardStmt.account || data.accounts?.find(a => a.type === 'CREDIT') || {};
  const creditData = cardAccount.creditData || {};
  let txs = cardStmt.transactions || [];

  if (state.searchQuery) {
    const q = state.searchQuery;
    txs = txs.filter(t =>
      (t.description || '').toLowerCase().includes(q) ||
      (t.category || '').toLowerCase().includes(q) ||
      (String(t.amount)).includes(q)
    );
  }

  const limitTotal = creditData.creditLimit || 25000;
  const limitAvailable = creditData.availableCreditLimit || 22519.10;
  const limitUsed = limitTotal - limitAvailable;
  const limitPercent = Math.min(100, Math.round((limitUsed / limitTotal) * 100));

  return `
    <div class="card-tab-content">
      <!-- Card Metadados do Cartão -->
      <div class="card-meta-box">
        <div class="card-meta-item">
          <span class="card-meta-label">Bandeira / Nível</span>
          <span class="card-meta-value">💳 ${creditData.brand || 'MASTERCARD'} ${creditData.level || 'BLACK'}</span>
        </div>
        <div class="card-meta-item">
          <span class="card-meta-label">Limite Total</span>
          <span class="card-meta-value">${formatMoney(limitTotal)}</span>
        </div>
        <div class="card-meta-item">
          <span class="card-meta-label">Limite Disponível</span>
          <span class="card-meta-value text-success">${formatMoney(limitAvailable)}</span>
        </div>
        <div class="card-meta-item">
          <span class="card-meta-label">Vencimento da Fatura</span>
          <span class="card-meta-value">${formatDate(creditData.balanceDueDate || '2026-08-10')}</span>
        </div>
        <div class="card-meta-item">
          <span class="card-meta-label">Fechamento da Fatura</span>
          <span class="card-meta-value">${formatDate(creditData.balanceCloseDate || '2026-08-31')}</span>
        </div>
      </div>

      <!-- Tabela de Transações -->
      <div class="content-card">
        <div class="content-card-header">
          <h3 class="content-card-title">
            Extrato de Compras e Faturas
            <span class="content-card-badge">${txs.length} itens encontrados</span>
          </h3>
        </div>
        ${renderCardTransactionsTable(txs)}
      </div>
    </div>
  `;
}

function renderCardTransactionsTable(txs) {
  if (!txs || txs.length === 0) {
    return `<div style="text-align: center; padding: 40px; color: #94a3b8;">Nenhuma transação encontrada para este filtro.</div>`;
  }

  const rows = txs.map(tx => {
    const isDebit = (Number(tx.amount) || 0) < 0 || tx.type === 'DEBIT';
    const amountClass = isDebit ? 'amount-debit' : 'amount-credit';
    const amountFormatted = (isDebit ? '- ' : '+ ') + formatMoney(Math.abs(tx.amount));
    const catClass = getCategoryClass(tx.category || '');

    let installmentInfo = '';
    if (tx.creditCardMetadata?.totalInstallments && tx.creditCardMetadata.totalInstallments > 1) {
      installmentInfo = `<span class="installment-tag">${tx.creditCardMetadata.installmentNumber || 1}/${tx.creditCardMetadata.totalInstallments}</span>`;
    }

    return `
      <tr>
        <td style="white-space: nowrap; font-weight: 500;">${formatDate(tx.date)}</td>
        <td>
          <span style="font-weight: 600; color: #0f172a;">${tx.description || tx.descriptionRaw || 'Compra no Cartão'}</span>
          ${installmentInfo}
        </td>
        <td>
          <span class="category-pill ${catClass}">
            🏷️ ${tx.category || 'Geral'}
          </span>
        </td>
        <td>
          <span style="font-size: 11px; font-weight: 600; color: ${isDebit ? '#dc2626' : '#16a34a'};">
            ${tx.type || (isDebit ? 'DEBIT' : 'CREDIT')}
          </span>
        </td>
        <td style="text-align: right;" class="${amountClass}">
          ${amountFormatted}
        </td>
        <td style="text-align: center; width: 60px;">
          <button type="button" class="btn-json-inspect" data-entity="cardTx" data-id="${tx.id}" title="Ver JSON puro">{ }</button>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="modern-table-wrapper">
      <table class="modern-table">
        <thead>
          <tr>
            <th>Data</th>
            <th>Estabelecimento / Descrição</th>
            <th>Categoria</th>
            <th>Tipo</th>
            <th style="text-align: right;">Valor</th>
            <th style="text-align: center;">JSON</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

// --- ABA 3: INVESTIMENTOS & APLICAÇÕES ---
function renderInvestmentsTabHtml() {
  let investments = state.activeData.investments || [];

  if (state.searchQuery) {
    const q = state.searchQuery;
    investments = investments.filter(inv =>
      (inv.name || '').toLowerCase().includes(q) ||
      (inv.type || '').toLowerCase().includes(q) ||
      (inv.subtype || '').toLowerCase().includes(q) ||
      (inv.institution || '').toLowerCase().includes(q)
    );
  }

  return `
    <div class="investments-tab-content">
      <div class="content-card">
        <div class="content-card-header">
          <h3 class="content-card-title">
            Carteira de Aplicações e Renda Fixa
            <span class="content-card-badge">${investments.length} ativos</span>
          </h3>
        </div>
        ${renderInvestmentsGrid(investments)}
      </div>
    </div>
  `;
}

function renderInvestmentsGrid(investments) {
  if (!investments || investments.length === 0) {
    return `<div style="text-align: center; padding: 40px; color: #94a3b8;">Nenhum investimento registrado.</div>`;
  }

  const cards = investments.map(inv => {
    const balance = Number(inv.balance || inv.value) || 0;
    const rateText = inv.rateType ? `${inv.annualRate || 100}% ${inv.rateType}` : (inv.rate ? `${inv.rate}% a.a.` : 'CDI');

    return `
      <div class="invest-card">
        <div>
          <div class="invest-top">
            <span class="invest-type-badge">${inv.subtype || inv.type || 'INVESTIMENTO'}</span>
            <button type="button" class="btn-json-inspect" data-entity="investment" data-id="${inv.id}" title="Ver JSON do ativo">{ }</button>
          </div>
          <h4 class="invest-name">${inv.name || 'Aplicação Financeira'}</h4>
          <div class="invest-institution">
            🏛️ ${inv.institution || 'Pluggy Invest'}
          </div>
          <div class="invest-specs-row">
            <div class="spec-item">
              <span class="spec-label">Indexador / Taxa</span>
              <span class="spec-val" style="color: #2563eb;">${rateText}</span>
            </div>
            <div class="spec-item">
              <span class="spec-label">Vencimento</span>
              <span class="spec-val">${formatDate(inv.dueDate || 'Liquidez Diária')}</span>
            </div>
          </div>
        </div>
        <div class="invest-bottom">
          <span class="invest-balance-label">Saldo Atual Bruto</span>
          <span class="invest-balance-val">${formatMoney(balance)}</span>
        </div>
      </div>
    `;
  }).join('');

  return `<div class="investments-grid">${cards}</div>`;
}

// --- ABA 4: EMPRÉSTIMOS & FINANCIAMENTOS (OPEN FINANCE) ---
function renderLoansTabHtml() {
  const loans = state.activeData.loans || [];

  return `
    <div class="loans-tab-content">
      <div class="content-card">
        <div class="content-card-header">
          <h3 class="content-card-title">
            Contratos de Empréstimo e Linhas de Crédito PJ (Open Finance)
            <span class="content-card-badge">${loans.length} contratos</span>
          </h3>
        </div>
        ${renderLoansGrid(loans)}
      </div>
    </div>
  `;
}

function renderLoansGrid(loans) {
  if (!loans || loans.length === 0) {
    return `<div style="text-align: center; padding: 40px; color: #94a3b8;">Nenhum empréstimo ativo registrado via Open Finance.</div>`;
  }

  const cards = loans.map(loan => {
    const totalInstallments = loan.installmentsTotal || 24;
    const paidInstallments = loan.installmentsPaid || 13;
    const remainingInstallments = loan.installmentsRemaining || (totalInstallments - paidInstallments);
    const percentPaid = Math.min(100, Math.round((paidInstallments / totalInstallments) * 100));

    return `
      <div class="loan-card">
        <div class="loan-header">
          <div>
            <h4 class="loan-title">📑 Contrato: ${loan.contractNumber || loan.id}</h4>
            <span style="font-size: 11px; color: #64748b;">${loan.type || 'Capital de Giro / Crédito PJ'} • Pluggy Bank</span>
          </div>
          <button type="button" class="btn-json-inspect" data-entity="loan" data-id="${loan.id}" title="Ver JSON do contrato">{ }</button>
        </div>

        <div class="loan-stats-grid">
          <div class="loan-stat">
            <span class="loan-stat-label">Saldo Devedor Atual</span>
            <span class="loan-stat-val text-danger">${formatMoney(loan.outstandingBalance || 14500)}</span>
          </div>
          <div class="loan-stat">
            <span class="loan-stat-label">Valor Original Contratado</span>
            <span class="loan-stat-val">${formatMoney(loan.contractAmount || 30000)}</span>
          </div>
          <div class="loan-stat">
            <span class="loan-stat-label">Valor da Parcela</span>
            <span class="loan-stat-val">${formatMoney(loan.installmentAmount || 1620.50)}</span>
          </div>
          <div class="loan-stat">
            <span class="loan-stat-label">Taxa de Juros Mensal (CET)</span>
            <span class="loan-stat-val" style="color: #d97706;">${loan.interestRate || 1.89}% a.m.</span>
          </div>
        </div>

        <div class="loan-progress-box">
          <div class="loan-progress-label-row">
            <span><strong>Progresso de Quitação:</strong> ${paidInstallments} de ${totalInstallments} parcelas pagas</span>
            <span style="font-weight: 600; color: #2563eb;">${percentPaid}%</span>
          </div>
          <div class="progress-bar-wrapper">
            <div class="progress-bar-fill" style="width: ${percentPaid}%;"></div>
          </div>
          <div style="font-size: 10.5px; color: #64748b; margin-top: 6px; display: flex; justify-content: space-between;">
            <span>Restam ${remainingInstallments} parcelas</span>
            <span>Próximo vencimento: ${formatDate(loan.dueDate || '2026-10-15')}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `<div class="loans-grid">${cards}</div>`;
}

// --- ABA 5: CONTA CORRENTE & EXTRATO ---
function renderCheckingTabHtml() {
  const data = state.activeData;
  const checkingAcc = data.accounts?.find(a => a.type === 'BANK') || {};
  let chkTxs = data.checkingTransactions || [];

  if (state.searchQuery) {
    const q = state.searchQuery;
    chkTxs = chkTxs.filter(t =>
      (t.description || '').toLowerCase().includes(q) ||
      (t.category || '').toLowerCase().includes(q) ||
      (t.paymentData?.receiver?.name || '').toLowerCase().includes(q) ||
      (String(t.amount)).includes(q)
    );
  }

  return `
    <div class="checking-tab-content">
      <div class="card-meta-box">
        <div class="card-meta-item">
          <span class="card-meta-label">Instituição / Conta</span>
          <span class="card-meta-value">🏦 ${checkingAcc.name || 'Conta Corrente Sandbox'}</span>
        </div>
        <div class="card-meta-item">
          <span class="card-meta-label">Agência e Conta</span>
          <span class="card-meta-value">${checkingAcc.bankData?.transferNumber || '123/0001/12345-0'}</span>
        </div>
        <div class="card-meta-item">
          <span class="card-meta-label">Saldo Disponível</span>
          <span class="card-meta-value text-success">${formatMoney(checkingAcc.balance || 21544.60)}</span>
        </div>
      </div>

      <div class="content-card">
        <div class="content-card-header">
          <h3 class="content-card-title">
            Extrato de Movimentações Bancárias
            <span class="content-card-badge">${chkTxs.length} transações</span>
          </h3>
        </div>
        ${renderCheckingTransactionsTable(chkTxs)}
      </div>
    </div>
  `;
}

function renderCheckingTransactionsTable(txs) {
  if (!txs || txs.length === 0) {
    return `<div style="text-align: center; padding: 40px; color: #94a3b8;">Nenhuma movimentação de conta corrente registrada.</div>`;
  }

  const rows = txs.map(tx => {
    const isDebit = (Number(tx.amount) || 0) < 0 || tx.type === 'DEBIT';
    const amountClass = isDebit ? 'amount-debit' : 'amount-credit';
    const amountFormatted = (isDebit ? '- ' : '+ ') + formatMoney(Math.abs(tx.amount));
    const catClass = getCategoryClass(tx.category || '');
    const counterparty = tx.paymentData?.receiver?.name || tx.paymentData?.payer?.name || '—';
    const method = tx.paymentData?.paymentMethod || (isDebit ? 'DÉBITO' : 'CRÉDITO');

    return `
      <tr>
        <td style="white-space: nowrap; font-weight: 500;">${formatDate(tx.date)}</td>
        <td>
          <span style="font-weight: 600; color: #0f172a;">${tx.description || tx.descriptionRaw || 'Transação C/C'}</span>
        </td>
        <td>
          <span class="category-pill ${catClass}">
            🏷️ ${tx.category || 'Geral'}
          </span>
        </td>
        <td>
          <span style="font-size: 11px; color: #475569; font-weight: 500;">
            ${counterparty}
          </span>
        </td>
        <td>
          <span style="font-size: 10.5px; font-weight: 600; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">
            ${method}
          </span>
        </td>
        <td style="text-align: right;" class="${amountClass}">
          ${amountFormatted}
        </td>
        <td style="text-align: center; width: 60px;">
          <button type="button" class="btn-json-inspect" data-entity="chkTx" data-id="${tx.id}" title="Ver JSON puro">{ }</button>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="modern-table-wrapper">
      <table class="modern-table">
        <thead>
          <tr>
            <th>Data</th>
            <th>Descrição</th>
            <th>Categoria</th>
            <th>Contraparte (Pagador / Favorecido)</th>
            <th>Método</th>
            <th style="text-align: right;">Valor</th>
            <th style="text-align: center;">JSON</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

// --- ABA 6: JSON INSPECTOR INTEGRADO ---
function renderJsonInspectorHtml() {
  const data = state.activeData || {};
  let targetData = data;
  const sub = state.jsonSubTab || 'all';

  if (sub === 'card') targetData = data.cardStatements || [];
  else if (sub === 'investments') targetData = data.investments || [];
  else if (sub === 'loans') targetData = data.loans || [];
  else if (sub === 'checking') targetData = data.checkingTransactions || [];
  else if (sub === 'accounts') targetData = data.accounts || [];
  else if (sub === 'item') targetData = data.item || {};

  const jsonString = JSON.stringify(targetData, null, 2);

  return `
    <div class="json-viewer-container">
      <div class="json-viewer-header">
        <div class="json-tabs">
          <button type="button" class="json-tab-btn ${sub === 'all' ? 'active' : ''}" data-subtab="all">Todos os Dados</button>
          <button type="button" class="json-tab-btn ${sub === 'card' ? 'active' : ''}" data-subtab="card">Cartão de Crédito</button>
          <button type="button" class="json-tab-btn ${sub === 'investments' ? 'active' : ''}" data-subtab="investments">Investimentos</button>
          <button type="button" class="json-tab-btn ${sub === 'loans' ? 'active' : ''}" data-subtab="loans">Empréstimos</button>
          <button type="button" class="json-tab-btn ${sub === 'checking' ? 'active' : ''}" data-subtab="checking">Conta Corrente</button>
          <button type="button" class="json-tab-btn ${sub === 'item' ? 'active' : ''}" data-subtab="item">Item / Conector</button>
        </div>
        <div style="display: flex; gap: 8px;">
          <a href="/api/last-data" target="_blank" class="btn-copy-json" style="text-decoration: none;">Abrir em Nova Aba ↗</a>
          <button type="button" class="btn-copy-json" id="btnCopyJson">📋 Copiar JSON</button>
        </div>
      </div>
      <pre class="json-code-block" id="jsonCodeBlock"><code>${escapeHtml(jsonString)}</code></pre>
    </div>
  `;
}

function setupJsonInspectorListeners() {
  document.querySelectorAll('.json-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.jsonSubTab = btn.dataset.subtab;
      renderTabContent();
    });
  });

  const copyBtn = document.getElementById('btnCopyJson');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const code = document.getElementById('jsonCodeBlock')?.innerText;
      if (code) {
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.textContent = '✅ Copiado!';
          setTimeout(() => { copyBtn.textContent = '📋 Copiar JSON'; }, 2000);
        });
      }
    });
  }
}

// Inspeciona o JSON de uma entidade específica
function inspectEntityJson(entity, id) {
  const data = state.activeData;
  let target = null;

  if (entity === 'cardTx') {
    target = data.cardStatements?.[0]?.transactions?.find(t => t.id === id);
  } else if (entity === 'investment') {
    target = data.investments?.find(i => i.id === id);
  } else if (entity === 'loan') {
    target = data.loans?.find(l => l.id === id);
  } else if (entity === 'chkTx') {
    target = data.checkingTransactions?.find(t => t.id === id);
  }

  if (target) {
    state.activeTab = 'json-inspector';
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === 'json-inspector');
    });

    const container = document.getElementById('tabContentArea');
    const jsonString = JSON.stringify(target, null, 2);

    container.innerHTML = `
      <div class="json-viewer-container">
        <div class="json-viewer-header">
          <div style="font-weight: 600; font-size: 13px;">
            📄 Inspecionando Entidade: ${entity} (ID: ${id})
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn-copy-json" onclick="window.state.activeTab='overview'; renderDashboard();">← Voltar</button>
            <button type="button" class="btn-copy-json" id="btnCopySingleJson">📋 Copiar JSON</button>
          </div>
        </div>
        <pre class="json-code-block"><code>${escapeHtml(jsonString)}</code></pre>
      </div>
    `;

    document.getElementById('btnCopySingleJson')?.addEventListener('click', () => {
      navigator.clipboard.writeText(jsonString).then(() => {
        alert('JSON copiado para a área de transferência!');
      });
    });
  }
}

function escapeHtml(string) {
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', init);
