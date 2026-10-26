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
- **`LAIR_HOST`** changes the bind address and adds that host to the allowed origins and `Host` names. A wildcard (`0.0.0.0`, `::`) listens on every interface and **disables the `Host` check**. With no authentication this is unsafe on an untrusted network: never set `LAIR_HOST` to a network or wildcard address there
- **lair-node peers**: `/ws/node` accepts connections from the server's own machine (loopback). Any other peer is refused unless the server has `LAIR_NODE_TOKEN` set and the node presents the same value (`Authorization: Bearer <token>`, or `?token=<token>`); the comparison is constant-time
- **Request parameters** naming files are validated: an invalid or unknown `?project=` and unsafe gate or dragon IDs in API paths get HTTP 400

### Command execution safety

- Commands are executed as argument arrays, never through a shell
- User input is passed as single arguments to prevent injection
- Only commands defined in project configuration are allowed

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
