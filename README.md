# Remote Dev Kit

Run and hot-reload your project on a remote VPS, from inside VS Code. No local Docker, no
containers on your laptop, and your code never leaves your machine.

[![Version](https://img.shields.io/visual-studio-marketplace/v/wavestudio.remote-dev-kit)](https://marketplace.visualstudio.com/items?itemName=wavestudio.remote-dev-kit)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/wavestudio.remote-dev-kit)](https://marketplace.visualstudio.com/items?itemName=wavestudio.remote-dev-kit)

---

## What it does

Point it at any project with a `Dockerfile` and it becomes a one-click remote dev environment.

**Deploy** builds the image *on the VPS* and serves it at `https://<project>.dev.yourdomain.com`
with a real certificate. Nothing is built locally.

**Watch** live-syncs your edits into the running container, so your dev server reloads as you
type. Your source stays on your machine; only the changes travel.

**The sidebar** shows a status dot per service, every URL the stack exposes, and puts logs and a
shell one click away.

**Stop** keeps your database. **Destroy** wipes images and volumes, and tells you so before it
does it.

It drives Docker over a remote SSH context, which is why you don't need Docker Desktop, just
the `docker` CLI.

## Requirements

- A VPS with Docker installed, and passwordless SSH to it
- The `docker` CLI locally, no daemon needed (`brew install docker`)
- A wildcard DNS record, `*.dev.yourdomain.com` pointing at the VPS

The DNS record is set once and covers every project you'll ever deploy.

## Getting started

1. Install the extension and open a project that has a `Dockerfile`.
2. The sidebar offers **Set Up This Project**. Click it.
3. Answer two questions — project name and URL. Both are pre-filled.
4. Click **Deploy**.

The first run also asks for your SSH target and wildcard domain. Once, ever. Every later project reuses them.

There is no settings screen to visit. Everything else is detected:

| | Detected from |
|---|---|
| Stack | `manage.py` means Django, otherwise your `Dockerfile` |
| Port | the `EXPOSE` line in your Dockerfile |
| Proxy mode and network | RDK connects and looks: existing Coolify or Traefik, or none |
| Cert resolver and entrypoint | read from the running proxy |
| URL | `<project>.<your wildcard domain>` |

## Configuration

Setup writes one file to your project, `.env.remote`, and adds it to git's exclude list so your
SSH target is never committed.

This is the same file the [`rdk` CLI](https://github.com/Enochthedev/remote-dev-kit) reads.
Configure it here and `rdk up` in a terminal does exactly the same thing; run `rdk init` in a
terminal and the extension picks it up on sight. One source of truth, either way.

Edit it by hand whenever you like. The extension watches the file and re-reads it on save. If
it still contains `rdk init` placeholders, the sidebar names the keys that need fixing.

Six global VS Code settings sit under `rdk.*`: `vpsSsh`, `baseDomain`, `acmeEmail`,
`proxyNetwork`, `certResolver`, `certEntrypoint`. The setup wizard fills them in, so you
shouldn't need to open Settings at all.

## Works with any stack

Nothing here is Django-specific. Point it at any `Dockerfile` (Node, Vite, Next, Go, Rust, static)
and deploy. Services stay private; only the web port is exposed through the proxy.

## Relationship to the CLI

This is the GUI companion to [remote-dev-kit](https://github.com/Enochthedev/remote-dev-kit).
Same engine underneath: a remote Docker context, Traefik, and bundled compose stacks. Doctor
and Security audit in the sidebar shell out to `rdk doctor` and `rdk audit` when the CLI is
installed.

## Contributing

Local development, packaging and release steps are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
