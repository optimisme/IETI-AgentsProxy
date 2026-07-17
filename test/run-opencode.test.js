const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const execFileAsync = promisify(execFile);

function modelsDevCatalog() {
  return {
    existing: {
      id: 'existing',
      name: 'Existing provider',
      env: ['EXISTING_API_KEY'],
      npm: '@ai-sdk/openai-compatible',
      models: {
        keep: {
          id: 'keep',
          name: 'Keep',
          release_date: '2025-01-01',
          attachment: false,
          reasoning: false,
          temperature: true,
          tool_call: true,
          limit: { context: 16000, output: 2000 }
        }
      }
    }
  };
}

test('run_opencode validates the key and creates a merged Models.dev catalog', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-run-opencode-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const script = path.join(directory, 'run_opencode.sh');
  const configPath = path.join(directory, 'opencode.json');
  fs.copyFileSync(path.join(__dirname, '..', 'run_opencode.sh'), script);
  fs.writeFileSync(configPath, `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { existing: { npm: '@ai-sdk/openai-compatible', models: { keep: {} } } },
    model: 'ieti-agents/removed-model',
    permission: { bash: 'ask' }
  }, null, 2)}\n`);

  const server = http.createServer((req, res) => {
    if (req.url === '/api.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(modelsDevCatalog()));
      return;
    }
    if (req.url !== '/v1/model-capabilities' || req.headers.authorization !== 'Bearer ieti_sk_test_valid') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key.' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'ieti.model_capabilities.list',
      schema_version: 1,
      data: [{
        id: 'active-model',
        context_window: 32768,
        max_output_tokens: 8192,
        capabilities: { text: true, image: true, tools: true, reasoning: true, parallel_tools: true },
        modalities: { input: ['text', 'image'], output: ['text'] }
      }]
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  fs.writeFileSync(
    path.join(directory, 'run_opencode_settings.env'),
    `PROXY_AGENTS_BASE_URL=http://127.0.0.1:${address.port}/v1\nPROXY_AGENTS_KEY=ieti_sk_test_valid\n`
  );
  const result = await execFileAsync('bash', [script, '--sync-only'], {
    env: {
      ...process.env,
      IETI_MODELS_DEV_API_URL: `http://127.0.0.1:${address.port}/api.json`
    }
  });
  assert.match(result.stdout, /IETI API key validated/);

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.provider.existing.models, { keep: {} });
  assert.deepEqual(config.permission, { bash: 'ask' });
  assert.equal(config.model, 'ieti-agents/active-model');
  assert.equal(config.provider['ieti-agents'].options.apiKey, '{env:PROXY_AGENTS_KEY}');
  assert.equal(config.provider['ieti-agents'].models, undefined);

  const merged = JSON.parse(fs.readFileSync(path.join(directory, '.opencode', 'ieti-models.json'), 'utf8'));
  assert.equal(merged.existing.models.keep.name, 'Keep');
  assert.equal(merged['ieti-agents'].api, `http://127.0.0.1:${address.port}/v1`);
  assert.equal(merged['ieti-agents'].models['active-model'].limit.context, 32768);
  assert.equal(merged['ieti-agents'].models['active-model'].limit.output, 8192);
  assert.equal(merged['ieti-agents'].models['active-model'].tool_call, true);
  assert.equal(merged['ieti-agents'].models['active-model'].reasoning, true);
  assert.deepEqual(merged['ieti-agents'].models['active-model'].modalities.input, ['text', 'image']);
  assert.equal(fs.statSync(path.join(directory, '.opencode', 'ieti-models.json')).mode & 0o777, 0o600);
});

test('run_opencode creates run_opencode_settings.env only after first-run settings are accepted', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-run-opencode-first-run-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const script = path.join(directory, 'run_opencode.sh');
  fs.copyFileSync(path.join(__dirname, '..', 'run_opencode.sh'), script);

  const server = http.createServer((req, res) => {
    if (req.url === '/api.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(modelsDevCatalog()));
      return;
    }
    if (req.url !== '/v1/model-capabilities' || req.headers.authorization !== 'Bearer ieti_sk_first_run') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key.' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'ieti.model_capabilities.list',
      schema_version: 1,
      data: [{
        id: 'first-model',
        context_window: 64000,
        max_output_tokens: 4000,
        capabilities: { text: true, image: false, tools: true, reasoning: false, parallel_tools: false },
        modalities: { input: ['text'], output: ['text'] }
      }]
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await execFileAsync('bash', [script, '--sync-only'], {
    env: {
      ...process.env,
      PROXY_AGENTS_KEY: 'ieti_sk_first_run',
      PROXY_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      IETI_MODELS_DEV_API_URL: `http://127.0.0.1:${address.port}/api.json`
    }
  });

  assert.match(result.stdout, /Created .*run_opencode_settings\.env with permissions 600/);
  assert.equal(
    fs.readFileSync(path.join(directory, 'run_opencode_settings.env'), 'utf8'),
    `PROXY_AGENTS_BASE_URL=http://127.0.0.1:${address.port}/v1\nPROXY_AGENTS_KEY=ieti_sk_first_run\n`
  );
  assert.equal(fs.statSync(path.join(directory, 'run_opencode_settings.env')).mode & 0o777, 0o600);
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'opencode.json'), 'utf8'));
  assert.equal(config.model, 'ieti-agents/first-model');
  assert.equal(config.provider['ieti-agents'].models, undefined);
  const merged = JSON.parse(fs.readFileSync(path.join(directory, '.opencode', 'ieti-models.json'), 'utf8'));
  assert.deepEqual(merged['ieti-agents'].models['first-model'].modalities.input, ['text']);
});

test('run_opencode rejects an invalid key without changing opencode.json', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-run-opencode-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const script = path.join(directory, 'run_opencode.sh');
  const configPath = path.join(directory, 'opencode.json');
  fs.copyFileSync(path.join(__dirname, '..', 'run_opencode.sh'), script);
  fs.writeFileSync(configPath, '{"untouched":true}\n');

  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key.' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  fs.writeFileSync(
    path.join(directory, 'run_opencode_settings.env'),
    `PROXY_AGENTS_BASE_URL=http://127.0.0.1:${address.port}/v1\nPROXY_AGENTS_KEY=ieti_sk_invalid\n`
  );
  await assert.rejects(
    execFileAsync('bash', [script, '--sync-only'], {
      env: { ...process.env }
    }),
    (error) => {
      assert.match(error.stdout, /HTTP 401.*Invalid API key/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"untouched":true}\n');
});

test('run_opencode rejects an invalid first-run base URL without creating settings', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-run-opencode-invalid-url-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const script = path.join(directory, 'run_opencode.sh');
  fs.copyFileSync(path.join(__dirname, '..', 'run_opencode.sh'), script);

  await assert.rejects(
    execFileAsync('bash', [script, '--sync-only'], {
      env: {
        ...process.env,
        PROXY_AGENTS_BASE_URL: 'not-a-url',
        PROXY_AGENTS_KEY: 'ieti_sk_not_saved'
      }
    }),
    (error) => {
      assert.match(error.stdout, /PROXY_AGENTS_BASE_URL must be a valid HTTP\(S\) base URL/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(directory, 'run_opencode_settings.env')), false);
});

test('run_opencode launches OpenCode with the generated catalog path', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-run-opencode-launch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const script = path.join(directory, 'run_opencode.sh');
  const binDirectory = path.join(directory, 'bin');
  const capturePath = path.join(directory, 'captured-path');
  fs.copyFileSync(path.join(__dirname, '..', 'run_opencode.sh'), script);
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(
    path.join(binDirectory, 'opencode'),
    '#!/bin/sh\nprintf "%s" "$OPENCODE_MODELS_PATH" > "$CAPTURE_PATH"\n'
  );
  fs.chmodSync(path.join(binDirectory, 'opencode'), 0o755);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api.json') {
      res.end(JSON.stringify(modelsDevCatalog()));
      return;
    }
    res.end(JSON.stringify({
      object: 'ieti.model_capabilities.list',
      schema_version: 1,
      data: [{
        id: 'launch-model',
        context_window: 32000,
        max_output_tokens: 4000,
        capabilities: { text: true, image: false, tools: true, reasoning: false, parallel_tools: false },
        modalities: { input: ['text'], output: ['text'] }
      }]
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  fs.writeFileSync(
    path.join(directory, 'run_opencode_settings.env'),
    `PROXY_AGENTS_BASE_URL=http://127.0.0.1:${address.port}/v1\nPROXY_AGENTS_KEY=ieti_sk_launch\n`
  );
  await execFileAsync('bash', [script], {
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      CAPTURE_PATH: capturePath,
      IETI_MODELS_DEV_API_URL: `http://127.0.0.1:${address.port}/api.json`
    }
  });

  assert.equal(fs.readFileSync(capturePath, 'utf8'), path.join(directory, '.opencode', 'ieti-models.json'));
});
