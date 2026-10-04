const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const profile = path.resolve(__dirname, '../../docker/models/qwen38-flash-next-tensorfold-vontra-mlx-4bit-mtp-int8-ssd-vision-128gb.yml');
const profileAvailable = fs.existsSync(profile);
const source = profileAvailable ? fs.readFileSync(profile, 'utf8') : '';
const pythonAvailable = spawnSync('python3', ['--version']).status === 0;
const composeAvailable = spawnSync('docker', ['compose', 'version']).status === 0;
const skip = !profileAvailable ? 'Docker profiles are omitted from proxy-only deployments'
  : pythonAvailable ? false : 'Python 3 is required to execute the startup patch';

function embeddedPython(marker) {
  const block = source.split(`<<'${marker}'\n`)[1]?.split(`        ${marker}\n`)[0];
  assert.ok(block, `Embedded ${marker} exists`);
  return block.replace(/^        /gm, '');
}

const expected = 'KEEP = 8                 # prompt states (one token before each end) a concurrent decoder keeps to resume from';
// The relevant unchanged planning/runtime call sites from the pinned engine.
const fixture = `KEEP_SERIAL = 4\n${expected}\n
def plan(text, streams, each, mtp, bits, rows0, graphs, tp):
    return indexed_stream_geometry(text, streams + int(graphs and mtp), each, KEEP, mtp=mtp,
                                                          kv_bits=bits, world=tp, prefill_rows=rows0)

def decoder(w, streams, max_len, depth, confidence, points):
    return MultiDecoder(w, slots=streams, capacity=max_len, depth=depth,
                        confidence=self.confidence, keep=KEEP, points=self.points,
                        kv_dtype='int8')
`;

function runPython(script, args, value, env = {}) {
  return spawnSync('python3', ['-', ...args], {
    input: script,
    encoding: 'utf8',
    env: { ...process.env, ...env, TENSORFOLD_PROMPT_SNAPSHOTS: value, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

test('Flash Next patch runs before pip and verifies the installed module before serving', { skip: !profileAvailable }, () => {
  const checkout = source.indexOf('checkout --detach 609ca419abecebdc5a059498a613680bd3aa847f');
  const patch = source.indexOf("<<'PY_PATCH_SNAPSHOTS'");
  const ssdPatch = source.indexOf("<<'PY_PATCH_SSD_BATCH'");
  const install = source.indexOf('python -m pip install');
  const verify = source.indexOf("<<'PY_VERIFY_SNAPSHOTS'");
  const ssdVerify = source.indexOf("<<'PY_VERIFY_SSD_BATCH'");
  const serve = source.indexOf('exec tensorfold serve');
  assert.ok(checkout < patch && patch < ssdPatch && ssdPatch < install && install < verify && verify < ssdVerify && ssdVerify < serve);
  assert.match(source, /TENSORFOLD_PROMPT_SNAPSHOTS: "\$\{TENSORFOLD_PROMPT_SNAPSHOTS:-32\}"/);
  assert.match(source, /TENSORFOLD_SSD_BATCH_GATHER: "\$\{TENSORFOLD_SSD_BATCH_GATHER:-1\}"/);
});

test('Flash Next SSD patch rejects invalid switches and source drift without writing', { skip }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-ssd-batch-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const filename = path.join(temp, 'forward.py');
  const drift = '# Unexpected upstream source must never be patched\n';
  const script = embeddedPython('PY_PATCH_SSD_BATCH');
  for (const enabled of ['', '2', 'true', ' 1', '0', '1']) {
    fs.writeFileSync(filename, drift);
    const result = runPython(script, [filename], '32', { TENSORFOLD_SSD_BATCH_GATHER: enabled });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, enabled === '0' || enabled === '1' ? /SHA-256 no longer matches/ : /must be exactly 0 or 1/);
    assert.equal(fs.readFileSync(filename, 'utf8'), drift);
  }
});

test('Flash Next SSD verification rejects an installed file different from the tested source', { skip }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-installed-ssd-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const installedRoot = path.join(temp, 'site-packages');
  const packageRoot = path.join(installedRoot, 'tensorfold');
  const cuda = path.join(packageRoot, 'families/qwen4_exp/cuda');
  fs.mkdirSync(cuda, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, '__init__.py'), '');
  fs.writeFileSync(path.join(cuda, 'forward.py'), '# stale installed package\n');
  for (const enabled of ['0', '1']) {
    const result = runPython(embeddedPython('PY_VERIFY_SSD_BATCH'), [path.join(temp, 'checkout')], '32', {
      PYTHONPATH: installedRoot, TENSORFOLD_SSD_BATCH_GATHER: enabled,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /installed SSD batch verification failed/);
  }
});

test('Flash Next snapshot patch accepts bounded values and rejects source drift without writing', { skip }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-snapshots-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const filename = path.join(temp, 'engine.py');
  const script = embeddedPython('PY_PATCH_SNAPSHOTS');
  for (const value of ['1', '8', '16', '32']) {
    fs.writeFileSync(filename, fixture);
    const result = runPython(script, [filename], value);
    assert.equal(result.status, 0, result.stderr);
    const updated = fs.readFileSync(filename, 'utf8');
    assert.ok(updated.includes(expected.replace('KEEP = 8 ', `KEEP = ${value} `)));
    assert.ok(updated.includes('KEEP_SERIAL = 4'));
    assert.match(updated, /indexed_stream_geometry\(text, streams \+ int\(graphs and mtp\), each, KEEP,/);
    assert.match(updated, /keep=KEEP/);
  }
  for (const value of ['', '0', '-1', '33', '16.0', ' 16', 'abc', '9'.repeat(5000)]) {
    fs.writeFileSync(filename, fixture);
    const result = runPython(script, [filename], value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be an integer from 1 to 32/);
    assert.equal(fs.readFileSync(filename, 'utf8'), fixture);
  }
  for (const drift of [fixture.replace('KEEP = 8 ', 'KEEP = 9 '), `${fixture}\n${expected}\n`,
    `${fixture}\nKEEP = 9\n`, fixture.replace('each, KEEP,', 'each, 8,'),
    fixture.replace('keep=KEEP', 'keep=8')]) {
    fs.writeFileSync(filename, drift);
    const result = runPython(script, [filename], '16');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pinned engine.py KEEP=8 or its planning\/runtime uses no longer match/);
    assert.equal(fs.readFileSync(filename, 'utf8'), drift);
  }
});

test('Flash Next verification rejects stale installed packages and source-checkout imports', { skip }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-installed-snapshots-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const installedRoot = path.join(temp, 'site-packages');
  const packageParts = ['tensorfold', 'families', 'qwen4_exp', 'cuda'];
  let parent = installedRoot;
  for (const part of packageParts) {
    parent = path.join(parent, part);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, '__init__.py'), '');
  }
  const installed = path.join(parent, 'engine.py');
  const script = embeddedPython('PY_VERIFY_SNAPSHOTS');
  const checkoutRoot = path.join(temp, 'checkout');
  fs.writeFileSync(installed, fixture.replace('KEEP = 8 ', 'KEEP = 16 '));
  let result = runPython(script, [checkoutRoot], '16', { PYTHONPATH: installedRoot });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified installed Flash Next KEEP=16/);
  fs.writeFileSync(installed, fixture);
  result = runPython(script, [checkoutRoot], '16', { PYTHONPATH: installedRoot });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed snapshot verification failed.*KEEP=8/);
  fs.writeFileSync(installed, fixture.replace('KEEP = 8 ', 'KEEP = 16 '));
  result = runPython(script, [installedRoot], '16', { PYTHONPATH: installedRoot });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed snapshot verification failed/);
  fs.writeFileSync(installed, fixture.replace('KEEP = 8 ', 'KEEP = 16 ').replace('keep=KEEP', 'keep=8'));
  result = runPython(script, [checkoutRoot], '16', { PYTHONPATH: installedRoot });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed snapshot verification failed/);
});

test('Flash Next canonical startup pins and verifies the checkpoint before serving', { skip }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-model-snapshot-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const revision = '2b170fa6309d5d1ee380b35636075fac7945f286';
  const snapshot = path.join(temp, revision);
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(snapshot, 'config.json'), '{}');
  fs.writeFileSync(path.join(snapshot, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { weight: 'model-00001-of-00001.safetensors' } }));
  fs.writeFileSync(path.join(snapshot, 'model-00001-of-00001.safetensors'), 'fixture');
  fs.writeFileSync(path.join(temp, 'huggingface_hub.py'), `import os\ndef snapshot_download(*, repo_id, revision, max_workers):\n    assert repo_id == 'TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP'\n    assert revision == '${revision}'\n    assert max_workers == 4\n    return os.environ['TEST_SNAPSHOT']\n`);
  const env = { PYTHONPATH: temp, MODEL_ID: 'TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP', MODEL_REVISION: revision, TEST_SNAPSHOT: snapshot };
  const script = embeddedPython('PY_MODEL_SNAPSHOT');
  let result = runPython(script, [], '32', env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), snapshot);
  assert.match(result.stderr, /Verified pinned model TensorFold\/Qwen3.8/);
  fs.rmSync(path.join(snapshot, 'model-00001-of-00001.safetensors'));
  result = runPython(script, [], '32', env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing weights or has an invalid shard index/);
  const wrongSnapshot = path.join(temp, 'wrong-revision');
  fs.mkdirSync(wrongSnapshot);
  fs.writeFileSync(path.join(wrongSnapshot, 'config.json'), '{}');
  result = runPython(script, [], '32', { ...env, TEST_SNAPSHOT: wrongSnapshot });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected model snapshot/);
  assert.doesNotMatch(source, /\n\s+tensorfold pull /);
  assert.match(source, /exec tensorfold serve "\$\$\{MODEL_PATH\}"/);
  assert.match(source, /MODEL_ID: TensorFold\/Qwen3.8-Flash-Next-MLX-4bit-MTP/);
});

test('Compose resolves snapshot overrides and retains escaped runtime variables and valid Bash', {
  skip: !profileAvailable ? 'Docker profiles are omitted from proxy-only deployments'
    : composeAvailable ? false : 'Docker Compose CLI is required',
}, () => {
  for (const override of [undefined, '8', '16', '32']) {
    const env = { ...process.env };
    delete env.TENSORFOLD_PROMPT_SNAPSHOTS;
    if (override) env.TENSORFOLD_PROMPT_SNAPSHOTS = override;
    const result = spawnSync('docker', ['compose', '-f', profile, 'config', '--format', 'json'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    const service = JSON.parse(result.stdout).services['qwen-tensorfold'];
    assert.equal(service.environment.TENSORFOLD_PROMPT_SNAPSHOTS, override || '32');
    assert.equal(service.environment.TENSORFOLD_SSD_BATCH_GATHER, process.env.TENSORFOLD_SSD_BATCH_GATHER || '1');
    assert.equal(service.environment.MODEL_REVISION, '2b170fa6309d5d1ee380b35636075fac7945f286');
    assert.equal(service.environment.MODEL_ID, 'TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP');
    const command = service.command.at(-1).replaceAll('$$', '$');
    assert.match(command, /--context "\$\{CONTEXT_LENGTH\}"/);
    assert.match(command, /MODEL_PATH=\$\(python - <<'PY_MODEL_SNAPSHOT'/);
    assert.match(command, /--name "\$\{MODEL_ID\}"/);
    const syntax = spawnSync('bash', ['-n'], { input: command, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  for (const enabled of ['0', '1']) {
    const result = spawnSync('docker', ['compose', '-f', profile, 'config', '--format', 'json'], {
      encoding: 'utf8', env: { ...process.env, TENSORFOLD_SSD_BATCH_GATHER: enabled },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).services['qwen-tensorfold'].environment.TENSORFOLD_SSD_BATCH_GATHER, enabled);
  }
});
