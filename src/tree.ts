import * as vscode from "vscode";
import * as path from "path";
import { extraHosts, proxyMode, stack } from "./config";
import { Phase, phaseLabel, RdkState, Service } from "./state";
import { formatLeft } from "./ttl";

/** What every RDK command receives. Tree rows carry their own project, so a click in one
 *  project's subtree can never act on another. */
export interface CmdArg {
  root?: string;
  service?: string;
}

export class Node extends vscode.TreeItem implements CmdArg {
  root?: string;
  service?: string;
  children?: Node[];

  constructor(
    label: string,
    opts: {
      icon?: string | vscode.ThemeIcon;
      description?: string;
      tooltip?: string;
      command?: string;
      root?: string;
      service?: string;
      contextValue?: string;
      collapsed?: vscode.TreeItemCollapsibleState;
      children?: Node[];
    } = {},
  ) {
    super(label, opts.collapsed ?? vscode.TreeItemCollapsibleState.None);
    this.iconPath = typeof opts.icon === "string" ? new vscode.ThemeIcon(opts.icon) : opts.icon;
    this.description = opts.description;
    this.tooltip = opts.tooltip;
    this.contextValue = opts.contextValue;
    this.children = opts.children;
    this.root = opts.root;
    this.service = opts.service;

    if (opts.command) {
      this.command = {
        command: opts.command,
        title: label,
        arguments: [{ root: opts.root, service: opts.service } satisfies CmdArg],
      };
    }
  }
}

const dot = (color: string) => new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(color));
const GREEN = dot("testing.iconPassed");
const RED = dot("testing.iconFailed");
const YELLOW = dot("testing.iconQueued");
const GREY = new vscode.ThemeIcon("circle-outline");

function serviceIcon(s: Service): vscode.ThemeIcon {
  if (s.health === "unhealthy") return RED;
  if (s.state === "running") return s.health === "starting" ? YELLOW : GREEN;
  if (s.state === "restarting") return YELLOW;
  if (s.state === "exited" && s.exitCode && s.exitCode !== 0) return RED;
  return GREY;
}

function phaseIcon(phase: Phase): vscode.ThemeIcon {
  switch (phase) {
    case "running":
      return GREEN;
    case "partial":
      return YELLOW;
    case "stopped":
      return GREY;
    case "incomplete":
    case "docker-missing":
      return new vscode.ThemeIcon("warning");
    default:
      return new vscode.ThemeIcon("cloud");
  }
}

export class RdkTree implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private all: RdkState[] = [];
  private activeRoot?: string;

  setStates(states: RdkState[], activeRoot?: string): void {
    this.all = states;
    this.activeRoot = activeRoot;
    this._onDidChange.fire();
  }

  getTreeItem(el: Node): vscode.TreeItem {
    return el;
  }

  getChildren(el?: Node): Node[] {
    if (el) return el.children ?? [];

    // A single project fills the panel directly — no pointless nesting.
    if (this.all.length === 1) {
      const rows = this.project(this.all[0]);
      // Even with one project set up, you may want to add a sibling folder.
      if (this.all[0].cfg) {
        rows.push(
          new Node("Add another project…", {
            icon: "add",
            description: "another folder",
            tooltip: "Set up RDK in another folder of this workspace.",
            command: "rdk.addProject",
          }),
        );
      }
      return rows;
    }

    // A monorepo: one row per project, the active one expanded.
    const rows = this.all.map((s) => {
      const name = s.cfg?.projectName ?? (s.root ? path.basename(s.root) : "?");
      return new Node(name, {
        icon: phaseIcon(s.phase),
        description: phaseLabel(s.phase),
        tooltip: `${s.root}\n${phaseLabel(s.phase)}`,
        root: s.root,
        contextValue: "rdk.projectRoot",
        collapsed:
          s.root === this.activeRoot
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
        children: this.project(s),
      });
    });

    // You already deploy A/-b; this is how you add A/-c without leaving the panel.
    rows.push(
      new Node("Add another project…", {
        icon: "add",
        description: "another folder",
        tooltip: "Set up RDK in another folder of this workspace.",
        command: "rdk.addProject",
      }),
    );

    return rows;
  }

  /** The rows for one project. Every row is bound to that project's root. */
  private project(s: RdkState): Node[] {
    const single = this.all.length === 1;

    switch (s.phase) {
      case "no-workspace":
      case "no-project":
      case "not-deployable":
      case "unconfigured":
        // Handled by viewsWelcome when it's the only project; inline when it's one of many.
        return single
          ? []
          : [new Node("Set up this project…", { icon: "wand", command: "rdk.setup", root: s.root })];

      case "docker-missing":
        return [
          new Node("Docker CLI not found", { icon: "error", description: "required" }),
          new Node("Install Docker CLI", {
            icon: "link-external",
            command: "rdk.installDocker",
            description: "brew install docker",
          }),
        ];

      case "incomplete":
        return [
          new Node("Setup unfinished", {
            icon: "warning",
            description: s.missing.join(", ").toLowerCase(),
            tooltip: `Missing or still placeholder in .env.remote:\n${s.missing.join("\n")}`,
          }),
          new Node("Finish setup", { icon: "wand", command: "rdk.setup", root: s.root, description: "guided" }),
          new Node("Edit .env.remote", { icon: "go-to-file", command: "rdk.openEnv", root: s.root }),
        ];

      case "disconnected":
        return [
          ...this.header(s, single),
          new Node("Connect to VPS", {
            icon: "plug",
            command: "rdk.connect",
            root: s.root,
            description: s.cfg?.vpsSsh,
            tooltip: "Creates the docker context for this project. Deploy does it for you too.",
          }),
          new Node("Deploy", { icon: "cloud-upload", command: "rdk.deploy", root: s.root }),
          ...this.manage(s),
        ];

      case "not-deployed":
        return [
          ...this.header(s, single),
          new Node("Deploy", { icon: "cloud-upload", command: "rdk.deploy", root: s.root, description: "build + start" }),
          new Node("Watch (hot reload)", { icon: "eye", command: "rdk.watch", root: s.root, description: "sync edits" }),
          ...this.manage(s),
        ];

      case "stopped":
        return [
          ...this.header(s, single),
          new Node("Start", { icon: "play", command: "rdk.start", root: s.root, description: "keep data" }),
          new Node("Deploy", { icon: "cloud-upload", command: "rdk.deploy", root: s.root, description: "rebuild" }),
          this.services(s),
          ...this.manage(s),
        ];

      case "running":
      case "partial":
        return [
          ...this.header(s, single),
          ...this.links(s),
          ...this.expiry(s),
          this.services(s),
          this.actions(s),
          ...this.manage(s),
        ];
    }
  }

  /** Expiry, when one is set. Loud if nothing is enforcing it — that's worse than no expiry. */
  private expiry(s: RdkState): Node[] {
    const t = s.ttl;
    if (!t) {
      return [
        new Node("No expiry", {
          icon: "clock",
          description: "runs until stopped",
          tooltip: "Set an expiry and this project stops itself, keeping its volumes.",
          command: "rdk.setTtl",
          root: s.root,
        }),
      ];
    }

    if (!t.reaperRunning) {
      return [
        new Node(`Expiry set, but not enforced`, {
          icon: "warning",
          description: "no reaper",
          tooltip:
            "An expiry is recorded but no reaper is running on this VPS, so nothing will stop it.\nClick to start the reaper (once per server).",
          command: "rdk.reaperUp",
          root: s.root,
        }),
      ];
    }

    return [
      new Node(`Expires in ${formatLeft(t.secondsLeft)}`, {
        icon: "clock",
        description: "extend",
        tooltip: `Stops at ${new Date(t.expiresAt * 1000).toLocaleString()} — volumes kept.\nClick to extend.`,
        command: "rdk.extendTtl",
        root: s.root,
      }),
    ];
  }

  /** In a monorepo the project name is already the parent row, so don't repeat it. */
  private header(s: RdkState, single: boolean): Node[] {
    if (!single || !s.cfg) return [];
    const cfg = s.cfg;
    return [
      new Node(cfg.projectName, {
        icon: phaseIcon(s.phase),
        description: phaseLabel(s.phase),
        tooltip: [
          `Project: ${cfg.projectName}`,
          `Stack:   ${stack(cfg)}`,
          `VPS:     ${cfg.vpsSsh}`,
          `Proxy:   ${proxyMode(cfg)} (network "${cfg.proxyNetwork}")`,
          `Folder:  ${s.root}`,
        ].join("\n"),
        root: s.root,
        contextValue: "rdk.project",
      }),
    ];
  }

  private links(s: RdkState): Node[] {
    const cfg = s.cfg!;
    const all = [{ label: "App", host: cfg.appHost, icon: "globe" }, ...extraHosts(cfg)];
    return all.map(
      (h) =>
        new Node(h.host, {
          icon: h.icon,
          description: h.label === "App" ? "open" : h.label.toLowerCase(),
          tooltip: `Open https://${h.host}`,
          command: "rdk.openHost",
          root: s.root,
          service: h.host, // reused as the host to open
        }),
    );
  }

  private services(s: RdkState): Node {
    const up = s.services.filter((x) => x.state === "running").length;
    return new Node("Services", {
      icon: "server-process",
      description: `${up}/${s.services.length} up`,
      collapsed: vscode.TreeItemCollapsibleState.Expanded,
      children: s.services.map(
        (svc) =>
          new Node(svc.name, {
            icon: serviceIcon(svc),
            description: svc.status || svc.state,
            tooltip: `${svc.name} — ${svc.status || svc.state}${svc.health ? ` (${svc.health})` : ""}`,
            contextValue: "rdk.service",
            command: "rdk.logs",
            root: s.root,
            service: svc.name,
          }),
      ),
    });
  }

  private actions(s: RdkState): Node {
    const cfg = s.cfg!;
    const isDjango = stack(cfg) === "django";
    return new Node("Actions", {
      icon: "zap",
      collapsed: vscode.TreeItemCollapsibleState.Expanded,
      children: [
        new Node("Redeploy", { icon: "cloud-upload", command: "rdk.deploy", root: s.root, description: "rebuild + restart" }),
        new Node("Watch (hot reload)", { icon: "eye", command: "rdk.watch", root: s.root, description: "sync edits" }),
        new Node("Logs", { icon: "output", command: "rdk.logs", root: s.root }),
        new Node("Shell", { icon: "terminal", command: "rdk.shell", root: s.root, description: cfg.appService }),
        ...(isDjango ? [new Node("manage.py…", { icon: "symbol-method", command: "rdk.manage", root: s.root })] : []),
        new Node("Restart", { icon: "debug-restart", command: "rdk.restart", root: s.root }),
        new Node("Stop", { icon: "debug-stop", command: "rdk.stop", root: s.root, description: "keep data" }),
        new Node("Destroy", { icon: "trash", command: "rdk.destroy", root: s.root, description: "deletes data" }),
      ],
    });
  }

  private manage(s: RdkState): Node[] {
    const cfg = s.cfg;
    const children: Node[] = [
      new Node("Doctor", { icon: "pulse", command: "rdk.doctor", root: s.root, description: "check prerequisites" }),
      new Node("Security audit", { icon: "shield", command: "rdk.audit", root: s.root, description: "TLS, headers, ports" }),
      new Node("Edit .env.remote", { icon: "go-to-file", command: "rdk.openEnv", root: s.root }),
      new Node("Reconfigure…", { icon: "wand", command: "rdk.reconfigure", root: s.root }),
      new Node("Change VPS / domain…", { icon: "server", command: "rdk.setupDefaults", description: "all projects" }),
    ];

    if (cfg && proxyMode(cfg) === "bare") {
      children.splice(2, 0, new Node("Start proxy (Traefik)", { icon: "server-environment", command: "rdk.proxyUp", root: s.root }));
    }

    return [
      new Node("Manage", {
        icon: "tools",
        collapsed: vscode.TreeItemCollapsibleState.Collapsed,
        children,
      }),
    ];
  }
}
