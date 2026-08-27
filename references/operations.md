# Operations

## Requirements

- Windows PowerShell 5.1 or later
- Node.js 20 or later
- npm available as `npm.cmd`
- Key-based SSH authentication or a running SSH agent exposed through `SSH_AUTH_SOCK`

The first broker start installs the exact `ssh2` version from the repository lockfile with lifecycle scripts disabled. No dependency is installed into a global Node.js location.

## Local paths

The default profile file is:

```text
%APPDATA%\persistent-ssh-operations\profiles.json
```

The default runtime state root is:

```text
%LOCALAPPDATA%\persistent-ssh-operations
```

Override them for testing or isolated environments with `PERSISTENT_SSH_CONFIG` and `PERSISTENT_SSH_STATE_DIR`. Neither path may point into a repository intended for publication.

Discover the effective config path:

```powershell
.\scripts\persistent-ssh.ps1 config-path
```

Copy `config.example.json` to that location, replace placeholders, and keep only local profiles there. A profile name may contain letters, digits, dots, underscores, and hyphens.

Use either `identityFile` or `useAgent: true`, not both. Encrypted private-key passphrases are intentionally not accepted through command arguments or profile files; load such keys into an SSH agent.

## Commands

```powershell
.\scripts\persistent-ssh.ps1 start production
.\scripts\persistent-ssh.ps1 status production
.\scripts\persistent-ssh.ps1 hostkey-show production
.\scripts\persistent-ssh.ps1 hostkey-approve production -Fingerprint 'SHA256:<verified-fingerprint>'
.\scripts\persistent-ssh.ps1 exec production 'uname -a' -TimeoutSec 60
.\scripts\persistent-ssh.ps1 stop production
```

`exec` preserves the remote exit code. Local control failures use these reserved codes:

| Code | Meaning |
| --- | --- |
| 124 | The broker closed the SSH channel after the requested timeout. Completion is uncertain. |
| 125 | Local broker or IPC failure, including an outcome lost across broker restart. |
| 126 | Host-key approval is required or the stored fingerprint does not match. |
| 127 | Local configuration or dependency failure. |

The broker executes one command at a time per profile. It never retries an `exec` request automatically.

## Host-key approval

On first contact the connection is refused and a pending fingerprint is recorded. Compare it with a fingerprint obtained through a trusted provider console, an existing verified `known_hosts` entry, or an administrator using a separate authenticated channel. Approve only the exact displayed value.

When a host key changes, stop and investigate. Rotation is approved with the same exact-fingerprint command only after the change is independently confirmed.

