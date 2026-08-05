import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { appUrl, getDefaults } from "./config";
import { checkPrereqs, detectProject } from "./detect";
import { activeRoot as pickActive, Candidate, discover } from "./discover";
import { ENV_FILE } from "./env";
import { forgetBins, output } from "./exec";
import * as run from "./runner";
import {
  fingerprint,
  forgetContext,
  forgetTtl,
  phaseLabel,
  publishContext,
  RdkState,
  resolveState,
} from "./state";
import { CmdArg, RdkTree } from "./tree";
import { clearTtl, formatLeft, pickDuration, readTtl, setTtl, shouldWarn } from "./ttl";
import { openEnvFile, setupDefaults, setupProject } from "./wizard";

/**
 * Poll cadence.
 *
 * The old code ran a flat 15s `setInterval` for as long as the view was visible, and each tick
 * probed every project over SSH. A window left open all afternoon on a stable deployment spent
 * the whole afternoon asking a question whose answer had not changed since lunch. Now the
 * interval starts tight and doubles while nothing moves, and any real event snaps it back.
 */
const POLL_MIN_MS = 15_000;
const POLL_MAX_MS = 240_000;
/** Debounce for burst events — writing .env.remote fires create and change back to back. */
const SETTLE_MS = 400;
const DISMISSED = "rdk.setupDismissed";

let projects: RdkState[] = [];
let candidates: Candidate[] = [];
let active: string | undefined;
let hasRdkCli = false;

interface RefreshOpts {
  /** Re-walk the workspace for projects. Defaults to true; polls skip it. */
  rediscover?: boolean;
  /** Read only what's on disk — no docker, no SSH. */
  localOnly?: boolean;
}

/** Union of two refresh intents, always resolving towards doing more work rather than less. */
function merge(a: RefreshOpts, b: RefreshOpts): RefreshOpts {
  return {
    rediscover: a.rediscover !== false || b.rediscover !== false,
    localOnly: a.localOnly === true && b.localOnly === true,
  };
}

export async function activate(ctx: vscode.ExtensionContext) {
  const tree = new RdkTree();
  const view = vscode.window.createTreeView("rdkView", { treeDataProvider: tree });
  ctx.subscriptions.push(view);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  ctx.subscriptions.push(status);

  /** Cheap, disk-only discovery. Re-walking the tree on every poll bought nothing. */
  const rediscover = async (): Promise<void> => {
    candidates = await discover();
    active = candidates.length ? pickActive(candidates) : undefined;
  };

  let lastPrint = "";
  let running: Promise<void> | undefined;
  let pending: RefreshOpts | undefined;

  const probe = async (localOnly: boolean): Promise<void> => {
    if (!candidates.length) {
      const phase = vscode.workspace.workspaceFolders?.length ? "no-project" : "no-workspace";
      projects = [{ phase, missing: [], services: [] }];
    } else {
      const before = new Map(projects.map((p) => [p.root, p]));
      // Resolve every project in parallel — each one is an independent SSH/docker probe.
      projects = await Promise.all(
        candidates.map((c) => resolveState(c.root, { localOnly, previous: before.get(c.root) })),
      );
    }

    const cur = current();
    publishContext(cur, candidates.length);
    paintStatus(status);
    paintView(view);

    // Rebuilding the tree means allocating every row again. Only do it when a row would differ.
    const print = fingerprint(projects);
    if (print !== lastPrint) {
      lastPrint = print;
      tree.setStates(projects, active);
    }
    void checkExpiries();
  };

  /**
   * Run a refresh, never two at once.
   *
   * With a bare interval a probe slower than the interval stacked on the next one, and whichever
   * finished last won — so a slow VPS could overwrite fresh state with stale state while piling
   * up ssh processes. Concurrent callers now join the in-flight run, and a request that arrives
   * mid-run schedules exactly one follow-up.
   */
  const refresh = (opts: RefreshOpts = {}): Promise<void> => {
    if (running) {
      // Keep the more thorough of the two intents. A wake that wants the network must not be
      // downgraded to local-only just because it landed during the first paint.
      pending = merge(pending ?? opts, opts);
      return running;
    }
    running = (async () => {
      try {
        if (opts.rediscover !== false) await rediscover();
        await probe(opts.localOnly === true);
      } finally {
        running = undefined;
      }
      const next = pending;
      pending = undefined;
      if (next) await refresh(next);
    })();
    return running;
  };

  // --- scheduling ---------------------------------------------------------
  let timer: NodeJS.Timeout | undefined;
  let delay = POLL_MIN_MS;
  let settle: NodeJS.Timeout | undefined;

  /** Poll only when the panel is on screen AND this window has focus — a background window is idle. */
  const shouldPoll = () => view.visible && vscode.window.state.focused;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    stop();
    if (!shouldPoll()) return;
    timer = setTimeout(tick, delay);
  };

  const tick = async () => {
    if (!shouldPoll()) return; // don't reschedule; focus/visibility will restart us
    const before = lastPrint;
    await refresh({ rediscover: false });
    // Back off while the world holds still; snap back the moment it doesn't.
    delay = lastPrint === before ? Math.min(delay * 2, POLL_MAX_MS) : POLL_MIN_MS;
    schedule();
  };

  /** Something happened that could have changed state: probe now and restart at full cadence. */
  const wake = (opts: RefreshOpts = {}) => {
    delay = POLL_MIN_MS;
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      void refresh(opts).then(schedule);
    }, SETTLE_MS);
  };

  checkPrereqs().then((p) => {
    hasRdkCli = p.rdkCli;
  });

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${ENV_FILE}`);
  ctx.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => wake()),
    watcher.onDidChange(() => wake()),
    watcher.onDidDelete(() => wake()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => wake()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("rdk")) wake();
    }),
    // Following the active editor is what makes "the project I'm looking at" the default target.
    vscode.window.onDidChangeActiveTextEditor(() => {
      const next = pickActive(candidates);
      if (next === active) return;
      active = next;
      publishContext(current(), candidates.length);
      tree.setStates(projects, active);
      paintStatus(status);
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) wake({ rediscover: false });
      else stop();
    }),
    view.onDidChangeVisibility(() => {
      if (view.visible) wake({ rediscover: false });
      else stop();
    }),
    { dispose: () => { stop(); if (settle) clearTimeout(settle); } },
  );

  const reg = (id: string, cb: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, cb));

  /**
   * Resolve which project a command applies to. Tree rows pass their own root; the command
   * palette passes nothing and gets the active project. With several projects and no hint,
   * ask rather than guess — deploying the wrong service is not a recoverable mistake.
   */
  const target = async (arg?: CmdArg): Promise<RdkState | undefined> => {
    const root = arg?.root ?? active;
    const hit = projects.find((p) => p.root === root);
    if (hit) return hit;
    // A row that named a root we no longer know about is stale — the folder was removed or
    // renamed under us. Falling back to "the only project" here would silently redirect the
    // click onto a different deployment, which for Destroy is unrecoverable. Ask instead.
    if (arg?.root) return pickProject();
    if (projects.length === 1) return projects[0];
    return pickProject();
  };

  const pickProject = async (): Promise<RdkState | undefined> => {
    const items = projects
      .filter((p) => p.root)
      .map((p) => ({
        label: p.cfg?.projectName ?? path.basename(p.root!),
        description: phaseLabel(p.phase),
        detail: p.root,
        state: p,
      }));
    if (!items.length) return undefined;
    const picked = await vscode.window.showQuickPick(items, {
      title: "Which project?",
      ignoreFocusOut: true,
    });
    return picked?.state;
  };

  /** Guard: route unconfigured/incomplete projects to setup instead of failing obscurely. */
  const acts = (fn: (s: RdkState) => void | Promise<void>) => async (arg?: CmdArg) => {
    const s = await target(arg);
    if (!s) {
      vscode.window.showErrorMessage("Remote Dev Kit: no project found in this workspace.");
      return;
    }
    if (s.phase === "docker-missing") {
      await vscode.commands.executeCommand("rdk.installDocker");
      return;
    }
    if (["no-project", "no-workspace", "unconfigured", "not-deployable", "incomplete"].includes(s.phase)) {
      await vscode.commands.executeCommand("rdk.setup", { root: s.root } satisfies CmdArg);
      return;
    }
    await fn(s);
    // Deploy and Watch only queue a command in the terminal, so probing the moment `fn` returns
    // always read the world as it was before the action. Wake instead: it reprobes after the
    // debounce and, because the state will have moved, holds the fast cadence while it settles.
    wake({ rediscover: false });
  };

  reg("rdk.setup", async (arg?: CmdArg) => {
    const root = arg?.root ?? (await chooseSetupRoot());
    if (!root) return;
    await setupProject(root);
    await refresh();
  });

  reg("rdk.reconfigure", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (s?.root) {
      await setupProject(s.root, { reconfigure: true });
      await refresh();
    }
  });

  reg("rdk.setupDefaults", async () => {
    await setupDefaults(true);
    await refresh();
  });

  reg("rdk.deploy", acts((s) => run.deploy(ctx, s)));
  reg("rdk.watch", acts((s) => run.watch(ctx, s)));
  reg("rdk.start", acts((s) => run.start(ctx, s)));
  reg("rdk.stop", acts((s) => run.stop(ctx, s)));
  reg("rdk.destroy", acts((s) => run.destroy(ctx, s)));
  reg("rdk.manage", acts((s) => run.manage(ctx, s)));
  reg("rdk.connect", acts((s) => run.connect(s.cfg!)));
  reg("rdk.proxyUp", acts((s) => run.proxyUp(ctx, s.cfg!, s.root!)));

  reg("rdk.logs", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (s) run.logs(ctx, s, arg?.service);
  });
  reg("rdk.shell", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (s) run.shell(ctx, s, arg?.service);
  });
  reg("rdk.restart", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (s) {
      await run.restart(ctx, s, arg?.service);
      await refresh();
    }
  });

  reg("rdk.open", acts((s) => run.openUrl(s.cfg!)));
  reg("rdk.openHost", async (arg?: CmdArg) => {
    // Tree link rows carry the host in `service`.
    if (arg?.service?.includes(".")) {
      vscode.env.openExternal(vscode.Uri.parse(`https://${arg.service}`));
      return;
    }
    const s = await target(arg);
    if (s?.cfg) run.openApp(s.cfg);
  });

  reg("rdk.openEnv", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (s?.root) await openEnvFile(s.root);
  });

  reg("rdk.doctor", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (s) run.runCli(s, ["doctor"], hasRdkCli);
  });
  reg("rdk.audit", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (s) run.runCli(s, ["audit"], hasRdkCli);
  });

  // --- TTL ---------------------------------------------------------------
  reg("rdk.setTtl", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (!s?.cfg) return;
    const secs = await pickDuration(`Expire ${s.cfg.projectName} after…`);
    if (!secs) return;
    if (await setTtl(s.cfg, secs)) {
      vscode.window.showInformationMessage(
        `${s.cfg.projectName} stops in ${formatLeft(secs)}. Volumes are kept.`,
      );
      await warnIfNoReaper(s);
    } else {
      vscode.window.showErrorMessage(`Couldn't set the expiry on ${s.cfg.vpsSsh}.`);
    }
    forgetTtl(s.cfg.projectName); // we just moved it; the cached countdown is now a lie
    await refresh();
  });

  reg("rdk.extendTtl", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (!s?.cfg) return;
    const secs = await pickDuration(`Extend ${s.cfg.projectName} by…`);
    if (!secs) return;
    if (await setTtl(s.cfg, secs)) {
      vscode.window.showInformationMessage(`${s.cfg.projectName} now stops in ${formatLeft(secs)}.`);
      warned.delete(s.root!);
    }
    forgetTtl(s.cfg.projectName);
    await refresh();
  });

  reg("rdk.clearTtl", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (!s?.cfg) return;
    if (await clearTtl(s.cfg)) {
      vscode.window.showInformationMessage(`${s.cfg.projectName} runs until you stop it.`);
      warned.delete(s.root!);
    }
    forgetTtl(s.cfg.projectName);
    await refresh();
  });

  reg("rdk.reaperUp", async (arg?: CmdArg) => {
    const s = await target(arg);
    if (!s?.root) return;
    // The reaper needs the VPS's docker gid and a socket-proxy; the CLI already does all of it.
    run.runCli(s, ["reaper", "up"], hasRdkCli);
  });

  // --- multi-folder ------------------------------------------------------
  reg("rdk.addProject", async () => {
    const root = await chooseAddRoot();
    if (!root) return;
    await setupProject(root);
    await refresh();
  });

  reg("rdk.installDocker", () => {
    forgetBins(); // they're going off to install it; don't hold the "missing" answer against them
    return vscode.env.openExternal(vscode.Uri.parse("https://docs.docker.com/engine/install/"));
  });
  reg("rdk.showOutput", () => output().show());
  reg("rdk.refresh", () => {
    // An explicit refresh means "ignore everything you think you know".
    forgetBins();
    forgetContext();
    forgetTtl();
    delay = POLL_MIN_MS;
    return refresh();
  });

  /*
   * Activation does no network work.
   *
   * The extension used to await a full probe here — discovery, then a docker context inspect, a
   * compose ps over SSH and two more SSH calls per project — before activation resolved. On a
   * sleeping VPS that was tens of seconds of the window's startup budget, spent on a panel the
   * user might never open. Now the first paint is disk-only and instant; the VPS is asked once
   * the window is actually in front of someone.
   */
  await refresh({ localOnly: true });

  const warmUp = setTimeout(() => {
    if (vscode.window.state.focused) void refresh({ rediscover: false }).then(schedule);
  }, 3_000);
  ctx.subscriptions.push({ dispose: () => clearTimeout(warmUp) });

  void offerSetup(ctx);
}

/**
 * Pick where to scaffold. Never silently scaffold at the workspace root — in a monorepo that
 * drops a .env.remote next to the real project, where nothing will ever read it.
 */
async function chooseSetupRoot(): Promise<string | undefined> {
  const unconfigured = candidates.filter((c) => !c.configured);

  if (unconfigured.length === 1) return unconfigured[0].root;

  if (unconfigured.length > 1) {
    const picked = await vscode.window.showQuickPick(
      unconfigured.map((c) => ({
        label: c.label,
        description: c.shape.stack,
        detail: c.root,
        root: c.root,
      })),
      { title: "Set up which project?", ignoreFocusOut: true },
    );
    return picked?.root;
  }

  // Nothing detected anywhere — let them point at a folder rather than guessing the root.
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage("Remote Dev Kit: open a project folder first.");
    return undefined;
  }

  const pick = await vscode.window.showOpenDialog({
    title: "Select the project folder to set up",
    defaultUri: folders[0].uri,
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Set up here",
  });
  return pick?.[0]?.fsPath;
}

function current(): RdkState {
  return projects.find((p) => p.root === active) ?? projects[0] ?? { phase: "no-workspace", missing: [], services: [] };
}

/**
 * Pick a folder to add as a new project.
 *
 * The common shape is a monorepo — A/ holding -a, -b, -c — where RDK is already set up in -b
 * and you now want -c. Offer the sibling folders that aren't projects yet, whether or not they
 * look deployable (a folder can gain a Dockerfile a minute from now), and always allow browsing.
 */
async function chooseAddRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    vscode.window.showErrorMessage("Remote Dev Kit: open a project folder first.");
    return undefined;
  }

  const taken = new Set(candidates.filter((c) => c.configured).map((c) => c.root));
  const siblings: { label: string; description?: string; detail: string; root: string }[] = [];

  for (const f of folders) {
    const base = f.uri.fsPath;
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => path.join(base, e.name));
    } catch {
      /* unreadable — just fall through to Browse */
    }

    for (const dir of [base, ...entries]) {
      if (taken.has(dir)) continue;
      const shape = detectProject(dir);
      siblings.push({
        label: path.basename(dir),
        description: shape.deployable ? shape.stack : "no Dockerfile yet",
        detail: dir,
        root: dir,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...siblings,
      { label: "$(folder-opened) Browse…", detail: "Pick any folder", root: "" },
    ],
    { title: "Add a project", placeHolder: "Which folder should RDK deploy?", ignoreFocusOut: true },
  );
  if (!picked) return undefined;
  if (picked.root) return picked.root;

  const browsed = await vscode.window.showOpenDialog({
    title: "Select the project folder",
    defaultUri: folders[0].uri,
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Set up here",
  });
  return browsed?.[0]?.fsPath;
}

/** Projects we've already nagged about this expiry window. Cleared on extend/clear. */
const warned = new Set<string>();

async function warnIfNoReaper(s: RdkState): Promise<void> {
  if (!s.cfg) return;
  const t = await readTtl(s.cfg).catch(() => undefined);
  if (t && !t.reaperRunning) {
    const pick = await vscode.window.showWarningMessage(
      "An expiry is set, but no reaper is running on this VPS — nothing will enforce it.",
      "Start reaper",
    );
    if (pick === "Start reaper") await vscode.commands.executeCommand("rdk.reaperUp", { root: s.root });
  }
}

/** Warn while you're at your desk and can still extend. If you're not, it stops anyway. */
async function checkExpiries(): Promise<void> {
  for (const s of projects) {
    if (!s.cfg || !s.ttl || !s.root) continue;
    if (!shouldWarn(s.ttl, s.cfg.ttlPrompt)) continue;
    if (warned.has(s.root)) continue;
    warned.add(s.root);

    const pick = await vscode.window.showWarningMessage(
      `${s.cfg.projectName} expires in ${formatLeft(s.ttl.secondsLeft)} and will stop.`,
      "Extend",
      "Stop now",
      "Let it expire",
    );
    if (pick === "Extend") await vscode.commands.executeCommand("rdk.extendTtl", { root: s.root });
    else if (pick === "Stop now") await vscode.commands.executeCommand("rdk.stop", { root: s.root });
  }
}

/** One-time nudge per project folder — never for the workspace root of a monorepo. */
async function offerSetup(ctx: vscode.ExtensionContext): Promise<void> {
  const fresh = candidates.filter((c) => !c.configured && c.shape.deployable);
  if (!fresh.length) return;

  for (const c of fresh) {
    const key = `${DISMISSED}:${c.root}`;
    if (ctx.workspaceState.get<boolean>(key)) continue;

    const knowsVps = Boolean(getDefaults().vpsSsh);
    const pick = await vscode.window.showInformationMessage(
      knowsVps
        ? `Deploy ${c.label} to your VPS? RDK can set it up in two questions.`
        : `Deploy ${c.label} to a VPS with Remote Dev Kit?`,
      "Set up",
      "Not now",
      "Never for this project",
    );

    if (pick === "Set up") {
      await vscode.commands.executeCommand("rdk.setup", { root: c.root } satisfies CmdArg);
    } else if (pick === "Never for this project") {
      await ctx.workspaceState.update(key, true);
    }
    return; // one prompt at a time; don't stack notifications
  }
}

function paintStatus(item: vscode.StatusBarItem): void {
  const s = current();

  if (s.phase === "no-workspace" || s.phase === "no-project" || s.phase === "not-deployable") {
    item.hide();
    return;
  }

  const name = s.cfg?.projectName ?? (s.root ? path.basename(s.root) : "");
  const spec: Record<string, { icon: string; text: string; cmd: string; bg?: string }> = {
    "docker-missing": { icon: "error", text: "Docker missing", cmd: "rdk.installDocker", bg: "statusBarItem.errorBackground" },
    unconfigured: { icon: "radio-tower", text: `Set up ${name}`, cmd: "rdk.setup" },
    checking: { icon: "sync~spin", text: name, cmd: "rdk.refresh" },
    incomplete: { icon: "warning", text: `${name}: finish setup`, cmd: "rdk.setup", bg: "statusBarItem.warningBackground" },
    disconnected: { icon: "debug-disconnect", text: `${name}: connect`, cmd: "rdk.connect" },
    "not-deployed": { icon: "cloud-upload", text: `Deploy ${name}`, cmd: "rdk.deploy" },
    stopped: { icon: "primitive-square", text: `${name}: stopped`, cmd: "rdk.start" },
    partial: { icon: "warning", text: `${name}: degraded`, cmd: "rdk.logs", bg: "statusBarItem.warningBackground" },
    running: { icon: "radio-tower", text: name, cmd: "rdk.open" },
  };

  const it = spec[s.phase];
  if (!it) {
    item.hide();
    return;
  }

  item.text = `$(${it.icon}) ${it.text}`;
  item.command = it.cmd;
  item.backgroundColor = it.bg ? new vscode.ThemeColor(it.bg) : undefined;

  const lines = [`Remote Dev Kit — ${phaseLabel(s.phase)}`];
  if (s.cfg?.appHost) lines.push(appUrl(s.cfg));
  if (s.services.length) {
    const up = s.services.filter((x) => x.state === "running").length;
    lines.push(`${up}/${s.services.length} services up`);
  }
  if (projects.length > 1) lines.push(`${projects.length} projects in this workspace`);
  item.tooltip = lines.join("\n");
  item.show();
}

function paintView(view: vscode.TreeView<unknown>): void {
  const s = current();
  const n = candidates.length;
  view.description = n > 1 ? `${n} projects` : s.cfg ? phaseLabel(s.phase) : undefined;

  const down = projects.reduce((acc, p) => acc + p.services.filter((x) => x.state !== "running").length, 0);
  view.badge = down ? { value: down, tooltip: "services down" } : undefined;
}

export function deactivate() {}
