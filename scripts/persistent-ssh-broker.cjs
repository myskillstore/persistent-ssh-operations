#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXIT = Object.freeze({ TIMEOUT: 124, BROKER: 125, HOST_KEY: 126, CONFIG: 127 });
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

function defaultConfigPath(env = process.env, platform = process.platform) {
  if (env.PERSISTENT_SSH_CONFIG) return path.resolve(env.PERSISTENT_SSH_CONFIG);
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'persistent-ssh-operations', 'profiles.json');
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'persistent-ssh-operations', 'profiles.json');
}

function defaultStateRoot(env = process.env, platform = process.platform) {
  if (env.PERSISTENT_SSH_STATE_DIR) return path.resolve(env.PERSISTENT_SSH_STATE_DIR);
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'persistent-ssh-operations');
  }
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'persistent-ssh-operations');
}

function validateProfileName(profile) {
  if (!PROFILE_PATTERN.test(profile || '')) {
    throw new Error('Profile names must use 1-64 letters, digits, dots, underscores, or hyphens.');
  }
  return profile;
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function loadProfile(configPath, profile) {
  validateProfileName(profile);
  let document;
  try {
    document = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Cannot read profile config: ${error.message}`);
  }
  const raw = document?.profiles?.[profile];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Profile '${profile}' was not found.`);
  if (typeof raw.host !== 'string' || !raw.host.trim()) throw new Error(`Profile '${profile}' requires host.`);
  if (typeof raw.username !== 'string' || !raw.username.trim()) throw new Error(`Profile '${profile}' requires username.`);
  const port = raw.port == null ? 22 : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Profile '${profile}' has an invalid port.`);
  const hasIdentity = typeof raw.identityFile === 'string' && raw.identityFile.trim() !== '';
  const useAgent = raw.useAgent === true;
  if (hasIdentity === useAgent) throw new Error(`Profile '${profile}' must set exactly one of identityFile or useAgent.`);
  if (useAgent && !process.env.SSH_AUTH_SOCK) throw new Error(`Profile '${profile}' requires SSH_AUTH_SOCK for useAgent.`);

  const boundedInteger = (name, fallback, minimum, maximum) => {
    const value = raw[name] == null ? fallback : Number(raw[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Profile '${profile}' has an invalid ${name}.`);
    }
    return value;
  };

  const result = {
    host: raw.host.trim(),
    port,
    username: raw.username.trim(),
    useAgent,
    connectTimeoutMs: boundedInteger('connectTimeoutMs', 30000, 1000, 300000),
    keepaliveIntervalMs: boundedInteger('keepaliveIntervalMs', 30000, 5000, 300000),
    keepaliveCountMax: boundedInteger('keepaliveCountMax', 3, 1, 20),
    maxOutputBytes: boundedInteger('maxOutputBytes', DEFAULT_MAX_OUTPUT, 1024, 256 * 1024 * 1024),
  };
  if (hasIdentity) {
    result.identityFile = path.resolve(expandHome(raw.identityFile));
    if (!fs.existsSync(result.identityFile)) throw new Error(`Profile '${profile}' identityFile does not exist.`);
  }
  return result;
}

function hostFingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function profilePaths(stateRoot, profile) {
  validateProfileName(profile);
  const base = path.join(path.resolve(stateRoot), profile);
  return {
    base,
    queue: path.join(base, 'queue'),
    results: path.join(base, 'results'),
    heartbeat: path.join(base, 'heartbeat.json'),
    pid: path.join(base, 'broker.pid.json'),
    lock: path.join(base, 'broker.lock'),
    knownHost: path.join(base, 'known-host.json'),
    pendingHost: path.join(base, 'pending-host.json'),
    log: path.join(base, 'broker.log'),
  };
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function atomicJson(file, value, mode = 0o600) {
  ensureDirectory(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, mode); } catch {}
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(paths, token) {
  ensureDirectory(paths.base);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(paths.lock, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readJson(paths.lock);
      if (processExists(Number(current?.pid))) throw new Error(`A broker is already running with PID ${current.pid}.`);
      try { fs.unlinkSync(paths.lock); } catch {}
    }
  }
  throw new Error('Could not acquire the broker lock.');
}

function sanitizeLogMessage(message) {
  return String(message).replace(/[\r\n]+/g, ' ').slice(0, 2000);
}

function createBroker({ configPath, stateRoot, profile, ClientClass }) {
  const config = loadProfile(configPath, profile);
  const paths = profilePaths(stateRoot, profile);
  ensureDirectory(paths.queue);
  ensureDirectory(paths.results);
  const token = crypto.randomUUID();
  acquireLock(paths, token);
  atomicJson(paths.pid, { pid: process.pid, token, profile, startedAt: new Date().toISOString() });

  let client = null;
  let ready = false;
  let stopping = false;
  let activeRequest = null;
  let reconnectDelay = 2000;
  let reconnectTimer = null;
  let connectionSequence = 0;
  let state = 'starting';

  function rotateLogIfNeeded() {
    try {
      if (fs.statSync(paths.log).size < 1024 * 1024) return;
      try { fs.unlinkSync(`${paths.log}.1`); } catch {}
      fs.renameSync(paths.log, `${paths.log}.1`);
    } catch {}
  }

  function log(message) {
    rotateLogIfNeeded();
    const connection = connectionSequence ? `c${connectionSequence}` : '--';
    fs.appendFileSync(paths.log, `${new Date().toISOString()} [${connection}] ${sanitizeLogMessage(message)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  function heartbeat(nextState = state, detail) {
    state = nextState;
    atomicJson(paths.heartbeat, {
      pid: process.pid,
      token,
      profile,
      state,
      ready,
      connectionSequence,
      activeRequest,
      updatedAt: new Date().toISOString(),
      ...(detail ? { detail: sanitizeLogMessage(detail) } : {}),
    });
  }

  function writeResponse(id, response) {
    atomicJson(path.join(paths.results, `${id}.resp.json`), { id, ...response, completedAt: new Date().toISOString() });
  }

  function recoverInterruptedRequests() {
    for (const name of fs.readdirSync(paths.queue)) {
      if (!name.endsWith('.run.json')) continue;
      const file = path.join(paths.queue, name);
      const request = readJson(file);
      if (request?.id) {
        writeResponse(request.id, {
          stdout: '',
          stderr: 'Broker restarted while the remote outcome was unknown. The command was not retried.\n',
          code: EXIT.BROKER,
          uncertain: true,
        });
      }
      try { fs.unlinkSync(file); } catch {}
    }
  }

  function verifyHostKey(key, accept) {
    const fingerprint = hostFingerprint(key);
    const known = readJson(paths.knownHost);
    const matchesTarget = known?.host === config.host && Number(known?.port) === config.port;
    if (matchesTarget && known?.fingerprint === fingerprint) {
      try { fs.unlinkSync(paths.pendingHost); } catch {}
      accept(true);
      return;
    }
    const status = known ? 'mismatch' : 'unknown';
    atomicJson(paths.pendingHost, {
      profile,
      host: config.host,
      port: config.port,
      fingerprint,
      status,
      observedAt: new Date().toISOString(),
      ...(known?.fingerprint ? { previouslyApprovedFingerprint: known.fingerprint } : {}),
    });
    ready = false;
    heartbeat('hostkey-pending', `${status} host key; explicit approval required`);
    log(`${status.toUpperCase()} HOST KEY ${fingerprint}; refusing connection pending explicit approval`);
    accept(false);
  }

  function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    heartbeat(state === 'hostkey-pending' ? state : 'reconnecting', `retry in ${delay}ms`);
  }

  function connect() {
    if (stopping) return;
    state = 'connecting';
    heartbeat();
    client = new ClientClass();
    client.on('ready', () => {
      connectionSequence += 1;
      ready = true;
      reconnectDelay = 2000;
      heartbeat('ready');
      log(`CONNECTED ${config.username}@${config.host}:${config.port}`);
      poll();
    });
    client.on('error', (error) => {
      ready = false;
      log(`connection error: ${error.message}`);
      if (state !== 'hostkey-pending') heartbeat('connection-error', error.message);
    });
    client.on('close', () => {
      ready = false;
      log('connection closed');
      if (!stopping) scheduleReconnect();
    });

    const connection = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: config.connectTimeoutMs,
      keepaliveInterval: config.keepaliveIntervalMs,
      keepaliveCountMax: config.keepaliveCountMax,
      hostVerifier: verifyHostKey,
    };
    if (config.useAgent) connection.agent = process.env.SSH_AUTH_SOCK;
    else connection.privateKey = fs.readFileSync(config.identityFile);
    client.connect(connection);
  }

  function finishRequest(runFile, request, response) {
    writeResponse(request.id, response);
    try { fs.unlinkSync(runFile); } catch {}
    activeRequest = null;
    heartbeat(ready ? 'ready' : state);
    setImmediate(poll);
  }

  function execute(runFile, request) {
    if (typeof request.command !== 'string' || !request.command || Buffer.byteLength(request.command, 'utf8') > 65536) {
      finishRequest(runFile, request, { stdout: '', stderr: 'Invalid or oversized command.\n', code: EXIT.CONFIG });
      return;
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 24 * 60 * 60 * 1000) {
      finishRequest(runFile, request, { stdout: '', stderr: 'Invalid timeout.\n', code: EXIT.CONFIG });
      return;
    }
    if (Number(request.deadlineMs) <= Date.now()) {
      finishRequest(runFile, request, { stdout: '', stderr: 'Request expired before execution and was not run.\n', code: EXIT.TIMEOUT, uncertain: false });
      return;
    }

    activeRequest = request.id;
    heartbeat('executing');
    client.exec(request.command, (error, stream) => {
      if (error) {
        finishRequest(runFile, request, { stdout: '', stderr: `${error.message}\n`, code: EXIT.BROKER, uncertain: true });
        return;
      }
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let settled = false;

      const append = (kind, chunk) => {
        const buffer = Buffer.from(chunk);
        const used = stdoutBytes + stderrBytes;
        const remaining = Math.max(0, config.maxOutputBytes - used);
        if (buffer.length > remaining) truncated = true;
        const text = buffer.subarray(0, remaining).toString('utf8');
        if (kind === 'stdout') { stdout += text; stdoutBytes += Math.min(buffer.length, remaining); }
        else { stderr += text; stderrBytes += Math.min(buffer.length, remaining); }
      };

      const settle = (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (truncated) response.stderr += `\n[broker] Output truncated at ${config.maxOutputBytes} bytes.\n`;
        finishRequest(runFile, request, response);
      };

      const timer = setTimeout(() => {
        try { stream.close(); } catch {}
        settle({ stdout, stderr: `${stderr}\n[broker] Command channel timed out; remote completion is uncertain.\n`, code: EXIT.TIMEOUT, uncertain: true, truncated });
      }, request.timeoutMs);

      stream.on('data', (chunk) => append('stdout', chunk));
      stream.stderr.on('data', (chunk) => append('stderr', chunk));
      stream.on('close', (code, signal) => {
        const exitCode = code == null ? (signal ? 128 : EXIT.BROKER) : code;
        settle({ stdout, stderr, code: exitCode, uncertain: code == null, truncated });
        log(`EXEC ${request.id} -> ${exitCode}`);
      });
    });
  }

  function stop(runFile, request) {
    stopping = true;
    writeResponse(request.id, { stdout: 'Broker stopped.\n', stderr: '', code: 0, uncertain: false });
    try { fs.unlinkSync(runFile); } catch {}
    heartbeat('stopping');
    setTimeout(shutdown, 25);
  }

  function poll() {
    if (stopping || activeRequest) return;
    const names = fs.readdirSync(paths.queue).filter((name) => name.endsWith('.req.json')).sort();
    for (const name of names) {
      const requestFile = path.join(paths.queue, name);
      const request = readJson(requestFile);
      if (!request?.id || request.id !== name.slice(0, -'.req.json'.length)) {
        try { fs.unlinkSync(requestFile); } catch {}
        continue;
      }
      if (request.type !== 'stop' && (!ready || request.type !== 'exec')) return;
      const runFile = path.join(paths.queue, `${request.id}.run.json`);
      try { fs.renameSync(requestFile, runFile); } catch { continue; }
      if (request.type === 'stop') stop(runFile, request);
      else execute(runFile, request);
      return;
    }
  }

  function cleanup() {
    for (const file of [paths.heartbeat, paths.pid, paths.lock]) {
      const value = readJson(file);
      if (!value || value.token === token || file === paths.heartbeat) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  }

  function shutdown() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { client?.end(); } catch {}
    cleanup();
    process.exit(0);
  }

  recoverInterruptedRequests();
  const heartbeatTimer = setInterval(() => heartbeat(), 5000);
  const pollTimer = setInterval(poll, 200);
  heartbeatTimer.unref();
  pollTimer.unref();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; shutdown(); });
  process.on('exit', cleanup);
  log(`broker started for profile ${profile}`);
  connect();
  return { paths, shutdown };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--validate') values.validate = true;
    else if (item.startsWith('--')) {
      if (index + 1 >= argv.length) throw new Error(`Missing value for ${item}.`);
      values[item.slice(2)] = argv[++index];
    } else throw new Error(`Unknown argument: ${item}`);
  }
  return values;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const configPath = path.resolve(args.config || defaultConfigPath());
    const stateRoot = path.resolve(args['state-root'] || defaultStateRoot());
    const profile = validateProfileName(args.profile || 'default');
    const config = loadProfile(configPath, profile);
    if (args.validate) {
      process.stdout.write(`${JSON.stringify({ profile, host: config.host, port: config.port, username: config.username, auth: config.useAgent ? 'agent' : 'identity-file' })}\n`);
      return;
    }
    const { Client } = require('ssh2');
    createBroker({ configPath, stateRoot, profile, ClientClass: Client });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT.CONFIG;
  }
}

module.exports = {
  EXIT,
  atomicJson,
  createBroker,
  defaultConfigPath,
  defaultStateRoot,
  hostFingerprint,
  loadProfile,
  parseArgs,
  profilePaths,
  validateProfileName,
};

if (require.main === module) main();

