import * as fs from "fs";
import * as path from "path";
import { run, sshOpts, which } from "./exec";

export interface ProjectShape {
  /** Can this folder actually be built and deployed? (i.e. is there a Dockerfile we can use) */
  deployable: boolean;
  stack: "generic" | "django";
  appService: string;
  appDockerfile: string;
  appPort: number;
  /** Human explanation of what we found — shown in the wizard so detection isn't a black box. */
  reason: string;
}

const DJANGO_DOCKERFILE = "compose/local/django/Dockerfile";

/** Files we recognise as "the project's own compose". Mirrors _BASE_CANDIDATES in bin/rdk. */
const BASE_CANDIDATES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "docker-compose.local.yml",
];

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

/** The project's own compose file, if it has one. Overlay mode layers on top of it. */
export function detectBaseCompose(root: string): string | undefined {
  return BASE_CANDIDATES.find((f) => exists(root, f));
}

/** Service names declared in a compose file — good enough to offer as a pick list. */
export function composeServices(root: string, file: string): string[] {
  try {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const body = text.split(/^services:\s*$/m)[1];
    if (!body) return [];
    const out: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (/^\S/.test(line)) break; // dedented out of `services:`
      const m = /^ {2}([A-Za-z0-9._-]+):/.exec(line);
      if (m) out.push(m[1]);
    }
    return out;
  } catch {
    return [];
  }
}

/** First EXPOSEd port in a Dockerfile, if any. */
function exposedPort(root: string, rel: string): number | undefined {
  try {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const m = text.match(/^\s*EXPOSE\s+(\d{2,5})/im);
    if (m) {
      const p = Number(m[1]);
      if (p > 0 && p < 65536) return p;
    }
  } catch {
    /* unreadable Dockerfile — fall through to the default */
  }
  return undefined;
}

/**
 * Memo for detectProject, keyed on the folder's own mtime.
 *
 * Detection is four-plus filesystem hits per folder, and discovery runs it across every folder in
 * the scan depth. A directory's mtime changes whenever an entry is added or removed in it, so a
 * Dockerfile appearing invalidates the entry that cares — one stat replaces the whole probe.
 */
const shapes = new Map<string, { mtimeMs: number; shape: ProjectShape }>();

function dirStamp(root: string): number {
  try {
    return fs.statSync(root).mtimeMs;
  } catch {
    return -1;
  }
}

/** Infer stack, service, Dockerfile and port from what's on disk. */
export function detectProject(root: string): ProjectShape {
  const mtimeMs = dirStamp(root);
  const hit = shapes.get(root);
  if (hit && hit.mtimeMs === mtimeMs) return hit.shape;

  const shape = probeProject(root);
  shapes.set(root, { mtimeMs, shape });
  return shape;
}

function probeProject(root: string): ProjectShape {
  const hasManage = exists(root, "manage.py");
  const hasDjangoDockerfile = exists(root, DJANGO_DOCKERFILE);
  const hasRootDockerfile = exists(root, "Dockerfile");

  if (hasManage && hasDjangoDockerfile) {
    return {
      deployable: true,
      stack: "django",
      appService: "django",
      appDockerfile: `./${DJANGO_DOCKERFILE}`,
      appPort: exposedPort(root, DJANGO_DOCKERFILE) ?? 8000,
      reason: "Found manage.py and compose/local/django/Dockerfile — Cookiecutter-Django layout.",
    };
  }

  if (hasRootDockerfile) {
    const port = exposedPort(root, "Dockerfile");
    return {
      deployable: true,
      stack: "generic",
      appService: "app",
      appDockerfile: "./Dockerfile",
      appPort: port ?? 8000,
      reason: port
        ? `Found ./Dockerfile with EXPOSE ${port}.`
        : "Found ./Dockerfile (no EXPOSE line — assuming port 8000).",
    };
  }

  if (hasManage) {
    return {
      deployable: false,
      stack: "django",
      appService: "django",
      appDockerfile: `./${DJANGO_DOCKERFILE}`,
      appPort: 8000,
      reason: "Found manage.py but no compose/local/django/Dockerfile to build from.",
    };
  }

  return {
    deployable: false,
    stack: "generic",
    appService: "app",
    appDockerfile: "./Dockerfile",
    appPort: 8000,
    reason: "No Dockerfile found — RDK builds images, so it needs one.",
  };
}

/** A docker-compose–safe project name: lowercase, alphanumeric plus dash/underscore. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

export interface VpsProbe {
  reachable: boolean;
  /** Did the SSH connection succeed without a prompt (key-based)? */
  passwordless: boolean;
  hasDocker: boolean;
  /** "coolify" if an existing Coolify/Traefik proxy is running, else "bare". */
  proxyMode: "bare" | "coolify";
  proxyNetwork: string;
  certResolver: string;
  certEntrypoint: string;
  error?: string;
}

/**
 * SSH in once and read the VPS's actual proxy setup, so the user never has to know what
 * a "cert resolver" is. Falls back to bare-Traefik defaults when nothing is detected.
 *
 * One connection, not four. The old version ran reachability, the docker check, the network
 * list and the proxy inspect as separate `ssh` invocations, each paying a full handshake — on a
 * VPS a continent away that was most of the wizard's wall-clock time. The script is delimiter-
 * separated so a failure in a later section still leaves the earlier answers readable.
 */
export async function probeVps(vpsSsh: string): Promise<VpsProbe> {
  const base: VpsProbe = {
    reachable: false,
    passwordless: false,
    hasDocker: false,
    proxyMode: "bare",
    proxyNetwork: "web",
    certResolver: "letsencrypt",
    certEntrypoint: "https",
  };

  const script = [
    "echo rdk-ok",
    "echo ---",
    "command -v docker >/dev/null && echo yes",
    "echo ---",
    "docker network ls --format '{{.Name}}' 2>/dev/null",
    "echo ---",
    "docker inspect coolify-proxy --format '{{join .Args \" \"}}' 2>/dev/null || true",
  ].join("; ");

  const res = await run("ssh", [...sshOpts(8), vpsSsh, script], { timeoutMs: 25_000, maxBuffer: 256 * 1024 });
  const [hello = "", dockerOut = "", netsOut = "", proxyArgs = ""] = res.stdout.split("---");

  if (!hello.includes("rdk-ok")) {
    return { ...base, error: (res.stderr || res.stdout).trim() || "SSH connection failed" };
  }
  base.reachable = true;
  base.passwordless = true;

  base.hasDocker = dockerOut.includes("yes");
  if (!base.hasDocker) {
    return { ...base, error: "Docker is not installed on the VPS" };
  }

  const networks = netsOut.split(/\r?\n/).map((n) => n.trim());

  if (networks.includes("coolify")) {
    base.proxyMode = "coolify";
    base.proxyNetwork = "coolify";

    // Read the real resolver/entrypoint names off the running proxy rather than guessing.
    const resolver = proxyArgs.match(/certificatesresolvers\.([A-Za-z0-9_-]+)\.acme/)?.[1];
    if (resolver) base.certResolver = resolver;

    const entry = proxyArgs.match(/entrypoints\.([A-Za-z0-9_-]+)\.address=:443/)?.[1];
    if (entry) base.certEntrypoint = entry;
  } else if (networks.includes("web")) {
    base.proxyMode = "bare";
    base.proxyNetwork = "web";
  }

  return base;
}

export interface Prereqs {
  dockerCli: boolean;
  rdkCli: boolean;
}

export async function checkPrereqs(): Promise<Prereqs> {
  const [dockerCli, rdkCli] = await Promise.all([which("docker"), which("rdk")]);
  return { dockerCli, rdkCli };
}
