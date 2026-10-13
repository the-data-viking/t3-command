// Scratch work: threads on a machine that aren't tied to a project (maintenance, storage cleanup,
// quick experiments). T3 has this built in as the "No project" project at <T3 home>/scratch
// (~/.t3/scratch), and gives each of its threads a dated folder of its own inside it. It is never
// grouped into a project station; its crew stand in that machine's engineering bay.

import type { EnvWorld } from "../store";
import type { ProjectShell } from "./types";

/** T3's own title for its scratch project, and where it lives under the default T3 home. */
export const SCRATCH_TITLE = "No project";
export const SCRATCH_ROOT = "~/.t3/scratch";

/** T3's scratch project: a "scratch" folder in its home (~/.t3), or titled as T3 titles it. */
export function isScratch(project: Pick<ProjectShell, "workspaceRoot" | "title"> | undefined): boolean {
  if (!project) return false;
  const parts = project.workspaceRoot.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) === "scratch" && (parts.at(-2) === ".t3" || project.title === SCRATCH_TITLE);
}

/** This machine's scratch project, oldest first if there is somehow more than one. */
export function scratchProject(env: EnvWorld | undefined): ProjectShell | undefined {
  if (!env || env.summary.kind === "hermes") return undefined;
  return Object.values(env.projects).filter(isScratch).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}
