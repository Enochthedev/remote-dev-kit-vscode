<div align="center">

# 🛰️ Remote Dev Kit — VS Code Extension

**Run and hot-reload your project on a remote VPS, from inside VS Code.**
No local Docker. Your code stays on your machine. One click to a live HTTPS URL.

</div>

---

## What it does

Turns any project with a `Dockerfile` into a one-click remote dev environment:

- ☁️ **Deploy** — builds your image **on the VPS** (nothing on your laptop) and serves it at `https://<project>.dev.yourdomain.com` with automatic TLS.
- 👀 **Watch (Hot Reload)** — live-syncs your edits into the running container; your dev server reloads instantly. Code never persists on the server.
- 🔎 **Live sidebar** — per-service status dots, links to every URL the stack exposes, logs and a shell one click away.
- ⏸ **Stop** (keeps your database) vs 🗑 **Destroy** (wipes images + volumes, and says so before it does).

It drives Docker over a remote SSH context — so **you don't install Docker Desktop**, just the `docker` CLI.

## Requirements

- A **VPS with Docker** and **passwordless SSH** to it.
- A **`docker` CLI** on your machine (no daemon needed): `brew install docker`.
- A **wildcard DNS** record `*.dev.yourdomain.com` → your VPS IP (set once; covers every project).

## Quick start

1. Install the extension and open your project.
2. The sidebar offers **Set Up This Project**. Click it.
3. Answer **two** questions — project name and URL, both pre-filled.
4. Click **Deploy**.

There is no settings screen to visit. The first time you ever run setup it also asks for your
**SSH target** and **wildcard domain** — once, for every project you'll ever deploy.

Everything else is detected:

| | Detected from |
|---|---|
| **Stack** | `manage.py` → Django, otherwise your `Dockerfile` |
| **Port** | the `EXPOSE` line in your Dockerfile |
| **Proxy mode / network** | RDK SSHes in and looks — existing Coolify/Traefik, or none |
| **Cert resolver / entrypoint** | read off your running proxy |
| **URL** | `<project>.<your wildcard domain>` |

## Configuration lives in `.env.remote`

Setup writes a single file to your project — **`.env.remote`** — and adds it to git's exclude
list so your SSH target is never committed.

This is *the same file* the [`rdk` CLI](https://github.com/Enochthedev/remote-dev-kit) reads.
Configure it in the extension and `rdk up` in a terminal does exactly the same thing; run
`rdk init` in a terminal and the extension picks it up on sight. One source of truth, either way.

Hand-edit it whenever you like — the extension watches the file and re-reads it on save.
If it still contains `rdk init` placeholders, the sidebar tells you exactly which keys to fix.

### The only VS Code settings

Six values under `rdk.*`, all **global** — you set them once and every future project reuses them.
The setup wizard fills them in, so you shouldn't need to open Settings at all:

`vpsSsh`, `baseDomain`, `acmeEmail`, `proxyNetwork`, `certResolver`, `certEntrypoint`

## Frontend-friendly

Nothing Django-specific is required. Point it at any `Dockerfile` (Node, Vite, Next, Go, Rust,
static…) and Deploy. The extension keeps your services private and only exposes the web port
through the proxy.

## How it relates to the CLI

This is the GUI companion to [remote-dev-kit](https://github.com/Enochthedev/remote-dev-kit)
(the shell version). Same engine — remote Docker context + Traefik + bundled compose stacks —
and now the same config file. **Doctor** and **Security audit** in the sidebar shell out to
`rdk doctor` / `rdk audit` when the CLI is installed.

## Develop / build locally

```bash
npm install
npm run compile        # bundle with esbuild → dist/
npm run lint           # tsc --noEmit
# press F5 in VS Code to launch an Extension Development Host
npx @vscode/vsce package   # → remote-dev-kit-<version>.vsix
code --install-extension remote-dev-kit-*.vsix   # try it in your editor
```

## Publishing to the Marketplace

One-time (needs a Marketplace **publisher** + an Azure DevOps **Personal Access Token**
with Marketplace → Manage scope):

```bash
npx @vscode/vsce create-publisher enochthedev   # once, if not created
npx @vscode/vsce login enochthedev              # paste your PAT
npx @vscode/vsce publish                        # from this folder
```

Bump `version` in `package.json` before each publish. `vsce publish patch|minor|major`
bumps + publishes in one step.
