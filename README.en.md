# Persistent SSH Operations

Persistent SSH Operations 是一个面向 Codex 的开源 Skill 与本地 Broker，通过复用已认证 SSH 连接，让 Windows 上的连续远程运维更快、更稳定。Persistent SSH Operations is an open-source Codex skill and local broker that makes repeated Windows-to-server operations faster and more reliable by reusing authenticated SSH connections.

[中文](README.md)

It is intended for deployment checks, service inspection, and ordered maintenance commands, especially when repeated SSH handshakes are slow or trigger cloud-host rate limits.

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
