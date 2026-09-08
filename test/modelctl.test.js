const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('modelctl starts only inference, preserves its Compose project and propagates startup failures', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelctl-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'docker.log');
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ default_model: 'test', models: {
    test: { engine: 'vllm', compose: 'compose-test.yml', container: 'inference-test', volumes: ['test-cache'] }
  } }));
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh
echo "$*" >> "$DOCKER_TEST_LOG"
case "$1" in
  inspect) [ "$2" = '-f' ] && echo existing-project; exit 0 ;;
  compose) exit "$DOCKER_TEST_EXIT" ;;
  ps) echo inference-test ;;
esac
` , { mode: 0o755 });
  const script = path.join(__dirname, '..', 'docker', 'modelctl.sh');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, MODELCTL_CONFIG: path.join(dir, 'models.json'),
    MODELCTL_TOKENS_FILE: path.join(dir, 'no-token.env'), DOCKER_TEST_LOG: log, DOCKER_TEST_EXIT: '0' };
  delete env.HUGGINGFACE_ACCESS_TOKENS;
  const started = spawnSync('bash', [script, 'start', 'test'], { env, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const commands = fs.readFileSync(log, 'utf8');
  assert.equal(commands.split('\n').filter((line) => line.startsWith('compose ')).length, 1);
  assert.match(commands, /compose -p existing-project -f .*compose-test.yml up -d/);
  assert.match(commands, /volume create test-cache/);
  assert.doesNotMatch(commands + started.stdout, /metadata|sidecar|9100|python:3/);
  const failed = spawnSync('bash', [script, 'start', 'test'], { env: { ...env, DOCKER_TEST_EXIT: '17' }, encoding: 'utf8' });
  assert.equal(failed.status, 17);
  const info = spawnSync('bash', [script, 'info', 'test'], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(info.stdout).container, 'inference-test');
  assert.equal(JSON.parse(info.stdout).metadata, undefined);
  fs.writeFileSync(log, '');
  const stopped = spawnSync('bash', [script, 'stop'], { env, encoding: 'utf8' });
  assert.equal(stopped.status, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /rm -f inference-test/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /metadata|--filter|--remove-orphans/);
});
