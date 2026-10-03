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

export const isWindows = process.platform === "win32";

/** Where a CLI lives when the extension host's PATH is too thin to find it. */
function fallbacks(bin: string): string[] {
  const home = os.homedir();
  if (isWindows) {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    return [
      path.join(pf, "Docker", "Docker", "resources", "bin", `${bin}.exe`),
      path.join(home, ".rd", "bin", `${bin}.exe`), // Rancher Desktop
    ];
  }
  return [
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/usr/bin/${bin}`,
    path.join(home, ".docker", "bin", bin),
    path.join(home, ".rd", "bin", bin), // Rancher Desktop
    path.join(home, ".local", "bin", bin),
    `/snap/bin/${bin}`, // Ubuntu's snap; not on PATH when VS Code starts from a desktop launcher
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
  if (isWindows) {
    // There is no /usr/bin/env on Windows, so the POSIX lookup below always failed and every
    // CLI read as "not installed". `where` can list an extensionless file first (e.g. a bash
    // script), which Windows can't launch directly, so prefer a real executable.
    const res = await run("where", [bin], { timeoutMs: 5_000, maxBuffer: 64 * 1024 });
    const hits = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const hit = hits.find((h) => /\.(exe|cmd|bat|com)$/i.test(h)) ?? hits[0];
    if (res.code === 0 && hit && fs.existsSync(hit)) return hit;
    return fallbacks(bin).find((p) => fs.existsSync(p));
  }
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
  const base = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, "-o", "StrictHostKeyChecking=accept-new"];
  // Windows' bundled OpenSSH has no connection multiplexing: asking for a ControlMaster makes
  // every call fail, which surfaced as "can't reach the VPS" even with a working key.
  if (isWindows) return base;
  const sock = controlPath();
  if (!sock) return base;
  return [...base, "-o", "ControlMaster=auto", "-o", `ControlPath=${sock}`, "-o", "ControlPersist=60s"];
}

/**
 * Where the multiplexing socket goes, or undefined if no short enough path exists.
 *
 * A Unix socket path is capped at 104 bytes on macOS (108 on Linux), and ssh needs room for more
 * than the final name: %C expands to 40 hex characters, and while setting the socket up ssh adds
 * a 17-character temporary suffix. This used to live in os.tmpdir(), which on macOS is
 * `/var/folders/xx/…/T/`, about 50 bytes on its own. That pushed every path over the limit, and
 * ssh exits 255 ("too long for Unix domain socket") rather than falling back, so every
 * extension-made SSH call failed on macOS: the setup check, expiry reads, all of it.
 */
function controlPath(): string | undefined {
  const ssh = path.join(os.homedir(), ".ssh");
  for (const dir of [ssh, "/tmp"]) {
    const p = path.join(dir, "rdk-%C");
    if (p.length - "%C".length + 40 + 17 >= 100) continue;
    if (dir === ssh && !fs.existsSync(ssh)) continue;
    return p;
  }
  return undefined; // run without multiplexing: slower, but it works
}

/**
 * Create a terminal whose shell we know. Command lines are quoted for one specific shell, and
 * the Windows default could be PowerShell, cmd or Git Bash, and POSIX quoting breaks in two of
 * them. On Windows we pin PowerShell, which ships with every supported version. Elsewhere the
 * default shell stays, since it's the one that sets up the user's PATH.
 */
export function createShellTerminal(opts: { name: string; iconPath?: vscode.ThemeIcon }): vscode.Terminal {
  if (!isWindows) return vscode.window.createTerminal(opts);
  return vscode.window.createTerminal({ ...opts, shellPath: "powershell.exe", shellArgs: ["-NoLogo"] });
}

let term: vscode.Terminal | undefined;

/** The single reusable RDK terminal — for interactive/streaming commands (logs, watch, shell). */
export function terminal(): vscode.Terminal {
  if (!term || term.exitStatus !== undefined) {
    term = createShellTerminal({ name: "Remote Dev Kit", iconPath: new vscode.ThemeIcon("radio-tower") });
  }
  term.show();
  return term;
}

/** Quote one argument for the shell createShellTerminal starts. */
export function shellQuote(s: string): string {
  if (isWindows) return `'${s.replace(/'/g, "''")}'`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** An argv array as one command line. PowerShell treats a leading quoted string as a value, not a command, hence `&`. */
export function commandLine(argv: string[]): string {
  const line = argv.map(shellQuote).join(" ");
  return isWindows ? `& ${line}` : line;
}

export function cdLine(dir: string): string {
  return isWindows ? `Set-Location -LiteralPath ${shellQuote(dir)}` : `cd ${shellQuote(dir)}`;
}

/** Run each line only if the previous one succeeded. Windows PowerShell 5 has no `&&`. */
export function andThen(lines: string[]): string {
  if (!isWindows) return lines.join(" && ");
  return lines.reduceRight((rest, line) => `${line}; if ($LASTEXITCODE -eq 0) { ${rest} }`);
}

/** Send an argv array to the RDK terminal as a properly quoted command line. */
export function sendToTerminal(argv: string[], cwd?: string): void {
  const t = terminal();
  if (cwd) {
    t.sendText(cdLine(cwd));
  }
  t.sendText(commandLine(argv));
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
