---
name: persistent-ssh-operations
description: Reuse authenticated SSH connections for repeated Windows-to-server operations through a local profile-based broker. Use for multi-command remote maintenance where repeated SSH handshakes are slow or rate-limited; do not use for interactive shells, file transfer, or port forwarding.
metadata:
  short-description: Reuse persistent SSH connections safely
---

# Persistent SSH Operations

Use the bundled PowerShell CLI to execute repeated remote commands over one authenticated SSH connection per profile.

## Non-negotiable gates

- Read [references/operations.md](references/operations.md) before first setup or host-key rotation.
- Keep profiles and runtime state outside repositories. Never commit private keys, real profile files, pending host keys, queues, results, or logs.
- Require the user to verify and explicitly approve a new or changed host-key fingerprint. Never bypass a mismatch by deleting state.
- Do not put passwords, tokens, private keys, or other secrets in remote command arguments. Use an authorized interactive or standard-input workflow outside this broker when a command needs secret input.
- Do not automatically retry an SSH command after timeout, disconnect, or unknown completion. Report the uncertain outcome before any manual retry.
- Obtain authorization immediately before destructive, privileged, production-changing, or externally consequential remote commands. Read-only diagnostics do not imply permission to mutate the server.
- Treat each profile as one ordered command stream. Use distinct profiles when independent targets or concurrency are required.

## Workflow

1. Resolve the directory containing this `SKILL.md` and invoke `scripts/persistent-ssh.ps1` from that directory.
2. Run `config-path`, create the local profile file from `config.example.json`, and keep it untracked.
3. Run `start <profile>`. On first contact, inspect `hostkey-show <profile>` and verify the fingerprint through an independent trusted channel.
4. Approve the exact fingerprint with `hostkey-approve <profile> -Fingerprint <SHA256:...>`.
5. Run `exec <profile> '<command>'`, choosing a bounded timeout. Preserve and report stdout, stderr, and the remote exit code.
6. Run `status <profile>` for connection state and `stop <profile>` when the persistent session is no longer needed.

Read [references/security.md](references/security.md) before commands involving production changes, root access, secrets, or host-key rotation. Read [references/troubleshooting.md](references/troubleshooting.md) only when setup, connection, or recovery fails.

