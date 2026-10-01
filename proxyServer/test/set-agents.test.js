const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const run = promisify(execFile);
const powershell = process.env.POWERSHELL_BIN || 'pwsh';
const hasPowerShell = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout?.trim();
const assets = path.join(__dirname, '../assets');

function catalog() {
  return { object: 'ieti.model_capabilities.list', schema_version: 1, data: [
    { id: 'vision/reasoner', context_window: 131072, max_output_tokens: 8192,
      capabilities: { text: true, image: true, tools: true, reasoning: true, parallel_tools: true },
      reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'low' },
    { id: 'text', context_window: 32768, max_output_tokens: 4096,
      capabilities: { text: true, image: false, tools: false, reasoning: false, parallel_tools: false },
      reasoning_efforts: [], default_reasoning_effort: null }
  ] };
}

async function fixture(t, platform, clients = ['opencode', 'atomic-agent']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-global-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(bin); fs.mkdirSync(cwd);
  for (const client of clients) {
    const file = path.join(bin, client);
    fs.writeFileSync(file, '#!/bin/sh\nexit 99\n'); fs.chmodSync(file, 0o755);
  }
  if (python) fs.symlinkSync(python, path.join(bin, 'python3'));
  const state = { body: catalog(), status: 200, requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ path: req.url, key: req.headers.authorization });
    res.writeHead(state.status, { 'Content-Type': 'application/json', ...(state.status === 302 ? { Location: '/other' } : {}) });
    res.end(JSON.stringify(state.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/course`;
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config home'),
    ATOMIC_AGENT_STATE_DIR: path.join(root, 'atomic state'), PATH: `${bin}:/usr/bin:/bin`,
    PROXY_AGENTS_BASE_URL: `${base}/v1/`, PROXY_AGENTS_KEY: 'ieti_sk_test_global' };
  const oc = path.join(env.XDG_CONFIG_HOME, 'opencode/opencode.json');
  const aa = path.join(env.ATOMIC_AGENT_STATE_DIR, 'config.json');
  const key = path.join(env.XDG_CONFIG_HOME, 'ieti-agents/agents_server_key');
  const dotenv = path.join(env.ATOMIC_AGENT_STATE_DIR, '.env');
  const launch = () => platform === 'sh'
    ? run('/bin/bash', [path.join(assets, 'set_agents.sh'), '--sync-only'], { cwd, env })
    : run(powershell, ['-NoProfile', '-File', path.join(assets, 'set_agents.ps1'), '-SyncOnly'], { cwd, env });
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { root, cwd, env, base, oc, aa, key, dotenv, state, launch, write, read };
}

for (const platform of ['sh', 'ps1']) {
  const skip = platform === 'ps1' ? !hasPowerShell && 'Set POWERSHELL_BIN or install pwsh to exercise native PowerShell.' : !python && 'Python 3 required';
  test(`${platform}: configures both global clients, preserves settings, refreshes models and reuses credentials`, { skip }, async t => {
    const f = await fixture(t, platform);
    const originalOc = { model: 'other/keep', permission: { bash: 'ask' }, enabled_providers: ['other'], disabled_providers: ['ieti-agents'],
      provider: { other: { models: { keep: {} } }, 'ieti-agents': { options: { custom: 42 }, models: { obsolete: {} } } } };
    const originalAa = { version: 63, agent: { approvalLevel: 2 }, llm: { activeTextProvider: 'other', providers: [
      { id: 'other', kind: 'llama-server' }, { id: 'ieti-agents', kind: 'openai-compatible', apiKey: 'old', defaultChatModel: 'obsolete', headers: { 'X-Custom': 'keep' } }
    ] } };
    f.write(f.oc, originalOc); f.write(f.aa, originalAa);
    f.write(f.dotenv, '# keep this\nOTHER_SECRET=untouched\nIETI_AGENTS_API_KEY=old\nIETI_AGENTS_API_KEY=duplicate\n');
    f.write(path.join(f.cwd, 'opencode.json'), '{"local":"untouched"}');
    const output = await f.launch();
    assert.doesNotMatch(output.stdout + output.stderr, /ieti_sk_test_global/);
    assert.equal(f.state.requests.length, 1);
    assert.deepEqual(f.state.requests[0], { path: '/course/v1/model-capabilities', key: 'Bearer ieti_sk_test_global' });
    const oc = f.read(f.oc); const aa = f.read(f.aa);
    assert.deepEqual(oc.permission, originalOc.permission);
    assert.equal(oc.model, 'other/keep');
    assert.deepEqual(oc.provider.other, originalOc.provider.other);
    assert.deepEqual(oc.enabled_providers, ['other', 'ieti-agents']);
    assert.deepEqual(oc.disabled_providers, []);
    const p = oc.provider['ieti-agents'];
    assert.equal(p.options.baseURL, `${f.base}/v1`);
    assert.equal(fs.realpathSync(p.options.apiKey.slice(6, -1)), fs.realpathSync(f.key));
    assert.equal(p.options.custom, 42);
    assert.deepEqual(Object.keys(p.models), ['vision/reasoner', 'text']);
    assert.deepEqual(p.models['vision/reasoner'].limit, { context: 131072, output: 8192 });
    assert.deepEqual(p.models['vision/reasoner'].interleaved, { field: 'reasoning_content' });
    assert.equal(p.models['vision/reasoner'].variants.medium.disabled, true);
    assert.equal(p.models['vision/reasoner'].options.reasoningEffort, 'low');
    assert.equal(p.models.text.tool_call, false);
    assert.equal(p.models.text.interleaved, undefined);
    assert.deepEqual(aa.agent, originalAa.agent);
    assert.equal(aa.version, 63);
    assert.equal(aa.llm.activeTextProvider, 'other');
    assert.deepEqual(aa.llm.providers[0], originalAa.llm.providers[0]);
    const a = aa.llm.providers[1];
    assert.equal(a.kind, 'openai-compatible'); assert.equal(a.baseUrl, f.base);
    assert.equal(a.apiKey, undefined); assert.equal(a.apiKeyEnvVar, 'IETI_AGENTS_API_KEY');
    assert.deepEqual(a.headers, { 'X-Custom': 'keep' });
    assert.equal(a.defaultChatModel, 'vision/reasoner');
    assert.deepEqual(a.userModels[0], { id: 'vision/reasoner', kind: 'chat', contextWindow: 131072,
      supportsVision: true, supportsTools: 'parallel', supportsPromptCache: false, reasoningFormat: 'auto',
      params: { max_tokens: 8192, parallel_tool_calls: true, reasoning_effort: 'low' } });
    assert.equal(a.userModels[1].supportsTools, 'none');
    assert.equal(a.userModels[1].reasoningFormat, 'none');
    assert.equal(fs.readFileSync(f.dotenv, 'utf8'), '# keep this\nOTHER_SECRET=untouched\nIETI_AGENTS_API_KEY=ieti_sk_test_global\n');
    assert.deepEqual(f.read(f.oc + '.bak'), originalOc);
    assert.deepEqual(f.read(f.aa + '.bak'), originalAa);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'opencode.json'), 'utf8'), '{"local":"untouched"}');
    assert.equal(fs.statSync(f.key).mode & 0o777, 0o600);
    const firstBytes = fs.readFileSync(f.oc, 'utf8');
    delete f.env.PROXY_AGENTS_KEY; delete f.env.PROXY_AGENTS_BASE_URL;
    await f.launch();
    assert.equal(fs.readFileSync(f.oc, 'utf8'), firstBytes);
    assert.deepEqual(f.read(f.oc + '.bak'), originalOc); // unchanged reruns don't destroy backups
    f.state.body.data = [f.state.body.data[1]];
    await f.launch();
    assert.deepEqual(Object.keys(f.read(f.oc).provider['ieti-agents'].models), ['text']);
    assert.equal(f.read(f.aa).llm.providers[1].defaultChatModel, 'text');
    assert.equal(f.read(f.aa).llm.providers[1].userModels.length, 1);
  });

  test(`${platform}: JSONC, a single detected client, and fresh defaults`, { skip }, async t => {
    const f = await fixture(t, platform, ['opencode']);
    const jsonc = f.oc + 'c';
    const original = '{ // comment\n"mcp": {"url": "https://example.test/a,//b",}, "model": "ieti-agents/gone",\n}';
    f.write(jsonc, original);
    await f.launch();
    assert.equal(f.read(jsonc).mcp.url, 'https://example.test/a,//b');
    assert.equal(f.read(jsonc).model, 'ieti-agents/vision/reasoner');
    assert.equal(fs.readFileSync(jsonc + '.bak', 'utf8'), original);
    assert.equal(fs.existsSync(f.oc), false);
    assert.equal(fs.existsSync(f.aa), false);
  });

  test(`${platform}: initializes Atomic Agent alone and activates its native-tools provider`, { skip }, async t => {
    const f = await fixture(t, platform, ['atomic-agent']);
    await f.launch();
    const llm = f.read(f.aa).llm;
    assert.equal(llm.activeTextProvider, 'ieti-agents');
    assert.equal(llm.toolTransport, 'native_tools');
    assert.equal(llm.providers.length, 1);
    assert.equal(fs.existsSync(f.oc), false);
  });

  test(`${platform}: failed auth, invalid metadata, malformed config and redirects leave files intact`, { skip }, async t => {
    const f = await fixture(t, platform);
    f.write(f.oc, { keep: true }); f.write(f.aa, { keep: true });
    const original = fs.readFileSync(f.oc, 'utf8');
    for (const status of [401, 503, 302]) {
      f.state.status = status;
      await assert.rejects(f.launch(), /Model discovery failed/);
    }
    f.state.status = 200; f.state.body.data[0].context_window = -1;
    await assert.rejects(f.launch(), /invalid model limits/);
    f.state.body = catalog(); f.write(f.aa, '{ broken');
    await assert.rejects(f.launch(), /Cannot read/);
    assert.equal(fs.readFileSync(f.oc, 'utf8'), original);
    assert.equal(fs.existsSync(f.key), false);
    assert.equal(fs.existsSync(f.oc + '.bak'), false);
    assert.equal(fs.existsSync(f.dotenv), false);
    assert.ok(f.state.requests.every(r => r.path === '/course/v1/model-capabilities'));
  });

  test(`${platform}: missing clients perform no network or filesystem configuration`, { skip }, async t => {
    const f = await fixture(t, platform, []);
    const output = await f.launch();
    assert.match(output.stdout, /No supported clients found/);
    assert.equal(f.state.requests.length, 0);
    assert.equal(fs.existsSync(f.key), false);
    assert.equal(fs.existsSync(f.oc), false);
    assert.equal(fs.existsSync(f.aa), false);
  });
}
