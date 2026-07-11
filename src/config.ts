import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export interface RdkConfig {
  projectName: string;
  appHost: string;
  appPort: number;
  vpsSsh: string;
  stack: "generic" | "django";
  appDockerfile: string;
  appService: string;
  proxyMode: "bare" | "coolify";
  proxyNetwork: string;
  certResolver: string;
  certEntrypoint: string;
  acmeEmail: string;
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getConfig(): RdkConfig {
  const c = vscode.workspace.getConfiguration("remoteDevKit");
  const root = workspaceRoot();
  const fallbackName = root ? path.basename(root) : "app";
  return {
    projectName: (c.get<string>("projectName") || fallbackName).trim(),
    appHost: (c.get<string>("appHost") || "").trim(),
    appPort: c.get<number>("appPort") ?? 8000,
    vpsSsh: (c.get<string>("vpsSsh") || "").trim(),
    stack: (c.get<string>("stack") as RdkConfig["stack"]) || "generic",
    appDockerfile: c.get<string>("appDockerfile") || "./Dockerfile",
    appService: c.get<string>("appService") || "app",
    proxyMode: (c.get<string>("proxyMode") as RdkConfig["proxyMode"]) || "bare",
    proxyNetwork: (c.get<string>("proxyNetwork") || "web").trim(),
    certResolver: c.get<string>("certResolver") || "letsencrypt",
    certEntrypoint: c.get<string>("certEntrypoint") || "https",
    acmeEmail: (c.get<string>("acmeEmail") || "").trim(),
  };
}

export function contextName(cfg: RdkConfig): string {
  return "remote-" + cfg.projectName;
}

export function stackFile(ctx: vscode.ExtensionContext, cfg: RdkConfig): string {
  const name = cfg.stack === "django" ? "docker-compose.django.yml" : "docker-compose.remote.yml";
  return ctx.asAbsolutePath(path.join("stacks", name));
}

export function traefikFile(ctx: vscode.ExtensionContext): string {
  return ctx.asAbsolutePath(path.join("stacks", "traefik.yml"));
}

export function missingRequired(cfg: RdkConfig): string[] {
  const miss: string[] = [];
  if (!cfg.appHost) miss.push("appHost");
  if (!cfg.vpsSsh) miss.push("vpsSsh");
  if (cfg.proxyMode === "bare" && !cfg.acmeEmail) miss.push("acmeEmail");
  return miss;
}

/** Values docker-compose interpolates. Written to a private env file (never in the user's repo). */
function envMap(cfg: RdkConfig): Record<string, string> {
  return {
    PROJECT_NAME: cfg.projectName,
    APP_HOST: cfg.appHost,
    APP_PORT: String(cfg.appPort),
    APP_SERVICE: cfg.appService,
    APP_DOCKERFILE: cfg.appDockerfile,
    PROXY_NETWORK: cfg.proxyNetwork,
    CERT_RESOLVER: cfg.certResolver,
    CERT_ENTRYPOINT: cfg.certEntrypoint,
    ACME_EMAIL: cfg.acmeEmail,
    MAIL_HOST: cfg.appHost ? "mail." + cfg.appHost : "mail.localhost",
    FLOWER_HOST: cfg.appHost ? "flower." + cfg.appHost : "flower.localhost",
  };
}

/** Write the interpolation env file into the extension's private storage; return its path. */
export function writeEnvFile(ctx: vscode.ExtensionContext, cfg: RdkConfig): string {
  const dir = ctx.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cfg.projectName}.env`);
  const body = Object.entries(envMap(cfg))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(file, body + "\n", "utf8");
  return file;
}
