import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { RdkConfig } from "./config";
import { run, sshOpts } from "./exec";

/**
 * Several machines, one deployment.
 *
 * Containers are named by project alone, so a Mac and a PC set up for the same repo on the same
 * VPS share one deployment. That's the default on purpose (a second full stack per device doubles
 * the VPS load), but sharing silently is dangerous: whoever deploys last replaces the other's
 * build, and nothing said which code was running.
 *
 * So every deploy stamps the app container with who deployed what, as Docker labels. Labels live
 * on the VPS, not on either machine, so every device reads the same answer without a sync step,
 * and it doesn't matter which SSH user each machine logs in as: anyone who can talk to the Docker
 * daemon sees them.
 */

export const LABEL = {
  device: "rdk.device",
  deviceName: "rdk.device-name",
  sshUser: "rdk.ssh-user",
  repo: "rdk.repo",
  commit: "rdk.commit",
  dirty: "rdk.dirty",
  at: "rdk.deployed-at",
  host: "rdk.host",
} as const;

/** Who deployed what, as read back from the app container. */
export interface Owner {
  deviceId: string;
  deviceName: string;
  sshUser: string;
  repo: string;
  commit: string;
  dirty: boolean;
  /** Unix seconds. */
  at: number;
}

export interface LocalGit {
  /** Normalised origin URL, e.g. `github.com/enochthedev/stakey`. Empty when there's no origin. */
  repo: string;
  commit: string;
  dirty: boolean;
}

export interface Device {
  id: string;
  name: string;
}

/**
 * Label values travel through `docker ps` as one `k=v,k=v` string, so a comma would split a value
 * in two. Keep them to a plain charset.
 */
function clean(v: string, max = 100): string {
  return v.replace(/[^A-Za-z0-9._@:/+-]/g, "-").slice(0, max);
}

/**
 * This machine. VS Code's machineId is stable per install and already anonymised; the name is
 * only for people to read.
 */
export function thisDevice(): Device {
  const custom = vscode.workspace.getConfiguration("rdk").get<string>("deviceName")?.trim();
  return { id: clean(vscode.env.machineId, 16), name: clean(custom || os.hostname() || "unknown", 60) };
}

/**
 * One repo, however it was cloned: `git@github.com:A/b.git`, `https://user:tok@github.com/A/b`
 * and `ssh://git@github.com/A/b.git` are all `github.com/a/b`. Credentials never survive.
 */
export function normalizeRepo(url: string): string {
  let u = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!u) return "";
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(u); // git@host:owner/repo
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const p = new URL(u);
      u = `${p.hostname}${p.pathname}`;
    } catch {
      /* a local path or something odd: use as-is */
    }
  }
  return clean(u.replace(/^\/+/, "").toLowerCase(), 120);
}

const gitCache = new Map<string, { at: number; value: LocalGit | undefined }>();
const GIT_TTL_MS = 10_000;

/** The working tree's commit and whether it has changes. Cached briefly: the panel polls. */
export async function localGit(root: string, fresh = false): Promise<LocalGit | undefined> {
  const hit = gitCache.get(root);
  if (!fresh && hit && Date.now() - hit.at < GIT_TTL_MS) return hit.value;

  const opts = { cwd: root, timeoutMs: 5_000, maxBuffer: 256 * 1024 };
  const [head, status, origin] = await Promise.all([
    run("git", ["rev-parse", "--short=12", "HEAD"], opts),
    // Untracked files count: the image is built from the working tree, so they ship too.
    run("git", ["status", "--porcelain"], opts),
    run("git", ["remote", "get-url", "origin"], opts),
  ]);

  const value =
    head.code === 0
      ? {
          commit: clean(head.stdout.trim(), 40),
          dirty: status.code === 0 && status.stdout.trim().length > 0,
          repo: origin.code === 0 ? normalizeRepo(origin.stdout) : "",
        }
      : undefined;
  gitCache.set(root, { at: Date.now(), value });
  return value;
}

function sshUser(cfg: RdkConfig): string {
  return clean(cfg.vpsSsh.split("@")[0] || "");
}

/**
 * The compose file that carries the stamp, layered last on Deploy and Watch.
 *
 * A separate file rather than labels in the stacks or the overlay: it works the same for every
 * stack, and the overlay must stay byte-for-byte what the CLI renders. Compose merges `labels`
 * across files, so this only adds to the app service and changes nothing else.
 */
export async function renderStamp(ctx: vscode.ExtensionContext, cfg: RdkConfig, root: string): Promise<string> {
  const me = thisDevice();
  const git = await localGit(root, true);
  const labels: Record<string, string> = {
    [LABEL.device]: me.id,
    [LABEL.deviceName]: me.name,
    [LABEL.sshUser]: sshUser(cfg),
    [LABEL.repo]: git?.repo ?? "",
    [LABEL.commit]: git?.commit ?? "",
    [LABEL.dirty]: git?.dirty ? "true" : "false",
    [LABEL.at]: String(Math.floor(Date.now() / 1000)),
    [LABEL.host]: clean(cfg.appHost),
  };

  const lines = [
    "# Generated by the Remote Dev Kit extension: who deployed this, from which commit.",
    "services:",
    `  ${cfg.appService}:`,
    "    labels:",
    // JSON strings are valid YAML double-quoted scalars; clean() already ruled out `$`.
    ...Object.entries(labels).map(([k, v]) => `      - ${JSON.stringify(`${k}=${v}`)}`),
  ];

  const dir = path.join(ctx.globalStorageUri.fsPath, "stamp", cfg.projectName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "stamp.yml");
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** Read a stamp from a container's labels. Undefined when it was deployed without one. */
export function parseOwner(get: (key: string) => string | undefined): Owner | undefined {
  const deviceId = get(LABEL.device);
  if (!deviceId) return undefined;
  return {
    deviceId,
    deviceName: get(LABEL.deviceName) || "another device",
    sshUser: get(LABEL.sshUser) || "",
    repo: get(LABEL.repo) || "",
    commit: get(LABEL.commit) || "",
    dirty: get(LABEL.dirty) === "true",
    at: Number(get(LABEL.at)) || 0,
  };
}

/** `docker ps` reports labels as one `k=v,k=v` string. */
export function labelValue(labels: string, key: string): string | undefined {
  for (const pair of String(labels ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === key) return pair.slice(eq + 1);
  }
  return undefined;
}

export function isMine(owner: Owner | undefined): boolean {
  return Boolean(owner && owner.deviceId === thisDevice().id);
}

export function ago(unix: number): string {
  if (!unix) return "at an unknown time";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 90) return "just now";
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function shortCommit(c: string): string {
  return c.slice(0, 7);
}

/** "desktop-l1iugkq at a1b2c3d (uncommitted changes), 14 min ago" */
export function describeOwner(o: Owner): string {
  const who = o.deviceId === thisDevice().id ? "this device" : o.deviceName;
  const what = o.commit ? ` at ${shortCommit(o.commit)}${o.dirty ? " (uncommitted changes)" : ""}` : "";
  return `${who}${what}, ${ago(o.at)}`;
}

export interface Deployment {
  project: string;
  host?: string;
  owner?: Owner;
  running: number;
  total: number;
  /** Found by git repo (a sure match) or only by project name (could be an unrelated project). */
  matchedBy: "repo" | "name";
}

/**
 * Deployments on the VPS that this folder could join: the same git repo, or (for deploys made
 * before stamps existed, or by the CLI) the same project name.
 */
export async function findDeployments(vpsSsh: string, repo: string, name: string): Promise<Deployment[]> {
  const q = (s: string) => `'${s.replace(/'/g, "")}'`;
  const fmt = q("{{json .}}");
  const script = [
    repo ? `docker ps -a --filter label=${q(`${LABEL.repo}=${repo}`)} --format ${fmt}` : "true",
    "echo ---rdk---",
    `docker ps -a --filter label=${q(`com.docker.compose.project=${name}`)} --format ${fmt}`,
  ].join("; ");

  const res = await run("ssh", [...sshOpts(8), vpsSsh, script], { timeoutMs: 25_000, maxBuffer: 1024 * 1024 });
  if (res.code !== 0 && !res.stdout.includes("---rdk---")) return [];
  const [byRepo = "", byName = ""] = res.stdout.split("---rdk---");

  const found = new Map<string, Deployment>();
  const seen = new Set<string>(); // a stamped container answers both queries
  const take = (out: string, matchedBy: Deployment["matchedBy"]) => {
    for (const line of out.split(/\r?\n/)) {
      let r: any;
      try {
        r = JSON.parse(line.trim());
      } catch {
        continue;
      }
      if (seen.has(r.ID)) continue;
      seen.add(r.ID);
      const labels = String(r.Labels ?? "");
      const project = labelValue(labels, "com.docker.compose.project");
      if (!project || labelValue(labels, "com.docker.compose.oneoff") === "True") continue;

      const d = found.get(project) ?? { project, running: 0, total: 0, matchedBy };
      if (matchedBy === "repo") d.matchedBy = "repo";
      d.total++;
      if (String(r.State ?? "").toLowerCase() === "running") d.running++;
      d.owner ??= parseOwner((k) => labelValue(labels, k));
      d.host ??= labelValue(labels, LABEL.host) || hostFromTraefik(labels);
      found.set(project, d);
    }
  };
  take(byRepo, "repo");
  take(byName, "name");

  // Only the sure matches when we have them.
  const all = [...found.values()];
  return all.some((d) => d.matchedBy === "repo") ? all.filter((d) => d.matchedBy === "repo") : all;
}

/** Older deploys have no rdk.host, but the router rule says the same thing. */
function hostFromTraefik(labels: string): string | undefined {
  return /traefik\.http\.routers\.[^=,]+-web\.rule=Host\(`([^`]+)`\)/.exec(labels)?.[1];
}
