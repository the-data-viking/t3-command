// Missions: several crew on one goal, each with their own part. The brief each one gets names the
// mission, the goal, who else is on it and what their own part is, so they can work as a team
// (and say in their report what the others need to know).

import type { SquadMember } from "../store";

export interface MissionPlan {
  name: string;
  goal: string;
  /** Each crew member's own part, by unit key; optional. */
  parts: Record<string, string>;
}

/** The order a crew member on a mission receives. */
export function missionBrief(plan: MissionPlan, crew: string[], me: string, part?: string): string {
  const others = crew.filter((t) => t !== me);
  return [
    `Mission "${plan.name.trim()}": ${crew.length} crew working on one goal.`,
    "",
    `Goal: ${plan.goal.trim()}`,
    "",
    part?.trim() ? `Your part: ${part.trim()}` : "Your part: whatever of the goal fits the work you're already doing in this thread.",
    others.length ? `Also on it: ${others.join("; ")}.` : "",
    "",
    "Stay within your part. When you're done, report what you did, how you verified it, and anything the others on this mission need to know.",
  ].filter((line, i, all) => line !== "" || (all[i - 1] !== "" && i > 0)).join("\n");
}

export const missionKey = (m: SquadMember): string => `${m.envId}:${m.threadId}`;
