import * as vscode from "vscode";
import { RdkConfig, contextName, loadConfig, unresolved } from "./config";
import { detectProject, ProjectShape } from "./detect";
import { envExists } from "./env";
import { run, which } from "./exec";
import { readTtl, Ttl } from "./ttl";

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

/** Parse `docker compose ps --format json` — v2 emits NDJSON, older builds emit an array. */
function parsePs(stdout: string): Service[] {
  const text = stdout.trim();
  if (!text) return [];

  const rows: any[] = [];
  if (text.startsWith("[")) {
    try {
      rows.push(...JSON.parse(text));
    } catch {
      return [];
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        rows.push(JSON.parse(l));
      } catch {
        /* skip a malformed row rather than losing the whole listing */
      }
    }
  }

  return rows.map((r) => ({
    name: r.Service ?? r.Name ?? "?",
    state: String(r.State ?? "").toLowerCase(),
    status: r.Status ?? "",
    health: r.Health || undefined,
    exitCode: typeof r.ExitCode === "number" ? r.ExitCode : undefined,
  }));
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
 * Work out the current phase. Cheap checks first; we only touch the network (via the
 * remote docker context) once we know there's something worth asking about.
 */
export async function resolveState(
  root: string | undefined,
  filesFor: (c: RdkConfig, root: string) => string[],
): Promise<RdkState> {
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

  const ctx = await run("docker", ["context", "inspect", contextName(cfg)], { timeoutMs: 10_000 });
  if (ctx.code !== 0) {
    return { phase: "disconnected", root, cfg, shape, missing: [], services: [] };
  }

  const ps = await run("docker", composeArgs(cfg, root, filesFor(cfg, root), "ps", "-a", "--format", "json"), {
    cwd: root,
    timeoutMs: 30_000,
  });

  // The context exists but the daemon is unreachable (VPS down, SSH broken) — treat as disconnected.
  if (ps.code !== 0 && /cannot connect|connection refused|no such host|permission denied/i.test(ps.stderr)) {
    return { phase: "disconnected", root, cfg, shape, missing: [], services: [] };
  }

  const services = parsePs(ps.stdout);
  if (!services.length) {
    return { phase: "not-deployed", root, cfg, shape, missing: [], services: [] };
  }

  const up = services.filter(isUp).length;
  const phase: Phase = up === 0 ? "stopped" : up === services.length ? "running" : "partial";
  const ttl = await readTtl(cfg).catch(() => undefined);
  return { phase, root, cfg, shape, missing: [], services, ttl };
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
    disconnected: "Not connected",
    "not-deployed": "Not deployed",
    stopped: "Stopped",
    partial: "Degraded",
    running: "Running",
  };
  return map[phase];
}
