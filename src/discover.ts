import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { detectProject, ProjectShape } from "./detect";
import { ENV_FILE, envExists } from "./env";

/** Folders that never contain a project root and are expensive to walk. */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  "vendor",
  ".idea",
  ".vscode",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
]);

/** How deep below a workspace folder we look. A monorepo nests one or two levels; configurable. */
function maxDepth(): number {
  const n = vscode.workspace.getConfiguration("rdk").get<number>("scanDepth");
  return typeof n === "number" && n >= 0 ? n : 2;
}

function skipped(): Set<string> {
  const extra = vscode.workspace.getConfiguration("rdk").get<string[]>("excludeFolders") ?? [];
  return new Set([...SKIP, ...extra]);
}

export interface Candidate {
  root: string;
  /** Folder name — what the user sees. */
  label: string;
  /** Has a .env.remote: an RDK project already. */
  configured: boolean;
  shape: ProjectShape;
}

function readDirs(dir: string, skip: Set<string>): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function candidate(root: string): Candidate | undefined {
  const configured = envExists(root);
  const shape = detectProject(root);
  if (!configured && !shape.deployable) return undefined;
  return { root, label: path.basename(root), configured, shape };
}

/**
 * Every folder that already has a .env.remote, at ANY depth.
 *
 * This is an exact-filename lookup against the editor's file index, so depth costs nothing —
 * unlike the directory walk below, which has to stat its way down. Depth-limiting this was a
 * bug: a project set up from the CLI in, say, repo/apps/personal/ sits 3 levels below the
 * workspace root and silently never appeared in the sidebar, even while it was deployed and
 * running. The file watcher in extension.ts is already `**​/.env.remote`; this matches it.
 */
async function findConfigured(skip: Set<string>): Promise<string[]> {
  const exclude = `**/{${[...skip].join(",")}}/**`;
  const uris = await vscode.workspace.findFiles(`**/${ENV_FILE}`, exclude);
  return uris.map((u) => path.dirname(u.fsPath));
}

/**
 * Find every RDK project in the workspace.
 *
 * Two passes, because the two cases have different costs:
 *  - Already configured (has .env.remote) → found at any depth, via the file index. Missing one
 *    of these is the worst failure: a live deployment the user can't see or control.
 *  - Not yet configured → found by a depth-limited walk. This pass only *offers* setup, so
 *    scanning the whole tree would be expensive for no benefit.
 *
 * A monorepo root (ise/) holds no Dockerfile of its own — the projects are one level down
 * (ise/ise-api/), or further in a pnpm workspace (portfolio/apps/personal/).
 */
export async function discover(): Promise<Candidate[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = new Map<string, Candidate>();
  const depthLimit = maxDepth();
  const skip = skipped();

  const configuredRoots = new Set(await findConfigured(skip));
  for (const root of configuredRoots) {
    const c = candidate(root);
    if (c) found.set(root, c);
  }

  const walk = (dir: string, depth: number): void => {
    if (!found.has(dir)) {
      const c = candidate(dir);
      if (c) found.set(dir, c);
    }
    // A configured project is a leaf: don't descend into it and pick up its own subfolders.
    if (configuredRoots.has(dir)) return;
    if (depth >= depthLimit) return;
    for (const child of readDirs(dir, skip)) {
      walk(child, depth + 1);
    }
  };

  for (const f of folders) {
    walk(f.uri.fsPath, 0);
  }

  // Configured projects first, then alphabetical — the ones you actually use float to the top.
  return [...found.values()].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/** The project the user is most likely thinking about: the one owning the active editor. */
export function activeRoot(candidates: Candidate[]): string | undefined {
  if (!candidates.length) return undefined;

  const open = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (open) {
    // Deepest matching root wins, so ise/ise-api beats ise/.
    const owning = candidates
      .filter((c) => open.startsWith(c.root + path.sep))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (owning) return owning.root;
  }
  return candidates[0].root;
}
