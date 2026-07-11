import * as vscode from "vscode";
import { getConfig, missingRequired } from "./config";

class Item extends vscode.TreeItem {
  constructor(
    label: string,
    icon: string,
    commandId?: string,
    description?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.description = description;
    if (commandId) {
      this.command = { command: commandId, title: label };
    }
  }
}

export class RdkTree implements vscode.TreeDataProvider<Item> {
  private _onDidChange = new vscode.EventEmitter<Item | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: Item): vscode.TreeItem {
    return el;
  }

  getChildren(): Item[] {
    const cfg = getConfig();
    const missing = missingRequired(cfg);

    if (missing.length) {
      return [
        new Item("Configure this project…", "gear", "remoteDevKit.configure", "setup needed"),
        new Item(`Missing: ${missing.join(", ")}`, "warning"),
      ];
    }

    const url = cfg.appHost ? `https://${cfg.appHost}` : "";
    return [
      new Item(cfg.projectName, "project", undefined, cfg.stack),
      new Item(url || "no host set", "globe", "remoteDevKit.openInBrowser"),
      new Item("Deploy", "cloud-upload", "remoteDevKit.deploy"),
      new Item("Watch (Hot Reload)", "eye", "remoteDevKit.watch"),
      new Item("Logs", "output", "remoteDevKit.logs"),
      new Item("Status", "pulse", "remoteDevKit.status"),
      new Item("Destroy", "trash", "remoteDevKit.down"),
      new Item(
        cfg.proxyMode === "bare" ? "Start Proxy (bare VPS)" : "Proxy: Coolify",
        "server",
        cfg.proxyMode === "bare" ? "remoteDevKit.proxyUp" : undefined,
        cfg.proxyNetwork,
      ),
      new Item("Configure…", "gear", "remoteDevKit.configure"),
    ];
  }
}
