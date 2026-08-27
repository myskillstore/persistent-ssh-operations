# Troubleshooting

## `hostkey-pending`

Run `hostkey-show`, verify the fingerprint independently, then approve the exact fingerprint. A mismatch is a security stop, not a cache-cleaning problem.

## Broker does not become ready

Run `status`, then inspect the profile-local `broker.log` under the state path. Confirm that the profile exists, the hostname resolves, TCP port 22 is reachable, and the selected key or SSH agent is available.

## Dependency bootstrap fails

Run `npm.cmd ci --ignore-scripts --omit=dev` in the skill directory. The lockfile pins the runtime dependency. Do not install into a global Node.js location as a workaround.

## Exit 124 or 125

Do not immediately rerun a mutating command. Query the remote state with a read-only command first. Exit 124 means the channel timeout fired; exit 125 means the broker could not prove the result.

## Stale daemon state

Run `stop` first. If no live broker responds, `start` can replace a stale lock only when its recorded process no longer exists. Do not kill a PID copied from the state directory without verifying process ownership and command line.

