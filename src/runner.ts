import * as vscode from "vscode";
import * as path from "path";
import { appUrl, baseFiles, contextName, extraHosts, isOverlay, proxyMode, RdkConfig, stack } from "./config";
import { logResult, output, run, sendToTerminal } from "./exec";
import { renderOverlay } from "./overlay";
import { composeArgs, RdkState } from "./state";

export function stackFile(ctx: vscode.ExtensionContext, cfg: RdkConfig): string {
  return ctx.asAbsolutePath(path.join("stacks", cfg.composeFile));
}

export function traefikFile(ctx: vscode.ExtensionContext): string {
  return ctx.asAbsolutePath(path.join("stacks", "traefik.yml"));
}

/**
 * Which compose files this project runs.
 *
 * Overlay mode: the project's OWN compose file(s), plus a generated overlay that adds nothing
 * but the proxy network and the Traefik labels. RDK defines none of your services.
 * Otherwise: one bundled stack, built from your Dockerfile.
 */
export function composeFilesFor(ctx: vscode.ExtensionContext, cfg: RdkConfig, root: string): string[] {
  if (!isOverlay(cfg)) return [stackFile(ctx, cfg)];
  const bases = baseFiles(cfg).map((f) => path.join(root, f));
  return [...bases, renderOverlay(ctx, cfg, root)];
}

function compose(ctx: vscode.ExtensionContext, cfg: RdkConfig, root: string, ...rest: string[]): string[] {
  return composeArgs(cfg, root, composeFilesFor(ctx, cfg, root), ...rest);
}

/** Surface a failed command instead of leaving it buried in a terminal. */
function fail(label: string, res: { stderr: string; stdout: string }): void {
  const first = (res.stderr || res.stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? "unknown error";
  vscode.window.showErrorMessage(`${label}: ${first}`, "Show Output").then((p) => {
    if (p === "Show Output") output().show();
  });
}

/** Create the docker context if it doesn't exist. Deploy calls this itself, so it's never a manual step. */
export async function ensureConnected(cfg: RdkConfig): Promise<boolean> {
  const ctxName = contextName(cfg);
  if ((await run("docker", ["context", "inspect", ctxName], { timeoutMs: 10_000 })).code === 0) {
    return true;
  }

  const args = ["context", "create", ctxName, "--docker", `host=ssh://${cfg.vpsSsh}`];
  const res = await run("docker", args, { timeoutMs: 20_000 });
  logResult("connect", ["docker", ...args], res);

  if (res.code !== 0) {
    fail("Couldn't connect to the VPS", res);
    return false;
  }
  return true;
}

export async function connect(cfg: RdkConfig): Promise<void> {
  const done = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${cfg.vpsSsh}…` },
    () => ensureConnected(cfg),
  );
  if (done) vscode.window.showInformationMessage(`Connected — docker context "${contextName(cfg)}".`);
}

/**
 * Deploy. Runs in the terminal because a remote image build is long and users want to watch it,
 * but we auto-connect first so the classic "context does not exist" failure can't happen.
 */
export async function deploy(ctx: vscode.ExtensionContext, state: RdkState): Promise<void> {
  const { cfg, root } = state;
  if (!cfg || !root) return;

  if (!(await ensureConnected(cfg))) return;
  if (proxyMode(cfg) === "bare" && !(await proxyRunning(ctx, cfg, root))) {
    const pick = await vscode.window.showWarningMessage(
      "No Traefik proxy is running on the VPS — HTTPS won't work until it is.",
      "Start proxy first",
      "Deploy anyway",
    );
    if (pick === "Start proxy first") {
      await proxyUp(ctx, cfg, root);
    } else if (pick !== "Deploy anyway") {
      return;
    }
  }

  sendToTerminal(["docker", ...compose(ctx, cfg, root, "up", "-d", "--build")], root);
}

export async function watch(ctx: vscode.ExtensionContext, state: RdkState): Promise<void> {
  const { cfg, root } = state;
  if (!cfg || !root) return;
  if (!(await ensureConnected(cfg))) return;

  const t = vscode.window.createTerminal({ name: "RDK: watch", iconPath: new vscode.ThemeIcon("eye") });
  t.show();
  const up = ["docker", ...compose(ctx, cfg, root, "up", "-d", "--build")];
  const w = ["docker", ...compose(ctx, cfg, root, "watch")];
  const q = (a: string[]) => a.map((s) => `'${s.replace(/'/g, `'\\''`)}'`).join(" ");
  t.sendText(`cd '${root.replace(/'/g, `'\\''`)}'`);
  t.sendText(`${q(up)} && echo "Syncing edits to VPS. Ctrl-C to stop." && ${q(w)}`);
}

export function logs(ctx: vscode.ExtensionContext, state: RdkState, service?: string): void {
  const { cfg, root } = state;
  if (!cfg || !root) return;
  const args = compose(ctx, cfg, root, "logs", "-f", "--tail", "200");
  if (service) args.push(service);
  sendToTerminal(["docker", ...args], root);
}

export function shell(ctx: vscode.ExtensionContext, state: RdkState, service?: string): void {
  const { cfg, root } = state;
  if (!cfg || !root) return;
  const svc = service || cfg.appService;
  sendToTerminal(["docker", ...compose(ctx, cfg, root, "exec", svc, "sh")], root);
}

/** Django-only: run a manage.py command, prompting for which one. */
export async function manage(ctx: vscode.ExtensionContext, state: RdkState): Promise<void> {
  const { cfg, root } = state;
  if (!cfg || !root) return;

  const common = [
    { label: "migrate", detail: "Apply database migrations" },
    { label: "makemigrations", detail: "Create new migrations" },
    { label: "createsuperuser", detail: "Create an admin user" },
    { label: "shell", detail: "Django shell" },
    { label: "collectstatic --noinput", detail: "Collect static files" },
  ];
  const picked = await vscode.window.showQuickPick(
    [...common, { label: "$(edit) Other…", detail: "Type a manage.py command" }],
    { title: "manage.py", placeHolder: "Pick a command", ignoreFocusOut: true },
  );
  if (!picked) return;

  let cmd = picked.label;
  if (cmd.startsWith("$(edit)")) {
    const typed = await vscode.window.showInputBox({
      title: "manage.py",
      prompt: "Arguments to pass to manage.py",
      placeHolder: "showmigrations course_app",
      ignoreFocusOut: true,
    });
    if (!typed?.trim()) return;
    cmd = typed.trim();
  }

  const args = compose(ctx, cfg, root, "run", "--rm", cfg.appService, "python", "manage.py", ...cmd.split(/\s+/));
  sendToTerminal(["docker", ...args], root);
}

export async function restart(ctx: vscode.ExtensionContext, state: RdkState, service?: string): Promise<void> {
  const { cfg, root } = state;
  if (!cfg || !root) return;
  const args = compose(ctx, cfg, root, "restart");
  if (service) args.push(service);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Restarting ${service ?? cfg.projectName}…` },
    async () => {
      const res = await run("docker", args, { cwd: root, timeoutMs: 120_000 });
      logResult("restart", ["docker", ...args], res);
      if (res.code !== 0) fail("Restart failed", res);
    },
  );
}

/** Start previously-stopped containers without rebuilding. */
export async function start(ctx: vscode.ExtensionContext, state: RdkState): Promise<void> {
  const { cfg, root } = state;
  if (!cfg || !root) return;
  const args = compose(ctx, cfg, root, "start");

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Starting ${cfg.projectName}…` },
    async () => {
      const res = await run("docker", args, { cwd: root, timeoutMs: 120_000 });
      logResult("start", ["docker", ...args], res);
      if (res.code !== 0) fail("Start failed", res);
    },
  );
}

/** Stop containers but keep volumes — the safe counterpart to destroy. */
export async function stop(ctx: vscode.ExtensionContext, state: RdkState): Promise<void> {
  const { cfg, root } = state;
  if (!cfg || !root) return;
  const args = compose(ctx, cfg, root, "stop");

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Stopping ${cfg.projectName}…` },
    async () => {
      const res = await run("docker", args, { cwd: root, timeoutMs: 120_000 });
      logResult("stop", ["docker", ...args], res);
      if (res.code !== 0) fail("Stop failed", res);
    },
  );
}

/**
 * Destroy: images AND volumes. This deletes the remote database, so it's the one action
 * that requires an explicit modal confirmation naming what's lost.
 */
export async function destroy(ctx: vscode.ExtensionContext, state: RdkState): Promise<void> {
  const { cfg, root } = state;
  if (!cfg || !root) return;

  const hasDb = stack(cfg) === "django" || stack(cfg) === "generic-db";
  const loses = hasDb ? "the Postgres database, Redis data, images and volumes" : "all images and volumes";

  const pick = await vscode.window.showWarningMessage(
    `Destroy "${cfg.projectName}" on the VPS?`,
    {
      modal: true,
      detail: `This permanently deletes ${loses}. Your local code is untouched.\n\nTo stop the app without losing data, use Stop instead.`,
    },
    "Destroy",
    "Stop instead",
  );

  if (pick === "Stop instead") {
    await stop(ctx, state);
    return;
  }
  if (pick !== "Destroy") return;

  const args = compose(ctx, cfg, root, "down", "--rmi", "all", "-v");
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Destroying ${cfg.projectName}…` },
    async () => {
      const res = await run("docker", args, { cwd: root, timeoutMs: 300_000 });
      logResult("destroy", ["docker", ...args], res);
      if (res.code !== 0) fail("Destroy failed", res);
      else vscode.window.showInformationMessage(`Destroyed ${cfg.projectName}.`);
    },
  );
}

async function proxyRunning(ctx: vscode.ExtensionContext, cfg: RdkConfig, root: string): Promise<boolean> {
  const args = [
    "--context",
    contextName(cfg),
    "compose",
    "-p",
    "remote-proxy",
    "--project-directory",
    root,
    "--env-file",
    ".env.remote",
    "-f",
    traefikFile(ctx),
    "ps",
    "-q",
  ];
  const res = await run("docker", args, { cwd: root, timeoutMs: 30_000 });
  return res.code === 0 && res.stdout.trim().length > 0;
}

export async function proxyUp(ctx: vscode.ExtensionContext, cfg: RdkConfig, root: string): Promise<void> {
  if (!(await ensureConnected(cfg))) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Starting Traefik on the VPS…" },
    async () => {
      const net = ["--context", contextName(cfg), "network", "create", cfg.proxyNetwork];
      await run("docker", net, { timeoutMs: 20_000 }); // already-exists is fine

      const args = [
        "--context",
        contextName(cfg),
        "compose",
        "-p",
        "remote-proxy",
        "--project-directory",
        root,
        "--env-file",
        ".env.remote",
        "-f",
        traefikFile(ctx),
        "up",
        "-d",
      ];
      const res = await run("docker", args, { cwd: root, timeoutMs: 180_000 });
      logResult("proxy up", ["docker", ...args], res);
      if (res.code !== 0) fail("Couldn't start the proxy", res);
      else vscode.window.showInformationMessage("Traefik is up on ports 80/443.");
    },
  );
}

export function openApp(cfg: RdkConfig): void {
  vscode.env.openExternal(vscode.Uri.parse(appUrl(cfg)));
}

/** One place to reach every URL this project exposes. */
export async function openUrl(cfg: RdkConfig): Promise<void> {
  const hosts = [{ label: "App", host: cfg.appHost, icon: "globe" }, ...extraHosts(cfg)];
  if (hosts.length === 1) {
    openApp(cfg);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    hosts.map((h) => ({ label: `$(${h.icon}) ${h.label}`, detail: `https://${h.host}`, host: h.host })),
    { title: "Open in browser", ignoreFocusOut: true },
  );
  if (picked) vscode.env.openExternal(vscode.Uri.parse(`https://${picked.host}`));
}

/**
 * Delegate to the CLI when it's installed — one implementation, not two. `reaper up` in
 * particular has to read the VPS's docker group id and stand up a socket-proxy; reimplementing
 * that here is exactly the duplication the overlay work exists to stamp out.
 */
export function runCli(state: RdkState, args: string[], hasRdk: boolean): void {
  const { root } = state;
  if (!root) return;

  if (!hasRdk) {
    vscode.window
      .showWarningMessage(
        `\`rdk ${args.join(" ")}\` needs the RDK CLI, which isn't on your PATH.`,
        "Install instructions",
      )
      .then((p) => {
        if (p === "Install instructions") {
          vscode.env.openExternal(vscode.Uri.parse("https://github.com/Enochthedev/remote-dev-kit#install"));
        }
      });
    return;
  }
  sendToTerminal(["rdk", ...args], root);
}
