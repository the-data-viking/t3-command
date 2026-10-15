// Adding a project to a machine from Command: an existing folder, a clone, or a new empty folder.
// T3 owns projects; these helpers only pick sensible names and places for them.

import type { EnvWorld } from "../store";
import type { ProjectClone } from "../t3/types";
import { isScratch } from "../t3/scratch";

export type NewProjectMode = "folder" | "clone" | "empty";

/** The last segment of a path, ignoring a trailing slash. */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** `parent` + `name`, with exactly one slash between. */
export function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
}

/** A repository's folder name from its clone URL, `owner/repo` shorthand included. */
export function repoName(url: string): string {
  return folderName(url.trim().replace(/[?#].*$/, "").replace(/\.git\/?$/, "").replace(/^[^@/]+@[^:/]+:/, ""));
}

/** A folder name that is safe to type into a path: no slashes, no leading dots. */
export function cleanFolderName(name: string): string {
  return name.trim().replace(/[\\/:]+/g, "-").replace(/^\.+/, "");
}

/**
 * Where new projects on this machine probably belong: the folder holding most of its existing
 * projects (say ~/Documents/GitHub), else its home folder.
 */
export function defaultParent(env: EnvWorld | undefined): string {
  const counts = new Map<string, number>();
  for (const p of Object.values(env?.projects ?? {})) {
    if (isScratch(p)) continue;
    const parent = p.workspaceRoot.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [parent, n] of counts) if (!best || n > counts.get(best)!) best = parent;
  return best ?? "~";
}

const STAGES: Record<ProjectClone["stage"], string> = {
  connecting: "Connecting",
  counting: "Counting objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checkout: "Checking out files",
};

/** One line on how a clone is going. */
export function cloneStatus(clone: ProjectClone): string {
  if (clone.phase === "done") return "Cloned";
  if (clone.phase === "cancelled") return "Clone cancelled";
  if (clone.phase === "failed") return `Clone failed: ${clone.error ?? "unknown error"}`;
  return [STAGES[clone.stage] ?? clone.stage, clone.percent !== null ? `${clone.percent}%` : undefined, clone.detail || undefined]
    .filter(Boolean).join(" · ");
}
