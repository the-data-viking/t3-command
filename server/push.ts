// Web Push from the Command server: fleet events reach your phone (or any browser that subscribed)
// even when no T3 Command tab is open. VAPID keys, subscriptions and rules live in owner-only
// files in the data dir. Notifications carry a deep link; acting still happens in the app.

import fs from "node:fs/promises";
import path from "node:path";
import webpush, { type PushSubscription } from "web-push";
import type { CommsEntry } from "../shared/comms.ts";
import type { PendingDecision } from "./decide.ts";
import { DEFAULT_PUSH_RULES, deviceWants, sanitizeDeviceKinds, sanitizeRules, shouldPush, type DeviceKinds, type PushRules } from "../shared/push.ts";

interface Saved {
  subscription: PushSubscription;
  label: string;
  addedAt: number;
  /** This device's own filter on top of the fleet's rules; absent or null: everything they allow. */
  kinds?: DeviceKinds;
  /**
   * The server's public key this subscription was made with. A push service only accepts pushes
   * signed by that key, so after a key rotation the subscription is stale until the device
   * subscribes again. Absent: made before keys were recorded, i.e. with the key in use until the
   * first rotation.
   */
  key?: string;
}

const TITLES: Partial<Record<NonNullable<CommsEntry["kind"]>, string>> = {
  approval: "Approval needed",
  question: "Question waiting",
  failed: "Turn failed",
  quiet: "Turn gone quiet",
  "long-turn": "Long-running turn",
  merged: "PR merged",
  done: "Job finished",
  mission: "Squad order finished",
  offline: "Machine offline",
  disk: "Disk running low",
};

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** Approve and Deny on the notification (unflagged approvals only), and the token they use. */
  actions?: Array<{ action: string; title: string }>;
  token?: string;
}

/**
 * The notification for a comms entry: what happened, where, and a link straight to it. For an
 * approval the server has read, the body says what's being asked and how risky it is.
 */
export function notificationFor(entry: CommsEntry, machine?: string, decision?: PendingDecision): PushPayload {
  const title = TITLES[entry.kind ?? "info"] ?? "T3 Command";
  const asked = decision ? ` ▲ ${decision.what}${decision.risk ? ` · ${decision.risk.level === "danger" ? "Danger" : "Careful"}: ${decision.risk.reasons.join(", ")}` : ""}` : "";
  const body = `${entry.text}${asked}${machine ? ` · ${machine}` : ""}`;
  // Something to decide (approve, answer, triage a failure, read a report) opens straight to its card.
  const decide = entry.kind === "approval" || entry.kind === "question" || entry.kind === "failed" || entry.kind === "done";
  const url = entry.dispatchId ? `/#replies/${encodeURIComponent(entry.dispatchId)}`
    : entry.envId && entry.threadId ? `/#${decide ? "decide" : "crew"}/${encodeURIComponent(entry.envId)}/${encodeURIComponent(entry.threadId)}`
    : entry.envId ? `/#host/${encodeURIComponent(entry.envId)}` : "/";
  // One notification per crew member and kind: a newer one replaces the older on the lock screen.
  const tag = `${entry.kind ?? "info"}:${entry.envId ?? ""}:${entry.threadId ?? ""}${entry.dispatchId ? `:${entry.dispatchId}` : ""}`;
  return { title, body, url, tag, ...(decision?.token ? { token: decision.token, actions: [{ action: "accept", title: "Approve" }, { action: "decline", title: "Deny" }] } : {}) };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[push] read failed", file, (err as Error).message); return undefined; }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.rm(tmp, { force: true });
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/**
 * The contact the server signs pushes with (VAPID "sub"). Apple's push service rejects a
 * non-routable one ("mailto:…@localhost": 403 BadJwtToken), so it's an https URL unless set.
 */
export const DEFAULT_PUSH_SUBJECT = "https://github.com/the-data-viking/t3-command";

/** A device subscribed with a server key that has since been replaced. */
export class PushKeyChanged extends Error {}

export class PushNotifier {
  private readonly dir: string;
  private keys?: { publicKey: string; privateKey: string };
  private subs: Saved[] = [];
  private rules: PushRules = DEFAULT_PUSH_RULES;
  private writes: Promise<void> = Promise.resolve();

  private readonly subject: string;

  constructor(dataDir: string, subject = DEFAULT_PUSH_SUBJECT) {
    this.dir = dataDir;
    this.subject = subject;
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  async load(): Promise<void> {
    this.keys = await readJson(this.file("push-vapid.json"));
    if (!this.keys) {
      this.keys = webpush.generateVAPIDKeys();
      await writeJson(this.file("push-vapid.json"), this.keys);
    }
    webpush.setVapidDetails(this.subject, this.keys.publicKey, this.keys.privateKey);
    this.subs = (await readJson<Saved[]>(this.file("push-subscriptions.json"))) ?? [];
    this.rules = sanitizeRules(await readJson(this.file("push-rules.json"))) ?? DEFAULT_PUSH_RULES;
  }

  /** Whether a subscription was made with the key the server signs with now (so a push can reach it). */
  private current(s: Saved): boolean {
    return !s.key || s.key === this.keys?.publicKey;
  }

  status(): { publicKey: string; devices: Array<{ label: string; addedAt: number; endpoint: string; kinds: DeviceKinds; stale: boolean }>; rules: PushRules } {
    return {
      publicKey: this.keys?.publicKey ?? "",
      devices: this.subs.map((s) => ({ label: s.label, addedAt: s.addedAt, endpoint: s.subscription.endpoint, kinds: s.kinds ?? null, stale: !this.current(s) })),
      rules: this.rules,
    };
  }

  /**
   * Replace the signing key (say it leaked) and start signing with the new one right away. The old
   * private key is replaced in the key file, never copied. Every existing subscription was made
   * with the old key, so it's marked stale: nothing is sent to it, and its device has to turn push
   * on again (which unsubscribes the old subscription at the push service and makes a new one).
   */
  rotate(): Promise<{ publicKey: string; stale: number }> {
    // One at a time, after any pending writes, so the key and subscriptions on disk always agree.
    const run = this.writes.then(async () => {
      const previous = this.keys?.publicKey;
      // Record the current key on older subscriptions first: if anything below fails, that changes nothing.
      for (const s of this.subs) if (!s.key) s.key = previous;
      await writeJson(this.file("push-subscriptions.json"), this.subs);
      const keys = webpush.generateVAPIDKeys();
      // On disk before it signs anything: if that fails, the server keeps the key it has and says so.
      await writeJson(this.file("push-vapid.json"), keys);
      webpush.setVapidDetails(this.subject, keys.publicKey, keys.privateKey);
      this.keys = keys;
      return { publicKey: keys.publicKey, stale: this.subs.filter((s) => !this.current(s)).length };
    });
    this.writes = run.then(() => undefined, () => undefined);
    return run;
  }

  private save(): void {
    const subs = [...this.subs], rules = this.rules;
    this.writes = this.writes.then(async () => {
      await writeJson(this.file("push-subscriptions.json"), subs);
      await writeJson(this.file("push-rules.json"), rules);
    }).catch((err) => console.warn("[push] write failed", (err as Error).message));
  }

  /**
   * Register a device's subscription. `replaces` is the endpoint it had before (a subscription the
   * device just dropped because the server's key changed): its filter carries over and it's removed.
   * `key` is the server key the browser subscribed with; if the server's key changed meanwhile,
   * the subscription is refused (it couldn't receive anything) and the device tries again.
   */
  subscribe(subscription: PushSubscription, label: string, replaces?: string, key?: string): void {
    if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint) || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error("Not a push subscription");
    if (key && key !== this.keys?.publicKey) throw new PushKeyChanged("The server's push key just changed. Turn push on again.");
    // Re-subscribing (a new key, a reinstall) keeps the device's own filter.
    const same = (s: Saved) => s.subscription.endpoint === subscription.endpoint || (!!replaces && s.subscription.endpoint === replaces);
    const kinds = (this.subs.find((s) => s.subscription.endpoint === subscription.endpoint) ?? this.subs.find(same))?.kinds;
    this.subs = this.subs.filter((s) => !same(s));
    this.subs.push({ subscription, label: label.slice(0, 80) || "Device", addedAt: Date.now(), key: this.keys?.publicKey, ...(kinds !== undefined ? { kinds } : {}) });
    this.save();
  }

  unsubscribe(endpoint: string): void {
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== endpoint);
    this.save();
  }

  /** Set one device's own filter: a list of kinds, or null for everything the fleet's rules allow. */
  setDeviceKinds(endpoint: string, input: unknown): void {
    const kinds = sanitizeDeviceKinds(input);
    if (kinds === undefined) throw new Error("kinds must be a list of event kinds, or null");
    const device = this.subs.find((s) => s.subscription.endpoint === endpoint);
    if (!device) throw new Error("No such device");
    device.kinds = kinds;
    this.save();
  }

  setRules(input: unknown): PushRules {
    const rules = sanitizeRules(input);
    if (!rules) throw new Error("Not a set of push rules");
    this.rules = rules;
    this.save();
    return rules;
  }

  /** Whether anything would be pushed for this entry (so the server only reads a request when it'll be used). */
  wants(entry: CommsEntry): boolean {
    return this.subs.some((s) => this.current(s)) && shouldPush(this.rules, entry.kind, new Date(entry.at));
  }

  /** Push a comms entry to every device whose filter wants it, if the fleet's rules let it through. */
  async notify(entry: CommsEntry, machine?: string, decision?: PendingDecision): Promise<void> {
    if (!this.subs.some((s) => this.current(s)) || !shouldPush(this.rules, entry.kind, new Date(entry.at))) return;
    await this.send(notificationFor(entry, machine, decision), (s) => deviceWants(s.kinds, entry.kind));
  }

  /** A test notification to one device (or all): how many went, and why any didn't. */
  async test(endpoint?: string): Promise<{ sent: number; errors: string[] }> {
    const errors: string[] = [];
    const sent = await this.send({ title: "T3 Command", body: "Push notifications are working on this device.", url: "/", tag: "test" }, (s) => !endpoint || s.subscription.endpoint === endpoint, errors);
    return { sent, errors };
  }

  private async send(payload: PushPayload, to: (s: Saved) => boolean, errors: string[] = []): Promise<number> {
    let sent = 0;
    const gone: string[] = [];
    // A stale subscription can't take this key's pushes; it waits for its device to subscribe again.
    await Promise.all(this.subs.filter((s) => this.current(s) && to(s)).map(async (s) => {
      try {
        await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 3600, urgency: payload.tag.startsWith("approval") ? "high" : "normal" });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // The push service's own reason ({"reason":"BadJwtToken"} from Apple), so a failure can be fixed.
        const body = String((err as { body?: unknown }).body ?? "").slice(0, 200);
        // The browser dropped this subscription (uninstalled, permission revoked): forget it.
        if (status === 404 || status === 410) gone.push(s.subscription.endpoint);
        else {
          console.warn("[push] send failed", status ?? (err as Error).message, body);
          errors.push(`${s.label}: ${status ? `HTTP ${status}` : (err as Error).message}${body ? ` ${body}` : ""}`);
        }
      }
    }));
    if (gone.length) { this.subs = this.subs.filter((s) => !gone.includes(s.subscription.endpoint)); this.save(); }
    return sent;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
