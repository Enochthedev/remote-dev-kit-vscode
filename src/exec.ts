import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  /** Cap on captured output. Probes read a few KB; only log/inspect commands need room. */
  maxBuffer?: number;
}

/** Run a binary with an argv array — never a shell string, so config values can't inject commands. */
export function run(file: string, args: string[], opts: RunOpts = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 20_000,
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        // The extension host may have been started without a login shell, so a spawn that
        // relies on PATH can fail for a tool the user definitely has. Callers resolve
        // absolute paths where it matters (see dockerBin).
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

export async function ok(file: string, args: string[], opts: RunOpts = {}): Promise<boolean> {
  return (await run(file, args, opts)).code === 0;
}

/** Where a CLI lives when the extension host's PATH is too thin to find it. */
function fallbacks(bin: string): string[] {
  const home = os.homedir();
  return [
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/usr/bin/${bin}`,
    path.join(home, ".docker", "bin", bin),
    path.join(home, ".rd", "bin", bin), // Rancher Desktop
    path.join(home, ".local", "bin", bin),
    "/Applications/Docker.app/Contents/Resources/bin/" + bin,
  ];
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBin(bin: string): Promise<string | undefined> {
  const res = await run("/usr/bin/env", ["which", bin], { timeoutMs: 5_000, maxBuffer: 64 * 1024 });
  const hit = res.stdout.split(/\r?\n/)[0]?.trim();
  if (res.code === 0 && hit && executable(hit)) return hit;
  return fallbacks(bin).find(executable);
}

const resolved = new Map<string, Promise<string | undefined>>();

/**
 * Absolute path to a CLI, resolved at most once per session.
 *
 * Two problems this fixes. VS Code launched from Finder or the Dock hands the extension host a
 * minimal PATH, so a working Homebrew install reported as "Docker CLI not found" — the single
 * most confusing state the extension can show. And the old code re-ran `which docker` inside
 * every state probe, so a workspace with three projects paid three PATH searches every poll,
 * forever, to re-learn something that cannot change while the window is open.
 */
export function bin(name: string): Promise<string | undefined> {
  let hit = resolved.get(name);
  if (!hit) {
    hit = resolveBin(name);
    resolved.set(name, hit);
  }
  return hit;
}

/** Re-resolve after the user installs something mid-session. */
export function forgetBins(): void {
  resolved.clear();
}

/** Is this binary available? */
export async function which(name: string): Promise<boolean> {
  return Boolean(await bin(name));
}

/** Run the docker CLI. Exit code 127 means it isn't installed — never a real docker failure. */
export async function runDocker(args: string[], opts: RunOpts = {}): Promise<ExecResult> {
  const exe = await bin("docker");
  if (!exe) return { code: 127, stdout: "", stderr: "docker CLI not found" };
  return run(exe, args, opts);
}

/**
 * SSH options every RDK connection shares.
 *
 * ControlMaster is the important one: the extension opens the same connection repeatedly (expiry
 * reads, probes), and a cold SSH handshake costs a few hundred milliseconds of round-trips before
 * a single byte of useful work happens. Multiplexing collapses every call after the first onto one
 * already-authenticated channel. ControlPersist bounds the cost — the master exits on its own once
 * the window goes quiet, so this doesn't leave a process parked forever.
 */
export function sshOpts(connectTimeout = 8): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ControlMaster=auto",
    // %C hashes host/port/user into 32 chars, keeping the socket path under the ~104 byte limit.
    "-o",
    `ControlPath=${path.join(os.tmpdir(), "rdk-%C")}`,
    "-o",
    "ControlPersist=60s",
  ];
}

let term: vscode.Terminal | undefined;

/** The single reusable RDK terminal — for interactive/streaming commands (logs, watch, shell). */
export function terminal(): vscode.Terminal {
  if (!term || term.exitStatus !== undefined) {
    term = vscode.window.createTerminal({
      name: "Remote Dev Kit",
      iconPath: new vscode.ThemeIcon("radio-tower"),
    });
  }
  term.show();
  return term;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Send an argv array to the RDK terminal as a properly quoted command line. */
export function sendToTerminal(argv: string[], cwd?: string): void {
  const t = terminal();
  if (cwd) {
    t.sendText(`cd ${shellQuote(cwd)}`);
  }
  t.sendText(argv.map(shellQuote).join(" "));
}

let channel: vscode.OutputChannel | undefined;

export function output(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Remote Dev Kit");
  }
  return channel;
}

/** Log a command and its result to the output channel, so failures are always inspectable. */
export function logResult(label: string, argv: string[], res: ExecResult): void {
  const out = output();
  out.appendLine(`\n$ ${argv.join(" ")}   # ${label}`);
  if (res.stdout.trim()) out.appendLine(res.stdout.trimEnd());
  if (res.stderr.trim()) out.appendLine(res.stderr.trimEnd());
  out.appendLine(`[exit ${res.code}]`);
}
