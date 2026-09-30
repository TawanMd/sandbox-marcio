// Teste de fumaça: sobe o servidor com senha e valida autenticação, validações e rotas removidas.
// Não chama a API da Pluggy (não precisa de credenciais). Uso: npm test
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import net from 'node:net';

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const auth = 'Basic ' + Buffer.from('marcio:senha-de-teste').toString('base64');
const wrong = 'Basic ' + Buffer.from('marcio:errada').toString('base64');

const child = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(port), APP_PASSWORD: 'senha-de-teste', PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: '' },
  stdio: 'ignore'
});

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* aguardando */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Servidor não subiu a tempo');
}

const get = (path, headers = {}) => fetch(base + path, { headers });
let failed = false;

async function check(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); } catch (err) { failed = true; console.error(`❌ ${name}\n   ${err.message}`); }
}

try {
  await waitUp();

  await check('healthz responde sem senha', async () => assert.equal((await get('/healthz')).status, 200));
  await check('página exige senha', async () => assert.equal((await get('/')).status, 401));
  await check('senha errada é recusada', async () => assert.equal((await get('/api/config', { Authorization: wrong })).status, 401));
  await check('senha correta abre a página', async () => {
    const res = await get('/', { Authorization: auth });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Mister Contador/);
  });
  await check('/api/config expõe período e includeSandbox', async () => {
    const data = await (await get('/api/config', { Authorization: auth })).json();
    assert.match(data.period.from, /^\d{4}-\d{2}-01$/);
    assert.equal(typeof data.includeSandbox, 'boolean');
    assert.equal(data.hasEnvKeys, false);
  });
  await check('mock-data e simulado não existem mais', async () => {
    assert.equal((await get('/api/mock-data', { Authorization: auth })).status, 404);
    assert.equal((await get('/simulado', { Authorization: auth })).status, 404);
  });
  await check('path traversal é bloqueado', async () => {
    const res = await get('/..%2Fserver.mjs', { Authorization: auth });
    assert.ok([400, 404].includes(res.status), `status ${res.status}`);
  });
  await check('caminho com % inválido não derruba o servidor', async () => {
    const res = await get('/%E0%A4%A', { Authorization: auth });
    assert.equal(res.status, 400);
    assert.equal((await get('/healthz')).status, 200);
  });
  await check('item-data valida itemId', async () => {
    assert.equal((await get('/api/item-data?itemId=abc&x=1', { Authorization: auth })).status, 400);
    assert.equal((await get('/api/item-data', { Authorization: auth })).status, 400);
  });
  await check('item-data valida datas', async () => {
    const res = await get('/api/item-data?itemId=00000000-0000-0000-0000-000000000000&from=ontem&to=hoje', { Authorization: auth });
    assert.equal(res.status, 400);
  });
  await check('connect-token exige clientUserId', async () => {
    const res = await fetch(`${base}/api/connect-token`, {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(res.status, 400);
  });
  await check('cabeçalhos de segurança presentes', async () => {
    const res = await get('/healthz');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });
} finally {
  child.kill();
}

if (failed) process.exit(1);
console.log('\nTodos os testes passaram.');
