// Deciding from a notification. When a crew member asks for approval, the Command server reads the
// request itself (a one-off look at the thread), so the push can say what's being asked and how
// risky it is. A request the risk lens doesn't flag also gets Approve and Deny actions, carrying a
// single-use token; the decision goes back over the server's own link to that machine and is
// logged ("approved from a notification"). Flagged requests only ever open the app.

import { randomBytes, randomUUID } from "node:crypto";
import type { ApprovalDecision, OrchestrationThread } from "../src/t3/types.ts";
import { pendingRequests } from "../src/t3/derive.ts";
import { assessRisk, type Risk } from "../src/ui/risk.ts";
import type { CommsLog } from "./comms.ts";

/** How long a notification's Approve and Deny stay usable. */
export const DECIDE_TTL_MS = 30 * 60_000;

export interface PendingDecision {
  requestId: string;
  /** The command or paths, on one line. */
  what: string;
  risk?: Risk;
  /** Present only when the request may be decided from the notification. */
  token?: string;
}

interface Grant { envId: string; threadId: string; requestId: string; what: string; title: string; expires: number }

type Peek = (envId: string, tag: string, payload: unknown) => Promise<Array<{ kind: string; snapshot?: { thread: OrchestrationThread } }>>;
type Send = (envId: string, tag: string, payload: unknown) => Promise<unknown>;

/** The newest pending approval in a thread, with what it asks and its risk. */
export function readApproval(thread: OrchestrationThread): Omit<PendingDecision, "token"> | undefined {
  const request = pendingRequests(thread).filter((r) => r.kind === "approval").at(-1);
  if (!request) return undefined;
  const p = request.activity.payload ?? {};
  const raw = typeof p.detail === "string" && p.detail.trim() ? p.detail : request.activity.summary;
  const what = (raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join(" · ");
  const risk = assessRisk(request);
  return { requestId: request.requestId, what: what.length > 140 ? `${what.slice(0, 139)}…` : what, ...(risk ? { risk } : {}) };
}

export class Decisions {
  private grants = new Map<string, Grant>();
  private readonly peek: Peek;
  private readonly send: Send;
  private readonly comms: CommsLog;

  constructor(peek: Peek, send: Send, comms: CommsLog) {
    this.peek = peek;
    this.send = send;
    this.comms = comms;
  }

  /** What a crew member is asking right now, and (if unflagged) a token to decide it from the notification. */
  async prepare(envId: string, threadId: string, title: string, now = Date.now()): Promise<PendingDecision | undefined> {
    const items = await this.peek(envId, "orchestration.subscribeThread", { threadId, turnLimit: 1, requestCompletionMarker: true });
    const thread = items.find((i) => i.kind === "snapshot")?.snapshot?.thread;
    const approval = thread ? readApproval(thread) : undefined;
    if (!approval) return undefined;
    for (const [token, g] of this.grants) if (g.expires < now) this.grants.delete(token);
    if (approval.risk) return approval;
    const token = randomBytes(18).toString("base64url");
    this.grants.set(token, { envId, threadId, requestId: approval.requestId, what: approval.what, title, expires: now + DECIDE_TTL_MS });
    return { ...approval, token };
  }

  /** Approve or deny with a notification's token: once, before it expires, for that one request. */
  async decide(token: string, decision: ApprovalDecision, now = Date.now()): Promise<{ title: string; what: string }> {
    const grant = this.grants.get(token);
    if (!grant || grant.expires < now) { this.grants.delete(token); throw new Error("This notification's decision has expired: open the app to decide"); }
    if (decision !== "accept" && decision !== "decline") throw new Error("Only approve or deny can be decided from a notification");
    this.grants.delete(token);
    await this.send(grant.envId, "orchestration.dispatchCommand", {
      commandId: randomUUID(), type: "thread.approval.respond", threadId: grant.threadId, requestId: grant.requestId, decision, createdAt: new Date(now).toISOString(),
    });
    this.comms.add({ tone: "info", kind: "info", envId: grant.envId, threadId: grant.threadId,
      text: `${decision === "accept" ? "Approved" : "Denied"} from a notification for "${grant.title}": ${grant.what}` });
    return { title: grant.title, what: grant.what };
  }
}
