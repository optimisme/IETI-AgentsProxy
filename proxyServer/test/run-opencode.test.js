const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const run = promisify(execFile);
const requestedPowerShell = process.env.POWERSHELL_BIN || 'pwsh';
const powershellProbe = spawnSync(requestedPowerShell, ['-NoProfile', '-Command', '[System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName'], { encoding: 'utf8' });
const hasPowerShell = powershellProbe.status === 0;
const powershell = hasPowerShell ? powershellProbe.stdout.trim() : requestedPowerShell;
const python = spawnSync('python3', ['-I', '-B', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout?.trim();
const assets = path.join(__dirname, '..', 'assets');

function filesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(filename) : [filename];
  });
}

function directoriesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const filename = path.join(directory, entry.name);
    return [filename, ...directoriesIn(filename)];
  });
}

function assertNoRuntimeFiles(f, before, beforeDirectories) {
  assert.deepEqual(fs.readdirSync(f.temporary), [], 'Installer temporary files must be removed before exit.');
  const allowed = new Set([f.configPath, `${f.configPath}c`, `${f.configPath}.bak`, `${f.configPath}c.bak`, f.keyPath]);
  for (const file of filesIn(f.root)) {
    assert.ok(before.has(file) || allowed.has(file), `Unexpected runtime file: ${path.relative(f.root, file)}`);
    assert.doesNotMatch(path.relative(f.root, file), /(?:^|\/)(?:__pycache__|\.venv)(?:\/|$)|\.tmp\./);
  }
  const configuredDirectories = new Set([f.configRoot, path.dirname(f.configPath), path.dirname(f.keyPath)]);
  for (const directory of directoriesIn(f.root)) {
    if (beforeDirectories.has(directory)) continue;
    assert.ok(configuredDirectories.has(directory), `Unexpected runtime folder: ${path.relative(f.root, directory)}`);
    assert.ok(filesIn(directory).length > 0, `Empty setup folder was left behind: ${path.relative(f.root, directory)}`);
  }
  for (const directory of [f.cwd, f.scripts, f.configRoot]) {
    if (fs.existsSync(directory)) assert.equal(fs.readdirSync(directory).some(name => name === '__pycache__' || name === '.venv'), false);
  }
}

function capabilities(models = [{}]) {
  return {
    object: 'ieti.model_capabilities.list',
    schema_version: 1,
    data: models.map((model, index) => ({
      id: model.id || `model-${index + 1}`,
      name: model.name,
      context_window: model.context ?? 32768,
      max_output_tokens: model.output ?? 8192,
      capabilities: {
        text: model.text ?? true,
        image: model.image ?? false,
        tools: model.tools ?? true,
        reasoning: model.reasoning ?? false,
        parallel_tools: model.parallelTools ?? false
      },
      reasoning_efforts: model.reasoningEfforts || [],
      default_reasoning_effort: model.defaultReasoningEffort || null,
      supports_chat_template_kwargs: model.chatTemplateKwargs ?? false,
      modalities: {
        input: ['text', ...(model.image ? ['image'] : [])],
        output: ['text']
      }
    }))
  };
}

test('ps1: installs using PowerShell built-ins with no external helper commands on PATH', {
  skip: !hasPowerShell && 'PowerShell is unavailable; set POWERSHELL_BIN to exercise native Windows-compatible flow.'
}, async t => {
  const f = await fixture(t, 'ps1');
  const emptyBin = path.join(f.root, 'empty-bin');
  fs.mkdirSync(emptyBin);
  f.env.PATH = emptyBin;
  f.env.PROXY_AGENTS_KEY = 'ieti_sk_replacement';
  await f.launch();
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_replacement\n');
  assert.equal(f.read().provider['ieti-agents'].options.baseURL, f.baseURL);
});

test('sh: installs with Python and system utilities while Node and package tools are absent from PATH', async t => {
  const f = await fixture(t, 'sh');
  const bin = path.join(f.root, 'isolated-bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(python, path.join(bin, 'python3'));
  for (const command of ['bash', 'cat', 'chmod', 'dirname', 'mktemp', 'rm']) {
    const source = spawnSync('/bin/bash', ['-c', 'command -v "$1"', '--', command], { encoding: 'utf8' }).stdout.trim();
    assert.ok(source, `The test host provides ${command}.`);
    fs.symlinkSync(source, path.join(bin, command));
  }
  f.env.PATH = bin;
  f.env.PROXY_AGENTS_KEY = 'ieti_sk_replacement';
  f.env.PYTHONPATH = f.cwd;
  const shadowSource = 'raise RuntimeError("shadow module loaded")\n';
  for (const module of ['json', 'http']) f.write(path.join(f.cwd, `${module}.py`), shadowSource);
  for (const command of ['node', 'curl', 'jq', 'pip', 'pip3']) {
    assert.notEqual(spawnSync('/bin/bash', ['-c', 'command -v "$1"', '--', command], { env: f.env }).status, 0);
  }
  await f.launch();
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_replacement\n');
  assert.equal(f.read().provider['ieti-agents'].options.baseURL, f.baseURL);
  assert.deepEqual(f.state.requests, [{ path: '/course/v1/model-capabilities', authorization: 'Bearer ieti_sk_replacement' }]);
  for (const module of ['json', 'http']) assert.equal(fs.readFileSync(path.join(f.cwd, `${module}.py`), 'utf8'), shadowSource);
});

async function fixture(t, platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-opencode-global-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const scripts = path.join(root, 'downloaded scripts');
  const configRoot = path.join(root, 'config home');
  const temporary = path.join(root, 'temporary-files');
  fs.mkdirSync(cwd); fs.mkdirSync(scripts); fs.mkdirSync(temporary);
  const script = path.join(scripts, `set_agents_opencode.${platform}`);
  fs.copyFileSync(path.join(assets, path.basename(script)), script);
  const configPath = path.join(configRoot, 'opencode', 'opencode.json');
  const keyPath = path.join(configRoot, 'ieti-agents', 'agents_server_key');
  const state = { catalog: capabilities(), status: 200, requests: [], acceptedKeys: new Set(['ieti_sk_saved', 'ieti_sk_replacement']), hang: false, trickle: false };
  const server = http.createServer((req, res) => {
    state.requests.push({ path: req.url, authorization: req.headers.authorization });
    if (state.hang) return;
    if (state.trickle) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000000', Connection: 'keep-alive' });
      res.write('{');
      const timer = setInterval(() => res.write(' '), 100);
      res.once('close', () => clearInterval(timer));
      return;
    }
    const suppliedKey = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const status = state.status !== 200 ? state.status : state.acceptedKeys.has(suppliedKey) ? 200 : 401;
    const messages = { 401: 'Invalid API key.', 403: 'Account disabled.', 429: 'Too many requests.', 503: 'Provider temporarily unavailable.' };
    res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 302 ? { Location: '/elsewhere' } : {}) });
    res.end(JSON.stringify(status === 200 ? state.catalog : { error: { message: messages[status] || 'Rejected request.' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseURL = `http://127.0.0.1:${server.address().port}/course/v1`;
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replaceAll('__IETI_DEFAULT_BASE_URL__', baseURL));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: configRoot, TMPDIR: temporary, PROXY_AGENTS_BASE_URL: `${baseURL}/` };
  delete env.PROXY_AGENTS_KEY;
  delete env.PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS;
  if (platform === 'ps1') {
    // The PowerShell host creates its own startup cache even for an empty run.
    // Establish that baseline before checking files created by the installer.
    env.POWERSHELL_TELEMETRY_OPTOUT = '1';
    env.POWERSHELL_UPDATECHECK = 'Off';
    await run(powershell, ['-NoProfile', '-Command', 'exit 0'], { cwd, env, timeout: 15000 });
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(keyPath), false);
    assert.deepEqual(fs.readdirSync(temporary), []);
  }
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const launch = async (action = 'sync') => {
    const before = new Set(filesIn(root));
    const beforeDirectories = new Set(directoriesIn(root));
    const hostCache = new Map(filesIn(path.join(root, '.cache', 'powershell')).map(file => [file, fs.readFileSync(file)]));
    try {
      return platform === 'sh'
        ? await run('/bin/bash', [script, ...(action === 'uninstall' ? ['--uninstall'] : action === 'sync' ? ['--sync-only'] : [])], { cwd, env, timeout: 15000 })
        : await run(powershell, ['-NoProfile', '-File', script, ...(action === 'uninstall' ? ['-Uninstall'] : action === 'sync' ? ['-SyncOnly'] : [])], { cwd, env, timeout: 15000 });
    } finally {
      assertNoRuntimeFiles({ root, temporary, cwd, scripts, configRoot, configPath, keyPath }, before, beforeDirectories);
      for (const [file, contents] of hostCache) assert.deepEqual(fs.readFileSync(file), contents, 'Installer must preserve existing PowerShell host cache files.');
    }
  };
  const read = (file = configPath) => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { root, cwd, scripts, script, temporary, configRoot, configPath, keyPath, state, baseURL, env, write, read, launch };
}

async function expectFailure(f, pattern) {
  await assert.rejects(f.launch(), error => {
    assert.match(`${error.stdout}\n${error.stderr}`, pattern);
    assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /ieti_sk_(saved|replacement|invalid)/);
    return true;
  });
}

for (const platform of ['sh', 'ps1']) {
  const skip = platform === 'ps1' && !hasPowerShell && 'PowerShell is unavailable; set POWERSHELL_BIN to exercise native Windows-compatible flow.';

  test(`${platform}: updates global model capabilities while preserving unrelated settings and the saved key`, { skip }, async t => {
    const f = await fixture(t, platform);
    const original = {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        other: { npm: '@ai-sdk/openai-compatible', models: { keep: {} } },
        'ieti-agents': {
          custom_property: 'keep-me',
          options: { customOption: 'keep-me', baseURL: 'https://old.example/v1' },
          models: { obsolete: { name: 'Remove me' } }
        }
      },
      model: 'ieti-agents/obsolete',
      permission: { bash: 'ask' },
      mcp: { local: { type: 'local', command: ['example-mcp'] }, customDate: '2026-10-02T01:02:03+05:00' }
    };
    f.write(f.configPath, original); f.write(f.keyPath, 'ieti_sk_saved\n');
    const localConfig = '{"local":"untouched"}\n';
    f.write(path.join(f.cwd, 'opencode.json'), localConfig);
    f.write(path.join(f.scripts, 'opencode.json'), localConfig);
    f.state.catalog = capabilities([{
      id: 'vision/reasoner', context: 131072, output: 8192, image: true, tools: true, reasoning: true,
      parallelTools: true, reasoningEfforts: ['low', 'medium', 'xhigh'], defaultReasoningEffort: 'low'
    }]);

    const output = await f.launch();
    assert.match(output.stdout, /IETI API key validated/);
    assert.doesNotMatch(output.stdout + output.stderr, /ieti_sk_saved/);
    assert.deepEqual(f.state.requests, [{ path: '/course/v1/model-capabilities', authorization: 'Bearer ieti_sk_saved' }]);
    const config = f.read();
    assert.deepEqual(config.provider.other, original.provider.other);
    assert.deepEqual(config.permission, original.permission);
    assert.deepEqual(config.mcp, original.mcp);
    assert.equal(config.mcp.customDate, '2026-10-02T01:02:03+05:00');
    assert.equal(config.model, 'ieti-agents/vision/reasoner');
    const provider = config.provider['ieti-agents'];
    assert.equal(provider.custom_property, 'keep-me');
    assert.equal(provider.options.customOption, 'keep-me');
    assert.equal(provider.options.baseURL, f.baseURL);
    assert.equal(provider.options.apiKey, `{file:${f.keyPath.replaceAll('\\', '/')}}`);
    assert.deepEqual(Object.keys(provider.models), ['vision/reasoner']);
    assert.deepEqual(provider.models['vision/reasoner'].limit, { context: 131072, output: 8192 });
    assert.equal(provider.models['vision/reasoner'].tool_call, true);
    assert.deepEqual(provider.models['vision/reasoner'].interleaved, { field: 'reasoning_content' });
    assert.equal(provider.models['vision/reasoner'].options.reasoningEffort, 'low');
    assert.deepEqual(provider.models['vision/reasoner'].modalities.input, ['text', 'image']);
    assert.deepEqual(provider.models['vision/reasoner'].variants, {
      none: { disabled: true }, minimal: { disabled: true }, low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' }, high: { disabled: true }, xhigh: { reasoningEffort: 'xhigh' }, max: { disabled: true }
    });
    assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.keyPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'opencode.json'), 'utf8'), localConfig);
    assert.equal(fs.readFileSync(path.join(f.scripts, 'opencode.json'), 'utf8'), localConfig);
    assert.equal(fs.existsSync(path.join(f.cwd, '.secrets')), false);
    assert.equal(fs.existsSync(path.join(f.scripts, '.secrets')), false);

    delete f.env.PROXY_AGENTS_BASE_URL;
    f.state.catalog = capabilities([{ id: 'text', tools: false }]);
    await f.launch();
    assert.equal(f.read().model, 'ieti-agents/text');
    assert.deepEqual(Object.keys(f.read().provider['ieti-agents'].models), ['text']);
    assert.equal(f.read().provider['ieti-agents'].models.text.interleaved, undefined);
    assert.deepEqual(f.read().provider['ieti-agents'].models.text.variants, {});
  });

  test(`${platform}: first install stores a validated supplied key globally and keeps another provider as default`, { skip }, async t => {
    const f = await fixture(t, platform);
    f.write(f.configPath, { model: 'other/keep', provider: { other: { models: { keep: {} } } } });
    f.env.PROXY_AGENTS_KEY = 'ieti_sk_replacement';
    const output = await f.launch();
    assert.doesNotMatch(output.stdout + output.stderr, /ieti_sk_replacement/);
    assert.equal(f.read().model, 'other/keep');
    assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_replacement\n');
    assert.equal(fs.existsSync(path.join(f.cwd, 'opencode.json')), false);
    assert.equal(fs.existsSync(path.join(f.scripts, 'opencode.json')), false);
  });

  test(`${platform}: valid environment replacement is validated before replacing a saved key`, { skip }, async t => {
    const f = await fixture(t, platform);
    f.write(f.configPath, { permission: { bash: 'ask' } }); f.write(f.keyPath, 'ieti_sk_saved\n');
    f.env.PROXY_AGENTS_KEY = 'ieti_sk_replacement';
    await f.launch();
    assert.deepEqual(f.state.requests, [{ path: '/course/v1/model-capabilities', authorization: 'Bearer ieti_sk_replacement' }]);
    assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_replacement\n');
    assert.deepEqual(f.read().permission, { bash: 'ask' });
  });

  test(`${platform}: refreshing the same model clears obsolete reasoning and tool capabilities`, { skip }, async t => {
    const f = await fixture(t, platform);
    f.write(f.keyPath, 'ieti_sk_saved\n');
    f.state.catalog = capabilities([{ id: 'changing-model', reasoning: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]);
    await f.launch();
    assert.deepEqual(f.read().provider['ieti-agents'].models['changing-model'].interleaved, { field: 'reasoning_content' });
    f.state.catalog = capabilities([{ id: 'changing-model', reasoning: false, tools: false }]);
    await f.launch();
    const model = f.read().provider['ieti-agents'].models['changing-model'];
    assert.equal(model.interleaved, undefined);
    assert.equal(model.options, undefined);
    assert.deepEqual(model.variants, {});
    assert.equal(model.tool_call, false);
    assert.equal(model.reasoning, false);
  });

  test(`${platform}: failed replacement auth preserves original config and key bytes`, { skip }, async t => {
    const f = await fixture(t, platform);
    const original = '{"model":"other/keep","untouched":true}\n';
    f.write(f.configPath, original); f.write(f.keyPath, 'ieti_sk_saved\n');
    f.env.PROXY_AGENTS_KEY = 'ieti_sk_invalid';
    await expectFailure(f, /HTTP 401|[Ii]nvalid API key/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
  });

  test(`${platform}: account, rate and server errors preserve config without treating them as invalid keys`, { skip }, async t => {
    const f = await fixture(t, platform);
    const original = '{"untouched":true}\n';
    f.write(f.configPath, original); f.write(f.keyPath, 'ieti_sk_saved\n');
    for (const [status, pattern] of [[403, /HTTP 403|[Dd]isabled|[Ff]orbidden/], [429, /HTTP 429|[Rr]ate|[Tt]oo many/], [503, /HTTP 503|[Uu]navailable|[Ss]erver/]]) {
      f.state.status = status;
      await expectFailure(f, pattern);
      assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
      assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
    }
    assert.equal(f.state.requests.length, 3);
  });

  test(`${platform}: request timeout and network failure preserve previous files`, { skip }, async t => {
    const f = await fixture(t, platform);
    const original = '{"untouched":true}\n';
    f.write(f.configPath, original); f.write(f.keyPath, 'ieti_sk_saved\n');
    f.env.PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS = '1';
    f.state.hang = true;
    await expectFailure(f, /[Tt]imeout|[Tt]imed out/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
    const unusedPort = await new Promise(resolve => {
      const unused = http.createServer();
      unused.listen(0, '127.0.0.1', () => { const port = unused.address().port; unused.close(() => resolve(port)); });
    });
    f.env.PROXY_AGENTS_BASE_URL = `http://127.0.0.1:${unusedPort}/v1`;
    await expectFailure(f, /[Cc]onnect|[Nn]etwork|[Uu]navailable/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
  });

  test(`${platform}: total request timeout stops a continuously trickling response and preserves previous files`, { skip }, async t => {
    const f = await fixture(t, platform);
    const original = '{"untouched":true}\n';
    f.write(f.configPath, original); f.write(f.keyPath, 'ieti_sk_saved\n');
    f.env.PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS = '1';
    f.state.trickle = true;
    const started = Date.now();
    await expectFailure(f, /[Tt]imeout|[Tt]imed out/);
    // Include interpreter startup and cleanup time without turning host load
    // into a failure; a missing total deadline reaches the 15-second guard.
    assert.ok(Date.now() - started < 4000, 'A total request deadline must stop a persistent response that sends bytes before each socket timeout.');
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
  });

  test(`${platform}: invalid model catalogs do not commit replacement keys or configuration`, { skip }, async t => {
    const f = await fixture(t, platform);
    const original = '{"untouched":true}\n';
    f.write(f.configPath, original); f.write(f.keyPath, 'ieti_sk_saved\n');
    f.env.PROXY_AGENTS_KEY = 'ieti_sk_replacement';
    for (const catalog of [capabilities([]), capabilities([{ context: -1 }]), { ...capabilities(), schema_version: 2 }]) {
      f.state.catalog = catalog;
      await expectFailure(f, /models|metadata|catalog|capabilities/i);
      assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
      assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
    }
  });

  test(`${platform}: supports an existing JSONC file without creating a competing JSON configuration`, { skip }, async t => {
    const f = await fixture(t, platform);
    const jsonc = `${f.configPath}c`;
    f.write(jsonc, '{ // comment\n"mcp": {"url": "https://example.test/a,//b",}, "model": "ieti-agents/gone",\n}');
    f.write(f.keyPath, 'ieti_sk_saved\n');
    await f.launch();
    assert.equal(f.read(jsonc).mcp.url, 'https://example.test/a,//b');
    assert.equal(f.read(jsonc).model, 'ieti-agents/model-1');
    assert.equal(fs.existsSync(f.configPath), false);
    assert.equal(f.read(jsonc).provider['ieti-agents'].options.apiKey, `{file:${f.keyPath.replaceAll('\\', '/')}}`);
  });

  test(`${platform}: rejects ambiguous or malformed existing configuration before mutation`, { skip }, async t => {
    const f = await fixture(t, platform);
    f.env.PROXY_AGENTS_KEY = 'ieti_sk_replacement';
    f.write(f.configPath, '{"json":true}\n'); f.write(`${f.configPath}c`, '{"jsonc":true}\n');
    await expectFailure(f, /both|conflict|multiple|ambiguous/i);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), '{"json":true}\n');
    assert.equal(fs.readFileSync(`${f.configPath}c`, 'utf8'), '{"jsonc":true}\n');
    assert.equal(fs.existsSync(f.keyPath), false);
    fs.rmSync(`${f.configPath}c`);
    f.write(f.configPath, '{ broken');
    await expectFailure(f, /[Cc]annot|[Ii]nvalid|JSON|[Pp]ars/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), '{ broken');
    assert.equal(fs.existsSync(f.keyPath), false);
  });

  test(`${platform}: offline uninstall removes only IETI provider and model references`, { skip }, async t => {
    const f = await fixture(t, platform);
    const original = {
      provider: { 'ieti-agents': { models: { old: {} } }, other: { models: { keep: {} } } },
      model: 'ieti-agents/old', small_model: 'other/keep',
      enabled_providers: ['other', 'ieti-agents'], disabled_providers: ['ieti-agents', 'unused'],
      agent: { custom: { model: 'ieti-agents/old', temperature: 0.4 }, other: { model: 'other/keep' } },
      permission: { bash: 'ask' }
    };
    f.write(f.configPath, original); f.write(f.keyPath, 'ieti_sk_saved\n');
    f.write(path.join(f.configRoot, 'ieti-agents', 'keep.txt'), 'keep');
    f.env.PROXY_AGENTS_BASE_URL = 'unavailable-and-invalid';
    await f.launch('uninstall');
    const config = f.read();
    assert.deepEqual(config.provider, { other: original.provider.other });
    assert.equal(config.model, undefined);
    assert.equal(config.small_model, 'other/keep');
    assert.deepEqual(config.enabled_providers, ['other']);
    assert.deepEqual(config.disabled_providers, ['unused']);
    assert.deepEqual(config.agent.custom, { temperature: 0.4 });
    assert.deepEqual(config.agent.other, original.agent.other);
    assert.deepEqual(config.permission, original.permission);
    assert.equal(fs.existsSync(f.keyPath), false);
    assert.equal(fs.readFileSync(path.join(f.configRoot, 'ieti-agents', 'keep.txt'), 'utf8'), 'keep');
    assert.deepEqual(f.state.requests, []);
    const bytes = fs.readFileSync(f.configPath, 'utf8');
    await f.launch('uninstall');
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), bytes);
  });

  test(`${platform}: embedded script URL survives download substitution`, { skip }, async t => {
    const f = await fixture(t, platform);
    const script = fs.readFileSync(path.join(assets, path.basename(f.script)), 'utf8').replaceAll('__IETI_DEFAULT_BASE_URL__', `${f.baseURL}/`);
    f.write(f.script, script); f.write(f.keyPath, 'ieti_sk_saved\n');
    delete f.env.PROXY_AGENTS_BASE_URL;
    await f.launch();
    assert.equal(f.read().provider['ieti-agents'].options.baseURL, f.baseURL);
    assert.deepEqual(f.state.requests, [{ path: '/course/v1/model-capabilities', authorization: 'Bearer ieti_sk_saved' }]);
  });

  test(`${platform}: invalid URL or missing key leaves a fresh installation untouched`, { skip }, async t => {
    const f = await fixture(t, platform);
    f.env.PROXY_AGENTS_BASE_URL = 'not-a-url';
    f.env.PROXY_AGENTS_KEY = 'ieti_sk_replacement';
    await expectFailure(f, /HTTP\(S\)|invalid.*URL/i);
    assert.equal(fs.existsSync(f.configPath), false);
    assert.equal(fs.existsSync(f.keyPath), false);
    f.env.PROXY_AGENTS_BASE_URL = f.baseURL;
    delete f.env.PROXY_AGENTS_KEY;
    await expectFailure(f, /key|interactive/i);
    assert.equal(fs.existsSync(f.configPath), false);
    assert.equal(fs.existsSync(f.keyPath), false);
    assert.deepEqual(f.state.requests, []);
  });

  test(`${platform}: only updates global configuration and never launches a client or executes settings.env`, { skip }, async t => {
    const f = await fixture(t, platform);
    const bin = path.join(f.root, 'bin');
    const marker = path.join(f.root, 'must-not-exist');
    fs.mkdirSync(bin);
    f.write(path.join(bin, 'opencode'), '#!/bin/sh\ntouch "$CAPTURE_PATH"\n');
    fs.chmodSync(path.join(bin, 'opencode'), 0o755);
    f.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    f.env.CAPTURE_PATH = marker;
    f.env.OPENCODE_DESKTOP_BIN = path.join(bin, 'opencode');
    f.write(path.join(f.cwd, 'settings.env'), `UNSAFE_VALUE=$(touch '${marker}')\n`);
    f.write(path.join(f.scripts, 'settings.env'), `UNSAFE_VALUE=$(touch '${marker}')\n`);
    f.write(f.keyPath, 'ieti_sk_saved\n');
    await f.launch('default');
    assert.equal(fs.existsSync(marker), false);
  });
}
