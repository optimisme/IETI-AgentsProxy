const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const execFileAsync = promisify(execFile);
const projectDirectory = path.join(__dirname, '..');

test('set_harness_buildlite installs archive contents at project root and links .opencode to .agents', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-buildlite-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const archive = fs.readFileSync(path.join(projectDirectory, 'assets', 'buildlite_harness.zip'));
  const server = http.createServer((req, res) => {
    if (req.url !== '/buildlite_harness.zip') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.end(archive);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const script = path.join(directory, 'set_harness_buildlite.sh');
  const scriptSource = fs.readFileSync(path.join(projectDirectory, 'assets', 'set_harness_buildlite.sh'), 'utf8')
    .replace('__IETI_BUILD_LITE_ZIP_URL__', `http://127.0.0.1:${server.address().port}/buildlite_harness.zip`);
  fs.writeFileSync(script, scriptSource, { mode: 0o755 });

  const result = await execFileAsync('bash', [script], { cwd: directory });
  assert.match(result.stdout, /BuildLite harness installed/);
  assert.equal(fs.existsSync(path.join(directory, 'buildlite_harness.zip')), false);
  assert.equal(fs.existsSync(path.join(directory, 'buildlite_harness')), false);
  assert.equal(fs.existsSync(path.join(directory, 'AGENTS.md')), true);
  assert.equal(fs.existsSync(path.join(directory, '.agents', 'agents', 'build_lite.md')), true);
  assert.equal(fs.lstatSync(path.join(directory, '.opencode')).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(directory, '.opencode')), '.agents');

  await execFileAsync('bash', [script], { cwd: directory });
  assert.equal(fs.readlinkSync(path.join(directory, '.opencode')), '.agents');
});

test('set_harness_buildlite leaves opencode.json unchanged in non-interactive runs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-buildlite-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const archive = fs.readFileSync(path.join(projectDirectory, 'assets', 'buildlite_harness.zip'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.end(archive);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'ieti-agents/active-model',
    provider: { custom: { options: { keep: true } } },
    permission: { edit: 'ask' }
  };
  fs.writeFileSync(path.join(directory, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`);
  const script = path.join(directory, 'set_harness_buildlite.sh');
  const scriptSource = fs.readFileSync(path.join(projectDirectory, 'assets', 'set_harness_buildlite.sh'), 'utf8')
    .replace('__IETI_BUILD_LITE_ZIP_URL__', `http://127.0.0.1:${server.address().port}/buildlite_harness.zip`);
  fs.writeFileSync(script, scriptSource, { mode: 0o755 });

  await execFileAsync('bash', [script], { cwd: directory });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'opencode.json'), 'utf8')), config);
});

test('set_harness_buildlite PowerShell script creates a Windows directory junction', () => {
  const script = fs.readFileSync(path.join(projectDirectory, 'assets', 'set_harness_buildlite.ps1'), 'utf8');
  assert.match(script, /Expand-Archive/);
  assert.match(script, /buildlite_harness/);
  assert.match(script, /Copy-Item -LiteralPath \$Item\.FullName/);
  assert.match(script, /mklink \/J/);
  assert.match(script, /\.opencode/);
  assert.match(script, /\.agents/);
  assert.match(script, /Remove-Item -LiteralPath \$ArchiveFile/);
  assert.match(script, /__IETI_BUILD_LITE_ZIP_URL__/);
  assert.match(script, /default_agent.*build_lite/);
  assert.match(script, /Set Build_lite as the default OpenCode agent/);
});
