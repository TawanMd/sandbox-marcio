// Utilitários dos testes: sobe o server.mjs em porta livre, faz requisições e registra resultados.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.mjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

export const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

// Ambiente base dos servidores de teste. Variáveis vazias não são sobrescritas pelo .env local
// (process.loadEnvFile não troca o que já existe), então nenhuma credencial real vaza para os testes.
// PLUGGY_API_URL aponta para uma porta fechada: nada sai para a Pluggy de verdade.
const BASE_ENV = {
  NODE_ENV: '',
  RENDER: '',
  HOST: '127.0.0.1',
  APP_USER: 'marcio',
  APP_PASSWORD: '',
  TRUST_PROXY_HOPS: '',
  PLUGGY_CLIENT_ID: '',
  PLUGGY_CLIENT_SECRET: '',
  PLUGGY_INCLUDE_SANDBOX: '',
  PLUGGY_API_URL: 'http://127.0.0.1:9',
  PLUGGY_TIMEOUT_MS: '',
  PLUGGY_POLL_MAX_MS: ''
};

function spawnServer(env, port) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, ...BASE_ENV, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const proc = { child, output: '', exitCode: undefined };
  child.stdout.on('data', (d) => { proc.output += d; });
  child.stderr.on('data', (d) => { proc.output += d; });
  proc.exited = new Promise((resolve) => child.on('exit', (code) => { proc.exitCode = code; resolve(code); }));
  return proc;
}

// Sobe o servidor e espera o /healthz responder. Se ele morrer ao subir, mostra a saída.
export async function startServer(env = {}) {
  const port = await freePort();
  const proc = spawnServer(env, port);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (proc.exitCode !== undefined) throw new Error(`Servidor saiu ao subir (código ${proc.exitCode}):\n${proc.output}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* aguardando */ }
    if (i > 100) {
      proc.child.kill();
      throw new Error(`Servidor não subiu a tempo:\n${proc.output}`);
    }
    await sleep(100);
  }
  return {
    base,
    port,
    output: () => proc.output,
    stop: () => { proc.child.kill(); return proc.exited; }
  };
}

// Roda o servidor esperando que ele se recuse a subir; devolve o código de saída e a saída
export async function runUntilExit(env = {}, timeoutMs = 5000) {
  const proc = spawnServer(env, await freePort());
  const timer = setTimeout(() => proc.child.kill(), timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, output: proc.output };
}

// Requisição com http.request (permite trocar o header Host, o que o fetch não deixa)
export function rawRequest(port, { method = 'GET', path: reqPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Registro simples de resultados (✅/❌), compartilhado entre os arquivos de teste
export function createSuite() {
  let failed = 0;
  let passed = 0;
  return {
    async check(name, fn) {
      try {
        await fn();
        passed++;
        console.log(`✅ ${name}`);
      } catch (err) {
        failed++;
        console.error(`❌ ${name}\n   ${String(err?.message || err).split('\n').join('\n   ')}`);
      }
    },
    section(title) {
      console.log(`\n— ${title}`);
    },
    get failed() { return failed; },
    get passed() { return passed; }
  };
}
