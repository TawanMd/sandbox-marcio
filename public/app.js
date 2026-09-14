/**
 * Controller Mister Contador / Conta Azul — Registro Contábil
 * Integração Pluggy Sandbox (Extrato Cartão M-1, Aplicações e Empréstimos)
 */

const state = {
  activeData: null,
  currentScenario: 'card', // 'card' | 'investments' | 'loans' | 'checking'
  config: null,
  connectedItemId: null,
  currentFilter: {
    from: '2026-08-01',
    to: '2026-08-31',
    label: 'agosto de 2026'
  }
};

// Disponibiliza o state globalmente para visualização imediata no console do navegador
window.state = state;
window.getPluggyJson = () => state.activeData;

// Formatação BRL (R$ 0.000,00)
function formatMoney(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return 'R$ 0,00';
  const abs = Math.abs(Number(amount));
  return 'R$ ' + abs.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Formatação de data (DD/MM/YYYY)
function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const [y, m, d] = dateStr.split('T')[0].split('-');
    return `${d}/${m}/${y}`;
  } catch {
    return dateStr;
  }
}

// Inicialização
async function init() {
  setupEventListeners();

  try {
    // 1. Carrega configuração do backend (período M-1)
    const configRes = await fetch('/api/config');
    state.config = await configRes.json();

    if (state.config.period) {
      state.currentFilter = {
        from: state.config.period.from,
        to: state.config.period.to,
        label: state.config.period.label.toLowerCase()
      };
      document.getElementById('periodText').textContent = state.currentFilter.label;
    }

    // 2. Roteamento: /simulado vs /
    const isSimulado = window.location.pathname.startsWith('/simulado');

    if (isSimulado) {
      // Rota Simulada: Fecha overlay e carrega os dados simulados no padrão Mister
      document.getElementById('connectOverlay').style.display = 'none';
      await loadMockData();
    } else {
      // Rota Raiz (/): Exibe o modal para disparar o Widget da Pluggy
      document.getElementById('connectOverlay').style.display = 'flex';

      // Se já houver chaves no .env, inicia automaticamente o widget
      if (state.config.hasEnvKeys) {
        document.getElementById('credentialsPrompt').style.display = 'none';
      } else {
        document.getElementById('credentialsPrompt').style.display = 'block';
      }
    }
  } catch (err) {
    console.error('Erro na inicialização:', err);
    // Fallback para dados de visualização
    await loadMockData();
  }
}

function setupEventListeners() {
  // Seletor de Conta (Cartão M-1, Aplicações, Empréstimos, C/C)
  const accountSelector = document.getElementById('misterAccountSelector');
  accountSelector.addEventListener('change', (e) => {
    state.currentScenario = e.target.value;
    renderTable();
  });

  // Botão de Reabertura do Pluggy Sandbox no toolbar
  document.getElementById('reopenPluggyBtn').addEventListener('click', () => {
    document.getElementById('connectOverlay').style.display = 'flex';
  });

  // Fechar overlay
  document.getElementById('closeOverlayBtn').addEventListener('click', () => {
    document.getElementById('connectOverlay').style.display = 'none';
    if (!state.activeData) {
      loadMockData();
    }
  });

  // Disparo do Widget pelo Modal
  document.getElementById('startWidgetBtn').addEventListener('click', launchPluggyWidget);

  // --- Controle do Popover de Filtro de Datas ---
  const periodBox = document.getElementById('periodDisplayBox');
  const filterBtn = document.querySelector('.btn-filter');
  const popover = document.getElementById('dateFilterPopover');
  const closePopoverBtn = document.getElementById('closeDatePopoverBtn');

  function togglePopover(e) {
    e.stopPropagation();
    const isVisible = popover.style.display === 'block';
    popover.style.display = isVisible ? 'none' : 'block';
  }

  periodBox.addEventListener('click', togglePopover);
  filterBtn.addEventListener('click', togglePopover);
  closePopoverBtn.addEventListener('click', () => { popover.style.display = 'none'; });

  // Fecha o popover ao clicar fora
  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && !periodBox.contains(e.target) && !filterBtn.contains(e.target)) {
      popover.style.display = 'none';
    }
  });

  // Atalhos de Período (Presets)
  const presetButtons = document.querySelectorAll('.preset-btn');
  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      presetButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const preset = btn.dataset.preset;
      let from, to, label;

      if (preset === 'm-1') {
        // M-1 Fechado (Padrão: Agosto de 2026)
        from = '2026-08-01';
        to = '2026-08-31';
        label = 'agosto de 2026';
      } else if (preset === 'current') {
        // Mês Atual (Setembro de 2026 - Em Aberto)
        from = '2026-09-01';
        to = '2026-09-30';
        label = 'setembro de 2026 (atual)';
      } else if (preset === 'm-2') {
        // M-2 (Julho de 2026)
        from = '2026-07-01';
        to = '2026-07-31';
        label = 'julho de 2026';
      } else if (preset === 'm-3') {
        // M-3 (Junho de 2026)
        from = '2026-06-01';
        to = '2026-06-30';
        label = 'junho de 2026';
      }

      document.getElementById('filterDateFrom').value = from;
      document.getElementById('filterDateTo').value = to;
      reloadFilteredData(from, to, label);
    });
  });

  // Aplicar Intervalo Personalizado
  document.getElementById('applyDateFilterBtn').addEventListener('click', () => {
    const from = document.getElementById('filterDateFrom').value;
    const to = document.getElementById('filterDateTo').value;

    if (!from || !to) {
      alert('Por favor, informe as datas inicial e final.');
      return;
    }

    if (from > to) {
      alert('A data inicial não pode ser maior que a data final.');
      return;
    }

    presetButtons.forEach(b => b.classList.remove('active'));
    const label = `${formatDate(from)} a ${formatDate(to)}`;
    reloadFilteredData(from, to, label);
  });

  // Restaurar M-1 (Mês Fechado Padrão)
  document.getElementById('resetDateFilterBtn').addEventListener('click', () => {
    presetButtons.forEach(b => b.classList.remove('active'));
    document.querySelector('.preset-btn[data-preset="m-1"]')?.classList.add('active');
    const from = '2026-08-01';
    const to = '2026-08-31';
    const label = 'agosto de 2026';
    document.getElementById('filterDateFrom').value = from;
    document.getElementById('filterDateTo').value = to;
    reloadFilteredData(from, to, label);
  });
}

// Recarrega os dados com as datas filtradas
async function reloadFilteredData(from, to, label) {
  state.currentFilter = { from, to, label };
  document.getElementById('periodText').textContent = label;
  document.getElementById('dateFilterPopover').style.display = 'none';

  if (state.connectedItemId) {
    // Consulta item real conectado na Pluggy com o novo período
    try {
      const res = await fetch(`/api/item-data?itemId=${state.connectedItemId}&from=${from}&to=${to}&label=${encodeURIComponent(label)}`);
      state.activeData = await res.json();
      renderTable();
    } catch (err) {
      console.error('Erro ao recarregar dados filtrados da Pluggy:', err);
    }
  } else {
    // Consulta mock data com o novo período
    try {
      const res = await fetch(`/api/mock-data?from=${from}&to=${to}&label=${encodeURIComponent(label)}`);
      state.activeData = await res.json();
      renderTable();
    } catch (err) {
      console.error('Erro ao recarregar dados mock filtrados:', err);
    }
  }
}

// Carregamento de dados simulados (para /simulado)
async function loadMockData() {
  try {
    const f = state.currentFilter;
    const res = await fetch(`/api/mock-data?from=${f.from}&to=${f.to}&label=${encodeURIComponent(f.label)}`);
    state.activeData = await res.json();
    renderTable();
  } catch (err) {
    console.error('Erro ao buscar dados simulados:', err);
  }
}

// Disparo e controle do Pluggy Connect Widget
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
    if (clientId) payload.clientId = clientId;
    if (clientSecret) payload.clientSecret = clientSecret;

    const res = await fetch('/api/connect-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Falha ao autenticar na Pluggy');
    }

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
        console.log('✅ Item Pluggy conectado:', itemId);
        document.getElementById('connectOverlay').style.display = 'flex';
        loadingState.style.display = 'block';
        loadingText.textContent = `Consultando Item ${itemId} na Pluggy com período selecionado...`;

        try {
          const f = state.currentFilter;
          const itemRes = await fetch(`/api/item-data?itemId=${itemId}&from=${f.from}&to=${f.to}&label=${encodeURIComponent(f.label)}`);
          state.activeData = await itemRes.json();
          console.log('📦 JSON COMPLETO RETORNADO DA API DA PLUGGY:', state.activeData);
          console.log('💡 Dica: Você também pode abrir http://localhost:3000/api/last-data para ver este JSON formatado.');
          document.getElementById('connectOverlay').style.display = 'none';
          renderTable();
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
        if (!state.activeData) {
          loadMockData();
        }
      }
    });

    pluggyConnect.init();
  } catch (err) {
    alert(err.message);
    loadingState.style.display = 'none';
    startBtn.style.display = 'block';
  }
}

// Renderização da Tabela Excel-like (Partidas Dobradas)
function renderTable() {
  const tbody = document.getElementById('misterTableBody');
  tbody.innerHTML = '';

  if (!state.activeData) return;

  const scenario = state.currentScenario;
  let rowsHtml = '';
  let totalEntries = 0;

  if (scenario === 'card') {
    // 💳 CENÁRIO 1: Extrato de Cartão no período M-1
    const cardStmts = state.activeData.cardStatements || [];
    const txs = cardStmts[0]?.transactions || [];
    totalEntries = txs.length;

    txs.forEach((tx) => {
      const isDebit = (Number(tx.amount) || 0) < 0 || tx.type === 'DEBIT';
      const amountFormatted = formatMoney(tx.amount);
      const classification = tx.classification || '1.1.1.01.0.00001';
      const accountNum = tx.accountCode || '5';
      const desc = tx.description || 'Lançamento Cartão';

      // Linha 1 (Débito - Fundo Branco)
      rowsHtml += `
        <tr class="row-debit">
          <td>${formatDate(tx.date)}</td>
          <td>${classification}</td>
          <td><span class="ledger-icon-badge">📘 ${accountNum}</span></td>
          <td class="col-debit-val">${amountFormatted}</td>
          <td></td>
          <td><a class="history-link" title="${desc}">${desc}</a></td>
          <td></td>
          <td style="text-align: center;"></td>
          <td>${tx.paymentData?.receiver?.name || tx.category || '/'}</td>
          <td style="text-align: center;"></td>
        </tr>
      `;

      // Linha 2 (Crédito - Fundo Amarelo/Creme #fffde7)
      rowsHtml += `
        <tr class="row-credit row-pair-separator">
          <td></td>
          <td><span class="contrapartida-text">2.1.2.01.0.00002</span></td>
          <td><span class="ledger-icon-badge">📘 ${accountNum}</span></td>
          <td></td>
          <td class="col-credit-val">${amountFormatted}</td>
          <td><a class="history-link contrapartida-text" title="${desc}">${desc}</a></td>
          <td></td>
          <td style="text-align: center;"><span class="action-icon" title="Editar NF">✏️</span></td>
          <td class="slash-empty">/</td>
          <td style="text-align: center;"><span class="action-icon" title="Anexos e Documentos">📎</span></td>
        </tr>
      `;
    });
  } else if (scenario === 'investments') {
    // 📈 CENÁRIO 2: Conta de Aplicação (Investimentos)
    const investments = state.activeData.investments || [];
    totalEntries = investments.length;

    investments.forEach((inv) => {
      const val = Number(inv.balance || inv.value) || 0;
      const formatted = formatMoney(val);
      const desc = inv.name || 'Aplicação Financeira';

      rowsHtml += `
        <tr class="row-debit">
          <td>${formatDate(inv.dueDate || state.currentFilter?.from || '2026-08-01')}</td>
          <td>1.1.3.01.0.00001</td>
          <td><span class="ledger-icon-badge">📘 12</span></td>
          <td class="col-debit-val">${formatted}</td>
          <td></td>
          <td><a class="history-link" title="${desc}">${desc}</a></td>
          <td></td>
          <td style="text-align: center;"></td>
          <td>${inv.institution || '/'}</td>
          <td style="text-align: center;"></td>
        </tr>
        <tr class="row-credit row-pair-separator">
          <td></td>
          <td><span class="contrapartida-text">1.1.1.01.0.00001</span></td>
          <td><span class="ledger-icon-badge">📘 5</span></td>
          <td></td>
          <td class="col-credit-val">${formatted}</td>
          <td><a class="history-link contrapartida-text" title="${desc}">${desc} (${inv.subtype || inv.type || 'INVESTIMENTO'})</a></td>
          <td></td>
          <td style="text-align: center;"><span class="action-icon">✏️</span></td>
          <td class="slash-empty">/</td>
          <td style="text-align: center;"><span class="action-icon">📎</span></td>
        </tr>
      `;
    });
  } else if (scenario === 'loans') {
    // 📑 CENÁRIO 3: Conta de Empréstimo
    const loans = state.activeData.loans || [];
    totalEntries = loans.length;

    loans.forEach((loan) => {
      const debt = Number(loan.outstandingBalance) || 0;
      const installment = Number(loan.installmentAmount) || (debt / (loan.installmentsRemaining || 12));
      const formattedInstallment = formatMoney(installment);
      const desc = `CONTRATO: ${loan.contractNumber || loan.id}`;

      rowsHtml += `
        <tr class="row-debit">
          <td>${formatDate(loan.dueDate || state.currentFilter?.from || '2026-08-05')}</td>
          <td>2.1.2.01.0.00010</td>
          <td><span class="ledger-icon-badge">📘 18</span></td>
          <td class="col-debit-val">${formattedInstallment}</td>
          <td></td>
          <td><a class="history-link" title="${desc}">${desc}</a></td>
          <td></td>
          <td style="text-align: center;"></td>
          <td>PLUGGY BANK</td>
          <td style="text-align: center;"></td>
        </tr>
        <tr class="row-credit row-pair-separator">
          <td></td>
          <td><span class="contrapartida-text">1.1.1.01.0.00001</span></td>
          <td><span class="ledger-icon-badge">📘 5</span></td>
          <td></td>
          <td class="col-credit-val">${formattedInstallment}</td>
          <td><a class="history-link contrapartida-text">${desc} (PARCELA ${loan.installmentsPaid || 1}/${loan.installmentsTotal || 24})</a></td>
          <td></td>
          <td style="text-align: center;"><span class="action-icon">✏️</span></td>
          <td class="slash-empty">/</td>
          <td style="text-align: center;"><span class="action-icon">📎</span></td>
        </tr>
      `;
    });
  } else {
    // 🏦 Conta Corrente Pluggy Bank
    const chkTxs = state.activeData.checkingTransactions || [];
    totalEntries = chkTxs.length;

    if (totalEntries === 0) {
      const acc = state.activeData.accounts?.find(a => a.type === 'BANK') || {};
      const balance = formatMoney(acc.balance);
      totalEntries = 1;

      rowsHtml = `
        <tr class="row-debit">
          <td>01/08/2026</td>
          <td>1.1.1.01.0.00001</td>
          <td><span class="ledger-icon-badge">📘 5</span></td>
          <td class="col-debit-val">${balance}</td>
          <td></td>
          <td><a class="history-link">SALDO CONTA CORRENTE PLUGGY BANK</a></td>
          <td></td>
          <td style="text-align: center;"></td>
          <td>PLUGGY BANK</td>
          <td style="text-align: center;"></td>
        </tr>
        <tr class="row-credit row-pair-separator">
          <td></td>
          <td><span class="contrapartida-text">5.1.1.01.0.00001</span></td>
          <td><span class="ledger-icon-badge">📘 1</span></td>
          <td></td>
          <td class="col-credit-val">${balance}</td>
          <td><a class="history-link contrapartida-text">SALDO CONTA CORRENTE PLUGGY BANK</a></td>
          <td></td>
          <td style="text-align: center;"><span class="action-icon">✏️</span></td>
          <td class="slash-empty">/</td>
          <td style="text-align: center;"><span class="action-icon">📎</span></td>
        </tr>
      `;
    } else {
      chkTxs.forEach((tx) => {
        const isDebit = (Number(tx.amount) || 0) < 0 || tx.type === 'DEBIT';
        const amountFormatted = formatMoney(tx.amount);
        const classification = tx.classification || (isDebit ? '3.1.2.01.0.00001' : '1.1.1.01.0.00001');
        const accountNum = tx.accountCode || '5';
        const desc = tx.description || tx.descriptionRaw || 'Transação C/C';
        const counterparty = tx.paymentData?.receiver?.name || tx.paymentData?.payer?.name || tx.category || '/';

        rowsHtml += `
          <tr class="row-debit">
            <td>${formatDate(tx.date)}</td>
            <td>${classification}</td>
            <td><span class="ledger-icon-badge">📘 ${accountNum}</span></td>
            <td class="col-debit-val">${amountFormatted}</td>
            <td></td>
            <td><a class="history-link" title="${desc}">${desc}</a></td>
            <td></td>
            <td style="text-align: center;"></td>
            <td>${counterparty}</td>
            <td style="text-align: center;"></td>
          </tr>
          <tr class="row-credit row-pair-separator">
            <td></td>
            <td><span class="contrapartida-text">${isDebit ? '1.1.1.01.0.00001' : '3.1.1.01.0.00001'}</span></td>
            <td><span class="ledger-icon-badge">📘 ${accountNum}</span></td>
            <td></td>
            <td class="col-credit-val">${amountFormatted}</td>
            <td><a class="history-link contrapartida-text" title="${desc}">${desc}</a></td>
            <td></td>
            <td style="text-align: center;"><span class="action-icon">✏️</span></td>
            <td class="slash-empty">/</td>
            <td style="text-align: center;"><span class="action-icon">📎</span></td>
          </tr>
        `;
      });
    }
  }

  tbody.innerHTML = rowsHtml;

  // Atualiza contadores característicos do Mister
  const doubleCount = totalEntries * 2;
  document.getElementById('lancamentosCounter').textContent = `${doubleCount}/${totalEntries}`;
  document.getElementById('resultsCountText').textContent = `Mostrando 1 - ${doubleCount} de ${doubleCount} resultados.`;
}

document.addEventListener('DOMContentLoaded', init);
