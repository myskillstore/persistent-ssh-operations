'use strict';

const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Server } = require('ssh2');

const { atomicJson, profilePaths } = require('../scripts/persistent-ssh-broker.cjs');

function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = check();
        if (value) return resolve(value);
      } catch (error) { return reject(error); }
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for test state.'));
      setTimeout(poll, 100);
    };
    poll();
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

test('two commands reuse one authenticated connection and unknown host keys require approval', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-ssh-integration-'));
  const hostKey = path.join(root, 'host-key');
  const clientKey = path.join(root, 'client-key');
  execFileSync('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);

  let connections = 0;
  const port = await freePort();
  const server = new Server({ hostKeys: [fs.readFileSync(hostKey)] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (context) => context.accept());
    client.on('ready', () => {
      connections += 1;
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`ran:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject));

  const configPath = path.join(root, 'profiles.json');
  const stateRoot = path.join(root, 'state');
  fs.writeFileSync(configPath, JSON.stringify({ profiles: { local: { host: '127.0.0.1', port, username: 'test', identityFile: clientKey } } }));
  const paths = profilePaths(stateRoot, 'local');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'persistent-ssh-broker.cjs'), '--config', configPath, '--state-root', stateRoot, '--profile', 'local'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childError = '';
  child.stderr.on('data', (chunk) => { childError += chunk.toString(); });

  t.after(async () => {
    if (!child.killed) child.kill();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const pending = await waitFor(() => readJson(paths.pendingHost));
  assert.equal(readJson(paths.heartbeat).state, 'hostkey-pending');
  atomicJson(paths.knownHost, { profile: 'local', host: '127.0.0.1', port, fingerprint: pending.fingerprint, approvedAt: new Date().toISOString() });
  fs.rmSync(paths.pendingHost, { force: true });
  await waitFor(() => readJson(paths.heartbeat)?.state === 'ready');

  async function execute(id, command) {
    atomicJson(path.join(paths.queue, `${id}.req.json`), { id, type: 'exec', command, timeoutMs: 5000, deadlineMs: Date.now() + 10000 });
    return waitFor(() => readJson(path.join(paths.results, `${id}.resp.json`)));
  }

  const first = await execute('first', 'one');
  const second = await execute('second', 'two');
  assert.equal(first.code, 0);
  assert.equal(first.stdout, 'ran:one\n');
  assert.equal(second.stdout, 'ran:two\n');
  assert.equal(connections, 1, childError);

  atomicJson(path.join(paths.queue, 'stop.req.json'), { id: 'stop', type: 'stop', timeoutMs: 1000, deadlineMs: Date.now() + 5000 });
  const stop = await waitFor(() => readJson(path.join(paths.results, 'stop.resp.json')));
  assert.equal(stop.code, 0);
  if (child.exitCode == null) await new Promise((resolve) => child.once('exit', resolve));
});
