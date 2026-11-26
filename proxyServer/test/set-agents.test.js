const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const run = promisify(execFile);
const assets = path.join(__dirname, '..', 'assets');
const python = spawnSync('python3', ['-I', '-B', '-c', 'import pty, sys; print(sys.executable)'], { encoding: 'utf8' }).stdout?.trim();
const catalog = {
  object: 'ieti.model_capabilities.list', schema_version: 1,
  data: [{ id: 'configured-model', context_window: 32768, max_output_tokens: 8192,
    capabilities: { text: true, image: false, tools: true, reasoning: false, parallel_tools: false },
    reasoning_efforts: [], default_reasoning_effort: null }]
};

function bashGenerator() {
  const bash = fs.readFileSync(path.join(assets, 'set_agents_opencode.sh'), 'utf8');
  return bash.match(/GLOBAL_SCRIPT <<'PYTHON' \|\| true\r?\n([\s\S]*?)\r?\nPYTHON/)[1];
}

// The helper exists in Python (inside the script) and in Perl (its own file). Every
// scenario below runs through both: how to start each one with an operation's arguments.
const perlHelper = path.join(assets, 'set_agents_helper.pl');
const perl = spawnSync('perl', ['-e', 'exit($] >= 5.016 ? 0 : 1)']).status === 0 && spawnSync('curl', ['--version']).status === 0 ? 'perl' : '';
const helpers = [
  ...(python ? [{ name: 'python', command: python, prefix: () => ['-I', '-B', '-c', bashGenerator()] }] : []),
  ...(perl ? [{ name: 'perl', command: perl, prefix: () => [perlHelper] }] : [])
];
const RUNTIMES = helpers.map(helper => helper.name);

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

// The child owns a terminal so the installer follows its actual interactive flow.
// Send each answer only after its prompt appears, including hidden key input.
const terminalDriver = `
import errno, fcntl, json, os, pty, select, signal, subprocess, sys, termios, time
master, slave = pty.openpty()
def claim_terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
child = subprocess.Popen(['/bin/bash', sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, preexec_fn=claim_terminal)
os.close(slave)
answers = json.loads(sys.argv[2])
output = bytearray()
cursor = 0
deadline = time.monotonic() + 15
def read_output():
    if select.select([master], [], [], 0.1)[0]:
        try:
            part = os.read(master, 65536)
            output.extend(part)
            return bool(part)
        except OSError as error:
            if error.errno != errno.EIO: raise
            return False
    return True
try:
    for prompt, answer in answers:
        needle = prompt.encode()
        while needle not in output[cursor:]:
            if time.monotonic() > deadline or not read_output():
                raise RuntimeError('Installer did not display prompt: ' + prompt)
        cursor = output.index(needle, cursor) + len(needle)
        time.sleep(0.05)
        if answer is None: os.write(master, b'\x03')
        else: os.write(master, answer.encode())
    while child.poll() is None:
        if time.monotonic() > deadline:
            raise RuntimeError('Installer did not finish after receiving answers')
        read_output()
    while read_output():
        if not select.select([master], [], [], 0)[0]: break
finally:
    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
    child.wait()
    os.close(master)
    sys.stdout.write(output.decode(errors='replace'))
sys.exit(child.returncode)
`;

async function fixture(t, runtime = 'python') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-opencode-interactive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const configRoot = path.join(root, 'config home');
  const scripts = path.join(root, 'downloads');
  const temporary = path.join(root, 'temporary-files');
  fs.mkdirSync(cwd); fs.mkdirSync(scripts); fs.mkdirSync(temporary);
  const configPath = path.join(configRoot, 'opencode', 'opencode.json');
  const keyPath = path.join(configRoot, 'ieti-agents', 'agents_server_key');
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push(req.headers.authorization);
    const accepted = ['Bearer ieti_sk_saved', 'Bearer ieti_sk_replacement'].includes(req.headers.authorization);
    res.writeHead(accepted ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(accepted ? catalog : { error: { message: 'Invalid API key.' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const script = path.join(scripts, 'set_agents_opencode.sh');
  fs.writeFileSync(script, fs.readFileSync(path.join(assets, 'set_agents_opencode.sh'), 'utf8').replaceAll('__IETI_DEFAULT_BASE_URL__', baseURL));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: configRoot, TMPDIR: temporary };
  delete env.PROXY_AGENTS_KEY; delete env.PROXY_AGENTS_BASE_URL; delete env.PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS; env.IETI_OPENCODE_VERSION = '2';
  // Pin the helper under test. The Perl one sits next to the script, as in a checkout.
  env.IETI_SETUP_RUNTIME = runtime;
  if (runtime === 'perl') fs.copyFileSync(perlHelper, path.join(scripts, 'set_agents_helper.pl'));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  };
  const launch = async answers => {
    const before = new Set(filesIn(root));
    const beforeDirectories = new Set(directoriesIn(root));
    try {
      return await run(python, ['-I', '-B', '-c', terminalDriver, script, JSON.stringify(answers)], { cwd, env, timeout: 20000 });
    } finally {
      assert.deepEqual(fs.readdirSync(temporary), [], 'Cancelled and completed installs must remove temporary files.');
      const allowed = new Set([configPath, `${configPath}c`, `${configPath}.bak`, `${configPath}c.bak`, keyPath]);
      for (const file of filesIn(root)) {
        assert.ok(before.has(file) || allowed.has(file), `Unexpected runtime file: ${path.relative(root, file)}`);
        assert.doesNotMatch(path.relative(root, file), /(?:^|\/)(?:__pycache__|\.venv)(?:\/|$)|\.tmp\./);
      }
      const configuredDirectories = new Set([configRoot, path.dirname(configPath), path.dirname(keyPath)]);
      for (const directory of directoriesIn(root)) {
        if (beforeDirectories.has(directory)) continue;
        assert.ok(configuredDirectories.has(directory), `Unexpected runtime folder: ${path.relative(root, directory)}`);
        assert.ok(filesIn(directory).length > 0, `Empty setup folder was left behind: ${path.relative(root, directory)}`);
      }
      assert.equal(fs.readdirSync(cwd).some(name => name === '__pycache__' || name === '.venv'), false);
    }
  };
  return { root, cwd, script, configPath, keyPath, state, baseURL, env, write, launch };
}

for (const runtime of RUNTIMES) test(`interactive first install confirms the embedded server URL and hides API key input [${runtime}]`, { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t, runtime);
  const result = await f.launch([
    ['IETI Agents base URL [', '\n'],
    ['Paste your IETI Agents API key:', 'ieti_sk_replacement\n']
  ]);
  assert.match(result.stdout, new RegExp(f.baseURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stdout + result.stderr, /ieti_sk_replacement/);
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_replacement\n');
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).providers['ieti-agents'].settings.baseURL, f.baseURL);
  assert.deepEqual(f.state.requests, ['Bearer ieti_sk_replacement']);
});

for (const runtime of RUNTIMES) test(`interactive server URL confirmation accepts a different server before validation [${runtime}]`, { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t, runtime);
  f.write(f.script, fs.readFileSync(f.script, 'utf8').replaceAll(f.baseURL, 'https://embedded.example.test/v1'));
  const result = await f.launch([
    ['IETI Agents base URL [', `${f.baseURL}/\n`],
    ['Paste your IETI Agents API key:', 'ieti_sk_replacement\n']
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /ieti_sk_replacement/);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).providers['ieti-agents'].settings.baseURL, f.baseURL);
  assert.deepEqual(f.state.requests, ['Bearer ieti_sk_replacement']);
});

for (const runtime of RUNTIMES) test(`interactive update defaults to update and keeping a validated saved key [${runtime}]`, { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t, runtime);
  f.write(f.configPath, { provider: { 'ieti-agents': { models: { obsolete: {} } } }, model: 'ieti-agents/obsolete', permission: { bash: 'ask' } });
  f.write(f.keyPath, 'ieti_sk_saved\n');
  const result = await f.launch([
    ['Update or uninstall?', '\n'],
    ['IETI Agents base URL [', '\n'],
    ['Keep or replace?', '\n']
  ]);
  assert.doesNotMatch(result.stdout, /Paste your IETI Agents API key/);
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
  const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.equal(config.model, 'ieti-agents/configured-model');
  assert.deepEqual(config.permission, { bash: 'ask' });
  assert.deepEqual(f.state.requests, ['Bearer ieti_sk_saved']);
});

for (const runtime of RUNTIMES) test(`interactive valid key replacement is checked before saving it [${runtime}]`, { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t, runtime);
  f.write(f.configPath, { provider: { 'ieti-agents': {} } }); f.write(f.keyPath, 'ieti_sk_saved\n');
  const result = await f.launch([
    ['Update or uninstall?', 'update\n'],
    ['IETI Agents base URL [', '\n'],
    ['Keep or replace?', 'replace\n'],
    ['Paste your IETI Agents API key:', 'ieti_sk_replacement\n']
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /ieti_sk_replacement/);
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_replacement\n');
  assert.deepEqual(f.state.requests, ['Bearer ieti_sk_saved', 'Bearer ieti_sk_replacement']);
});

for (const runtime of RUNTIMES) test(`interactive failed replacement leaves the previous config and key untouched [${runtime}]`, { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t, runtime);
  const original = '{"provider":{"ieti-agents":{}},"keep":true}\n';
  f.write(f.configPath, original); f.write(f.keyPath, 'ieti_sk_saved\n');
  await assert.rejects(f.launch([
    ['Update or uninstall?', '\n'],
    ['IETI Agents base URL [', '\n'],
    ['Keep or replace?', 'replace\n'],
    ['Paste your IETI Agents API key:', 'ieti_sk_invalid\n'],
    ['API key is invalid', ''],
    ['Paste your IETI Agents API key:', null]
  ]), error => {
    assert.doesNotMatch(error.stderr, /Traceback|Installer did not/, error.stdout);
    assert.match(error.stdout + error.stderr, /HTTP 401|Invalid API key|API key is invalid/);
    assert.match(error.stdout, /Setup cancelled/);
    assert.doesNotMatch(error.stdout + error.stderr, /ieti_sk_invalid/);
    return true;
  });
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
  assert.deepEqual(f.state.requests, ['Bearer ieti_sk_saved', 'Bearer ieti_sk_invalid']);
});

for (const runtime of RUNTIMES) test(`interactive invalid saved key asks for a new one instead of offering to keep it [${runtime}]`, { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t, runtime);
  f.write(f.configPath, { provider: { 'ieti-agents': {} } }); f.write(f.keyPath, 'ieti_sk_expired\n');
  const result = await f.launch([
    ['Update or uninstall?', '\n'],
    ['IETI Agents base URL [', '\n'],
    ['Paste your IETI Agents API key:', 'ieti_sk_replacement\n']
  ]);
  assert.doesNotMatch(result.stdout, /Keep or replace/);
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_replacement\n');
  assert.deepEqual(f.state.requests, ['Bearer ieti_sk_expired', 'Bearer ieti_sk_replacement']);
});

for (const runtime of RUNTIMES) test(`interactive uninstall completes without server URL confirmation or key validation [${runtime}]`, { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t, runtime);
  f.write(f.configPath, { provider: { 'ieti-agents': {}, other: { models: { keep: {} } } }, model: 'ieti-agents/old' });
  f.write(f.keyPath, 'ieti_sk_saved\n');
  const result = await f.launch([['Update or uninstall?', 'uninstall\n']]);
  assert.doesNotMatch(result.stdout, /IETI Agents base URL|Keep or replace|Paste your/);
  assert.equal(fs.existsSync(f.keyPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).provider, { other: { models: { keep: {} } } });
  assert.deepEqual(f.state.requests, []);
});

test('PowerShell uses built-in APIs, secure key prompts, unattended actions, and request timeouts', () => {
  const script = fs.readFileSync(path.join(assets, 'set_agents_opencode.ps1'), 'utf8');
  assert.match(script, /\[switch\]\$SyncOnly/);
  assert.match(script, /\[switch\]\$Uninstall/);
  assert.match(script, /XDG_CONFIG_HOME/);
  assert.match(script, /ieti-agents/);
  assert.match(script, /agents_server_key/);
  assert.match(script, /-AsSecureString/);
  assert.match(script, /PROXY_AGENTS_KEY/);
  assert.match(script, /PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS/);
  assert.match(script, /Keep or replace/);
  assert.match(script, /Update or uninstall/);
  assert.doesNotMatch(script, /Get-Command opencode|opencode:\/\/|OPENCODE_DESKTOP_BIN|\.secrets|settings\.env/);
  assert.doesNotMatch(script, /\$mergeScript|node:fs|require\(|Get-Command\s+(?:node|python3?|curl|chmod)\b|&\s+(?:node|python3?|curl|chmod)\b/i);
});

test('Bash uses Python standard library, or Perl with curl, without Node or package dependencies', async () => {
  const script = fs.readFileSync(path.join(assets, 'set_agents_opencode.sh'), 'utf8');
  assert.match(script, /command -v python3/);
  assert.match(script, /python3 -I -B -c/);
  assert.doesNotMatch(script, /command -v\s+(?:node|jq|pip3?)\b|\$\((?:node|jq|pip3?)\b|\n\s*(?:node|jq|pip3?)\b/);
  // curl is only reached on the Perl path: to find out whether it can be used, and to fetch the helper.
  assert.deepEqual(script.match(/^.*\bcurl\b.*$/gm).filter(line => !/^\s*#/.test(line)).map(line => line.trim().slice(0, 40)), [
    'command -v perl >/dev/null 2>&1 && comma', "echo 'Error: this setup needs Python 3.9", 'if ! PERL_SCRIPT="$(curl -fsSL --connect'
  ]);
  // The setup command refuses downloads over 64 KiB, so the script must stay under it.
  assert.ok(Buffer.byteLength(script) < 60000, 'set_agents_opencode.sh must stay well under the 65536-byte download limit');
  const helper = fs.readFileSync(perlHelper, 'utf8');
  assert.ok(Buffer.byteLength(helper) < 131072);
  assert.match(helper, /^# IETI Agents setup helper \(Perl\)\n/);
  assert.ok(helper.endsWith(';\n}\n') && !helper.endsWith('\n\n'), 'The helper ends with exactly one newline: its fingerprint is taken that way.');
  // Only modules that come with Perl itself, and no other program than curl.
  assert.deepEqual([...helper.matchAll(/^use ([A-Za-z:0-9]+)/gm)].map(match => match[1]).sort(),
    ['Cwd', 'Encode', 'Fcntl', 'IPC::Open2', 'MIME::Base64', 'POSIX', 'strict', 'warnings']);
  assert.doesNotMatch(helper, /`|\bsystem\s*\(|\bexec\s*\(|\bqx\b|\beval\s+"|\brequire\s+[A-Za-z]/);
  assert.equal(helper.match(/open2\(/g).length, 1);
  const imported = await run(python, ['-I', '-B', '-c', [
    'import ast, json, sys',
    'tree = ast.parse(sys.argv[1], feature_version=(3, 9))',
    'modules = {alias.name.split(".")[0] for item in ast.walk(tree) if isinstance(item, ast.Import) for alias in item.names}',
    'modules.update(item.module.split(".")[0] for item in ast.walk(tree) if isinstance(item, ast.ImportFrom) and item.module)',
    'stdlib = getattr(sys, "stdlib_module_names", {"argparse", "atexit", "base64", "collections", "concurrent", "contextlib", "errno", "hashlib", "http", "json", "math", "os", "pathlib", "queue", "re", "secrets", "select", "shutil", "signal", "socket", "ssl", "stat", "sys", "tempfile", "threading", "time", "urllib", "uuid"})',
    'print(json.dumps(sorted(modules - stdlib - set(sys.builtin_module_names))))'
  ].join('\n'), bashGenerator()]);
  assert.deepEqual(JSON.parse(imported.stdout), [], 'The installer must only import Python standard library modules.');
});

test('configuration edits made while the user confirms setup are preserved', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-opencode-concurrent-edit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [index, helper] of helpers.entries()) {
    const call = (...args) => run(helper.command, [...helper.prefix(), ...args]);
    const directory = path.join(root, `platform-${index}`);
    fs.mkdirSync(directory);
    const configPath = path.join(directory, 'opencode.json');
    const catalogPath = path.join(directory, 'capabilities.json');
    const preparedPath = path.join(directory, 'prepared.json');
    const keyPath = path.join(directory, 'agents_server_key');
    const candidatePath = path.join(directory, 'replacement-key');
    const manifestPath = path.join(directory, 'transaction.json');
    fs.writeFileSync(configPath, '{"permission":{"bash":"ask"}}\n');
    fs.writeFileSync(keyPath, 'ieti_sk_saved\n');
    fs.writeFileSync(candidatePath, 'ieti_sk_replacement\n');
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    await call('prepare', configPath, catalogPath, preparedPath, 'https://proxy.example.test/v1', keyPath, 'update');
    const edited = '{"permission":{"bash":"deny"},"newSetting":"keep"}\n';
    fs.writeFileSync(configPath, edited);
    await assert.rejects(call('stage', configPath, preparedPath, keyPath, candidatePath, manifestPath, 'update'), error => {
      assert.match(error.stdout + error.stderr, /changed during|changed since|modified/i);
      return true;
    });
    assert.equal(fs.readFileSync(configPath, 'utf8'), edited);
    assert.equal(fs.readFileSync(keyPath, 'utf8'), 'ieti_sk_saved\n');
    assert.equal(fs.existsSync(`${configPath}.bak`), false);
    assert.equal(fs.readdirSync(directory).some(filename => filename.includes('.tmp.')), false);
  }
});

for (const helper of helpers) test(`a saved key changed during validation is preserved instead of overwritten [${helper.name}]`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-opencode-concurrent-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const call = (...args) => run(helper.command, [...helper.prefix(), ...args]);
  const configPath = path.join(root, 'opencode.json');
  const catalogPath = path.join(root, 'capabilities.json');
  const preparedPath = path.join(root, 'prepared.json');
  const keyPath = path.join(root, 'agents_server_key');
  const candidatePath = path.join(root, 'replacement-key');
  const manifestPath = path.join(root, 'transaction.json');
  const originalConfig = '{"permission":{"bash":"ask"}}\n';
  fs.writeFileSync(configPath, originalConfig);
  fs.writeFileSync(keyPath, 'ieti_sk_saved\n');
  fs.writeFileSync(candidatePath, 'ieti_sk_replacement\n');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  await call('snapshot-key', keyPath, `${preparedPath}.key-source`);
  fs.writeFileSync(keyPath, 'ieti_sk_concurrent_change\n');
  await call('prepare', configPath, catalogPath, preparedPath, 'https://proxy.example.test/v1', keyPath, 'update');
  await assert.rejects(call('stage', configPath, preparedPath, keyPath, candidatePath, manifestPath, 'update'), error => {
    assert.match(error.stdout + error.stderr, /changed during|changed since|modified/i);
    return true;
  });
  assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), 'ieti_sk_concurrent_change\n');
  assert.equal(fs.existsSync(`${configPath}.bak`), false);
  assert.equal(fs.readdirSync(root).some(filename => filename.includes('.tmp.')), false);
});

// ---- The two helpers must behave as one ----------------------------------------------------

const catalogModel = (id, extra = {}) => ({ id, context_window: 32768, max_output_tokens: 8192,
  capabilities: { text: true, image: false, tools: true, reasoning: false, parallel_tools: false }, reasoning_efforts: [], default_reasoning_effort: null, ...extra });
const catalogOf = (data, extra = {}) => JSON.stringify({ object: 'ieti.model_capabilities.list', schema_version: 1, data, ...extra });
const reasoningModel = { capabilities: { text: true, image: true, tools: true, reasoning: true, parallel_tools: true },
  reasoning_efforts: ['high', 'low', 'bogus', 3, 'none'], default_reasoning_effort: 'low' };
const CATALOGS = {
  reasoning: catalogOf([catalogModel('Qwen38', reasoningModel),
    catalogModel('team/model:tag', { modalities: { input: ['text', 'image', 'video', 'smell', 7], output: ['text'] }, context_window: 75000.0, max_output_tokens: '4096' }),
    catalogModel('default-not-supported', { ...reasoningModel, default_reasoning_effort: 'max' })]),
  floats: catalogOf([catalogModel('float-limits', { context_window: 1000.5, max_output_tokens: 2.5e3 }), catalogModel('big', { context_window: 1e21, max_output_tokens: 123456789012345680000 })]),
  unicode: catalogOf([catalogModel('modèle-ü-😀'), catalogModel('  spaced  ')]),
  bom: '﻿' + catalogOf([catalogModel('with-bom')]),
  empty: catalogOf([]), wrongObject: JSON.stringify({ object: 'x', schema_version: 1, data: [catalogModel('a')] }),
  versionFloat: '{"object":"ieti.model_capabilities.list","schema_version":1.0,"data":[{"id":"a"}]}', versionTwo: catalogOf([catalogModel('a')], { schema_version: 2 }),
  duplicate: catalogOf([catalogModel('a'), catalogModel('a')]), noId: catalogOf([catalogModel('')]), idNumber: catalogOf([catalogModel(5)]),
  zeroLimit: catalogOf([catalogModel('a', { context_window: 0 })]), boolLimit: catalogOf([catalogModel('a', { context_window: true })]),
  nullLimit: catalogOf([catalogModel('a', { max_output_tokens: null })]), wordLimit: catalogOf([catalogModel('a', { context_window: 'lots' })]),
  badCapabilities: catalogOf([catalogModel('a', { capabilities: { text: true, image: 1, tools: true, reasoning: false, parallel_tools: false } })]),
  notObject: catalogOf(['x']), invalidJson: '{"object": ', notUtf8: Buffer.from([0x7b, 0xff, 0x7d])
};
const CONFIGS = {
  missing: null, empty: '', emptyObject: '{}', whitespace: ' \n{ }\n',
  comments: '// top\n{\n  /* block\n comment */ "model": "anthropic/claude", // trailing\n  "list": [1, 2, 3,],\n  "url": "http://x/y//z /* not a comment */",\n  "nested": {"a": {"b": [],},},\n}\n',
  openCode1: JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { 'ieti-agents': { npm: 'old', name: 'Old', options: { baseURL: 'http://old', apiKey: 'k', headers: { 'X-A': 'b' }, timeout: 5 }, models: { obsolete: {} }, extra: [1, { a: null }] }, other: { models: { keep: {} } } },
    model: 'ieti-agents/obsolete', small_model: 'ieti-agents/obsolete', enabled_providers: ['other'], disabled_providers: ['ieti-agents', 'x'],
    agent: { build: { model: 'ieti-agents/obsolete', temperature: 0.2 }, plan: { model: 'other/keep' }, odd: 3 }, permission: { bash: 'ask' } }),
  openCode2: '{"providers":{"ieti-agents":{"name":"x","canonical":"c","env":["E"],"headers":{"h":"1"},"body":{"b":2},"compatibility":{"z":true},"settings":{"baseURL":"old","custom":[1.5,-0,1e3,1.0,100000000000000000000,0.1,1e-7,-2.50,1E+2],"apiKey":"old","chunkTimeout":1},"models":{"configured-model":{}},"junk":1}},"model":"ieti-agents/configured-model","enabled_providers":["ieti-agents"]}',
  both: JSON.stringify({ provider: { 'ieti-agents': { options: { extraOne: 1, baseURL: 'a' } } }, providers: { 'ieti-agents': { settings: { extraTwo: 2, timeout: 3 } } }, model: 'other/model' }),
  onlyIeti: JSON.stringify({ provider: { 'ieti-agents': {} }, providers: { 'ieti-agents': 5 }, model: 7, $schema: '' }),
  text: '{"título": "caf\\u00e9 \\ud83d\\ude00 \\u0000 \\u007f é 😀", "tab\\tkey": "line\\nbreak \\"quoted\\" back\\\\slash \\/ \\b\\f\\r", "ordered": {"z": 1, "10": 2, "2": 3, "a": 4}, "dup": 1, "dup": 2, "numbers": [0, -0, 0.0, -0.0, 1e0, 12345678901234567890, 1.7976931348623157e308, 5e-324, 0.30000000000000004, 123456.789e3, 1e16, 1e15, 0.0001, 0.00001]}',
  bom: '﻿{"model": "x/y"}', crlf: '{\r\n  "provider": {"ieti-agents": {"models": {}}},\r\n  // note\r\n  "keep": true\r\n}\r\n',
  array: '[1,2]', scalar: '"text"', invalid: '{"a": }', trailingGarbage: '{} x', unterminatedComment: '{} /* open', nan: '{"a": NaN}', infinity: '{"a": -Infinity}',
  hugeFloat: '{"a": 1e999}', controlCharacter: '{"a": "line\nbreak"}', badEscape: '{"a": "\\x"}', notUtf8: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])
};

test('the Python and Perl helpers write exactly the same files and answers for the same input', { skip: helpers.length < 2 && 'Both Python 3 and Perl with curl are required.' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-opencode-helpers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'case');
  const at = name => path.join(directory, name);
  // What an operation leaves behind: its exit status and output, and every file with its mode and bytes.
  // Only the wording after "Error:" for unreadable input may differ; the bookkeeping files hold the same facts in each helper's own notation.
  const wording = /: line \d+ column \d+ \(char \d+\)|Expecting[^\n]*|Invalid (?:control character|\\escape)[^\n]*|Extra data[^\n]*|Unterminated string[^\n]*|'utf-8' codec[^\n]*|The file is not valid UTF-8 text\.|\[Errno \d+\] [^\n]*|(?:No such file or directory|Is a directory|Not a directory|Permission denied)[^\n]*|Expected a file at [^\n]*|'idna' codec[^\n]*|Base URL host name[^\n]*/g;
  const listing = folder => fs.readdirSync(folder).sort().flatMap(name => {
    const file = path.join(folder, name), stats = fs.statSync(file), mode = (stats.mode & 0o777).toString(8);
    if (stats.isDirectory()) return [`${name}/ ${mode}`, ...listing(file).map(line => `${name}/${line}`)];
    return /^(?:prepared\.json|second\.json)\.(?:source|key-source)$|^transaction\d?\.json$/.test(name) ? [] : [`${name} ${mode} ${fs.readFileSync(file).toString('base64')}`];
  });
  const outcome = (helper, files, steps) => {
    fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory);
    for (const [name, value] of Object.entries(files)) {
      if (value === null) continue;
      fs.mkdirSync(path.dirname(at(name)), { recursive: true });
      fs.writeFileSync(at(name), value);
      if (name === 'key') fs.chmodSync(at(name), 0o644);
    }
    const log = steps.map(args => {
      const result = spawnSync(helper.command, [...helper.prefix(), ...args], { cwd: directory, encoding: 'utf8',
        env: { ...process.env, HOME: directory, PATH: '/usr/bin:/bin', XDG_STATE_HOME: '', XDG_DATA_HOME: '' } });
      return `${args[0]} -> ${result.status} | ${result.stdout} | ${result.stderr.replace(wording, '<detail>')}`;
    });
    return [...log, ...listing(directory)].join('\n').replace(/\.tmp\.(rollback\.)?[0-9a-f]{32}/g, '.tmp.$1<id>');
  };
  let compared = 0;
  const same = (label, files, steps) => {
    const [first, second] = helpers.map(helper => outcome(helper, files, steps));
    compared += 1;
    if (first === second) return;
    const left = first.split('\n'), right = second.split('\n');
    const index = left.findIndex((line, position) => line !== right[position]);
    const readable = line => (line || '').replace(/ ([A-Za-z0-9+/=]{24,})$/, (_, bytes) => ' ' + JSON.stringify(Buffer.from(bytes, 'base64').toString('utf8')));
    assert.fail(`${label}: the helpers differ.\n  ${helpers[0].name}: ${readable(left[index]).slice(0, 1500)}\n  ${helpers[1].name}: ${readable(right[index]).slice(0, 1500)}`);
  };
  const update = (major, config = 'opencode.json', key = 'key', prepared = 'prepared.json', transaction = 'transaction.json') => [
    ['inspect-config', at(config)],
    ['snapshot-key', at(key), at(`${prepared}.key-source`)],
    ['prepare', at(config), at('capabilities.json'), at(prepared), 'https://proxy.example.test/v1', at(key), 'update', major],
    ['stage', at(config), at(prepared), at(key), at('candidate'), at(transaction), 'update'],
    ['commit', at(transaction)],
    ['model-count', at(prepared)]
  ];
  const uninstall = [
    ['snapshot-key', at('key'), at('prepared.json.key-source')],
    ['prepare', at('opencode.json'), 'unused', at('prepared.json'), 'unused', at('key'), 'uninstall'],
    ['stage', at('opencode.json'), at('prepared.json'), at('key'), 'unused', at('transaction.json'), 'uninstall'],
    ['commit', at('transaction.json')]
  ];
  const keys = { key: 'ieti_sk_saved\n', candidate: 'ieti_sk_new\n' };
  // Every kind of existing configuration, in both OpenCode formats, and removing the setup from each.
  for (const [name, config] of Object.entries(CONFIGS)) {
    for (const major of ['1', '2']) same(`update ${name} for OpenCode ${major}`, { 'opencode.json': config, 'capabilities.json': CATALOGS.reasoning, ...keys }, update(major));
    same(`uninstall ${name}`, { 'opencode.json': config, key: 'ieti_sk_saved\n' }, uninstall);
  }
  // Every kind of catalog the server could answer with, into an existing configuration of each format.
  for (const [name, capabilities] of Object.entries(CATALOGS)) {
    for (const [major, config] of [['1', CONFIGS.openCode1], ['2', CONFIGS.openCode2]]) {
      same(`catalog ${name} for OpenCode ${major}`, { 'opencode.json': config, 'capabilities.json': capabilities, ...keys }, update(major));
    }
  }
  // A first install creates its folders; running it again with the same key changes nothing.
  same('first install, then again', { 'capabilities.json': CATALOGS.reasoning, candidate: 'ieti_sk_new\n' }, [
    ...update('2', 'home/opencode/opencode.json', 'home/ieti-agents/key'),
    ...update('2', 'home/opencode/opencode.json', 'home/ieti-agents/key', 'second.json', 'transaction2.json'),
    ['read-key', at('home/ieti-agents/key')], ['cleanup', at('transaction2.json')]
  ]);
  for (const [name, body] of Object.entries({ nested: '{"error":{"message":"Bad key ieti_sk_secret123 here"}}', flat: '{"message":"flat"}', empty: '{}', notJson: 'oops', text: '{"error":"text"}', number: '{"error":{"message":42}}', list: '[1]' })) {
    same(`server error ${name}`, { body }, [['error', at('body')]]);
  }
  for (const address of ['https://Agents.IETI.site', 'http://host:80/v1/', 'https://host:8443/api', 'http://[::1]:3000', 'https://host/a b/ü', 'ftp://x', 'https://u:p@host',
    'https://host/v1?x=1', 'host/v1', 'https://host:99999', 'https://host:abc', ' https://host/v1// ', 'https://host/v1#', 'HTTPS://HOST:443/V1', 'https://', 'http://a..b/']) {
    same(`address ${address}`, {}, [['normalize', address]]);
  }
  for (const requested of ['1', '2', '3', '']) same(`OpenCode version ${requested || 'detected'}`, {}, [['detect-opencode', requested]]);
  same('OpenCode 2 service', { '.local/state/opencode/service.json': '{"version":"2.3.1"}' }, [['detect-opencode', '']]);
  same('OpenCode desktop versions', Object.fromEntries(['1.9.9', '2.10.0', '2.9.9', 'junk'].map(version => [`Library/Application Support/ai.opencode.desktop/cli/${version}/keep`, ''])), [['detect-opencode', '']]);
  same('OpenCode binary', { '.opencode/bin/opencode': Buffer.concat([Buffer.alloc(5000, 1), Buffer.from(' --user-agent=opencode/latest/1.4.2 ')]) }, [['detect-opencode', '']]);
  same('OpenCode binary without a version', { '.opencode/bin/opencode': 'no version here' }, [['detect-opencode', '']]);
  for (const value of ['relative/path', '/a/b/../c/./d//e/', '.', '/', '../up']) same(`absolute ${value}`, {}, [['absolute', value]]);
  same('unknown operation', {}, [['nope']]);
  same('configuration is a folder', { 'opencode.json/inside': '' }, [['inspect-config', at('opencode.json')]]);
  assert.ok(compared >= 140, `${compared} scenarios compared`);
});

// ---- Choosing the helper, and fetching the Perl one --------------------------------------------

async function unattended(t, { helperSource = fs.readFileSync(perlHelper), fingerprint } = {}) {
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-opencode-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/downloads/set_agents_helper.pl') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(helperSource); }
    const accepted = req.headers.authorization === 'Bearer ieti_sk_saved';
    res.writeHead(accepted ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(accepted ? catalog : { error: { message: 'Invalid API key.' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  // As the proxy serves it: the server address and the helper's fingerprint filled in. The
  // script is run as text, the way the setup command does, so no helper sits next to it.
  const script = fs.readFileSync(path.join(assets, 'set_agents_opencode.sh'), 'utf8')
    .replaceAll('__IETI_DEFAULT_BASE_URL__', baseURL)
    .replace('__IETI_HELPER_SHA256__', fingerprint || crypto.createHash('sha256').update(fs.readFileSync(perlHelper)).digest('hex'));
  const configRoot = path.join(root, 'config home');
  const configPath = path.join(configRoot, 'opencode', 'opencode.json');
  const keyPath = path.join(configRoot, 'ieti-agents', 'agents_server_key');
  const temporary = path.join(root, 'tmp'); fs.mkdirSync(temporary);
  const start = (env = {}) => new Promise(resolve => {
    const child = execFile('/bin/bash', ['-c', script], { cwd: root, timeout: 20000,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: configRoot, TMPDIR: temporary, PROXY_AGENTS_KEY: 'ieti_sk_saved', IETI_OPENCODE_VERSION: '2', ...env } },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end();
  });
  // A folder holding only the named programs, to run the script as on a machine without the others.
  const pathWith = (...programs) => {
    const bin = fs.mkdtempSync(path.join(root, 'bin-'));
    for (const program of programs) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${program}`], { encoding: 'utf8' }).stdout.trim();
      if (found) fs.symlinkSync(found, path.join(bin, program));
    }
    return bin;
  };
  return { root, configPath, keyPath, temporary, requests, baseURL, start, pathWith };
}
const TOOLS = ['bash', 'cat', 'chmod', 'dirname', 'mktemp', 'rm', 'uname', 'env'];

test('without Python the setup fetches the Perl helper from its own server, checks it, and installs', { skip: !perl && 'Perl with curl is required.' }, async t => {
  const f = await unattended(t);
  const result = await f.start({ PATH: f.pathWith(...TOOLS, 'perl', 'curl') });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /IETI API key validated\. Updated global .* with 1 available model\(s\)\./);
  assert.deepEqual(f.requests, ['/downloads/set_agents_helper.pl', '/v1/model-capabilities']);
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_saved\n');
  assert.equal(fs.statSync(f.keyPath).mode & 0o777, 0o600);
  const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.equal(config.model, 'ieti-agents/configured-model');
  assert.equal(config.providers['ieti-agents'].settings.baseURL, f.baseURL);
  assert.deepEqual(fs.readdirSync(f.temporary), []);
  assert.doesNotMatch(result.stdout + result.stderr, /ieti_sk_saved/);
});

test('with Python the setup never fetches the Perl helper, and both leave the same configuration', { skip: helpers.length < 2 && 'Both Python 3 and Perl with curl are required.' }, async t => {
  const withPython = await unattended(t);
  const first = await withPython.start();
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(withPython.requests, ['/v1/model-capabilities']);
  const withPerl = await unattended(t);
  const second = await withPerl.start({ IETI_SETUP_RUNTIME: 'perl' });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const portable = (f) => fs.readFileSync(f.configPath, 'utf8').replaceAll(f.root, '<home>').replaceAll(f.baseURL, '<server>');
  assert.equal(portable(withPerl), portable(withPython));
});

test('a Perl helper that is not the one the setup expects is refused before anything is written', { skip: !perl && 'Perl with curl is required.' }, async t => {
  for (const options of [
    { fingerprint: '0'.repeat(64) },
    { helperSource: `${fs.readFileSync(perlHelper, 'utf8')}print "tampered";\n` },
    { helperSource: '<html>captive portal</html>\n' }
  ]) {
    const f = await unattended(t, options);
    const result = await f.start({ IETI_SETUP_RUNTIME: 'perl' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /does not match the one this setup expects\. Nothing was changed\./);
    assert.doesNotMatch(result.stdout, /tampered/);
    assert.deepEqual(f.requests, ['/downloads/set_agents_helper.pl']);
    assert.equal(fs.existsSync(f.configPath) || fs.existsSync(f.keyPath), false);
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  }
});

test('the setup explains what to install when neither Python nor Perl with curl is available', async t => {
  const f = await unattended(t);
  for (const programs of [TOOLS, [...TOOLS, 'perl'], [...TOOLS, 'curl']]) {
    const result = await f.start({ PATH: f.pathWith(...programs) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Error: this setup needs Python 3\.9 or newer, or Perl 5\.16 or newer together with curl\./);
    if (process.platform === 'darwin') assert.match(result.stderr, /xcode-select --install/);
    assert.deepEqual(f.requests, []);
    assert.equal(fs.existsSync(f.configPath), false);
  }
  const unknown = await f.start({ IETI_SETUP_RUNTIME: 'ruby' });
  assert.match(unknown.stderr, /IETI_SETUP_RUNTIME must be python or perl/);
});

test("on a Mac without Apple's developer tools, Python's placeholder is never run and Perl is used", { skip: (process.platform !== 'darwin' || !perl) && 'Needs macOS with Perl and curl.' }, async t => {
  const f = await unattended(t);
  // /usr/bin/python3 is Apple's placeholder: it exists, and running it without the developer
  // tools opens the install dialog. A stand-in xcode-select reports that they are missing.
  const bin = f.pathWith(...TOOLS, 'perl', 'curl');
  fs.writeFileSync(path.join(bin, 'xcode-select'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
  const ran = path.join(f.root, 'python-was-run');
  fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, { mode: 0o755 });
  // The placeholder is recognised by its place in /usr/bin, so that is where python3 must be found first.
  assert.equal(spawnSync('/bin/sh', ['-c', 'PATH=/usr/bin command -v python3'], { encoding: 'utf8' }).stdout.trim(), '/usr/bin/python3');
  fs.rmSync(path.join(bin, 'python3'));
  const result = await f.start({ PATH: `/usr/bin:${bin}` });
  // /usr/bin also has the real xcode-select; put the stand-in first without hiding /usr/bin/python3.
  const standIn = await f.start({ PATH: `${path.join(f.root, 'first')}:/usr/bin:${bin}` });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(standIn.code, 0, standIn.stdout + standIn.stderr);
});
