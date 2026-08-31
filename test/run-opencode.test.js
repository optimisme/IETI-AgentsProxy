const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const execFileAsync = promisify(execFile);

function capabilities(models = [{}]) {
  return {
    object: 'ieti.model_capabilities.list',
    schema_version: 1,
    data: models.map((model, index) => ({
      id: model.id || `model-${index + 1}`,
      name: model.name,
      context_window: model.context || 32768,
      max_output_tokens: model.output || 8192,
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

async function startCapabilitiesServer(t, apiKey, models) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/model-capabilities' || req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key.' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(capabilities(models)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address();
}

function createLauncherDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'set_agents_opencode.sh');
  const keyDirectory = path.join(directory, '.secrets');
  const keyPath = path.join(keyDirectory, 'agents_server_key');
  fs.mkdirSync(keyDirectory, { mode: 0o700 });
  fs.writeFileSync(keyPath, 'ieti_sk_default\n', { mode: 0o600 });
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'set_agents_opencode.sh'), script);
  fs.chmodSync(script, 0o755);
  return { directory, script, configPath: path.join(directory, 'opencode.json'), keyPath };
}

test('set_agents_opencode updates only the IETI provider models and preserves the rest of opencode.json', async (t) => {
  const { directory, script, configPath, keyPath } = createLauncherDirectory(t, 'ieti-set-agents-server-');
  fs.writeFileSync(configPath, `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      existing: { npm: '@ai-sdk/openai-compatible', models: { keep: {} } },
      'ieti-agents': {
        custom_property: 'keep-me',
        options: { customOption: 'keep-me', baseURL: 'https://old.example/v1' },
        models: { 'removed-model': { name: 'Remove me' } }
      }
    },
    model: 'ieti-agents/removed-model',
    permission: { bash: 'ask' },
    mcp: { local: { type: 'local', command: ['example-mcp'] } }
  }, null, 2)}\n`);

  const address = await startCapabilitiesServer(t, 'ieti_sk_test_valid', [{
    id: 'active-model', name: 'Active model', context: 32768, output: 8192,
    image: true, tools: true, reasoning: true, parallelTools: true,
    reasoningEfforts: ['low', 'medium', 'xhigh'], defaultReasoningEffort: 'low',
    chatTemplateKwargs: true
  }]);
  fs.writeFileSync(keyPath, 'ieti_sk_test_valid\n');

  const result = await execFileAsync('bash', [script, '--sync-only'], {
    env: { ...process.env, PROXY_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1` }
  });
  assert.match(result.stdout, /IETI API key validated/);
  assert.doesNotMatch(result.stdout, /Paste your IETI Agents API key/);

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.provider.existing.models, { keep: {} });
  assert.deepEqual(config.permission, { bash: 'ask' });
  assert.deepEqual(config.mcp, { local: { type: 'local', command: ['example-mcp'] } });
  assert.equal(config.model, 'ieti-agents/active-model');
  assert.equal(config.provider['ieti-agents'].custom_property, 'keep-me');
  assert.equal(config.provider['ieti-agents'].options.customOption, 'keep-me');
  assert.equal(config.provider['ieti-agents'].options.apiKey, '{file:.secrets/agents_server_key}');
  assert.deepEqual(Object.keys(config.provider['ieti-agents'].models), ['active-model']);
  assert.equal(config.provider['ieti-agents'].models['active-model'].limit.context, 32768);
  assert.equal(config.provider['ieti-agents'].models['active-model'].limit.output, 8192);
  assert.equal(config.provider['ieti-agents'].models['active-model'].tool_call, true);
  assert.equal(config.provider['ieti-agents'].models['active-model'].reasoning, true);
  assert.equal(config.provider['ieti-agents'].models['active-model'].options.reasoningEffort, 'low');
  assert.deepEqual(config.provider['ieti-agents'].models['active-model'].variants, {
    none: { disabled: true },
    minimal: { disabled: true },
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { disabled: true },
    xhigh: { reasoningEffort: 'xhigh' },
    max: { disabled: true }
  });
  assert.deepEqual(config.provider['ieti-agents'].models['active-model'].modalities.input, ['text', 'image']);
  assert.equal(fs.existsSync(path.join(directory, '.opencode', 'ieti-models.json')), false);
});

test('set_agents_opencode reuses the provider base URL from opencode.json', async (t) => {
  const { directory, script, configPath, keyPath } = createLauncherDirectory(t, 'ieti-set-agents-server-config-url-');
  const address = await startCapabilitiesServer(t, 'ieti_sk_default', [{ id: 'config-url-model' }]);
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  fs.writeFileSync(configPath, `${JSON.stringify({
    provider: { 'ieti-agents': { options: { baseURL } } }
  }, null, 2)}\n`);

  const result = await execFileAsync('bash', [script, '--sync-only'], {
    env: { ...process.env, PROXY_AGENTS_BASE_URL: '' }
  });

  assert.match(result.stdout, /IETI API key validated/);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.provider['ieti-agents'].options.baseURL, baseURL);
  assert.equal(fs.existsSync(path.join(directory, 'settings.env')), false);
});

test('set_agents_opencode stores the base URL in opencode.json without creating settings.env', async (t) => {
  const { script, configPath, directory, keyPath } = createLauncherDirectory(t, 'ieti-set-agents-server-first-run-');
  const address = await startCapabilitiesServer(t, 'ieti_sk_default', [{
    id: 'first-model', context: 64000, output: 4000, tools: true
  }]);

  const result = await execFileAsync('bash', [script, '--sync-only'], {
    env: {
      ...process.env,
      PROXY_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1`
    }
  });

  assert.doesNotMatch(result.stdout, /settings\.env/);
  assert.equal(fs.existsSync(path.join(directory, 'settings.env')), false);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), 'ieti_sk_default\n');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.model, 'ieti-agents/first-model');
  assert.deepEqual(Object.keys(config.provider['ieti-agents'].models), ['first-model']);
});

test('set_agents_opencode leaves an existing settings.env untouched', async (t) => {
  const { script, directory } = createLauncherDirectory(t, 'ieti-set-agents-server-incomplete-settings-');
  const address = await startCapabilitiesServer(t, 'ieti_sk_default', [{ id: 'completed-model' }]);
  const settingsPath = path.join(directory, 'settings.env');
  const originalSettings = 'OPENAI_API_KEY=keep-this-value\nPROXY_AGENTS_KEY=ieti_sk_legacy\n';
  fs.writeFileSync(settingsPath, originalSettings);

  const result = await execFileAsync('bash', [script, '--sync-only'], {
    env: {
      ...process.env,
      PROXY_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1`
    }
  });

  assert.doesNotMatch(result.stdout, /settings\.env/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalSettings);
});

test('set_agents_opencode rejects an invalid key without changing opencode.json', async (t) => {
  const { script, configPath, keyPath } = createLauncherDirectory(t, 'ieti-set-agents-server-invalid-');
  fs.writeFileSync(configPath, '{"untouched":true}\n');
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key.' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  fs.writeFileSync(keyPath, 'ieti_sk_invalid\n');

  await assert.rejects(
    execFileAsync('bash', [script, '--sync-only'], {
      env: { ...process.env, PROXY_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1` }
    }),
    (error) => {
      assert.match(error.stdout, /HTTP 401.*Invalid API key/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"untouched":true}\n');
});

test('set_agents_opencode rejects an invalid first-run base URL without creating settings.env', async (t) => {
  const { script, directory } = createLauncherDirectory(t, 'ieti-set-agents-server-invalid-url-');
  await assert.rejects(
    execFileAsync('bash', [script, '--sync-only'], {
      env: {
        ...process.env,
        PROXY_AGENTS_BASE_URL: 'not-a-url',
      }
    }),
    (error) => {
      assert.match(error.stdout, /PROXY_AGENTS_BASE_URL must be a valid HTTP\(S\) base URL/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(directory, 'settings.env')), false);
});

test('set_agents_opencode only updates configuration and never starts OpenCode', async (t) => {
  const { directory, script } = createLauncherDirectory(t, 'ieti-set-agents-server-no-launch-');
  const binDirectory = path.join(directory, 'bin');
  const capturePath = path.join(directory, 'unexpected-opencode-launch');
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(
    path.join(binDirectory, 'opencode'),
    '#!/bin/sh\ntouch "$CAPTURE_PATH"\n'
  );
  fs.chmodSync(path.join(binDirectory, 'opencode'), 0o755);
  const address = await startCapabilitiesServer(t, 'ieti_sk_default', [{ id: 'configured-model' }]);
  await execFileAsync('bash', [script], {
    env: {
      ...process.env,
      PROXY_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      PATH: `${binDirectory}:${process.env.PATH}`,
      CAPTURE_PATH: capturePath
    }
  });

  assert.equal(fs.existsSync(capturePath), false);
});

test('set_agents_opencode does not open OpenCode by default', async (t) => {
  const { directory, script } = createLauncherDirectory(t, 'ieti-set-agents-server-no-desktop-');
  const desktopPath = path.join(directory, 'fake-opencode-desktop');
  const capturePath = path.join(directory, 'desktop-invocations');
  fs.writeFileSync(desktopPath, '#!/bin/sh\nprintf "<%s>\\n" "$*" >> "$CAPTURE_PATH"\n');
  fs.chmodSync(desktopPath, 0o755);
  const address = await startCapabilitiesServer(t, 'ieti_sk_default', [{ id: 'desktop-model' }]);
  await execFileAsync('bash', [script], {
    env: {
      ...process.env,
      PROXY_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      CAPTURE_PATH: capturePath,
      OPENCODE_DESKTOP_BIN: desktopPath
    }
  });

  assert.equal(fs.existsSync(capturePath), false);
});

test('set_agents_opencode does not read settings.env as executable input', async (t) => {
  const { directory, script } = createLauncherDirectory(t, 'ieti-set-agents-server-safe-settings-');
  const marker = path.join(directory, 'must-not-exist');
  const address = await startCapabilitiesServer(t, 'ieti_sk_default', [{ id: 'safe-model' }]);
  fs.writeFileSync(path.join(directory, 'settings.env'), [
    `PROXY_AGENTS_BASE_URL=http://127.0.0.1:${address.port}/v1`,
    `UNSAFE_VALUE=$(touch ${marker})`,
    ''
  ].join('\n'));

  await execFileAsync('bash', [script, '--sync-only'], {
    env: { ...process.env, PROXY_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1` }
  });
  assert.equal(fs.existsSync(marker), false);
});

test('PowerShell configuration script uses the key file and never opens OpenCode', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'assets', 'set_agents_opencode.ps1'), 'utf8');
  assert.match(script, /\$WorkingDirectory = \(Get-Location\)\.Path/);
  assert.match(script, /Join-Path \$WorkingDirectory '\.secrets'/);
  assert.match(script, /agents_server_key/);
  assert.match(script, /if \(-not \(Test-Path -LiteralPath \$KeyFile\)\)/);
  assert.match(script, /Read-Host 'Paste your IETI Agents API key'/);
  assert.match(script, /apiKey: '\{file:\.secrets\/agents_server_key\}'/);
  assert.match(script, /config\.provider\['ieti-agents'\]/);
  assert.match(script, /canonicalReasoningEfforts/);
  assert.match(script, /reasoningEffort: defaultReasoningEffort/);
  assert.match(script, /Read-ConfigBaseUrl/);
  assert.doesNotMatch(script, /SettingsFile|Read-SettingValue|settings\.env/);
  assert.doesNotMatch(script, /EnvironmentVariable\([^)]*PROXY_AGENTS_KEY|apiKey: '\{env:PROXY_AGENTS_KEY\}'|OpenCodeArguments|opencode:\/\/|Get-Command opencode|OpenCode desktop/);
  assert.doesNotMatch(script, /OPENCODE_MODELS_PATH|ieti-models\.json|models\.dev/);
});
