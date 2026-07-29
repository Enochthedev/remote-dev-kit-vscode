# Changelog

## 0.4.1

- **New icon.** The satellite mark from the RDK marketing site, teal on the site's dark
  palette — marketplace icon, gallery banner, and activity bar now match the brand. The
  status bar and terminal swap the old `$(rocket)` codicon for `$(radio-tower)`.
- **http → https redirect.** The overlay and all bundled stacks add a plain-HTTP router
  that redirects to HTTPS. Coolify's Traefik has no global redirect, so port 80 used to
  404. Configurable via `HTTP_ENTRYPOINT` (default `http`).
- Bundled stacks re-synced with the CLI's (redirect labels, Traefik entrypoint renamed
  `web` → `http` to match Coolify's naming).

## 0.4.0

### Overlay mode

- The extension understands `BASE_COMPOSE`. If your project has its own compose file, that file
  is the source of truth and RDK layers on only the proxy network and the Traefik labels — it
  no longer redefines your services. Without this the extension would have shown an overlay
  project as *"setup unfinished"* and deployed the wrong stack.
- The generated overlay is **byte-identical to the CLI's**, verified by diff. The same
  `.env.remote` deploys the same thing whether you click Deploy or run `rdk up`.
- The setup wizard offers your compose file when it finds one, and asks which of **your**
  services faces the web — picked from a list, because `APP_SERVICE` cannot be guessed.

### Expiry

- Projects show `Expires in 3h 41m` in the sidebar. Click to extend. **Set Expiry**,
  **Extend Expiry**, **Clear Expiry**, and **Start TTL Reaper** in the panel and palette.
- You get a warning before it expires, while you're still at your desk to do something about
  it. If you're not, it stops anyway — that's the point of a server-side timer.
- If an expiry is set but no reaper is running, the sidebar says so loudly. A TTL nobody
  enforces is worse than no TTL: you'd believe the box was cleaning itself up.
- Expiry **stops, never destroys** — volumes survive.

### Monorepos

- **Add another project…** in the panel. RDK is set up in `app/-b` and you want `app/-c`:
  pick the sibling folder, no re-opening the workspace.
- `rdk.scanDepth` (default `2`) controls how far below each workspace folder RDK looks, and
  `rdk.excludeFolders` skips names you don't want scanned.

## 0.3.0

- **Multi-project workspaces.** The extension scans each workspace folder and two levels below
  it, so opening a monorepo root finds the projects nested inside. Each gets its own row, its
  own status, and its own actions — a click under one project can never act on another.
- The active project follows your open editor. When a command is ambiguous, RDK asks instead of
  guessing; deploying the wrong service is not recoverable.
- Setup no longer scaffolds blindly at the workspace root — in a monorepo that writes a
  `.env.remote` nothing will ever read.

## 0.2.1

- Bundle `docker-compose.remote-db.yml` (Postgres + Redis). It shipped in the CLI but not here,
  so a project using it failed with "stack file missing".
- The wizard offers **Generic + Postgres/Redis** and generates `REDIS_PASSWORD` rather than
  asking you to invent a secret.
- A missing `REDIS_PASSWORD` is now reported as *setup unfinished* instead of failing at
  compose time — the stack guards it with `:?` and Redis refuses to boot without it.
- **Destroy** now warns you'll lose the Postgres database on that stack too, not just Django.

## 0.2.0

Setup and day-to-day use no longer go through the Settings screen.

### Configuration

- Config now lives in **`.env.remote`** — the same file the `rdk` CLI reads. Configure it in the
  editor and `rdk up` works from a terminal; run `rdk init` in a terminal and the extension picks
  it up. Previously the two had separate, silently diverging config.
- Added a **setup wizard**. It detects your stack (Django vs generic), your port (from `EXPOSE`),
  and SSHes into the VPS to detect your proxy mode, network, cert resolver and entrypoint. It asks
  two questions; everything else is inferred.
- The **VPS SSH target and wildcard domain are now global** and asked once, ever. Every later
  project reuses them — they used to be re-entered per workspace.
- Settings dropped from 11 per-project keys to 6 global ones. The wizard fills them in.
- `.env.remote` is added to `.git/info/exclude` on creation, so the SSH target is never committed.
- Hand-edits to `.env.remote` are picked up on save.

### Sidebar

- The tree is now **state-aware**: it knows whether you're unconfigured, disconnected, not
  deployed, stopped, degraded or running, and shows only the actions that apply.
- **Live per-service status** with health dots. Click a service for its logs; right-click to
  restart or open a shell in it.
- Links to every URL the stack exposes (app, plus Mailpit and Flower on the Django stack).
- Welcome screens for the empty states, plus a first-run walkthrough.
- One-time, dismissible prompt when a deployable project has no `.env.remote` yet.

### Actions

- **Deploy auto-connects.** Creating the docker context is no longer a hidden prerequisite you
  had to know about; the "context does not exist" failure is gone.
- Added **Stop** (keeps volumes) as the safe counterpart to Destroy.
- **Destroy now confirms**, and names what you lose (on the Django stack: the Postgres database).
  It offers Stop instead. It used to be a single unconfirmed click that wiped volumes.
- Added **Shell**, **Restart**, **manage.py…** (Django), **Doctor** and **Security audit**
  (delegated to the `rdk` CLI when present).
- Failures surface as notifications with a link to the output channel, instead of scrolling past
  in a terminal.
- Status bar reflects live state and offers the right next action.

## 0.1.0

- Initial release.
- Sidebar + status-bar UI: Deploy, Watch (hot reload), Logs, Status, Destroy, Open in Browser.
- Connect to VPS (remote docker context), Start Proxy (bare-VPS Traefik).
- Generic (any Dockerfile) and Django stacks bundled.
- Config via VS Code settings — no files written into your repo.
