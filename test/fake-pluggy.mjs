// Pluggy falsa (local) para os testes de integração. Imita só o que o server.mjs usa, no formato
// documentado: /auth, /connect_token, /items/{id}, /accounts, /v2/transactions (cursor), /bills,
// /investments e /loans (page/totalPages), /identity e /categories. Nunca fala com a Pluggy real.
import http from 'node:http';

export const FAKE_CLIENT_ID = '11111111-1111-4111-8111-111111111111';
export const FAKE_CLIENT_SECRET = 'segredo-falso-de-teste';

export const IDS = {
  main: 'aaaaaaaa-0000-4000-8000-000000000001',
  sandbox: 'aaaaaaaa-0000-4000-8000-000000000002',
  realEmpty: 'aaaaaaaa-0000-4000-8000-000000000003',
  updatingOnce: 'aaaaaaaa-0000-4000-8000-000000000004',
  alwaysUpdating: 'aaaaaaaa-0000-4000-8000-000000000005',
  broken: 'aaaaaaaa-0000-4000-8000-000000000006',
  rateLimited: 'aaaaaaaa-0000-4000-8000-000000000007',
  slow: 'aaaaaaaa-0000-4000-8000-000000000008',
  loans400: 'aaaaaaaa-0000-4000-8000-000000000009',
  truncated: 'aaaaaaaa-0000-4000-8000-00000000000a',
  missing: 'aaaaaaaa-0000-4000-8000-0000000000ff'
};

const ACC = {
  bank: 'bbbbbbbb-0000-4000-8000-000000000001',
  card: 'bbbbbbbb-0000-4000-8000-000000000002',
  recent: 'bbbbbbbb-0000-4000-8000-000000000003',
  endless: 'bbbbbbbb-0000-4000-8000-000000000004'
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z';

const bankAccount = (id) => ({ id, type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta Corrente', balance: 1000, currencyCode: 'BRL' });

function baseItem(id, overrides = {}) {
  return {
    id,
    status: 'UPDATED',
    executionStatus: 'SUCCESS',
    statusDetail: null,
    connector: { id: 1, name: 'Banco Teste', isSandbox: false },
    ...overrides
  };
}

export async function startFakePluggy() {
  const state = {
    validKeys: new Set(),
    keyCounter: 0,
    authCalls: [], // clientIds recebidos no /auth
    connectTokenBodies: [],
    categoryCalls: 0,
    itemGets: {},
    deleted: new Set(),
    requests: []
  };

  // Cada Item: dados de /items/{id} e o que as listas devolvem
  const items = {
    [IDS.main]: {
      item: baseItem(IDS.main, {
        executionStatus: 'PARTIAL_SUCCESS',
        statusDetail: {
          creditCards: { isUpdated: false, lastUpdatedAt: null },
          accounts: { isUpdated: true, warnings: [{ code: '001', message: 'Missing permission', providerMessage: 'Sem permissão para ver o limite' }] }
        }
      }),
      accountPages: [[bankAccount(ACC.bank)], [{ id: ACC.card, type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Cartão Empresa', balance: 300, currencyCode: 'BRL' }]],
      investmentPages: [[{ id: 'inv-1', type: 'FIXED_INCOME', balance: 100 }], [{ id: 'inv-2', type: 'MUTUAL_FUND', balance: 200 }]],
      loanPages: [[{ id: 'loan-1', productName: 'Capital de giro' }], [{ id: 'loan-2', productName: 'Conta garantida' }]],
      identity: { id: 'id-1', itemId: IDS.main, companyName: 'Empresa Teste LTDA', taxNumber: '33.333.333/0001-33' }
    },
    [IDS.sandbox]: { item: baseItem(IDS.sandbox, { connector: { id: 2, name: 'Pluggy Bank', isSandbox: true } }), accountPages: [[bankAccount(ACC.recent)]] },
    [IDS.realEmpty]: { item: baseItem(IDS.realEmpty), accountPages: [[bankAccount(ACC.recent)]] },
    [IDS.updatingOnce]: { item: baseItem(IDS.updatingOnce), accountPages: [[]], updatingGets: 1 },
    [IDS.alwaysUpdating]: { item: baseItem(IDS.alwaysUpdating, { status: 'UPDATING', executionStatus: 'LOGIN_IN_PROGRESS' }), accountPages: [[]] },
    [IDS.broken]: { item: baseItem(IDS.broken), itemStatusCode: 500 },
    [IDS.rateLimited]: { item: baseItem(IDS.rateLimited), itemStatusCode: 429 },
    [IDS.slow]: { item: baseItem(IDS.slow), itemDelayMs: 3000 },
    [IDS.loans400]: { item: baseItem(IDS.loans400), accountPages: [[]], loansStatusCode: 400 },
    [IDS.truncated]: { item: baseItem(IDS.truncated), accountPages: [[bankAccount(ACC.endless)]] }
  };

  // Lançamentos por conta (date sempre à meia-noite UTC, como a Pluggy)
  const transactions = {
    [ACC.bank]: [
      { id: 'tx-1', accountId: ACC.bank, date: '2026-09-05T00:00:00.000Z', amount: 1500, type: 'CREDIT', categoryId: '05000000', currencyCode: 'BRL', description: 'TED recebida' },
      { id: 'tx-2', accountId: ACC.bank, date: '2026-09-10T00:00:00.000Z', amount: -200, type: 'DEBIT', categoryId: '01000000', currencyCode: 'BRL', description: 'Tarifa' },
      { id: 'tx-3', accountId: ACC.bank, date: '2026-09-20T00:00:00.000Z', amount: -50, type: 'DEBIT', currencyCode: 'BRL', description: 'Sem categoria' },
      { id: 'tx-out', accountId: ACC.bank, date: '2026-08-31T00:00:00.000Z', amount: -1, type: 'DEBIT', currencyCode: 'BRL', description: 'Fora do período' }
    ],
    [ACC.card]: [
      { id: 'tx-4', accountId: ACC.card, date: '2026-09-15T00:00:00.000Z', amount: 80, type: 'DEBIT', currencyCode: 'BRL', description: 'Compra', creditCardMetadata: { billId: 'bill-1' } }
    ],
    [ACC.recent]: [
      { id: 'tx-recent', accountId: ACC.recent, date: daysAgo(10), amount: -10, type: 'DEBIT', currencyCode: 'BRL', description: 'Recente' }
    ]
  };

  const bills = { [ACC.card]: [{ id: 'bill-1', dueDate: '2026-10-10T00:00:00.000Z', billClosingDate: '2026-10-01T00:00:00.000Z', totalAmount: 80, totalAmountCurrencyCode: 'BRL', financeCharges: [], payments: [] }] };

  const send = (res, status, data) => {
    // O servidor pode ter desistido (timeout): resposta tardia é descartada sem erro
    res.on('error', () => {});
    if (res.destroyed || res.socket?.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const paged = (pages, pageParam) => {
    const page = Number(pageParam || 1);
    return { page, total: pages.flat().length, totalPages: pages.length, results: pages[page - 1] || [] };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const p = url.pathname;
      const q = url.searchParams;
      state.requests.push(`${req.method} ${p}`);

      if (p === '/auth' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        state.authCalls.push(body.clientId);
        if (body.clientId === FAKE_CLIENT_ID && body.clientSecret === FAKE_CLIENT_SECRET) {
          const apiKey = `chave-${++state.keyCounter}`;
          state.validKeys.add(apiKey);
          return send(res, 200, { apiKey });
        }
        return send(res, 401, { code: 401, codeDescription: 'CLIENT_KEYS_UNAUTHORIZED', message: 'Client keys are invalid' });
      }

      if (!state.validKeys.has(req.headers['x-api-key'])) {
        return send(res, 403, { code: 403, message: 'Missing or invalid authorization token' });
      }

      if (p === '/connect_token' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        state.connectTokenBodies.push(body);
        if (body.itemId && (!items[body.itemId] || state.deleted.has(body.itemId))) {
          return send(res, 404, { code: 404, codeDescription: 'ITEM_NOT_FOUND', message: 'item not found' });
        }
        return send(res, 200, { accessToken: 'connect-token-falso' });
      }

      const itemMatch = /^\/items\/([^/]+)$/.exec(p);
      if (itemMatch) {
        const entry = items[itemMatch[1]];
        if (!entry || state.deleted.has(itemMatch[1])) return send(res, 404, { code: 404, codeDescription: 'ITEM_NOT_FOUND', message: 'item not found' });
        if (req.method === 'DELETE') {
          state.deleted.add(itemMatch[1]);
          return send(res, 200, { count: 1 });
        }
        state.itemGets[itemMatch[1]] = (state.itemGets[itemMatch[1]] || 0) + 1;
        if (entry.itemStatusCode) return send(res, entry.itemStatusCode, { code: entry.itemStatusCode, message: 'erro simulado' });
        if (entry.itemDelayMs) return setTimeout(() => send(res, 200, entry.item), entry.itemDelayMs);
        if (entry.updatingGets && state.itemGets[itemMatch[1]] <= entry.updatingGets) return send(res, 200, { ...entry.item, status: 'UPDATING' });
        return send(res, 200, entry.item);
      }

      const byItem = items[q.get('itemId')];
      if (p === '/accounts') return send(res, 200, paged(byItem?.accountPages || [[]], q.get('page')));
      if (p === '/investments') return send(res, 200, paged(byItem?.investmentPages || [[]], q.get('page')));
      if (p === '/loans') {
        if (byItem?.loansStatusCode) return send(res, byItem.loansStatusCode, { code: byItem.loansStatusCode, message: 'loans not available' });
        return send(res, 200, paged(byItem?.loanPages || [[]], q.get('page')));
      }
      if (p === '/identity') {
        if (!byItem?.identity) return send(res, 404, { code: 404, codeDescription: 'IDENTITY_NOT_FOUND', message: 'identity not found' });
        return send(res, 200, byItem.identity);
      }
      if (p === '/bills') return send(res, 200, paged([bills[q.get('accountId')] || []], q.get('page')));
      if (p === '/categories') {
        state.categoryCalls++;
        return send(res, 200, {
          page: 1, total: 2, totalPages: 1,
          results: [
            { id: '05000000', description: 'Transfers', descriptionTranslated: 'Transferências' },
            { id: '01000000', description: 'Income', descriptionTranslated: 'Renda' }
          ]
        });
      }

      if (p === '/v2/transactions') {
        const accountId = q.get('accountId');
        if (accountId === ACC.endless) {
          // Sempre há "próxima página": força o limite de páginas do servidor
          const n = Number(q.get('after') || 0);
          return send(res, 200, { results: [{ id: `tx-endless-${n}`, accountId, date: '2026-09-01T00:00:00.000Z', amount: -1, type: 'DEBIT' }], next: `?accountId=${accountId}&dateFrom=${q.get('dateFrom')}&dateTo=${q.get('dateTo')}&after=${n + 1}` });
        }
        const from = q.get('dateFrom');
        const to = q.get('dateTo');
        const list = (transactions[accountId] || []).filter((tx) => (!from || tx.date.slice(0, 10) >= from) && (!to || tx.date.slice(0, 10) <= to));
        // Duas páginas por cursor quando há mais de 2 lançamentos
        if (!q.get('after') && list.length > 2) {
          return send(res, 200, { results: list.slice(0, 2), next: `?accountId=${accountId}&dateFrom=${from}&dateTo=${to}&after=pagina2` });
        }
        return send(res, 200, { results: q.get('after') ? list.slice(2) : list, next: null });
      }

      send(res, 404, { code: 404, message: 'not found' });
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    revokeAllKeys: () => state.validKeys.clear(),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  };
}
