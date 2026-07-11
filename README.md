<div align="center">

# 🛰️ Remote Dev Kit — VS Code Extension

**Run and hot-reload your project on a remote VPS, from inside VS Code.**
No local Docker. Your code stays on your machine. One click to a live HTTPS URL.

</div>

---

## What it does

Turns any project with a `Dockerfile` into a one-click remote dev environment:

- ☁️ **Deploy** — builds your image **on the VPS** (nothing on your laptop) and serves it at `https://<your-app>.dev.yourdomain.com` with automatic TLS.
- 👀 **Watch (Hot Reload)** — live-syncs your edits into the running container; your dev server reloads instantly. Code never persists on the server.
- 🧹 **Destroy** — one click wipes the deployment (images + volumes) from the VPS.
- 🌐 **Open in Browser**, 📜 **Logs**, 📊 **Status** — all from the sidebar or status bar.

It drives Docker over a remote SSH context — so **you don't install Docker Desktop**, and the extension **doesn't drop any files in your repo** (config lives in VS Code settings; compose stacks are bundled in the extension).

## Requirements

- A **VPS with Docker** and **passwordless SSH** to it.
- A **`docker` CLI** on your machine (no daemon needed): `brew install docker`.
- A **wildcard DNS** record `*.dev` → your VPS IP (set once; covers every project).

## Quick start

1. Install the extension, open your project.
2. Click the **🚀 Remote Dev Kit** icon in the Activity Bar → **Configure…**, and set:
   - `appHost` (e.g. `myapp.dev.yourdomain.com`), `appPort`, `vpsSsh` (e.g. `root@1.2.3.4`)
   - `proxyMode`: **bare** (extension runs Traefik) or **coolify** (existing proxy)
   - `stack`: **generic** (any Dockerfile) or **django** (full Cookiecutter-Django stack)
3. **Connect to VPS** (creates the docker context) → run once.
4. **bare VPS only:** **Start Proxy** → run once per server.
5. Click **Deploy** (or the status-bar **🚀 Deploy** button). Then **Open in Browser**.

For live editing, click **Watch (Hot Reload)** instead of Deploy.

## Frontend-friendly

Nothing Django-specific is required. Point `stack: generic` at any `Dockerfile`
(Node, Vite, Next, Go, Rust, static…), set `appPort` to whatever it serves, and Deploy.
Need a database? It works the same — the extension keeps your service private and only
exposes the web port.

## Settings

All under `remoteDevKit.*` (Command Palette → *Preferences: Open Settings* → search "Remote Dev Kit"):
`projectName`, `appHost`, `appPort`, `vpsSsh`, `stack`, `appDockerfile`, `appService`,
`proxyMode`, `proxyNetwork`, `certResolver`, `certEntrypoint`, `acmeEmail`.

## How it relates to the CLI

This is the GUI companion to [remote-dev-kit](https://github.com/Enochthedev/remote-dev-kit)
(the shell version). Same engine — remote Docker context + Traefik + bundled compose stacks —
without the loose files or terminal commands.

## Develop / build locally

```bash
npm install
npm run compile        # bundle with esbuild → dist/
# press F5 in VS Code to launch an Extension Development Host
npx @vscode/vsce package   # → remote-dev-kit-<version>.vsix
```
