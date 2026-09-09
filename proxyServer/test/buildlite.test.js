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

async function installerFixture(t, archivePath = path.join(projectDirectory, 'assets', 'buildlite_harness.zip')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-buildlite-regression-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archive = fs.readFileSync(archivePath);
  const server = http.createServer((_req, res) => res.end(archive));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const script = path.join(directory, 'install.sh');
  fs.writeFileSync(script,
    fs.readFileSync(path.join(projectDirectory, 'assets', 'set_harness_buildlite.sh'), 'utf8')
      .replace('__IETI_BUILD_LITE_ZIP_URL__', `http://127.0.0.1:${server.address().port}/harness.zip`));
  return { directory, run: () => execFileAsync('bash', [script], { cwd: directory }) };
}

test('BuildLite preserves project instructions and updates only its managed block', async (t) => {
  const { directory, run } = await installerFixture(t);
  const instructions = path.join(directory, 'AGENTS.md');
  const original = '# Project rules\r\n\r\nUse npm test. Keep the café label.';
  fs.writeFileSync(instructions, original);
  await run();
  const installed = fs.readFileSync(instructions, 'utf8');
  assert.ok(installed.startsWith(original + '\n\n'));
  assert.equal(installed.split('<!-- buildlite:start -->').length, 2);
  await run();
  assert.equal(fs.readFileSync(instructions, 'utf8'), installed);

  const suffix = '\n# More project rules\nKeep these too.\n';
  fs.writeFileSync(instructions, installed.replace(
    /<!-- buildlite:start -->[\s\S]*?<!-- buildlite:end -->/,
    '<!-- buildlite:start -->\nOld harness instructions\n<!-- buildlite:end -->') + suffix);
  await run();
  assert.equal(fs.readFileSync(instructions, 'utf8'), installed + suffix);
});

test('BuildLite installation preserves existing task state and does not ship session state', async (t) => {
  const { directory, run } = await installerFixture(t);
  const stateDirectory = path.join(directory, '.agents', 'state');
  fs.mkdirSync(stateDirectory, { recursive: true });
  const statePath = path.join(stateDirectory, 'existing-task.md');
  const state = '# Existing task\nA1: pending\nRecovery rounds: 2\n';
  fs.writeFileSync(statePath, state);
  await run();
  assert.equal(fs.readFileSync(statePath, 'utf8'), state);
  assert.deepEqual(fs.readdirSync(stateDirectory), ['existing-task.md']);
  await run();
  assert.equal(fs.readFileSync(statePath, 'utf8'), state);

  const fresh = await installerFixture(t);
  await fresh.run();
  assert.equal(fs.existsSync(path.join(fresh.directory, '.agents', 'state')), false);
});

test('BuildLite replaces the exact legacy harness while preserving customized legacy instructions', async (t) => {
  const { directory, run } = await installerFixture(t);
  const instructions = path.join(directory, 'AGENTS.md');
  const legacy = fs.readFileSync(path.join(__dirname, 'fixtures', 'buildlite-legacy-AGENTS.md'), 'utf8');
  fs.writeFileSync(instructions, legacy);
  await run();
  const updated = fs.readFileSync(instructions, 'utf8');
  assert.ok(updated.startsWith('<!-- buildlite:start -->'));
  assert.doesNotMatch(updated, /create the empty file first/);
  assert.equal(updated.split('# Lite Harness').length, 2);

  const customized = legacy + '\n# Project additions\nKeep these instructions.\n';
  fs.writeFileSync(instructions, customized);
  await run();
  assert.ok(fs.readFileSync(instructions, 'utf8').startsWith(customized));
});

test('BuildLite rejects conflicting OpenCode paths before changing instructions or agents', async (t) => {
  for (const kind of ['directory', 'wrong-link', 'broken-link']) {
    await t.test(kind, async (t) => {
      const { directory, run } = await installerFixture(t);
      const instructions = path.join(directory, 'AGENTS.md');
      fs.writeFileSync(instructions, 'Original project instructions');
      const openCode = path.join(directory, '.opencode');
      if (kind === 'directory') fs.mkdirSync(openCode);
      else fs.symlinkSync(kind === 'wrong-link' ? '.' : 'missing', openCode);
      await assert.rejects(run());
      assert.equal(fs.readFileSync(instructions, 'utf8'), 'Original project instructions');
      assert.equal(fs.existsSync(path.join(directory, '.agents')), false);
    });
  }
});

test('BuildLite leaves the project untouched when managed markers are malformed', async (t) => {
  const { directory, run } = await installerFixture(t);
  const instructions = path.join(directory, 'AGENTS.md');
  const original = '# Project\n<!-- buildlite:start -->\nUnclosed section';
  fs.writeFileSync(instructions, original);
  await assert.rejects(run(), /malformed BuildLite markers/);
  assert.equal(fs.readFileSync(instructions, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(directory, '.agents')), false);
});

test('PowerShell embedded scripts preserve instructions, resolve links and update config', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-buildlite-ps-js-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = fs.readFileSync(path.join(projectDirectory, 'assets', 'set_harness_buildlite.ps1'), 'utf8');
  const embedded = (name) => {
    const match = script.match(new RegExp('\\$' + name + " = @'\\r?\\n([\\s\\S]*?)\\r?\\n'@"));
    assert.ok(match, `Missing ${name}`);
    return match[1];
  };
  const original = path.join(directory, 'AGENTS.md');
  const staged = path.join(directory, 'source.md');
  fs.writeFileSync(original, '# Project rules\n');
  fs.writeFileSync(staged, '# Harness rules\n');
  await execFileAsync(process.execPath, ['-e', embedded('mergeInstructionsScript'), original, staged]);
  assert.equal(fs.readFileSync(original, 'utf8'), '# Project rules\n');
  assert.match(fs.readFileSync(staged, 'utf8'), /^# Project rules\n[\s\S]*<!-- buildlite:start -->\n# Harness rules/);

  const link = path.join(directory, 'link');
  fs.symlinkSync(directory, link, 'junction');
  await execFileAsync(process.execPath, ['-e', embedded('checkLinkScript'), link, directory]);
  await assert.rejects(execFileAsync(process.execPath, ['-e', embedded('checkLinkScript'), link, os.tmpdir()]));

  const config = path.join(directory, 'opencode.json');
  const output = path.join(directory, 'config.tmp');
  fs.writeFileSync(config, JSON.stringify({ model: 'existing-model', permission: { edit: 'ask' } }));
  await execFileAsync(process.execPath, ['-e', embedded('defaultAgentScript'), config, output]);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
    model: 'existing-model', permission: { edit: 'ask' }, default_agent: 'build_lite'
  });
});

test('downloadable BuildLite archive matches the source harness', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-buildlite-archive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await execFileAsync('unzip', ['-q', path.join(projectDirectory, 'assets', 'buildlite_harness.zip'), '-d', directory]);
  assert.deepEqual(fs.readdirSync(directory), ['buildlite_harness']);
  const source = path.join(projectDirectory, 'assets', 'buildlite_harness');
  const extracted = path.join(directory, 'buildlite_harness');
  const files = (root) => fs.readdirSync(root, { recursive: true })
    .filter((name) => fs.statSync(path.join(root, name)).isFile()).sort();
  const sourceFiles = files(source).filter((name) =>
    path.basename(name) !== '.DS_Store' && !path.basename(name).startsWith('._'));
  assert.deepEqual(files(extracted), sourceFiles);
  for (const name of sourceFiles) {
    assert.deepEqual(fs.readFileSync(path.join(extracted, name)), fs.readFileSync(path.join(source, name)), name);
  }
});

const macosFixture = path.join(__dirname, 'fixtures', 'buildlite-macos-metadata.zip');

function assertCleanHarness(directory) {
  for (const name of fs.readdirSync(directory, { recursive: true })) {
    const parts = name.split(/[\\/]/);
    assert.equal(parts.some((part) => ['__MACOSX', '.DS_Store', '.AppleDouble', '.LSOverride'].includes(part)
      || part.startsWith('._')), false, `Unexpected macOS metadata: ${name}`);
  }
  const expected = {
    '.agents/agents/build_lite.md': '# Fixture agent\n',
    '.agents/.gitkeep': '',
    '.agents/notes with spaces/.settings': 'keep hidden file\n',
    '.agents/notes with spaces/.DS_Store.txt': 'keep similar name\n',
    '.agents/notes with spaces/my._notes': 'keep embedded prefix\n',
    '__MACOSX-not-metadata/keep.md': 'keep similar folder\n'
  };
  for (const [name, content] of Object.entries(expected)) {
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), content, name);
  }
}

test('BuildLite installs a contaminated ZIP without macOS metadata and preserves existing project files', async (t) => {
  const { directory, run } = await installerFixture(t, macosFixture);
  await run();
  assertCleanHarness(directory);
  assert.match(fs.readFileSync(path.join(directory, 'AGENTS.md'), 'utf8'), /# Fixture harness/);
  assert.equal(fs.readlinkSync(path.join(directory, '.opencode')), '.agents');

  // Reinstall must sanitize the extracted source, not delete or overwrite project metadata.
  const existing = ['.DS_Store', '.agents/._build_lite.md'];
  for (const name of existing) fs.writeFileSync(path.join(directory, name), 'existing project metadata');
  await run();
  for (const name of existing) {
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), 'existing project metadata');
  }
});

test('PowerShell staging script removes nested macOS metadata before copying the harness', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-buildlite-ps-macos-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await execFileAsync('unzip', ['-q', macosFixture, '-d', directory]);
  const source = path.join(directory, 'buildlite_harness');
  const original = path.join(directory, 'AGENTS.md');
  const existingMetadata = path.join(directory, '.DS_Store');
  fs.writeFileSync(original, '# Project instructions\n');
  fs.writeFileSync(existingMetadata, 'existing project metadata');
  const script = fs.readFileSync(path.join(projectDirectory, 'assets', 'set_harness_buildlite.ps1'), 'utf8');
  const match = script.match(/\$mergeInstructionsScript = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(match);
  await execFileAsync(process.execPath, ['-e', match[1], original, path.join(source, 'AGENTS.md')]);
  assertCleanHarness(source);
  assert.equal(fs.readFileSync(original, 'utf8'), '# Project instructions\n');
  assert.equal(fs.readFileSync(existingMetadata, 'utf8'), 'existing project metadata');
  assert.match(fs.readFileSync(path.join(source, 'AGENTS.md'), 'utf8'), /# Project instructions[\s\S]*# Fixture harness/);
});
