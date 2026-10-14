// Web Push from the Command server: fleet events reach your phone (or any browser that subscribed)
// even when no T3 Command tab is open. VAPID keys, subscriptions and rules live in owner-only
// files in the data dir. Notifications carry a deep link; acting still happens in the app.

import fs from "node:fs/promises";
import path from "node:path";
import webpush, { type PushSubscription } from "web-push";
import type { CommsEntry } from "../shared/comms.ts";
import { DEFAULT_PUSH_RULES, deviceWants, sanitizeDeviceKinds, sanitizeRules, shouldPush, type DeviceKinds, type PushRules } from "../shared/push.ts";

interface Saved {
  subscription: PushSubscription;
  label: string;
  addedAt: number;
  /** This device's own filter on top of the fleet's rules; absent or null: everything they allow. */
  kinds?: DeviceKinds;
}

const TITLES: Partial<Record<NonNullable<CommsEntry["kind"]>, string>> = {
  approval: "Approval needed",
  question: "Question waiting",
  failed: "Turn failed",
  quiet: "Turn gone quiet",
  "long-turn": "Long-running turn",
  merged: "PR merged",
  done: "Job finished",
  offline: "Machine offline",
  disk: "Disk running low",
};

/** The notification for a comms entry: what happened, where, and a link straight to it. */
export function notificationFor(entry: CommsEntry, machine?: string): { title: string; body: string; url: string; tag: string } {
  const title = TITLES[entry.kind ?? "info"] ?? "T3 Command";
  const body = machine ? `${entry.text} · ${machine}` : entry.text;
  // Something to decide (approve, answer, triage a failure, read a report) opens straight to its card.
  const decide = entry.kind === "approval" || entry.kind === "question" || entry.kind === "failed" || entry.kind === "done";
  const url = entry.envId && entry.threadId ? `/#${decide ? "decide" : "crew"}/${encodeURIComponent(entry.envId)}/${encodeURIComponent(entry.threadId)}`
    : entry.envId ? `/#host/${encodeURIComponent(entry.envId)}` : "/";
  // One notification per crew member and kind: a newer one replaces the older on the lock screen.
  const tag = `${entry.kind ?? "info"}:${entry.envId ?? ""}:${entry.threadId ?? ""}`;
  return { title, body, url, tag };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[push] read failed", file, (err as Error).message); return undefined; }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export class PushNotifier {
  private readonly dir: string;
  private keys?: { publicKey: string; privateKey: string };
  private subs: Saved[] = [];
  private rules: PushRules = DEFAULT_PUSH_RULES;
  private writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = dataDir;
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
    webpush.setVapidDetails("mailto:t3-command@localhost", this.keys.publicKey, this.keys.privateKey);
    this.subs = (await readJson<Saved[]>(this.file("push-subscriptions.json"))) ?? [];
    this.rules = sanitizeRules(await readJson(this.file("push-rules.json"))) ?? DEFAULT_PUSH_RULES;
  }

  status(): { publicKey: string; devices: Array<{ label: string; addedAt: number; endpoint: string; kinds: DeviceKinds }>; rules: PushRules } {
    return {
      publicKey: this.keys?.publicKey ?? "",
      devices: this.subs.map((s) => ({ label: s.label, addedAt: s.addedAt, endpoint: s.subscription.endpoint, kinds: s.kinds ?? null })),
      rules: this.rules,
    };
  }

  private save(): void {
    const subs = [...this.subs], rules = this.rules;
    this.writes = this.writes.then(async () => {
      await writeJson(this.file("push-subscriptions.json"), subs);
      await writeJson(this.file("push-rules.json"), rules);
    }).catch((err) => console.warn("[push] write failed", (err as Error).message));
  }

  subscribe(subscription: PushSubscription, label: string): void {
    if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint) || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error("Not a push subscription");
    // Re-subscribing (a new key, a reinstall) keeps the device's own filter.
    const kinds = this.subs.find((s) => s.subscription.endpoint === subscription.endpoint)?.kinds;
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== subscription.endpoint);
    this.subs.push({ subscription, label: label.slice(0, 80) || "Device", addedAt: Date.now(), ...(kinds !== undefined ? { kinds } : {}) });
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

  /** Push a comms entry to every device whose filter wants it, if the fleet's rules let it through. */
  async notify(entry: CommsEntry, machine?: string): Promise<void> {
    if (!this.subs.length || !shouldPush(this.rules, entry.kind, new Date(entry.at))) return;
    await this.send(notificationFor(entry, machine), (s) => deviceWants(s.kinds, entry.kind));
  }

  /** A test notification to one device (or all). */
  async test(endpoint?: string): Promise<number> {
    return this.send({ title: "T3 Command", body: "Push notifications are working on this device.", url: "/", tag: "test" }, (s) => !endpoint || s.subscription.endpoint === endpoint);
  }

  private async send(payload: { title: string; body: string; url: string; tag: string }, to: (s: Saved) => boolean): Promise<number> {
    let sent = 0;
    const gone: string[] = [];
    await Promise.all(this.subs.filter(to).map(async (s) => {
      try {
        await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 3600, urgency: payload.tag.startsWith("approval") ? "high" : "normal" });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // The browser dropped this subscription (uninstalled, permission revoked): forget it.
        if (status === 404 || status === 410) gone.push(s.subscription.endpoint);
        else console.warn("[push] send failed", status ?? (err as Error).message);
      }
    }));
    if (gone.length) { this.subs = this.subs.filter((s) => !gone.includes(s.subscription.endpoint)); this.save(); }
    return sent;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
