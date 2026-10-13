// A crew member's posture: how much it may do without asking (T3's runtime mode), and whether it
// plans before it builds (plan mode). Shared by the recruit form and the crew panel.

import type { RuntimeMode } from "../t3/types";

export const RUNTIME_MODES: Array<{ id: RuntimeMode; label: string }> = [
  { id: "full-access", label: "Full access" },
  { id: "auto", label: "Auto" },
  { id: "auto-accept-edits", label: "Auto-accept edits" },
  { id: "approval-required", label: "Ask before acting" },
];

/** Least to most trusting, for "is this a step up?". */
const TRUST: Record<RuntimeMode, number> = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };

/** Raising trust to full access deserves a confirmation; anything lower doesn't. */
export function needsConfirm(from: RuntimeMode, to: RuntimeMode): boolean {
  return to === "full-access" && TRUST[to] > TRUST[from];
}

/** The order that hands an approved plan over to building. */
export const BUILD_THE_PLAN = "The plan is approved. Go ahead and implement it, then summarize what you built and how you verified it.";
