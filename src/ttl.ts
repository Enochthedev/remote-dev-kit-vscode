import * as vscode from "vscode";
import { RdkConfig } from "./config";
import { run, sshOpts } from "./exec";

const SSH = sshOpts(10);
const TTL_DIR = "/var/lib/rdk/ttl";

export interface Ttl {
  /** Absolute expiry, epoch seconds — on the VPS clock. */
  expiresAt: number;
  secondsLeft: number;
  /** Is anything actually enforcing this? A TTL nobody enforces is worse than none. */
  reaperRunning: boolean;
  /** VPS clock minus this machine's clock, so the countdown can be advanced locally. */
  skew: number;
  /** Local epoch seconds when this was last read from the VPS. */
  readAt: number;
}

/**
 * Advance a cached expiry using the local clock instead of asking the VPS again.
 *
 * An expiry is a countdown against a fixed instant: once we know `expiresAt` and how far the
 * VPS clock sits from ours, every later tick is arithmetic. Re-reading it over SSH on every poll
 * bought nothing but latency and a second round-trip per project.
 */
export function projectTtl(ttl: Ttl): Ttl {
  const nowOnVps = Math.floor(Date.now() / 1000) + ttl.skew;
  return { ...ttl, secondsLeft: ttl.expiresAt - nowOnVps };
}

/** How long a cached expiry stays trustworthy before we re-read it (someone may have changed it on the box). */
export const TTL_REFRESH_MS = 5 * 60_000;

/** "90m" | "4h" | "2d" -> seconds. Mirrors _ttl_secs in bin/rdk. */
export function parseDuration(d: string): number | undefined {
  const m = /^(\d+)\s*([smhd]?)$/.exec(d.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!n) return undefined;
  switch (m[2]) {
    case "s":
      return n;
    case "h":
      return n * 3600;
    case "d":
      return n * 86400;
    default:
      return n * 60; // bare number, or "m"
  }
}

export function formatLeft(seconds: number): string {
  if (seconds <= 0) return "expired";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Read the expiry the reaper will act on. Undefined = no expiry; runs until stopped.
 *
 * One SSH round-trip for all three facts. The reaper check used to be a second, separate
 * `docker --context` call — which itself tunnels over SSH — doubling the cost of every poll to
 * answer a question the same shell was already positioned to answer.
 */
export async function readTtl(cfg: RdkConfig): Promise<Ttl | undefined> {
  const script = [
    `cat ${TTL_DIR}/${cfg.projectName} 2>/dev/null`,
    "echo ---",
    "date +%s",
    "echo ---",
    "docker ps -q --filter name=rdk-reaper 2>/dev/null | head -n1",
  ].join("; ");

  const res = await run("ssh", [...SSH, cfg.vpsSsh, script], { timeoutMs: 20_000, maxBuffer: 64 * 1024 });
  if (res.code !== 0) return undefined;

  const [expRaw, nowRaw, reaperRaw] = res.stdout.split("---");
  const expiresAt = Number((expRaw ?? "").replace(/\D/g, ""));
  const now = Number((nowRaw ?? "").replace(/\D/g, ""));
  if (!expiresAt || !now) return undefined;

  return {
    expiresAt,
    secondsLeft: expiresAt - now,
    reaperRunning: (reaperRaw ?? "").trim().length > 0,
    skew: now - Math.floor(Date.now() / 1000),
    readAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Set expiry. Computed with the VPS clock, not this Mac's — a few minutes of skew would
 * otherwise kill a deployment early, and the reaper compares against VPS time.
 */
export async function setTtl(cfg: RdkConfig, seconds: number): Promise<boolean> {
  const res = await run(
    "ssh",
    [
      ...SSH,
      cfg.vpsSsh,
      `mkdir -p ${TTL_DIR} && echo $(( $(date +%s) + ${seconds} )) > ${TTL_DIR}/${cfg.projectName}`,
    ],
    { timeoutMs: 20_000, maxBuffer: 64 * 1024 },
  );
  return res.code === 0;
}

export async function clearTtl(cfg: RdkConfig): Promise<boolean> {
  const res = await run("ssh", [...SSH, cfg.vpsSsh, `rm -f ${TTL_DIR}/${cfg.projectName}`], {
    timeoutMs: 20_000,
    maxBuffer: 64 * 1024,
  });
  return res.code === 0;
}

const PRESETS = ["1h", "4h", "8h", "1d", "3d"];

/** Ask for a duration. Presets first, because nobody wants to type "14400". */
export async function pickDuration(title: string): Promise<number | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      ...PRESETS.map((p) => ({ label: p, detail: `Stops in ${formatLeft(parseDuration(p)!)}`, value: p })),
      { label: "$(edit) Custom…", detail: "e.g. 90m, 12h, 2d", value: "" },
    ],
    { title, ignoreFocusOut: true, placeHolder: "How long should it run?" },
  );
  if (!picked) return undefined;

  let text = picked.value;
  if (!text) {
    const typed = await vscode.window.showInputBox({
      title,
      prompt: "Duration — 90m, 12h, 2d",
      placeHolder: "4h",
      ignoreFocusOut: true,
      validateInput: (v) => (parseDuration(v) ? undefined : "Expected something like 90m, 4h or 2d"),
    });
    if (!typed) return undefined;
    text = typed;
  }
  return parseDuration(text);
}

/** Warn once per expiry window, while you're actually at your desk to do something about it. */
export function shouldWarn(ttl: Ttl, promptWindow: string): boolean {
  const lead = parseDuration(promptWindow);
  if (!lead) return false; // TTL_PROMPT=0 disables
  return ttl.secondsLeft > 0 && ttl.secondsLeft <= lead;
}
