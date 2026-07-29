import { execFile } from "child_process";
import * as vscode from "vscode";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a binary with an argv array — never a shell string, so config values can't inject commands. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

export async function ok(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<boolean> {
  return (await run(file, args, opts)).code === 0;
}

/** Is this binary on PATH? */
export async function which(bin: string): Promise<boolean> {
  return ok("/usr/bin/env", ["which", bin], { timeoutMs: 5_000 });
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
