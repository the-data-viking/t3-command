import type { ThreadShell } from "./types";

export type RecruitWorkspace =
  | { mode: "local"; branch?: string }
  | { mode: "latest" }
  | { mode: "existing"; path: string }
  | { mode: "worktree"; branch?: string; startFromOrigin?: boolean };

export interface VcsRef {
  name: string;
  current: boolean;
  isDefault: boolean;
  isRemote?: boolean;
  worktreePath: string | null;
}

export interface ProjectRefs {
  refs: VcsRef[];
  isRepo: boolean;
}

export function latestWorktree(threads: ThreadShell[], projectId: string, workspaceRoot: string): ThreadShell | undefined {
  return threads
    .filter((t) => t.projectId === projectId && t.worktreePath && t.worktreePath !== workspaceRoot && !t.archivedAt && Number.isFinite(Date.parse(t.updatedAt)))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

export function defaultBranch(refs: VcsRef[]): string | undefined {
  return (refs.find((r) => r.current) ?? refs.find((r) => r.isDefault) ?? refs[0])?.name;
}
