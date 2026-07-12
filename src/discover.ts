import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { detectProject, ProjectShape } from "./detect";
import { envExists } from "./env";

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
 * Find every RDK project in the workspace.
 *
 * A monorepo root (ise/) holds no Dockerfile of its own — the projects are one level down
 * (ise/ise-api/). Scanning only the workspace root would report "nothing here" while a
 * perfectly good, already-deployed project sits in a subfolder.
 */
export function discover(): Candidate[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = new Map<string, Candidate>();
  const depthLimit = maxDepth();
  const skip = skipped();

  const walk = (dir: string, depth: number): void => {
    const c = candidate(dir);
    if (c) {
      found.set(dir, c);
      // A configured project is a leaf: don't descend into it and pick up its own subfolders.
      if (c.configured) return;
    }
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
