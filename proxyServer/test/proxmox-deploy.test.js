const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const application = path.resolve(__dirname, '..');
const deploymentPath = path.join(application, 'proxmox', 'proxmoxDeploy.sh');
if (!fs.existsSync(deploymentPath)) {
  test('Proxmox deployment preservation checks', { skip: 'Local Proxmox deployment tooling is not included.' }, () => {});
} else {
  const deployment = fs.readFileSync(deploymentPath, 'utf8');
  const remoteStart = 'bash -s -- "$SERVER_PORT" "$LOCAL_HEAD" << \'EOF\'\n';
  const remoteOffset = deployment.indexOf(remoteStart);
  assert.ok(remoteOffset >= 0, 'The deploy script supplies its remote program over SSH.');
  const remoteProgram = deployment.slice(remoteOffset + remoteStart.length, deployment.lastIndexOf('\nEOF'));

  function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, ...options });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  }

  function runtimeFiles(directory) {
    const files = [];
    function visit(filename) {
      if (fs.statSync(filename).isDirectory()) {
        for (const name of fs.readdirSync(filename).sort()) visit(path.join(filename, name));
      } else {
        files.push([path.relative(directory, filename), createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]);
      }
    }
    visit(path.join(directory, 'data'));
    visit(path.join(directory, 'settings.env'));
    return files;
  }

  function fixture(t, { mutate = false, occupied = false, uncheckpointed = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ieti-proxmox-deploy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const current = path.join(home, 'nodejs_server');
    const release = path.join(root, 'release');
    const bin = path.join(home, '.npm-global', 'bin');
    const temporary = path.join(root, 'temporary');
    for (const directory of [path.join(current, 'data'), path.join(current, 'src'), path.join(release, 'src', 'db'), bin, temporary]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const packageJson = JSON.stringify({ name: 'deployment-fixture', version: '1.0.0', type: 'commonjs' });
    fs.writeFileSync(path.join(current, 'package.json'), packageJson);
    fs.writeFileSync(path.join(release, 'package.json'), packageJson);
    fs.writeFileSync(path.join(current, 'src', 'server.js'), '// previous release\n');
    fs.writeFileSync(path.join(release, 'src', 'server.js'), '// candidate release\n');
    fs.copyFileSync(path.join(application, 'src', 'config.js'), path.join(release, 'src', 'config.js'));
    fs.copyFileSync(path.join(application, 'src', 'db', 'index.js'), path.join(release, 'src', 'db', 'index.js'));
    const modules = path.join(application, 'node_modules');
    fs.symlinkSync(modules, path.join(current, 'node_modules'), 'dir');
    fs.symlinkSync(modules, path.join(release, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(current, 'settings.env'), [
      'DATABASE_PATH=./data/custom.sqlite',
      'PUBLIC_BASE_URL=https://deployment.example.test',
      'ADMIN_PASSWORD=fixture-admin-password',
      'SESSION_SECRET=fixture-session-secret-with-enough-length',
      'DEFAULT_PROVIDER_API_KEY=fixture-provider-key',
      'GOOGLE_OAUTH_ENABLED=false',
      ''
    ].join('\n'));
    const database = path.join(current, 'data', 'custom.sqlite');
    const initialized = run(process.execPath, ['-e', `
      require('dotenv').config({ path: process.argv[1], override: true, quiet: true });
      process.env.DATABASE_PATH = process.argv[2];
      const { getDb, closeDb } = require('./src/db');
      // Represent an established deployment, including legacy default-group backfill.
      getDb(); closeDb(); getDb(); closeDb();
    `, path.join(current, 'settings.env'), database], { cwd: release });
    assert.equal(initialized.status, 0, initialized.stderr);
    const db = new Database(database);
    db.exec(`
      INSERT INTO users (id, name, email) VALUES (1, 'Deployment fixture', 'fixture@example.test');
      INSERT INTO user_groups (user_id, group_id) VALUES (1, (SELECT MIN(id) FROM groups));
      INSERT INTO conversations (id, user_id, title) VALUES (1, 1, 'Saved conversation');
      INSERT INTO messages (conversation_id, user_id, role, content) VALUES (1, 1, 'user', 'Preserve this message');
      INSERT INTO usage_logs (user_id, model, input_tokens, output_tokens, total_tokens, status)
        VALUES (1, 'fixture-model', 3, 4, 7, 'success');
      UPDATE settings SET updated_at = '2000-01-01' WHERE key = 'public_base_url';
    `);
    db.close();
    if (uncheckpointed) {
      const interrupted = run(process.execPath, ['-e', `
        const database = require('better-sqlite3')(process.argv[1]);
        database.exec("INSERT INTO messages (conversation_id, user_id, role, content) VALUES (1, 1, 'assistant', 'Committed only in WAL')");
        // Simulate an abruptly stopped app without SQLite's close/checkpoint cleanup.
        process.kill(process.pid, 'SIGKILL');
      `, database], { cwd: release });
      assert.equal(interrupted.signal, 'SIGKILL');
      assert.ok(fs.statSync(`${database}-wal`).size > 0, 'Committed records remain in the WAL before deployment.');
    }
    fs.writeFileSync(path.join(current, 'data', 'attachment.bin'), Buffer.from([0, 1, 255, 2]));
    if (mutate) {
      fs.appendFileSync(path.join(release, 'src', 'db', 'index.js'), `
        const originalGetDb = module.exports.getDb;
        module.exports.getDb = () => {
          const database = originalGetDb();
          database.exec('DELETE FROM messages');
          return database;
        };
      `);
    }
    const zipped = run('python3', ['-c', `
  import pathlib, sys, zipfile
  source = pathlib.Path(sys.argv[1])
  with zipfile.ZipFile(sys.argv[2], 'w') as archive:
      for file in source.rglob('*'):
          if file.is_file():
              archive.write(file, file.relative_to(source))
    `, release, path.join(home, 'server-package.zip')]);
    assert.equal(zipped.status, 0, zipped.stderr);
    function command(name, body) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
    }
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    command('npm', 'ln -s "$DEPLOY_TEST_MODULES" node_modules');
    command('pm2', 'printf "%s\\n" "$*" >> "$DEPLOY_TEST_COMMANDS"');
    command('ss', 'if [[ "$DEPLOY_TEST_OCCUPIED" == "1" ]]; then printf "LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*\\n"; fi');
    command('sleep', ':');
    command('curl', ':');
    command('sudo', 'exit 1');
    const script = path.join(root, 'remote-deploy.sh');
    const commands = path.join(root, 'commands.log');
    fs.writeFileSync(script, remoteProgram);
    const before = runtimeFiles(current);
    return {
      root, home, current, before, commands, temporary,
      deploy() {
        return run('bash', [script, '3000', '0123456789abcdef0123456789abcdef01234567'], {
          cwd: root,
          env: {
            ...process.env,
            HOME: home,
            TMPDIR: temporary,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            DEPLOY_TEST_MODULES: modules,
            DEPLOY_TEST_COMMANDS: commands,
            DEPLOY_TEST_OCCUPIED: occupied ? '1' : '0',
            // A stale inherited database setting must never escape the validation copy.
            DATABASE_PATH: path.join(root, 'unexpected.sqlite')
          }
        });
      }
    };
  }

  test('deployment validates actual startup on an isolated database and preserves all production runtime bytes', t => {
    const f = fixture(t, { uncheckpointed: true });
    const result = f.deploy();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /New release startup preserves every database table and record/);
    assert.deepEqual(runtimeFiles(f.current), f.before);
    assert.match(fs.readFileSync(path.join(f.current, 'src', 'server.js'), 'utf8'), /candidate release/);
    assert.equal(fs.existsSync(path.join(f.root, 'unexpected.sqlite')), false);
    const backups = fs.readdirSync(path.join(f.home, 'proxy-deploy-backups'));
    assert.equal(backups.length, 1);
    const backup = path.join(f.home, 'proxy-deploy-backups', backups[0]);
    const original = new Map(f.before);
    const retained = new Map(runtimeFiles(backup));
    for (const [filename, hash] of original) {
      // Readers can change shared-memory coordination; database and WAL payloads remain protected.
      if (filename.endsWith('-shm')) continue;
      assert.equal(retained.get(filename), hash, `Backup preserves ${filename}.`);
    }
    // SQLite's read-only integrity check may create missing empty WAL/shared-memory files.
    for (const filename of retained.keys()) {
      if (!original.has(filename)) assert.match(filename, /^data\/custom\.sqlite-(?:shm|wal)$/);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'database-before.json'), 'utf8')).messages.count, 2, 'The retained backup includes the committed WAL record.');
    assert.deepEqual(fs.readdirSync(f.temporary), [], 'Staged code and validation copies are removed.');
  });

  test('deployment rejects a destructive startup migration before replacing code or touching production data', t => {
    const f = fixture(t, { mutate: true });
    const result = f.deploy();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release startup would change production records/);
    assert.deepEqual(runtimeFiles(f.current), f.before);
    assert.match(fs.readFileSync(path.join(f.current, 'src', 'server.js'), 'utf8'), /previous release/);
    assert.match(fs.readFileSync(f.commands, 'utf8'), /start src\/server.js --name app/);
    assert.equal(fs.existsSync(path.join(f.root, 'unexpected.sqlite')), false);
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  });

  test('deployment rejects a port that remains occupied after the bounded shutdown wait', t => {
    const f = fixture(t, { occupied: true });
    const result = f.deploy();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /port 3000 continua ocupat/);
    assert.deepEqual(runtimeFiles(f.current), f.before);
    assert.match(fs.readFileSync(path.join(f.current, 'src', 'server.js'), 'utf8'), /previous release/);
    assert.equal(fs.existsSync(path.join(f.home, 'proxy-deploy-backups')), false);
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  });

  test('deployment refuses runtime symlinks that could connect validation to live data', t => {
    const f = fixture(t);
    fs.symlinkSync('custom.sqlite', path.join(f.current, 'data', 'linked.sqlite'));
    const before = runtimeFiles(f.current);
    const result = f.deploy();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Runtime symlinks require independent target backups/);
    assert.deepEqual(runtimeFiles(f.current), before);
    assert.match(fs.readFileSync(path.join(f.current, 'src', 'server.js'), 'utf8'), /previous release/);
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  });
}
