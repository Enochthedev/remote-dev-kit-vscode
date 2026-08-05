import * as vscode from "vscode";
import { RdkConfig, contextName, loadConfig, unresolved } from "./config";
import { detectProject, ProjectShape } from "./detect";
import { envExists } from "./env";
import { runDocker, which } from "./exec";
import { projectTtl, readTtl, Ttl, TTL_REFRESH_MS } from "./ttl";

/**
 * Every situation the extension can be in. The tree, the status bar and the guards all
 * read this one value, so the UI can never offer an action that doesn't apply yet.
 */
export type Phase =
  | "no-workspace" // nothing open
  | "no-project" // a workspace, but no RDK project found anywhere in it
  | "docker-missing" // no docker CLI on this machine
  | "not-deployable" // a folder, but nothing we can build (no Dockerfile)
  | "unconfigured" // deployable, but no .env.remote yet  → offer setup
  | "incomplete" // .env.remote exists but still has placeholders → offer fix
  | "checking" // configured; the first remote probe hasn't answered yet
  | "disconnected" // configured, but no docker context → offer connect
  | "not-deployed" // connected, nothing running yet → offer deploy
  | "stopped" // containers exist but are stopped → offer start
  | "partial" // some services up, some down/exited
  | "running"; // all good

export interface Service {
  name: string;
  state: string; // running | exited | created | restarting …
  status: string; // "Up 4 minutes"
  health?: string;
  exitCode?: number;
}

export interface RdkState {
  phase: Phase;
  root?: string;
  cfg?: RdkConfig;
  shape?: ProjectShape;
  /** Which .env.remote keys are missing/placeholder (phase === "incomplete"). */
  missing: string[];
  services: Service[];
  /** Expiry, if one is set. Only read for deployed projects — it costs an SSH round-trip. */
  ttl?: Ttl;
}

function isUp(s: Service): boolean {
  return s.state === "running";
}

/** `docker ps` reports labels as one `k=v,k=v` string. */
function labelValue(labels: string, key: string): string | undefined {
  for (const pair of String(labels ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === key) return pair.slice(eq + 1);
  }
  return undefined;
}

/**
 * Parse `docker ps --format {{json .}}` — one JSON object per line.
 *
 * We ask `docker ps` rather than `docker compose ps` on purpose. Compose has to read, merge and
 * interpolate every compose file before it will tell you anything, and in overlay mode that meant
 * regenerating the overlay on disk once per poll just to list containers. `docker ps` filtered by
 * the compose project label answers the same question with a single API call and no local work.
 */
export function parsePs(stdout: string): Service[] {
  const out: Service[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;

    let r: any;
    try {
      r = JSON.parse(l);
    } catch {
      continue; // skip a malformed row rather than losing the whole listing
    }

    // `docker compose run` containers carry the project label too, but they are not services —
    // a `manage.py migrate` still in flight would otherwise appear as a phantom row and drag the
    // project into "degraded". Compose hid these for us; filtering by label alone does not.
    // Treat an absent label as a normal container: older compose builds don't always set it.
    if (labelValue(r.Labels, "com.docker.compose.oneoff") === "True") continue;

    const status: string = r.Status ?? "";
    out.push({
      name: labelValue(r.Labels, "com.docker.compose.service") ?? r.Names ?? r.Name ?? "?",
      state: String(r.State ?? "").toLowerCase(),
      status,
      // `docker ps` folds health into Status ("Up 3 minutes (healthy)") — compose had its own field.
      health: /\(healthy\)/.test(status)
        ? "healthy"
        : /\(unhealthy\)/.test(status)
          ? "unhealthy"
          : /health: starting/.test(status)
            ? "starting"
            : undefined,
      exitCode: Number(status.match(/^Exited \((\d+)\)/)?.[1] ?? NaN) || undefined,
    });
  }

  // Compose orders by service name; `docker ps` orders by creation. Sort so the tree stops
  // reshuffling its rows every time a container is recreated.
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `files` is one bundled stack, or (overlay mode) the project's own compose file(s) + our overlay. */
export function composeArgs(cfg: RdkConfig, root: string, files: string[], ...rest: string[]): string[] {
  return [
    "--context",
    contextName(cfg),
    "compose",
    "-p",
    cfg.projectName,
    "--project-directory",
    root,
    "--env-file",
    ".env.remote",
    ...files.flatMap((f) => ["-f", f]),
    ...rest,
  ];
}

/**
 * Whether a docker context exists. Contexts are created by us and essentially never vanish
 * mid-session, but `docker context inspect` still costs a process spawn per project per poll,
 * so a confirmed hit is remembered. A miss is not cached — that's the state the user is
 * actively trying to fix by hitting Connect, and it must clear the instant they do.
 */
const knownContexts = new Set<string>();

export function forgetContext(name?: string): void {
  if (name) knownContexts.delete(name);
  else knownContexts.clear();
}

export async function contextExists(name: string): Promise<boolean> {
  if (knownContexts.has(name)) return true;
  const res = await runDocker(["context", "inspect", name], { timeoutMs: 10_000, maxBuffer: 256 * 1024 });
  if (res.code === 0) knownContexts.add(name);
  return res.code === 0;
}

/** Last expiry read per project, so the countdown can tick locally between SSH reads. */
const ttlCache = new Map<string, Ttl>();

export function forgetTtl(projectName?: string): void {
  if (projectName) ttlCache.delete(projectName);
  else ttlCache.clear();
}

async function currentTtl(cfg: RdkConfig): Promise<Ttl | undefined> {
  const cached = ttlCache.get(cfg.projectName);
  if (cached && Date.now() - cached.readAt * 1000 < TTL_REFRESH_MS) return projectTtl(cached);

  const fresh = await readTtl(cfg).catch(() => undefined);
  if (fresh) ttlCache.set(cfg.projectName, fresh);
  else ttlCache.delete(cfg.projectName);
  return fresh;
}

const UNREACHABLE = /cannot connect|connection refused|no such host|permission denied|timed out|handshake|broken pipe/i;

export interface ResolveOpts {
  /** Skip every remote call. Used for the first paint, so opening a window never waits on SSH. */
  localOnly?: boolean;
  /** The phase this project was last known to be in, kept when a probe fails outright. */
  previous?: RdkState;
}

/**
 * Work out the current phase. Cheap checks first; we only touch the network (via the
 * remote docker context) once we know there's something worth asking about.
 */
export async function resolveState(root: string | undefined, opts: ResolveOpts = {}): Promise<RdkState> {
  const empty = { missing: [], services: [] };

  if (!root) return { phase: "no-workspace", ...empty };
  if (!(await which("docker"))) return { phase: "docker-missing", root, ...empty };

  const shape = detectProject(root);

  if (!envExists(root)) {
    return { phase: shape.deployable ? "unconfigured" : "not-deployable", root, shape, ...empty };
  }

  const cfg = loadConfig(root);
  if (!cfg) return { phase: "unconfigured", root, shape, ...empty };

  const missing = unresolved(cfg);
  if (missing.length) {
    return { phase: "incomplete", root, cfg, shape, missing, services: [] };
  }

  // Everything past here needs the VPS. On the first paint we say so rather than paying for it.
  if (opts.localOnly) {
    const prev = opts.previous;
    if (prev?.cfg && prev.root === root) return { ...prev, cfg, shape, missing: [] };
    return { phase: "checking", root, cfg, shape, missing: [], services: [] };
  }

  const ctxName = contextName(cfg);
  if (!(await contextExists(ctxName))) {
    return { phase: "disconnected", root, cfg, shape, missing: [], services: [] };
  }

  const ps = await runDocker(
    [
      "--context",
      ctxName,
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${cfg.projectName}`,
      "--format",
      "{{json .}}",
    ],
    { cwd: root, timeoutMs: 30_000, maxBuffer: 512 * 1024 },
  );

  if (ps.code !== 0) {
    // The context exists but the daemon is unreachable (VPS down, SSH broken).
    if (UNREACHABLE.test(ps.stderr)) {
      forgetContext(ctxName);
      return { phase: "disconnected", root, cfg, shape, missing: [], services: [] };
    }
    // Any other failure tells us nothing about the deployment. Reporting "not deployed" here
    // was a real bug: one flaky probe made a running project's tree collapse to a Deploy button.
    const prev = opts.previous;
    if (prev && prev.root === root && prev.services.length) {
      return { ...prev, cfg, shape, missing: [] };
    }
    return { phase: "disconnected", root, cfg, shape, missing: [], services: [] };
  }

  const services = parsePs(ps.stdout);
  if (!services.length) {
    return { phase: "not-deployed", root, cfg, shape, missing: [], services: [] };
  }

  const up = services.filter(isUp).length;
  const phase: Phase = up === 0 ? "stopped" : up === services.length ? "running" : "partial";
  const ttl = await currentTtl(cfg);
  return { phase, root, cfg, shape, missing: [], services, ttl };
}

/** A compact snapshot of everything the UI draws — lets a poll skip a repaint when nothing moved. */
export function fingerprint(states: RdkState[]): string {
  return states
    .map((s) => {
      const svc = s.services.map((x) => `${x.name}:${x.state}:${x.health ?? ""}`).join("|");
      // Bucket the countdown: it changes every second, but the label only renders whole minutes.
      const ttl = s.ttl ? Math.floor(s.ttl.secondsLeft / 60) : "";
      return `${s.root}=${s.phase}#${s.missing.join(",")}#${svc}#${ttl}`;
    })
    .join("\n");
}

/** Drives `when` clauses in package.json (menus, welcome views). */
export function publishContext(state: RdkState, projectCount = 1): void {
  vscode.commands.executeCommand("setContext", "rdk.phase", state.phase);
  vscode.commands.executeCommand("setContext", "rdk.projectCount", projectCount);
  vscode.commands.executeCommand(
    "setContext",
    "rdk.deployed",
    ["running", "partial", "stopped"].includes(state.phase),
  );
}

export function phaseLabel(phase: Phase): string {
  const map: Record<Phase, string> = {
    "no-workspace": "No folder open",
    "no-project": "No project found",
    "docker-missing": "Docker CLI not found",
    "not-deployable": "No Dockerfile",
    unconfigured: "Not set up",
    incomplete: "Setup unfinished",
    checking: "Checking…",
    disconnected: "Not connected",
    "not-deployed": "Not deployed",
    stopped: "Stopped",
    partial: "Degraded",
    running: "Running",
  };
  return map[phase];
}
