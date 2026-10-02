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

async function fixture(t) {
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
  delete env.PROXY_AGENTS_KEY; delete env.PROXY_AGENTS_BASE_URL; delete env.PROXY_AGENTS_REQUEST_TIMEOUT_SECONDS;
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

test('interactive first install confirms the embedded server URL and hides API key input', { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t);
  const result = await f.launch([
    ['IETI Agents base URL [', '\n'],
    ['Paste your IETI Agents API key:', 'ieti_sk_replacement\n']
  ]);
  assert.match(result.stdout, new RegExp(f.baseURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stdout + result.stderr, /ieti_sk_replacement/);
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'ieti_sk_replacement\n');
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).provider['ieti-agents'].options.baseURL, f.baseURL);
  assert.deepEqual(f.state.requests, ['Bearer ieti_sk_replacement']);
});

test('interactive server URL confirmation accepts a different server before validation', { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t);
  f.write(f.script, fs.readFileSync(f.script, 'utf8').replaceAll(f.baseURL, 'https://embedded.example.test/v1'));
  const result = await f.launch([
    ['IETI Agents base URL [', `${f.baseURL}/\n`],
    ['Paste your IETI Agents API key:', 'ieti_sk_replacement\n']
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /ieti_sk_replacement/);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).provider['ieti-agents'].options.baseURL, f.baseURL);
  assert.deepEqual(f.state.requests, ['Bearer ieti_sk_replacement']);
});

test('interactive update defaults to update and keeping a validated saved key', { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t);
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

test('interactive valid key replacement is checked before saving it', { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t);
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

test('interactive failed replacement leaves the previous config and key untouched', { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t);
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

test('interactive invalid saved key asks for a new one instead of offering to keep it', { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t);
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

test('interactive uninstall completes without server URL confirmation or key validation', { skip: !python && 'Python with pty is required.' }, async t => {
  const f = await fixture(t);
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

test('Bash uses Python standard library without Node or package dependencies', async () => {
  const script = fs.readFileSync(path.join(assets, 'set_agents_opencode.sh'), 'utf8');
  assert.match(script, /command -v python3/);
  assert.match(script, /python3 -I -B -c/);
  assert.doesNotMatch(script, /command -v\s+(?:node|curl|jq|pip3?)\b|\$\((?:node|curl|jq|pip3?)\b|\n\s*(?:node|curl|jq|pip3?)\b/);
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
  for (const [index, program] of [bashGenerator()].entries()) {
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
    await run(python, ['-I', '-B', '-c', program, 'prepare', configPath, catalogPath, preparedPath, 'https://proxy.example.test/v1', keyPath, 'update']);
    const edited = '{"permission":{"bash":"deny"},"newSetting":"keep"}\n';
    fs.writeFileSync(configPath, edited);
    await assert.rejects(run(python, ['-I', '-B', '-c', program, 'stage', configPath, preparedPath, keyPath, candidatePath, manifestPath, 'update']), error => {
      assert.match(error.stdout + error.stderr, /changed during|changed since|modified/i);
      return true;
    });
    assert.equal(fs.readFileSync(configPath, 'utf8'), edited);
    assert.equal(fs.readFileSync(keyPath, 'utf8'), 'ieti_sk_saved\n');
    assert.equal(fs.existsSync(`${configPath}.bak`), false);
    assert.equal(fs.readdirSync(directory).some(filename => filename.includes('.tmp.')), false);
  }
});

test('a saved key changed during validation is preserved instead of overwritten', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-opencode-concurrent-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const program = bashGenerator();
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
  await run(python, ['-I', '-B', '-c', program, 'snapshot-key', keyPath, `${preparedPath}.key-source`]);
  fs.writeFileSync(keyPath, 'ieti_sk_concurrent_change\n');
  await run(python, ['-I', '-B', '-c', program, 'prepare', configPath, catalogPath, preparedPath, 'https://proxy.example.test/v1', keyPath, 'update']);
  await assert.rejects(run(python, ['-I', '-B', '-c', program, 'stage', configPath, preparedPath, keyPath, candidatePath, manifestPath, 'update']), error => {
    assert.match(error.stdout + error.stderr, /changed during|changed since|modified/i);
    return true;
  });
  assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), 'ieti_sk_concurrent_change\n');
  assert.equal(fs.existsSync(`${configPath}.bak`), false);
  assert.equal(fs.readdirSync(root).some(filename => filename.includes('.tmp.')), false);
});
