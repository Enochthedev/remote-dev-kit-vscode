# Changelog

## 0.6.0

Several machines, one deployment. Set up the same repo on two machines against one VPS and they
already shared a deployment, silently: whoever deployed last replaced the other's build, and
nothing said whose code was running. Sharing stays the default, but now it's visible and asks
before overwriting.

- **Every deploy records who deployed what.** Deploy and Watch add labels to the app container:
  the device, the SSH user it logged in as, the git repo, the commit, whether there were
  uncommitted changes, and when. They live on the VPS, so every machine reads the same record,
  whichever SSH user it uses.
- **Setup offers to join an existing deployment.** If this repo is already deployed on the VPS
  (or, for deploys made before this version, something with the same project name), setup lists
  it with who deployed it and when, and offers to join it or set up a separate one. Joining means
  both machines deploy to it; replacing the other machine's build still asks first.
- **Two projects can't share a name.** Containers, volumes and the URL router are all keyed by the
  project name, so a clash means one project replaces the other. Setup checks whatever name you
  pick against the VPS and refuses one that's taken. If setup couldn't reach the VPS to check, it
  says so instead of assuming the name is free. And Deploy refuses outright (no "replace anyway")
  when the name on the VPS belongs to a different repo: change `PROJECT_NAME` instead.
- **Deploying over an unrecorded deployment asks once.** Deploys from the CLI or older versions
  have no record of who made them. The first Deploy from this version asks before replacing one,
  then records it.
- **A fresh clone knows it's already deployed.** `.env.remote` is git-ignored, so a second machine
  or a new clone used to see a blank "Deploy this project". If this machine already has your VPS
  set up, the panel asks it once and, when this repo is running there, shows "Already deployed on
  your VPS" with a Join option instead.
- **Monorepos: packages don't mistake each other's deployments for their own.** Packages share a
  git remote, so the stamp also records the folder within the repo. Setup and the sidebar only
  treat a deployment as this project's when both match, and Deploy refuses to replace a sibling
  package that happens to use the same project name.
- **The sidebar says whose code is live.** A "Deployed from …" row shows the device, commit and
  age. "Your code differs" appears when your commit isn't the one running, and clicking it deploys
  yours. "Different repo on the VPS" warns when two unrelated projects share a project name.
- **Replacing another device's deployment asks first.** Deploy and Watch name the device and
  commit you'd replace. Stop and Destroy say whose deployment they end.
- **New setting `rdk.deviceName`** names this machine to your others. Defaults to the hostname.

Deploys made with the `rdk` CLI don't record a device yet and show as "unknown".

## 0.5.3

- **SSH from the extension works on macOS again.** Since 0.5.0, every SSH call the extension made
  itself failed on macOS with `too long for Unix domain socket`. Connection sharing kept its socket
  in the system temp folder, which on macOS is a long `/var/folders/…` path. With the 40-character
  connection hash and the temporary suffix ssh adds, that went past the 104-byte limit for socket
  paths, and ssh exits instead of falling back. The panel's status still worked, because it goes
  through Docker's own SSH connection, so the failure was easy to miss. What broke: the setup
  wizard's VPS check (a false "Can't reach" with a working key) and the expiry countdown (always
  "No expiry"). The socket now lives in `~/.ssh`, and if no short enough path exists RDK connects
  without sharing instead of failing.
- **A VPS user who can't use Docker is told so, instead of "can't reach".** Connecting as a
  non-root user (`you@` rather than `root@`) who isn't in the VPS's `docker` group made every
  Docker call fail with "permission denied", which the panel read as the VPS being unreachable.
  Worse, setup read the empty network list as "no proxy here" and would set up a second Traefik on
  a server that already had one. Setup now stops and gives the fix (`sudo usermod -aG docker you`),
  and the panel says the same.
- **Linux: Docker installed with snap is found.** `/snap/bin` is now searched; it isn't on `PATH`
  when VS Code starts from a desktop launcher.
- **The "Docker CLI not found" hint fits your OS.** It said `brew install docker` everywhere,
  including Linux and Windows.

## 0.5.2

Windows. Setup didn't work there at all; it does now, and nothing changes on macOS or Linux.

- **"Copy SSH key…" works on every OS.** It used to type `ssh-copy-id` into a terminal. Windows'
  OpenSSH doesn't ship `ssh-copy-id`, so the button failed with "not recognized". The extension
  now does the job itself with plain `ssh`: it creates an `id_ed25519` key if you don't have one,
  then appends it to `~/.ssh/authorized_keys` on the VPS after you type the password once. Running
  it twice doesn't add the key twice.
- **The VPS check no longer fails on Windows with a working key.** Every SSH call asked for
  connection sharing (`ControlMaster`), which Windows' OpenSSH doesn't support: it fails with
  `getsockname failed: Not a socket`. Setup then reported "Can't reach the VPS", sending you to
  the key button for a problem the key wasn't causing. Windows now connects without sharing.
- **Docker is found on Windows.** The extension looked for CLIs with `/usr/bin/env which`, which
  doesn't exist on Windows, so Docker always read as "not installed". It now uses `where` and
  picks `docker.exe` rather than the extensionless shim Docker Desktop also puts on `PATH`.
- **Logs, shell, deploy and watch run in PowerShell on Windows.** Commands were quoted for a POSIX
  shell, which neither PowerShell nor cmd understands. On Windows, RDK terminals now always open
  PowerShell, with quoting and `&&`-style chaining written for it.

## 0.5.1

- **Fixes auto-activation in large workspaces, broken by 0.5.0.** The new activation event was
  `workspaceContains:**/.env.remote`. VS Code splits these: a value with no glob characters is a
  direct existence check per workspace folder and costs nothing, while anything containing `*`
  runs a file search capped at seven seconds. A `**/` search over a large monorepo overruns that
  budget, and when it does the extension simply never activates — no status bar, no expiry
  warnings, until you open the panel by hand. Activation is now a free root check plus two
  bounded-depth patterns, matching the default `rdk.scanDepth` of 2. Discovery is unchanged and
  still finds configured projects at any depth once the extension is running.

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
