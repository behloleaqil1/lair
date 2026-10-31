# Getting Started with Lair

This guide walks you through setting up Lair to monitor your first project.

## Prerequisites

- **macOS or Linux**
- **Node.js 22 or 24** (the versions CI tests; Node 20 is end-of-life and not supported) and **npm**
- **Git**
- A C/C++ toolchain only if npm can't download a prebuilt `better-sqlite3` binary for your platform (Xcode Command Line Tools on macOS, `build-essential` and Python 3 on Linux)

Optional: a container runtime (Docker, Podman or Colima) only if your gate pipelines or experimental lair-node jobs run in containers. Lair itself does not need one.

## Installation

```bash
# Clone the repository
git clone https://github.com/behloleaqil1/lair.git
cd lair

# Install dependencies
npm install

# Build the web UI and the server
npm run build

# Start the server (from the repository root)
npm start
```

Open `http://localhost:4777`. The server serves both the API and the built web UI on that port.

Lair reads project configs from `projects/` and writes its state to `data/`, both relative to the directory you start it from, so always start it from the repository root.

### Install scripts

The repository's `.npmrc` sets `ignore-scripts=true`, so `npm install` and `npm ci` run no preinstall, install or
postinstall script of any dependency. Three packages need theirs, and only they are listed in `allowedInstallScripts` in
`package.json`:

- `better-sqlite3`: downloads a prebuilt SQLite binding for your Node.js version, or compiles one
- `esbuild`: checks and installs its platform binary
- `fsevents` (macOS only, optional): file watching; npm does not install it on Linux

`npm run rebuild:native` runs exactly those scripts (`npm rebuild --ignore-scripts=false <name>`). `npm run build`,
`npm run dev` and the test runner (`npm test` or `npx vitest`) run it once after each install, and again when the
lockfile or the Node.js version changes, so the steps above work as they are. `npm run setup` does both in one step:
`npm ci`, then `npm run rebuild:native`.

CI runs `npm run check:install-scripts`, which fails when a dependency in `package-lock.json` has an install script and
is not on the list. If you add such a dependency, read its script first, then add it to `allowedInstallScripts` and to
this section.

### Development mode

For development with hot reload:

```bash
npm run dev
```

This starts the API server on port 4777 and the Vite dev server with hot module replacement. Use the UI at `http://localhost:5173`; Vite forwards `/api` requests to port 4777.

## Creating your first project

Lair monitors projects defined in YAML configuration files. The repository ships `projects/example.yaml`, which points at the synthetic files in `fixtures/` so you can try the UI right away.

For your own project, create a config in `projects/local/` (gitignored, so your paths never end up in a commit):

```bash
mkdir -p projects/local
cp projects/example.yaml projects/local/myproject.yaml
```

Edit `projects/local/myproject.yaml` to point to your repository and workflow files:

```yaml
name: MyProject
repo: /path/to/your/repo
github: your-org/your-repo
queue_file: /path/to/queue.md
agents_dir: /path/to/agents
gates_dir: /path/to/gates
```

The file name (without `.yaml` or `.yml`) is the project name. A file in `projects/local/` takes precedence over one with the same name in `projects/`, and `.yaml` over `.yml` in the same directory. The server picks up new and changed project files without a restart (see [Live config reload](configuration.md#live-config-reload)); reload the dashboard to see a new project in its list.

See [Configuration](configuration.md) for all available options.

## Verifying the setup

1. Open `http://localhost:4777` (or `http://localhost:5173` in dev mode)
2. If you have more than one project, pick it from the project selector in the header. The dashboard opens the project named in `LAIR_PROJECT` (for example `LAIR_PROJECT=myproject npm start`), else `example` when it exists, else the first project
3. Check **Home**: its "needs you" list shows config problems (a path that doesn't exist, a file Lair can't read) with what to fix
4. Open **PRs**: with `github:` set and the [GitHub CLI](https://cli.github.com/) signed in, your open pull requests are listed; open **Gates** and **Work** to see what Lair reads from your gates directory and queue file

## Next steps

- Connect your agents: the fleet bus (MCP) or the queue file, in [Agents](agents.md)
- Learn the words Lair uses in the [Glossary](glossary.md)
- Read the [Configuration](configuration.md) guide to customize your project
- Explore the [Architecture](architecture.md) to understand how Lair works
- Want to help? Pick a [good first issue](https://github.com/behloleaqil1/lair/issues?q=is%3Aopen+label%3A%22good+first+issue%22) and read [CONTRIBUTING.md](../CONTRIBUTING.md)

## Troubleshooting

### Server won't start

- Check that port 4777 is not in use: `lsof -i :4777`
- Verify Node.js version: `node --version` (should be 22 or 24)
- If `npm run rebuild:native` (or the first `npm run build`) failed on `better-sqlite3`, install the C/C++ toolchain listed under Prerequisites and run `npm run rebuild:native` again; after a Node.js upgrade, run it once too
- Read the server's output in the terminal where you ran `npm start` (a service manager writes it to its log file instead); each module logs its start and any config error with a `[module]` prefix

### Project not showing

- Ensure the YAML file is in `projects/` or `projects/local/`
- Check that the file name ends in `.yaml` or `.yml`
- Check the project name (the file name without the extension): it must start with a letter or digit and contain only letters, digits, `.`, `_` and `-`. Other files are not listed
- Verify the YAML syntax is valid: an invalid file shows in a banner on the dashboard, with the error
- Reload the dashboard after adding the file

### Can't connect to the UI

- The server binds to `127.0.0.1` only by default (localhost)
- After `npm start`, if the server logs "No built web UI found", run `npm run build` first
- In development mode, the UI runs on port 5173, not 4777
- If `npm run dev` stops with "Port 5173 is already in use", another process (often an earlier `npm run dev`) holds the port: find it with `lsof -i :5173` and stop it. Vite is set to `strictPort`, so it fails instead of moving to 5174, because the server only accepts the dashboard from ports 5173 and 4777 and would refuse a page on 5174 with HTTP 403
- Check browser console for WebSocket connection errors
- An HTTP 403 ("Cross-origin request refused" or "Unexpected Host header") means the page was opened under a host name the server does not know: use `http://localhost:4777` or `http://127.0.0.1:4777` (or the address in `LAIR_HOST`)
