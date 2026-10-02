// Teste de fumaça: sobe o servidor com senha e valida autenticação, validações, cabeçalhos,
// proteção contra CSRF, limite de tentativas e travas de produção. Depois roda a integração com
// uma Pluggy falsa local (test/integration.mjs). Nunca chama a API real da Pluggy. Uso: npm test
import assert from 'node:assert/strict';
import { basic, createSuite, rawRequest, runUntilExit, startServer } from './helpers.mjs';
import { getMMinusOnePeriod } from '../server.mjs';
import { runIntegration } from './integration.mjs';

const suite = createSuite();
const { check } = suite;

const auth = basic('marcio', 'senha-de-teste');
const wrong = basic('marcio', 'errada');
const ITEM = '00000000-0000-0000-0000-000000000000';
const FAKE_ID = '11111111-1111-4111-8111-111111111111';

const CSP = "default-src 'self'; script-src 'self' https://cdn.pluggy.ai; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src https://*.pluggy.ai; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const servers = [];
async function start(env) {
  const s = await startServer(env);
  servers.push(s);
  return s;
}

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`resposta não é JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
}

// Confere status e code do erro no formato do contrato { error, code }
async function expectError(res, status, code) {
  const data = await json(res);
  assert.equal(res.status, status, `status ${res.status}: ${JSON.stringify(data)}`);
  assert.equal(data.code, code);
  assert.equal(typeof data.error, 'string');
  assert.ok(data.error.length > 0);
  return data;
}

try {
  suite.section('Período M-1 (fuso America/Sao_Paulo)');

  await check('virada de mês em UTC ainda conta como o mês anterior no Brasil', async () => {
    // 01/11/2026 00:30 UTC = 31/10/2026 21:30 em Brasília → M-1 = setembro
    assert.deepEqual(getMMinusOnePeriod(new Date('2026-11-01T00:30:00Z')), { from: '2026-09-01', to: '2026-09-30', label: 'Setembro de 2026' });
    assert.deepEqual(getMMinusOnePeriod(new Date('2026-11-01T03:30:00Z')), { from: '2026-10-01', to: '2026-10-31', label: 'Outubro de 2026' });
  });
  await check('janeiro → dezembro do ano anterior e fevereiro bissexto', async () => {
    assert.deepEqual(getMMinusOnePeriod(new Date('2026-01-15T12:00:00Z')), { from: '2025-12-01', to: '2025-12-31', label: 'Dezembro de 2025' });
    assert.equal(getMMinusOnePeriod(new Date('2028-03-10T12:00:00Z')).to, '2028-02-29');
  });

  suite.section('Servidor com senha (sem credenciais da Pluggy)');
  const a = await start({ APP_PASSWORD: 'senha-de-teste' });
  const get = (p, headers = {}) => fetch(a.base + p, { headers });
  const post = (p, { headers = {}, body = '{}' } = {}) => fetch(a.base + p, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers }, body
  });

  await check('healthz responde sem senha', async () => {
    const res = await get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
  await check('página exige senha', async () => assert.equal((await get('/')).status, 401));
  await check('senha errada é recusada', async () => assert.equal((await get('/api/config', { Authorization: wrong })).status, 401));
  await check('senha correta abre a página', async () => {
    const res = await get('/', { Authorization: auth });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Mister Contador/);
  });
  await check('/api/config segue o contrato (fora de produção, sem chaves)', async () => {
    const data = await json(await get('/api/config', { Authorization: auth }));
    assert.match(data.period.from, /^\d{4}-\d{2}-01$/);
    assert.equal(typeof data.period.label, 'string');
    assert.equal(data.hasEnvKeys, false);
    assert.equal(data.allowRuntimeCreds, true);
    assert.equal(data.includeSandbox, true);
  });
  await check('mock-data e simulado não existem mais', async () => {
    await expectError(await get('/api/mock-data', { Authorization: auth }), 404, 'NOT_FOUND');
    await expectError(await get('/simulado', { Authorization: auth }), 404, 'NOT_FOUND');
  });
  await check('path traversal é bloqueado', async () => {
    const res = await get('/..%2Fserver.mjs', { Authorization: auth });
    assert.ok([400, 404].includes(res.status), `status ${res.status}`);
  });
  await check('caminho com % inválido não derruba o servidor', async () => {
    await expectError(await get('/%E0%A4%A', { Authorization: auth }), 400, 'VALIDATION');
    assert.equal((await get('/healthz')).status, 200);
  });

  await check('cabeçalhos de segurança (CSP, Permissions-Policy) e sem HSTS fora de produção', async () => {
    for (const res of [await get('/healthz'), await get('/', { Authorization: auth }), await get('/api/config', { Authorization: auth })]) {
      assert.equal(res.headers.get('content-security-policy'), CSP);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
      assert.equal(res.headers.get('strict-transport-security'), null);
    }
  });

  await check('item-data valida itemId', async () => {
    await expectError(await get('/api/item-data?itemId=abc&x=1', { Authorization: auth }), 400, 'VALIDATION');
    await expectError(await get('/api/item-data', { Authorization: auth }), 400, 'VALIDATION');
  });
  await check('item-data valida datas (formato, data real, from<=to, até 366 dias, as duas datas)', async () => {
    const q = (from, to) => get(`/api/item-data?itemId=${ITEM}&from=${from}&to=${to}`, { Authorization: auth });
    await expectError(await q('ontem', 'hoje'), 400, 'VALIDATION');
    await expectError(await q('2026-02-30', '2026-03-10'), 400, 'VALIDATION');
    await expectError(await q('2026-13-01', '2026-13-02'), 400, 'VALIDATION');
    await expectError(await q('2026-09-30', '2026-09-01'), 400, 'VALIDATION');
    await expectError(await q('2025-01-01', '2026-01-02'), 400, 'VALIDATION'); // 367 dias
    await expectError(await get(`/api/item-data?itemId=${ITEM}&from=2026-09-01`, { Authorization: auth }), 400, 'VALIDATION');
  });
  await check('item-data com 366 dias passa da validação (falha só por falta de credenciais)', async () => {
    const res = await get(`/api/item-data?itemId=${ITEM}&from=2024-01-01&to=2024-12-31`, { Authorization: auth });
    await expectError(res, 502, 'PLUGGY_AUTH');
  });

  await check('connect-token exige senha', async () => {
    const res = await fetch(`${a.base}/api/connect-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
  });
  await check('connect-token sem clientUserId não dá mais 400: falha por falta de credenciais, com mensagem amigável', async () => {
    const data = await expectError(await post('/api/connect-token'), 502, 'PLUGGY_AUTH');
    assert.doesNotMatch(data.error, /clientUserId|undefined|null|Error/);
    await expectError(await post('/api/connect-token', { body: '{"clientUserId":"qualquer"}' }), 502, 'PLUGGY_AUTH');
  });
  await check('connect-token exige Content-Type application/json (415)', async () => {
    await expectError(await post('/api/connect-token', { headers: { 'Content-Type': 'text/plain' }, body: '{"clientId":"x","p":"="}' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    await expectError(await post('/api/connect-token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    // charset é aceito
    await expectError(await post('/api/connect-token', { headers: { 'Content-Type': 'application/json; charset=utf-8' } }), 502, 'PLUGGY_AUTH');
  });
  await check('connect-token recusa outra origem (403)', async () => {
    await expectError(await post('/api/connect-token', { headers: { Origin: 'https://evil.example' } }), 403, 'FORBIDDEN_ORIGIN');
    await expectError(await post('/api/connect-token', { headers: { Origin: 'null' } }), 403, 'FORBIDDEN_ORIGIN');
    await expectError(await post('/api/connect-token', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'FORBIDDEN_ORIGIN');
    // Mesma origem passa pela checagem (e cai na falta de credenciais)
    await expectError(await post('/api/connect-token', { headers: { Origin: a.base, 'Sec-Fetch-Site': 'same-origin' } }), 502, 'PLUGGY_AUTH');
  });
  await check('connect-token valida o corpo (JSON inválido, null, lista, itemId, Client ID)', async () => {
    await expectError(await post('/api/connect-token', { body: '{quebrado' }), 400, 'VALIDATION');
    await expectError(await post('/api/connect-token', { body: 'null' }), 400, 'VALIDATION');
    await expectError(await post('/api/connect-token', { body: '[]' }), 400, 'VALIDATION');
    await expectError(await post('/api/connect-token', { body: '{"itemId":"abc"}' }), 400, 'VALIDATION');
    await expectError(await post('/api/connect-token', { body: '{"clientId":"abc","clientSecret":"x"}' }), 400, 'VALIDATION');
    await expectError(await post('/api/connect-token', { body: `{"clientId":"${FAKE_ID}"}` }), 400, 'VALIDATION');
    await expectError(await post('/api/connect-token', { body: JSON.stringify({ pad: 'x'.repeat(20000) }) }), 400, 'VALIDATION');
  });
  await check('Client ID/Secret recusados não ficam gravados (sem chaves continua sem chaves)', async () => {
    // A Pluggy (porta fechada) não responde: nada é gravado e o /api/config não muda
    await expectError(await post('/api/connect-token', { body: JSON.stringify({ clientId: FAKE_ID, clientSecret: 'qualquer' }) }), 502, 'PLUGGY_UNAVAILABLE');
    const data = await json(await get('/api/config', { Authorization: auth }));
    assert.equal(data.hasEnvKeys, false);
    assert.equal(data.allowRuntimeCreds, true);
    await expectError(await post('/api/connect-token'), 502, 'PLUGGY_AUTH');
  });

  await check('DELETE /api/item valida itemId e origem', async () => {
    const del = (q, headers = {}) => fetch(`${a.base}/api/item${q}`, { method: 'DELETE', headers: { Authorization: auth, ...headers } });
    await expectError(await del(''), 400, 'VALIDATION');
    await expectError(await del('?itemId=abc'), 400, 'VALIDATION');
    await expectError(await del(`?itemId=${ITEM}`, { Origin: 'https://evil.example' }), 403, 'FORBIDDEN_ORIGIN');
    await expectError(await del(`?itemId=${ITEM}`, { 'Sec-Fetch-Site': 'same-site' }), 403, 'FORBIDDEN_ORIGIN');
    assert.equal((await fetch(`${a.base}/api/item?itemId=${ITEM}`, { method: 'DELETE' })).status, 401);
  });
  await check('/api/last-data exige senha e itemId; sem consulta recente → 404', async () => {
    assert.equal((await get(`/api/last-data?itemId=${ITEM}`)).status, 401);
    await expectError(await get('/api/last-data', { Authorization: auth }), 400, 'VALIDATION');
    await expectError(await get('/api/last-data?itemId=abc', { Authorization: auth }), 400, 'VALIDATION');
    await expectError(await get(`/api/last-data?itemId=${ITEM}`, { Authorization: auth }), 404, 'NOT_FOUND');
  });
  await check('rota de API desconhecida ou método errado → 404 JSON', async () => {
    await expectError(await get('/api/nao-existe', { Authorization: auth }), 404, 'NOT_FOUND');
    await expectError(await get('/api/connect-token', { Authorization: auth }), 404, 'NOT_FOUND');
  });
  await a.stop();

  suite.section('Limite de tentativas de senha');
  const rl = await start({ APP_PASSWORD: 'senha-de-teste' });
  await check('10 senhas erradas bloqueiam o IP da conexão, mesmo trocando X-Forwarded-For (429)', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${rl.base}/api/config`, { headers: { Authorization: wrong, 'X-Forwarded-For': `10.0.0.${i}` } });
      assert.equal(res.status, 401, `tentativa ${i + 1}`);
    }
    const blocked = await fetch(`${rl.base}/api/config`, { headers: { Authorization: auth, 'X-Forwarded-For': '10.9.9.9' } });
    await expectError(blocked, 429, 'RATE_LIMIT');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const page = await fetch(`${rl.base}/`, { headers: { Authorization: auth } });
    assert.equal(page.status, 429);
    assert.match(page.headers.get('content-type'), /text\/plain/);
    assert.equal((await fetch(`${rl.base}/healthz`)).status, 200);
  });
  await rl.stop();

  const hops = await start({ APP_PASSWORD: 'senha-de-teste', TRUST_PROXY_HOPS: '1' });
  await check('TRUST_PROXY_HOPS=1 usa o IP anexado pelo proxy (último do X-Forwarded-For)', async () => {
    for (let i = 0; i < 10; i++) {
      await fetch(`${hops.base}/api/config`, { headers: { Authorization: wrong, 'X-Forwarded-For': `${i}.${i}.${i}.${i}, 200.0.0.1` } });
    }
    await expectError(await fetch(`${hops.base}/api/config`, { headers: { Authorization: auth, 'X-Forwarded-For': '8.8.8.8, 200.0.0.1' } }), 429, 'RATE_LIMIT');
    const other = await fetch(`${hops.base}/api/config`, { headers: { Authorization: auth, 'X-Forwarded-For': '200.0.0.1, 200.0.0.2' } });
    assert.equal(other.status, 200);
  });
  await check('muitas falhas no total atrasam as respostas erradas, sem bloquear quem acerta a senha', async () => {
    // 10 falhas já registradas acima; mais 25 de IPs diferentes passam do limite global (30)
    let lastMs = 0;
    for (let i = 0; i < 25; i++) {
      const t0 = Date.now();
      const res = await fetch(`${hops.base}/api/config`, { headers: { Authorization: wrong, 'X-Forwarded-For': `201.0.0.${i}` } });
      assert.equal(res.status, 401);
      lastMs = Date.now() - t0;
    }
    assert.ok(lastMs >= 1000, `última falha respondeu em ${lastMs} ms`);
    const t0 = Date.now();
    const ok = await fetch(`${hops.base}/api/config`, { headers: { Authorization: auth, 'X-Forwarded-For': '202.0.0.1' } });
    assert.equal(ok.status, 200);
    assert.ok(Date.now() - t0 < 1000, 'senha correta não deve esperar');
  });
  await hops.stop();

  suite.section('Sem senha (desenvolvimento local)');
  const open = await start({ HOST: '', APP_PASSWORD: '' });
  await check('sem senha atende por localhost e recusa outro Host (DNS rebinding)', async () => {
    assert.equal((await fetch(`${open.base}/api/config`)).status, 200);
    const evil = await rawRequest(open.port, { path: '/api/config', headers: { Host: 'evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(JSON.parse(evil.body).code, 'FORBIDDEN_ORIGIN');
    const local = await rawRequest(open.port, { path: '/api/config', headers: { Host: `localhost:${open.port}` } });
    assert.equal(local.status, 200);
  });
  await open.stop();

  const noSandbox = await start({ APP_PASSWORD: 'senha-de-teste', PLUGGY_INCLUDE_SANDBOX: 'false' });
  await check('PLUGGY_INCLUDE_SANDBOX=false desliga o sandbox fora de produção', async () => {
    assert.equal((await json(await fetch(`${noSandbox.base}/api/config`, { headers: { Authorization: auth } }))).includeSandbox, false);
  });
  await noSandbox.stop();

  suite.section('Produção');
  const prodEnv = { NODE_ENV: 'production', PLUGGY_CLIENT_ID: FAKE_ID, PLUGGY_CLIENT_SECRET: 'segredo-falso' };
  await check('produção sem APP_PASSWORD não sobe', async () => {
    const { code, output } = await runUntilExit({ ...prodEnv, APP_PASSWORD: '' });
    assert.equal(code, 1, output);
    assert.match(output, /APP_PASSWORD/);
  });
  await check('produção com senha curta (< 12) não sobe', async () => {
    const { code, output } = await runUntilExit({ ...prodEnv, APP_PASSWORD: 'curta12345' });
    assert.equal(code, 1, output);
    assert.match(output, /12 caracteres/);
  });
  await check('produção sem chaves da Pluggy no ambiente não sobe', async () => {
    const { code, output } = await runUntilExit({ ...prodEnv, APP_PASSWORD: 'senha-forte-de-producao', PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: '' });
    assert.equal(code, 1, output);
    assert.match(output, /PLUGGY_CLIENT_ID/);
  });
  await check('no Render (RENDER=true) a senha é obrigatória mesmo sem NODE_ENV', async () => {
    const { code } = await runUntilExit({ RENDER: 'true', APP_PASSWORD: '' });
    assert.equal(code, 1);
  });

  // Em produção PLUGGY_API_URL é ignorada: aqui só se testa o que não chama a Pluggy
  const prodAuth = basic('marcio', 'senha-forte-de-producao');
  const prod = await start({ ...prodEnv, APP_PASSWORD: 'senha-forte-de-producao' });
  await check('produção envia HSTS e /api/config sem sandbox e sem credenciais pela tela', async () => {
    const res = await fetch(`${prod.base}/api/config`, { headers: { Authorization: prodAuth } });
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.equal(res.headers.get('content-security-policy'), CSP);
    const data = await json(res);
    assert.equal(data.hasEnvKeys, true);
    assert.equal(data.allowRuntimeCreds, false);
    assert.equal(data.includeSandbox, false);
  });
  await prod.stop();

  const prodSandbox = await start({ ...prodEnv, APP_PASSWORD: 'senha-forte-de-producao', PLUGGY_INCLUDE_SANDBOX: 'true' });
  await check('produção com PLUGGY_INCLUDE_SANDBOX=true liga o sandbox explicitamente', async () => {
    assert.equal((await json(await fetch(`${prodSandbox.base}/api/config`, { headers: { Authorization: prodAuth } }))).includeSandbox, true);
  });
  await prodSandbox.stop();

  // Integração com a Pluggy falsa (local)
  await runIntegration(suite, start);
} catch (err) {
  console.error('❌ Erro inesperado nos testes:', err);
  await suite.check('execução sem erro inesperado', () => { throw err; });
} finally {
  await Promise.all(servers.map((s) => s.stop()));
}

if (suite.failed) {
  console.error(`\n${suite.failed} teste(s) falharam, ${suite.passed} passaram.`);
  process.exit(1);
}
console.log(`\nTodos os ${suite.passed} testes passaram.`);
