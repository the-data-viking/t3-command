import type { NativeSubagent, ThreadShell } from "./types";
import { isNativeSubagent } from "./derive";

/** Join parent-owned lifecycles to native child shells without inventing app runs. */
export function withNativeSubagents(threads: Record<string, ThreadShell>, agents: Iterable<NativeSubagent>): Record<string, ThreadShell> {
  const byChild = new Map<string, NativeSubagent>();
  for (const agent of agents) {
    const previous = byChild.get(agent.childThreadId);
    if (!previous || previous.updatedAt <= agent.updatedAt) byChild.set(agent.childThreadId, agent);
  }
  let next = threads;
  for (const thread of Object.values(threads)) {
    if (!isNativeSubagent(thread)) continue;
    const agent = byChild.get(thread.id);
    const nativeSubagent = agent?.parentThreadId === thread.lineage?.parentThreadId ? agent : undefined;
    if (JSON.stringify(thread.nativeSubagent) === JSON.stringify(nativeSubagent)) continue;
    if (next === threads) next = { ...threads };
    next[thread.id] = { ...thread, nativeSubagent };
  }
  return next;
}
