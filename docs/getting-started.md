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

The file name (without `.yaml`) is the project name. A file in `projects/local/` takes precedence over one with the same name in `projects/`. Restart the server after adding a project.

See [Configuration](configuration.md) for all available options.

## Verifying the setup

1. Open `http://localhost:4777` (or `http://localhost:5173` in dev mode)
2. If you have more than one project, pick it from the project selector in the header. The dashboard opens the project named in `LAIR_PROJECT` (for example `LAIR_PROJECT=myproject npm start`), else `example` when it exists, else the first project
3. Check the Overview page for any detected problems
4. Verify that your repository status is showing correctly

## Next steps

- Read the [Configuration](configuration.md) guide to customize your project
- Learn about [Agents](agents.md) to connect your AI coding tools
- Explore the [Architecture](architecture.md) to understand how Lair works

## Troubleshooting

### Server won't start

- Check that port 4777 is not in use: `lsof -i :4777`
- Verify Node.js version: `node --version` (should be 22 or 24)
- If `npm install` failed on `better-sqlite3`, install the C/C++ toolchain listed under Prerequisites and run `npm install` again
- Check logs for errors

### Project not showing

- Ensure the YAML file is in `projects/` or `projects/local/`
- Check that the file name ends in `.yaml` (`.yml` is not loaded)
- Check the project name (the file name without the extension): it must start with a letter or digit and contain only letters, digits, `.`, `_` and `-`. Other files are not listed
- Verify the YAML syntax is valid
- Restart the server after adding the file

### Can't connect to the UI

- The server binds to `127.0.0.1` only by default (localhost)
- After `npm start`, if the server logs "No built web UI found", run `npm run build` first
- In development mode, the UI runs on port 5173, not 4777
- Check browser console for WebSocket connection errors
- An HTTP 403 ("Cross-origin request refused" or "Unexpected Host header") means the page was opened under a host name the server does not know: use `http://localhost:4777` or `http://127.0.0.1:4777` (or the address in `LAIR_HOST`)
