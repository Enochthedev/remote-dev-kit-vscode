import * as vscode from "vscode";
import * as path from "path";
import { EnvMap, isPlaceholder, readEnv } from "./env";
import { slug } from "./detect";

export interface RdkConfig {
  projectName: string;
  appHost: string;
  appPort: number;
  appService: string;
  composeFile: string;
  appDockerfile: string;
  vpsSsh: string;
  proxyNetwork: string;
  acmeEmail: string;
  certResolver: string;
  certEntrypoint: string;
  /** The proxy's :80 entrypoint — target of the http→https redirect router. */
  httpEntrypoint: string;
  redisPassword: string;
  /** The project's OWN compose file(s). Set = overlay mode: we add labels, we own no services. */
  baseCompose: string;
  /** Was APP_SERVICE actually chosen, or is it just the stack-derived default? */
  appServiceSet: boolean;
  ttl: string;
  ttlPrompt: string;
}

/** Overlay mode: the project's compose file is the source of truth and RDK only layers on top. */
export function isOverlay(cfg: RdkConfig): boolean {
  return cfg.baseCompose.length > 0;
}

/** Base compose files, relative to the project root. */
export function baseFiles(cfg: RdkConfig): string[] {
  return cfg.baseCompose
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

export type ProxyMode = "bare" | "coolify";

export function proxyMode(cfg: RdkConfig): ProxyMode {
  return cfg.proxyNetwork === "coolify" ? "coolify" : "bare";
}

export function stack(cfg: RdkConfig): "overlay" | "generic" | "generic-db" | "django" {
  if (cfg.baseCompose) return "overlay";
  if (cfg.composeFile === "docker-compose.django.yml") return "django";
  if (cfg.composeFile === "docker-compose.remote-db.yml") return "generic-db";
  return "generic";
}

export function contextName(cfg: RdkConfig): string {
  return "remote-" + cfg.projectName;
}

export function appUrl(cfg: RdkConfig): string {
  return `https://${cfg.appHost}`;
}

/**
 * Machine-level defaults. These are the values the CLI's own template calls
 * "set once, rarely changes across projects" — so we ask for them once, globally,
 * and stamp them into every new project's .env.remote.
 */
export interface Defaults {
  vpsSsh: string;
  baseDomain: string;
  acmeEmail: string;
  proxyNetwork: string;
  certResolver: string;
  certEntrypoint: string;
}

export function getDefaults(): Defaults {
  const c = vscode.workspace.getConfiguration("rdk");
  return {
    vpsSsh: (c.get<string>("vpsSsh") || "").trim(),
    baseDomain: (c.get<string>("baseDomain") || "").trim().replace(/^\.+/, ""),
    acmeEmail: (c.get<string>("acmeEmail") || "").trim(),
    proxyNetwork: (c.get<string>("proxyNetwork") || "web").trim(),
    certResolver: (c.get<string>("certResolver") || "letsencrypt").trim(),
    certEntrypoint: (c.get<string>("certEntrypoint") || "https").trim(),
  };
}

export async function saveDefaults(d: Partial<Defaults>): Promise<void> {
  const c = vscode.workspace.getConfiguration("rdk");
  for (const [k, v] of Object.entries(d)) {
    await c.update(k, v, vscode.ConfigurationTarget.Global);
  }
}

export function hasDefaults(): boolean {
  const d = getDefaults();
  return Boolean(d.vpsSsh && d.baseDomain);
}

/** Build config out of a parsed .env.remote. This file is the source of truth. */
export function fromEnv(env: EnvMap, root: string): RdkConfig {
  const name = env.PROJECT_NAME?.trim() || slug(path.basename(root));
  return {
    projectName: name,
    appHost: (env.APP_HOST || "").trim(),
    appPort: Number(env.APP_PORT) || 8000,
    appService: (env.APP_SERVICE || "app").trim(),
    composeFile: (env.COMPOSE_FILE || "docker-compose.remote.yml").trim(),
    appDockerfile: (env.APP_DOCKERFILE || "./Dockerfile").trim(),
    vpsSsh: (env.VPS_SSH || "").trim(),
    proxyNetwork: (env.PROXY_NETWORK || "web").trim(),
    acmeEmail: (env.ACME_EMAIL || "").trim(),
    certResolver: (env.CERT_RESOLVER || "letsencrypt").trim(),
    certEntrypoint: (env.CERT_ENTRYPOINT || "https").trim(),
    httpEntrypoint: (env.HTTP_ENTRYPOINT || "http").trim(),
    redisPassword: (env.REDIS_PASSWORD || "").trim(),
    baseCompose: (env.BASE_COMPOSE || "").trim(),
    appServiceSet: Boolean(env.APP_SERVICE?.trim()),
    ttl: (env.TTL || "").trim(),
    ttlPrompt: (env.TTL_PROMPT || "10m").trim(),
  };
}

export function loadConfig(root: string): RdkConfig | undefined {
  const env = readEnv(root);
  return env ? fromEnv(env, root) : undefined;
}

/**
 * Fields that are missing or still hold a `rdk init` placeholder. Reported by name so the
 * UI can say exactly what to fix instead of a generic "not configured".
 */
export function unresolved(cfg: RdkConfig): string[] {
  const bad: string[] = [];
  if (!cfg.projectName) bad.push("PROJECT_NAME");
  if (isPlaceholder(cfg.appHost)) bad.push("APP_HOST");
  if (isPlaceholder(cfg.vpsSsh)) bad.push("VPS_SSH");
  if (proxyMode(cfg) === "bare" && isPlaceholder(cfg.acmeEmail)) bad.push("ACME_EMAIL");
  // The remote-db stack guards REDIS_PASSWORD with `:?`, so Redis refuses to boot without it.
  // Catch it here rather than letting Deploy fail at compose time.
  if (stack(cfg) === "generic-db" && !cfg.redisPassword) bad.push("REDIS_PASSWORD");
  // In overlay mode APP_SERVICE is whichever of YOUR services faces the web. There is no
  // sensible default — the stack-derived "app"/"django" is a guess at someone else's file.
  if (isOverlay(cfg) && !cfg.appServiceSet) bad.push("APP_SERVICE");
  return bad;
}

/** Extra hosts the django stack routes, so the tree can offer them as links. */
export function extraHosts(cfg: RdkConfig): { label: string; host: string; icon: string }[] {
  if (stack(cfg) !== "django" || !cfg.appHost) return [];
  return [
    { label: "Mailpit", host: `mail.${cfg.appHost}`, icon: "mail" },
    { label: "Flower", host: `flower.${cfg.appHost}`, icon: "graph" },
  ];
}
