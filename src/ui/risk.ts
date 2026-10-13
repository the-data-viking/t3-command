// The risk lens: what an approval request could break, read from the command or files it names.
// A request that matches is flagged on the event card, the unit panel and the roster, and is never
// approved in bulk: "approve for the rest of this session" is withheld and approving arms slowly.
// Heuristics, not a sandbox: a clean request isn't promised safe, a flag is a reason to read twice.

import type { PendingRequest } from "../t3/types";

export type RiskLevel = "danger" | "caution";

export interface Risk {
  level: RiskLevel;
  /** Short plain reasons, most serious first: "deletes files recursively", "rewrites git history". */
  reasons: string[];
}

interface Rule {
  level: RiskLevel;
  reason: string;
  test: RegExp;
}

/** Rules for commands. Word-ish boundaries so "rm" inside "perform" or "format" doesn't match. */
const COMMAND_RULES: Rule[] = [
  { level: "danger", reason: "deletes files recursively", test: /(^|[\s;&|(])(sudo\s+)?rm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r|--recursive)\b/i },
  { level: "danger", reason: "deletes untracked files", test: /\bgit\s+clean\s+-[a-z]*[fdx]/i },
  { level: "danger", reason: "deletes files it finds", test: /\bfind\b[^|;&]*\s-delete\b/i },
  { level: "danger", reason: "force-pushes (rewrites remote history)", test: /\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/i },
  { level: "danger", reason: "throws away local changes", test: /\bgit\s+(reset\s+--hard|checkout\s+(--\s+)?\.(\s|$)|restore\s+(--\S+\s+)*\.(\s|$)|stash\s+(drop|clear))/i },
  { level: "danger", reason: "deletes a branch that may not be merged", test: /\bgit\s+branch\s+(-D|--delete\s+--force)\b/ },
  { level: "danger", reason: "drops or empties database data", test: /\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from\s+\w+\s*(;|$|"|'))/i },
  { level: "danger", reason: "resets a database", test: /\b(migrate\s+reset|db:(reset|drop)|db\s+reset|reset\s+--force)\b/i },
  { level: "danger", reason: "runs a script straight from the internet", test: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/i },
  { level: "danger", reason: "writes raw disks or formats them", test: /\b(dd\s+if=|mkfs(\.\w+)?\s|diskutil\s+(erase|partition))/i },
  { level: "danger", reason: "destroys infrastructure", test: /\b(terraform\s+destroy|kubectl\s+delete|gh\s+repo\s+delete|docker\s+(system|volume)\s+prune)\b/i },
  { level: "danger", reason: "reads secrets or keys", test: /(\.ssh\/|id_(rsa|ed25519)|\.aws\/credentials|\.netrc|security\s+find-(generic|internet)-password|\bprintenv\b|(^|\s)env\s*($|\|))/i },
  { level: "caution", reason: "reads or writes a .env file", test: /(^|[\s/'"=])\.env(\.\w+)?\b/ },
  { level: "caution", reason: "runs a database migration", test: /\b(migrate|migration|db:push|prisma\s+db\s+push)\b/i },
  { level: "caution", reason: "uses --force", test: /\s--force\b/ },
  { level: "caution", reason: "runs with sudo", test: /(^|[\s;&|(])sudo\s/ },
  { level: "caution", reason: "pushes straight to main", test: /\bgit\s+push\b[^;&|]*\s(origin\s+)?(HEAD:)?(main|master)\b/i },
  { level: "caution", reason: "publishes or deploys", test: /\b(npm\s+publish|pnpm\s+publish|cargo\s+publish|gh\s+release\s+create|terraform\s+apply|kubectl\s+apply|vercel\s+--prod|fly\s+deploy)\b/i },
  { level: "caution", reason: "changes permissions recursively", test: /\b(chmod|chown)\s+-R\b|\bchmod\s+(-\w+\s+)?777\b/ },
  { level: "caution", reason: "kills processes by name", test: /\b(pkill|killall)\b/ },
];

/** Rules for file changes and reads, matched against the paths the request names. */
const FILE_RULES: Rule[] = [
  { level: "danger", reason: "touches keys or credentials", test: /(\.ssh\/|id_(rsa|ed25519)|\.pem\b|\.key\b|credentials|\.netrc)/i },
  { level: "caution", reason: "touches a .env file", test: /(^|\/)\.env(\.\w+)?\b/ },
  { level: "caution", reason: "changes CI workflows", test: /\.github\/workflows\//i },
  { level: "caution", reason: "changes database migrations", test: /(^|\/)(migrations?|migrate)\//i },
];

/** The text a request is judged by: its detail (the command, or the paths), else its summary. */
function requestText(request: PendingRequest): string {
  const p = request.activity.payload ?? {};
  const detail = typeof p.detail === "string" ? p.detail : "";
  return `${detail}\n${request.activity.summary}`;
}

/** Judge one piece of text (a command, or file paths) against the rules for its kind. */
export function assessText(text: string, kind: string): Risk | undefined {
  const rules = kind === "file-change" || kind === "file-read" ? FILE_RULES : COMMAND_RULES;
  const hits = rules.filter((r) => r.test.test(text));
  if (!hits.length) return undefined;
  const level: RiskLevel = hits.some((r) => r.level === "danger") ? "danger" : "caution";
  const reasons = [...hits.filter((r) => r.level === "danger"), ...hits.filter((r) => r.level === "caution")].map((r) => r.reason);
  return { level, reasons: [...new Set(reasons)] };
}

/** The risk of an approval request, or undefined if nothing in it is flagged (questions never are). */
export function assessRisk(request: PendingRequest | undefined): Risk | undefined {
  if (!request || request.kind !== "approval") return undefined;
  const kind = String(request.activity.payload?.requestKind ?? "command");
  return assessText(requestText(request), kind);
}

/** Withholds "approve for the rest of this session" from a dangerous request: each one is approved on its own. */
export function allowedDecisions<T extends { decision: string }>(options: T[], risk: Risk | undefined): T[] {
  return risk?.level === "danger" ? options.filter((o) => o.decision !== "acceptForSession") : options;
}

/** How long a request's approve buttons stay disarmed: longer when it's flagged dangerous. */
export const RISK_ARM_MS = 1_500;
