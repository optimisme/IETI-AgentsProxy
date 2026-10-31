const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..', 'docker');
const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

// Python and Zig TensorFold profiles share one downloaded checkpoint on purpose, and renaming a volume would orphan a server's data.
const SHARED_CACHE = /^ieti-qwen38-flash-next-tensorfold-/;
// Values a run supplies; config only needs them present.
const composeEnv = { ...process.env, IETI_RUN: 'test', TENSORFOLD_NATIVE_PATCH_SHA256: '0'.repeat(64) };

test('Compose profiles isolate caches, resolve token mounts and contain valid launch commands', {
  skip: !fs.existsSync(root) ? 'Docker profiles are not included in proxy-only deployments'
    : composeAvailable ? false : 'Docker Compose CLI is required; no Docker daemon or GPU is needed'
}, () => {
  const files = fs.readdirSync(path.join(root, 'models'));
  assert.ok(files.length > 0);
  const projects = new Set(), containers = new Set(), volumes = new Set();
  const configs = fs.readFileSync(path.join(root, 'CONFIGS.md'), 'utf8');
  for (const [, profile] of configs.matchAll(/`(models\/[^`]+\.yml)`/g)) {
    assert.ok(fs.existsSync(path.join(root, profile)), `Recommended profile exists: ${profile}`);
  }
  for (const file of files) {
    assert.match(file, /\.yml$/);
    const filename = path.join(root, 'models', file);
    const source = fs.readFileSync(filename, 'utf8');
    // A private env_file is absent from a clean checkout, and Compose cannot resolve the profile without it.
    const envFile = source.match(/env_file:\n\s+- (\S+)/)?.[1];
    if (envFile && !fs.existsSync(path.join(root, 'models', envFile))) continue;
    const result = spawnSync('docker', ['compose', '-f', filename, 'config', '--format', 'json'], { encoding: 'utf8', env: composeEnv });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    const config = JSON.parse(result.stdout);
    // Experiment families are alternatives of one service: same project and container, never run together.
    const family = /^ieti-qwen38-python-/.test(config.name);
    assert.ok(config.name && (family || !projects.has(config.name)), `Unique project: ${file}`);
    projects.add(config.name);
    assert.equal(Object.keys(config.services).length, 1);
    const service = Object.values(config.services)[0];
    assert.ok(service.container_name && (family || !containers.has(service.container_name)));
    containers.add(service.container_name);
    assert.equal(service.labels['com.ieti.profile'], file);
    assert.equal(service.labels['com.ieti.inference'], 'true');
    const bind = service.volumes.filter((volume) => volume.type === 'bind');
    const tokens = bind.filter((volume) => volume.source === path.join(root, 'tokens.env'));
    assert.ok(tokens.every((volume) => volume.read_only), `Read-only tokens: ${file}`);
    assert.equal(tokens.length, /HUGGINGFACE_ACCESS_TOKENS/.test(source) ? 1 : 0, `tokens.env only where it is read: ${file}`);
    if (bind.length) assert.match(source, /create_host_path: false/, file);
    assert.doesNotMatch(source, /active-model/);
    const mounted = service.volumes.filter((volume) => volume.type === 'volume').map((volume) => volume.source).sort();
    assert.deepEqual(mounted, Object.keys(config.volumes).sort());
    for (const [key, volume] of Object.entries(config.volumes)) {
      if (volume.external || SHARED_CACHE.test(volume.name)) continue;
      assert.equal(key, volume.name, `config --volumes must identify the actual volumes for cleanup: ${file}`);
      assert.ok(!volumes.has(volume.name), `Cache shared across profiles: ${volume.name}`);
      volumes.add(volume.name);
    }
    // Compose escapes dollar signs again when serializing its resolved command.
    const command = [...service.command].sort((a, b) => b.length - a.length)[0].replaceAll('$$', '$'); // the script, if argv has several
    const syntax = spawnSync('bash', ['-n'], { input: command, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${file}: ${syntax.stderr}`);
    const identity = source.match(/^# Served model: (.+)$/m)?.[1];
    assert.ok(identity);
    const runtimeIdentity = command.match(/--(?:served-model-name|alias)\s+(\S+)/)?.[1] || service.environment.MODEL_ID;
    assert.equal(runtimeIdentity, identity);
    if (service.environment.MODEL_ID && /snapshot_download/.test(command)) assert.match(command, /os\.environ\['MODEL_ID'\]/);
  }
});
