import * as vscode from "vscode";
import {
  RdkConfig,
  contextName,
  stackFile,
  traefikFile,
  workspaceRoot,
  writeEnvFile,
} from "./config";

let term: vscode.Terminal | undefined;

function terminal(): vscode.Terminal {
  if (!term || term.exitStatus !== undefined) {
    term = vscode.window.createTerminal({ name: "Remote Dev Kit", iconPath: new vscode.ThemeIcon("rocket") });
  }
  term.show();
  return term;
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Prefix for every compose call, bound to this project's remote context + bundled stack. */
function composePrefix(ctx: vscode.ExtensionContext, cfg: RdkConfig): string {
  const root = workspaceRoot()!;
  const envFile = writeEnvFile(ctx, cfg);
  return (
    `docker --context ${q(contextName(cfg))} compose ` +
    `-p ${q(cfg.projectName)} ` +
    `--project-directory ${q(root)} ` +
    `--env-file ${q(envFile)} ` +
    `-f ${q(stackFile(ctx, cfg))}`
  );
}

export function connect(cfg: RdkConfig): void {
  const t = terminal();
  t.sendText(
    `docker context create ${q(contextName(cfg))} --docker "host=ssh://${cfg.vpsSsh}" 2>/dev/null ` +
      `&& echo "✅ connected to ${cfg.vpsSsh}" || echo "ℹ️  context already exists"`,
  );
}

export function proxyUp(ctx: vscode.ExtensionContext, cfg: RdkConfig): void {
  const t = terminal();
  const envFile = writeEnvFile(ctx, cfg);
  t.sendText(`docker --context ${q(contextName(cfg))} network create ${q(cfg.proxyNetwork)} 2>/dev/null || true`);
  t.sendText(
    `docker --context ${q(contextName(cfg))} compose -p remote-proxy ` +
      `--env-file ${q(envFile)} -f ${q(traefikFile(ctx))} up -d && echo "✅ proxy up (80/443)"`,
  );
}

export function deploy(ctx: vscode.ExtensionContext, cfg: RdkConfig): void {
  terminal().sendText(`${composePrefix(ctx, cfg)} up -d --build`);
}

export function watch(ctx: vscode.ExtensionContext, cfg: RdkConfig): void {
  const p = composePrefix(ctx, cfg);
  terminal().sendText(`${p} up -d --build && echo "👀 syncing edits → VPS (Ctrl-C to stop)…" && ${p} watch`);
}

export function down(ctx: vscode.ExtensionContext, cfg: RdkConfig): void {
  terminal().sendText(`${composePrefix(ctx, cfg)} down --rmi all -v`);
}

export function logs(ctx: vscode.ExtensionContext, cfg: RdkConfig): void {
  terminal().sendText(`${composePrefix(ctx, cfg)} logs -f`);
}

export function status(ctx: vscode.ExtensionContext, cfg: RdkConfig): void {
  terminal().sendText(`${composePrefix(ctx, cfg)} ps`);
}
