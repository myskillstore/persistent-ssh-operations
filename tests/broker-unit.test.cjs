'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const broker = require('../scripts/persistent-ssh-broker.cjs');

test('profile names are bounded and filesystem-safe', () => {
  assert.equal(broker.validateProfileName('prod-1.eu'), 'prod-1.eu');
  for (const value of ['', '../prod', 'name with spaces', 'a'.repeat(65)]) {
    assert.throws(() => broker.validateProfileName(value));
  }
});

test('host fingerprints use OpenSSH SHA256 notation', () => {
  assert.equal(broker.hostFingerprint(Buffer.from('host-key')), 'SHA256:CfEOS9w3pHE4KlqjcQFwWyWMmyRvvPoehydyMhTxpzg');
});

test('profile config requires exactly one supported authentication source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-ssh-unit-'));
  const config = path.join(root, 'profiles.json');
  fs.writeFileSync(config, JSON.stringify({ profiles: { invalid: { host: 'localhost', username: 'deploy' } } }));
  assert.throws(() => broker.loadProfile(config, 'invalid'), /exactly one/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('profile state is isolated by profile name', () => {
  const first = broker.profilePaths(path.join(os.tmpdir(), 'persistent-ssh-state'), 'first');
  const second = broker.profilePaths(path.join(os.tmpdir(), 'persistent-ssh-state'), 'second');
  assert.notEqual(first.base, second.base);
  assert.ok(first.queue.startsWith(first.base));
});
