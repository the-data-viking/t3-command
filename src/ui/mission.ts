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

/** What another crew member said, for sharing with the rest. */
export interface SharedReply { title: string; reply?: string; status: string; part?: string }

/** Longest share of one crew member's reply passed on to the others. */
export const SHARED_REPLY_MAX = 1_500;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * The follow-up order for one crew member: the mission (if any) and their part, your instruction,
 * and, when shared, what everyone else on it reported last time, so they can build on it.
 */
export function followUpBrief(opts: { mission?: { name: string; goal: string }; text: string; part?: string; others?: SharedReply[] }): string {
  const lines: string[] = [];
  if (opts.mission) {
    lines.push(`Mission "${opts.mission.name}", follow-up.`, `Goal: ${opts.mission.goal}`);
    if (opts.part?.trim()) lines.push(`Your part: ${opts.part.trim()}`);
    lines.push("");
  }
  lines.push(opts.text.trim());
  const shared = (opts.others ?? []).filter((o) => o.reply?.trim());
  if (shared.length) {
    lines.push("", opts.mission ? "What the others on this mission reported last time:" : "What the others given this order reported last time:");
    for (const o of shared) lines.push("", `--- ${o.title}${o.part ? ` (part: ${o.part})` : ""} ---`, clip(o.reply!.trim(), SHARED_REPLY_MAX));
  }
  if (opts.mission) lines.push("", "When you're done, report what you did, how you verified it, and anything the others need to know.");
  return lines.join("\n");
}

/** Everything a squad order or mission produced, as one markdown document. */
export function debriefMarkdown(opts: { mission?: { name: string; goal: string }; order: string; replies: SharedReply[] }): string {
  const out = [opts.mission ? `# Mission: ${opts.mission.name}` : "# Squad order", ""];
  out.push(opts.mission ? `**Goal:** ${opts.mission.goal}` : `**Order:** ${opts.order.split("\n")[0]}`, "");
  for (const r of opts.replies) {
    out.push(`## ${r.title} — ${r.status}${r.part ? ` (part: ${r.part})` : ""}`, "", r.reply?.trim() || "_No reply._", "");
  }
  return out.join("\n").trimEnd() + "\n";
}
