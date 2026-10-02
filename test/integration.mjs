// Integração com uma Pluggy falsa local (test/fake-pluggy.mjs): connect token, item-data completo,
// paginação, avisos, fallback do sandbox, polling de UPDATING, mapeamento de erros, reautenticação,
// revogação e credenciais digitadas na tela. Chamado pelo test/smoke.mjs.
import assert from 'node:assert/strict';
import { basic } from './helpers.mjs';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, IDS, startFakePluggy } from './fake-pluggy.mjs';

const auth = basic('marcio', 'senha-integracao');
const SEPT = 'from=2026-09-01&to=2026-09-30&label=Setembro%20de%202026';
const OLD = 'from=2020-01-01&to=2020-01-31';
const ATTACKER_ID = '99999999-9999-4999-8999-999999999999';

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`resposta não é JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
}

async function expectError(res, status, code) {
  const data = await json(res);
  assert.equal(res.status, status, `status ${res.status}: ${JSON.stringify(data)}`);
  assert.equal(data.code, code);
  assert.ok(typeof data.error === 'string' && data.error.length > 0);
  return data;
}

const todayInBrazil = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export async function runIntegration(suite, start) {
  const { check } = suite;
  const fake = await startFakePluggy();
  try {
    suite.section('Integração com Pluggy falsa (chaves no ambiente)');
    const s = await start({
      APP_PASSWORD: 'senha-integracao',
      PLUGGY_API_URL: fake.url,
      PLUGGY_CLIENT_ID: FAKE_CLIENT_ID,
      PLUGGY_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      PLUGGY_POLL_MAX_MS: '3000',
      PLUGGY_TIMEOUT_MS: '1000'
    });
    const get = (p) => fetch(s.base + p, { headers: { Authorization: auth } });
    const postToken = (body) => fetch(`${s.base}/api/connect-token`, {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const del = (itemId) => fetch(`${s.base}/api/item?itemId=${itemId}`, { method: 'DELETE', headers: { Authorization: auth, Origin: s.base } });
    const itemData = (itemId, query = SEPT) => get(`/api/item-data?itemId=${itemId}&${query}`);

    await check('connect-token: conexão nova usa APP_USER como clientUserId e ignora o do navegador', async () => {
      const res = await postToken({ clientUserId: 'vindo-do-navegador' });
      assert.equal(res.status, 200);
      assert.equal((await json(res)).accessToken, 'connect-token-falso');
      assert.deepEqual(fake.state.connectTokenBodies.at(-1), { options: { clientUserId: 'marcio' } });
    });
    await check('connect-token: com itemId gera token de atualização ({ itemId, options })', async () => {
      assert.equal((await postToken({ itemId: IDS.main })).status, 200);
      assert.deepEqual(fake.state.connectTokenBodies.at(-1), { itemId: IDS.main, options: { clientUserId: 'marcio' } });
    });
    await check('connect-token: itemId que não existe → 404 ITEM_NOT_FOUND', async () => {
      await expectError(await postToken({ itemId: IDS.missing }), 404, 'ITEM_NOT_FOUND');
    });
    await check('connect-token: com chaves no ambiente, Client ID/Secret do corpo são ignorados', async () => {
      assert.equal((await postToken({ clientId: ATTACKER_ID, clientSecret: 'do-atacante' })).status, 200);
      assert.ok(!fake.state.authCalls.includes(ATTACKER_ID), 'o /auth nunca deve receber o clientId do corpo');
      assert.ok(fake.state.authCalls.every((id) => id === FAKE_CLIENT_ID));
    });

    let main;
    await check('item-data: resumo completo no formato do contrato', async () => {
      const res = await itemData(IDS.main);
      main = await json(res);
      assert.equal(res.status, 200, JSON.stringify(main));
      assert.equal(main.item.id, IDS.main);
      assert.equal(main.syncing, false);
      assert.deepEqual(main.period, { from: '2026-09-01', to: '2026-09-30', label: 'Setembro de 2026' });
      assert.equal(main.periodFallback, false);
      assert.equal(main.fallbackRange, null);
      assert.equal(main.truncated, false);
      assert.equal(main.identity.companyName, 'Empresa Teste LTDA');
      assert.equal(typeof main.timestamp, 'string');
      assert.equal(main.accounts.length, 2, 'contas das duas páginas');
      assert.equal(main.checkingTransactions.length, 3, 'lançamentos das duas páginas do cursor, só do período');
      assert.equal(main.cardStatements.length, 1);
      const card = main.cardStatements[0];
      assert.equal(card.account.subtype, 'CREDIT_CARD');
      assert.equal(card.transactions.length, 1);
      assert.equal(card.totalTransactions, 1);
      assert.deepEqual(card.period, main.period);
      assert.equal(card.bills.length, 1);
      assert.equal(card.bills[0].id, 'bill-1');
      assert.deepEqual(main.investments.map((i) => i.id), ['inv-1', 'inv-2']);
      assert.deepEqual(main.loans.map((l) => l.id), ['loan-1', 'loan-2']);
    });
    await check('item-data: avisos de PARTIAL_SUCCESS / statusDetail', async () => {
      assert.ok(Array.isArray(main.warnings));
      const products = main.warnings.map((w) => w.product);
      assert.ok(products.includes('creditCards'), JSON.stringify(main.warnings));
      assert.ok(main.warnings.some((w) => w.product === 'accounts' && w.message.includes('Sem permissão para ver o limite')));
      for (const w of main.warnings) assert.ok(typeof w.message === 'string' && w.message.length > 10);
    });
    await check('item-data: categoryTranslated vem de /categories e é omitido sem categoria', async () => {
      const byId = Object.fromEntries(main.checkingTransactions.map((tx) => [tx.id, tx]));
      assert.equal(byId['tx-1'].categoryTranslated, 'Transferências');
      assert.equal(byId['tx-2'].categoryTranslated, 'Renda');
      assert.ok(!('categoryTranslated' in byId['tx-3']));
    });
    await check('item-data: categorias ficam em cache (uma chamada só a /categories)', async () => {
      assert.equal((await itemData(IDS.main)).status, 200);
      assert.equal(fake.state.categoryCalls, 1);
    });
    await check('last-data devolve o último resumo só para o mesmo itemId', async () => {
      const res = await get(`/api/last-data?itemId=${IDS.main}`);
      assert.equal(res.status, 200);
      assert.equal((await json(res)).item.id, IDS.main);
      await expectError(await get(`/api/last-data?itemId=${IDS.sandbox}`), 404, 'NOT_FOUND');
    });

    await check('item-data: Item inexistente → 404 ITEM_NOT_FOUND', async () => {
      await expectError(await itemData(IDS.missing), 404, 'ITEM_NOT_FOUND');
    });
    await check('item-data: sandbox com todas as contas vazias usa os últimos 90 dias', async () => {
      const data = await json(await itemData(IDS.sandbox, OLD));
      assert.equal(data.periodFallback, true);
      assert.equal(data.fallbackRange.to, todayInBrazil());
      const days = (Date.parse(data.fallbackRange.to) - Date.parse(data.fallbackRange.from)) / 86400000;
      assert.equal(days, 90);
      assert.equal(data.checkingTransactions.length, 1);
      assert.equal(data.period.from, '2020-01-01');
    });
    await check('item-data: conector real nunca usa fallback de período', async () => {
      const data = await json(await itemData(IDS.realEmpty, OLD));
      assert.equal(data.periodFallback, false);
      assert.equal(data.fallbackRange, null);
      assert.equal(data.checkingTransactions.length, 0);
    });
    await check('item-data: espera o Item sair de UPDATING (polling)', async () => {
      const data = await json(await itemData(IDS.updatingOnce));
      assert.equal(data.item.status, 'UPDATED');
      assert.equal(data.syncing, false);
      assert.equal(fake.state.itemGets[IDS.updatingOnce], 2);
    });
    await check('item-data: ainda UPDATING após a espera → syncing: true e não vira "último resumo"', async () => {
      const t0 = Date.now();
      const data = await json(await itemData(IDS.alwaysUpdating));
      assert.equal(data.syncing, true);
      assert.ok(Date.now() - t0 >= 2900, 'deve ter esperado o polling');
      await expectError(await get(`/api/last-data?itemId=${IDS.alwaysUpdating}`), 404, 'NOT_FOUND');
    });
    await check('item-data: produto opcional com 4xx vira aviso, sem derrubar a consulta', async () => {
      const res = await itemData(IDS.loans400);
      const data = await json(res);
      assert.equal(res.status, 200);
      assert.deepEqual(data.loans, []);
      assert.ok(data.warnings.some((w) => w.product === 'loans'), JSON.stringify(data.warnings));
    });
    await check('item-data: limite de páginas atingido → truncated: true', async () => {
      const data = await json(await itemData(IDS.truncated));
      assert.equal(data.truncated, true);
      assert.equal(data.checkingTransactions.length, 50);
    });
    await check('item-data: Pluggy 5xx → 502 PLUGGY_UNAVAILABLE, 429 → 429 RATE_LIMIT, demora → 504 TIMEOUT', async () => {
      await expectError(await itemData(IDS.broken), 502, 'PLUGGY_UNAVAILABLE');
      const limited = await itemData(IDS.rateLimited);
      assert.equal(limited.headers.get('retry-after'), '60');
      await expectError(limited, 429, 'RATE_LIMIT');
      await expectError(await itemData(IDS.slow), 504, 'TIMEOUT');
    });
    await check('API Key revogada: reautentica uma vez e repete a chamada', async () => {
      const before = fake.state.authCalls.length;
      fake.revokeAllKeys();
      // Duas consultas ao mesmo tempo recebem 403 com a chave antiga: só um /auth novo deve sair
      const [r1, r2] = await Promise.all([itemData(IDS.main), itemData(IDS.main)]);
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(fake.state.authCalls.length, before + 1, 'um único /auth, mesmo com chamadas em paralelo');
    });

    await check('DELETE /api/item revoga na Pluggy, limpa o último resumo e 404 conta como já revogado', async () => {
      const res = await del(IDS.main);
      assert.equal(res.status, 200);
      assert.deepEqual(await json(res), { revoked: true });
      assert.ok(fake.state.requests.includes(`DELETE /items/${IDS.main}`));
      await expectError(await get(`/api/last-data?itemId=${IDS.main}`), 404, 'NOT_FOUND');
      const again = await del(IDS.main);
      assert.equal(again.status, 200);
      assert.deepEqual(await json(again), { revoked: true });
      await expectError(await itemData(IDS.main), 404, 'ITEM_NOT_FOUND');
    });
    await check('nenhum erro da Pluggy vaza para o usuário (detalhe só no console do servidor)', async () => {
      assert.match(s.output(), /\[pluggy\] GET \/items\/\{?.*HTTP 500/);
      assert.ok(!s.output().includes(FAKE_CLIENT_SECRET), 'segredo não pode aparecer no log');
    });
    await s.stop();

    suite.section('Integração: credenciais digitadas na tela (desenvolvimento, sem chaves no ambiente)');
    const dev = await start({ APP_PASSWORD: 'senha-integracao', PLUGGY_API_URL: fake.url });
    const devPost = (body) => fetch(`${dev.base}/api/connect-token`, {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const devConfig = async () => json(await fetch(`${dev.base}/api/config`, { headers: { Authorization: auth } }));

    await check('Client Secret errado é recusado e não fica gravado', async () => {
      const data = await expectError(await devPost({ clientId: FAKE_CLIENT_ID, clientSecret: 'errado' }), 502, 'PLUGGY_AUTH');
      assert.match(data.error, /não aceitou/);
      const config = await devConfig();
      assert.equal(config.hasEnvKeys, false);
      assert.equal(config.allowRuntimeCreds, true);
      // Sem credenciais gravadas: continua pedindo as chaves (não ficou "envenenado")
      const again = await expectError(await devPost({}), 502, 'PLUGGY_AUTH');
      assert.match(again.error, /Informe o Client ID/);
    });
    await check('credenciais corretas são validadas no /auth e passam a valer', async () => {
      assert.equal((await devPost({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET })).status, 200);
      assert.equal((await devPost({})).status, 200);
      assert.equal((await devConfig()).hasEnvKeys, false, 'hasEnvKeys reflete só o ambiente');
    });
    await dev.stop();
  } finally {
    await fake.close();
  }
}
