import * as vscode from "vscode";
import { getConfig, missingRequired, workspaceRoot, RdkConfig } from "./config";
import * as run from "./runner";
import { RdkTree } from "./tree";

export function activate(context: vscode.ExtensionContext) {
  const tree = new RdkTree();
  vscode.window.registerTreeDataProvider("remoteDevKitView", tree);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "remoteDevKit.deploy";
  updateStatus(status);
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("remoteDevKit")) {
        tree.refresh();
        updateStatus(status);
      }
    }),
  );

  // Guard: ensure a workspace + required settings before running remote actions.
  const guarded = (fn: (ctx: vscode.ExtensionContext, cfg: RdkConfig) => void) => () => {
    if (!workspaceRoot()) {
      vscode.window.showErrorMessage("Remote Dev Kit: open a project folder first.");
      return;
    }
    const cfg = getConfig();
    const missing = missingRequired(cfg);
    if (missing.length) {
      vscode.window
        .showWarningMessage(`Remote Dev Kit: set ${missing.join(", ")} first.`, "Configure")
        .then((pick) => pick && vscode.commands.executeCommand("remoteDevKit.configure"));
      return;
    }
    fn(context, cfg);
  };

  const reg = (id: string, cb: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, cb));

  reg("remoteDevKit.deploy", guarded(run.deploy));
  reg("remoteDevKit.watch", guarded(run.watch));
  reg("remoteDevKit.down", guarded(run.down));
  reg("remoteDevKit.logs", guarded(run.logs));
  reg("remoteDevKit.status", guarded(run.status));
  reg("remoteDevKit.proxyUp", guarded((ctx, cfg) => run.proxyUp(ctx, cfg)));
  reg("remoteDevKit.connect", () => {
    const cfg = getConfig();
    if (!cfg.vpsSsh) {
      vscode.window
        .showWarningMessage("Remote Dev Kit: set the VPS SSH target first.", "Configure")
        .then((p) => p && vscode.commands.executeCommand("remoteDevKit.configure"));
      return;
    }
    run.connect(cfg);
  });
  reg("remoteDevKit.openInBrowser", () => {
    const cfg = getConfig();
    if (!cfg.appHost) {
      vscode.window.showWarningMessage("Remote Dev Kit: no appHost configured yet.");
      return;
    }
    vscode.env.openExternal(vscode.Uri.parse(`https://${cfg.appHost}`));
  });
  reg("remoteDevKit.configure", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "remoteDevKit"),
  );
  reg("remoteDevKit.refresh", () => tree.refresh());
}

function updateStatus(item: vscode.StatusBarItem) {
  const cfg = getConfig();
  const ready = missingRequired(cfg).length === 0;
  item.text = ready ? `$(rocket) Deploy ${cfg.projectName}` : `$(rocket) Remote Dev Kit`;
  item.tooltip = ready
    ? `Deploy ${cfg.projectName} → https://${cfg.appHost}`
    : "Remote Dev Kit — click to configure";
  item.command = ready ? "remoteDevKit.deploy" : "remoteDevKit.configure";
}

export function deactivate() {}
