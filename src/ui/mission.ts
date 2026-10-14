// Missions: several crew on one goal, each with their own part. The brief each one gets leads with
// their part, names the goal and every teammate with their part and where they work, and sets the
// conventions that keep many agents' reports comparable (BLOCKED, a closing STATUS line).

import type { SquadMember } from "../store";

export interface MissionPlan {
  name: string;
  goal: string;
  /** Each crew member's own part, by unit key; optional. */
  parts: Record<string, string>;
}

/** Someone on a mission, as their teammates see them. */
export interface MissionMember {
  key: string;
  title: string;
  part?: string;
  /** Machine, and branch or worktree when known: where they work, so overlaps can be spotted. */
  where?: string;
}

/**
 * The order a crew member on a mission receives: their own part first, then each teammate with
 * their part and where they work, and the conventions that make many agents' reports usable
 * (stay in your lane, say BLOCKED, end with a status line). `me` is this member's key.
 */
export function missionBrief(plan: MissionPlan, crew: MissionMember[], me: string, part?: string): string {
  // By key, not title: two crew can share a title ("Untitled") and must still see each other.
  const others = crew.filter((c) => c.key !== me);
  const lines = [
    `Mission "${plan.name.trim()}": ${crew.length} crew working on one goal.`,
    "",
    part?.trim() ? `Your part: ${part.trim()}` : "Your part: whatever of the goal fits the work you're already doing in this thread.",
    "",
    `Goal: ${plan.goal.trim()}`,
  ];
  if (others.length) {
    lines.push("", "The others on it:");
    for (const o of others) lines.push(`- ${o.title}${o.part?.trim() ? ` — part: ${o.part.trim()}` : ""}${o.where ? ` (${o.where})` : ""}`);
  }
  lines.push("", "How to work on it:",
    "- Stay within your part. If you need to change something in another's area, stop and say so instead.",
    "- If you're blocked, start your reply with \"BLOCKED:\" and say what you need.",
    `- If you open a pull request, put "[${plan.name.trim()}]" at the start of its title.`,
    "- End your report with one line: STATUS: done | partial | blocked · FILES: the files you changed · PR: its number, or none.");
  return lines.join("\n");
}

export const missionKey = (m: SquadMember): string => `${m.envId}:${m.threadId}`;

/** What another crew member said, for sharing with the rest. */
export interface SharedReply { title: string; reply?: string; status: string; part?: string }

/** Longest share of one crew member's reply passed on to the others… */
export const SHARED_REPLY_MAX = 1_500;
/** …and of all of them together, so a follow-up stays well inside the 8,000-character order limit. */
export const SHARED_TOTAL_MAX = 6_000;

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
  const each = Math.min(SHARED_REPLY_MAX, Math.floor(SHARED_TOTAL_MAX / Math.max(1, shared.length)));
  if (shared.length) {
    lines.push("", opts.mission ? "What the others on this mission reported last time:" : "What the others given this order reported last time:");
    for (const o of shared) lines.push("", `--- ${o.title}${o.part ? ` (part: ${o.part})` : ""} ---`, clip(o.reply!.trim(), each));
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
