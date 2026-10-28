# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Lair, please report it responsibly.

**Do not open a public issue for security vulnerabilities.**

Instead, use GitHub's [private vulnerability reporting](https://github.com/behloleaqil1/lair/security/advisories/new) to submit your report. Include:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Any suggested fixes (if you have them)

We will acknowledge receipt within 48 hours and provide a more detailed response within 7 days, including:

- Confirmation of the vulnerability
- Our plan to address it
- Expected timeline for a fix

## Security Design

Lair is designed with security in mind:

### Local-only by default

- The server binds to `127.0.0.1:4777` by default
- Lair has **no authentication**: anyone who can reach the port can read project data and, when controls are enabled, run the configured commands
- Any process running on the same machine can reach the local port

### Browser and network checks

- **Cross-site requests are refused.** A request whose `Origin` is not one of the dashboard's own (`http://localhost`, `http://127.0.0.1` or `http://[::1]` on port 4777 or 5173) gets HTTP 403, including "simple" POSTs that never trigger a CORS preflight. WebSocket handshakes on `/ws` and `/ws/node` get the same check. Requests without an `Origin` header (non-browser clients such as `curl` or lair-node) are allowed
- **Foreign `Host` headers are refused** (HTTP 403), which blocks DNS rebinding: a page on another domain that re-resolves its name to 127.0.0.1 still sends its own name as `Host`
- **`LAIR_HOST`** changes the bind address and adds that host to the allowed origins and `Host` names, so a browser that opens `http://<LAIR_HOST>:4777` gets the full dashboard. A wildcard (`0.0.0.0`, `::`) listens on every interface and **disables the `Host` check**, but adds no allowed origin (a wildcard is not an address a page can be served from). A browser on another machine then gets only the read-only GET requests, which carry no `Origin`; its POSTs (every control) get HTTP 403 and its WebSocket handshakes are refused. With no authentication either setting is unsafe on an untrusted network: never set `LAIR_HOST` to a network or wildcard address there
- **lair-node peers**: `/ws/node` accepts connections from the server's own machine (loopback). Any other peer is refused unless the server has `LAIR_NODE_TOKEN` set and the node presents the same value (`Authorization: Bearer <token>`, or `?token=<token>`); the comparison is constant-time
- **Request parameters** naming files are validated: an invalid or unknown `?project=`, unsafe gate or dragon IDs in API paths, and a dragon start/stop request for a dragon that is neither in the YAML `dragons:` map nor in `dragons.txt` get HTTP 400

### The owner session (answering decisions)

Answering a Decision Inbox item is the one action that needs a signed-in owner. Signing in needs the owner token in `data/owner.token`, created at first start and readable only by your OS user; the server prints a one-time setup link to its output. The browser keeps its session in the dashboard origin's storage and sends it in a header, never a cookie, so other programs (agents and other local apps included) can't approve the work a decision holds back. A program running as your OS user can read that file and the server's output: run agents as a separate OS user to close that gap. Signed-in browsers are listed in the Decisions view, where you can sign each out ([details](docs/configuration.md#decision-inbox)).

### Command execution safety

- Controls, dragon start/stop, the process manager and local gate scripts run their commands as argument arrays, never through a shell
- User input is passed as single arguments to prevent injection
- Only commands defined in project configuration are allowed
- Two exceptions do go through a shell; in both, the command itself comes from your own project config:
  - The legacy `ssh_cmd` machine setting is a shell command string, and Lair runs it with the local shell to check whether the machine is up
  - Remote gate commands (and the SSH health check, `echo up && uptime`) are passed to `ssh` as one command string, which the remote user's shell parses. Lair builds the gate string as `cd '<dir>' && NAME='value' '<script>' '<config>' '<worktree>'` with every value single-quoted. The script and directories come from your config; env vars come from gate requests, so their names must be plain identifiers and may not be loader, shell, git or runtime variables (`PATH`, `LD_*`, `GIT_CONFIG_*`, `NODE_OPTIONS` and others)

### Credential handling

- SSH keys are referenced by path, never stored by Lair
- No `.env` files or credential stores are read
- Secrets are never displayed in the UI or logged

### Read-only by default

- All write operations are disabled by default (`read_only: true`)
- Each control action requires explicit configuration
- Only stopping a running dragon asks for confirmation in the UI; every other control runs as soon as you click it, so keep `read_only: true` unless you need the controls

### Audit logging

- Control actions are logged to `data/audit.log`
- Logs include timestamp, action, command, exit code, and output
- Audit trail is visible in the Activity view

## Best Practices for Users

1. **Keep Lair local**: Don't expose Lair to the network; there is no authentication
2. **Use read-only mode**: Only enable controls when needed
3. **Protect SSH keys**: Use dedicated keys for Lair with minimal permissions
4. **Review configurations**: Check project YAML files for correct paths and commands
5. **Monitor audit logs**: Regularly review `data/audit.log` for unexpected actions

## Known Limitations

- Lair trusts the project configuration file; ensure it's not writable by untrusted users
- The UI displays information from the monitored project; ensure project files don't contain sensitive data
- SSH commands are run with the configured user's permissions
- The experimental lair-node daemon uses placeholder keys and signatures, and its WebSocket is unencrypted (a remote node's `LAIR_NODE_TOKEN` travels in clear text); don't run it across an untrusted network
