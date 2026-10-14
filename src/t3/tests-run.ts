// The test and check commands an agent ran in a turn, read from its own tool activity. Pure, so
// the Command server can use it too (to notice a turn that keeps failing the same command).

import type { OrchestrationThread } from "./types.ts";

/** Commands that run tests or checks, by the usual runners. */
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck)\b|\b(vitest|jest|pytest|mocha|playwright\s+test|cargo\s+test|go\s+test|tsc\b|eslint|rspec|phpunit)\b/i;

export interface TestRun {
  command: string;
  /** "ran": finished, but without an exit code to say whether it passed. */
  outcome: "passed" | "failed" | "ran" | "running";
}

/** The test and check commands the agent ran in its latest turn, and how each ended (last run of each). */
export function testsRun(thread: OrchestrationThread): TestRun[] {
  const turnId = thread.latestTurn?.turnId;
  if (!turnId) return [];
  const calls = new Map<string, TestRun>();
  for (const a of thread.activities) {
    if (a.turnId !== turnId || !a.kind.startsWith("tool.")) continue;
    const p = a.payload ?? {};
    const command = typeof p.detail === "string" && p.detail.trim() ? p.detail.split("\n")[0].trim() : a.summary;
    if (!command || !TEST_COMMAND.test(command)) continue;
    const id = String(p.toolCallId ?? a.id);
    const failed = p.status === "failed" || a.tone === "error" || (typeof p.exitCode === "number" && p.exitCode !== 0);
    const done = a.kind === "tool.completed" || p.status === "completed" || p.status === "failed";
    // Passed only on evidence: exit code 0. Finished without one is "ran", not a pass.
    const passed = typeof p.exitCode === "number" && p.exitCode === 0;
    calls.set(id, { command: command.length > 100 ? `${command.slice(0, 99)}…` : command, outcome: failed ? "failed" : passed ? "passed" : done ? "ran" : "running" });
  }
  // The last run of each distinct command is what counts.
  const byCommand = new Map<string, TestRun>();
  for (const run of calls.values()) { byCommand.delete(run.command); byCommand.set(run.command, run); }
  return [...byCommand.values()];
}
