# Changelog

## 0.5.0

Startup and polling. The extension used to activate in every window and hold a fixed 15-second
SSH poll open for as long as its panel was visible. This release makes it lazy and quiet.

### Startup

- **The extension no longer loads in windows that don't need it.** Activation was
  `onStartupFinished` — every VS Code window, every project, RDK or not. It's now
  `workspaceContains:**/.env.remote`, plus the implicit activation VS Code does when you open the
  panel or run a command. The activity bar icon is unchanged, so a new project is still one click
  away; what's gone is the background load in windows that have nothing to do with RDK.
  The one trade-off: a workspace with a Dockerfile but no `.env.remote` no longer raises an
  unprompted "deploy this?" toast at startup. Open the panel and it offers setup as before.
- **Activation does no network work.** It used to `await` a full probe — discovery, then a
  `docker context inspect`, a `docker compose ps` over SSH and two more SSH calls per project —
  before activation resolved. Against a sleeping VPS that was tens of seconds of the window's
  startup budget spent on a panel you might never open. The first paint is now disk-only and
  instant; projects show `Checking…` and the VPS is asked ~3s later, only if the window has focus.

### Polling

- **The poll backs off.** 15s while things are moving, doubling to a 4-minute ceiling while
  nothing changes. Any real event — a file write, a command, the window regaining focus —
  snaps it back to 15s.
- **Polling stops when you're not looking.** Previously the only condition was panel visibility,
  so a background window with the panel open kept SSHing to your VPS all day. It now also
  requires the window to have focus.
- **A slow probe can't stack.** There was no in-flight guard: on a slow link, probes overlapped
  and whichever finished last won, so fresh state could be overwritten by stale state while ssh
  processes piled up. Concurrent refreshes now join the running one.
- **Fewer round-trips per poll.** Status came from `docker compose ps`, which reads, merges and
  interpolates every compose file before answering — and in overlay mode regenerated the overlay
  on disk each time. It's now a single `docker ps` filtered by the compose project label.
  The expiry read and its reaper check were two connections; they're one. Between reads the
  countdown advances against the local clock instead of asking the VPS again.
- **SSH connections are multiplexed** (`ControlMaster`, 60s persist), so repeat calls skip the
  handshake. The VPS setup probe went from four connections to one.
- **`which docker` is resolved once per session**, not once per project per poll.
- **The tree only rebuilds when a row would actually differ**, instead of reallocating every
  node every 15 seconds.

### Fixes

- **"Docker CLI not found" with Docker installed.** VS Code launched from Finder or the Dock
  hands the extension host a minimal `PATH`, so a working Homebrew install reported as missing.
  RDK now falls back to the usual install locations (Homebrew, Docker Desktop, Rancher Desktop).
- **A running project could collapse to "Not deployed".** Any `ps` failure that wasn't a
  recognised connection error was read as "no containers". A single flaky probe replaced a
  healthy tree with a Deploy button. Unrecognised failures now keep the last known state.
- **A stale tree row could act on the wrong project.** If a row named a folder that had since
  been removed or renamed, the command fell through to "the only project" — silently
  redirecting the click onto a different deployment, which for Destroy is unrecoverable.
  It now asks which project you meant.
- **`compose run` containers no longer appear as phantom services.** A `manage.py migrate` in
  flight could show up as an extra row and drag the project into "degraded".
- **Deploy and Watch no longer re-probe too early.** Both only queue a command in the terminal,
  so the refresh that followed always read the world as it was before the action.
- Setting, extending or clearing an expiry now invalidates the cached countdown immediately.

## 0.4.2

- Projects set up from the CLI now always appear in the sidebar. Discovery used a single
  depth-limited walk (`rdk.scanDepth`, default 2) for every project, so a folder configured
  with `rdk init` deeper than that (say a pnpm workspace app at `repo/apps/personal/`)
  stayed invisible even while it was deployed and running. Folders that already have a
  `.env.remote` are now found at any depth via the editor's file index, which matches the
  `**/.env.remote` file watcher the extension was already using. `rdk.scanDepth` still bounds
  the search for *not-yet-configured* folders, where scanning the whole tree would be
  expensive for no benefit.

## 0.4.1

- New icon. The satellite mark from the RDK marketing site, teal on the site's dark
  palette. Marketplace icon, gallery banner and activity bar now match the brand. The
  status bar and terminal swap the old `$(rocket)` codicon for `$(radio-tower)`.
- http → https redirect. The overlay and all bundled stacks add a plain-HTTP router that
  redirects to HTTPS. Coolify's Traefik has no global redirect, so port 80 used to 404. Configurable via `HTTP_ENTRYPOINT` (default `http`).
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

- Add another project… in the panel. RDK is set up in `app/-b` and you want `app/-c`:
  pick the sibling folder, no re-opening the workspace.
- `rdk.scanDepth` (default `2`) controls how far below each workspace folder RDK looks, and
  `rdk.excludeFolders` skips names you don't want scanned.

## 0.3.0

- Multi-project workspaces. The extension scans each workspace folder and two levels below
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
- Destroy now warns you'll lose the Postgres database on that stack too, not just Django.

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
- Live per-service status with health dots. Click a service for its logs; right-click to
  restart or open a shell in it.
- Links to every URL the stack exposes (app, plus Mailpit and Flower on the Django stack).
- Welcome screens for the empty states, plus a first-run walkthrough.
- One-time, dismissible prompt when a deployable project has no `.env.remote` yet.

### Actions

- Deploy auto-connects. Creating the docker context is no longer a hidden prerequisite you
  had to know about; the "context does not exist" failure is gone.
- Added **Stop** (keeps volumes) as the safe counterpart to Destroy.
- Destroy now confirms, and names what you lose (on the Django stack: the Postgres database).
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
