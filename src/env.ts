import * as fs from "fs";
import * as path from "path";
import { run } from "./exec";

export const ENV_FILE = ".env.remote";

/** Keys that must never come out of a config file — they would hijack the shell/loader. Mirrors bin/rdk. */
const DENY = /^(PATH|IFS|ENV|BASH_ENV|SHELLOPTS|PS4|PROMPT_COMMAND|LD_.*|DYLD_.*|BASH_FUNC_.*)$/;

export type EnvMap = Record<string, string>;

export function envPath(root: string): string {
  return path.join(root, ENV_FILE);
}

export function envExists(root: string): boolean {
  return fs.existsSync(envPath(root));
}

/**
 * Parse KEY=VALUE only — never evaluate. Same rules as the CLI's safe loader so both
 * agree on exactly what a given .env.remote means.
 */
export function parseEnv(text: string): EnvMap {
  const out: EnvMap = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key) || DENY.test(key)) continue;

    let val = line.slice(eq + 1);
    val = val.replace(/\s+#.*$/, "").trim(); // strip inline comment
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function readEnv(root: string): EnvMap | undefined {
  const file = envPath(root);
  if (!fs.existsSync(file)) return undefined;
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Strip anything that would break out of a single KEY=VALUE line. */
function sanitize(v: string): string {
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

/**
 * Update keys in place, preserving the user's comments, ordering and hand-edits.
 * Keys not already present are appended.
 */
export function updateEnv(root: string, patch: EnvMap): void {
  const file = envPath(root);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(patch).map(([k, v]) => [k, sanitize(v)]));

  const next = lines.map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return raw;
    const eq = line.indexOf("=");
    if (eq < 0) return raw;
    const key = line.slice(0, eq).trim();
    if (!pending.has(key)) return raw;

    const value = pending.get(key)!;
    pending.delete(key);
    // keep any trailing comment the user wrote on this line
    const comment = raw.match(/\s+(#.*)$/)?.[1];
    return comment ? `${key}=${value}   ${comment}` : `${key}=${value}`;
  });

  for (const [k, v] of pending) {
    next.push(`${k}=${v}`);
  }

  let body = next.join("\n");
  if (!body.endsWith("\n")) body += "\n";
  fs.writeFileSync(file, body, "utf8");
}

export interface ScaffoldValues {
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
  /** Required by the remote-db stack — Redis will not boot without it. */
  redisPassword?: string;
  /** Set = overlay mode: the project's own compose file is the base, RDK only adds labels. */
  baseCompose?: string;
  ttl?: string;
}

/** Write a complete, CLI-compatible .env.remote. The file is self-sufficient: `rdk up` works from it alone. */
export function writeEnv(root: string, v: ScaffoldValues): void {
  const django = v.composeFile === "docker-compose.django.yml";
  const genericDb = v.composeFile === "docker-compose.remote-db.yml";
  const s = (x: string | number) => sanitize(String(x));

  const lines = [
    "# Remote Dev Kit — the only per-project file. Read by both `rdk` and the VS Code extension.",
    "# Safe to edit by hand; the extension picks changes up on save.",
    "",
    "# ── Per-project ────────────────────────────────────────────────────────",
    `PROJECT_NAME=${s(v.projectName)}`,
    `APP_HOST=${s(v.appHost)}`,
    `APP_PORT=${s(v.appPort)}`,
    `APP_SERVICE=${s(v.appService)}`,
  ];

  if (v.baseCompose) {
    lines.push(
      "",
      "# Your compose file is the source of truth. RDK adds only the proxy network and the",
      "# traefik labels on APP_SERVICE — it does not redefine your services.",
      `BASE_COMPOSE=${s(v.baseCompose)}`,
    );
  } else {
    lines.push(`COMPOSE_FILE=${s(v.composeFile)}`, `APP_DOCKERFILE=${s(v.appDockerfile)}`);
  }

  lines.push(
    "",
    "# ── VPS + proxy (set once, rarely changes across projects) ─────────────",
    `VPS_SSH=${s(v.vpsSsh)}`,
    `PROXY_NETWORK=${s(v.proxyNetwork)}`,
    `ACME_EMAIL=${s(v.acmeEmail)}`,
    `CERT_RESOLVER=${s(v.certResolver)}`,
    `CERT_ENTRYPOINT=${s(v.certEntrypoint)}`,
    "",
    "# ── Expiry (optional) ──────────────────────────────────────────────────",
    "# Stop automatically after this long. Volumes are KEPT. Needs: rdk reaper up",
    `TTL=${s(v.ttl ?? "")}`,
    "TTL_PROMPT=10m",
  );

  if (django) {
    lines.push(
      "",
      "# ── Django stack only ──────────────────────────────────────────────────",
      `MAIL_HOST=mail.${s(v.appHost)}`,
      `FLOWER_HOST=flower.${s(v.appHost)}`,
      "DJANGO_DOCKERFILE=./compose/local/django/Dockerfile",
      "POSTGRES_DOCKERFILE=./compose/production/postgres/Dockerfile",
      "APP_ENV_FILE=./.envs/.local/.django",
      "DB_ENV_FILE=./.envs/.local/.postgres",
    );
  }

  if (genericDb) {
    lines.push(
      "",
      "# ── Postgres + Redis stack only ────────────────────────────────────────",
      "# Reach them from your app at these hostnames — the aliases avoid colliding",
      "# with a `postgres`/`redis` that already exists on a shared proxy network.",
      `#   ${s(v.projectName)}-postgres      ${s(v.projectName)}-redis`,
      `REDIS_PASSWORD=${s(v.redisPassword ?? "")}`,
      "APP_ENV_FILE=./.env.remote.app",
      "DB_ENV_FILE=./.env.remote.db",
      "POSTGRES_IMAGE=postgres:18-alpine",
      "REDIS_IMAGE=redis:7-alpine",
    );
  }

  fs.writeFileSync(envPath(root), lines.join("\n") + "\n", "utf8");
}

/**
 * Keep the SSH target out of git. Prefer .git/info/exclude — it's local-only, so we never
 * dirty a tracked .gitignore in someone else's repo.
 */
export async function ensureIgnored(root: string): Promise<boolean> {
  const isRepo = (await run("git", ["rev-parse", "--git-dir"], { cwd: root, timeoutMs: 5_000 })).code === 0;
  if (!isRepo) return false;

  if ((await run("git", ["check-ignore", "-q", ENV_FILE], { cwd: root, timeoutMs: 5_000 })).code === 0) {
    return true; // already ignored somewhere
  }

  const gitDir = (await run("git", ["rev-parse", "--git-dir"], { cwd: root, timeoutMs: 5_000 })).stdout.trim();
  const abs = path.isAbsolute(gitDir) ? gitDir : path.join(root, gitDir);
  const exclude = path.join(abs, "info", "exclude");

  try {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!cur.split(/\r?\n/).some((l) => l.trim() === ENV_FILE)) {
      fs.appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${ENV_FILE}\n`, "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

/** Placeholder values shipped by `rdk init` — present means "not actually configured yet". */
const PLACEHOLDERS = [
  /^youruser@YOUR_VPS_IP$/i,
  /^you@example\.com$/i,
  /YOUR_VPS_IP/i,
  /\.example\.com$/i,
];

export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  return PLACEHOLDERS.some((re) => re.test(v));
}
