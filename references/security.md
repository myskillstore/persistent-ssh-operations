# Security Boundaries

## Authorization

The broker changes transport efficiency, not authorization. A read-only status request does not authorize deployment, restart, package installation, data mutation, credential rotation, firewall changes, or deletion. Confirm scope before consequential commands.

## Secrets

Remote commands are transiently written to a user-local queue before execution. Never place a password, API token, private key, session cookie, or recovery secret in the command string. The broker also does not provide an interactive TTY or secret-standard-input channel.

Prefer an SSH agent for encrypted keys. If `identityFile` is used, keep the key outside repositories and restrict its filesystem permissions to the current user.

## Host identity

The broker deliberately refuses trust-on-first-use. Unknown and changed fingerprints remain pending until the exact fingerprint is approved. Do not delete the known-host record as a shortcut around a mismatch.

## Retry and recovery

The daemon reconnects the transport, but it never replays a remote command. If a timeout, disconnect, local crash, or broker restart makes completion uncertain:

1. Report the command and uncertain state without exposing secrets.
2. Check the remote system using a read-only, idempotent query.
3. Retry only when the observed state proves the original operation did not complete and authorization still applies.

## Runtime state

The state directory contains host fingerprints, heartbeat metadata, transient requests/results, a PID, and a local log. Keep it user-local, exclude it from backups shared with others, and do not publish it. The log records connection state and request IDs, not command text.

