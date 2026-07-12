import * as fs from "fs";
import * as path from "path";
import { run, which } from "./exec";

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

/** Infer stack, service, Dockerfile and port from what's on disk. */
export function detectProject(root: string): ProjectShape {
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

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new"];

/**
 * SSH in once and read the VPS's actual proxy setup, so the user never has to know what
 * a "cert resolver" is. Falls back to bare-Traefik defaults when nothing is detected.
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

  const hello = await run("ssh", [...SSH_OPTS, vpsSsh, "echo rdk-ok"], { timeoutMs: 20_000 });
  if (hello.code !== 0 || !hello.stdout.includes("rdk-ok")) {
    return { ...base, error: (hello.stderr || hello.stdout).trim() || "SSH connection failed" };
  }
  base.reachable = true;
  base.passwordless = true;

  const docker = await run("ssh", [...SSH_OPTS, vpsSsh, "command -v docker >/dev/null && echo yes"], {
    timeoutMs: 20_000,
  });
  base.hasDocker = docker.stdout.includes("yes");
  if (!base.hasDocker) {
    return { ...base, error: "Docker is not installed on the VPS" };
  }

  const nets = await run("ssh", [...SSH_OPTS, vpsSsh, "docker network ls --format '{{.Name}}'"], {
    timeoutMs: 20_000,
  });
  const networks = nets.stdout.split(/\r?\n/).map((n) => n.trim());

  if (networks.includes("coolify")) {
    base.proxyMode = "coolify";
    base.proxyNetwork = "coolify";

    // Read the real resolver/entrypoint names off the running proxy rather than guessing.
    const args = await run(
      "ssh",
      [...SSH_OPTS, vpsSsh, "docker inspect coolify-proxy --format '{{join .Args \" \"}}' 2>/dev/null || true"],
      { timeoutMs: 20_000 },
    );
    const resolver = args.stdout.match(/certificatesresolvers\.([A-Za-z0-9_-]+)\.acme/)?.[1];
    if (resolver) base.certResolver = resolver;

    const entry = args.stdout.match(/entrypoints\.([A-Za-z0-9_-]+)\.address=:443/)?.[1];
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
