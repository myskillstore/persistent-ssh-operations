# Persistent SSH Operations

Persistent SSH Operations 是一个面向 Codex 的开源 Skill 与本地 Broker。它解决智能体执行连续远程命令时，每次调用都重新完成 SSH 握手所带来的延迟、限流和不稳定问题。Persistent SSH Operations is an open-source Codex skill and local broker. It solves the latency, throttling, and instability caused when agents perform a full SSH handshake for every remote command.

[中文](README.md)

## Why this skill exists

A person normally signs in to a server once and runs several commands in the same shell. An agent often performs the same operation as a sequence of isolated tool calls:

```text
check Git status → inspect service → read logs → deploy → verify health
```

When every call launches ordinary `ssh`, each command repeats DNS resolution, TCP setup, SSH key exchange, host-key verification, and user authentication. The remote command may take milliseconds while connection setup takes seconds.

That creates four practical problems:

| Pain point | Operational impact |
| --- | --- |
| Repeated handshake latency | A sequence of short commands becomes noticeably slow and agent feedback is delayed. |
| Cloud-host connection throttling | Bursts of new sessions can trigger SSH `MaxStartups`, security controls, or provider rate limits. |
| Lower reliability during long tasks | Deployments, diagnostics, and acceptance checks see more intermittent handshake failures. |
| Unsafe shortcuts | Automatically trusting a changed host key or replaying a write after disconnect turns a performance fix into a security risk. |

The real problem is therefore not “how to wrap another SSH command,” but:

> How can an agent reuse an authenticated transport for consecutive commands without weakening host identity, operation authorization, or failure handling?

## How it solves the problem

The project separates safe usage from connection persistence:

- The Codex skill decides when reuse is appropriate and enforces host-key, authorization, secret-handling, and recovery rules.
- A local broker keeps one authenticated `ssh2` connection for each profile.
- Every remote command opens only a new SSH channel on that connection instead of performing another handshake.
- Keepalives and exponential backoff restore the transport, but uncertain commands are never replayed automatically.
- Profiles, host keys, queues, results, and logs remain outside repositories.

After the first connection is authenticated, status checks, log reads, deployment steps, and health verification continue through the same transport. The project reuses the SSH connection, not the user's authorization.

## When to use it

Good fits:

- One task needs three or more commands on the same server.
- SSH setup is slower than the remote commands themselves.
- A cloud host is sensitive to bursts of new SSH connections.
- Codex is deploying, diagnosing, reading logs, controlling a service, or running consecutive acceptance checks.

Not a fit:

- An occasional one-off remote command.
- Interactive shells, TTY workflows, or secret entry in a terminal.
- SFTP/SCP, port forwarding, or password authentication.
- Automatic retries of non-idempotent writes after a disconnect.

## Highlights

- Keeps one `ssh2` connection per profile and opens a channel for each command.
- Uses 30-second keepalives and reconnects the transport after a disconnect.
- Requires explicit verification and approval for new or changed host keys.
- Executes commands sequentially per profile and never retries after timeout or disconnect.
- Keeps profiles, host keys, queues, results, and logs outside the repository.
- Preserves remote exit codes for scripts and Codex workflows.

## Requirements

- Windows PowerShell 5.1+
- Node.js 20+
- npm
- Private-key authentication or an SSH agent exposed through `SSH_AUTH_SOCK`

## Quick start

Install the pinned dependency:

```powershell
npm.cmd ci --ignore-scripts --omit=dev
```

Print the local config path:

```powershell
.\scripts\persistent-ssh.ps1 config-path
```

Copy `config.example.json` there and define a local profile. The first connection stops in `hostkey-pending`:

```powershell
.\scripts\persistent-ssh.ps1 start production
.\scripts\persistent-ssh.ps1 hostkey-show production
.\scripts\persistent-ssh.ps1 hostkey-approve production -Fingerprint 'SHA256:<verified-fingerprint>'
.\scripts\persistent-ssh.ps1 exec production 'uname -a' -TimeoutSec 60
```

Verify the fingerprint through a cloud-provider console, an existing trusted `known_hosts` entry, or a separate administrator channel. Never place passwords, tokens, or private keys in remote command arguments.

See [SKILL.md](SKILL.md) for the Codex workflow and [references/operations.md](references/operations.md) for configuration and exit codes.

## Current scope

The first release does not provide interactive shells, SFTP/SCP, port forwarding, password authentication, or an MCP interface. The broker improves connection reuse without expanding remote-operation authorization.

## Validation

```powershell
npm.cmd test
npm.cmd run check:syntax
```

## License

[MIT](LICENSE)
