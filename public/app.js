/**
 * Mister Contador — Open Finance Pluggy Integration Controller
 * Visualização e gestão completa com suporte às novas funcionalidades:
 * Início, Registro Contábil, Extrato, Cartão de Crédito, Comprovantes, Estatísticas, Empresa e Permissões.
 * DADOS REAIS VIA PLUGGY API (SEM MOCKS AUTOMÁTICOS).
 */

const state = {
  currentView: 'comprovantes', // 'inicio' | 'registro' | 'extrato' | 'cartao' | 'comprovantes' | 'estatisticas' | 'empresa' | 'permissoes'
  activeData: null,            // Nulo até que haja conexão real com o widget
  connectedItemId: null,
  config: null,
  subTypeFilter: 'all',
  jsonSubTab: 'all',
  currentFilter: {
    from: '2026-08-01',
    to: '2026-08-31',
    label: 'agosto de 2026'
  },
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
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- Inicialização da Aplicação ---
async function init() {
  setupEventListeners();

  try {
    const configRes = await fetch('/api/config');
    state.config = await configRes.json();

    if (state.config.period) {
      state.currentFilter = {
        from: state.config.period.from,
        to: state.config.period.to,
        label: state.config.period.label.toLowerCase()
      };
      updatePeriodUI();
    }
  } catch (err) {
    console.warn('Configuração de período offline, utilizando padrão M-1:', err);
  }

  // Restaura sessão conectada caso o usuário já tenha conectado via widget
  const savedItemId = localStorage.getItem('pluggy_connected_item_id');
  if (savedItemId) {
    state.connectedItemId = savedItemId;
    await fetchItemData(savedItemId);
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
      let from, to, label;

      if (preset === 'm-1') {
        from = '2026-08-01'; to = '2026-08-31'; label = 'agosto de 2026';
      } else if (preset === 'current') {
        from = '2026-09-01'; to = '2026-09-30'; label = 'setembro de 2026';
      } else if (preset === 'm-2') {
        from = '2026-07-01'; to = '2026-07-31'; label = 'julho de 2026';
      } else if (preset === 'm-3') {
        from = '2026-06-01'; to = '2026-06-30'; label = 'junho de 2026';
      }

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
    reloadWithFilter('2026-08-01', '2026-08-31', 'agosto de 2026');
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

// Atualiza contador de lançamentos no badge central do header
function updateHeaderTxCount() {
  const badge = document.getElementById('headerTxCount');
  if (!badge) return;

  if (!state.activeData) {
    badge.textContent = '0';
    return;
  }

  const allFiltered = getFilteredTransactions();
  const chkCount = allFiltered.filter(t => state.activeData?.checkingTransactions?.some(ct => ct.id === t.id)).length;
  const cardCount = allFiltered.filter(t => state.activeData?.cardStatements?.some(cs => cs.transactions?.some(ct => ct.id === t.id))).length;

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
      const docCode = p.boletoMetadata?.digitableLine || tx.id.slice(0, 10);
      const dueDate = formatDate(p.boletoMetadata?.dueDate || tx.date);
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
          <td>${formatMoney(Math.abs(tx.amount))}</td>
          <td style="${amountColor} font-weight: 600;">${amountFormatted}</td>
          <td>R$ 0,00</td>
          <td>R$ 0,00</td>
          <td>R$ 0,00</td>
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
          <td>1.1.1.01.0.00001</td>
          <td>📘 5</td>
          <td style="color: var(--mister-debit-red); font-weight: 600;">${absAmount}</td>
          <td></td>
          <td><a href="#detalhe" style="color: #0052cc; text-decoration: none;">${desc}</a></td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>Extrato Pluggy Open Finance</td>
        </tr>
        <!-- Linha 2: Crédito (Amarela #fffde7) -->
        <tr class="credit-line">
          <td></td>
          <td></td>
          <td>📘 5</td>
          <td></td>
          <td style="color: #111827; font-weight: 600;">${absAmount}</td>
          <td>Contrapartida Contábil: ${desc}</td>
          <td>✏️ Anexo</td>
          <td>📎 NF</td>
          <td>—</td>
          <td>Partida Dobrada #${idx + 1}</td>
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
  const allFiltered = getFilteredTransactions();
  // Filtrar apenas as transações que têm conta do tipo BANK, que geralmente são de checkingTransactions
  // Mas como a Pluggy pode não trazer category, nós podemos checar se veio de checkingTransactions
  // Ou mais simples: checar se a transação está no array de checkingTransactions original.
  const chkTxs = allFiltered.filter(t => state.activeData?.checkingTransactions?.some(ct => ct.id === t.id));

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
      const method = tx.paymentData?.paymentMethod || (tx.description?.includes('PIX') ? 'PIX' : (tx.description?.includes('TED') ? 'TED' : 'OUTROS'));
      const amountColor = isDebit ? 'color: var(--mister-debit-red);' : 'color: var(--mister-success-green);';
      const formatted = (isDebit ? '- ' : '+ ') + formatMoney(Math.abs(tx.amount));
      const party = tx.paymentData?.receiver?.name || tx.paymentData?.payer?.name || '—';

      return `
        <tr>
          <td>${formatDate(tx.date)}</td>
          <td><strong>${escapeHtml(tx.description)}</strong></td>
          <td><span style="background: #f1f5f9; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${method}</span></td>
          <td style="${amountColor} font-weight: 600;">${formatted}</td>
          <td>${escapeHtml(tx.category || 'Geral')}</td>
          <td>${escapeHtml(party)}</td>
          <td><code style="font-size: 11px;">${tx.id.slice(0, 10)}</code></td>
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
  const allFiltered = getFilteredTransactions();
  // Filtrar apenas as transações de cartão de crédito originais
  const cardTxs = allFiltered.filter(t => state.activeData?.cardStatements?.some(cs => cs.transactions?.some(ct => ct.id === t.id)));

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
          <td style="color: var(--mister-debit-red); font-weight: 600;">${formatted}</td>
          <td><code style="font-size: 11px;">${tx.id.slice(0, 10)}</code></td>
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
          <td style="color: var(--mister-success-green); font-weight: 600;">${formatMoney(inv.balance || inv.value)}</td>
          <td>${inv.annualRate ? `${inv.annualRate}% ${inv.rateType || ''}` : '—'}</td>
          <td>${formatDate(inv.dueDate) || '—'}</td>
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
    rowsHtml = loans.map(loan => {
      return `
        <tr>
          <td><strong>${escapeHtml(loan.contractNumber || loan.id.slice(0,10))}</strong></td>
          <td><span style="background: #fef08a; color: #854d0e; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 11px;">${escapeHtml(loan.type)}</span></td>
          <td>${formatMoney(loan.contractAmount)}</td>
          <td style="color: var(--mister-debit-red); font-weight: 600;">${formatMoney(loan.outstandingBalance)}</td>
          <td>${loan.interestRate ? `${loan.interestRate}% ${loan.interestRateType || ''}` : '—'}</td>
          <td>${loan.installmentsRemaining || 0} de ${loan.installmentsTotal || 0} restantes</td>
          <td>${formatDate(loan.dueDate) || '—'}</td>
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
function renderEstatisticasDashboardHtml() {
  const data = state.activeData;

  // Se não houver dados, exibe os KPIs zerados e mensagem no JSON Inspector
  const cardTxs = data?.cardStatements?.flatMap(cs => cs.transactions || []) || [];
  
  // Aggregate total available credit limit and spend across all cards
  let availableCreditLimit = 0;
  let cardSpend = 0;

  if (data?.cardStatements) {
    data.cardStatements.forEach(cs => {
      availableCreditLimit += (cs.account?.creditData?.availableCreditLimit || 0);
      cs.transactions?.forEach(tx => {
        if (tx.type === 'DEBIT' || Number(tx.amount) < 0) {
          cardSpend += Math.abs(Number(tx.amount));
        }
      });
    });
  }

  const investments = data?.investments || [];
  const investTotal = investments.reduce((sum, i) => sum + (Number(i.balance || i.value) || 0), 0);

  const loans = data?.loans || [];
  const loanDebt = loans.reduce((sum, l) => sum + (Number(l.outstandingBalance) || 0), 0);

  const checkingAcc = data?.accounts?.find(a => a.type === 'BANK') || {};
  const bankBalance = checkingAcc.balance || 0;

  // JSON a exibir no inspector
  let displayJson = data;
  if (data) {
    if (state.jsonSubTab === 'card') displayJson = data.cardStatements || [];
    else if (state.jsonSubTab === 'investments') displayJson = data.investments || [];
    else if (state.jsonSubTab === 'loans') displayJson = data.loans || [];
    else if (state.jsonSubTab === 'checking') displayJson = data.checkingTransactions || [];
    else if (state.jsonSubTab === 'item') displayJson = data.item || {};
  } else {
    displayJson = {
      status: 'AGUARDANDO_CONEXAO',
      mensagem: 'Conecte sua conta via Pluggy Connect Widget para inspecionar os dados reais da API.'
    };
  }

  const jsonString = JSON.stringify(displayJson, null, 2);

  return `
    <div class="stats-dashboard-view">
      <!-- Banner de Status da Sincronização -->
      <div class="stats-sync-banner">
        <div>
          <strong>Status da Sincronização Open Finance:</strong>
          <span>${data ? '🟢 Dados consolidados em tempo real via Pluggy API' : '⚪ Aguardando autenticação da conta bancária'}</span>
        </div>
        <button type="button" class="btn-mister-action" onclick="window.launchPluggyWidget()">
          <span>${data ? 'Sincronizar Novamente' : 'Conectar Agora'}</span>
          <span>🔌</span>
        </button>
      </div>

      <!-- 4 Cards de Métricas Principais (KPIs) -->
      <div class="stats-kpi-grid">
        <!-- KPI 1: Cartão de Crédito -->
        <div class="stats-kpi-card">
          <div class="stats-kpi-title-row">
            <span>Fatura Cartão (M-1)</span>
            <span>💳</span>
          </div>
          <div class="stats-kpi-value">${formatMoney(cardSpend)}</div>
          <div class="stats-kpi-footer">
            <span>${cardTxs.length} transações</span>
            <span>Limite disp: ${formatMoney(availableCreditLimit)}</span>
          </div>
        </div>

        <!-- KPI 2: Investimentos -->
        <div class="stats-kpi-card">
          <div class="stats-kpi-title-row">
            <span>Patrimônio em Investimentos</span>
            <span>📈</span>
          </div>
          <div class="stats-kpi-value" style="color: var(--mister-success-green);">${formatMoney(investTotal)}</div>
          <div class="stats-kpi-footer">
            <span>${investments.length} aplicações ativas</span>
            <span>100% CDI / SELIC</span>
          </div>
        </div>

        <!-- KPI 3: Empréstimos -->
        <div class="stats-kpi-card">
          <div class="stats-kpi-title-row">
            <span>Saldo Devedor Empréstimos</span>
            <span>📑</span>
          </div>
          <div class="stats-kpi-value" style="color: var(--mister-debit-red);">${formatMoney(loanDebt)}</div>
          <div class="stats-kpi-footer">
            <span>${loans.length} contrato(s)</span>
            <span>Taxa CET Open Finance</span>
          </div>
        </div>

        <!-- KPI 4: Conta Corrente -->
        <div class="stats-kpi-card">
          <div class="stats-kpi-title-row">
            <span>Saldo em Conta Corrente</span>
            <span>🏦</span>
          </div>
          <div class="stats-kpi-value">${formatMoney(bankBalance)}</div>
          <div class="stats-kpi-footer">
            <span>${data?.checkingTransactions?.length || 0} movimentações</span>
            <span>Pluggy Bank PJ</span>
          </div>
        </div>
      </div>

      <!-- JSON Inspector Integrado -->
      <div class="json-inspector-box">
        <div class="json-inspector-header">
          <div class="json-subtabs">
            <button type="button" class="json-subtab-btn ${state.jsonSubTab === 'all' ? 'active' : ''}" data-subtab="all">Payload Completo</button>
            <button type="button" class="json-subtab-btn ${state.jsonSubTab === 'card' ? 'active' : ''}" data-subtab="card">Cartão</button>
            <button type="button" class="json-subtab-btn ${state.jsonSubTab === 'investments' ? 'active' : ''}" data-subtab="investments">Investimentos</button>
            <button type="button" class="json-subtab-btn ${state.jsonSubTab === 'loans' ? 'active' : ''}" data-subtab="loans">Empréstimos</button>
            <button type="button" class="json-subtab-btn ${state.jsonSubTab === 'checking' ? 'active' : ''}" data-subtab="checking">Extrato</button>
            <button type="button" class="json-subtab-btn ${state.jsonSubTab === 'item' ? 'active' : ''}" data-subtab="item">Item & Conector</button>
          </div>
          <button type="button" class="btn-copy-code" id="btnCopyJson">📋 Copiar JSON</button>
        </div>
        <pre class="json-pre-code" id="jsonPreBlock"><code>${escapeHtml(jsonString)}</code></pre>
      </div>
    </div>
  `;
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

  return `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px;">
      <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: var(--mister-radius-md); padding: 22px;">
        <h3 style="color: #002b80; font-size: 15px; margin-bottom: 14px; border-bottom: 1px solid var(--mister-border-subtle); padding-bottom: 8px;">
          🏢 Identificação da Empresa Conectada
        </h3>
        <p style="margin-bottom: 8px;"><strong>Razão Social:</strong> EMPRESA TESTE MISTER CONTADOR LTDA</p>
        <p style="margin-bottom: 8px;"><strong>Nome Fantasia:</strong> EMPRESA TESTE</p>
        <p style="margin-bottom: 8px;"><strong>CNPJ:</strong> 00.000.000/0001-91</p>
        <p style="margin-bottom: 8px;"><strong>Segmento:</strong> Comércio Varejista / Mercado</p>
        <p style="margin-bottom: 8px;"><strong>Regime Tributário:</strong> Simples Nacional</p>
      </div>

      <div style="background: #fff; border: 1px solid var(--mister-border); border-radius: var(--mister-radius-md); padding: 22px;">
        <h3 style="color: #002b80; font-size: 15px; margin-bottom: 14px; border-bottom: 1px solid var(--mister-border-subtle); padding-bottom: 8px;">
          🔌 Conexão Bancária Open Finance
        </h3>
        <p style="margin-bottom: 8px;"><strong>Instituição:</strong> ${connector.name || 'Pluggy Bank (Sandbox)'}</p>
        <p style="margin-bottom: 8px;"><strong>Status do Conector:</strong> <span style="background: #dcfce7; color: #15803d; padding: 2px 8px; border-radius: 10px; font-weight: 600;">${item.status || (state.connectedItemId ? 'UPDATED' : 'DESCONECTADO')}</span></p>
        <p style="margin-bottom: 8px;"><strong>ID da Conexão (Item ID):</strong> <code>${item.id || state.connectedItemId || 'Nenhum item conectado'}</code></p>
        <p style="margin-bottom: 8px;"><strong>Ambiente:</strong> Sandbox Pluggy Open Finance</p>
        <button type="button" class="btn-mister-filter" style="margin-top: 10px;" onclick="window.launchPluggyWidget()">Gerenciar Conexão</button>
      </div>
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
        ${isConn ? '<button type="button" class="btn-cancel" onclick="window.misterState.activeData=null; window.misterState.connectedItemId=null; localStorage.removeItem(\'pluggy_connected_item_id\'); switchView(\'inicio\');">Revogar Acesso</button>' : ''}
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
    html += `<option value="${acc.id}">${acc.name} - ${acc.number || ''}</option>`;
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
function getFilteredTransactions() {
  if (!state.activeData) return [];

  const chkTxs = state.activeData.checkingTransactions || [];
  const cardTxs = state.activeData.cardStatements?.flatMap(c => c.transactions || []) || [];
  let all = [...chkTxs, ...cardTxs];

  if (state.currentAccount !== 'all') {
    all = all.filter(t => t.accountId === state.currentAccount);
  }

  if (state.subTypeFilter === 'debit') {
    all = all.filter(t => t.type === 'DEBIT' || Number(t.amount) < 0);
  } else if (state.subTypeFilter === 'credit') {
    all = all.filter(t => t.type === 'CREDIT' || Number(t.amount) > 0);
  } else if (state.subTypeFilter === 'pix') {
    all = all.filter(t => (t.description || '').toUpperCase().includes('PIX'));
  } else if (state.subTypeFilter === 'boleto') {
    all = all.filter(t => (t.description || '').toUpperCase().includes('BOLETO'));
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

    if (typeof window.PluggyConnect === 'undefined') {
      throw new Error('Script do Pluggy Connect não carregado. Verifique sua conexão com a internet.');
    }

    const pluggyConnect = new window.PluggyConnect({
      connectToken: data.accessToken,
      includeSandbox: true,
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

// Busca os dados consolidados do Item na API da Pluggy
async function fetchItemData(itemId) {
  const f = state.currentFilter;
  try {
    const res = await fetch(`/api/item-data?itemId=${itemId}&from=${f.from}&to=${f.to}&label=${encodeURIComponent(f.label)}`);
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
    if (statusText) statusText.textContent = `Pluggy Bank (Item: ${itemId.slice(0, 8)}...)`;
    if (btnLabel) btnLabel.textContent = 'Atualizar';

    updateAccountsDropdown();
    renderCurrentView();
  } catch (fetchErr) {
    alert('Erro ao consolidar dados da conta: ' + fetchErr.message);
  }
}

// Torna launchPluggyWidget acessível globalmente
window.launchPluggyWidget = launchPluggyWidget;
window.switchView = switchView;

document.addEventListener('DOMContentLoaded', init);
