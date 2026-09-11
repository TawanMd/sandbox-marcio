/**
 * Pluggy MCP Client & Test Script
 * Permite interagir e testar as ferramentas do MCP da Pluggy diretamente.
 */

const PLUGGY_MCP_URL = 'https://docs.pluggy.ai/mcp';

async function callPluggyMcp(method, params = {}) {
  const response = await fetch(PLUGGY_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    })
  });

  const text = await response.text();
  const match = text.match(/data:\s*(.*)/);
  if (match && match[1]) {
    return JSON.parse(match[1]);
  }
  return { raw: text };
}

async function main() {
  console.log('🔄 Conectando ao MCP da Pluggy...');
  const initResult = await callPluggyMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pluggy-marcio-client', version: '1.0' }
  });
  console.log('✅ Inicialização bem-sucedida:', JSON.stringify(initResult.result?.serverInfo || initResult, null, 2));

  console.log('\n🔍 Listando ferramentas disponíveis...');
  const toolsResult = await callPluggyMcp('tools/list', {});
  const tools = toolsResult.result?.tools?.map(t => ` - ${t.name}: ${t.description.split('.')[0]}`) || [];
  console.log(`Foram encontradas ${tools.length} ferramentas:\n` + tools.join('\n'));

  console.log('\n📚 Testando ferramenta "list-specs"...');
  const specsResult = await callPluggyMcp('tools/call', {
    name: 'list-specs',
    arguments: {}
  });
  console.log('Especificações OpenAPI disponíveis:', specsResult.result?.content?.[0]?.text);
}

main().catch(err => {
  console.error('Erro ao conectar ao MCP da Pluggy:', err);
  process.exit(1);
});
